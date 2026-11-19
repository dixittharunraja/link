use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use crate::core::identity::DeviceIdentity;
use crate::core::packet::LinkPacket;

pub const DISCOVERY_PORT: u16 = 1716;

// How often this device announces itself. Fast while it is looking for someone (a paired device is
// not connected, or nothing is paired yet); slow once every paired device is connected, because an
// announcement then tells nobody anything they need. A device that hears a stranger it has not seen
// announces at once, so two devices still find each other quickly whatever pace each is at.
const FAST_ANNOUNCE: Duration = Duration::from_secs(2);
const SLOW_ANNOUNCE: Duration = Duration::from_secs(30);
// The fast pace only lasts this long; after it a still-missing device is looked for every
// FAST_BACKOFF_ANNOUNCE, until the network changes or the search starts over (LinkDiscovery.java
// does the same).
const FAST_WINDOW: Duration = Duration::from_secs(30);
const FAST_BACKOFF_ANNOUNCE: Duration = Duration::from_secs(12);
// Over Tailscale an announcement goes out this often (and says so, so it is not expired in between).
pub const TAILNET_ANNOUNCE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub ip: String,
    pub ip_address: String,
    pub last_seen: i64,
    // How often the peer says it announces, so it is not expired between two slow announcements.
    pub interval_ms: i64,
}

pub struct DiscoveryManager {
    socket: std::sync::Mutex<Option<Arc<UdpSocket>>>,
    identity: DeviceIdentity,
    device_name: Arc<RwLock<String>>,
    discovered: Arc<RwLock<HashMap<String, DiscoveredPeer>>>,
    visibility: Arc<RwLock<bool>>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    fast: Arc<AtomicBool>,
    // When the current fast search began.
    fast_since: Arc<std::sync::Mutex<std::time::Instant>>,
    wake: Arc<tokio::sync::Notify>,
    // Wakes the reconnect loop (core/reconnect.rs): a device was heard anew or moved, or a connection ended.
    redial: Arc<tokio::sync::Notify>,
    // Devices heard anew (first announcement after going quiet) or at a new address since the reconnect loop
    // last looked: alive right now, so they are dialled at once whatever backoff their silence built up.
    heard_anew: Arc<std::sync::Mutex<HashSet<String>>>,
    // "Use Tailscale when away" is on: announcements may go to, and be answered over, the tailnet.
    remote: Arc<AtomicBool>,
    // Paired devices by the anonymous token a hidden device announces (privacy_token), as token -> (id, name).
    // A device with Device Visibility off says only this, so without it a hidden phone that changed address
    // would never be heard. Rebuilt only when the paired list changes (paired_key).
    paired_tokens: Arc<std::sync::RwLock<HashMap<String, (String, String)>>>,
    paired_key: std::sync::Mutex<Vec<(String, i64)>>,
}

/// What a device with Device Visibility off announces instead of its name: a token only paired devices can
/// recognise, the first 32 hex digits of SHA-256("<device id>:<certificate fingerprint>"). Matches
/// LinkDiscovery.computePrivacyToken on Android.
pub fn privacy_token(device_id: &str, fingerprint: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(format!("{}:{}", device_id, fingerprint).as_bytes());
    hex::encode(digest)[..32].to_string()
}

fn anon_announcement(token: &str, interval_ms: u128, reply: bool) -> Option<Vec<u8>> {
    let body = serde_json::json!({
        "token": token,
        "port": DISCOVERY_PORT,
        "announceIntervalMs": interval_ms as u64,
        "reply": reply,
    });
    LinkPacket::new("link.identity.anon", body).serialize().ok()
}

fn announce_pace(fast: &AtomicBool, fast_since: &std::sync::Mutex<std::time::Instant>) -> Duration {
    if !fast.load(Ordering::Relaxed) {
        SLOW_ANNOUNCE
    } else if fast_since.lock().map_or(true, |since| since.elapsed() < FAST_WINDOW) {
        FAST_ANNOUNCE
    } else {
        FAST_BACKOFF_ANNOUNCE
    }
}

// Only what a listener shows or acts on before connecting. Capabilities and the rest of the identity
// come in the identity packet on the TLS connection.
fn announcement(identity: &DeviceIdentity, name: &str, interval_ms: u128, reply: bool) -> Option<Vec<u8>> {
    let body = serde_json::json!({
        "deviceId": identity.device_id,
        "deviceName": name,
        "deviceType": identity.device_type,
        "announceIntervalMs": interval_ms as u64,
        // An answer to someone else's announcement, which is not answered in turn.
        "reply": reply,
    });
    LinkPacket::new("link.identity", body).serialize().ok()
}

