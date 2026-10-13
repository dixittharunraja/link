use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::core::guest::{close_with, connect_guest_client, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::host::{remote_control_lines, CAPTURE_INTERVAL};
use crate::core::plugins::{input, screen};
use crate::core::transport::DeviceManager;

// Lets an unpaired phone control this PC as a presenter pointer, touchpad or full remote control:
// it joins over a TLS WebSocket, the user confirms the PIN, and from then on its UDP input lines
// (core/input_relay.rs) are honoured for as long as the socket stays open. Remote control also
// rides the socket itself: this PC streams its screen down as JPEG frames and takes taps, scrolls
// and keys back as {"type":"input"} messages. One guest at a time; a newcomer replaces it.

pub const INPUT_GUEST_PORT: u16 = crate::core::transport::LINK_PORT + 10;

struct InputGuest {
    id: String,
    name: String,
    mode: &'static str,
    kick: mpsc::Sender<&'static str>,
}

#[derive(Default)]
pub struct InputGuests {
    admitted: Mutex<HashMap<String, InputGuest>>,
    client: Mutex<Option<mpsc::Sender<ClientCmd>>>,
}

impl InputGuests {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, InputGuest>) -> T) -> Option<T> {
        self.admitted.lock().ok().map(|mut m| f(&mut m))
    }
}

async fn read_join(guest: &mut GuestSocket) -> Option<Value> {
    while let Some(Ok(message)) = guest.ws.next().await {
        match message {
            Message::Text(text) => return serde_json::from_str(text.as_str()).ok(),
            Message::Close(_) => return None,
            _ => {}
        }
    }
    None
}

