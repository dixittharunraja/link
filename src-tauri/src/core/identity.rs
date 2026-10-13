use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use rcgen::{CertificateParams, KeyPair, DistinguishedName, DnType};
use base64::Engine;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub protocol_version: u32,
    pub incoming_capabilities: Vec<String>,
    pub outgoing_capabilities: Vec<String>,
    pub visibility: bool,
    #[serde(skip_serializing)]
    pub cert_pem: String,
    #[serde(skip_serializing)]
    pub key_pem: String,
    pub fingerprint: String,
    pub ip_address: Option<String>,
    pub ip_addresses: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    device_id: String,
    device_name: String,
}

pub fn get_local_ips() -> (Option<String>, Vec<String>) {
    let mut ips: Vec<String> = Vec::new();
    if let Ok(ifas) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in ifas {
            if let std::net::IpAddr::V4(ipv4) = ip {
                if !ipv4.is_loopback() && !ipv4.is_unspecified() && !ipv4.is_link_local() {
                    let s = ipv4.to_string();
                    if !ips.contains(&s) {
                        ips.push(s);
                    }
                }
            }
        }
    }

    let primary = match local_ip_address::local_ip() {
        Ok(std::net::IpAddr::V4(ipv4)) if !ipv4.is_loopback() && !ipv4.is_unspecified() => Some(ipv4.to_string()),
        _ => ips.first().cloned(),
    };

    if let Some(ref p) = primary {
        if !ips.contains(p) {
            ips.insert(0, p.clone());
        }
    }

    (primary, ips)
}

pub fn get_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Link")
}

pub fn compute_cert_fingerprint(cert_pem: &str) -> String {
    let clean = cert_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    
    // Base64 decode to get raw DER bytes
    let der_bytes = match base64::engine::general_purpose::STANDARD.decode(clean.as_bytes()) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    
    let mut hasher = Sha256::new();
    hasher.update(&der_bytes);
    hex::encode(hasher.finalize())
}

pub fn load_or_create_identity(config_dir: &Path) -> Result<DeviceIdentity, Box<dyn std::error::Error>> {
    fs::create_dir_all(config_dir)?;
    let id_file = config_dir.join("identity.json");
    let cert_file = config_dir.join("cert.pem");
    let key_file = config_dir.join("key.pem");

    let (device_id, device_name) = if id_file.exists() {
        match fs::read_to_string(&id_file) {
            Ok(content) => match serde_json::from_str::<StoredIdentity>(&content) {
                Ok(stored) if stored.device_id.len() >= 32 => (stored.device_id, stored.device_name),
                _ => generate_new_identity_meta(config_dir)?,
            },
            Err(_) => generate_new_identity_meta(config_dir)?,
        }
    } else {
        generate_new_identity_meta(config_dir)?
    };

    // Load or generate TLS certificate
    let (cert_pem, key_pem) = if cert_file.exists() && key_file.exists() {
        let cert = fs::read_to_string(&cert_file)?;
        let key = fs::read_to_string(&key_file)?;
        (cert, key)
    } else {
        let (cert, key) = generate_self_signed_cert(&device_id)?;
        fs::write(&cert_file, &cert)?;
        fs::write(&key_file, &key)?;
        (cert, key)
    };

    let fingerprint = compute_cert_fingerprint(&cert_pem);
    let (ip_address, ip_addresses) = get_local_ips();

    Ok(DeviceIdentity {
        device_id,
        device_name,
        device_type: "desktop".to_string(),
        protocol_version: 1,
        incoming_capabilities: incoming_capabilities(),
        outgoing_capabilities: outgoing_capabilities(),
        visibility: true,
        cert_pem,
        key_pem,
        fingerprint,
        ip_address,
        ip_addresses,
    })
}

