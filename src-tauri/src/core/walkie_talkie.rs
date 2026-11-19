use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::core::guest::{close_with, connect_guest_client, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::transport::DeviceManager;

// Walkie-talkie signalling for devices that are not paired. The audio itself is WebRTC inside the
// WebView; only the session messages travel here, as {type, body} JSON, between a host listening on
// WALKIE_TALKIE_PORT and its guests. Paired devices use the normal TLS connection instead.

pub const WALKIE_TALKIE_PORT: u16 = crate::core::transport::LINK_PORT + 8;

enum Outgoing {
    Signal(String, Value),
    Kick,
}

struct Guest {
    ip: String,
    tx: mpsc::Sender<Outgoing>,
}

#[derive(Default)]
pub struct WalkieTalkie {
    guests: Mutex<HashMap<String, Guest>>,
    server: Mutex<Option<tokio::task::AbortHandle>>,
    // The session this PC joined as a guest of another device.
    client: Mutex<Option<mpsc::Sender<ClientCommand>>>,
}

enum ClientCommand {
    Send(String, Value),
    Leave,
}

async fn guest_connection(manager: Arc<DeviceManager>, mut guest: GuestSocket) {
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
        return close_with(&mut guest.ws, CLOSE_MALFORMED, "malformed join message").await;
    };
    if first["type"].as_str() != Some("join-guest") {
        return close_with(&mut guest.ws, CLOSE_UNKNOWN_JOIN, "unknown join type").await;
    }
    let name = first["deviceName"].as_str().unwrap_or("Guest").to_string();
    let conn_id = uuid::Uuid::new_v4().to_string();
    // Registered before the PIN prompt: the host UI sends its first signal the moment it accepts,
    // and that has to queue behind the admission rather than find nobody there.
    let (tx, mut rx) = mpsc::channel::<Outgoing>(64);
    manager.walkie.guests.lock().map(|mut g| g.insert(conn_id.clone(), Guest { ip: guest.remote_ip.clone(), tx })).ok();
    // The UI admits a member only on an explicit accept, so a paired device (which skips the PIN)
    // is announced as joined here instead. It is listed under the name it sends, which is current;
    // the paired record may still hold the name it had when it was paired.
    if manager.paired_name_for_cert(&guest.peer_cert).await.is_some() {
        manager.emit_event("walkie-talkie-guest-joined", json!([conn_id, guest.remote_ip, name])).await;
    }
    if manager.confirm_guest(&mut guest, &conn_id, Some(name), "walkie-talkie-guest-pin-pending", vec![]).await != Decision::Accept {
        manager.walkie.guests.lock().map(|mut g| g.remove(&conn_id)).ok();
        return;
    }

    send_json(&mut guest.ws, json!({ "type": "admitted" })).await;

    loop {
        tokio::select! {
            incoming = guest.ws.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) {
                        manager.emit_event("walkie-talkie-guest-signal", json!([conn_id, msg["type"], msg["body"]])).await;
                    }
                }
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
            outgoing = rx.recv() => match outgoing {
                Some(Outgoing::Signal(kind, body)) => { send_json(&mut guest.ws, json!({ "type": kind, "body": body })).await; }
                Some(Outgoing::Kick) | None => {
                    close_with(&mut guest.ws, 1000, "removed by host").await;
                    break;
                }
            }
        }
    }
    manager.walkie.guests.lock().map(|mut g| g.remove(&conn_id)).ok();
    manager.emit_event("walkie-talkie-guest-left", json!(conn_id)).await;
}

impl DeviceManager {
    pub async fn start_walkie_talkie_listener(self: &Arc<Self>) -> Result<u16, String> {
        if self.walkie.server.lock().map(|s| s.is_some()).unwrap_or(false) {
            return Ok(WALKIE_TALKIE_PORT);
        }
        let handle = self.serve_guests(WALKIE_TALKIE_PORT, "Walkie-talkie guest listener", guest_connection).await?;
        self.walkie.server.lock().map(|mut s| *s = Some(handle)).ok();
        Ok(WALKIE_TALKIE_PORT)
    }

    pub async fn stop_walkie_talkie_listener(&self) {
        if let Some(handle) = self.walkie.server.lock().ok().and_then(|mut s| s.take()) {
            handle.abort();
        }
        let guests: Vec<Guest> = self.walkie.guests.lock().map(|mut g| g.drain().map(|(_, v)| v).collect()).unwrap_or_default();
        for guest in guests {
            let _ = guest.tx.send(Outgoing::Kick).await;
        }
    }

