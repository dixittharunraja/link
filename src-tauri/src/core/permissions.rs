use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

// Per-device permissions for what a paired peer may do on THIS machine (device-permissions.json).
// A brand-new pairing starts with everything denied; the user opts each feature in from the UI.
// Same file and shape as the Electron core's store: { deviceId: { permissionKey: bool } }.

pub const ALL_PERMISSION_KEYS: &[&str] = &[
    "fileaccess", "lock", "runcommand", "presenter", "flashlight", "touchpad", "systemvolume", "mpris",
    "telephony", "notification", "notificationMirroring", "dnd", "clipboard", "remoteinput", "remotecontrol",
];

// Keys this desktop actually executes; only these are advertised to peers, so a phone never shows
// a button for something the PC can't do yet.
pub const IMPLEMENTED_KEYS: &[&str] = &["systemvolume", "lock", "mpris", "runcommand", "remoteinput", "presenter", "clipboard", "fileaccess", "remotecontrol"];

// Features every paired device may use without an explicit grant.
pub const UNGATED_KEYS: &[&str] = &["lock"];

pub struct PermissionStore {
    path: PathBuf,
    data: Map<String, Value>,
}

impl PermissionStore {
    pub fn load(config_dir: &std::path::Path) -> Self {
        let path = config_dir.join("device-permissions.json");
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok())
            .unwrap_or_default();
        Self { path, data }
    }

    fn persist(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = fs::write(&self.path, json);
        }
    }

    pub fn all(&self) -> Value {
        Value::Object(self.data.clone())
    }

    pub fn replace(&mut self, all: Value) {
        if let Value::Object(map) = all {
            self.data = map;
            self.persist();
        }
    }

    pub fn check(&self, device_id: &str, key: &str) -> bool {
        match self.data.get(device_id).and_then(|d| d.get(key)) {
            Some(Value::Bool(allowed)) => *allowed,
            Some(Value::String(s)) => !s.is_empty(),
            _ => false,
        }
    }

    pub fn init_denied(&mut self, device_id: &str) {
        let denied: Map<String, Value> = ALL_PERMISSION_KEYS.iter().map(|k| (k.to_string(), Value::Bool(false))).collect();
        self.data.insert(device_id.to_string(), Value::Object(denied));
        self.persist();
    }

    pub fn delete(&mut self, device_id: &str) {
        if self.data.remove(device_id).is_some() {
            self.persist();
        }
    }

    /// The implemented features currently allowed for this peer. Lock is never gated: any paired
    /// device may lock this PC.
    pub fn effective(&self, device_id: &str) -> Vec<String> {
        IMPLEMENTED_KEYS.iter().filter(|k| UNGATED_KEYS.contains(k) || self.check(device_id, k)).map(|k| k.to_string()).collect()
    }
}
