use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::server::TlsStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::core::identity::compute_cert_fingerprint;
use crate::core::pairing::compute_verification_code;
use crate::core::pairing_window::{Admission, PairingWindow};
use crate::core::settings::BlockEntry;
use crate::core::transport::{public_key_der, DeviceManager};

// Shared plumbing for the tools that accept unpaired devices (audio sink, file transfer,
// joystick, walkie-talkie, input guests): a TLS WebSocket server per tool, a PIN both screens show
// so the user can confirm they are talking to the right device, and a registry of guests waiting
// for the user to accept, reject or block them. Paired devices skip the PIN: their certificate is
// already pinned in the trust store.
//
// A QR code shown by a tool carries the host's key fingerprint and a one-time token (the same idea as
// the pairing QR, see pairing_window.rs). The guest checks the fingerprint before saying anything, so
// there is no PIN to compare, and presents the token in the address it dials (wss://host:port/?t=...).
// The host takes each token once. The host's Accept button is still the gate: a token only proves the
// guest scanned the code on this screen. A guest that typed the address instead has no token and goes
// through the PIN as before. Android implements the same protocol (LinkGuestAccess.java).

pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(30);
// Each of the TLS and WebSocket handshakes of a guest socket gets this long (generous for a slow
// phone), and at most this many sockets per tool may be handshaking at once.
const GUEST_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const GUEST_MAX_HANDSHAKING: usize = 16;

// Close codes shared with the Android implementation.
pub const CLOSE_NO_CERT: u16 = 4001;
pub const CLOSE_MALFORMED: u16 = 4003;
pub const CLOSE_UNKNOWN_JOIN: u16 = 4004;
pub const CLOSE_TIMED_OUT: u16 = 4006;
pub const CLOSE_REJECTED: u16 = 4007;
pub const CLOSE_BLOCKED: u16 = 4010;

pub type GuestWs = WebSocketStream<TlsStream<TcpStream>>;

pub struct GuestSocket {
    pub ws: GuestWs,
    pub remote_ip: String,
    pub peer_cert: Vec<u8>,
    /// The port this guest dialled, which names the tool.
    pub port: u16,
    /// The one-time token from the QR it scanned, if any.
    pub token: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    Accept,
    Reject,
    Block,
}

struct Pending {
    decide: oneshot::Sender<Decision>,
}

/// Guests waiting for the user's answer, across every tool (connection ids are unique).
#[derive(Default)]
pub struct GuestHub {
    pending: Mutex<HashMap<String, Pending>>,
    // Guests whose confirmation timer is paused while the user finishes a related dialog.
    held: Mutex<HashSet<String>>,
    // The QR code each tool is showing, by port: its one-time token.
    qr: Mutex<HashMap<u16, PairingWindow>>,
    // QR codes this device scanned and has not used yet, by host address.
    scans: Mutex<HashMap<String, GuestScan>>,
    // Host certificates (SHA-256, hex) verified against a scanned QR, until their PIN would have been shown.
    verified: Mutex<HashSet<String>>,
}

/// What a scanned tool QR proves about the host it names.
pub(crate) struct GuestScan {
    pub(crate) fingerprint: String,
    pub(crate) token: String,
    at: Instant,
}

/// How long a scanned code stays usable.
const SCAN_LIFETIME: Duration = Duration::from_secs(120);

