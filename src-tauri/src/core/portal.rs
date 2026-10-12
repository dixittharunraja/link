use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::core::guest::{clean_ip, close_with, connect_guest_client, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::transport::{DeviceManager, LINK_PORT};

// File portal: one-off file transfer with a device that is not paired. Both sides announce the files
// they are willing to hand over ({id, name, size}); the other side asks for one by id and the source
// streams it as a `file-info` message followed by 256 KB binary frames. The same session driver
// serves a hosted guest, a client joining someone else's portal and a browser (web mode, which has
// no certificates, so its PIN is random and the page is served from the same port).

pub const PORTAL_PORT: u16 = LINK_PORT + 7;

const CHUNK_SIZE: usize = 256 * 1024;
const CLIENT_CONN_ID: &str = "client-conn";
const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_INVALID_NAME: u16 = 4009;
const PORTAL_PAGE: &str = include_str!("../../resources/portal-web.html");

#[derive(Clone)]
struct SharedFile {
    id: String,
    name: String,
    size: u64,
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalFile {
    pub name: String,
    pub local_path: String,
}

enum Cmd {
    Announce,
    Request { file_id: String, save_dir: Option<PathBuf> },
    Close,
}

struct Conn {
    tx: mpsc::Sender<Cmd>,
    name: String,
}

struct Server {
    web: bool,
    task: tokio::task::AbortHandle,
}

#[derive(Default)]
struct Inner {
    server: Option<Server>,
    downloads: Vec<SharedFile>,
    // Guests admitted to our server, in admission order.
    hosted: Vec<(String, Conn)>,
    // The portal this PC joined as a guest of another device.
    client: Option<Conn>,
    // Destination folder chosen for a guest while it was still waiting for confirmation.
    save_dirs: HashMap<String, PathBuf>,
}

#[derive(Default)]
pub struct Portal {
    inner: Mutex<Inner>,
    transfers: AtomicUsize,
}

impl Portal {
    fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        self.inner.lock().ok().map(|mut inner| f(&mut inner))
    }

    fn download(&self, id: &str) -> Option<SharedFile> {
        self.with(|i| i.downloads.iter().find(|d| d.id == id).cloned()).flatten()
    }

    fn listing(&self) -> Value {
        let files: Vec<Value> = self
            .with(|i| i.downloads.iter().map(|d| json!({ "id": d.id, "name": d.name, "size": d.size })).collect())
            .unwrap_or_default();
        json!({ "type": "downloads-available", "files": files })
    }

    fn has_downloads(&self) -> bool {
        self.with(|i| !i.downloads.is_empty()).unwrap_or(false)
    }

    fn set_peer_name(&self, conn_id: &str, name: &str) {
        self.with(|i| {
            let conn = if conn_id == CLIENT_CONN_ID { i.client.as_mut() } else { i.hosted.iter_mut().find(|(id, _)| id == conn_id).map(|(_, c)| c) };
            if let Some(conn) = conn {
                conn.name = name.to_string();
            }
        });
    }
}

fn default_save_dir() -> PathBuf {
    dirs::download_dir().unwrap_or_else(std::env::temp_dir).join("Link")
}

fn text_message(value: Value) -> Message {
    Message::Text(value.to_string().into())
}

fn close_message(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() }))
}

fn random_pin() -> String {
    let id = uuid::Uuid::new_v4();
    let bytes = id.as_bytes();
    format!("{}", 100_000 + u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 900_000)
}

/// A peer-supplied name may carry folders; keep them but never let them climb out of the save folder.
fn relative_path(name: &str) -> Option<PathBuf> {
    let parts: Vec<String> = name.split(['/', '\\']).filter(|p| !p.is_empty() && *p != "." && *p != "..").map(|p| p.replace(':', "_")).collect();
    (!parts.is_empty()).then(|| parts.iter().collect())
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|candidate| !candidate.exists()).unwrap_or(path)
}

