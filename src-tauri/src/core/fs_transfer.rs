use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::core::transport::DeviceManager;

// Download, upload and open-from-peer for the file explorer, built on the FsClient request
// channel. Large files move in 4 MB chunks with several requests in flight, so a high-latency
// link isn't paced by one round trip per chunk.

const CHUNK: u64 = 4 * 1024 * 1024;
const CONCURRENCY: usize = 4;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct Transfers {
    cancels: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

struct Progress {
    id: String,
    direction: &'static str,
    device_id: String,
    path: String,
    total: u64,
    transferred: u64,
    last_emit: Instant,
    app: Option<tauri::AppHandle>,
    cancelled: Arc<AtomicBool>,
}

impl Progress {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("Transfer cancelled".into())
        } else {
            Ok(())
        }
    }

    fn advance(&mut self, bytes: u64, force: bool) {
        self.transferred += bytes;
        if !force && self.last_emit.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        self.last_emit = Instant::now();
        if let Some(app) = &self.app {
            let _ = app.emit(
                "fs-transfer-progress",
                json!({
                    "transferId": self.id, "direction": self.direction, "deviceId": self.device_id,
                    "path": self.path, "transferred": self.transferred, "total": self.total,
                }),
            );
        }
    }
}

fn join_remote(parent: &str, name: &str) -> String {
    if parent.ends_with('/') || parent.ends_with('\\') {
        format!("{}{}", parent, name)
    } else {
        format!("{}/{}", parent, name)
    }
}

fn entries(listing: &Value) -> Vec<Value> {
    ["files", "entries", "result"].iter().find_map(|k| listing.get(k).and_then(|v| v.as_array()).cloned()).unwrap_or_default()
}

