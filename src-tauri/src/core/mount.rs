use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};

use crate::core::transport::DeviceManager;

// Mounts a paired phone's storage as a Windows drive letter. The WinFsp driver (built from
// native/link-fs-driver into vendor/link-fs-driver) exposes the drive to Explorer and turns every
// file operation into an HTTP call against the loopback API served here, which forwards it to the
// phone over the file-system channel (core/fs_client.rs). The API is token-protected and bound to
// 127.0.0.1 only.

const DRIVER_EXE: &str = "link-fs-driver.exe";
const READY_MARKER: &str = "LINK_FS_DRIVER_READY";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const DRIVE_LETTERS: &str = "ZYXWVUTSRQPONMLKJIHGFED";

pub struct MountService {
    pub drive_letter: String,
    child: Option<Child>,
    api: tokio::task::AbortHandle,
}

impl MountService {
    fn teardown(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
        self.api.abort();
        crate::core::fs_server::show_drive(&self.drive_letter);
        hidden("net", &["use", &self.drive_letter, "/delete", "/y"]);
        clear_drive_label(&self.drive_letter);
    }
}

impl Drop for MountService {
    fn drop(&mut self) {
        self.teardown();
    }
}

#[cfg(windows)]
fn hidden(program: &str, args: &[&str]) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new(program).args(args).creation_flags(0x0800_0000).spawn();
}

#[cfg(not(windows))]
fn hidden(_program: &str, _args: &[&str]) {}

/// Makes the driver die with the app. `kill_on_drop` never runs when the app is killed outright
/// (a stopped dev server, a crash), and an orphaned driver keeps its drive letter alive, so every
/// restart would then mount the same phone again on the next free letter.
#[cfg(windows)]
fn tie_to_app_lifetime(child: &Child) {
    use std::ffi::c_void;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    // SAFETY: plain Win32 calls; the job handle is deliberately never closed, so it lives exactly
    // as long as this process and closing it (process exit) kills everything assigned to it.
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as *const c_void, std::mem::size_of_val(&limits) as u32);
        job as usize
    });
    if let Some(process) = child.raw_handle() {
        // SAFETY: both handles are live.
        unsafe { AssignProcessToJobObject(job as _, process as _) };
    }
}

fn drive_icon_key(letter: &str) -> String {
    format!("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons\\{}", letter.trim_end_matches(':'))
}

fn set_drive_label(letter: &str, label: &str) {
    hidden("reg", &["add", &format!("{}\\DefaultLabel", drive_icon_key(letter)), "/ve", "/d", label, "/f"]);
}

fn clear_drive_label(letter: &str) {
    hidden("reg", &["delete", &drive_icon_key(letter), "/f"]);
}

fn winfsp_installed() -> bool {
    ["ProgramFiles(x86)", "ProgramFiles"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .any(|dir| std::path::Path::new(&dir).join("WinFsp").join("bin").join("winfsp-x64.dll").exists())
}

fn find_driver(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("vendor").join("link-fs-driver").join(DRIVER_EXE));
        candidates.push(resources.join(DRIVER_EXE));
    }
    // Development: run from the source tree.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("link-fs-driver").join(DRIVER_EXE));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("vendor").join("link-fs-driver").join(DRIVER_EXE));
        candidates.push(cwd.join("..").join("vendor").join("link-fs-driver").join(DRIVER_EXE));
    }
    candidates.into_iter().find(|p| p.exists())
}

// ---- loopback HTTP API used by the driver ----

// Largest request body accepted. The driver uploads writes in 4 MB chunks (WriteChunkSize in
// native/link-fs-driver/LinkFileSystem.cs), and one oversized write call can push a chunk past
// that, so this leaves room above it.
const MAX_BODY: usize = 16 * 1024 * 1024;

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: Vec<u8>,
}

enum Incoming {
    Request(Request),
    Forbidden,
    TooLarge,
}

fn decode(value: &str) -> String {
    urlencoding::decode(&value.replace('+', " ")).map(|c| c.into_owned()).unwrap_or_default()
}

/// Compares secrets in time that depends only on their length, so a caller cannot find a token
/// byte by byte from response times.
pub(crate) fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && std::hint::black_box(a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y))) == 0
}

