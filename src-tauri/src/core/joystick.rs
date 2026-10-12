use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;

use crate::core::guest::{close_with, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::transport::DeviceManager;

// A phone as a game controller: the phone joins over a TLS WebSocket (PIN confirmed unless it is
// paired), then streams stick/button state as UDP "js ..." lines to the input relay. Each
// controller gets one of four virtual Xbox pads, created by the bundled joystick helper through
// the ViGEm driver. Rumble from games travels back to the phone, and a controller that goes quiet
// is unplugged.

pub const JOYSTICK_PORT: u16 = crate::core::transport::LINK_PORT + 9;
const MAX_PADS: usize = 4;
const SWEEP_INTERVAL: Duration = Duration::from_secs(3);
const LIVENESS_TIMEOUT: Duration = Duration::from_secs(8);
const PING_INTERVAL: Duration = Duration::from_secs(1);
const HELPER_READY_TIMEOUT: Duration = Duration::from_secs(3);
const HELPER_EXE: &str = "joystick-helper.exe";
// The helper drives a kernel-level virtual device, so it only runs if it is exactly the binary
// that shipped with this app.
const HELPER_SHA256: &str = "2252c609568bd230f9d43474d14ef7c2d2117cb59c26c1415e1437894b42208b";

enum ToGuest {
    Ping,
    Rumble { large: u8, small: u8 },
    Kick(String),
}

struct Controller {
    slot: usize,
    name: String,
    last_seen: Instant,
    tx: mpsc::Sender<ToGuest>,
}

#[derive(Default)]
struct Helper {
    stdin: Option<ChildStdin>,
    child: Option<Child>,
    ready: bool,
    status: String,
    error: Option<String>,
}

#[derive(Default)]
pub struct Joystick {
    controllers: Mutex<HashMap<String, Controller>>,
    helper: tokio::sync::Mutex<Helper>,
    ready: Notify,
}

fn find_helper(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("vendor").join("joystick-helper").join(HELPER_EXE));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("joystick-helper").join(HELPER_EXE));
    candidates.into_iter().find(|p| p.exists())
}

impl DeviceManager {
    async fn set_joystick_status(&self, status: &str, error: Option<&str>) {
        {
            let mut helper = self.joystick.helper.lock().await;
            helper.status = status.to_string();
            helper.error = error.map(str::to_string);
        }
        self.emit_event("joystick-driver-status", json!({ "status": status, "error": error })).await;
    }

