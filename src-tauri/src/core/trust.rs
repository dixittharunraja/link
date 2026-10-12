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
    pub protocol_version: u32,
    pub paired_at: i64,
    #[serde(alias = "last_known_ip", alias = "lastKnownIp")]
    pub ip_address: Option<String>,
}

pub struct TrustStore {
    file_path: PathBuf,
    devices: HashMap<String, TrustedDevice>,
}

impl TrustStore {
    pub fn new(config_dir: &Path) -> Self {
        let file_path = config_dir.join("trusted-devices.json");
        let mut store = Self {
            file_path,
            devices: HashMap::new(),
        };
        store.load();
        store
    }

    fn load(&mut self) {
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
        if let Some(parent) = self.file_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let list: Vec<&TrustedDevice> = self.devices.values().collect();
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = fs::write(&self.file_path, json);
        }
    }

    pub fn is_paired(&self, device_id: &str) -> bool {
        self.devices.contains_key(device_id)
    }

    pub fn get(&self, device_id: &str) -> Option<&TrustedDevice> {
        self.devices.get(device_id)
    }

    pub fn pair(&mut self, device: TrustedDevice) {
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

    pub fn rename(&mut self, device_id: &str, new_name: &str) {
        if let Some(dev) = self.devices.get_mut(device_id) {
            dev.device_name = new_name.to_string();
            self.persist();
        }
    }

    /// Computes the canonical PoolHash(P) strictly matching equation (6) from the paper:
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