impl GuestHub {
    fn register(&self, conn_id: &str) -> oneshot::Receiver<Decision> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(conn_id.to_string(), Pending { decide: tx });
        }
        rx
    }

    fn forget(&self, conn_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(conn_id);
        }
        if let Ok(mut held) = self.held.lock() {
            held.remove(conn_id);
        }
    }

    /// A tool is showing its QR: returns the token it carries.
    pub fn open_qr(&self, port: u16) -> String {
        self.qr.lock().map(|mut m| m.entry(port).or_default().open(Instant::now())).unwrap_or_default()
    }

    pub fn refresh_qr(&self, port: u16) -> Option<String> {
        self.qr.lock().ok().and_then(|mut m| m.get_mut(&port).and_then(|w| w.refresh(Instant::now())))
    }

    pub fn close_qr(&self, port: u16) {
        if let Ok(mut m) = self.qr.lock() {
            if let Some(window) = m.get_mut(&port) {
                window.close();
            }
        }
    }

    /// Judges a guest by the token it presented. A guest without one is an ordinary guest: the host is
    /// running the tool on purpose, so it is asked about via the PIN.
    pub(crate) fn admit(&self, port: u16, token: Option<&str>) -> Admission {
        self.qr.lock().map(|mut m| m.entry(port).or_default().admit(token, true, Instant::now())).unwrap_or(Admission::Closed)
    }

    /// Remembers a scanned QR for the addresses it names; the next dial to one of them uses it.
    pub fn remember_scan(&self, addresses: &str, fingerprint: &str, token: &str) {
        if let Ok(mut scans) = self.scans.lock() {
            scans.retain(|_, scan| scan.at.elapsed() < SCAN_LIFETIME);
            for host in addresses.split(',').map(normalize_host).filter(|h| !h.is_empty()) {
                scans.insert(host, GuestScan { fingerprint: fingerprint.to_lowercase(), token: token.to_string(), at: Instant::now() });
            }
        }
    }

    fn mark_verified(&self, fingerprint: &str) {
        if let Ok(mut verified) = self.verified.lock() {
            verified.insert(fingerprint.to_string());
        }
    }

    /// Whether this host certificate was verified by a QR for the connection being set up; used up by the call.
    fn take_verified(&self, fingerprint: &str) -> bool {
        self.verified.lock().is_ok_and(|mut verified| verified.remove(fingerprint))
    }

    pub(crate) fn take_scan(&self, host: &str) -> Option<GuestScan> {
        let scan = self.scans.lock().ok().and_then(|mut scans| scans.remove(host))?;
        (scan.at.elapsed() < SCAN_LIFETIME).then_some(scan)
    }

    /// Stops the confirmation timeout for a guest; the user's answer is awaited indefinitely.
    pub fn hold(&self, conn_id: &str) {
        if let Ok(mut held) = self.held.lock() {
            held.insert(conn_id.to_string());
        }
    }

    fn is_held(&self, conn_id: &str) -> bool {
        self.held.lock().map(|h| h.contains(conn_id)).unwrap_or(false)
    }

    /// Delivers the user's answer; false when that guest is no longer waiting.
    pub fn decide(&self, conn_id: &str, decision: Decision) -> bool {
        let entry = self.pending.lock().ok().and_then(|mut m| m.remove(conn_id));
        if let Ok(mut held) = self.held.lock() {
            held.remove(conn_id);
        }
        entry.is_some_and(|p| p.decide.send(decision).is_ok())
    }
}

pub async fn close_with<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, code: u16, reason: &str) {
    let _ = ws
        .send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() })))
        .await;
}

pub async fn send_json<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, value: Value) -> bool {
    ws.send(Message::Text(value.to_string().into())).await.is_ok()
}

pub type ClientWs = WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>;

/// "https://10.0.0.5:1747", "::ffff:10.0.0.5" or "10.0.0.5:80" all become "10.0.0.5".
pub fn normalize_host(raw: &str) -> String {
    let host = raw.trim().trim_start_matches("::ffff:");
    let host = host.split_once("://").map(|(_, rest)| rest).unwrap_or(host);
    let host = host.split('/').next().unwrap_or(host);
    host.split(':').next().unwrap_or(host).to_string()
}

/// Dials a guest-session server on another device, presenting this device's certificate. Returns the
/// socket and the server's certificate (for computing the PIN locally).
pub async fn connect_guest_client(manager: &DeviceManager, host: &str, port: u16) -> Result<(ClientWs, Vec<u8>), String> {
    let host = normalize_host(host);
    let stream = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| "Connection timed out".to_string())?
        .map_err(|e| format!("Connect error: {}", e))?;
    let _ = stream.set_nodelay(true);
    let server_name = rustls::pki_types::ServerName::try_from("link.local".to_string()).map_err(|e| e.to_string())?;
    let tls = manager.tls_connector().connect(server_name, stream).await.map_err(|e| format!("TLS handshake error: {}", e))?;
    let cert = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec()).ok_or("The device presented no certificate")?;
    // A scanned QR names the host's key. Whoever answered must hold it, or something sits between this
    // device and the host.
    let scan = manager.guests.take_scan(&host);
    if let Some(scan) = &scan {
        if hex::encode(Sha256::digest(&cert)) != scan.fingerprint {
            return Err("That is not the device in the QR code. Connection stopped.".to_string());
        }
        manager.guests.mark_verified(&scan.fingerprint);
    }
    let url = match &scan {
        Some(scan) => format!("wss://{}:{}/?t={}", host, port, scan.token),
        None => format!("wss://{}:{}", host, port),
    };
    let (ws, _) = tokio_tungstenite::client_async(url, tls).await.map_err(|e| format!("Handshake failed: {}", e))?;
    Ok((ws, cert))
}

/// The `t` parameter of a query string ("t=abc&x=1" gives "abc").
pub fn query_token(query: Option<&str>) -> Option<String> {
    query?.split('&').find_map(|pair| pair.strip_prefix("t=")).filter(|t| !t.is_empty()).map(str::to_string)
}

pub fn clean_ip(addr: SocketAddr) -> String {
    addr.ip().to_string().trim_start_matches("::ffff:").to_string()
}