    /// Starts the helper if it isn't running; false when it is missing or fails its integrity check.
    async fn start_joystick_helper(self: &Arc<Self>) -> bool {
        if self.joystick.helper.lock().await.child.is_some() {
            return true;
        }
        let Some(app) = self.app_handle().await else { return false };
        let Some(exe) = find_helper(&app) else {
            self.set_joystick_status("missing", Some("helper_not_bundled")).await;
            return false;
        };
        let intact = std::fs::read(&exe).map(|bytes| hex::encode(Sha256::digest(bytes)) == HELPER_SHA256).unwrap_or(false);
        if !intact {
            self.set_joystick_status("error", Some("helper_integrity_check_failed")).await;
            return false;
        }

        let mut command = Command::new(&exe);
        command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                self.set_joystick_status("error", Some("spawn_failed")).await;
                return false;
            }
        };
        let stdout = child.stdout.take();
        {
            let mut helper = self.joystick.helper.lock().await;
            helper.stdin = child.stdin.take();
            helper.child = Some(child);
            helper.ready = false;
        }

        let manager = self.clone();
        tokio::spawn(async move {
            if let Some(stdout) = stdout {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    manager.joystick_helper_line(&line).await;
                }
            }
            manager.joystick_helper_exited().await;
        });
        true
    }

    async fn joystick_helper_line(&self, line: &str) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["ready"] => {
                self.joystick.helper.lock().await.ready = true;
                self.set_joystick_status("ready", None).await;
                self.joystick.ready.notify_waiters();
            }
            ["error", reason, ..] => {
                self.joystick.helper.lock().await.ready = false;
                self.set_joystick_status(if *reason == "driver_not_found" { "missing" } else { "error" }, Some(reason)).await;
                self.joystick.ready.notify_waiters();
            }
            ["rumble", slot, large, small, ..] => {
                let (Ok(slot), Ok(large), Ok(small)) = (slot.parse::<usize>(), large.parse::<u8>(), small.parse::<u8>()) else { return };
                let tx = self.joystick.controllers.lock().ok().and_then(|c| c.values().find(|c| c.slot == slot).map(|c| c.tx.clone()));
                if let Some(tx) = tx {
                    let _ = tx.send(ToGuest::Rumble { large, small }).await;
                }
            }
            _ => {}
        }
    }

    // The helper died: every controller lost its virtual pad.
    async fn joystick_helper_exited(&self) {
        {
            let mut helper = self.joystick.helper.lock().await;
            helper.child = None;
            helper.stdin = None;
            helper.ready = false;
        }
        self.set_joystick_status("unknown", None).await;
        self.joystick.ready.notify_waiters();
        let stranded: Vec<(String, mpsc::Sender<ToGuest>)> =
            self.joystick.controllers.lock().map(|mut c| c.drain().map(|(ip, c)| (ip, c.tx)).collect()).unwrap_or_default();
        for (_, tx) in stranded {
            let _ = tx.send(ToGuest::Kick("host_error".into())).await;
        }
        self.emit_event("joystick-roster-changed", Value::Null).await;
    }

    async fn joystick_write(&self, line: &str) {
        let mut helper = self.joystick.helper.lock().await;
        if let Some(stdin) = helper.stdin.as_mut() {
            let _ = stdin.write_all(format!("{}\n", line).as_bytes()).await;
            let _ = stdin.flush().await;
        }
    }

    async fn wait_joystick_ready(self: &Arc<Self>) -> bool {
        if !self.start_joystick_helper().await {
            return false;
        }
        let notified = self.joystick.ready.notified();
        if self.joystick.helper.lock().await.ready {
            return true;
        }
        let _ = tokio::time::timeout(HELPER_READY_TIMEOUT, notified).await;
        self.joystick.helper.lock().await.ready
    }

    /// Plugs a controller in on the first free virtual pad.
    async fn joystick_hello(self: &Arc<Self>, ip: &str, name: &str, tx: mpsc::Sender<ToGuest>) -> Result<usize, String> {
        if self.is_blocked(ip) {
            return Err("blocked".into());
        }
        if !self.wait_joystick_ready().await {
            return Err("helper_not_ready".into());
        }
        let slot = {
            let mut controllers = self.joystick.controllers.lock().map_err(|e| e.to_string())?;
            if let Some(existing) = controllers.get_mut(ip) {
                existing.name = name.to_string();
                existing.last_seen = Instant::now();
                existing.tx = tx;
                return Ok(existing.slot);
            }
            let slot = (0..MAX_PADS).find(|s| controllers.values().all(|c| c.slot != *s)).ok_or("slots_full")?;
            controllers.insert(ip.to_string(), Controller { slot, name: name.to_string(), last_seen: Instant::now(), tx });
            slot
        };
        self.joystick_write(&format!("plug {}", slot)).await;
        self.emit_event("joystick-roster-changed", Value::Null).await;
        Ok(slot)
    }

    pub async fn joystick_bye(&self, ip: &str, reason: &str) {
        let removed = self.joystick.controllers.lock().ok().and_then(|mut c| c.remove(ip));
        let Some(controller) = removed else { return };
        self.joystick_write(&format!("unplug {}", controller.slot)).await;
        if reason != "left" {
            let _ = controller.tx.send(ToGuest::Kick(reason.to_string())).await;
        }
        self.emit_event("joystick-roster-changed", Value::Null).await;
    }

    /// A "js ..." line from the UDP relay; only acts for a controller that has joined.
    pub(crate) async fn joystick_state(&self, ip: &str, line: &str) {
        if self.is_blocked(ip) {
            return;
        }
        let slot = self.joystick.controllers.lock().ok().and_then(|mut c| {
            c.get_mut(ip).map(|controller| {
                controller.last_seen = Instant::now();
                controller.slot
            })
        });
        if let Some(slot) = slot {
            self.joystick_write(&format!("report {} {}", slot, line)).await;
        }
    }

    pub async fn joystick_status(&self) -> Value {
        let (status, error) = {
            let helper = self.joystick.helper.lock().await;
            (if helper.status.is_empty() { "unknown".to_string() } else { helper.status.clone() }, helper.error.clone())
        };
        let controllers: Vec<Value> = self
            .joystick
            .controllers
            .lock()
            .map(|c| c.iter().map(|(ip, c)| json!({ "ip": ip, "name": c.name, "padIndex": c.slot })).collect())
            .unwrap_or_default();
        json!({ "driverStatus": status, "driverError": error, "connectedControllers": controllers })
    }

    /// "Verify installation": actively probes by starting the helper rather than reading a cache.
    pub async fn check_joystick_driver(self: &Arc<Self>) -> Value {
        self.start_joystick_helper().await;
        let status = self.joystick_status().await;
        json!({ "driverStatus": status["driverStatus"], "driverError": status["driverError"] })
    }

    /// Pings every controller each second, and unplugs any that has gone silent.
    pub fn start_joystick_timers(self: &Arc<Self>) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(PING_INTERVAL);
            loop {
                tick.tick().await;
                let senders: Vec<mpsc::Sender<ToGuest>> = manager.joystick.controllers.lock().map(|c| c.values().map(|c| c.tx.clone()).collect()).unwrap_or_default();
                for tx in senders {
                    let _ = tx.send(ToGuest::Ping).await;
                }
            }
        });
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(SWEEP_INTERVAL);
            loop {
                tick.tick().await;
                let stale: Vec<String> = manager
                    .joystick
                    .controllers
                    .lock()
                    .map(|c| c.iter().filter(|(_, c)| c.last_seen.elapsed() > LIVENESS_TIMEOUT).map(|(ip, _)| ip.clone()).collect())
                    .unwrap_or_default();
                for ip in stale {
                    manager.joystick_bye(&ip, "timeout").await;
                }
            }
        });
    }

    pub async fn start_joystick_server(self: &Arc<Self>) -> Result<(), String> {
        self.start_joystick_timers();
        self.serve_guests(JOYSTICK_PORT, "Joystick server", joystick_connection).await.map(|_| ())
    }
}