/// Reads one request. The token is checked, and the body size bounded, before any body is read.
async fn read_request(reader: &mut BufReader<TcpStream>, expected_token: &str) -> Option<Incoming> {
    let mut line = String::new();
    if reader.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let (mut length, mut token) = (0usize, None);
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await.ok()? == 0 {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            match name.trim().to_lowercase().as_str() {
                "content-length" => length = value.trim().parse().unwrap_or(0),
                "x-link-token" => token = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    if !token.is_some_and(|t| same_secret(t.as_bytes(), expected_token.as_bytes())) {
        return Some(Incoming::Forbidden);
    }
    if length > MAX_BODY {
        return Some(Incoming::TooLarge);
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await.ok()?;

    let (path, query_string) = target.split_once('?').unwrap_or((&target, ""));
    let query = query_string
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_string(), decode(v)))
        .collect();
    Some(Incoming::Request(Request { method, path: path.to_string(), query, body }))
}

async fn respond(stream: &mut BufReader<TcpStream>, status: &str, content_type: &str, body: &[u8]) -> bool {
    let head = format!("HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n", status, content_type, body.len());
    let out = stream.get_mut();
    out.write_all(head.as_bytes()).await.is_ok() && out.write_all(body).await.is_ok()
}

fn not_found(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("not found") || lower.contains("access denied")
}

/// The entries of a whole-folder readdir reply.
fn listing_entries(mut reply: Value) -> Value {
    reply.get_mut("files").map(Value::take).filter(Value::is_array).unwrap_or_else(|| json!([]))
}

async fn route(manager: &DeviceManager, device_id: &str, roots: &Value, req: &Request) -> Result<(String, String, Vec<u8>), String> {
    let path = req.query.get("path").cloned().unwrap_or_default();
    let number = |key: &str| req.query.get(key).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let json_body = || serde_json::from_slice::<Value>(&req.body).map_err(|e| e.to_string());
    let ok = |value: Value| Ok(("200 OK".to_string(), "application/json".to_string(), value.to_string().into_bytes()));

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/roots") => ok(roots.clone()),
        ("GET", "/stat") => ok(manager.fs_request(device_id, "stat", json!({ "path": path })).await?),
        ("GET", "/readdir") => ok(listing_entries(manager.fs_request(device_id, "readdir", json!({ "path": path })).await?)),
        ("GET", "/read") => {
            let bytes = manager.fs_read(device_id, &path, number("offset"), number("length")).await?;
            Ok(("200 OK".into(), "application/octet-stream".into(), bytes))
        }
        ("POST", "/write") => {
            manager.fs_write(device_id, &path, number("offset"), &req.body).await?;
            ok(json!({ "ok": true }))
        }
        ("POST", "/create") => {
            let body = json_body()?;
            manager.fs_request(device_id, "create", json!({ "path": body["path"], "isDirectory": body["isDirectory"] })).await?;
            ok(json!({ "ok": true }))
        }
        ("POST", "/delete") => {
            let body = json_body()?;
            manager.fs_request(device_id, "delete", json!({ "path": body["path"] })).await?;
            ok(json!({ "ok": true }))
        }
        ("POST", "/rename") => {
            let body = json_body()?;
            manager.fs_request(device_id, "rename", json!({ "path": body["path"], "newPath": body["newPath"] })).await?;
            ok(json!({ "ok": true }))
        }
        _ => Ok(("404 Not Found".into(), "text/plain".into(), Vec::new())),
    }
}