struct Incoming {
    file: tokio::fs::File,
    size: u64,
    received: u64,
    dest: PathBuf,
}

async fn open_destination(save_dir: &Path, name: &str) -> Result<(tokio::fs::File, PathBuf, PathBuf), String> {
    let relative = relative_path(name).ok_or("invalid filename")?;
    let dest = unique_path(save_dir.join(&relative));
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let file = tokio::fs::File::create(&dest).await.map_err(|e| e.to_string())?;
    Ok((file, dest, relative))
}

async fn finish_incoming(manager: &DeviceManager, conn_id: &str, active: Incoming, batch: &mut Option<(u64, u64)>, out: &mpsc::Sender<Message>) {
    manager.portal.transfers.fetch_sub(1, Ordering::Relaxed);
    let mut file = active.file;
    let _ = file.flush().await;
    manager.emit_event("portal-transfer-complete", json!({ "connId": conn_id, "destPath": active.dest.display().to_string() })).await;
    if let Some((expected, got)) = batch.as_mut() {
        *got += 1;
        if *got < *expected {
            return;
        }
    }
    *batch = None;
    let _ = out.send(text_message(json!({ "type": "received" }))).await;
}

async fn stream_file(manager: &DeviceManager, out: &mpsc::Sender<Message>, turn: &tokio::sync::Mutex<()>, file: &SharedFile) -> Result<(), String> {
    const CLOSED: &str = "Connection closed mid-transfer";
    // Two files interleaved on one socket would corrupt the receiver, so they go one at a time.
    let _turn = turn.lock().await;
    let mut source = tokio::fs::File::open(&file.path).await.map_err(|e| format!("Failed to read file: {e}"))?;
    let total = source.metadata().await.map_err(|e| e.to_string())?.len();
    out.send(text_message(json!({ "type": "file-info", "name": file.name, "size": total }))).await.map_err(|_| CLOSED)?;

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut sent = 0u64;
    while sent < total {
        let read = source.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        out.send(Message::Binary(buffer[..read].to_vec().into())).await.map_err(|_| CLOSED)?;
        sent += read as u64;
        manager.emit_event("portal-send-progress", json!({ "sent": sent, "total": total })).await;
    }
    Ok(())
}

