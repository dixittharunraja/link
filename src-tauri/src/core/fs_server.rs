use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::core::transport::DeviceManager;

// Serves this PC's files to paired devices that hold the "fileaccess" permission. The wire protocol
// is the phone's own file server's (LinkFsServer.java), so a phone reads a PC and another phone the
// same way (LinkFsClient.java):
//
//   One TLS WebSocket per connection; requests carry an `id` that their reply echoes.
//   text request    { id, action, path?, offset?, length?, limit?, newPath?, isDirectory?, max?, quality? }
//   binary request  u32 big-endian header length, JSON header { id, action: "write", path, offset }, raw bytes
//   text reply      { id, success, error? , ...result fields }   listRoots -> roots, readdir -> files + hasMore,
//                                                                 stat -> name / isDirectory / size / mtime
//   binary reply    u32 big-endian header length, JSON header { id, success: true }, raw bytes (read, thumbnail)
//
// The phone listens on a fixed port. This PC binds its listener on first use and hands the port out
// through the one remaining control packet, link.fs.request { action: "open" } -> { port }, which also
// registers the asking device's pinned certificate: a connection is served only when its client
// certificate is that pin and the device is still connected, and every request is checked against the
// device's fileaccess permission.

const MAX_READ: usize = 8 * 1024 * 1024;

// Drive letters that are other devices' mounted storage. Serving them back would show a phone its
// own files as a folder of this PC (and let it copy them into themselves), so they are neither
// listed nor reachable.
static MOUNTED_DRIVES: std::sync::Mutex<Vec<char>> = std::sync::Mutex::new(Vec::new());

fn drive_char(letter: &str) -> Option<char> {
    let mut chars = letter.trim().chars();
    let first = chars.next().filter(char::is_ascii_alphabetic)?;
    matches!(chars.next(), None | Some(':')).then(|| first.to_ascii_uppercase())
}

pub fn hide_drive(letter: &str) {
    if let (Some(c), Ok(mut drives)) = (drive_char(letter), MOUNTED_DRIVES.lock()) {
        if !drives.contains(&c) {
            drives.push(c);
        }
    }
}

pub fn show_drive(letter: &str) {
    if let (Some(c), Ok(mut drives)) = (drive_char(letter), MOUNTED_DRIVES.lock()) {
        drives.retain(|d| *d != c);
    }
}

fn is_mounted_drive(letter: char) -> bool {
    MOUNTED_DRIVES.lock().is_ok_and(|drives| drives.contains(&letter.to_ascii_uppercase()))
}

fn is_on_mounted_drive(path: &str) -> bool {
    let mut chars = path.trim().chars();
    matches!((chars.next(), chars.next()), (Some(c), Some(':')) if is_mounted_drive(c))
}

// Collapses "." and ".." lexically, so a path like C:\Users\x\..\..\Windows is judged by where it
// really lands (the OS resolves it the same way when the operation runs).
fn normalize(path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn lower(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().replace('/', "\\")
}

fn env_dir(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string()).to_lowercase()
}

/// Credential stores and operating-system folders no remote device may read or write.
fn is_sensitive(path: &str) -> bool {
    let resolved = lower(&normalize(path));
    if resolved.is_empty() {
        return false;
    }
    let roots = [
        env_dir("SystemRoot", "C:\\Windows"),
        env_dir("ProgramFiles", "C:\\Program Files"),
        env_dir("ProgramFiles(x86)", "C:\\Program Files (x86)"),
        env_dir("CommonProgramFiles", "C:\\Program Files\\Common Files"),
    ];
    if roots.iter().any(|r| resolved.starts_with(r.as_str())) {
        return true;
    }
    const FRAGMENTS: &[&str] = &[
        ":\\$recycle.bin",
        ":\\system volume information",
        ":\\recovery",
        "\\.ssh",
        "\\.aws",
        "\\.kube",
        "\\.gnupg",
        "\\appdata\\local\\google\\chrome\\user data",
        "\\appdata\\local\\microsoft\\edge\\user data",
        "\\appdata\\roaming\\mozilla\\firefox\\profiles",
    ];
    FRAGMENTS.iter().any(|f| resolved.contains(f))
}