fn generate_new_identity_meta(config_dir: &Path) -> Result<(String, String), Box<dyn std::error::Error>> {
    let id = Uuid::new_v4().simple().to_string(); // 32 hex chars (128-bit)
    let hostname = match whoami::fallible::hostname() {
        Ok(h) => h,
        Err(_) => "Windows-PC".to_string(),
    };
    let clean_name = hostname.chars().take(32).collect::<String>();
    
    let stored = StoredIdentity {
        device_id: id.clone(),
        device_name: clean_name.clone(),
    };
    fs::write(config_dir.join("identity.json"), serde_json::to_string_pretty(&stored)?)?;
    Ok((id, clean_name))
}

fn generate_self_signed_cert(common_name: &str) -> Result<(String, String), Box<dyn std::error::Error>> {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, common_name);
    params.distinguished_name = dn;
    
    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;
    
    Ok((cert.pem(), key_pair.serialize_pem()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cert_generation() {
        let res = generate_self_signed_cert("test_device");
        assert!(res.is_ok(), "Cert generation failed: {:?}", res.err());
        let (cert, key) = res.unwrap();
        assert!(cert.contains("BEGIN CERTIFICATE"));
        assert!(key.contains("PRIVATE KEY"));
    }

    #[test]
    fn test_load_or_create_identity() {
        let temp_dir = std::env::temp_dir().join(format!("link_test_{}", Uuid::new_v4()));
        let res = load_or_create_identity(&temp_dir);
        assert!(res.is_ok(), "Load/create identity failed: {:?}", res.err());
        let id = res.unwrap();
        assert_eq!(id.device_id.len(), 32);
        assert!(!id.fingerprint.is_empty());
        let _ = fs::remove_dir_all(&temp_dir);
    }
}

// Protocol packet types this desktop receives / sends. Peers gate their UI on these exact strings
// (the phone shows Presenter only if "link.presenter" is listed, Remote Input only if
// "link.touchpad.request" is, and so on), so this must stay in step with what core/host.rs handles.
fn incoming_capabilities() -> Vec<String> {
    [
        "link.clipboard", "link.clipboard.connect", "link.battery",
        "link.findmydevice.request", "link.runcommand.request", "link.presenter",
        "link.systemvolume", "link.systemvolume.request", "link.lock.request", "link.lock", "link.connectivity",
        "link.touchpad.request", "link.mpris.request", "link.telephony", "link.notification",
        "link.flashlight", "link.dnd", "link.rename", "link.rename.request",
        "link.digitizer.session", "link.digitizer",
        "link.remotecontrol.signal", "link.remotecontrol.stream", "link.remotecontrol.input",
        "link.fs.request", "link.capabilities",
    ]
    .iter()
    .map(|c| c.to_string())
    .collect()
}

fn outgoing_capabilities() -> Vec<String> {
    [
        "link.clipboard", "link.clipboard.connect", "link.battery",
        "link.findmydevice.request", "link.runcommand",
        "link.systemvolume", "link.lock.request", "link.lock", "link.mpris",
        "link.flashlight", "link.dnd", "link.rename", "link.rename.request",
        "link.telephony.request",
        "link.remotecontrol.signal", "link.remotecontrol.stream", "link.remotecontrol.input",
        "link.fs.response", "link.capabilities",
    ]
    .iter()
    .map(|c| c.to_string())
    .collect()
}

const MAX_NAME_LENGTH: usize = 32;

/// Strips the characters the wire format reserves and caps the length, as on every platform.
pub fn filter_device_name(input: &str) -> String {
    input
        .chars()
        .filter(|c| !"\"',;:.!?()[]<>".contains(*c))
        .take(MAX_NAME_LENGTH)
        .collect()
}

/// Persists a new device name in identity.json and returns the filtered name actually stored.
pub fn save_device_name(config_dir: &Path, new_name: &str) -> Result<String, Box<dyn std::error::Error>> {
    let id_file = config_dir.join("identity.json");
    let filtered = filter_device_name(new_name);
    let mut stored: StoredIdentity = serde_json::from_str(&fs::read_to_string(&id_file)?)?;
    stored.device_name = filtered.clone();
    fs::write(&id_file, serde_json::to_string_pretty(&stored)?)?;
    Ok(filtered)
}
