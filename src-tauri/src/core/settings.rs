use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// Small persisted preferences (settings.json) and the device blocklist (blocklist.json).

/// Writes a file so a crash or power cut mid-write leaves either the old contents or the new, never
/// a truncated file: the bytes go to a sibling temp file first, which then replaces the real one
/// (a rename replaces an existing file on Windows too).
pub(crate) fn write_atomic(path: &std::path::Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(contents.as_ref())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub struct SettingsStore {
    path: PathBuf,
    data: Map<String, Value>,
}

impl SettingsStore {
    pub fn load(config_dir: &std::path::Path) -> Self {
        let path = config_dir.join("settings.json");
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok())
            .unwrap_or_default();
        Self { path, data }
    }

    pub fn get_value(&self, key: &str) -> Option<Value> {
        self.data.get(key).cloned()
    }

    pub fn set_value(&mut self, key: &str, value: Value) {
        self.data.insert(key.to_string(), value);
        self.persist();
    }

    fn persist(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = write_atomic(&self.path, json);
        }
    }

    pub fn get_bool(&self, key: &str, default: bool) -> bool {
        self.data.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
    }

    pub fn set_bool(&mut self, key: &str, value: bool) {
        self.set_value(key, Value::Bool(value));
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockEntry {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub blocked_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct BlocklistFile {
    entries: Vec<BlockEntry>,
}

pub struct Blocklist {
    path: PathBuf,
    entries: Vec<BlockEntry>,
}

impl Blocklist {
    pub fn load(config_dir: &std::path::Path) -> Self {
        let path = config_dir.join("blocklist.json");
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<BlocklistFile>(&s).ok())
            .unwrap_or_default()
            .entries;
        Self { path, entries }
    }

    fn persist(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&BlocklistFile { entries: self.entries.clone() }) {
            let _ = write_atomic(&self.path, json);
        }
    }

    pub fn entries(&self) -> Vec<BlockEntry> {
        self.entries.clone()
    }

    pub fn is_blocked(&self, id_or_ip: &str) -> bool {
        self.entries.iter().any(|e| e.id == id_or_ip || e.ip.as_deref() == Some(id_or_ip))
    }

    pub fn add(&mut self, entry: BlockEntry) {
        self.entries.retain(|e| e.id != entry.id);
        self.entries.push(entry);
        self.persist();
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|e| e.id != id);
        self.persist();
    }
}