impl DiscoveryManager {
    /// This device's announcement as it should go out now: its name while visible, the anonymous token
    /// (which only paired devices recognise) while hidden.
    async fn current_announcement(&self, interval_ms: u128) -> Option<Vec<u8>> {
        if *self.visibility.read().await {
            let name = self.device_name.read().await.clone();
            announcement(&self.identity, &name, interval_ms, false)
        } else {
            anon_announcement(&privacy_token(&self.identity.device_id, &self.identity.fingerprint), interval_ms, false)
        }
    }

    /// Tells discovery which devices are paired, as (device id, name, certificate fingerprint), so their
    /// anonymous announcements are recognised. Cheap when nothing changed; the reconnect loop calls it each pass.
    pub fn set_paired(&self, devices: &[crate::core::trust::TrustedDevice]) {
        let mut key: Vec<(String, i64)> = devices.iter().map(|d| (d.device_id.clone(), d.paired_at)).collect();
        key.sort();
        {
            let Ok(mut last) = self.paired_key.lock() else { return };
            if *last == key {
                return;
            }
            *last = key;
        }
        let tokens = devices
            .iter()
            .map(|d| {
                let fingerprint = crate::core::identity::compute_cert_fingerprint(&d.cert_pem);
                (privacy_token(&d.device_id, &fingerprint), (d.device_id.clone(), d.device_name.clone()))
            })
            .collect();
        if let Ok(mut map) = self.paired_tokens.write() {
            *map = tokens;
        }
    }