async fn joystick_connection(manager: Arc<DeviceManager>, mut guest: GuestSocket) {
    let mut first = None;
    while let Some(Ok(message)) = guest.ws.next().await {
        match message {
            Message::Text(text) => {
                first = serde_json::from_str::<Value>(text.as_str()).ok();
                break;
            }
            Message::Close(_) => return,
            _ => {}
        }
    }
    let Some(first) = first else {
        return close_with(&mut guest.ws, CLOSE_MALFORMED, "malformed first message").await;
    };
    if first["type"].as_str() != Some("join-guest") {
        return close_with(&mut guest.ws, CLOSE_UNKNOWN_JOIN, "unknown join type").await;
    }
    let paired = manager.paired_name_for_cert(&guest.peer_cert).await;
    let name = paired.clone().or_else(|| first["deviceName"].as_str().map(str::to_string)).unwrap_or_else(|| "Controller".into());

    if paired.is_none() {
        let conn_id = uuid::Uuid::new_v4().to_string();
        if manager.confirm_guest(&mut guest, &conn_id, Some(name.clone()), "joystick-guest-pin-pending", vec![]).await != Decision::Accept {
            return;
        }
    }

    let (tx, mut rx) = mpsc::channel::<ToGuest>(32);
    let slot = match manager.joystick_hello(&guest.remote_ip, &name, tx).await {
        Ok(slot) => slot,
        Err(error) => return close_with(&mut guest.ws, 4008, &error).await,
    };
    send_json(&mut guest.ws, json!({ "type": "admitted", "padIndex": slot })).await;

    loop {
        tokio::select! {
            incoming = guest.ws.next() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
            outgoing = rx.recv() => match outgoing {
                Some(ToGuest::Ping) => { send_json(&mut guest.ws, json!({ "type": "ping" })).await; }
                Some(ToGuest::Rumble { large, small }) => { send_json(&mut guest.ws, json!({ "type": "rumble", "large": large, "small": small })).await; }
                Some(ToGuest::Kick(reason)) => { close_with(&mut guest.ws, 1000, &reason).await; break; }
                None => break,
            }
        }
    }
    manager.joystick_bye(&guest.remote_ip, "left").await;
}
