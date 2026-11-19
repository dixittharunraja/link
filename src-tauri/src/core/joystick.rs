use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::core::plugins::gamepad::{self, Command, Gamepads, Rumble, Unavailable, MAX_PADS};
use crate::core::guest::{close_with, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::transport::DeviceManager;

// A phone as a game controller: the phone joins over a TLS WebSocket (PIN confirmed unless it is
// paired), then streams stick/button state as UDP "<token> js ..." lines to the input relay, with
// the token it was handed on admission. Each
// controller gets one of four virtual Xbox pads, created through the ViGEm driver. Rumble from
// games travels back to the phone, and a controller that goes quiet is unplugged.

pub const JOYSTICK_PORT: u16 = crate::core::transport::LINK_PORT + 9;
const SWEEP_INTERVAL: Duration = Duration::from_secs(3);
const LIVENESS_TIMEOUT: Duration = Duration::from_secs(8);
const PING_INTERVAL: Duration = Duration::from_secs(1);

enum ToGuest {
    Ping,
    Rumble { large: u8, small: u8 },
    Kick(String),
}

struct Controller {
    slot: usize,
    name: String,
    token: String,
    last_seen: Instant,
    tx: mpsc::Sender<ToGuest>,
}

#[derive(Default)]
struct Driver {
    status: String,
    error: Option<String>,
}

#[derive(Default)]
pub struct Joystick {
    controllers: Mutex<HashMap<String, Controller>>,
    driver: tokio::sync::Mutex<Driver>,
    /// The driver's command queue once it is connected; it stays for as long as the app runs. Kept
    /// apart from `driver` so controller reports (about 60 a second per phone) reach it without
    /// taking that lock.
    pads: OnceLock<Gamepads>,
}

impl DeviceManager {
    /// Connects to the virtual-controller driver if not already; false when it is missing or unusable.
    async fn start_joystick_driver(self: &Arc<Self>) -> bool {
        // Held across the connect, so two joiners at once don't start two driver threads.
        let mut driver = self.joystick.driver.lock().await;
        if self.joystick.pads.get().is_some() {
            return true;
        }
        let (rumble_tx, mut rumble_rx) = mpsc::unbounded_channel();
        let outcome = gamepad::start(rumble_tx).await;
        let (status, error) = match &outcome {
            Ok(_) => ("ready", None),
            Err(Unavailable::NotInstalled) => ("missing", Some("driver_not_found".to_string())),
            Err(Unavailable::Other(reason)) => {
                log::warn!("Virtual controller driver unavailable: {}", reason);
                ("error", Some(reason.clone()))
            }
        };
        driver.status = status.to_string();
        driver.error = error.clone();
        let started = outcome.map(|pads| drop(self.joystick.pads.set(pads))).is_ok();
        drop(driver);
        self.emit_event("joystick-driver-status", json!({ "status": status, "error": error })).await;
        if started {
            let manager = self.clone();
            tokio::spawn(async move {
                while let Some(rumble) = rumble_rx.recv().await {
                    manager.joystick_rumble(rumble).await;
                }
            });
        }
        started
    }

    async fn joystick_rumble(&self, rumble: Rumble) {
        let tx = self.joystick.controllers.lock().ok().and_then(|c| c.values().find(|c| c.slot == rumble.slot).map(|c| c.tx.clone()));
        if let Some(tx) = tx {
            let _ = tx.send(ToGuest::Rumble { large: rumble.large, small: rumble.small }).await;
        }
    }

    async fn joystick_command(&self, command: Command) {
        if let Some(pads) = self.joystick.pads.get() {
            pads.send(command);
        }
    }

    /// Plugs a controller in on the first free virtual pad.
    async fn joystick_hello(self: &Arc<Self>, ip: &str, name: &str, token: &str, tx: mpsc::Sender<ToGuest>) -> Result<usize, String> {
        if self.is_blocked(ip) {
            return Err("blocked".into());
        }
        if !self.start_joystick_driver().await {
            return Err("helper_not_ready".into());
        }
        let slot = {
            let mut controllers = self.joystick.controllers.lock().map_err(|e| e.to_string())?;
            if let Some(existing) = controllers.get_mut(ip) {
                existing.name = name.to_string();
                existing.token = token.to_string();
                existing.last_seen = Instant::now();
                existing.tx = tx;
                return Ok(existing.slot);
            }
            let slot = (0..MAX_PADS).find(|s| controllers.values().all(|c| c.slot != *s)).ok_or("slots_full")?;
            controllers.insert(ip.to_string(), Controller { slot, name: name.to_string(), token: token.to_string(), last_seen: Instant::now(), tx });
            slot
        };
        log::info!("Joystick controller {} ({}) joined as pad {}", name, ip, slot);
        self.joystick_command(Command::Plug(slot)).await;
        self.emit_event("joystick-roster-changed", Value::Null).await;
        Ok(slot)
    }

    pub async fn joystick_bye(&self, ip: &str, reason: &str) {
        let removed = self.joystick.controllers.lock().ok().and_then(|mut c| c.remove(ip));
        let Some(controller) = removed else { return };
        log::info!("Joystick controller {} ({}) left pad {}: {}", controller.name, ip, controller.slot, reason);
        self.joystick_command(Command::Unplug(controller.slot)).await;
        if reason != "left" {
            let _ = controller.tx.send(ToGuest::Kick(reason.to_string())).await;
        }
        self.emit_event("joystick-roster-changed", Value::Null).await;
    }

    /// A "js ..." line from the UDP relay; only acts for a joined controller at this address that
    /// sent the token it was admitted with.
    pub(crate) async fn joystick_state(&self, ip: &str, token: &str, line: &str) {
        if self.is_blocked(ip) {
            return;
        }
        let slot = self.joystick.controllers.lock().ok().and_then(|mut c| {
            c.get_mut(ip).filter(|controller| controller.token == token).map(|controller| {
                controller.last_seen = Instant::now();
                controller.slot
            })
        });
        let Some(slot) = slot else { return };
        // "lx ly rx ry lt rt buttons", read straight into place.
        let mut values = [0i32; 7];
        let mut count = 0;
        for (place, value) in values.iter_mut().zip(line.split_whitespace().filter_map(|part| part.parse().ok())) {
            *place = value;
            count += 1;
        }
        if let (7, [lx, ly, rx, ry, lt, rt, buttons]) = (count, values) {
            self.joystick_command(Command::Report { slot, lx, ly, rx, ry, lt, rt, buttons }).await;
        }
    }

    pub async fn joystick_status(&self) -> Value {
        let (status, error) = {
            let driver = self.joystick.driver.lock().await;
            (if driver.status.is_empty() { "unknown".to_string() } else { driver.status.clone() }, driver.error.clone())
        };
        let controllers: Vec<Value> = self
            .joystick
            .controllers
            .lock()
            .map(|c| c.iter().map(|(ip, c)| json!({ "ip": ip, "name": c.name, "padIndex": c.slot })).collect())
            .unwrap_or_default();
        json!({ "driverStatus": status, "driverError": error, "connectedControllers": controllers })
    }

    /// "Verify installation": actively probes the driver rather than reading a cache.
    pub async fn check_joystick_driver(self: &Arc<Self>) -> Value {
        self.start_joystick_driver().await;
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
    let token = crate::core::input_relay::new_input_token();
    let slot = match manager.joystick_hello(&guest.remote_ip, &name, &token, tx).await {
        Ok(slot) => slot,
        Err(error) => return close_with(&mut guest.ws, 4008, &error).await,
    };
    send_json(&mut guest.ws, json!({ "type": "admitted", "padIndex": slot, "inputToken": token })).await;

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