    /// Sends this device's announcement straight to every address of each local private subnet.
    /// Broadcasts are filtered on some networks (guest Wi-Fi, hotspots, routers that rate-limit
    /// them) while unicast still gets through; a paired phone that hears it connects back.
    pub async fn sweep_local_subnets(&self) {
        let Some(socket) = self.socket.lock().ok().and_then(|s| s.clone()) else { return };
        // A hidden PC sweeps with its anonymous token, so the sweep never names it to the whole subnet.
        let Some(bytes) = self.current_announcement(FAST_ANNOUNCE.as_millis()).await else { return };
        // Each interface's own subnet, capped at a /22 (1022 hosts) so a large network is
        // swept in part rather than flooded.
        for interface in if_addrs::get_if_addrs().unwrap_or_default() {
            let if_addrs::IfAddr::V4(v4) = interface.addr else { continue };
            if !v4.ip.is_private() || v4.ip.is_link_local() {
                continue;
            }
            let prefix = v4.netmask.to_bits().count_ones().max(22);
            let mask = u32::MAX << (32 - prefix);
            let network = v4.ip.to_bits() & mask;
            for host in (1..(!mask)).map(|offset| network | offset).filter(|host| *host != v4.ip.to_bits()) {
                let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::from_bits(host)), DISCOVERY_PORT);
                let _ = socket.send_to(&bytes, target).await;
            }
        }
    }

    pub fn new(identity: DeviceIdentity) -> Self {
        Self {
            socket: std::sync::Mutex::new(None),
            device_name: Arc::new(RwLock::new(identity.device_name.clone())),
            identity,
            discovered: Arc::new(RwLock::new(HashMap::new())),
            visibility: Arc::new(RwLock::new(true)),
            app_handle: Arc::new(RwLock::new(None)),
            fast: Arc::new(AtomicBool::new(true)),
            fast_since: Arc::new(std::sync::Mutex::new(std::time::Instant::now())),
            wake: Arc::new(tokio::sync::Notify::new()),
            redial: Arc::new(tokio::sync::Notify::new()),
            heard_anew: Arc::new(std::sync::Mutex::new(HashSet::new())),
            remote: Arc::new(AtomicBool::new(false)),
            paired_tokens: Arc::new(std::sync::RwLock::new(HashMap::new())),
            paired_key: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// The reconnect loop waits on this between its ticks.
    pub(crate) fn redial_signal(&self) -> Arc<tokio::sync::Notify> {
        self.redial.clone()
    }

    /// The devices heard anew or at a new address since the last call (see `heard_anew`).
    pub(crate) fn take_heard_anew(&self) -> HashSet<String> {
        self.heard_anew.lock().map(|mut set| std::mem::take(&mut *set)).unwrap_or_default()
    }

    /// The network changed: search at the fast pace again, starting now.
    pub fn network_changed(&self) {
        if let Ok(mut since) = self.fast_since.lock() {
            *since = std::time::Instant::now();
        }
        self.wake.notify_one();
    }

    pub fn set_remote_discovery(&self, on: bool) {
        self.remote.store(on, Ordering::Relaxed);
    }

    /// Device Visibility: whether new devices may discover this one.
    pub async fn is_visible(&self) -> bool {
        *self.visibility.read().await
    }

    /// Sends this device's announcement straight to tailnet devices: a broadcast does not cross
    /// Tailscale, so this is how a device there learns this one is looking to pair.
    pub async fn announce_to(&self, addresses: &[Ipv4Addr]) {
        let Some(socket) = self.socket.lock().ok().and_then(|s| s.clone()) else { return };
        let Some(bytes) = self.current_announcement(TAILNET_ANNOUNCE.as_millis()).await else { return };
        for address in addresses {
            let _ = socket.send_to(&bytes, SocketAddr::new(IpAddr::V4(*address), DISCOVERY_PORT)).await;
        }
    }

    /// Records a paired device found some way other than a UDP announcement (mDNS, core/mdns.rs), in the
    /// same table, so the reconnect loop dials it as it dials one heard by broadcast. A device an
    /// announcement has just been heard from keeps its entry, which carries the real name and type.
    pub async fn note_trusted_peer(&self, device_id: &str, device_name: &str, ip: &str, interval_ms: i64) {
        let now = chrono::Utc::now().timestamp_millis();
        let (is_new, device_type) = {
            let mut map = self.discovered.write().await;
            if map.get(device_id).is_some_and(|p| now - p.last_seen < p.interval_ms) {
                return;
            }
            let device_type = map.get(device_id).map(|p| p.device_type.clone()).unwrap_or_else(|| "desktop".to_string());
            let peer = DiscoveredPeer {
                device_id: device_id.to_string(),
                device_name: device_name.to_string(),
                device_type: device_type.clone(),
                ip: ip.to_string(),
                ip_address: ip.to_string(),
                last_seen: now,
                interval_ms,
            };
            (map.insert(device_id.to_string(), peer).is_none(), device_type)
        };
        if is_new {
            self.heard_anew.lock().map(|mut set| set.insert(device_id.to_string())).ok();
            self.redial.notify_one();
            if let Some(app) = self.app_handle.read().await.as_ref() {
                let _ = app.emit("device-discovered", serde_json::json!({
                    "deviceId": device_id,
                    "deviceName": device_name,
                    "deviceType": device_type,
                    "ipAddress": ip,
                }));
            }
        }
    }

    /// Fast while this device is looking for someone, slow once every paired device is connected.
    pub fn set_fast_mode(&self, fast: bool) {
        if !self.fast.swap(fast, Ordering::Relaxed) && fast {
            if let Ok(mut since) = self.fast_since.lock() {
                *since = std::time::Instant::now();
            }
            self.wake.notify_one();
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        let app = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let mut w = app.write().await;
            *w = Some(handle);
        });
    }

    pub fn get_discovered_peers(&self) -> Arc<RwLock<HashMap<String, DiscoveredPeer>>> {
        self.discovered.clone()
    }

    pub fn set_device_name(&self, name: String) {
        let current = self.device_name.clone();
        tauri::async_runtime::spawn(async move {
            *current.write().await = name;
        });
    }

    pub fn set_visibility(&self, enabled: bool) {
        let vis = self.visibility.clone();
        tauri::async_runtime::spawn(async move {
            let mut w = vis.write().await;
            *w = enabled;
        });
    }

    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use socket2::{Domain, Socket, Type};
        let std_sock = Socket::new(Domain::IPV4, Type::DGRAM, None)?;
        let _ = std_sock.set_reuse_address(true);
        let _ = std_sock.set_broadcast(true);
        let _ = std_sock.set_nonblocking(true);
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), DISCOVERY_PORT);
        std_sock.bind(&addr.into())?;
        let socket = Arc::new(UdpSocket::from_std(std_sock.into())?);
        if let Ok(mut shared) = self.socket.lock() {
            *shared = Some(socket.clone());
        }

        let rx_socket = socket.clone();
        let my_id = self.identity.device_id.clone();
        let peers_map = self.discovered.clone();
        let app_handle_rx = self.app_handle.clone();
        let wake_rx = self.wake.clone();
        let redial_rx = self.redial.clone();
        let heard_anew_rx = self.heard_anew.clone();
        let (identity_rx, name_rx, visibility_rx) = (self.identity.clone(), self.device_name.clone(), self.visibility.clone());
        let remote_rx = self.remote.clone();
        let paired_rx = self.paired_tokens.clone();

        // Receiver: records every identity announcement heard on the discovery port.
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            let mut last_reply = std::time::Instant::now() - Duration::from_secs(10);
            let mut tailnet_replied: HashMap<IpAddr, std::time::Instant> = HashMap::new();
            loop {
                if let Ok((len, src)) = rx_socket.recv_from(&mut buf).await {
                    if let Ok(packet) = serde_json::from_slice::<LinkPacket>(&buf[..len]) {
                        // A visible device names itself. A hidden one sends only a token, which is recognised
                        // when it belongs to a paired device; its name then comes from the pairing.
                        let heard: Option<(String, String, Option<String>)> = match packet.packet_type.as_str() {
                            "link.identity" => packet.body["deviceId"].as_str().map(|id| {
                                let name = packet.body["deviceName"].as_str().and_then(crate::core::identity::received_device_name).unwrap_or_else(|| "Unknown device".into());
                                (id.to_string(), name, Some(packet.body["deviceType"].as_str().unwrap_or("desktop").to_string()))
                            }),
                            "link.identity.anon" => packet.body["token"]
                                .as_str()
                                .and_then(|token| paired_rx.read().ok().and_then(|map| map.get(token).cloned()))
                                .map(|(id, name)| (id, name, None)),
                            _ => None,
                        };
                        if let Some((dev_id, dev_name, dev_type)) = heard {
                                if dev_id != my_id {
                                    // A token says nothing about the device's type: keep what was heard before.
                                    let dev_type = match dev_type {
                                        Some(t) => t,
                                        None => peers_map.read().await.get(&dev_id).map_or_else(|| "desktop".to_string(), |p| p.device_type.clone()),
                                    };
                                    let ip = src.ip().to_string();
                                    let Some(interval_ms) = packet.body["announceIntervalMs"].as_i64() else { continue };

                                    let peer = DiscoveredPeer {
                                        device_id: dev_id.clone(),
                                        device_name: dev_name.clone(),
                                        device_type: dev_type.clone(),
                                        ip: ip.clone(),
                                        ip_address: ip.clone(),
                                        last_seen: chrono::Utc::now().timestamp_millis(),
                                        interval_ms: interval_ms.clamp(1_000, 300_000),
                                    };

                                    let (is_new, changed) = {
                                        let mut map = peers_map.write().await;
                                        match map.insert(dev_id.clone(), peer) {
                                            None => (true, true),
                                            Some(before) => {
                                                if before.ip != ip {
                                                    heard_anew_rx.lock().map(|mut set| set.insert(dev_id.clone())).ok();
                                                }
                                                (false, before.device_name != dev_name || before.device_type != dev_type || before.ip != ip)
                                            }
                                        }
                                    };
                                    if is_new {
                                        heard_anew_rx.lock().map(|mut set| set.insert(dev_id.clone())).ok();
                                    }
                                    // Tailscale carries no broadcasts, so a device there that announces itself is answered
                                    // directly (never a reply in turn, and at most every few seconds), but only while this
                                    // device is visible and the user allowed Tailscale.
                                    let is_reply = packet.body["reply"].as_bool().unwrap_or(false);
                                    if !is_reply
                                        && crate::core::identity::is_tailscale_ip(src.ip())
                                        && remote_rx.load(Ordering::Relaxed)
                                        && *visibility_rx.read().await
                                        && tailnet_replied.get(&src.ip()).is_none_or(|t| t.elapsed() >= Duration::from_secs(4))
                                    {
                                        tailnet_replied.insert(src.ip(), std::time::Instant::now());
                                        let name = name_rx.read().await.clone();
                                        if let Some(bytes) = announcement(&identity_rx, &name, TAILNET_ANNOUNCE.as_millis(), true) {
                                            let _ = rx_socket.send_to(&bytes, src).await;
                                        }
                                    }
                                    // A device we have not heard before is looking for us: answer now, but at most once
                                    // every couple of seconds so forged announcements cannot make us flood the network.
                                    if is_new && last_reply.elapsed() >= Duration::from_secs(2) {
                                        last_reply = std::time::Instant::now();
                                        wake_rx.notify_one();
                                    }

                                    // The UI only needs to hear of a device it does not know yet, or one whose name,
                                    // type or address changed; a repeat announcement says nothing new.
                                    if !changed {
                                        continue;
                                    }
                                    // A paired device that turns up, or moves, is dialled now rather than on the next tick.
                                    redial_rx.notify_one();
                                    if let Some(app) = app_handle_rx.read().await.as_ref() {
                                        let _ = app.emit("device-discovered", serde_json::json!({
                                            "deviceId": dev_id,
                                            "deviceName": dev_name,
                                            "deviceType": dev_type,
                                            "ipAddress": ip,
                                        }));
                                    }
                                }
                        }
                    }
                }
            }
        });

        // Broadcaster: announces this device while visible, at the pace set by set_fast_mode.
        let tx_socket = socket.clone();
        let identity = self.identity.clone();
        let device_name = self.device_name.clone();
        let visibility = self.visibility.clone();
        let fast = self.fast.clone();
        let fast_since = self.fast_since.clone();
        let wake_tx = self.wake.clone();
        let paired_tx = self.paired_tokens.clone();

        tokio::spawn(async move {
            let mut first = true;
            // One socket per local address: a broadcast from the shared wildcard socket leaves by a
            // single adapter, so a PC on Wi-Fi and a hotspot at once would be visible on only one.
            let mut per_adapter: HashMap<Ipv4Addr, UdpSocket> = HashMap::new();
            // What the last announcement said; the next one comes after that long.
            let mut pace = FAST_ANNOUNCE;
            loop {
                if !first {
                    tokio::select! {
                        _ = tokio::time::sleep(pace) => {}
                        _ = wake_tx.notified() => {}
                    }
                }
                first = false;
                pace = announce_pace(&fast, &fast_since);

                // Hidden: only the anonymous token, which paired devices recognise, and only if anyone is paired.
                let visible = *visibility.read().await;
                if !visible && paired_tx.read().map_or(true, |m| m.is_empty()) {
                    continue;
                }

                let local: Vec<Ipv4Addr> = local_ip_address::list_afinet_netifas()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|(_, ip)| match ip {
                        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4),
                        _ => None,
                    })
                    .collect();
                per_adapter.retain(|ip, _| local.contains(ip));
                for ip in &local {
                    if per_adapter.contains_key(ip) {
                        continue;
                    }
                    let bound = std::net::UdpSocket::bind((*ip, 0)).and_then(|s| {
                        s.set_broadcast(true)?;
                        s.set_nonblocking(true)?;
                        UdpSocket::from_std(s)
                    });
                    if let Ok(socket) = bound {
                        per_adapter.insert(*ip, socket);
                    }
                }

                let bytes = if visible {
                    let name = device_name.read().await.clone();
                    announcement(&identity, &name, pace.as_millis(), false)
                } else {
                    anon_announcement(&privacy_token(&identity.device_id, &identity.fingerprint), pace.as_millis(), false)
                };
                if let Some(bytes) = bytes {
                    let broadcast_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT);
                    // The wildcard socket leaves by the default adapter, which has its own socket below, so it is
                    // used only when some adapter has none (a bind failed), not as a second copy of the same packet.
                    if per_adapter.len() < local.len() || per_adapter.is_empty() {
                        let _ = tx_socket.send_to(&bytes, broadcast_addr).await;
                    }
                    for socket in per_adapter.values() {
                        let _ = socket.send_to(&bytes, broadcast_addr).await;
                    }
                }
            }
        });

        // Expiry: a peer unheard for three of its announcement intervals (6 seconds at the fast pace) is dropped.
        let expiry_map = self.discovered.clone();
        let app_handle_exp = self.app_handle.clone();
        tokio::spawn(async move {
            loop {
                let now = chrono::Utc::now().timestamp_millis();
                // A read lock is enough to see whether anything has expired; an empty map is checked rarely.
                let (empty, any_expired) = {
                    let map = expiry_map.read().await;
                    (map.is_empty(), map.values().any(|peer| now - peer.last_seen >= (peer.interval_ms * 3).max(6000) + 1000))
                };
                let mut expired_ids = Vec::new();
                if any_expired {
                    let mut map = expiry_map.write().await;
                    map.retain(|id, peer| {
                        // Three missed announcements, at the pace that peer announced.
                        let keep = now - peer.last_seen < (peer.interval_ms * 3).max(6000) + 1000;
                        if !keep {
                            expired_ids.push(id.clone());
                        }
                        keep
                    });
                }
                if let Some(app) = app_handle_exp.read().await.as_ref() {
                    for id in expired_ids {
                        let _ = app.emit("device-expired", serde_json::json!({ "deviceId": id }));
                    }
                }
                tokio::time::sleep(Duration::from_secs(if empty { 10 } else { 2 })).await;
            }
        });

        Ok(())
    }
}