impl DeviceManager {
    /// Reads `length` bytes at `offset` from a file on the peer.
    pub async fn fs_read(&self, device_id: &str, path: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let reply = self.fs_request(device_id, "read", json!({ "path": path, "offset": offset, "length": length })).await?;
        let res = reply.get("result").unwrap_or(&reply);
        if let Some(encoded) = reply.get("dataBase64").or_else(|| res.get("dataBase64")).and_then(|v| v.as_str()) {
            return base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| e.to_string());
        }
        let buf = if res.get("data").is_some() { res } else { res.get("buffer").unwrap_or(res) };
        if let Some(arr) = buf.get("data").and_then(|d| d.as_array()) {
            return Ok(arr.iter().filter_map(|b| b.as_u64().map(|b| b as u8)).collect());
        }
        Err("Expected binary or buffer data in read response".into())
    }

    pub async fn fs_stat(&self, device_id: &str, path: &str) -> Result<(bool, u64), String> {
        let reply = self.fs_request(device_id, "stat", json!({ "path": path })).await?;
        let stat = reply.get("result").unwrap_or(&reply);
        Ok((stat["isDirectory"].as_bool().unwrap_or(false), stat["size"].as_u64().unwrap_or(0)))
    }

    fn begin_transfer(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.transfers.cancels.lock() {
            map.insert(id.to_string(), flag.clone());
        }
        flag
    }

    fn end_transfer(&self, id: &str) {
        if let Ok(mut map) = self.transfers.cancels.lock() {
            map.remove(id);
        }
    }

    pub fn cancel_transfer(&self, id: &str) -> bool {
        match self.transfers.cancels.lock().ok().and_then(|mut m| m.remove(id)) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    async fn new_progress(&self, direction: &'static str, device_id: &str, path: &str, total: u64) -> Progress {
        let id = format!("transfer-{}-{}", chrono::Utc::now().timestamp_millis(), &uuid::Uuid::new_v4().simple().to_string()[..7]);
        let cancelled = self.begin_transfer(&id);
        Progress {
            id,
            direction,
            device_id: device_id.to_string(),
            path: path.to_string(),
            total,
            transferred: 0,
            last_emit: Instant::now() - PROGRESS_INTERVAL,
            app: self.app_handle().await,
            cancelled,
        }
    }

    async fn remote_size(&self, device_id: &str, path: &str) -> Result<u64, String> {
        let (is_dir, size) = self.fs_stat(device_id, path).await?;
        if !is_dir {
            return Ok(size);
        }
        let mut total = 0;
        for child in entries(&self.fs_request(device_id, "readdir", json!({ "path": path })).await?) {
            let name = child["name"].as_str().unwrap_or("");
            total += if child["isDirectory"].as_bool().unwrap_or(false) {
                Box::pin(self.remote_size(device_id, &join_remote(path, name))).await?
            } else {
                child["size"].as_u64().unwrap_or(0)
            };
        }
        Ok(total)
    }

    async fn download_file(&self, device_id: &str, remote: &str, local: &Path, size: u64, progress: &mut Progress) -> Result<(), String> {
        let mut file = std::fs::File::create(local).map_err(|e| e.to_string())?;
        let offsets: Vec<u64> = (0..size).step_by(CHUNK as usize).collect();
        let mut chunks = stream::iter(offsets.into_iter().map(|offset| {
            let length = CHUNK.min(size - offset);
            async move { (offset, self.fs_read(device_id, remote, offset, length).await) }
        }))
        .buffered(CONCURRENCY);
        while let Some((offset, chunk)) = chunks.next().await {
            progress.check()?;
            let bytes = chunk?;
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            progress.advance(bytes.len() as u64, false);
        }
        Ok(())
    }

    async fn download_dir(&self, device_id: &str, remote: &str, local: &Path, progress: &mut Progress) -> Result<(), String> {
        std::fs::create_dir_all(local).map_err(|e| e.to_string())?;
        for child in entries(&self.fs_request(device_id, "readdir", json!({ "path": remote })).await?) {
            progress.check()?;
            let name = child["name"].as_str().unwrap_or("").to_string();
            let (child_remote, child_local) = (join_remote(remote, &name), local.join(&name));
            if child["isDirectory"].as_bool().unwrap_or(false) {
                Box::pin(self.download_dir(device_id, &child_remote, &child_local, progress)).await?;
            } else {
                self.download_file(device_id, &child_remote, &child_local, child["size"].as_u64().unwrap_or(0), progress).await?;
            }
        }
        Ok(())
    }

    /// Downloads a file or a whole folder tree. For a folder, `local` is the directory to create.
    pub async fn fs_download(&self, device_id: &str, remote: &str, local: &str) -> Result<bool, String> {
        let (is_dir, size) = self.fs_stat(device_id, remote).await?;
        let total = if is_dir { self.remote_size(device_id, remote).await? } else { size };
        let mut progress = self.new_progress("download", device_id, remote, total).await;
        let result = if is_dir {
            self.download_dir(device_id, remote, Path::new(local), &mut progress).await
        } else {
            self.download_file(device_id, remote, Path::new(local), size, &mut progress).await
        };
        self.end_transfer(&progress.id);
        result?;
        progress.advance(0, true);
        Ok(true)
    }

    fn local_size(path: &Path) -> u64 {
        match std::fs::metadata(path) {
            Ok(m) if m.is_dir() => std::fs::read_dir(path).map(|d| d.filter_map(|e| e.ok()).map(|e| Self::local_size(&e.path())).sum()).unwrap_or(0),
            Ok(m) => m.len(),
            Err(_) => 0,
        }
    }

    async fn upload_item(&self, device_id: &str, local: &Path, remote_parent: &str, progress: &mut Progress) -> Result<(), String> {
        let name = local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let remote = join_remote(remote_parent, &name);
        if local.is_dir() {
            self.fs_request(device_id, "create", json!({ "path": remote, "isDirectory": true })).await?;
            let children: Vec<PathBuf> = std::fs::read_dir(local).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            for child in children {
                progress.check()?;
                Box::pin(self.upload_item(device_id, &child, &remote, progress)).await?;
            }
            return Ok(());
        }

        self.fs_request(device_id, "create", json!({ "path": remote, "isDirectory": false })).await?;
        let size = std::fs::metadata(local).map_err(|e| e.to_string())?.len();
        let mut file = std::fs::File::open(local).map_err(|e| e.to_string())?;
        // Chunks are read up front in order (cheap, sequential disk reads) and sent concurrently.
        let mut pending = Vec::new();
        let mut offset = 0u64;
        while offset < size {
            let length = CHUNK.min(size - offset) as usize;
            let mut buf = vec![0u8; length];
            file.read_exact(&mut buf).map_err(|e| e.to_string())?;
            pending.push((offset, buf));
            offset += length as u64;
        }
        let mut writes = stream::iter(pending.into_iter().map(|(offset, buf)| {
            let remote = remote.clone();
            async move {
                let length = buf.len() as u64;
                (length, self.fs_write(device_id, &remote, offset, buf).await)
            }
        }))
        .buffered(CONCURRENCY);
        while let Some((length, outcome)) = writes.next().await {
            progress.check()?;
            outcome?;
            progress.advance(length, false);
        }
        Ok(())
    }

    pub async fn fs_upload(&self, device_id: &str, local: &str, remote_parent: &str) -> Result<bool, String> {
        let local_path = Path::new(local);
        let mut progress = self.new_progress("upload", device_id, local, Self::local_size(local_path)).await;
        let result = self.upload_item(device_id, local_path, remote_parent, &mut progress).await;
        self.end_transfer(&progress.id);
        result?;
        progress.advance(0, true);
        Ok(true)
    }

    /// Fetches a document to a read-only temp copy and opens it with the system's default app.
    /// Read-only because the copy has no path back to the phone: an edit saved into it would
    /// otherwise be lost silently when temp is cleared.
    pub async fn fs_open_document(&self, device_id: &str, remote: &str) -> Result<bool, String> {
        let (is_dir, size) = self.fs_stat(device_id, remote).await?;
        if is_dir {
            return Err("Cannot open a directory".into());
        }
        let name = remote.replace('\\', "/").rsplit('/').next().unwrap_or("document").to_string();
        let dir = std::env::temp_dir().join(format!("link-doc-{}-{}", chrono::Utc::now().timestamp_millis(), &uuid::Uuid::new_v4().simple().to_string()[..6]));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let local = dir.join(name);

        let mut progress = self.new_progress("download", device_id, remote, size).await;
        let result = self.download_file(device_id, remote, &local, size, &mut progress).await;
        self.end_transfer(&progress.id);
        result?;
        progress.advance(0, true);

        if let Ok(meta) = std::fs::metadata(&local) {
            let mut permissions = meta.permissions();
            permissions.set_readonly(true);
            let _ = std::fs::set_permissions(&local, permissions);
        }
        open_with_default_app(&local.to_string_lossy())?;
        Ok(true)
    }
}

/// Hands a path or URL to whatever the OS has registered for it.
pub fn open_with_default_app(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    let spawned = std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(target).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}
