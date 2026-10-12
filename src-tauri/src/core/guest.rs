use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::SinkExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::server::TlsStream;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::core::identity::compute_cert_fingerprint;
use crate::core::pairing::compute_verification_code;
use crate::core::settings::BlockEntry;
use crate::core::transport::{public_key_der, DeviceManager};

// Shared plumbing for the tools that accept unpaired devices (audio sink, file transfer,
// joystick, walkie-talkie, input guests): a TLS WebSocket server per tool, a PIN both screens show
// so the user can confirm they are talking to the right device, and a registry of guests waiting
// for the user to accept, reject or block them. Paired devices skip the PIN: their certificate is
// already pinned in the trust store.

pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(30);

// Close codes shared with the Android and Electron implementations.
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
}

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

/// Dials a guest-session server on another device, presenting our certificate. Returns the
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
    let (ws, _) = tokio_tungstenite::client_async(format!("wss://{}:{}", host, port), tls).await.map_err(|e| format!("Handshake failed: {}", e))?;
    Ok((ws, cert))
}

pub fn clean_ip(addr: SocketAddr) -> String {
    addr.ip().to_string().trim_start_matches("::ffff:").to_string()
}

impl DeviceManager {
    /// PIN shown on both screens: SHA-256 over both public keys (larger first), first 8 hex chars.
    pub(crate) fn guest_pin(&self, peer_cert: &[u8]) -> String {
        compute_verification_code(&public_key_der(&self.own_cert_der()), &public_key_der(peer_cert), "")
    }

    /// Name of the paired device that owns this certificate, if any.
    pub(crate) async fn paired_name_for_cert(&self, peer_cert: &[u8]) -> Option<String> {
        let fingerprint = hex::encode(Sha256::digest(peer_cert));
        self.trust_store.read().await.list().into_iter().find(|d| compute_cert_fingerprint(&d.cert_pem) == fingerprint).map(|d| d.device_name)
    }

    /// Blocks a guest by address, as its real device when the app can identify it, else by IP.
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

    pub(crate) async fn emit_event(&self, event: &str, payload: Value) {
        if let Some(app) = self.app_handle().await {
            let _ = app.emit(event, payload);
        }
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
        let pin = self.guest_pin(&guest.peer_cert);
        self.confirm_pin(&mut guest.ws, &guest.remote_ip, pin, conn_id, name, event, extra).await
    }

    /// The confirmation flow for a PIN the caller already chose (the web portal uses a random one).
    pub(crate) async fn confirm_pin<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        ws: &mut WebSocketStream<S>,
        remote_ip: &str,
        pin: String,
        conn_id: &str,
        name: Option<String>,
        event: &str,
        extra: Vec<Value>,
    ) -> Decision {
        let mut answer = self.guests.register(conn_id);
        send_json(ws, json!({ "type": "pin", "code": pin })).await;

        let mut args = vec![json!(conn_id), json!(pin), json!(remote_ip), json!(name)];
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
            loop {
                let Ok((stream, addr)) = listener.accept().await else { continue };
                let (manager, handler) = (manager.clone(), handler.clone());
                tokio::spawn(async move {
                    let ip = clean_ip(addr);
                    if manager.is_blocked(&ip) {
                        return;
                    }
                    let _ = stream.set_nodelay(true);
                    let Ok(tls) = manager.tls_acceptor().accept(stream).await else { return };
                    let peer_cert = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tls).await else { return };
                    match peer_cert {
                        Some(cert) => handler(manager, GuestSocket { ws, remote_ip: ip, peer_cert: cert }).await,
                        None => close_with(&mut ws, CLOSE_NO_CERT, "no client certificate presented").await,
                    }
                });
            }
        });
        Ok(task.abort_handle())
    }
}
