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
    identity: DeviceIdentity,
    device_name: Arc<RwLock<String>>,
    discovered: Arc<RwLock<HashMap<String, DiscoveredPeer>>>,
    visibility: Arc<RwLock<bool>>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl DiscoveryManager {
    pub fn new(identity: DeviceIdentity) -> Self {
        Self {
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
            loop {
                interval.tick().await;

                if !*visibility.read().await {
                    continue;
                }

                let name = device_name.read().await.clone();
                let body = serde_json::json!({
                    "deviceId": identity.device_id,
                    "deviceName": name,
                    "deviceType": identity.device_type,
                    "protocolVersion": identity.protocol_version,
                    "incomingCapabilities": identity.incoming_capabilities,
                    "outgoingCapabilities": identity.outgoing_capabilities,
                });

                let packet = LinkPacket::new("link.identity", body);
                if let Ok(bytes) = packet.serialize() {
                    let broadcast_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT);
                    let _ = tx_socket.send_to(&bytes, broadcast_addr).await;
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
