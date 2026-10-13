use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use crate::core::identity::DeviceIdentity;
use crate::core::packet::LinkPacket;

pub const DISCOVERY_PORT: u16 = 1716;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub ip: String,
    pub ip_address: String,
    pub last_seen: i64,
}

pub struct DiscoveryManager {
    socket: std::sync::Mutex<Option<Arc<UdpSocket>>>,
    identity: DeviceIdentity,
    device_name: Arc<RwLock<String>>,
    discovered: Arc<RwLock<HashMap<String, DiscoveredPeer>>>,
    visibility: Arc<RwLock<bool>>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

fn announcement(identity: &DeviceIdentity, name: &str) -> Option<Vec<u8>> {
    let body = serde_json::json!({
        "deviceId": identity.device_id,
        "deviceName": name,
        "deviceType": identity.device_type,
        "protocolVersion": identity.protocol_version,
        "incomingCapabilities": identity.incoming_capabilities,
        "outgoingCapabilities": identity.outgoing_capabilities,
    });
    LinkPacket::new("link.identity", body).serialize().ok()
}

impl DiscoveryManager {
    /// Sends this device's announcement straight to every address of each local private subnet.
    /// Broadcasts are filtered on some networks (guest Wi-Fi, hotspots, routers that rate-limit
    /// them) while unicast still gets through; a paired phone that hears it connects back.
    pub async fn sweep_local_subnets(&self) {
        let Some(socket) = self.socket.lock().ok().and_then(|s| s.clone()) else { return };
        let name = self.device_name.read().await.clone();
        let Some(bytes) = announcement(&self.identity, &name) else { return };
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

        // Background Receiver Task
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                if let Ok((len, src)) = rx_socket.recv_from(&mut buf).await {
                    if let Ok(packet) = serde_json::from_slice::<LinkPacket>(&buf[..len]) {
                        if packet.packet_type == "link.identity" {
                            if let Ok(dev_id) = serde_json::from_value::<String>(packet.body["deviceId"].clone()) {
                                if dev_id != my_id {
                                    let dev_name = packet.body["deviceName"].as_str().unwrap_or("Unknown").to_string();
                                    let dev_type = packet.body["deviceType"].as_str().unwrap_or("desktop").to_string();
                                    let ip = src.ip().to_string();

                                    let peer = DiscoveredPeer {
                                        device_id: dev_id.clone(),
                                        device_name: dev_name.clone(),
                                        device_type: dev_type.clone(),
                                        ip: ip.clone(),
                                        ip_address: ip.clone(),
                                        last_seen: chrono::Utc::now().timestamp_millis(),
                                    };

                                    {
                                        let mut map = peers_map.write().await;
                                        map.insert(dev_id.clone(), peer);
                                    }

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
            }
        });

        // Background Broadcaster Task (Every 2 seconds)
        let tx_socket = socket.clone();
        let identity = self.identity.clone();
        let device_name = self.device_name.clone();
        let visibility = self.visibility.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
            // One socket per local address: a broadcast from the shared wildcard socket leaves by a
            // single adapter, so a PC on Wi-Fi and a hotspot at once was only visible on one of them.
            let mut per_adapter: HashMap<Ipv4Addr, UdpSocket> = HashMap::new();
            loop {
                interval.tick().await;

                if !*visibility.read().await {
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

                let name = device_name.read().await.clone();
                if let Some(bytes) = announcement(&identity, &name) {
                    let broadcast_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT);
                    let _ = tx_socket.send_to(&bytes, broadcast_addr).await;
                    for socket in per_adapter.values() {
                        let _ = socket.send_to(&bytes, broadcast_addr).await;
                    }
                }
            }
        });

        // Background Expiry Task (Checks every 2 seconds, expires > 6 seconds)
        let expiry_map = self.discovered.clone();
        let app_handle_exp = self.app_handle.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
            loop {
                interval.tick().await;
                let now = chrono::Utc::now().timestamp_millis();
                let mut expired_ids = Vec::new();
                {
                    let mut map = expiry_map.write().await;
                    map.retain(|id, peer| {
                        let keep = now - peer.last_seen < 6000;
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
            }
        });

        Ok(())
    }
}