    fn walkie_guest(&self, conn_id: &str) -> Option<mpsc::Sender<Outgoing>> {
        self.walkie.guests.lock().ok()?.get(conn_id).map(|g| g.tx.clone())
    }

    pub fn walkie_guest_ip(&self, conn_id: &str) -> Option<String> {
        self.walkie.guests.lock().ok()?.get(conn_id).map(|g| g.ip.clone())
    }

    pub async fn walkie_guest_signal(&self, conn_id: &str, kind: &str, body: Value) {
        if let Some(tx) = self.walkie_guest(conn_id) {
            let _ = tx.send(Outgoing::Signal(kind.to_string(), body)).await;
        }
    }

    pub async fn kick_walkie_guest(&self, conn_id: &str) {
        if let Some(tx) = self.walkie_guest(conn_id) {
            let _ = tx.send(Outgoing::Kick).await;
        }
    }

    // ---- joining someone else's session as a guest ----

    pub async fn join_walkie_talkie_guest(self: &Arc<Self>, host: &str) -> Result<(), String> {
        self.leave_walkie_talkie_guest().await;
        // A host lists every address it has and only some are reachable from here: try them together
        // and keep whichever answers first.
        let hosts: Vec<&str> = host.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
        if hosts.is_empty() {
            return Err("No address to connect to".into());
        }
        let attempts = hosts.iter().map(|h| Box::pin(connect_guest_client(self, h, WALKIE_TALKIE_PORT)));
        let (mut ws, server_cert) = match futures_util::future::select_ok(attempts).await {
            Ok((connected, _)) => connected,
            Err(message) => {
                self.emit_event("walkie-talkie-host-error", json!({ "message": message })).await;
                return Ok(());
            }
        };
        let (tx, mut rx) = mpsc::channel::<ClientCommand>(32);
        self.walkie.client.lock().map(|mut c| *c = Some(tx)).ok();

        // The host's certificate is known from the handshake, so the PIN is computed locally.
        let pin = self.client_pin(&server_cert);
        self.emit_event("walkie-talkie-guest-pin-computed", json!({ "pin": pin })).await;
        let name = self.device_name.read().await.clone();
        send_json(&mut ws, json!({ "type": "join-guest", "deviceName": name })).await;

        let manager = self.clone();
        tokio::spawn(async move {
            let mut reason = String::new();
            let mut graceful = false;
            loop {
                tokio::select! {
                    incoming = ws.next() => match incoming {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                            match msg["type"].as_str() {
                                Some("admitted") | Some("pin") => {}
                                _ => manager.emit_event("walkie-talkie-host-signal", json!({ "type": msg["type"], "body": msg["body"] })).await,
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            if let Some(frame) = frame {
                                reason = frame.reason.to_string();
                                graceful = matches!(u16::from(frame.code), 1000 | 1001);
                            }
                            break;
                        }
                        None | Some(Err(_)) => { reason = "connection lost".into(); break; }
                        _ => {}
                    },
                    command = rx.recv() => match command {
                        Some(ClientCommand::Send(kind, body)) => { send_json(&mut ws, json!({ "type": kind, "body": body })).await; }
                        Some(ClientCommand::Leave) | None => { let _ = ws.close(None).await; return; }
                    }
                }
            }
            manager.walkie.client.lock().map(|mut c| *c = None).ok();
            let event = if graceful { "walkie-talkie-host-ended" } else { "walkie-talkie-host-closed" };
            manager.emit_event(event, json!({ "reason": reason })).await;
        });
        Ok(())
    }

    pub async fn leave_walkie_talkie_guest(&self) {
        let tx = self.walkie.client.lock().ok().and_then(|mut c| c.take());
        if let Some(tx) = tx {
            let _ = tx.send(ClientCommand::Leave).await;
        }
    }

    pub async fn send_walkie_talkie_guest_message(&self, kind: &str, body: Value) {
        let tx = self.walkie.client.lock().ok().and_then(|c| c.clone());
        if let Some(tx) = tx {
            let _ = tx.send(ClientCommand::Send(kind.to_string(), body)).await;
        }
    }
}
