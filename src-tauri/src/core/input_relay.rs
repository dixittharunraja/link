use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use socket2::{Domain, Socket, Type};
use tokio::net::UdpSocket;

use crate::core::plugins::input;
use crate::core::transport::DeviceManager;

// Low-latency path for phone input: one text line per UDP datagram, "<token> <command>" (commands
// such as "move dx dy", "click left", "pmove dx dy", "dig x y true", "js ..."). Datagrams are
// unauthenticated, so the receiver hands each sender a random token over an authenticated TLS
// channel first: the control connection for a paired device ("link.input.token"), the WebSocket
// admission for an input guest or joystick ("inputToken" in "admitted"). A line acts only when its
// token belongs to a live session and arrives from that session's address; what it may do then
// depends on the session: a paired device's permissions, or the mode a guest was admitted for.

pub const INPUT_RELAY_PORT: u16 = 1717;
pub const PACKET_TYPE_INPUT_TOKEN: &str = "link.input.token";

/// A fresh 128-bit token, as 32 hex characters.
pub fn new_input_token() -> String {
    let mut bytes = [0u8; 16];
    SystemRandom::new().fill(&mut bytes).expect("system random source");
    hex::encode(bytes)
}

/// Who a UDP input line comes from, once its token and address check out.
#[derive(Clone)]
enum InputSender {
    Paired(String),
    Guest(&'static str),
}

/// Logs a refused UDP input line, at most once per sender address every 10 seconds; a refused
/// sender usually keeps sending many lines a second.
fn log_refused(ip: &str, why: &str) {
    static LAST: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> = std::sync::Mutex::new(None);
    let Ok(mut last) = LAST.lock() else { return };
    let map = last.get_or_insert_with(Default::default);
    let now = std::time::Instant::now();
    if map.get(ip).is_some_and(|t| now.duration_since(*t) < std::time::Duration::from_secs(10)) {
        return;
    }
    map.insert(ip.to_string(), now);
    log::warn!("Refused UDP input from {}: {}", ip, why);
}

// Who an (address, token) pair resolved to, kept this long so a stream of lines does not take the peer table lock
// each time. Short, so a kicked or rotated token stops working almost at once; rotate_input_token and
// kick_input also clear it.
const SENDER_TTL: std::time::Duration = std::time::Duration::from_secs(2);

type SenderCache = std::sync::Mutex<std::collections::HashMap<String, (String, InputSender, std::time::Instant)>>;

fn sender_cache() -> &'static SenderCache {
    static CACHE: std::sync::OnceLock<SenderCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

pub(crate) fn forget_input_senders() {
    if let Ok(mut cache) = sender_cache().lock() {
        cache.clear();
    }
}

fn presenter() -> &'static crate::core::presenter::Presenter {
    static PRESENTER: std::sync::OnceLock<crate::core::presenter::Presenter> = std::sync::OnceLock::new();
    PRESENTER.get_or_init(Default::default)
}

pub fn stop_presenter(app: &tauri::AppHandle) {
    presenter().stop(app);
}

