use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::core::packet::LinkPacket;
use crate::core::transport::DeviceManager;

// File sharing between paired devices. Wire protocol shared with the Android core (LinkShare.java):
//
//   sender   -> receiver  link.share.offer   { transferId, files: [{ name, size }], totalSize }
//   receiver -> sender    link.share.answer  { transferId, accepted, reason? }
//   sender   -> receiver  link.share.start   { transferId }  + payloadTransferInfo { port }
//   receiver -> sender    link.share.done    { transferId, ok, saved, error? }
//
// `name` is a relative path with '/' separators. After the answer, the sender opens a one-shot TLS
// server (only the peer's pinned certificate is served) and streams every file's bytes back to back
// in offer order; the receiver connects, splits the stream by the offered sizes and writes to disk.
// This desktop always asks the user (Accept or Reject, then where to save) before it answers.
pub const OFFER: &str = "link.share.offer";
pub const ANSWER: &str = "link.share.answer";
pub const START: &str = "link.share.start";
pub const DONE: &str = "link.share.done";

const MAX_FILES: usize = 10_000;
const MAX_DEPTH: usize = 32;
// How long the prompt waits for the user before the offer is refused.
const OFFER_TTL: Duration = Duration::from_secs(90);
// How long a sender waits for the other side to answer (it covers the user clicking Accept and choosing a folder).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);
const START_TIMEOUT: Duration = Duration::from_secs(60);
const SERVE_TIMEOUT: Duration = Duration::from_secs(60);
const DONE_TIMEOUT: Duration = Duration::from_secs(3600);

struct Incoming {
    device_id: String,
    device_name: String,
    files: Vec<(Vec<String>, u64)>,
    total: u64,
    // Set once the user accepted and chose a folder.
    save_dir: Option<PathBuf>,
}

struct Answer {
    accepted: bool,
    reason: String,
}

struct Done {
    ok: bool,
    saved: u64,
    error: String,
}

struct Outgoing {
    device_id: String,
    answer: Option<oneshot::Sender<Answer>>,
    done: Option<oneshot::Sender<Done>>,
}

struct OutFile {
    name: String,
    path: PathBuf,
    size: u64,
}

static INCOMING: LazyLock<Mutex<HashMap<String, Incoming>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static OUTGOING: LazyLock<Mutex<HashMap<String, Outgoing>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn plural(n: usize) -> String {
    if n == 1 { "1 file".to_string() } else { format!("{} files", n) }
}

fn payload_port(pkt: &LinkPacket) -> Option<u16> {
    pkt.payload_transfer_info.as_ref()?.get("port")?.as_u64().map(|p| p as u16)
}

fn transfer_id(pkt: &LinkPacket) -> Option<String> {
    pkt.body.get("transferId").and_then(|v| v.as_str()).map(str::to_string)
}

// Makes one path component safe to create on Windows: no reserved characters or device names, no
// trailing dots or spaces, and never "." or "..".
fn clean_component(component: &str) -> String {
    let mut cleaned: String = component
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.chars().count() > 200 {
        cleaned = cleaned.chars().take(200).collect();
    }
    if cleaned.is_empty() {
        return "_".to_string();
    }
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3",
        "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        cleaned.insert(0, '_');
    }
    cleaned
}

fn safe_relative(name: &str) -> Option<Vec<String>> {
    let parts: Vec<String> = name.split('/').filter(|p| !p.is_empty()).map(clean_component).collect();
    (!parts.is_empty() && parts.len() <= MAX_DEPTH).then_some(parts)
}

fn exists_or_partial(path: &Path) -> bool {
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    path.exists() || Path::new(&part).exists()
}

// First free name for a top-level entry: "a.txt", then "a (1).txt", "a (2).txt"... A folder keeps its
// name and gains the suffix on the whole folder.
fn unique_top(dir: &Path, name: &str, is_folder: bool) -> String {
    if !exists_or_partial(&dir.join(name)) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.').filter(|&i| i > 0 && !is_folder) {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{} ({}){}", stem, n, ext);
        if !exists_or_partial(&dir.join(&candidate)) {
            return candidate;
        }
    }
    name.to_string()
}

fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<OutFile>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let name = format!("{}/{}", prefix, entry.file_name().to_string_lossy());
        if kind.is_file() {
            if let Ok(meta) = entry.metadata() {
                out.push(OutFile { name, path: entry.path(), size: meta.len() });
            }
        } else if kind.is_dir() {
            walk(&entry.path(), &name, depth + 1, out);
        }
    }
}

// Files are sent as they are; a folder is sent with its structure. Links are not followed.
fn collect(paths: Vec<PathBuf>) -> Vec<OutFile> {
    let mut out = Vec::new();
    for path in paths {
        if out.len() >= MAX_FILES {
            break;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        if meta.is_file() {
            out.push(OutFile { name, path, size: meta.len() });
        } else if meta.is_dir() {
            walk(&path, &name, 1, &mut out);
        }
    }
    out
}

// Each tokio::fs read or write is a hop to the blocking pool, so the buffers are large enough to keep
// those hops rare at LAN speeds.
const IO_BUFFER: usize = 512 * 1024;

async fn stream_files<W: AsyncWrite + Unpin>(files: &[OutFile], out: &mut W) -> Result<(), String> {
    let mut buf = vec![0u8; IO_BUFFER];
    for f in files {
        let mut file = tokio::fs::File::open(&f.path).await.map_err(|e| format!("Could not read {}: {}", f.name, e))?;
        let mut left = f.size;
        while left > 0 {
            let want = buf.len().min(left as usize);
            let n = file.read(&mut buf[..want]).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("{} changed while it was being sent", f.name));
            }
            out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            left -= n as u64;
        }
    }
    out.flush().await.map_err(|e| e.to_string())?;
    out.shutdown().await.map_err(|e| e.to_string())
}

// Writes the incoming byte stream to disk as <name>.part files, renaming each when complete. Returns
// the number of files written. A half-written file is removed on failure.
async fn receive_to_disk<R: AsyncRead + Unpin>(reader: &mut R, files: &[(Vec<String>, u64)], dir: &Path) -> Result<usize, String> {
    // Resolve each top-level name once so a folder's files stay together.
    let mut tops: HashMap<String, String> = HashMap::new();
    for (parts, _) in files {
        let top = &parts[0];
        if !tops.contains_key(top) {
            let is_folder = files.iter().any(|(p, _)| &p[0] == top && p.len() > 1);
            tops.insert(top.clone(), unique_top(dir, top, is_folder));
        }
    }

    let mut buf = vec![0u8; IO_BUFFER];
    let mut saved = 0;
    for (parts, size) in files {
        let mut target = dir.join(&tops[&parts[0]]);
        for part in &parts[1..] {
            target.push(part);
        }
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        let mut part_path = target.as_os_str().to_owned();
        part_path.push(".part");
        let part_path = PathBuf::from(part_path);

        let result: Result<(), String> = async {
            let mut file = tokio::fs::File::create(&part_path).await.map_err(|e| e.to_string())?;
            let mut left = *size;
            while left > 0 {
                let want = buf.len().min(left as usize);
                let n = reader.read(&mut buf[..want]).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("The connection closed before the file was complete".to_string());
                }
                file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                left -= n as u64;
            }
            file.flush().await.map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                tokio::fs::rename(&part_path, &target).await.map_err(|e| e.to_string())?;
                saved += 1;
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(e);
            }
        }
    }
    Ok(saved)
}

impl DeviceManager {
    async fn share_emit(&self, event: &str, payload: Value) {
        if let Some(app) = self.app_handle().await {
            let _ = app.emit(event, payload);
        }
    }

    async fn share_toast(&self, title: &str, body: &str) {
        if let Some(app) = self.app_handle().await {
            let _ = app.notification().builder().title(title).body(body).show();
        }
    }

    async fn share_status(&self, id: &str, device_id: &str, state: &str, message: &str) {
        self.share_emit("share-status", json!({ "transferId": id, "deviceId": device_id, "state": state, "message": message })).await;
    }