impl DeviceManager {
    /// PIN shown on both screens, derived from both public keys (see compute_verification_code).
    pub(crate) fn guest_pin(&self, peer_cert: &[u8]) -> String {
        compute_verification_code(&public_key_der(&self.own_cert_der()), &public_key_der(peer_cert), "")
    }

    /// The PIN this device shows while it waits to be admitted to a host it dialled. Empty when a scanned QR
    /// already verified the host: there is nothing to compare.
    pub(crate) fn client_pin(&self, server_cert: &[u8]) -> String {
        if self.guests.take_verified(&hex::encode(Sha256::digest(server_cert))) {
            return String::new();
        }
        self.guest_pin(server_cert)
    }

    /// Name of the paired device that owns this certificate, if any.
    pub(crate) async fn paired_name_for_cert(&self, peer_cert: &[u8]) -> Option<String> {
        let fingerprint = hex::encode(Sha256::digest(peer_cert));
        self.trust_store.read().await.list().into_iter().find(|d| compute_cert_fingerprint(&d.cert_pem) == fingerprint).map(|d| d.device_name)
    }

    /// Blocks a guest by device id when a connected peer has its address, otherwise by IP.
    pub async fn block_guest(&self, ip: &str, name: Option<&str>) {
        let identified = self.connected_peers().await.into_iter().find(|p| p["ipAddress"].as_str() == Some(ip));
        let entry = match identified {
            Some(peer) => BlockEntry {
                id: peer["deviceId"].as_str().unwrap_or(ip).to_string(),
                label: name.map(str::to_string).or_else(|| peer["deviceName"].as_str().map(str::to_string)).unwrap_or_else(|| format!("Guest ({})", ip)),
                kind: "device".into(),
                blocked_at: chrono::Utc::now().timestamp_millis(),
                device_type: peer["deviceType"].as_str().map(str::to_string),
                ip: Some(ip.to_string()),
            },
            None => BlockEntry {
                id: ip.to_string(),
                label: name.map(str::to_string).unwrap_or_else(|| format!("Guest ({})", ip)),
                kind: "ip".into(),
                blocked_at: chrono::Utc::now().timestamp_millis(),
                device_type: None,
                ip: None,
            },
        };
        if let Ok(mut blocklist) = self.blocklist.lock() {
            blocklist.add(entry);
        }
    }

    /// Blocks a paired device by id (and its current address, so it can't come back as a guest).
    pub async fn block_guest_device(&self, device_id: &str, label: &str) {
        let ip = self.connected_peers().await.into_iter().find(|p| p["deviceId"].as_str() == Some(device_id)).and_then(|p| p["ipAddress"].as_str().map(str::to_string));
        if let Ok(mut blocklist) = self.blocklist.lock() {
            blocklist.add(BlockEntry {
                id: device_id.to_string(),
                label: label.to_string(),
                kind: "device".into(),
                blocked_at: chrono::Utc::now().timestamp_millis(),
                device_type: None,
                ip,
            });
        }
    }

    /// A tool's QR is on screen: what it carries.
    pub fn open_guest_qr(&self, port: u16) -> Value {
        json!({ "fingerprint": self.fingerprint(), "token": self.guests.open_qr(port) })
    }

    pub(crate) async fn emit_event(&self, event: &str, payload: Value) {
        if let Some(app) = self.app_handle().await {
            let _ = app.emit(event, payload);
        }
    }

    /// Judges a guest by the QR token it presented: a token this tool did not issue, or one already used,
    /// is refused (the socket is closed and None comes back). One without a token is an ordinary guest and is
    /// asked about via the PIN.
    pub(crate) async fn admit_guest(&self, guest: &mut GuestSocket, name: &Option<String>) -> Option<Admission> {
        let admission = self.guests.admit(guest.port, guest.token.as_deref());
        if matches!(admission, Admission::Closed | Admission::BadToken | Admission::Conflict) {
            log::warn!("Refused a guest on port {}: {:?}", guest.port, admission);
            if admission == Admission::Conflict {
                self.emit_event("pairing-blocked", json!({ "deviceName": name })).await;
            }
            close_with(&mut guest.ws, CLOSE_REJECTED, "refused").await;
            return None;
        }
        Some(admission)
    }

