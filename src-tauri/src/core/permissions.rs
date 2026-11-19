use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

// Per-device permissions for what a paired peer may do on this machine, stored in
// device-permissions.json as { deviceId: { permissionKey: bool } }. A new pairing starts with
// everything allowed; the user can switch features off from the UI.

pub const ALL_PERMISSION_KEYS: &[&str] = &[
    "fileaccess", "lock", "runcommand", "presenter", "flashlight", "touchpad", "systemvolume", "mpris",
    "telephony", "notification", "notificationMirroring", "dnd", "clipboard", "remoteinput", "remotecontrol", "joystick",
    "location",
];


// Keys this desktop actually executes; only these are advertised to peers, so a phone never shows
// a button for something the PC can't do yet.
pub const IMPLEMENTED_KEYS: &[&str] = &["systemvolume", "lock", "mpris", "runcommand", "remoteinput", "presenter", "clipboard", "fileaccess", "remotecontrol", "joystick", "location"];

// Low-risk features every paired device may use without an explicit grant, and with no toggle in
// the permissions menu. Anything that exposes data or acts on this machine (clipboard, files,
// commands, raw input, remote control, telephony, notifications) stays opt-in.
pub const UNGATED_KEYS: &[&str] = &["lock", "systemvolume", "mpris", "presenter", "touchpad", "flashlight", "dnd"];

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
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = crate::core::settings::write_atomic(&self.path, json);
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
        if UNGATED_KEYS.contains(&key) {
            return true;
        }
        matches!(self.data.get(device_id).and_then(|d| d.get(key)), Some(Value::Bool(true)))
    }

    pub fn init_defaults(&mut self, device_id: &str) {
        let allowed: Map<String, Value> = ALL_PERMISSION_KEYS.iter().map(|k| (k.to_string(), Value::Bool(true))).collect();
        self.data.insert(device_id.to_string(), Value::Object(allowed));
        self.persist();
    }

    /// Gives a paired device a value for every key it has none for yet (on, like a new pairing), so a
    /// permission added in an update reaches devices paired before it. Existing values are kept.
    pub fn fill_missing(&mut self, device_id: &str) {
        let Some(Value::Object(perms)) = self.data.get_mut(device_id) else { return };
        let mut changed = false;
        for key in ALL_PERMISSION_KEYS {
            if !perms.contains_key(*key) {
                perms.insert(key.to_string(), Value::Bool(true));
                changed = true;
            }
        }
        if changed {
            self.persist();
        }
    }

    pub fn delete(&mut self, device_id: &str) {
        if self.data.remove(device_id).is_some() {
            self.persist();
        }
    }

    /// The implemented features currently allowed for this peer, ungated ones included.
    pub fn effective(&self, device_id: &str) -> Vec<String> {
        IMPLEMENTED_KEYS.iter().filter(|k| UNGATED_KEYS.contains(k) || self.check(device_id, k)).map(|k| k.to_string()).collect()
    }
}