    async fn share_peer_name(&self, device_id: &str) -> String {
        self.trust_store.read().await.get(device_id).map(|d| d.device_name.clone()).unwrap_or_else(|| "your device".to_string())
    }

    fn share_allowed(&self, device_id: &str) -> bool {
        self.permission_store.lock().is_ok_and(|p| p.check(device_id, "fileaccess"))
    }

    // One-shot TLS server that streams `files` to the peer, which must present its pinned certificate.
    async fn serve_files(self: &Arc<Self>, device_id: &str, files: Vec<OutFile>) -> Result<(u16, oneshot::Receiver<Result<(), String>>), String> {
        let (_, pinned) = self.peer_endpoint(device_id).await.ok_or_else(|| "Missing pinned certificate for peer".to_string())?;
        let listener = TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let acceptor = self.tls_acceptor();
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + SERVE_TIMEOUT;
            let mut tls = loop {
                let Ok(Ok((stream, _))) = tokio::time::timeout_at(deadline, listener.accept()).await else {
                    let _ = tx.send(Err("The other device never connected".to_string()));
                    return;
                };
                let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await else { continue };
                let presented = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| hex::encode(Sha256::digest(c.as_ref())));
                if presented.as_deref() == Some(pinned.as_str()) {
                    break tls;
                }
            };
            let _ = tx.send(stream_files(&files, &mut tls).await);
        });
        Ok((port, rx))
    }

    async fn connect_payload(self: &Arc<Self>, device_id: &str, port: u16) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
        let (host, pinned) = self.peer_endpoint(device_id).await.ok_or_else(|| "Missing host or pinned certificate for peer".to_string())?;
        let stream = TcpStream::connect((host.as_str(), port)).await.map_err(|e| e.to_string())?;
        let server_name = rustls::pki_types::ServerName::try_from("link.local".to_string()).map_err(|e| e.to_string())?;
        let tls = self.tls_connector().connect(server_name, stream).await.map_err(|e| e.to_string())?;
        let presented = tls
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first())
            .map(|c| hex::encode(Sha256::digest(c.as_ref())))
            .ok_or("Payload connection presented no certificate")?;
        if presented != pinned {
            return Err("Payload connection certificate does not match pinned device — refusing transfer".into());
        }
        Ok(tls)
    }

    /// Offers files or folders to a paired device and, once it accepts, streams them. Returns the
    /// transfer id right away; progress and the outcome arrive as notifications.
    pub async fn send_files(self: &Arc<Self>, device_id: &str, paths: Vec<PathBuf>) -> Result<String, String> {
        let files = tokio::task::spawn_blocking(move || collect(paths)).await.map_err(|e| e.to_string())?;
        if files.is_empty() {
            return Err("There is nothing to send".to_string());
        }
        let total: u64 = files.iter().map(|f| f.size).sum();
        let id = uuid::Uuid::new_v4().to_string();
        let name = self.share_peer_name(device_id).await;

        let (answer_tx, answer_rx) = oneshot::channel();
        let (done_tx, done_rx) = oneshot::channel();
        lock(&OUTGOING).insert(id.clone(), Outgoing { device_id: device_id.to_string(), answer: Some(answer_tx), done: Some(done_tx) });

        let listing: Vec<Value> = files.iter().map(|f| json!({ "name": f.name, "size": f.size })).collect();
        let offer = LinkPacket::new(OFFER, json!({ "transferId": id, "files": listing, "totalSize": total }));
        if let Err(e) = self.send_link_packet(device_id, offer).await {
            lock(&OUTGOING).remove(&id);
            return Err(e);
        }
        self.share_status(&id, device_id, "offered", &format!("Offered {} to {}", plural(files.len()), name)).await;

        let mgr = self.clone();
        let device_id = device_id.to_string();
        let tid = id.clone();
        tokio::spawn(async move {
            let outcome = mgr.run_outgoing(&tid, &device_id, &name, files, total, answer_rx, done_rx).await;
            lock(&OUTGOING).remove(&tid);
            match outcome {
                Ok(count) => {
                    mgr.share_status(&tid, &device_id, "sent", &format!("Sent {} to {}", plural(count), name)).await;
                    mgr.share_toast("Files sent", &format!("{} copied to {}", plural(count), name)).await;
                }
                Err(message) => {
                    mgr.share_status(&tid, &device_id, "failed", &message).await;
                    mgr.share_toast("Couldn't send files", &message).await;
                }
            }
        });
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_outgoing(
        self: &Arc<Self>,
        id: &str,
        device_id: &str,
        name: &str,
        files: Vec<OutFile>,
        total: u64,
        answer_rx: oneshot::Receiver<Answer>,
        done_rx: oneshot::Receiver<Done>,
    ) -> Result<usize, String> {
        let count = files.len();
        let answer = match tokio::time::timeout(ANSWER_TIMEOUT, answer_rx).await {
            Ok(Ok(answer)) => answer,
            _ => return Err(format!("{} did not respond", name)),
        };
        if !answer.accepted {
            return Err(match answer.reason.as_str() {
                "permission" => format!("{} does not allow file transfers from this PC", name),
                "expired" => format!("{} did not respond in time", name),
                "invalid" => format!("{} could not read the file list", name),
                _ => format!("{} declined the files", name),
            });
        }

        self.share_status(id, device_id, "sending", &format!("Sending {} to {}", plural(count), name)).await;
        let (port, served) = self.serve_files(device_id, files).await?;
        let mut start = LinkPacket::new(START, json!({ "transferId": id }));
        start.payload_size = Some(total as i64);
        start.payload_transfer_info = Some(json!({ "port": port }));
        self.send_link_packet(device_id, start).await?;

        if let Ok(Err(e)) = served.await {
            return Err(e);
        }
        match tokio::time::timeout(DONE_TIMEOUT, done_rx).await {
            Ok(Ok(done)) if done.ok => Ok(done.saved as usize),
            Ok(Ok(done)) => Err(if done.error.is_empty() { format!("{} could not save the files", name) } else { done.error }),
            _ => Err(format!("{} did not confirm the transfer", name)),
        }
    }

    /// A paired device wants to send files here. The user is always asked first.
    pub async fn on_share_offer(self: &Arc<Self>, from: &str, pkt: LinkPacket) {
        let Some(id) = transfer_id(&pkt) else { return };
        let reject = |reason: &'static str| {
            let mgr = self.clone();
            let from = from.to_string();
            let id = id.clone();
            async move {
                let _ = mgr.send_link_packet(&from, LinkPacket::new(ANSWER, json!({ "transferId": id, "accepted": false, "reason": reason }))).await;
            }
        };

        if !self.share_allowed(from) {
            reject("permission").await;
            return;
        }
        let Some(list) = pkt.body.get("files").and_then(|v| v.as_array()).filter(|l| !l.is_empty() && l.len() <= MAX_FILES) else {
            reject("invalid").await;
            return;
        };
        let mut files = Vec::with_capacity(list.len());
        let mut total: u64 = 0;
        for entry in list {
            let parsed = entry
                .get("name")
                .and_then(|v| v.as_str())
                .and_then(safe_relative)
                .zip(entry.get("size").and_then(|v| v.as_u64()));
            let Some((parts, size)) = parsed else {
                reject("invalid").await;
                return;
            };
            let Some(sum) = total.checked_add(size) else {
                reject("invalid").await;
                return;
            };
            total = sum;
            files.push((parts, size));
        }
        if pkt.body.get("totalSize").and_then(|v| v.as_u64()).is_some_and(|t| t != total) {
            reject("invalid").await;
            return;
        }

        let device_name = self.share_peer_name(from).await;
        let names: Vec<String> = files.iter().take(5).map(|(p, _)| p.join("/")).collect();
        let count = files.len();
        lock(&INCOMING).insert(id.clone(), Incoming { device_id: from.to_string(), device_name: device_name.clone(), files, total, save_dir: None });

        self.share_emit(
            "share-offer",
            json!({ "transferId": id, "deviceId": from, "deviceName": device_name, "count": count, "totalSize": total, "names": names }),
        )
        .await;
        if let Some(app) = self.app_handle().await {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        self.share_toast(&format!("{} wants to send you files", device_name), &format!("{} · open Link to accept", plural(count))).await;

        // Refuse the offer if nobody answers, so the sender is not left waiting.
        let mgr = self.clone();
        let from = from.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(OFFER_TTL).await;
            let expired = {
                let mut map = lock(&INCOMING);
                if map.get(&id).is_some_and(|i| i.save_dir.is_none()) {
                    map.remove(&id);
                    true
                } else {
                    false
                }
            };
            if expired {
                let _ = mgr.send_link_packet(&from, LinkPacket::new(ANSWER, json!({ "transferId": id, "accepted": false, "reason": "expired" }))).await;
                mgr.share_emit("share-offer-closed", json!({ "transferId": id })).await;
            }
        });
    }

    /// The user accepted an offer and picked the folder to save into.
    pub async fn accept_share(self: &Arc<Self>, id: &str, save_dir: &str) -> Result<(), String> {
        let dir = PathBuf::from(save_dir);
        if !dir.is_dir() {
            return Err("That folder does not exist".to_string());
        }
        let device_id = {
            let mut map = lock(&INCOMING);
            let incoming = map.get_mut(id).ok_or_else(|| "This offer has expired".to_string())?;
            if incoming.save_dir.is_some() {
                return Err("This offer was already accepted".to_string());
            }
            incoming.save_dir = Some(dir);
            incoming.device_id.clone()
        };
        let answer = LinkPacket::new(ANSWER, json!({ "transferId": id, "accepted": true }));
        if let Err(e) = self.send_link_packet(&device_id, answer).await {
            lock(&INCOMING).remove(id);
            return Err(e);
        }

        // If the sender never starts the transfer, forget the offer.
        let mgr = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(START_TIMEOUT).await;
            if lock(&INCOMING).remove(&id).is_some() {
                mgr.share_status(&id, &device_id, "failed", "The sender did not start the transfer").await;
            }
        });
        Ok(())
    }

    pub async fn reject_share(self: &Arc<Self>, id: &str) {
        let removed = lock(&INCOMING).remove(id);
        if let Some(incoming) = removed {
            let _ = self.send_link_packet(&incoming.device_id, LinkPacket::new(ANSWER, json!({ "transferId": id, "accepted": false, "reason": "declined" }))).await;
        }
    }

    pub async fn on_share_answer(&self, from: &str, pkt: LinkPacket) {
        let Some(id) = transfer_id(&pkt) else { return };
        let accepted = pkt.body.get("accepted").and_then(|v| v.as_bool()).unwrap_or(false);
        let reason = pkt.body.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut map = lock(&OUTGOING);
        if let Some(out) = map.get_mut(&id).filter(|o| o.device_id == from) {
            if let Some(tx) = out.answer.take() {
                let _ = tx.send(Answer { accepted, reason });
            }
        }
    }

    pub async fn on_share_done(&self, from: &str, pkt: LinkPacket) {
        let Some(id) = transfer_id(&pkt) else { return };
        let done = Done {
            ok: pkt.body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            saved: pkt.body.get("saved").and_then(|v| v.as_u64()).unwrap_or(0),
            error: pkt.body.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        };
        let mut map = lock(&OUTGOING);
        if let Some(out) = map.get_mut(&id).filter(|o| o.device_id == from) {
            if let Some(tx) = out.done.take() {
                let _ = tx.send(done);
            }
        }
    }

    /// The sender is ready: pull the bytes into the folder the user chose.
    pub async fn on_share_start(self: &Arc<Self>, from: &str, pkt: LinkPacket) {
        let Some(id) = transfer_id(&pkt) else { return };
        let Some(port) = payload_port(&pkt) else { return };
        let incoming = {
            let mut map = lock(&INCOMING);
            match map.get(&id) {
                Some(i) if i.device_id == from && i.save_dir.is_some() => map.remove(&id),
                _ => None,
            }
        };
        let Some(Incoming { device_name, files, total, save_dir: Some(dir), .. }) = incoming else { return };

        self.share_status(&id, from, "receiving", &format!("Receiving {} from {}", plural(files.len()), device_name)).await;
        let result = async {
            let mut tls = self.connect_payload(from, port).await?;
            let saved = receive_to_disk(&mut tls, &files, &dir).await?;
            Ok::<usize, String>(saved)
        }
        .await;

        match result {
            Ok(saved) => {
                let _ = self.send_link_packet(from, LinkPacket::new(DONE, json!({ "transferId": id, "ok": true, "saved": saved }))).await;
                let message = format!("Received {} from {}", plural(saved), device_name);
                self.share_emit("share-status", json!({ "transferId": id, "deviceId": from, "state": "received", "message": message, "savedTo": dir.display().to_string(), "bytes": total })).await;
                self.share_toast("Files received", &format!("{} saved to {}", plural(saved), dir.display())).await;
            }
            Err(error) => {
                let _ = self.send_link_packet(from, LinkPacket::new(DONE, json!({ "transferId": id, "ok": false, "saved": 0, "error": error }))).await;
                self.share_status(&id, from, "failed", &error).await;
                self.share_toast("Couldn't receive files", &error).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_hostile_names() {
        assert_eq!(safe_relative("../../etc/passwd"), Some(vec!["_".to_string(), "_".to_string(), "etc".to_string(), "passwd".to_string()]));
        assert_eq!(safe_relative("C:\\Windows\\x.txt"), Some(vec!["C__Windows_x.txt".to_string()]));
        assert_eq!(safe_relative("dir/sub/file.txt"), Some(vec!["dir".to_string(), "sub".to_string(), "file.txt".to_string()]));
        assert_eq!(safe_relative("/a//b"), Some(vec!["a".to_string(), "b".to_string()]));
        assert_eq!(safe_relative("///"), None);
        assert_eq!(clean_component("nul.txt"), "_nul.txt");
        assert_eq!(clean_component("name. "), "name");
    }

    #[test]
    fn dedupes_top_level_names() {
        let dir = std::env::temp_dir().join(format!("link-share-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("pics")).unwrap();
        assert_eq!(unique_top(&dir, "a.txt", false), "a (1).txt");
        assert_eq!(unique_top(&dir, "b.txt", false), "b.txt");
        assert_eq!(unique_top(&dir, "pics", true), "pics (1)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn streams_files_round_trip() {
        let src = std::env::temp_dir().join(format!("link-share-src-{}", std::process::id()));
        let dst = std::env::temp_dir().join(format!("link-share-dst-{}", std::process::id()));
        std::fs::create_dir_all(src.join("album")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("one.txt"), b"hello").unwrap();
        std::fs::write(src.join("album").join("two.bin"), vec![7u8; 300_000]).unwrap();

        let files = collect(vec![src.join("one.txt"), src.join("album")]);
        assert_eq!(files.len(), 2);
        let mut wire = Vec::new();
        stream_files(&files, &mut wire).await.unwrap();
        let listing: Vec<(Vec<String>, u64)> = files.iter().map(|f| (safe_relative(&f.name).unwrap(), f.size)).collect();
        let saved = receive_to_disk(&mut wire.as_slice(), &listing, &dst).await.unwrap();
        assert_eq!(saved, 2);
        assert_eq!(std::fs::read(dst.join("one.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dst.join("album").join("two.bin")).unwrap().len(), 300_000);

        // A truncated stream fails and leaves no .part file behind.
        let dst2 = dst.join("again");
        std::fs::create_dir_all(&dst2).unwrap();
        let err = receive_to_disk(&mut &wire[..100], &listing, &dst2).await;
        assert!(err.is_err());
        assert!(std::fs::read_dir(&dst2).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".part")));
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }
}
