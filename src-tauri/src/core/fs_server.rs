use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

// Serves this PC's files to paired devices that hold the "fileaccess" permission, over the
// link.fs.request / link.fs.response packets. Same actions and result shapes as the Electron
// core; binary data travels as Node-style {"type":"Buffer","data":[bytes]} objects because the
// Android client parses exactly that.

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

fn buffer_json(bytes: &[u8]) -> Value {
    json!({ "type": "Buffer", "data": bytes })
}

fn bytes_of(buffer: &Value) -> Vec<u8> {
    buffer.get("data").and_then(|d| d.as_array()).map(|a| a.iter().filter_map(|b| b.as_u64().map(|b| b as u8)).collect()).unwrap_or_default()
}

fn s<'a>(body: &'a Value, key: &str) -> &'a str {
    body.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// Runs one file-system action. Blocking I/O: call from a blocking thread.
pub fn handle(body: &Value) -> Result<Value, String> {
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

    match action {
        "listRoots" => Ok(Value::Array(drives())),
        "readdir" => {
            let entries = std::fs::read_dir(path).map_err(io)?;
            let list: Vec<Value> = entries
                .filter_map(|e| e.ok())
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
            Ok(Value::Array(list))
        }
        "stat" => {
            let meta = std::fs::metadata(path).map_err(io)?;
            Ok(json!({
                "name": Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "isDirectory": meta.is_dir(),
                "size": meta.len(),
                "mtime": millis(meta.modified()),
            }))
        }
        "read" => {
            let offset = body.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let length = (body.get("length").and_then(|v| v.as_u64()).unwrap_or(0) as usize).min(MAX_READ);
            let mut file = std::fs::File::open(path).map_err(io)?;
            file.seek(SeekFrom::Start(offset)).map_err(io)?;
            let mut buf = vec![0u8; length];
            let mut filled = 0;
            while filled < length {
                match file.read(&mut buf[filled..]).map_err(io)? {
                    0 => break,
                    n => filled += n,
                }
            }
            buf.truncate(filled);
            Ok(buffer_json(&buf))
        }
        "create" => {
            if body.get("isDirectory").and_then(|v| v.as_bool()).unwrap_or(false) {
                std::fs::create_dir_all(path).map_err(io)?;
            } else {
                std::fs::write(path, b"").map_err(io)?;
            }
            Ok(Value::Bool(true))
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
            Ok(Value::Bool(true))
        }
        "rename" => {
            if is_protected(path) || (!new_path.is_empty() && is_protected(new_path)) {
                return Err("Access Denied: Moving or renaming Windows system directory is blocked.".into());
            }
            std::fs::rename(path, new_path).map_err(io)?;
            Ok(Value::Bool(true))
        }
        "write" => {
            if is_protected(path) {
                return Err("Access Denied: Writing to protected Windows system directory is blocked.".into());
            }
            let offset = body.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let data = bytes_of(body.get("buffer").unwrap_or(&Value::Null));
            let mut file = std::fs::OpenOptions::new().write(true).open(path).map_err(io)?;
            file.seek(SeekFrom::Start(offset)).map_err(io)?;
            file.write_all(&data).map_err(io)?;
            Ok(Value::Bool(true))
        }
        other => Err(format!("Unsupported FS action: {}", other)),
    }
}