/// Drives one admitted connection until either side ends it; returns the close code and reason.
async fn run_session<S>(manager: Arc<DeviceManager>, ws: WebSocketStream<S>, conn_id: String, mut commands: mpsc::Receiver<Cmd>, mut save_dir: PathBuf) -> (u16, String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (out, mut queue) = mpsc::channel::<Message>(16);
    let writer = tokio::spawn(async move {
        while let Some(message) = queue.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
    });
    let turn = Arc::new(tokio::sync::Mutex::new(()));
    let mut incoming: Option<Incoming> = None;
    let mut batch: Option<(u64, u64)> = None;
    let mut closed_by_us = false;

    let end = loop {
        tokio::select! {
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    match msg["type"].as_str() {
                        Some("admitted") => {
                            let name = msg["deviceName"].as_str().unwrap_or_default();
                            manager.portal.set_peer_name(&conn_id, name);
                            manager.emit_event("portal-admitted", json!({ "deviceName": msg["deviceName"] })).await;
                            if manager.portal.has_downloads() {
                                let _ = out.send(text_message(manager.portal.listing())).await;
                            }
                        }
                        Some("downloads-available") => {
                            manager.emit_event("portal-peer-files-changed", json!({ "files": msg["files"] })).await;
                        }
                        Some("request-download") => {
                            let Some(file) = msg["fileId"].as_str().and_then(|id| manager.portal.download(id)) else { continue };
                            let (manager, out, turn) = (manager.clone(), out.clone(), turn.clone());
                            tokio::spawn(async move {
                                match stream_file(&manager, &out, &turn, &file).await {
                                    Ok(()) => manager.emit_event("portal-send-complete", json!({})).await,
                                    Err(e) => log::warn!("Portal download failed: {}", e),
                                }
                            });
                        }
                        Some("batch-info") => {
                            if let Some(count) = msg["count"].as_u64().filter(|c| *c > 0) {
                                batch = Some((count, 0));
                            }
                        }
                        Some("file-info") => {
                            let (Some(name), Some(size)) = (msg["name"].as_str(), msg["size"].as_u64()) else { continue };
                            let (file, dest, relative) = match open_destination(&save_dir, name).await {
                                Ok(opened) => opened,
                                Err(reason) => {
                                    let _ = out.send(close_message(CLOSE_INVALID_NAME, &reason)).await;
                                    closed_by_us = true;
                                    break (CLOSE_INVALID_NAME, reason);
                                }
                            };
                            manager.portal.transfers.fetch_add(1, Ordering::Relaxed);
                            manager.emit_event("portal-transfer-started", json!({ "connId": conn_id, "name": relative.display().to_string(), "size": size })).await;
                            let active = Incoming { file, size, received: 0, dest };
                            if size == 0 {
                                finish_incoming(&manager, &conn_id, active, &mut batch, &out).await;
                            } else {
                                incoming = Some(active);
                            }
                        }
                        Some("received") => manager.emit_event("portal-send-complete", json!({})).await,
                        _ => {}
                    }
                }
                Some(Ok(Message::Binary(chunk))) => {
                    let Some(active) = incoming.as_mut() else { continue };
                    if active.file.write_all(&chunk).await.is_err() {
                        break (1011, "write failed".to_string());
                    }
                    active.received += chunk.len() as u64;
                    let (received, size) = (active.received, active.size);
                    manager.emit_event("portal-transfer-progress", json!({ "connId": conn_id, "received": received, "size": size })).await;
                    if received >= size {
                        if let Some(done) = incoming.take() {
                            finish_incoming(&manager, &conn_id, done, &mut batch, &out).await;
                        }
                    }
                }
                Some(Ok(Message::Close(frame))) => break frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1000, String::new())),
                None | Some(Err(_)) => break (1006, "connection lost".to_string()),
                _ => {}
            },
            command = commands.recv() => match command {
                Some(Cmd::Announce) => {
                    let _ = out.send(text_message(manager.portal.listing())).await;
                }
                Some(Cmd::Request { file_id, save_dir: dir }) => {
                    if let Some(dir) = dir {
                        save_dir = dir;
                    }
                    let _ = out.send(text_message(json!({ "type": "request-download", "fileId": file_id }))).await;
                }
                Some(Cmd::Close) | None => {
                    let _ = out.send(close_message(1000, "left")).await;
                    closed_by_us = true;
                    break (1000, String::new());
                }
            }
        }
    };

    if incoming.is_some() {
        manager.portal.transfers.fetch_sub(1, Ordering::Relaxed);
    }
    if closed_by_us {
        let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    } else {
        writer.abort();
    }
    end
}

