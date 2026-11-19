use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;

use crate::core::transport::DeviceManager;

// Client for the peer's file-system server (LinkFsServer.java): one TLS WebSocket per device at
// wss://<ip>:FS_PORT/fs. Each request is a JSON object carrying a 36-char id; the response is a
// JSON message (or a binary frame for reads) echoing that id.
pub const FS_PORT: u16 = crate::core::transport::LINK_PORT + 2;

// A request that gets no answer (dropped packet, dozing radio) must fail instead of hanging the UI.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const CONNECTION_CLOSED: &str = "File system connection closed";

/// A reply: its JSON (the header, for a binary frame) and, for reads and thumbnails, the raw bytes.
pub struct FsReply {
    pub json: serde_json::Value,
    pub data: Option<Vec<u8>>,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<FsReply, String>>>>>;

// Reads and writes go over a second connection, so a run of 4 MB chunks never queues a listing
// or a stat behind it. LinkFsServer accepts any number of connections per device.
fn bulk_key(device_id: &str) -> String {
    format!("{}\u{1}bulk", device_id)
}

pub struct FsClient {
    tx: mpsc::Sender<Message>,
    pending: Pending,
    // Cleared by the reader task when the connection ends. The sender alone can't tell: it only
    // reports closed after a later write fails, so a dead connection would look open to the cache.
    alive: Arc<std::sync::atomic::AtomicBool>,
}

fn request_id() -> String {
    let raw = format!("{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().simple());
    raw.chars().take(36).collect()
}

fn reply_of(message: serde_json::Value, data: Option<Vec<u8>>) -> Result<FsReply, String> {
    if let Some(err) = message.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    if message.get("success").and_then(|s| s.as_bool()) == Some(false) {
        return Err("File system request failed".to_string());
    }
    Ok(FsReply { json: message, data })
}

impl FsClient {
    async fn connect(host: &str, manager: &DeviceManager) -> Result<Arc<Self>, String> {
        let stream = TcpStream::connect((host, FS_PORT)).await.map_err(|e| format!("Connect error: {}", e))?;
        let url = format!("wss://{}:{}/fs", host, FS_PORT);
        let (socket, _) = tokio_tungstenite::client_async_tls_with_config(
            url.as_str(),
            stream,
            None,
            Some(Connector::Rustls(manager.tls_client_config())),
        )
        .await
        .map_err(|e| format!("File system handshake failed: {}", e))?;

        let (mut sink, mut source) = socket.split();
        let (tx, mut rx) = mpsc::channel::<Message>(64);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });

        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let reader_alive = alive.clone();
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = source.next().await {
                let (id, body, data) = match message {
                    Message::Text(text) => match serde_json::from_str::<serde_json::Value>(text.as_str()) {
                        Ok(json) => (json.get("id").and_then(|v| v.as_str()).map(str::to_string), json, None),
                        Err(_) => continue,
                    },
                    // Binary frames: 4-byte big-endian header length + JSON header + raw payload.
                    Message::Binary(bytes) if bytes.len() >= 4 => {
                        let header_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
                        match bytes.get(4..4 + header_len).and_then(|h| serde_json::from_slice::<serde_json::Value>(h).ok()) {
                            Some(header) => (header.get("id").and_then(|v| v.as_str()).map(str::to_string), header, Some(bytes[4 + header_len..].to_vec())),
                            None => continue,
                        }
                    }
                    Message::Close(_) => break,
                    _ => continue,
                };
                if let Some(waiter) = match id {
                    Some(id) => reader_pending.lock().await.remove(&id),
                    None => None,
                } {
                    let _ = waiter.send(reply_of(body, data));
                }
            }
            // Connection gone: mark it dead and fail everything still waiting.
            reader_alive.store(false, std::sync::atomic::Ordering::SeqCst);
            for (_, waiter) in reader_pending.lock().await.drain() {
                let _ = waiter.send(Err(CONNECTION_CLOSED.to_string()));
            }
        });

        Ok(Arc::new(Self { tx, pending, alive }))
    }

    fn is_open(&self) -> bool {
        !self.tx.is_closed() && self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn send(&self, action: &str, args: &serde_json::Value, data: Option<&[u8]>) -> Result<FsReply, String> {
        if !self.is_open() {
            return Err(CONNECTION_CLOSED.to_string());
        }
        let id = request_id();
        let mut payload = serde_json::json!({ "id": id, "action": action });
        if let (Some(p), Some(a)) = (payload.as_object_mut(), args.as_object()) {
            p.extend(a.iter().map(|(k, v)| (k.clone(), v.clone())));
        }

        let (done_tx, done_rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), done_tx);
        let message = match data {
            None => Message::Text(payload.to_string().into()),
            Some(bytes) => {
                let header = payload.to_string().into_bytes();
                let mut frame = Vec::with_capacity(4 + header.len() + bytes.len());
                frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
                frame.extend_from_slice(&header);
                frame.extend_from_slice(bytes);
                Message::Binary(frame.into())
            }
        };
        if self.tx.send(message).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(CONNECTION_CLOSED.to_string());
        }

        match tokio::time::timeout(REQUEST_TIMEOUT, done_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CONNECTION_CLOSED.to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("File system request {} timed out", action))
            }
        }
    }
}

