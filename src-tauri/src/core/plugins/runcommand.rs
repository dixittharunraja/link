// The whitelist of commands a paired device may trigger on this PC (runcommand.json).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct CommandEntry {
    pub name: String,
    pub command: String,
}

pub struct RunCommands {
    path: PathBuf,
    entries: BTreeMap<String, CommandEntry>,
}

impl RunCommands {
    pub fn load(config_dir: &std::path::Path) -> Self {
        let path = config_dir.join("runcommand.json");
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<BTreeMap<String, CommandEntry>>(&s).ok())
            .unwrap_or_else(|| {
                BTreeMap::from([("notepad".to_string(), CommandEntry { name: "Open Notepad".into(), command: "notepad.exe".into() })])
            });
        let store = Self { path, entries };
        store.persist();
        store
    }

    fn persist(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.entries) {
            let _ = std::fs::write(&self.path, json);
        }
    }

    pub fn all(&self) -> BTreeMap<String, CommandEntry> {
        self.entries.clone()
    }

    pub fn set(&mut self, key: String, entry: CommandEntry) {
        self.entries.insert(key, entry);
        self.persist();
    }

    pub fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        self.persist();
    }

    /// Runs the whitelisted command stored under `key`; unknown keys do nothing.
    pub fn trigger(&self, key: &str) {
        let Some(entry) = self.entries.get(key) else { return };
        let command = entry.command.trim();
        if command.is_empty() {
            return;
        }
        let bare = command.trim_matches('"');
        let spawned = if cfg!(windows) && std::path::Path::new(bare).exists() {
            let is_program = matches!(
                std::path::Path::new(bare).extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref(),
                Some("exe" | "bat" | "cmd")
            );
            if is_program {
                Command::new(bare).spawn()
            } else {
                Command::new("cmd").args(["/C", "start", "", bare]).spawn()
            }
        } else if cfg!(windows) {
            Command::new("cmd").args(["/C", command]).spawn()
        } else {
            Command::new("sh").args(["-c", command]).spawn()
        };
        if let Err(e) = spawned {
            log::warn!("Run command '{}' failed to start: {}", key, e);
        }
    }
}
