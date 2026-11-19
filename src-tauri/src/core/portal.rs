use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::BytesMut;
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

use crate::core::pairing_window::Admission;
use crate::core::guest::{clean_ip, close_with, connect_guest_client, send_json, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::transport::{DeviceManager, LINK_PORT};

// File portal: one-off file transfer with a device that is not paired. Both sides announce the files
// they are willing to hand over ({id, name, size}); the other side asks for one by id and the source
// streams it as a `file-info` message followed by binary frames of up to 1 MB (receivers write
// each frame as it comes, whatever its size). The same session driver
// serves a hosted guest, a client joining someone else's portal and a browser (web mode, which has
// no certificates, so its PIN is random and the page is served from the same port).

pub const PORTAL_PORT: u16 = LINK_PORT + 7;

const CHUNK_SIZE: usize = 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
// Buffer for a browser's plain-HTTP download; tokio::io::copy's own is 8 KB.
const HTTP_COPY_BUFFER: usize = 256 * 1024;
const CLIENT_CONN_ID: &str = "client-conn";
const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
// A session that has received nothing for SESSION_IDLE is ended; it is pinged every SESSION_PING so a quiet
// but live peer answers and stays. At most WEB_ACCEPTS web-page connections are served at once.
const SESSION_IDLE: Duration = Duration::from_secs(45);
const SESSION_PING: Duration = Duration::from_secs(15);
const WEB_ACCEPTS: usize = 32;
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
    // Guests admitted to this PC's portal, in admission order.
    hosted: Vec<(String, Conn)>,
    // The portal this PC joined as a guest of another device.
    client: Option<Conn>,
    // Destination folder chosen for a guest while it was still waiting for confirmation.
    save_dirs: HashMap<String, PathBuf>,
    // Per admitted guest: its address and the token a browser must send to fetch /download/ over
    // plain HTTP, so only a PIN-admitted session can download.
    download_tokens: HashMap<String, (String, String)>,
    // Which connection announced each file id, so a download request goes to the peer that
    // offers the file rather than to whichever guest was admitted first.
    peer_files: HashMap<String, String>,
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

    /// Whether an admitted guest at this address holds this download token.
    fn download_allowed(&self, ip: &str, token: &str) -> bool {
        self.with(|i| i.download_tokens.values().any(|(at, t)| at == ip && crate::core::mount::same_secret(t.as_bytes(), token.as_bytes())))
            .unwrap_or(false)
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

    fn set_peer_files(&self, conn_id: &str, files: Option<&Vec<Value>>) {
        self.with(|i| {
            i.peer_files.retain(|_, owner| owner != conn_id);
            for id in files.into_iter().flatten().filter_map(|f| f["id"].as_str()) {
                i.peer_files.insert(id.to_string(), conn_id.to_string());
            }
        });
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

/// A browser has no certificate to derive a PIN from, so this one is random. It has the same shape
/// as every other PIN in Link: 8 uppercase hex characters.
fn random_pin() -> String {
    let id = uuid::Uuid::new_v4();
    let bytes = id.as_bytes();
    format!("{:08X}", u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
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

/// Whether a progress event is due: the first, the last, and otherwise at most one per
/// PROGRESS_INTERVAL. Each is an IPC message to the window, and a fast link moves dozens of chunks
/// a second.
fn progress_due(last: &mut Option<Instant>, done: bool) -> bool {
    if done || last.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
        *last = Some(Instant::now());
        return true;
    }
    false
}

async fn stream_file(manager: &DeviceManager, out: &mpsc::Sender<Message>, turn: &tokio::sync::Mutex<()>, file: &SharedFile) -> Result<(), String> {
    const CLOSED: &str = "Connection closed mid-transfer";
    // Two files interleaved on one socket would corrupt the receiver, so they go one at a time.
    let _turn = turn.lock().await;
    let mut source = tokio::fs::File::open(&file.path).await.map_err(|e| format!("Failed to read file: {e}"))?;
    let total = source.metadata().await.map_err(|e| e.to_string())?.len();
    out.send(text_message(json!({ "type": "file-info", "name": file.name, "size": total }))).await.map_err(|_| CLOSED)?;

    // Each chunk is read into its own buffer and handed to the frame as is (no copy per chunk).
    let mut buffer = BytesMut::new();
    let mut sent = 0u64;
    let mut last_progress: Option<Instant> = None;
    while sent < total {
        buffer.reserve(CHUNK_SIZE);
        let read = (&mut source).take(CHUNK_SIZE as u64).read_buf(&mut buffer).await.map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        out.send(Message::Binary(buffer.split().freeze())).await.map_err(|_| CLOSED)?;
        sent += read as u64;
        if progress_due(&mut last_progress, sent >= total) {
            manager.emit_event("portal-send-progress", json!({ "sent": sent, "total": total })).await;
        }
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
    let mut last_progress: Option<Instant> = None;

    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + SESSION_PING, SESSION_PING);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_rx = Instant::now();

    let end = loop {
        tokio::select! {
            message = stream.next() => { last_rx = Instant::now(); match message {
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
                            log::info!("Portal {}: peer announced {} file(s)", conn_id, msg["files"].as_array().map_or(0, Vec::len));
                            manager.portal.set_peer_files(&conn_id, msg["files"].as_array());
                            manager.emit_event("portal-peer-files-changed", json!({ "files": msg["files"], "connId": conn_id })).await;
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
                            last_progress = None;
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
                    if progress_due(&mut last_progress, received >= size) {
                        manager.emit_event("portal-transfer-progress", json!({ "connId": conn_id, "received": received, "size": size })).await;
                    }
                    if received >= size {
                        if let Some(done) = incoming.take() {
                            finish_incoming(&manager, &conn_id, done, &mut batch, &out).await;
                        }
                    }
                }
                Some(Ok(Message::Close(frame))) => break frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1000, String::new())),
                None | Some(Err(_)) => break (1006, "connection lost".to_string()),
                _ => {}
            } },
            _ = ping.tick() => {
                if last_rx.elapsed() >= SESSION_IDLE {
                    log::info!("Portal {}: idle for {:?}; ending it", conn_id, SESSION_IDLE);
                    break (1006, "connection timed out".to_string());
                }
                let _ = out.try_send(Message::Ping(Default::default()));
            }
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
    manager.portal.set_peer_files(&conn_id, None);
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

/// `shown` is the code the host's screen shows; it is empty when the guest scanned the QR (nothing to compare).
async fn host_connection<S>(manager: Arc<DeviceManager>, mut ws: WebSocketStream<S>, remote_ip: String, pin: String, shown: String, paired_name: Option<String>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(join) = read_join(&mut ws).await else { return };
    let name = paired_name.clone().or_else(|| join["deviceName"].as_str().map(str::to_string));
    let conn_id = uuid::Uuid::new_v4().to_string();
    // A paired device has already been vouched for; only strangers get the PIN prompt.
    if paired_name.is_none() && manager.confirm_with(&mut ws, &remote_ip, pin, shown, &conn_id, name.clone(), "portal-guest-pin-pending", vec![]).await != Decision::Accept {
        manager.portal.with(|i| i.save_dirs.remove(&conn_id));
        manager.emit_event("portal-connection-closed", json!({ "connId": conn_id })).await;
        return;
    }

    let guest_name = name.unwrap_or_else(|| "Guest".to_string());
    let save_dir = manager.portal.with(|i| i.save_dirs.remove(&conn_id)).flatten().unwrap_or_else(default_save_dir);
    let own_name = manager.device_name.read().await.clone();
    let download_token = crate::core::input_relay::new_input_token();
    manager.portal.with(|i| i.download_tokens.insert(conn_id.clone(), (remote_ip.clone(), download_token.clone())));
    send_json(&mut ws, json!({ "type": "admitted", "deviceName": own_name, "downloadToken": download_token })).await;
    if manager.portal.has_downloads() {
        send_json(&mut ws, manager.portal.listing()).await;
    }
    log::info!("Portal {}: {} joined from {} (trusted: {})", conn_id, guest_name, remote_ip, paired_name.is_some());
    let (tx, commands) = mpsc::channel(8);
    manager.portal.with(|i| i.hosted.push((conn_id.clone(), Conn { tx, name: guest_name.clone() })));
    manager.emit_event("portal-connection-admitted", json!({ "connId": conn_id, "deviceName": guest_name })).await;

    run_session(manager.clone(), ws, conn_id.clone(), commands, save_dir).await;

    log::info!("Portal {}: closed", conn_id);
    manager.portal.with(|i| {
        i.hosted.retain(|(id, _)| *id != conn_id);
        i.download_tokens.remove(&conn_id);
    });
    manager.emit_event("portal-connection-closed", json!({ "connId": conn_id })).await;
}

async fn tls_guest(manager: Arc<DeviceManager>, mut guest: GuestSocket) {
    let pin = manager.guest_pin(&guest.peer_cert);
    let paired_name = manager.paired_name_for_cert(&guest.peer_cert).await;
    // A stranger that scanned the portal's QR holds its one-time token; one without is asked about via the PIN.
    let mut shown = pin.clone();
    if paired_name.is_none() {
        match manager.admit_guest(&mut guest, &None).await {
            Some(Admission::Qr) => shown = String::new(),
            Some(_) => {}
            None => return,
        }
    }
    host_connection(manager, guest.ws, guest.remote_ip, pin, shown, paired_name).await;
}

// ---- web mode: the same port speaks plain HTTP (the page and direct downloads) and WebSocket ----

const MAX_REQUEST_HEAD: usize = 8192;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(2);

/// Reads (consuming) up to the end of the request head, or 8 KB, waking only when bytes arrive. A
/// client that sends no complete head within two seconds is dropped.
async fn read_request_head(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let deadline = tokio::time::Instant::now() + REQUEST_HEAD_TIMEOUT;
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; MAX_REQUEST_HEAD];
    loop {
        let read = tokio::time::timeout_at(deadline, stream.read(&mut chunk[..MAX_REQUEST_HEAD - head.len()])).await.ok()?.ok()?;
        if read == 0 {
            return None;
        }
        head.extend_from_slice(&chunk[..read]);
        if head.len() == MAX_REQUEST_HEAD || head.windows(4).any(|w| w == b"\r\n\r\n") {
            return Some(head);
        }
    }
}

/// A connection whose first bytes were already read: they are handed out again before the socket's
/// own, so the WebSocket handshake sees the whole request.
struct Replayed {
    head: Vec<u8>,
    pos: usize,
    inner: TcpStream,
}

impl AsyncRead for Replayed {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        if self.pos < self.head.len() {
            let (start, n) = (self.pos, (self.head.len() - self.pos).min(buf.remaining()));
            buf.put_slice(&self.head[start..start + n]);
            self.pos += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for Replayed {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, data: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, data)
    }

    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

async fn respond(stream: &mut TcpStream, status: &str, headers: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

/// Answers a plain HTTP GET whose head has already been read (any body is ignored; the page and
/// downloads take none).
async fn serve_http(manager: &DeviceManager, mut stream: TcpStream, head: &str, remote_ip: &str) {
    let target = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path == "/" || path == "/index.html" {
        return respond(&mut stream, "200 OK", "Content-Type: text/html; charset=utf-8\r\n", PORTAL_PAGE.as_bytes()).await;
    }
    let Some(id) = path.strip_prefix("/download/") else {
        return respond(&mut stream, "404 Not Found", "", b"Not Found").await;
    };
    // The PIN is the gate: only a browser whose session was admitted may download.
    let token = query.split('&').find_map(|pair| pair.strip_prefix("token=")).unwrap_or("");
    if !manager.portal.download_allowed(remote_ip, token) {
        return respond(&mut stream, "403 Forbidden", "", b"Not admitted").await;
    }
    let id = urlencoding::decode(id).map(|c| c.into_owned()).unwrap_or_default();
    let Some(file) = manager.portal.download(&id) else {
        return respond(&mut stream, "404 Not Found", "", b"File Not Found").await;
    };
    let Ok(source) = tokio::fs::File::open(&file.path).await else {
        return respond(&mut stream, "410 Gone", "", b"File no longer exists on host").await;
    };
    let length = source.metadata().await.map(|m| m.len()).unwrap_or(file.size);
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {length}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nConnection: close\r\n\r\n",
        urlencoding::encode(&file.name)
    );
    if stream.write_all(headers.as_bytes()).await.is_ok() {
        let mut source = tokio::io::BufReader::with_capacity(HTTP_COPY_BUFFER, source);
        let _ = tokio::io::copy_buf(&mut source, &mut stream).await;
    }
}

async fn web_connection(manager: Arc<DeviceManager>, mut stream: TcpStream, remote_ip: String) {
    if manager.is_blocked(&remote_ip) {
        return;
    }
    let _ = stream.set_nodelay(true);
    let Some(head) = read_request_head(&mut stream).await else { return };
    let text = String::from_utf8_lossy(&head).into_owned();
    if text.to_ascii_lowercase().contains("upgrade: websocket") {
        let Ok(ws) = tokio_tungstenite::accept_async(Replayed { head, pos: 0, inner: stream }).await else { return };
        let pin = random_pin();
        host_connection(manager, ws, remote_ip, pin.clone(), pin, None).await;
    } else {
        serve_http(&manager, stream, &text, &remote_ip).await;
    }
}

impl DeviceManager {
    async fn serve_portal_web(self: &Arc<Self>) -> Result<tokio::task::AbortHandle, String> {
        let listener = TcpListener::bind(("0.0.0.0", PORTAL_PORT)).await.map_err(|e| format!("Portal could not listen on port {}: {}", PORTAL_PORT, e))?;
        log::info!("Portal web page listening on port {}", PORTAL_PORT);
        let manager = self.clone();
        let slots = Arc::new(tokio::sync::Semaphore::new(WEB_ACCEPTS));
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, addr)) = listener.accept().await else { continue };
                // Past the cap a connection is dropped, not queued.
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                let manager = manager.clone();
                tokio::spawn(async move {
                    web_connection(manager, stream, clean_ip(addr)).await;
                    drop(permit);
                });
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
        let tx = self
            .portal
            .with(|i| {
                let owner = i.peer_files.get(&file_id).cloned();
                let owned = owner.and_then(|owner| {
                    if owner == CLIENT_CONN_ID {
                        i.client.as_ref().map(|c| c.tx.clone())
                    } else {
                        i.hosted.iter().find(|(id, _)| *id == owner).map(|(_, c)| c.tx.clone())
                    }
                });
                // A file id nobody announced (the listing raced a reconnect) keeps the old routing.
                owned.or_else(|| i.hosted.first().map(|(_, c)| c.tx.clone())).or_else(|| i.client.as_ref().map(|c| c.tx.clone()))
            })
            .flatten();
        if let Some(tx) = tx {
            let _ = tx.send(Cmd::Request { file_id, save_dir: save_dir.filter(|d| !d.is_empty()).map(PathBuf::from) }).await;
        }
    }

    /// Offers `files` over the current portal session (hosted or joined), or joins the portal at `host` first.
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
        self.emit_event("portal-pin-computed", json!({ "pin": self.client_pin(&server_cert) })).await;
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
                    // The files staged for sharing, so a reopened screen shows them again.
                    "stagedFiles": i.downloads.iter().map(|d| json!({ "name": d.name, "localPath": d.path.display().to_string() })).collect::<Vec<_>>(),
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
