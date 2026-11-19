use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::core::identity::compute_cert_fingerprint;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    pub device_id: String,
    pub device_name: String,
    pub cert_pem: String,
    pub paired_at: i64,
    #[serde(rename = "lastKnownIp")]
    pub ip_address: Option<String>,
    /// The device's Tailscale address, learned while connected; used to reach it away from the LAN.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailscale_ip: Option<String>,
}

pub struct TrustStore {
    file_path: PathBuf,
    devices: HashMap<String, TrustedDevice>,
    // Removals, as device id -> when (ms). Pool membership is a last-writer-wins set: a device is in the
    // pool when its pairing is newer than its removal. A removal is kept (and passed on in pool lists)
    // so a member that was offline when it happened cannot bring the device back, and drops it
    // itself when it reconnects. Pairing it again on purpose is always newer.
    removed: HashMap<String, i64>,
    removed_path: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Removal {
    device_id: String,
    removed_at: i64,
}

impl TrustStore {
    pub fn new(config_dir: &Path) -> Self {
        let file_path = config_dir.join("trusted-devices.json");
        let mut store = Self {
            file_path,
            devices: HashMap::new(),
            removed: HashMap::new(),
            removed_path: config_dir.join("removed-devices.json"),
        };
        store.load();
        store
    }

    /// When this device was removed from the pool, if it was.
    pub fn removed_at(&self, device_id: &str) -> Option<i64> {
        self.removed.get(device_id).copied()
    }

    /// Every removal this device knows of, for pool lists.
    pub fn removals(&self) -> Vec<(String, i64)> {
        self.removed.iter().map(|(id, at)| (id.clone(), *at)).collect()
    }

    /// Records that `device_id` was removed at `at` and drops it if its pairing is not newer. Returns
    /// whether anything changed, so a removal is only passed on once.
    pub fn remove_device(&mut self, device_id: &str, at: i64) -> bool {
        let mut changed = false;
        if self.removed.get(device_id).is_none_or(|known| *known < at) {
            self.removed.insert(device_id.to_string(), at);
            self.persist_removed();
            changed = true;
        }
        if self.devices.get(device_id).is_some_and(|d| d.paired_at <= at) {
            self.devices.remove(device_id);
            self.persist();
            changed = true;
        }
        changed
    }

    fn persist_removed(&self) {
        let list: Vec<Removal> = self.removed.iter().map(|(id, at)| Removal { device_id: id.clone(), removed_at: *at }).collect();
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            if let Err(e) = crate::core::settings::write_atomic(&self.removed_path, json) {
                log::warn!("Could not save the removed devices: {}", e);
            }
        }
    }

    fn load(&mut self) {
        if let Ok(content) = fs::read_to_string(&self.removed_path) {
            if let Ok(list) = serde_json::from_str::<Vec<Removal>>(&content) {
                self.removed = list.into_iter().map(|r| (r.device_id, r.removed_at)).collect();
            }
        }
        if self.file_path.exists() {
            if let Ok(content) = fs::read_to_string(&self.file_path) {
                if let Ok(list) = serde_json::from_str::<Vec<TrustedDevice>>(&content) {
                    for dev in list {
                        self.devices.insert(dev.device_id.clone(), dev);
                    }
                }
            }
        }
    }

    fn persist(&self) {
        let list: Vec<&TrustedDevice> = self.devices.values().collect();
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            // A torn write would forget every pairing, so the file is replaced whole.
            if let Err(e) = crate::core::settings::write_atomic(&self.file_path, json) {
                log::warn!("Could not save the trusted devices: {}", e);
            }
        }
    }

    pub fn is_paired(&self, device_id: &str) -> bool {
        self.devices.contains_key(device_id)
    }

    pub fn get(&self, device_id: &str) -> Option<&TrustedDevice> {
        self.devices.get(device_id)
    }

    pub fn pair(&mut self, mut device: TrustedDevice) {
        // Pairing it again lifts the removal, and is newer than it even when the clocks disagree.
        if let Some(removed_at) = self.removed.remove(&device.device_id) {
            device.paired_at = device.paired_at.max(removed_at + 1);
            self.persist_removed();
        }
        self.devices.insert(device.device_id.clone(), device);
        self.persist();
    }

    pub fn unpair(&mut self, device_id: &str) -> Option<TrustedDevice> {
        let removed = self.devices.remove(device_id);
        if removed.is_some() {
            self.persist();
        }
        removed
    }

    pub fn list(&self) -> Vec<TrustedDevice> {
        self.devices.values().cloned().collect()
    }

    /// Records a paired device's Tailscale address; returns whether it changed.
    pub fn set_tailscale_ip(&mut self, device_id: &str, ip: &str) -> bool {
        match self.devices.get_mut(device_id) {
            Some(dev) if dev.tailscale_ip.as_deref() != Some(ip) => {
                dev.tailscale_ip = Some(ip.to_string());
                self.persist();
                true
            }
            _ => false,
        }
    }

    /// Refreshes where a paired device was last seen; false when nothing changed.
    pub fn set_ip(&mut self, device_id: &str, ip: &str) -> bool {
        match self.devices.get_mut(device_id) {
            Some(dev) if dev.ip_address.as_deref() != Some(ip) => {
                dev.ip_address = Some(ip.to_string());
                self.persist();
                true
            }
            _ => false,
        }
    }

    pub fn rename(&mut self, device_id: &str, new_name: &str) {
        if let Some(dev) = self.devices.get_mut(device_id) {
            dev.device_name = new_name.to_string();
            self.persist();
        }
    }

    /// Computes the pool hash, which changes whenever the set of trusted devices changes:
    /// 1. For each device, compute s_i = ID_i || ':' || FP_i
    /// 2. Sort lexicographically by device_id
    /// 3. Join with '|'
    /// 4. Truncated SHA-256 (first 16 hex chars)
    pub fn compute_pool_hash(&self) -> String {
        let mut sorted: Vec<&TrustedDevice> = self.devices.values().collect();
        sorted.sort_by(|a, b| a.device_id.cmp(&b.device_id));

        let canonical: String = sorted
            .iter()
            .map(|d| {
                let fp = compute_cert_fingerprint(&d.cert_pem);
                format!("{}:{}", d.device_id, fp)
            })
            .collect::<Vec<_>>()
            .join("|");

        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        let hash_hex = hex::encode(hasher.finalize());
        hash_hex.chars().take(16).collect()
    }
}
