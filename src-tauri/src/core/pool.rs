// The Trusted Pool: pair once with any device in your set and every device in it trusts the newcomer, with
// no second pairing. The human gate is the one approval at the first pairing.
//
// Membership is a last-writer-wins set that every member converges on, whatever order devices come and go:
//   * a pairing carries the time it happened (`pairedAt`); a removal carries the time it was made
//     (`removedAt`) and is remembered, not just applied;
//   * a device is in the pool when its pairing is newer than its removal (pairing it again on purpose
//     is always newer, see TrustStore::pair);
//   * a pool list carries both the pairings and the removals, so a device that was offline learns of
//     new members AND of dropped ones when it reconnects, and cannot bring a dropped one back: whoever
//     sees a removal it did not know passes it on, and a member that lists a device removed here is told.
//
// Lists are accepted ONLY from a device this one has already paired with. Anyone can open a connection, so a
// list from a stranger would let it vouch for itself. Android implements the same protocol
// (LinkDeviceManager.java); keep the two in step.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::core::identity::{compute_cert_fingerprint, received_device_name};
use crate::core::packet::LinkPacket;
use crate::core::transport::DeviceManager;
use crate::core::trust::{TrustStore, TrustedDevice};

pub const SYNC: &str = "link.pool.sync";
pub const REMOVE: &str = "link.pool.remove";

/// This device, as it appears in its own list.
pub struct Me<'a> {
    pub device_id: &'a str,
    pub device_name: &'a str,
    pub cert_pem: &'a str,
}

/// Every paired device with its certificate and last known address, and this device itself. `live`
/// holds the address of each current connection, used when no address is stored.
pub fn sync_list(store: &TrustStore, me: &Me, live: &HashMap<String, String>) -> Vec<Value> {
    let mut list: Vec<Value> = store
        .list()
        .into_iter()
        .map(|d| {
            let ip = d.ip_address.clone().filter(|ip| !ip.is_empty()).or_else(|| live.get(&d.device_id).cloned()).unwrap_or_default();
            json!({
                "deviceId": d.device_id,
                "deviceName": d.device_name,
                "certPem": d.cert_pem,
                "lastKnownIp": ip,
                "pairedAt": d.paired_at,
            })
        })
        .collect();
    // This device's own entry has no pairing time: whoever receives the list already pairs with it.
    list.push(json!({
        "deviceId": me.device_id,
        "deviceName": me.device_name,
        "certPem": me.cert_pem,
        "lastKnownIp": "",
    }));
    list
}

/// Every removal this device knows of, for a pool list.
pub fn removal_list(store: &TrustStore) -> Vec<Value> {
    store.removals().into_iter().map(|(id, at)| json!({ "deviceId": id, "removedAt": at })).collect()
}

/// What a received list changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Learned {
    /// Devices added to the pool.
    pub added: Vec<String>,
    /// Devices dropped because the list told of their removal.
    pub removed: Vec<String>,
    /// Devices the sender lists although they were removed here after it paired them: (id, removal time).
    pub stale: Vec<(String, i64)>,
}