async fn stream_screen(frames: mpsc::Sender<Value>) {
    let mut tick = tokio::time::interval(CAPTURE_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let Ok(Some(frame)) = tokio::task::spawn_blocking(|| screen::capture_jpeg(1600, 900, 82)).await else { continue };
        let body = json!({
            "type": "stream",
            "body": { "type": "frame", "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &frame.jpeg), "w": frame.width, "h": frame.height },
        });
        if frames.send(body).await.is_err() {
            break;
        }
    }
}

async fn connection(manager: Arc<DeviceManager>, mut guest: GuestSocket) {
    let Some(first) = read_join(&mut guest).await else {
        return close_with(&mut guest.ws, CLOSE_MALFORMED, "malformed first message").await;
    };
    if first["type"].as_str() != Some("join-guest") {
        return close_with(&mut guest.ws, CLOSE_UNKNOWN_JOIN, "unknown join type").await;
    }
    let mode: &'static str = match first["mode"].as_str() {
        Some("presenter") => "presenter",
        Some("remotecontrol") => "remotecontrol",
        _ => "touchpad",
    };
    let paired = manager.paired_name_for_cert(&guest.peer_cert).await;
    let name = paired
        .clone()
        .or_else(|| first["deviceName"].as_str().map(str::to_string))
        .unwrap_or_else(|| match mode {
            "presenter" => "Presenter".into(),
            "remotecontrol" => "Remote Control".into(),
            _ => "Touchpad".into(),
        });

    if paired.is_none() {
        let conn_id = uuid::Uuid::new_v4().to_string();
        if manager.confirm_guest(&mut guest, &conn_id, Some(name.clone()), "input-guest-pin-pending", vec![json!(mode)]).await != Decision::Accept {
            return;
        }
    }

    // A newcomer replaces whoever was admitted before.
    let (kick_tx, mut kick_rx) = mpsc::channel::<&'static str>(1);
    let id = uuid::Uuid::new_v4().to_string();
    manager.input_guests.with(|guests| {
        for (ip, old) in guests.drain() {
            if ip != guest.remote_ip {
                let _ = old.kick.try_send("replaced by new connection");
            }
        }
        guests.insert(guest.remote_ip.clone(), InputGuest { id: id.clone(), name: name.clone(), mode, kick: kick_tx });
    });
    send_json(&mut guest.ws, json!({ "type": "admitted", "mode": mode, "hostDeviceType": "desktop" })).await;
    manager.emit_event("input-guest-roster-changed", Value::Null).await;

    // Two frames of buffer at most: capture waits for a slow viewer rather than queueing a stale screen.
    let (frames_tx, mut frames_rx) = mpsc::channel::<Value>(2);
    let capture = (mode == "remotecontrol").then(|| tokio::spawn(stream_screen(frames_tx))).map(|task| task.abort_handle());

    loop {
        tokio::select! {
            incoming = guest.ws.next() => match incoming {
                Some(Ok(Message::Text(text))) if mode == "remotecontrol" => {
                    let Ok(message) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    match message["type"].as_str() {
                        Some("input") => {
                            for line in remote_control_lines(&message["body"]) {
                                input::run_line(&line);
                            }
                        }
                        Some("signal") if message["body"]["type"].as_str() == Some("stop") => break,
                        _ => {}
                    }
                }
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
            Some(frame) = frames_rx.recv() => {
                // A slow viewer can stall this write for a long time; a kick must not wait for it.
                let sent = tokio::select! {
                    sent = send_json(&mut guest.ws, frame) => sent,
                    _ = kick_rx.recv() => false,
                };
                if !sent {
                    break;
                }
            }
            reason = kick_rx.recv() => {
                close_with(&mut guest.ws, 1000, reason.unwrap_or("removed by host")).await;
                break;
            }
        }
    }
    if let Some(capture) = capture {
        capture.abort();
    }
    manager.input_guests.with(|guests| {
        if guests.get(&guest.remote_ip).is_some_and(|g| g.id == id) {
            guests.remove(&guest.remote_ip);
        }
    });
    manager.emit_event("input-guest-roster-changed", Value::Null).await;
}

impl DeviceManager {
    pub async fn start_input_guest_server(self: &Arc<Self>) -> Result<(), String> {
        self.serve_guests(INPUT_GUEST_PORT, "Input guest server", connection).await.map(|_| ())
    }

    /// Whether this address is an admitted guest allowed to act in `mode`. A touchpad guest also
    /// covers presenter; when exactly one guest is admitted a NAT-rewritten address still matches it.
    pub(crate) fn input_guest_admitted(&self, ip: &str, mode: &str) -> bool {
        self.input_guests
            .with(|guests| {
                let ip = ip.trim_start_matches("::ffff:");
                let guest = guests.get(ip).or_else(|| (guests.len() == 1).then(|| guests.values().next()).flatten());
                guest.is_some_and(|g| g.mode == mode || g.mode == "touchpad")
            })
            .unwrap_or(false)
    }

    pub async fn input_guest_roster(&self) -> Value {
        let guests = self
            .input_guests
            .with(|g| g.iter().map(|(ip, guest)| json!({ "ip": ip, "name": guest.name, "mode": guest.mode })).collect::<Vec<_>>())
            .unwrap_or_default();
        json!({ "admittedGuests": guests, "pairedSessions": self.paired_input_sessions().await })
    }

    /// Removes whoever is driving the presenter or remote input: a guest (by address) has its
    /// socket closed; a paired device (by address or device id) loses its live session and is told
    /// to close its screen, since it has no socket of its own to close.
    pub async fn kick_input(&self, target: &str) {
        let paired_ip = self.connected_peers().await.into_iter().find(|p| p["deviceId"].as_str() == Some(target)).and_then(|p| p["ipAddress"].as_str().map(str::to_string));
        let ip = paired_ip.clone().unwrap_or_else(|| target.to_string());
        // Dropped from the roster at once: the socket may take a while to wind down.
        self.input_guests.with(|guests| {
            if let Some(guest) = guests.remove(&ip) {
                let _ = guest.kick.try_send("removed by host");
            }
        });
        let paired_id = match paired_ip {
            Some(_) => Some(target.to_string()),
            None => self.paired_device_at(&ip).await,
        };
        if let Some(device_id) = paired_id {
            self.clear_input_activity(&device_id).await;
            let _ = self.send_packet(&device_id, "link.input.kicked", json!({})).await;
        }
        self.emit_event("input-guest-roster-changed", Value::Null).await;
    }
}

// ---- joining another device's input-guest server (this PC as the remote-control viewer) ----

enum ClientCmd {
    Packet(String, Value),
    Leave,
}

impl DeviceManager {
    /// Joins a phone's guest server by address (several, comma separated, are raced). The phone
    /// shows the PIN and asks its user; a paired device is let straight in.
    pub async fn join_input_guest(self: &Arc<Self>, host: &str, name: Option<String>, mode: &str) -> Result<(), String> {
        self.leave_input_guest().await;
        let hosts: Vec<&str> = host.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
        if hosts.is_empty() {
            return Err("No address to connect to".into());
        }
        let attempts = hosts.iter().map(|h| Box::pin(connect_guest_client(self, h, INPUT_GUEST_PORT)));
        let (mut ws, server_cert) = match futures_util::future::select_ok(attempts).await {
            Ok((connected, _)) => connected,
            Err(message) => {
                self.emit_event("input-guest-error", json!({ "error": message })).await;
                return Ok(());
            }
        };
        let Ok(peer) = ws.get_ref().get_ref().0.peer_addr() else { return Err("The connection closed immediately".into()) };

        self.emit_event("input-guest-pin-required", json!({ "pin": self.guest_pin(&server_cert) })).await;
        let name = match name {
            Some(name) => name,
            None => self.device_name.read().await.clone(),
        };
        send_json(&mut ws, json!({ "type": "join-guest", "deviceName": name, "mode": mode })).await;

        let (tx, mut commands) = mpsc::channel(32);
        self.input_guests.client.lock().map(|mut c| *c = Some(tx)).ok();
        let manager = self.clone();
        tokio::spawn(async move {
            let reason = loop {
                tokio::select! {
                    incoming = ws.next() => match incoming {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                            match msg["type"].as_str() {
                                Some("admitted") => manager.emit_event("input-guest-admitted", json!({
                                    "mode": msg["mode"], "host": peer.ip().to_string(), "hostDeviceType": msg["hostDeviceType"],
                                })).await,
                                Some("packet") => manager.emit_event("input-guest-packet", json!({ "packetType": msg["packetType"], "body": msg["body"] })).await,
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(frame))) => break frame.map(|f| f.reason.to_string()).filter(|r| !r.is_empty()).unwrap_or_else(|| "disconnected".into()),
                        None | Some(Err(_)) => break "connection lost".to_string(),
                        _ => {}
                    },
                    command = commands.recv() => match command {
                        Some(ClientCmd::Packet(packet_type, body)) => { send_json(&mut ws, json!({ "type": "packet", "packetType": packet_type, "body": body })).await; }
                        Some(ClientCmd::Leave) | None => {
                            let _ = ws.close(None).await;
                            return;
                        }
                    }
                }
            };
            manager.input_guests.client.lock().map(|mut c| *c = None).ok();
            manager.emit_event("input-guest-closed", json!({ "reason": reason })).await;
        });
        Ok(())
    }

    pub async fn leave_input_guest(&self) {
        let session = self.input_guests.client.lock().ok().and_then(|mut c| c.take());
        if let Some(tx) = session {
            let _ = tx.send(ClientCmd::Leave).await;
        }
    }

    pub async fn send_input_guest_packet(&self, packet_type: String, body: Value) {
        let session = self.input_guests.client.lock().ok().and_then(|c| c.clone());
        if let Some(tx) = session {
            let _ = tx.send(ClientCmd::Packet(packet_type, body)).await;
        }
    }
}