impl DeviceManager {
    pub async fn start_input_relay(self: &Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let raw = Socket::new(Domain::IPV4, Type::DGRAM, None)?;
        let _ = raw.set_reuse_address(true);
        raw.set_nonblocking(true)?;
        raw.bind(&SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), INPUT_RELAY_PORT).into())?;
        let socket = UdpSocket::from_std(raw.into())?;
        log::info!("Input relay listening on UDP port {}", INPUT_RELAY_PORT);

        let manager = self.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            loop {
                let Ok((len, from)) = socket.recv_from(&mut buf).await else { continue };
                let ip = from.ip().to_string();
                if manager.is_blocked(&ip) {
                    continue;
                }
                let text = String::from_utf8_lossy(&buf[..len]);
                let Some((token, line)) = text.trim().split_once(' ') else { continue };
                manager.handle_input_line(&ip, token, line.trim()).await;
            }
        });
        Ok(())
    }

    /// Sends a paired peer the token its UDP input lines must carry to be heard here.
    pub(crate) async fn push_input_token(&self, device_id: &str) {
        let token = self.active_peers.read().await.get(device_id).map(|p| p.input_token.clone());
        if let Some(token) = token {
            let _ = self.send_packet(device_id, PACKET_TYPE_INPUT_TOKEN, json!({ "token": token })).await;
        }
    }

    /// Replaces a paired peer's token (after a kick), so lines already in flight under the old
    /// one are dropped; the peer gets the new one for its next session.
    pub(crate) async fn rotate_input_token(&self, device_id: &str) {
        if let Some(peer) = self.active_peers.write().await.get_mut(device_id) {
            peer.input_token = new_input_token();
        }
        forget_input_senders();
        self.push_input_token(device_id).await;
    }

    /// Keeps the token a paired peer issued for the lines this side sends it.
    pub(crate) async fn store_peer_input_token(&self, device_id: &str, body: &Value) {
        let Some(token) = body.get("token").and_then(Value::as_str).filter(|t| !t.is_empty()) else { return };
        if let Some(peer) = self.active_peers.write().await.get_mut(device_id) {
            peer.peer_input_token = Some(token.to_string());
        }
    }

    async fn input_sender(&self, ip: &str, token: &str) -> Option<InputSender> {
    if let Ok(cache) = sender_cache().lock() {
        if let Some((cached_token, sender, at)) = cache.get(ip) {
            if cached_token == token && at.elapsed() < SENDER_TTL {
                return Some(sender.clone());
            }
        }
    }
    let found = self.resolve_input_sender(ip, token).await;
    if let (Some(sender), Ok(mut cache)) = (&found, sender_cache().lock()) {
        if cache.len() >= 64 {
            cache.retain(|_, (_, _, at)| at.elapsed() < SENDER_TTL);
        }
        cache.insert(ip.to_string(), (token.to_string(), sender.clone(), std::time::Instant::now()));
    }
    found
    }

    async fn resolve_input_sender(&self, ip: &str, token: &str) -> Option<InputSender> {
        let (paired, why) = {
            let peers = self.active_peers.read().await;
            let paired = peers.values().find(|p| p.trusted && p.input_token == token && p.ip == ip).map(|p| p.device_id.clone());
            // Only worked out for the log line below, when the line is refused.
            let why = if paired.is_some() {
                ""
            } else if let Some(p) = peers.values().find(|p| p.input_token == token) {
                if !p.trusted { "the token's device is not paired" } else { "the token's device is connected from another address" }
            } else if peers.values().any(|p| p.ip == ip) {
                "a connected device sent an unknown or old token"
            } else {
                "no session matches"
            };
            (paired, why)
        };
        match paired {
            Some(id) => Some(InputSender::Paired(id)),
            None => {
                let guest = self.input_guest_mode(ip, token).map(InputSender::Guest);
                if guest.is_none() {
                    log_refused(ip, why);
                }
                guest
            }
        }
    }

    async fn handle_input_line(&self, ip: &str, token: &str, line: &str) {
        // Controller state goes straight to the joystick helper, which checks its own tokens.
        if let Some(state) = line.strip_prefix("js ") {
            self.joystick_state(ip, token, state).await;
            return;
        }
        let Some(sender) = self.input_sender(ip, token).await else { return };
        let (paired, presenter_ok, input_ok) = match &sender {
            InputSender::Paired(id) => (Some(id.as_str()), self.allowed(id, "presenter"), self.allowed(id, "remoteinput")),
            InputSender::Guest(mode) => (None, *mode == "presenter", *mode == "touchpad"),
        };
        // The line's words, split once (no line has more than four that matter).
        let mut words = [""; 4];
        for (slot, word) in words.iter_mut().zip(line.split_whitespace()) {
            *slot = word;
        }
        let num = |i: usize| words[i].parse::<f64>().ok();

        if let Some(id) = paired {
            let is_presenter_line = line.starts_with("pmove ") || line == "pstop";
            // Only one device presents at a time; a paired device's presenter lines are dropped while
            // another one holds the slot. (An admitted guest holds it by being admitted.) Remote
            // input is open to any number of devices at once.
            if is_presenter_line && presenter_ok && !self.claim_presenter(id, false).await {
                return;
            }
            if line.starts_with("pmove ") && presenter_ok {
                self.note_input_activity(id, "presenter").await;
            } else if input_ok && !line.starts_with("special ") && line != "pstop" {
                self.note_input_activity(id, "touchpad").await;
            }
        }

        if line.starts_with("pmove ") {
            // Handed to the dot's own task: opening its window can take a while, and this runs on
            // the one task that receives every phone's input.
            if let (true, Some(app), Some(dx), Some(dy)) = (presenter_ok, self.app_handle().await, num(1), num(2)) {
                presenter().move_dot(&app, dx, dy);
            }
        } else if line == "pstop" {
            if let (true, Some(app)) = (presenter_ok, self.app_handle().await) {
                presenter().stop(&app);
            }
        } else if line.starts_with("special ") {
            if presenter_ok || input_ok {
                input::run_line(line);
            }
        } else if line.starts_with("dig ") {
            if let (true, Some(x), Some(y)) = (input_ok, num(1), num(2)) {
                let touching = words[3] == "true";
                let (width, height) = self.digitizer_size().await;
                let (screen_w, screen_h) = input::screen_size();
                let rx = (x / width.max(1.0)).clamp(0.0, 1.0);
                let ry = (y / height.max(1.0)).clamp(0.0, 1.0);
                input::run_line(&format!("setpos {} {}", (rx * screen_w).round(), (ry * screen_h).round()));
                input::run_line(&format!("touch {}", touching));
            }
        } else if input_ok {
            // move / click / hold / release / scroll / key / unicode / undo / redo
            input::run_line(line);
        }
    }

    /// Sends one input line to a paired phone's input relay (desktop acting as the controller),
    /// prefixed with the token the phone issued for this connection.
    pub async fn send_input_line(&self, device_id: &str, line: &str) -> Result<(), String> {
        static SOCKET: std::sync::OnceLock<std::net::UdpSocket> = std::sync::OnceLock::new();
        let (ip, token) = {
            let peers = self.active_peers.read().await;
            let peer = peers.get(device_id).ok_or_else(|| format!("Device {} is not connected", device_id))?;
            let token = peer.peer_input_token.clone().ok_or_else(|| format!("Device {} has not enabled input yet", device_id))?;
            (peer.ip.clone(), token)
        };
        let socket = match SOCKET.get() {
            Some(s) => s,
            None => {
                let bound = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
                SOCKET.get_or_init(|| bound)
            }
        };
        let datagram = format!("{} {}", token, line);
        socket.send_to(datagram.as_bytes(), (ip.as_str(), INPUT_RELAY_PORT)).map_err(|e| e.to_string())?;
        Ok(())
    }
}