/// Merges a received list into this device's pool. A known device keeps the certificate it was paired with
/// (a list can never replace it); only its address may be refreshed, quietly.
pub fn learn(
    store: &mut TrustStore,
    entries: &[Value],
    removals: &[Value],
    my_id: &str,
    sender_id: &str,
    sender_ip: &str,
    blocked: &dyn Fn(&str) -> bool,
) -> Learned {
    let mut learned = Learned::default();

    for removal in removals {
        let id = removal.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
        let at = removal.get("removedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        // Nobody removes this device or the one vouching from this device's own pool.
        if id.is_empty() || id == my_id || id == sender_id {
            continue;
        }
        let was_paired = store.is_paired(id);
        if store.remove_device(id, at) && was_paired && !store.is_paired(id) {
            learned.removed.push(id.to_string());
        }
    }

    for entry in entries {
        let id = entry.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() || id == my_id || blocked(id) {
            continue;
        }
        // The sender's own entry has no address of its own: it is the one this list arrived from.
        let ip = entry
            .get("lastKnownIp")
            .and_then(|v| v.as_str())
            .filter(|ip| !ip.is_empty())
            .or_else(|| (id == sender_id && !sender_ip.is_empty()).then_some(sender_ip));
        if store.is_paired(id) {
            if let Some(ip) = ip {
                store.set_ip(id, ip);
            }
            continue;
        }
        let paired_at = entry.get("pairedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some(removed_at) = store.removed_at(id) {
            if paired_at <= removed_at {
                if id != sender_id {
                    learned.stale.push((id.to_string(), removed_at));
                }
                continue;
            }
        }
        let cert_pem = entry.get("certPem").and_then(|v| v.as_str()).unwrap_or("");
        if compute_cert_fingerprint(cert_pem).is_empty() {
            continue;
        }
        let name = entry.get("deviceName").and_then(|v| v.as_str()).and_then(received_device_name).unwrap_or_else(|| "Unknown device".into());
        store.pair(TrustedDevice {
            device_id: id.to_string(),
            device_name: name,
            cert_pem: cert_pem.to_string(),
            paired_at: if paired_at > 0 { paired_at } else { chrono::Utc::now().timestamp_millis() },
            ip_address: ip.map(str::to_string),
            tailscale_ip: None,
        });
        learned.added.push(id.to_string());
    }
    learned
}

impl DeviceManager {
    async fn pool_sync_packet(&self) -> LinkPacket {
        let live: HashMap<String, String> = self.active_peers.read().await.iter().map(|(id, p)| (id.clone(), p.ip.clone())).collect();
        let name = self.device_name.read().await.clone();
        let store = self.trust_store.read().await;
        let me = Me {
            device_id: &self.identity.device_id,
            device_name: &name,
            cert_pem: &self.identity.cert_pem,
        };
        LinkPacket::new(SYNC, json!({ "trustList": sync_list(&store, &me, &live), "removed": removal_list(&store) }))
    }

    async fn trusted_senders(&self, except: &[&str]) -> Vec<tokio::sync::mpsc::Sender<LinkPacket>> {
        self.active_peers.read().await.values().filter(|p| p.trusted && !except.contains(&p.device_id.as_str())).map(|p| p.tx.clone()).collect()
    }

    /// Tells one paired, connected device who is in the pool.
    pub(crate) async fn send_pool_sync(&self, device_id: &str) {
        let tx = self.active_peers.read().await.get(device_id).filter(|p| p.trusted).map(|p| p.tx.clone());
        if let Some(tx) = tx {
            let _ = tx.send(self.pool_sync_packet().await).await;
        }
    }

    /// Tells every paired, connected device (but `except`) who is in the pool.
    pub(crate) async fn broadcast_pool_sync(&self, except: Option<&str>) {
        let packet = self.pool_sync_packet().await;
        for tx in self.trusted_senders(&except.into_iter().collect::<Vec<_>>()).await {
            let _ = tx.send(packet.clone()).await;
        }
    }

    /// A device was just paired: set it up and tell the rest of the pool.
    pub(crate) async fn pool_joined(&self, device_id: &str) {
        self.on_paired(device_id).await;
        self.broadcast_pool_sync(None).await;
    }

    /// A device just entered the pool through a list: a connection already open to it was made before it
    /// was trusted, so it is trusted from now on instead of staying ignored until it reconnects.
    async fn admit_pool_member(&self, device_id: &str) {
        let connected = self.active_peers.write().await.get_mut(device_id).map(|p| {
            p.trusted = true;
            p.to_json()
        });
        if let (Some(session), Some(app)) = (connected.clone(), self.app_handle.read().await.as_ref()) {
            use tauri::Emitter;
            let _ = app.emit("device-connected", session);
        }
        self.on_paired(device_id).await;
        if connected.is_some() {
            self.send_pool_sync(device_id).await;
        }
    }

    /// A pool list arrived. Only a paired device may vouch for others.
    pub(crate) async fn on_pool_sync(&self, sender: &str, body: &Value) {
        let sender_ip = {
            let peers = self.active_peers.read().await;
            match peers.get(sender) {
                Some(peer) if peer.trusted => peer.ip.clone(),
                _ => {
                    log::warn!("Ignored a pool list from {}: not a paired device", sender);
                    return;
                }
            }
        };
        let entries = body.get("trustList").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let removals = body.get("removed").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let learned = {
            let mut store = self.trust_store.write().await;
            if !store.is_paired(sender) {
                return;
            }
            learn(&mut store, &entries, &removals, &self.identity.device_id, sender, &sender_ip, &|id| self.is_blocked(id))
        };

        // The sender missed a removal made here: say so, and it drops the device when it has caught up.
        if !learned.stale.is_empty() {
            let tx = self.active_peers.read().await.get(sender).map(|p| p.tx.clone());
            if let Some(tx) = tx {
                for (id, at) in &learned.stale {
                    let _ = tx.send(LinkPacket::new(REMOVE, json!({ "deviceId": id, "removedAt": at }))).await;
                }
            }
        }
        for id in &learned.removed {
            log::info!("Dropped {} from the pool: removed, as {} told", id, sender);
            let _ = self.unpair(id).await;
        }
        for id in &learned.added {
            log::info!("Learned {} from the pool via {}", id, sender);
            self.admit_pool_member(id).await;
        }
        if learned.added.is_empty() && learned.removed.is_empty() {
            return;
        }
        if let Some(app) = self.app_handle.read().await.as_ref() {
            use tauri::Emitter;
            let _ = app.emit("trust-list-updated", json!({}));
        }
        // The rest of the pool may not know either.
        self.broadcast_pool_sync(Some(sender)).await;
    }

    /// A paired device asks for another to be removed from the pool.
    pub(crate) async fn on_pool_remove(&self, sender: &str, body: &Value) {
        if !self.active_peers.read().await.get(sender).is_some_and(|p| p.trusted) {
            return;
        }
        let Some(target) = body.get("deviceId").and_then(|v| v.as_str()).filter(|t| !t.is_empty()) else { return };
        if target == self.identity.device_id || target == sender {
            return;
        }
        let at = body.get("removedAt").and_then(|v| v.as_i64()).unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        // Only a removal this device did not know about is applied and passed on, so it cannot loop.
        let changed = self.trust_store.write().await.remove_device(target, at);
        if !changed {
            return;
        }
        log::info!("{} asked to remove {} from the pool", sender, target);
        let packet = LinkPacket::new(REMOVE, json!({ "deviceId": target, "removedAt": at }));
        for tx in self.trusted_senders(&[sender, target]).await {
            let _ = tx.send(packet.clone()).await;
        }
        let _ = self.unpair(target).await;
    }

    /// The user removed a device: every member is told (and the ones offline learn it from the lists they
    /// get when they return), then this device lets go of it.
    pub async fn unpair_from_pool(&self, target: &str) -> Result<(), String> {
        let at = chrono::Utc::now().timestamp_millis();
        self.trust_store.write().await.remove_device(target, at);
        let packet = LinkPacket::new(REMOVE, json!({ "deviceId": target, "removedAt": at }));
        for tx in self.trusted_senders(&[target]).await {
            let _ = tx.send(packet.clone()).await;
        }
        self.unpair(target).await
    }

    /// Leaves the pool: every paired device is let go of.
    pub async fn exit_pool(&self) {
        let ids: Vec<String> = self.trust_store.read().await.list().into_iter().map(|d| d.device_id).collect();
        for id in ids {
            let _ = self.unpair(&id).await;
        }
    }
}