    /// Runs the PIN confirmation for one unpaired guest: sends the PIN down the socket, tells the UI
    /// (with `event`), and waits for the user's answer. Closes the socket for anything but Accept.
    pub(crate) async fn confirm_guest(
        &self,
        guest: &mut GuestSocket,
        conn_id: &str,
        name: Option<String>,
        event: &str,
        extra: Vec<Value>,
    ) -> Decision {
        // A device whose certificate is already pinned in the trust store has been vouched for.
        if self.paired_name_for_cert(&guest.peer_cert).await.is_some() {
            return Decision::Accept;
        }
        let Some(admission) = self.admit_guest(guest, &name).await else { return Decision::Reject };
        let pin = self.guest_pin(&guest.peer_cert);
        // The guest scanned the QR and verified this device, so there is no code for the user to compare.
        let shown = if admission == Admission::Qr { String::new() } else { pin.clone() };
        self.confirm_with(&mut guest.ws, &guest.remote_ip, pin, shown, conn_id, name, event, extra).await
    }

    /// The confirmation flow: `pin` goes to the guest, `shown` is the code the user's screen shows (empty when there
    /// is nothing to compare). The web portal uses a random PIN for both.
    pub(crate) async fn confirm_with<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        ws: &mut WebSocketStream<S>,
        remote_ip: &str,
        pin: String,
        shown: String,
        conn_id: &str,
        name: Option<String>,
        event: &str,
        extra: Vec<Value>,
    ) -> Decision {
        let mut answer = self.guests.register(conn_id);
        send_json(ws, json!({ "type": "pin", "code": pin })).await;

        let mut args = vec![json!(conn_id), json!(shown), json!(remote_ip), json!(name)];
        args.extend(extra);
        self.emit_event(event, Value::Array(args)).await;

        let decision = match tokio::time::timeout(CONFIRM_TIMEOUT, &mut answer).await {
            Ok(Ok(decision)) => decision,
            Ok(Err(_)) => Decision::Reject,
            Err(_) if self.guests.is_held(conn_id) => answer.await.unwrap_or(Decision::Reject),
            Err(_) => {
                self.guests.forget(conn_id);
                close_with(ws, CLOSE_TIMED_OUT, "confirmation timed out").await;
                return Decision::Reject;
            }
        };
        match decision {
            Decision::Accept => {}
            Decision::Reject => close_with(ws, CLOSE_REJECTED, "rejected by host").await,
            Decision::Block => {
                self.block_guest(remote_ip, name.as_deref()).await;
                close_with(ws, CLOSE_BLOCKED, "blocked").await;
            }
        }
        decision
    }

    /// Listens on `port` for TLS WebSocket guests and hands each upgraded socket to `handler`.
    /// Blocked addresses are refused before any data is read.
    pub(crate) async fn serve_guests<H, Fut>(self: &Arc<Self>, port: u16, label: &'static str, handler: H) -> Result<tokio::task::AbortHandle, String>
    where
        H: Fn(Arc<DeviceManager>, GuestSocket) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let listener = TcpListener::bind(("0.0.0.0", port)).await.map_err(|e| format!("{} could not listen on port {}: {}", label, port, e))?;
        log::info!("{} listening on port {}", label, port);
        let manager = self.clone();
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            // Sockets still in the TLS or WebSocket handshake; past the cap new ones are refused, and
            // each handshake is bounded, so stalled sockets cannot pile up.
            let handshaking = Arc::new(tokio::sync::Semaphore::new(GUEST_MAX_HANDSHAKING));
            loop {
                let Ok((stream, addr)) = listener.accept().await else { continue };
                let Ok(permit) = handshaking.clone().try_acquire_owned() else {
                    log::warn!("{}: refusing {}, too many connections are still handshaking", label, addr);
                    continue;
                };
                let (manager, handler) = (manager.clone(), handler.clone());
                tokio::spawn(async move {
                    let ip = clean_ip(addr);
                    if manager.is_blocked(&ip) {
                        return;
                    }
                    let _ = stream.set_nodelay(true);
                    let Ok(Ok(tls)) = tokio::time::timeout(GUEST_HANDSHAKE_TIMEOUT, manager.tls_acceptor().accept(stream)).await else { return };
                    let peer_cert = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
                    // The token a QR-scanning guest presents rides on the address it dialled: /?t=<token>.
                    let presented = Arc::new(Mutex::new(None::<String>));
                    let capture = presented.clone();
                    let callback = move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
                        if let Ok(mut slot) = capture.lock() {
                            *slot = query_token(request.uri().query());
                        }
                        Ok(response)
                    };
                    let Ok(Ok(mut ws)) = tokio::time::timeout(GUEST_HANDSHAKE_TIMEOUT, tokio_tungstenite::accept_hdr_async(tls, callback)).await else { return };
                    drop(permit);
                    let token = presented.lock().ok().and_then(|mut slot| slot.take());
                    match peer_cert {
                        Some(cert) => handler(manager, GuestSocket { ws, remote_ip: ip, peer_cert: cert, port, token }).await,
                        None => close_with(&mut ws, CLOSE_NO_CERT, "no client certificate presented").await,
                    }
                });
            }
        });
        Ok(task.abort_handle())
    }
}