async fn serve_connection(manager: Arc<DeviceManager>, device_id: String, token: String, roots: Value, stream: TcpStream) {
    let mut reader = BufReader::new(stream);
    while let Some(incoming) = read_request(&mut reader, &token).await {
        // An unread body leaves the stream out of step, so both refusals end the connection.
        let request = match incoming {
            Incoming::Request(request) => request,
            Incoming::Forbidden => {
                respond(&mut reader, "403 Forbidden", "text/plain", b"").await;
                return;
            }
            Incoming::TooLarge => {
                respond(&mut reader, "413 Payload Too Large", "text/plain", b"").await;
                return;
            }
        };
        let sent = match route(&manager, &device_id, &roots, &request).await {
            Ok((status, content_type, body)) => respond(&mut reader, &status, &content_type, &body).await,
            Err(error) if not_found(&error) => respond(&mut reader, "404 Not Found", "application/json", br#"{"error":"Not found"}"#).await,
            Err(error) => {
                log::warn!("Mount API {} {} failed: {}", request.method, request.path, error);
                respond(&mut reader, "500 Internal Server Error", "application/json", json!({ "error": error }).to_string().as_bytes()).await
            }
        };
        if !sent {
            return;
        }
    }
}

// ---- mounting ----

impl DeviceManager {
    fn drive_in_use(&self, letter: &str, mounts: &HashMap<String, MountService>) -> bool {
        std::path::Path::new(&format!("{}\\", letter)).exists() || mounts.values().any(|m| m.drive_letter == letter)
    }

    fn setting_map(&self, key: &str) -> serde_json::Map<String, Value> {
        self.settings.lock().ok().and_then(|s| s.get_value(key)).and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }

    fn save_setting_map(&self, key: &str, map: serde_json::Map<String, Value>) {
        if let Ok(mut settings) = self.settings.lock() {
            settings.set_value(key, Value::Object(map));
        }
    }

    /// Whether this device's storage should be mounted as a drive whenever it allows file access. On by
    /// default; unmounting it from the app records `false`, which is then kept.
    pub fn mount_enabled(&self, device_id: &str) -> bool {
        self.setting_map("device_mount_enabled").get(device_id).and_then(|v| v.as_bool()).unwrap_or(true)
    }

    pub fn set_mount_enabled(&self, device_id: &str, enabled: bool) {
        let mut map = self.setting_map("device_mount_enabled");
        map.insert(device_id.to_string(), Value::Bool(enabled));
        self.save_setting_map("device_mount_enabled", map);
    }

    pub async fn mounted_letter(&self, device_id: &str) -> Option<String> {
        self.mounts.lock().await.get(device_id).map(|m| m.drive_letter.clone())
    }

    async fn announce_mount(&self, device_id: &str, letter: Option<&str>) {
        if let Some(app) = self.app_handle().await {
            let _ = app.emit("device-mount-changed", json!({ "deviceId": device_id, "driveLetter": letter }));
        }
    }

    /// Mounts a paired phone's storage on a drive letter (its preferred one if free, else the
    /// first unused from Z down). Records the intent so the mount returns after a reconnect.
    pub async fn mount_device(self: &Arc<Self>, device_id: &str) -> Result<String, String> {
        // Connect-time auto-mount, reconnects and the UI can all ask at once; without this each
        // sees "not mounted yet" and the same phone ends up on two drive letters.
        static MOUNTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _one_at_a_time = MOUNTING.lock().await;
        if let Some(existing) = self.mounted_letter(device_id).await {
            return Ok(existing);
        }
        if !cfg!(windows) {
            return Err("Mounting a drive is only available on Windows.".into());
        }
        if !winfsp_installed() {
            return Err("WinFsp is not installed. Install it from the vendor/winfsp folder (or winfsp.dev) and try again.".into());
        }
        let app = self.app_handle().await.ok_or("Application is not ready")?;
        let driver = find_driver(&app).ok_or("link-fs-driver.exe was not found")?;
        let (name, _kind) = {
            let peer = self.connected_peers().await.into_iter().find(|p| p["deviceId"].as_str() == Some(device_id)).ok_or("Device is offline or unreachable")?;
            (peer["deviceName"].as_str().unwrap_or("Device").to_string(), peer["deviceType"].as_str().unwrap_or("phone").to_string())
        };

        let roots = self.fs_request(device_id, "listRoots", json!({})).await?;
        let roots: Vec<Value> = roots
            .get("roots")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|r| json!({ "name": r["name"], "path": r["path"], "totalSpace": r["totalSpace"].as_u64().unwrap_or(0), "freeSpace": r["freeSpace"].as_u64().unwrap_or(0) }))
            .collect();
        let roots = Value::Array(roots);

        let letter = {
            let mounts = self.mounts.lock().await;
            let preferred = self.setting_map("device_drive_letters").get(device_id).and_then(|v| v.as_str().map(str::to_string));
            preferred
                .filter(|l| !self.drive_in_use(l, &mounts))
                .or_else(|| DRIVE_LETTERS.chars().map(|c| format!("{}:", c)).find(|l| !self.drive_in_use(l, &mounts)))
                .unwrap_or_else(|| "Z:".to_string())
        };

        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let api = {
            let (manager, device_id, token, roots) = (self.clone(), device_id.to_string(), token.clone(), roots.clone());
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(serve_connection(manager.clone(), device_id.clone(), token.clone(), roots.clone(), stream));
                }
            })
            .abort_handle()
        };

        let label = format!("{} (Link)", name);
        let spawned = Self::spawn_driver(&driver, &letter, &label, port, &token).await;
        let child = match spawned {
            Ok(child) => child,
            Err(error) => {
                api.abort();
                return Err(error);
            }
        };
        set_drive_label(&letter, &label);
        crate::core::fs_server::hide_drive(&letter);
        self.mounts.lock().await.insert(device_id.to_string(), MountService { drive_letter: letter.clone(), child: Some(child), api });
        self.announce_mount(device_id, Some(&letter)).await;
        Ok(letter)
    }

    async fn spawn_driver(driver: &PathBuf, letter: &str, label: &str, port: u16, token: &str) -> Result<Child, String> {
        let mut command = Command::new(driver);
        command
            .args(["--drive-letter", letter, "--volume-label", label, "--api-port", &port.to_string(), "--api-token", token])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().map_err(|e| format!("Could not start the drive driver: {}", e))?;
        #[cfg(windows)]
        tie_to_app_lifetime(&child);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (ready_tx, mut ready_rx) = tokio::sync::mpsc::channel::<()>(2);
        for stream in [stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
            let ready = ready_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!("[WinFSP driver] {}", line);
                    if line.contains(READY_MARKER) {
                        let _ = ready.send(()).await;
                    }
                }
            });
        }
        drop(ready_tx);

        tokio::select! {
            _ = ready_rx.recv() => Ok(child),
            exited = child.wait() => Err(format!("The drive driver exited early ({})", exited.map(|s| s.to_string()).unwrap_or_default())),
            // Without the ready marker, assume the driver is up once the timeout passes.
            _ = tokio::time::sleep(READY_TIMEOUT) => Ok(child),
        }
    }

    pub async fn unmount_device(&self, device_id: &str) {
        let removed = self.mounts.lock().await.remove(device_id);
        if removed.is_some() {
            // Dropping the service kills the driver and removes the drive label.
            drop(removed);
            self.announce_mount(device_id, None).await;
        }
        self.drop_fs_clients(device_id).await;
    }

    /// The user's own choice of letter for a device; remounts at once if it is mounted now.
    pub async fn set_drive_letter(self: &Arc<Self>, device_id: &str, letter: &str) {
        let mut map = self.setting_map("device_drive_letters");
        if letter.is_empty() {
            map.remove(device_id);
        } else {
            map.insert(device_id.to_string(), Value::String(letter.to_string()));
        }
        self.save_setting_map("device_drive_letters", map);
        if self.mounted_letter(device_id).await.is_some() {
            self.unmount_device(device_id).await;
            if let Err(error) = self.mount_device(device_id).await {
                log::warn!("Remount after drive letter change failed: {}", error);
            }
        }
    }

    pub async fn mount_config(&self, device_id: &str) -> Value {
        let letters: Vec<String> = DRIVE_LETTERS.chars().map(|c| format!("{}:", c)).collect();
        let preferred = self.setting_map("device_drive_letters");
        let mounts = self.mounts.lock().await;
        let occupied: Vec<&String> = letters
            .iter()
            .filter(|l| {
                std::path::Path::new(&format!("{}\\", l)).exists()
                    || preferred.iter().any(|(id, v)| id != device_id && v.as_str() == Some(l.as_str()))
                    || mounts.iter().any(|(id, m)| id != device_id && &m.drive_letter == *l)
            })
            .collect();
        json!({
            "preferredDriveLetter": preferred.get(device_id).and_then(|v| v.as_str()).unwrap_or(""),
            "occupiedLetters": occupied,
            "letters": letters,
        })
    }

    /// A peer's capabilities changed: drop the drive when file access is revoked, bring it back
    /// when it is granted again and the user wanted it mounted.
    pub async fn on_file_access_changed(self: &Arc<Self>, device_id: &str, allowed: bool) {
        if !allowed {
            self.unmount_device(device_id).await;
        } else if self.mount_enabled(device_id) {
            if let Err(error) = self.mount_device(device_id).await {
                log::warn!("Automatic mount of {} failed: {}", device_id, error);
            }
        }
    }
}
