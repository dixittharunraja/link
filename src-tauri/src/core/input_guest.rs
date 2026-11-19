use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::core::guest::{close_with, connect_guest_client, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::host::{place_on_monitor, remote_control_lines};
use crate::core::plugins::input;
use crate::core::rtc_share;
use crate::core::transport::DeviceManager;

// Lets an unpaired phone control this PC as a presenter pointer, touchpad or full remote control, or
// extend it as an extra screen (remote control of a monitor made for that guest, see claim_guest_screen):
// it joins over a TLS WebSocket, the user confirms the PIN, and from then on its UDP input lines
// (core/input_relay.rs) are honoured for as long as the socket stays open, when they come from its
// address, carry the token it was handed on admission, and suit the mode it joined in. Any number of
// touchpad and remote-control guests may be admitted at once; only one device presents at a time
// (guest or paired, see claim_presenter in host.rs), and a second presenter is refused as busy.
//
// Remote control works as it does for a paired phone (core/rtc_share.rs): the screen goes out as a
// WebRTC H.264 video track. Only the signalling differs: it rides this socket as
// {"type":"packet","packetType":"link.remotecontrol.signal","body":...} messages both ways, and the
// viewer's taps, scrolls and keys come back as "link.remotecontrol.input" packets, the same messages
// a phone hosting a guest exchanges (LinkInputGuestServer.java).

pub const INPUT_GUEST_PORT: u16 = crate::core::transport::LINK_PORT + 10;

/// A viewer repeats its request until video arrives; a session younger than this is still being
/// set up, and a repeated request leaves it alone.
const SHARE_SETTLE: Duration = Duration::from_secs(8);

// A guest socket that has said nothing for GUEST_IDLE is dropped (and any held mouse button released); it is
// pinged every GUEST_PING so a quiet but live guest answers and stays.
const GUEST_IDLE: Duration = Duration::from_secs(45);
const GUEST_PING: Duration = Duration::from_secs(15);

struct InputGuest {
    id: String,
    name: String,
    mode: &'static str,
    token: String,
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

/// A remote-control guest's screen-share session. Dropping it ends the session.
struct GuestShare {
    task: tokio::task::JoinHandle<()>,
    started: Instant,
    /// Where the viewer's answer and ICE candidates go.
    signals: mpsc::UnboundedSender<rtc_share::Signal>,
}

impl Drop for GuestShare {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts streaming to a guest that asked for it, unless a session is already being set up: the main
/// screen for remote control, or `extended` (the extra screen claimed for this guest) when it extends
/// this PC. `out` takes the session's signalling for the guest's socket.
async fn start_share(
    manager: &Arc<DeviceManager>,
    name: &str,
    request: &Value,
    extended: Option<Arc<AtomicU32>>,
    out: &mpsc::UnboundedSender<Value>,
    share: &mut Option<GuestShare>,
) {
    if share.as_ref().is_some_and(|s| !s.task.is_finished() && s.started.elapsed() < SHARE_SETTLE) {
        return;
    }
    if !manager.h264_ready().await {
        return;
    }
    let (signals, signals_rx) = mpsc::unbounded_channel();
    let viewer = rtc_share::Viewer::Guest { name: name.to_string(), signals: out.clone() };
    let (display, screen) = match extended {
        Some(screen) => (rtc_share::Display::Extended, screen),
        None => (rtc_share::Display::Primary, Arc::new(AtomicU32::new(0))),
    };
    let task = tokio::spawn(rtc_share::run(manager.clone(), viewer, display, screen, rtc_share::viewport_from_request(request), signals_rx));
    // Replacing an older session ends it.
    *share = Some(GuestShare { task, started: Instant::now(), signals });
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
        Some("extendscreen") => "extendscreen",
        _ => "touchpad",
    };
    // Extending is remote control of an extra screen made for this guest, so it shares that path.
    let streams = matches!(mode, "remotecontrol" | "extendscreen");
    let paired = manager.paired_name_for_cert(&guest.peer_cert).await;
    let name = paired
        .clone()
        .or_else(|| first["deviceName"].as_str().map(str::to_string))
        .unwrap_or_else(|| match mode {
            "presenter" => "Presenter".into(),
            "remotecontrol" => "Remote Control".into(),
            "extendscreen" => "Extended Screen".into(),
            _ => "Touchpad".into(),
        });

    // One controller at a time: a paired phone is keyed by its device id so it cannot hold the slot
    // twice (over UDP and as a guest); an unpaired one by its address.
    let key = match manager.paired_device_at(&guest.remote_ip).await {
        Some(device_id) if paired.is_some() => device_id,
        _ => format!("guest:{}", guest.remote_ip),
    };

    if paired.is_none() {
        let conn_id = uuid::Uuid::new_v4().to_string();
        if manager.confirm_guest(&mut guest, &conn_id, Some(name.clone()), "input-guest-pin-pending", vec![json!(mode)]).await != Decision::Accept {
            return;
        }
    }

    // Only one presenter at a time: refuse a newcomer while someone else holds the slot. Touchpad
    // and remote-control guests are not limited.
    if mode == "presenter" && !manager.claim_presenter(&key, true).await {
        return close_with(&mut guest.ws, 1008, "busy: another device is already presenting").await;
    }
    let (kick_tx, mut kick_rx) = mpsc::channel::<&'static str>(1);
    let id = uuid::Uuid::new_v4().to_string();
    let token = crate::core::input_relay::new_input_token();
    manager.input_guests.with(|guests| {
        // Only this address's own earlier connection can still be here; it is superseded.
        if let Some(old) = guests.remove(&guest.remote_ip) {
            let _ = old.kick.try_send("replaced by new connection");
        }
        guests.insert(guest.remote_ip.clone(), InputGuest { id: id.clone(), name: name.clone(), mode, token: token.clone(), kick: kick_tx });
    });
    send_json(&mut guest.ws, json!({ "type": "admitted", "mode": mode, "hostDeviceType": "desktop", "inputToken": token })).await;
    manager.emit_event("input-guest-roster-changed", Value::Null).await;

    // The screen-share session's signalling on its way to the guest, and the session itself.
    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel::<Value>();
    let mut share: Option<GuestShare> = None;
    // The extra screen an extending guest was given (claimed on its first request, kept across retries).
    let mut extended: Option<Arc<AtomicU32>> = None;
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + GUEST_PING, GUEST_PING);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_rx = Instant::now();
    loop {
        tokio::select! {
            incoming = guest.ws.next() => {
                last_rx = Instant::now();
                match incoming {
                Some(Ok(Message::Text(text))) if streams => {
                    let Ok(message) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    if message["type"].as_str() != Some("packet") {
                        continue;
                    }
                    let body = &message["body"];
                    match message["packetType"].as_str() {
                        Some("link.remotecontrol.input") => {
                            // On the extra screen, a tap lands on that monitor rather than the main one.
                            let screen = extended.as_ref().map(|s| s.load(std::sync::atomic::Ordering::Relaxed)).filter(|s| *s != 0);
                            let monitor = match screen {
                                Some(screen) => tokio::task::spawn_blocking(move || rtc_share::second_screen(screen)).await.ok().flatten(),
                                None => None,
                            };
                            for line in remote_control_lines(body) {
                                input::run_line(&place_on_monitor(line, monitor));
                            }
                        }
                        Some("link.remotecontrol.signal") => match body["type"].as_str() {
                            Some("request") if mode == "extendscreen" => {
                                if extended.is_none() {
                                    extended = manager.claim_guest_screen(&key).await;
                                }
                                match &extended {
                                    Some(screen) => start_share(&manager, &name, body, Some(screen.clone()), &signal_tx, &mut share).await,
                                    // Nothing to extend onto: the viewer says how to add a second screen.
                                    None => {
                                        let _ = signal_tx.send(json!({ "type": "no_second_screen" }));
                                    }
                                }
                            }
                            Some("request") => start_share(&manager, &name, body, None, &signal_tx, &mut share).await,
                            Some("stop") => break,
                            _ => {
                                if let (Some(signal), Some(session)) = (rtc_share::parse_signal(body), share.as_ref()) {
                                    let _ = session.signals.send(signal);
                                }
                            }
                        },
                        _ => {}
                    }
                }
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
                }
            },
            _ = ping.tick() => {
                if last_rx.elapsed() >= GUEST_IDLE {
                    log::info!("Input guest {} idle for {:?}; dropping it", guest.remote_ip, GUEST_IDLE);
                    // A guest that vanished mid-drag must not leave the button held down.
                    if mode != "presenter" {
                        input::run_line("release left");
                        input::run_line("touch false");
                    }
                    break;
                }
                let sent = tokio::select! {
                    sent = guest.ws.send(Message::Ping(Default::default())) => sent.is_ok(),
                    _ = kick_rx.recv() => false,
                };
                if !sent {
                    break;
                }
            }
            Some(body) = signal_rx.recv() => {
                let packet = json!({ "type": "packet", "packetType": "link.remotecontrol.signal", "body": body });
                // A slow viewer can stall this write; a kick must not wait for it.
                let sent = tokio::select! {
                    sent = guest.ws.send(Message::Text(packet.to_string().into())) => sent.is_ok(),
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
    drop(share);
    let still_mine = manager.input_guests.with(|guests| guests.get(&guest.remote_ip).is_some_and(|g| g.id == id)).unwrap_or(false);
    if still_mine {
        manager.input_guests.with(|guests| guests.remove(&guest.remote_ip));
    }
    // Freed unless this address reconnected meanwhile, or the host kicked it (which already freed it).
    let reconnected = manager.input_guests.with(|guests| guests.contains_key(&guest.remote_ip)).unwrap_or(false);
    if mode == "presenter" && !reconnected {
        manager.release_presenter(&key).await;
    }
    if mode == "extendscreen" && !reconnected {
        manager.release_guest_screen(&key).await;
    }
    manager.emit_event("input-guest-roster-changed", Value::Null).await;
}

impl DeviceManager {
    pub async fn start_input_guest_server(self: &Arc<Self>) -> Result<(), String> {
        self.serve_guests(INPUT_GUEST_PORT, "Input guest server", connection).await.map(|_| ())
    }

    /// The mode of the guest admitted at this address with this token, if any.
    pub(crate) fn input_guest_mode(&self, ip: &str, token: &str) -> Option<&'static str> {
        self.input_guests
            .with(|guests| {
                let ip = ip.trim_start_matches("::ffff:");
                guests.get(ip).filter(|g| g.token == token).map(|g| g.mode)
            })
            .flatten()
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
        crate::core::input_relay::forget_input_senders();
        let paired_ip = self.connected_peers().await.into_iter().find(|p| p["deviceId"].as_str() == Some(target)).and_then(|p| p["ipAddress"].as_str().map(str::to_string));
        let ip = paired_ip.clone().unwrap_or_else(|| target.to_string());
        // Dropped from the roster at once: the socket may take a while to wind down.
        let removed = self
            .input_guests
            .with(|guests| guests.remove(&ip).map(|guest| { let _ = guest.kick.try_send("removed by host"); }).is_some())
            .unwrap_or(false);
        if removed {
            self.release_presenter(&format!("guest:{}", ip)).await;
        }
        let paired_id = match paired_ip {
            Some(_) => Some(target.to_string()),
            None => self.paired_device_at(&ip).await,
        };
        if let Some(device_id) = paired_id {
            self.clear_input_activity(&device_id).await;
            let _ = self.send_packet(&device_id, "link.input.kicked", json!({})).await;
            self.rotate_input_token(&device_id).await;
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

        self.emit_event("input-guest-pin-required", json!({ "pin": self.client_pin(&server_cert) })).await;
        let name = match name {
            Some(name) => name,
            None => self.device_name.read().await.clone(),
        };
        send_json(&mut ws, json!({ "type": "join-guest", "deviceName": name, "mode": mode })).await;

        let (tx, mut commands) = mpsc::channel(32);
        self.input_guests.client.lock().map(|mut c| *c = Some(tx)).ok();
        let manager = self.clone();
        tokio::spawn(async move {
            let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + GUEST_PING, GUEST_PING);
            ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last_rx = Instant::now();
            let reason = loop {
                tokio::select! {
                    incoming = ws.next() => {
                    last_rx = Instant::now();
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                            match msg["type"].as_str() {
                                Some("admitted") => manager.emit_event("input-guest-admitted", json!({
                                    "mode": msg["mode"], "host": peer.ip().to_string(), "hostDeviceType": msg["hostDeviceType"],
                                })).await,
                                // Remote control: the host's WebRTC signalling for the viewer.
                                Some("packet") => manager.emit_event("input-guest-packet", json!({ "packetType": msg["packetType"], "body": msg["body"] })).await,
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(frame))) => break frame.map(|f| f.reason.to_string()).filter(|r| !r.is_empty()).unwrap_or_else(|| "disconnected".into()),
                        None | Some(Err(_)) => break "connection lost".to_string(),
                        _ => {}
                    }
                    },
                    _ = ping.tick() => {
                        if last_rx.elapsed() >= GUEST_IDLE || ws.send(Message::Ping(Default::default())).await.is_err() {
                            break "connection lost".to_string();
                        }
                    }
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
