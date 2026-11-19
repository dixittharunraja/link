use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::core::transport::DeviceManager;

// Download, upload and open-from-peer for the file explorer, built on the FsClient request
// channel. Large files move in 4 MB chunks with several requests in flight, so a high-latency
// link isn't paced by one round trip per chunk, and a folder moves several files at once, so a
// tree of small files isn't paced by one round trip per file either.

const CHUNK: u64 = 4 * 1024 * 1024;
const CONCURRENCY: usize = 4;
// Files of one folder transfer in flight at once. Each still bounds its own chunks to CONCURRENCY.
const FILE_CONCURRENCY: usize = 4;
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

/// One file of a folder transfer. Boxed: the files run as a stream of futures, and naming the
/// type keeps the Send check on the Tauri command from tripping over the closures' lifetimes.
type Job<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;

/// Progress shared by the files of a folder that are in flight together.
type SharedProgress = Mutex<Progress>;

fn check(progress: &SharedProgress) -> Result<(), String> {
    progress.lock().unwrap_or_else(|e| e.into_inner()).check()
}

fn advance(progress: &SharedProgress, bytes: u64) {
    progress.lock().unwrap_or_else(|e| e.into_inner()).advance(bytes, false);
}

fn join_remote(parent: &str, name: &str) -> String {
    if parent.ends_with('/') || parent.ends_with('\\') {
        format!("{}{}", parent, name)
    } else {
        format!("{}/{}", parent, name)
    }
}

/// The entries of a whole-folder readdir reply (no `limit`, so it is one page).
fn entries(mut listing: Value) -> Vec<Value> {
    match listing.get_mut("files").map(Value::take) {
        Some(Value::Array(files)) => files,
        _ => Vec::new(),
    }
}

/// One item of a folder transfer, listed once up front: the walk gives both the total for the
/// progress bar and the work list, so no folder is listed twice.
struct Item {
    remote: String,
    local: PathBuf,
    is_dir: bool,
    size: u64,
}

/// Every file and folder under a local folder, parents before their children.
fn walk_local(dir: &Path, remote: &str, out: &mut Vec<Item>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let child_remote = join_remote(remote, &entry.file_name().to_string_lossy());
        if path.is_dir() {
            out.push(Item { remote: child_remote.clone(), local: path.clone(), is_dir: true, size: 0 });
            walk_local(&path, &child_remote, out)?;
        } else {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(Item { remote: child_remote, local: path, is_dir: false, size });
        }
    }
    Ok(())
}

impl DeviceManager {
    /// Reads `length` bytes at `offset` from a file on the peer.
    pub async fn fs_read(&self, device_id: &str, path: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let reply = self.fs_request_data(device_id, true, "read", json!({ "path": path, "offset": offset, "length": length })).await?;
        reply.data.ok_or_else(|| "The device sent no data for a read".to_string())
    }