/// Folders that may be browsed but never modified: drive roots and the system trees.
fn is_protected(path: &str) -> bool {
    let norm = lower(&normalize(path)).replace('\\', "/");
    let clean = norm.trim_end_matches('/');
    if clean.len() <= 2 || (clean.len() == 3 && clean.ends_with(":/")) {
        return true;
    }
    for root in ["c:/windows", "c:/program files", "c:/program files (x86)", "c:/users"] {
        if clean == root || clean.starts_with(&format!("{}/", root)) {
            if root == "c:/users" {
                // C:\Users and C:\Users\<name> themselves are protected; folders inside a profile are not.
                if clean.split('/').count() <= 3 {
                    return true;
                }
                continue;
            }
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn drives() -> Vec<Value> {
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| {
            let letter = (b'A' + i) as char;
            if is_mounted_drive(letter) {
                return None;
            }
            let root: Vec<u16> = format!("{}:\\", letter).encode_utf16().chain(std::iter::once(0)).collect();
            let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
            if kind != DRIVE_FIXED && kind != DRIVE_REMOVABLE {
                return None;
            }
            let (mut free, mut total, mut total_free) = (0u64, 0u64, 0u64);
            unsafe { GetDiskFreeSpaceExW(root.as_ptr(), &mut free, &mut total, &mut total_free) };
            Some(json!({ "name": format!("{}:", letter), "path": format!("{}:\\", letter), "totalSpace": total, "freeSpace": free }))
        })
        .collect()
}

#[cfg(not(windows))]
fn drives() -> Vec<Value> {
    vec![json!({ "name": "/", "path": "/", "totalSpace": 0, "freeSpace": 0 })]
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn s<'a>(body: &'a Value, key: &str) -> &'a str {
    body.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

fn number(body: &Value, key: &str) -> u64 {
    body.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// What an action produced: reply fields for metadata, raw bytes for reads and thumbnails.
enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

/// One page of a folder: entries sorted by name, so pages line up across requests, and only the
/// page's entries have their metadata read. `limit` 0 means the rest of the folder.
fn read_dir_page(path: &str, offset: usize, limit: usize) -> std::io::Result<Value> {
    let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    let start = offset.min(entries.len());
    let end = if limit == 0 { entries.len() } else { start.saturating_add(limit).min(entries.len()) };
    let files: Vec<Value> = entries[start..end]
        .iter()
        .map(|e| {
            let meta = e.metadata().ok();
            json!({
                "name": e.file_name().to_string_lossy(),
                "isDirectory": meta.as_ref().is_some_and(|m| m.is_dir()),
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "mtime": meta.map(|m| millis(m.modified())).unwrap_or(0),
            })
        })
        .collect();
    Ok(json!({ "files": files, "hasMore": end < entries.len() }))
}

/// Runs one file-system action. `data` is a write's bytes. Blocking I/O: call from a blocking thread.
fn run(body: &Value, data: &[u8]) -> Result<Reply, String> {
    let action = s(body, "action");
    let path = s(body, "path");
    let new_path = s(body, "newPath");
    if (!path.is_empty() && is_sensitive(path)) || (!new_path.is_empty() && is_sensitive(new_path)) {
        return Err("Access Denied: Path contains system-sensitive or credential data.".into());
    }
    if is_on_mounted_drive(path) || is_on_mounted_drive(new_path) {
        return Err("Access Denied: This drive is another device's storage.".into());
    }
    let io = |e: std::io::Error| e.to_string();
    let done = || Ok(Reply::Json(json!({})));

    match action {
        "listRoots" => Ok(Reply::Json(json!({ "roots": drives() }))),
        "readdir" => read_dir_page(path, number(body, "offset") as usize, number(body, "limit") as usize).map(Reply::Json).map_err(io),
        "stat" => {
            let meta = std::fs::metadata(path).map_err(io)?;
            Ok(Reply::Json(json!({
                "name": Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "isDirectory": meta.is_dir(),
                "size": meta.len(),
                "mtime": millis(meta.modified()),
            })))
        }
        "read" => {
            let length = (number(body, "length") as usize).min(MAX_READ);
            let mut file = std::fs::File::open(path).map_err(io)?;
            file.seek(SeekFrom::Start(number(body, "offset"))).map_err(io)?;
            let mut buf = vec![0u8; length];
            let mut filled = 0;
            while filled < length {
                match file.read(&mut buf[filled..]).map_err(io)? {
                    0 => break,
                    n => filled += n,
                }
            }
            buf.truncate(filled);
            Ok(Reply::Bytes(buf))
        }
        "thumbnail" => {
            let max = number(body, "max").clamp(64, 4096) as u32;
            let quality = body.get("quality").and_then(|v| v.as_u64()).unwrap_or(70).clamp(30, 95) as u8;
            crate::core::photos::thumbnail_jpeg(Path::new(path), max, quality).map(Reply::Bytes)
        }
        "create" => {
            if body.get("isDirectory").and_then(|v| v.as_bool()).unwrap_or(false) {
                std::fs::create_dir_all(path).map_err(io)?;
            } else {
                std::fs::write(path, b"").map_err(io)?;
            }
            done()
        }
        "delete" => {
            if is_protected(path) {
                return Err("Access Denied: Deletion of protected Windows system directory is blocked.".into());
            }
            let target = Path::new(path);
            if target.is_dir() {
                std::fs::remove_dir_all(target).map_err(io)?;
            } else if target.exists() {
                std::fs::remove_file(target).map_err(io)?;
            }
            done()
        }
        "rename" => {
            if is_protected(path) || (!new_path.is_empty() && is_protected(new_path)) {
                return Err("Access Denied: Moving or renaming Windows system directory is blocked.".into());
            }
            std::fs::rename(path, new_path).map_err(io)?;
            done()
        }
        "write" => {
            if is_protected(path) {
                return Err("Access Denied: Writing to protected Windows system directory is blocked.".into());
            }
            let mut file = std::fs::OpenOptions::new().write(true).open(path).map_err(io)?;
            file.seek(SeekFrom::Start(number(body, "offset"))).map_err(io)?;
            file.write_all(data).map_err(io)?;
            done()
        }
        other => Err(format!("Unknown action: {}", other)),
    }
}

// ---- link.fs.request: where to connect ----

/// Answers one link.fs.request packet ({ action: "open" } -> { port }). The caller spawns this.
pub async fn handle_request(manager: Arc<DeviceManager>, device_id: String, body: Value) -> Value {
    let request_id = body.get("requestId").cloned().unwrap_or(Value::Null);
    let outcome = if !manager.allowed(&device_id, "fileaccess") {
        Err("Permission denied: File access is disabled.".to_string())
    } else if s(&body, "action") == "open" {
        server_port(&manager, &device_id).await.map(|port| json!({ "port": port }))
    } else {
        Err(format!("Unknown file-system request: {}", s(&body, "action")))
    };
    match outcome {
        Ok(result) => json!({ "requestId": request_id, "success": true, "result": result }),
        Err(error) => json!({ "requestId": request_id, "success": false, "error": error }),
    }
}

// ---- The file server ----

const MAX_HEADER: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 32;
// Requests one connection runs at once; the client keeps a few chunks in flight on its bulk connection.
const MAX_IN_FLIGHT: usize = 8;
// Thumbnails decode whole images; this many at once across all connections bounds the memory.
static THUMBNAILS: Semaphore = Semaphore::const_new(3);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

static SERVER_PORT: tokio::sync::Mutex<Option<u16>> = tokio::sync::Mutex::const_new(None);
// Pinned certificate fingerprint -> device id, for the devices that asked where to connect.
static PEERS: LazyLock<std::sync::Mutex<HashMap<String, String>>> = LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Port of the file server, started on first use. Registers `device_id` as allowed to connect.
async fn server_port(manager: &Arc<DeviceManager>, device_id: &str) -> Result<u16, String> {
    let (_, pinned) = manager.peer_endpoint(device_id).await.ok_or_else(|| "Device is not connected".to_string())?;
    if let Ok(mut peers) = PEERS.lock() {
        peers.retain(|_, id| id != device_id);
        peers.insert(pinned, device_id.to_string());
    }
    let mut port = SERVER_PORT.lock().await;
    if let Some(port) = *port {
        return Ok(port);
    }
    let listener = TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    let manager = manager.clone();
    tokio::spawn(async move {
        let open = Arc::new(AtomicUsize::new(0));
        while let Ok((stream, _)) = listener.accept().await {
            // Unauthenticated sockets are capped so a flood cannot pile up handshakes.
            if open.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                continue;
            }
            open.fetch_add(1, Ordering::SeqCst);
            let (manager, open) = (manager.clone(), open.clone());
            tokio::spawn(async move {
                serve(manager, stream).await;
                open.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    *port = Some(bound);
    Ok(bound)
}

/// Splits a binary request into its JSON header and payload.
fn split_frame(frame: &[u8]) -> Option<(Value, &[u8])> {
    let len = u32::from_be_bytes(frame.get(..4)?.try_into().ok()?) as usize;
    if len > MAX_HEADER {
        return None;
    }
    let header = serde_json::from_slice(frame.get(4..4 + len)?).ok()?;
    Some((header, &frame[4 + len..]))
}

fn binary_reply(header: &Value, data: &[u8]) -> Message {
    let head = header.to_string().into_bytes();
    let mut frame = Vec::with_capacity(4 + head.len() + data.len());
    frame.extend_from_slice(&(head.len() as u32).to_be_bytes());
    frame.extend_from_slice(&head);
    frame.extend_from_slice(data);
    Message::Binary(frame.into())
}

/// The message answering request `id` with `outcome`.
fn reply_message(id: Value, outcome: Result<Reply, String>) -> Message {
    match outcome {
        Ok(Reply::Bytes(bytes)) => binary_reply(&json!({ "id": id, "success": true }), &bytes),
        Ok(Reply::Json(fields)) => {
            let mut reply = json!({ "id": id, "success": true });
            if let (Some(out), Value::Object(fields)) = (reply.as_object_mut(), fields) {
                out.extend(fields);
            }
            Message::Text(reply.to_string().into())
        }
        Err(error) => Message::Text(json!({ "id": id, "success": false, "error": error }).to_string().into()),
    }
}

async fn serve(manager: Arc<DeviceManager>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let Ok(Ok(tls)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, manager.tls_acceptor().accept(stream)).await else { return };
    let Some(presented) = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| hex::encode(Sha256::digest(c.as_ref()))) else { return };
    let Some(device_id) = PEERS.lock().ok().and_then(|p| p.get(&presented).cloned()) else { return };
    // Still connected, and still paired with this same certificate.
    if manager.peer_endpoint(&device_id).await.map(|(_, pinned)| pinned) != Some(presented) {
        return;
    }
    let config = WebSocketConfig::default().max_message_size(Some(MAX_HEADER + 2 * MAX_READ)).max_frame_size(Some(MAX_HEADER + 2 * MAX_READ));
    let Ok(Ok(socket)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::accept_async_with_config(tls, Some(config))).await else { return };

    let (mut sink, mut source) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(MAX_IN_FLIGHT * 2);
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let slots = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
    // Only requests count as activity: the client's keep-alive pings would hold an unused connection open forever.
    let mut deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;
    loop {
        let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, source.next()).await else { break };
        let (header, data, offset) = match message {
            Message::Text(text) => match serde_json::from_str::<Value>(text.as_str()) {
                Ok(header) => (header, Default::default(), 0usize),
                Err(_) => continue,
            },
            Message::Binary(frame) => match split_frame(&frame) {
                Some((header, data)) => {
                    let offset = frame.len() - data.len();
                    (header, frame, offset)
                }
                None => continue,
            },
            Message::Close(_) => break,
            _ => continue,
        };
        deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;
        let Ok(slot) = slots.clone().acquire_owned().await else { break };
        let (manager, device_id, tx) = (manager.clone(), device_id.clone(), tx.clone());
        tokio::spawn(async move {
            let id = header.get("id").cloned().unwrap_or(Value::Null);
            let outcome = if !manager.allowed(&device_id, "fileaccess") || manager.is_blocked(&device_id) {
                Err("Permission denied: File access is disabled.".to_string())
            } else {
                let _decoding = match s(&header, "action") {
                    "thumbnail" => THUMBNAILS.acquire().await.ok(),
                    _ => None,
                };
                tokio::task::spawn_blocking(move || run(&header, &data[offset..])).await.unwrap_or_else(|e| Err(e.to_string()))
            };
            let _ = tx.send(reply_message(id, outcome)).await;
            drop(slot);
        });
    }
    drop(tx);
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("link-fs-server-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn frames_split_into_header_and_data() {
        let Message::Binary(frame) = binary_reply(&json!({ "action": "write", "path": "x" }), &[1, 2, 3]) else { panic!("binary") };
        let (header, data) = split_frame(&frame).unwrap();
        assert_eq!((header["action"].as_str(), data), (Some("write"), &[1u8, 2, 3][..]));
        assert!(split_frame(&[0, 0]).is_none());
        assert!(split_frame(&[0, 0, 0, 9, b'{']).is_none());
    }

    #[test]
    fn reads_and_writes_raw_bytes() {
        let dir = temp_dir("rw");
        let file = dir.join("data.bin");
        let path = file.to_string_lossy().to_string();
        std::fs::write(&file, b"").unwrap();
        run(&json!({ "action": "write", "path": path, "offset": 0 }), &[9u8, 8, 7, 6]).unwrap();
        match run(&json!({ "action": "read", "path": path, "offset": 1, "length": 10 }), &[]).unwrap() {
            Reply::Bytes(bytes) => assert_eq!(bytes, vec![8, 7, 6]),
            Reply::Json(_) => panic!("read must return bytes"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pages_a_folder_in_name_order() {
        let dir = temp_dir("page");
        for name in ["c.txt", "a.txt", "b.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let path = dir.to_string_lossy().to_string();
        let first = read_dir_page(&path, 0, 2).unwrap();
        let names = |page: &Value| page["files"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!((names(&first), first["hasMore"].as_bool()), (vec!["a.txt".to_string(), "b.txt".to_string()], Some(true)));
        let rest = read_dir_page(&path, 2, 2).unwrap();
        assert_eq!((names(&rest), rest["hasMore"].as_bool()), (vec!["c.txt".to_string()], Some(false)));
        assert_eq!(read_dir_page(&path, 0, 0).unwrap()["files"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replies_carry_the_id_and_fields() {
        let Message::Text(text) = reply_message(json!("r1"), Ok(Reply::Json(json!({ "roots": [] })))) else { panic!("text") };
        let reply: Value = serde_json::from_str(text.as_str()).unwrap();
        assert_eq!((reply["id"].as_str(), reply["success"].as_bool(), reply["roots"].is_array()), (Some("r1"), Some(true), true));
        let Message::Text(text) = reply_message(json!("r2"), Err("nope".into())) else { panic!("text") };
        assert!(text.as_str().contains("\"success\":false"));
    }
}
