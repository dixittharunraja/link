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

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>>;

pub struct FsClient {
    tx: mpsc::Sender<Message>,
    pending: Pending,
}

fn request_id() -> String {
    let raw = format!("{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4().simple());
    raw.chars().take(36).collect()
}

fn reply_of(message: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(err) = message.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    if message.get("success").and_then(|s| s.as_bool()) == Some(false) {
        return Err("File system request failed".to_string());
    }
    Ok(message)
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

        let reader_pending = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = source.next().await {
                let (id, body) = match message {
                    Message::Text(text) => match serde_json::from_str::<serde_json::Value>(text.as_str()) {
                        Ok(json) => (json.get("id").and_then(|v| v.as_str()).map(str::to_string), json),
                        Err(_) => continue,
                    },
                    // Binary frames: 4-byte big-endian header length + JSON header + payload.
                    Message::Binary(bytes) if bytes.len() >= 4 => {
                        let header_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
                        match bytes.get(4..4 + header_len).and_then(|h| serde_json::from_slice::<serde_json::Value>(h).ok()) {
                            Some(mut header) => {
                                header["dataBase64"] = serde_json::Value::String(
                                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes[4 + header_len..]),
                                );
                                (header.get("id").and_then(|v| v.as_str()).map(str::to_string), header)
                            }
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
                    let _ = waiter.send(reply_of(body));
                }
            }
            // Connection gone: fail everything still waiting.
            for (_, waiter) in reader_pending.lock().await.drain() {
                let _ = waiter.send(Err("File system connection closed".to_string()));
            }
        });

        Ok(Arc::new(Self { tx, pending }))
    }

    fn is_open(&self) -> bool {
        !self.tx.is_closed()
    }

    async fn request(&self, action: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        self.send(action, args, None).await
    }

    async fn request_binary(&self, action: &str, args: serde_json::Value, data: Vec<u8>) -> Result<serde_json::Value, String> {
        self.send(action, args, Some(data)).await
    }

    async fn send(&self, action: &str, args: serde_json::Value, data: Option<Vec<u8>>) -> Result<serde_json::Value, String> {
        let id = request_id();
        let mut payload = serde_json::json!({ "id": id, "action": action, "type": action });
        if let (Some(p), Some(a)) = (payload.as_object_mut(), args.as_object()) {
            p.extend(a.clone());
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
                frame.extend_from_slice(&bytes);
                Message::Binary(frame.into())
            }
        };
        if self.tx.send(message).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err("File system connection closed".to_string());
        }

        match tokio::time::timeout(REQUEST_TIMEOUT, done_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("File system connection closed".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("File system request {} timed out", action))
            }
        }
    }
}

impl DeviceManager {
    async fn fs_client_for(&self, device_id: &str) -> Result<Arc<FsClient>, String> {
        let existing = self.fs_clients().lock().await.get(device_id).cloned().filter(|c| c.is_open());
        let client = match existing {
            Some(client) => client,
            None => {
                let (host, _) = self
                    .peer_endpoint(device_id)
                    .await
                    .ok_or_else(|| format!("Device {} is not connected or not paired", device_id))?;
                let client = FsClient::connect(&host, self).await?;
                self.fs_clients().lock().await.insert(device_id.to_string(), client.clone());
                client
            }
        };
        Ok(client)
    }

    /// Sends one file-system request to a paired peer, opening (or reopening) its connection.
    pub async fn fs_request(&self, device_id: &str, action: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        self.fs_client_for(device_id).await?.request(action, args).await
    }

    /// Writes `data` into a file on the peer at `offset`.
    pub async fn fs_write(&self, device_id: &str, path: &str, offset: u64, data: Vec<u8>) -> Result<(), String> {
        self.fs_client_for(device_id)
            .await?
            .request_binary("write", serde_json::json!({ "path": path, "offset": offset }), data)
            .await
            .map(|_| ())
    }
}