    pub async fn fs_stat(&self, device_id: &str, path: &str) -> Result<(bool, u64), String> {
        let stat = self.fs_request(device_id, "stat", json!({ "path": path })).await?;
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

    async fn new_progress(&self, direction: &'static str, device_id: &str, path: &str, total: u64) -> SharedProgress {
        let id = format!("transfer-{}-{}", chrono::Utc::now().timestamp_millis(), &uuid::Uuid::new_v4().simple().to_string()[..7]);
        let cancelled = self.begin_transfer(&id);
        Mutex::new(Progress {
            id,
            direction,
            device_id: device_id.to_string(),
            path: path.to_string(),
            total,
            transferred: 0,
            last_emit: Instant::now() - PROGRESS_INTERVAL,
            app: self.app_handle().await,
            cancelled,
        })
    }

    /// Ends a transfer: forgets its cancel flag and, on success, sends the final progress event.
    fn finish(&self, progress: SharedProgress, result: Result<(), String>) -> Result<bool, String> {
        let mut progress = progress.into_inner().unwrap_or_else(|e| e.into_inner());
        self.end_transfer(&progress.id);
        result?;
        progress.advance(0, true);
        Ok(true)
    }

    /// Every file and folder under a remote folder, parents before their children.
    async fn walk_remote(&self, device_id: &str, remote: &str, local: &Path, out: &mut Vec<Item>) -> Result<(), String> {
        for child in entries(self.fs_request(device_id, "readdir", json!({ "path": remote })).await?) {
            let name = child["name"].as_str().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let (child_remote, child_local) = (join_remote(remote, &name), local.join(&name));
            if child["isDirectory"].as_bool().unwrap_or(false) {
                out.push(Item { remote: child_remote.clone(), local: child_local.clone(), is_dir: true, size: 0 });
                Box::pin(self.walk_remote(device_id, &child_remote, &child_local, out)).await?;
            } else {
                out.push(Item { remote: child_remote, local: child_local, is_dir: false, size: child["size"].as_u64().unwrap_or(0) });
            }
        }
        Ok(())
    }

    async fn download_file(&self, device_id: &str, remote: &str, local: &Path, size: u64, progress: &SharedProgress) -> Result<(), String> {
        // tokio::fs runs the writes on the blocking pool, off the runtime's worker threads.
        let mut file = tokio::fs::File::create(local).await.map_err(|e| e.to_string())?;
        let offsets: Vec<u64> = (0..size).step_by(CHUNK as usize).collect();
        let mut chunks = stream::iter(offsets.into_iter().map(|offset| {
            let length = CHUNK.min(size - offset);
            async move { (offset, self.fs_read(device_id, remote, offset, length).await) }
        }))
        .buffered(CONCURRENCY);
        while let Some((offset, chunk)) = chunks.next().await {
            check(progress)?;
            let bytes = chunk?;
            file.seek(SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
            advance(progress, bytes.len() as u64);
        }
        file.flush().await.map_err(|e| e.to_string())
    }

    /// Downloads a file or a whole folder tree. For a folder, `local` is the directory to create.
    pub async fn fs_download(&self, device_id: &str, remote: &str, local: &str) -> Result<bool, String> {
        let (is_dir, size) = self.fs_stat(device_id, remote).await?;
        if !is_dir {
            let progress = self.new_progress("download", device_id, remote, size).await;
            let result = self.download_file(device_id, remote, Path::new(local), size, &progress).await;
            return self.finish(progress, result);
        }

        let mut items = Vec::new();
        self.walk_remote(device_id, remote, Path::new(local), &mut items).await?;
        let total = items.iter().map(|i| i.size).sum();
        let progress = self.new_progress("download", device_id, remote, total).await;
        let result = async {
            tokio::fs::create_dir_all(local).await.map_err(|e| e.to_string())?;
            for dir in items.iter().filter(|i| i.is_dir) {
                tokio::fs::create_dir_all(&dir.local).await.map_err(|e| e.to_string())?;
            }
            let progress = &progress;
            let jobs: Vec<Job<'_>> = items
                .iter()
                .filter(|i| !i.is_dir)
                .map(|item| -> Job<'_> {
                    Box::pin(async move {
                        check(progress)?;
                        self.download_file(device_id, &item.remote, &item.local, item.size, progress).await
                    })
                })
                .collect();
            let mut files = stream::iter(jobs).buffer_unordered(FILE_CONCURRENCY);
            while let Some(outcome) = files.next().await {
                outcome?;
            }
            Ok(())
        }
        .await;
        self.finish(progress, result)
    }

    async fn upload_file(&self, device_id: &str, local: &Path, remote: &str, size: u64, progress: &SharedProgress) -> Result<(), String> {
        self.fs_request(device_id, "create", json!({ "path": remote, "isDirectory": false })).await?;
        let file = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
        // A bounded producer: the next chunk is read from disk only when a write slot frees up, so
        // at most CONCURRENCY + 1 chunks are in memory however large the file.
        let reads = stream::unfold((file, 0u64), move |(mut file, offset)| async move {
            if offset >= size {
                return None;
            }
            let length = CHUNK.min(size - offset) as usize;
            let mut buf = vec![0u8; length];
            let read = file.read_exact(&mut buf).await.map(|_| buf).map_err(|e| e.to_string());
            Some(((offset, read), (file, offset + length as u64)))
        });
        let mut writes = std::pin::pin!(reads
            .map(|(offset, read)| async move {
                let buf = read?;
                self.fs_write(device_id, remote, offset, &buf).await.map(|_| buf.len() as u64)
            })
            .buffered(CONCURRENCY));
        while let Some(outcome) = writes.next().await {
            check(progress)?;
            advance(progress, outcome?);
        }
        Ok(())
    }

    pub async fn fs_upload(&self, device_id: &str, local: &str, remote_parent: &str) -> Result<bool, String> {
        let local_path = PathBuf::from(local);
        let name = local_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let remote_root = join_remote(remote_parent, &name);
        let root = local_path.clone();
        let root_remote = remote_root.clone();
        let items = tokio::task::spawn_blocking(move || -> Result<Vec<Item>, String> {
            let meta = std::fs::metadata(&root).map_err(|e| e.to_string())?;
            let mut items = vec![Item { remote: root_remote.clone(), local: root.clone(), is_dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() } }];
            if meta.is_dir() {
                walk_local(&root, &root_remote, &mut items)?;
            }
            Ok(items)
        })
        .await
        .map_err(|e| e.to_string())??;

        let total = items.iter().map(|i| i.size).sum();
        let progress = self.new_progress("upload", device_id, local, total).await;
        let result = async {
            // Folders first, in walk order (parents before children), then the files several at a time.
            for dir in items.iter().filter(|i| i.is_dir) {
                check(&progress)?;
                self.fs_request(device_id, "create", json!({ "path": dir.remote, "isDirectory": true })).await?;
            }
            let progress = &progress;
            let jobs: Vec<Job<'_>> = items
                .iter()
                .filter(|i| !i.is_dir)
                .map(|item| -> Job<'_> {
                    Box::pin(async move {
                        check(progress)?;
                        self.upload_file(device_id, &item.local, &item.remote, item.size, progress).await
                    })
                })
                .collect();
            let mut files = stream::iter(jobs).buffer_unordered(FILE_CONCURRENCY);
            while let Some(outcome) = files.next().await {
                outcome?;
            }
            Ok(())
        }
        .await;
        self.finish(progress, result)
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

        let progress = self.new_progress("download", device_id, remote, size).await;
        let result = self.download_file(device_id, remote, &local, size, &progress).await;
        self.finish(progress, result)?;

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
