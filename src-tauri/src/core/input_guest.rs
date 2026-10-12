use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::core::guest::{close_with, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
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
                send_json(&mut guest.ws, frame).await;
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

    pub fn kick_input_guest(&self, ip: &str) {
        self.input_guests.with(|guests| {
            if let Some(guest) = guests.get(ip) {
                let _ = guest.kick.try_send("removed by host");
            }
        });
    }
}