/// Waits for the guest's opening message and checks it is a guest join.
async fn read_join<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>) -> Option<Value> {
    let first = tokio::time::timeout(JOIN_TIMEOUT, async {
        while let Some(Ok(message)) = ws.next().await {
            match message {
                Message::Text(text) => return Some(text),
                Message::Close(_) => return None,
                _ => {}
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let Some(text) = first else {
        close_with(ws, CLOSE_MALFORMED, "malformed join message").await;
        return None;
    };
    match serde_json::from_str::<Value>(text.as_str()) {
        Ok(msg) if msg["type"].as_str() == Some("join-guest") => Some(msg),
        Ok(_) => {
            close_with(ws, CLOSE_UNKNOWN_JOIN, "unknown join type").await;
            None
        }
        Err(_) => {
            close_with(ws, CLOSE_MALFORMED, "malformed join message").await;
            None
        }
    }
}

async fn host_connection<S>(manager: Arc<DeviceManager>, mut ws: WebSocketStream<S>, remote_ip: String, pin: String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(join) = read_join(&mut ws).await else { return };
    let name = join["deviceName"].as_str().map(str::to_string);
    let conn_id = uuid::Uuid::new_v4().to_string();
    if manager.confirm_pin(&mut ws, &remote_ip, pin, &conn_id, name.clone(), "portal-guest-pin-pending", vec![]).await != Decision::Accept {
        manager.portal.with(|i| i.save_dirs.remove(&conn_id));
        manager.emit_event("portal-connection-closed", json!({ "connId": conn_id })).await;
        return;
    }

    let guest_name = name.unwrap_or_else(|| "Guest".to_string());
    let save_dir = manager.portal.with(|i| i.save_dirs.remove(&conn_id)).flatten().unwrap_or_else(default_save_dir);
    let own_name = manager.device_name.read().await.clone();
    send_json(&mut ws, json!({ "type": "admitted", "deviceName": own_name })).await;
    if manager.portal.has_downloads() {
        send_json(&mut ws, manager.portal.listing()).await;
    }
    let (tx, commands) = mpsc::channel(8);
    manager.portal.with(|i| i.hosted.push((conn_id.clone(), Conn { tx, name: guest_name.clone() })));
    manager.emit_event("portal-connection-admitted", json!({ "connId": conn_id, "deviceName": guest_name })).await;

    run_session(manager.clone(), ws, conn_id.clone(), commands, save_dir).await;

    manager.portal.with(|i| i.hosted.retain(|(id, _)| *id != conn_id));
    manager.emit_event("portal-connection-closed", json!({ "connId": conn_id })).await;
}

async fn tls_guest(manager: Arc<DeviceManager>, guest: GuestSocket) {
    let pin = manager.guest_pin(&guest.peer_cert);
    host_connection(manager, guest.ws, guest.remote_ip, pin).await;
}

// ---- web mode: the same port speaks plain HTTP (the page and direct downloads) and WebSocket ----

async fn peek_request_head(stream: &TcpStream) -> Option<Vec<u8>> {
    let mut buffer = [0u8; 8192];
    for _ in 0..100 {
        let read = stream.peek(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        if read == buffer.len() || buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
            return Some(buffer[..read].to_vec());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    None
}

async fn respond(stream: &mut TcpStream, status: &str, headers: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

async fn serve_http(manager: &DeviceManager, mut stream: TcpStream, head: &str) {
    let head_len = head.find("\r\n\r\n").map(|i| i + 4).unwrap_or(head.len());
    let mut consumed = vec![0u8; head_len];
    if stream.read_exact(&mut consumed).await.is_err() {
        return;
    }
    let path = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("/").split('?').next().unwrap_or("/");
    if path == "/" || path == "/index.html" {
        return respond(&mut stream, "200 OK", "Content-Type: text/html; charset=utf-8\r\n", PORTAL_PAGE.as_bytes()).await;
    }
    let Some(id) = path.strip_prefix("/download/") else {
        return respond(&mut stream, "404 Not Found", "", b"Not Found").await;
    };
    let Some(file) = manager.portal.download(id) else {
        return respond(&mut stream, "404 Not Found", "", b"File Not Found").await;
    };
    let Ok(mut source) = tokio::fs::File::open(&file.path).await else {
        return respond(&mut stream, "410 Gone", "", b"File no longer exists on host").await;
    };
    let length = source.metadata().await.map(|m| m.len()).unwrap_or(file.size);
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {length}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nConnection: close\r\n\r\n",
        urlencoding::encode(&file.name)
    );
    if stream.write_all(headers.as_bytes()).await.is_ok() {
        let _ = tokio::io::copy(&mut source, &mut stream).await;
    }
}

async fn web_connection(manager: Arc<DeviceManager>, stream: TcpStream, remote_ip: String) {
    if manager.is_blocked(&remote_ip) {
        return;
    }
    let _ = stream.set_nodelay(true);
    let Some(head) = peek_request_head(&stream).await else { return };
    let head = String::from_utf8_lossy(&head).into_owned();
    if head.to_ascii_lowercase().contains("upgrade: websocket") {
        let Ok(ws) = tokio_tungstenite::accept_async(stream).await else { return };
        host_connection(manager, ws, remote_ip, random_pin()).await;
    } else {
        serve_http(&manager, stream, &head).await;
    }
}

impl DeviceManager {
    async fn serve_portal_web(self: &Arc<Self>) -> Result<tokio::task::AbortHandle, String> {
        let listener = TcpListener::bind(("0.0.0.0", PORTAL_PORT)).await.map_err(|e| format!("Portal could not listen on port {}: {}", PORTAL_PORT, e))?;
        log::info!("Portal web page listening on port {}", PORTAL_PORT);
        let manager = self.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, addr)) = listener.accept().await else { continue };
                tokio::spawn(web_connection(manager.clone(), stream, clean_ip(addr)));
            }
        });
        Ok(task.abort_handle())
    }

    pub async fn start_portal_receive(self: &Arc<Self>, web: bool) -> Result<Value, String> {
        match self.portal.with(|i| i.server.as_ref().map(|s| s.web)).flatten() {
            Some(running) if running == web => return Ok(json!({ "started": true, "port": PORTAL_PORT })),
            Some(_) => self.stop_portal_receive().await,
            None => {}
        }
        let task = if web { self.serve_portal_web().await? } else { self.serve_guests(PORTAL_PORT, "File portal", tls_guest).await? };
        self.portal.with(|i| i.server = Some(Server { web, task }));
        Ok(json!({ "started": true, "port": PORTAL_PORT, "saveDir": default_save_dir().display().to_string() }))
    }

    pub async fn stop_portal_receive(&self) {
        let (server, hosted) = self.portal.with(|i| (i.server.take(), i.hosted.iter().map(|(_, c)| c.tx.clone()).collect::<Vec<_>>())).unwrap_or_default();
        if let Some(server) = server {
            server.task.abort();
        }
        for tx in hosted {
            let _ = tx.send(Cmd::Close).await;
        }
        if self.portal.with(|i| i.client.is_none()).unwrap_or(true) {
            self.portal.with(|i| i.downloads.clear());
        }
    }

    pub fn accept_portal_guest(&self, conn_id: &str, save_dir: Option<String>) {
        if let Some(dir) = save_dir.filter(|d| !d.is_empty()) {
            self.portal.with(|i| i.save_dirs.insert(conn_id.to_string(), PathBuf::from(dir)));
        }
        self.guests.decide(conn_id, Decision::Accept);
    }

    pub async fn disconnect_portal_connection(&self, conn_id: &str) {
        let tx = self.portal.with(|i| i.hosted.iter().find(|(id, _)| id == conn_id).map(|(_, c)| c.tx.clone())).flatten();
        if let Some(tx) = tx {
            let _ = tx.send(Cmd::Close).await;
        }
    }

    /// Replaces the files offered to the connected peer(s) and tells them.
    pub async fn set_portal_downloads(&self, files: Vec<PortalFile>) {
        let mut shared = Vec::new();
        for file in files {
            let path = PathBuf::from(&file.local_path);
            match tokio::fs::metadata(&path).await {
                Ok(meta) if meta.is_file() => {
                    let id = format!("file-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
                    shared.push(SharedFile { id, name: file.name, size: meta.len(), path });
                }
                _ => {}
            }
        }
        let peers = self
            .portal
            .with(|i| {
                i.downloads = shared;
                i.hosted.iter().map(|(_, c)| c.tx.clone()).chain(i.client.as_ref().map(|c| c.tx.clone())).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for tx in peers {
            let _ = tx.send(Cmd::Announce).await;
        }
    }

    pub async fn request_portal_download(&self, file_id: String, save_dir: Option<String>) {
        let tx = self.portal.with(|i| i.hosted.first().map(|(_, c)| c.tx.clone()).or_else(|| i.client.as_ref().map(|c| c.tx.clone()))).flatten();
        if let Some(tx) = tx {
            let _ = tx.send(Cmd::Request { file_id, save_dir: save_dir.filter(|d| !d.is_empty()).map(PathBuf::from) }).await;
        }
    }

    /// Offers `files` to the peer we are already connected to, or joins the portal at `host` first.
    pub async fn join_portal_guest(self: &Arc<Self>, host: &str, files: Vec<PortalFile>) -> Result<(), String> {
        let connected = self.portal.with(|i| !i.hosted.is_empty() || i.client.is_some()).unwrap_or(false);
        self.set_portal_downloads(files).await;
        if connected {
            return Ok(());
        }

        let (mut ws, server_cert) = match connect_guest_client(self, host, PORTAL_PORT).await {
            Ok(connected) => connected,
            Err(message) => {
                self.emit_event("portal-error", json!({ "message": message })).await;
                return Ok(());
            }
        };
        self.emit_event("portal-pin-computed", json!({ "pin": self.guest_pin(&server_cert) })).await;
        let name = self.device_name.read().await.clone();
        send_json(&mut ws, json!({ "type": "join-guest", "deviceName": name })).await;

        let (tx, commands) = mpsc::channel(8);
        self.portal.with(|i| i.client = Some(Conn { tx, name: String::new() }));
        let manager = self.clone();
        tokio::spawn(async move {
            let (code, reason) = run_session(manager.clone(), ws, CLIENT_CONN_ID.to_string(), commands, default_save_dir()).await;
            manager.portal.with(|i| i.client = None);
            if matches!(code, 1000 | 1001) {
                manager.emit_event("portal-ended", json!({})).await;
            } else {
                let reason = if reason.is_empty() { format!("code {code}") } else { reason };
                manager.emit_event("portal-closed", json!({ "reason": reason })).await;
            }
        });
        Ok(())
    }

    pub async fn leave_portal_send(&self) {
        let tx = self.portal.with(|i| i.client.take().map(|c| c.tx)).flatten();
        if let Some(tx) = tx {
            let _ = tx.send(Cmd::Close).await;
        }
    }

    pub fn portal_status(&self) -> Value {
        self.portal
            .with(|i| {
                let host = i.hosted.first();
                json!({
                    "receiving": i.server.is_some(),
                    "sending": i.client.is_some(),
                    "webMode": i.server.as_ref().is_some_and(|s| s.web),
                    "connected": host.is_some() || i.client.is_some(),
                    "isHost": host.is_some(),
                    "peerName": host.map(|(_, c)| c.name.clone()).or_else(|| i.client.as_ref().map(|c| c.name.clone())),
                    "connId": host.map(|(id, _)| id.clone()),
                    "transferring": self.portal.transfers.load(Ordering::Relaxed) > 0,
                })
            })
            .unwrap_or(Value::Null)
    }
}

/// Files picked in a dialog become {localPath, relPath} pairs; a folder is expanded into its
/// files, with paths relative to the folder's parent so the structure is recreated on arrival.
pub fn expand_picked(paths: Vec<PathBuf>) -> Vec<Value> {
    fn walk(dir: &Path, base: &Path, into: &mut Vec<Value>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, into);
            } else if let Ok(relative) = path.strip_prefix(base) {
                into.push(json!({ "localPath": path.display().to_string(), "relPath": relative.to_string_lossy().replace('\\', "/") }));
            }
        }
    }
    let mut files = Vec::new();
    for path in paths {
        if path.is_dir() {
            walk(&path, path.parent().unwrap_or(&path), &mut files);
        } else if let Some(name) = path.file_name() {
            files.push(json!({ "localPath": path.display().to_string(), "relPath": name.to_string_lossy() }));
        }
    }
    files
}