impl DeviceManager {
    /// The phone's file server may still be starting (first launch, or right after the app was
    /// restarted), so a refused connection or failed handshake is retried briefly before giving up.
    async fn connect_with_retry(&self, host: &str) -> Result<Arc<FsClient>, String> {
        let mut last = String::new();
        for attempt in 0..4u32 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
            }
            match FsClient::connect(host, self).await {
                Ok(client) => return Ok(client),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    async fn fs_client_for(&self, device_id: &str, key: &str) -> Result<Arc<FsClient>, String> {
        let existing = self.fs_clients().lock().await.get(key).cloned().filter(|c| c.is_open());
        let client = match existing {
            Some(client) => client,
            None => {
                let (host, _) = self
                    .peer_endpoint(device_id)
                    .await
                    .ok_or_else(|| format!("Device {} is not connected or not paired", device_id))?;
                let client = self.connect_with_retry(&host).await?;
                self.fs_clients().lock().await.insert(key.to_string(), client.clone());
                client
            }
        };
        Ok(client)
    }

    /// Sends one request on the device's metadata (or bulk) connection, opening it as needed.
    async fn fs_send(&self, device_id: &str, bulk: bool, action: &str, args: serde_json::Value, data: Option<&[u8]>) -> Result<FsReply, String> {
        let key = if bulk { bulk_key(device_id) } else { device_id.to_string() };
        match self.fs_client_for(device_id, &key).await?.send(action, &args, data).await {
            // A connection that died since it was cached: drop it and try once on a fresh one.
            Err(e) if e == CONNECTION_CLOSED => {
                self.fs_clients().lock().await.remove(&key);
                self.fs_client_for(device_id, &key).await?.send(action, &args, data).await
            }
            other => other,
        }
    }

    /// Sends one metadata request (listRoots, readdir, stat, create, delete, rename, recentPhotos)
    /// to a paired peer, opening (or reopening) its connection, and returns the reply's JSON.
    pub async fn fs_request(&self, device_id: &str, action: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        self.fs_send(device_id, false, action, args, None).await.map(|reply| reply.json)
    }

    /// Like fs_request, but a binary reply's bytes are returned raw. `bulk` picks the connection
    /// reserved for reads and writes.
    pub(crate) async fn fs_request_data(&self, device_id: &str, bulk: bool, action: &str, args: serde_json::Value) -> Result<FsReply, String> {
        self.fs_send(device_id, bulk, action, args, None).await
    }

    /// Writes `data` into a file on the peer at `offset`.
    pub async fn fs_write(&self, device_id: &str, path: &str, offset: u64, data: &[u8]) -> Result<(), String> {
        self.fs_send(device_id, true, "write", serde_json::json!({ "path": path, "offset": offset }), Some(data)).await.map(|_| ())
    }

    /// Forgets both connections to a device.
    pub(crate) async fn drop_fs_clients(&self, device_id: &str) {
        let mut clients = self.fs_clients().lock().await;
        clients.remove(device_id);
        clients.remove(&bulk_key(device_id));
    }
}
