use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, RwLock};
use tauri::{AppHandle, Emitter};
use sha2::Digest;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::server::ServerConfig;
use rustls::client::ClientConfig;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::core::identity::DeviceIdentity;
use crate::core::packet::{LinkPacket, PacketStreamReader, PACKET_TYPE_PAIR, PACKET_TYPE_IDENTITY, PACKET_TYPE_HEARTBEAT};
use crate::core::pairing::compute_verification_code;
use crate::core::identity::compute_cert_fingerprint;
use crate::core::trust::{TrustStore, TrustedDevice};
use crate::core::discovery::DiscoveryManager;
use crate::core::fs_client::FsClient;
use crate::core::fs_transfer::Transfers;
use crate::core::guest::GuestHub;
use crate::core::input_guest::InputGuests;
use crate::core::joystick::Joystick;
use crate::core::mount::MountService;
use crate::core::audio_sink::AudioSink;
use crate::core::portal::Portal;
use crate::core::walkie_talkie::WalkieTalkie;
use crate::core::host::PluginState;
use crate::core::permissions::PermissionStore;
use crate::core::plugins::runcommand::RunCommands;
use crate::core::settings::{Blocklist, SettingsStore};
use crate::core::speedtest;

// TCP port of the TLS control channel, shared with the Android core (LinkTransport.LINK_PORT).
// Distinct from the UDP discovery port (discovery.rs), which Android also uses.
pub const LINK_PORT: u16 = 1739;

// The Android core pings every 5s while idle and drops a connection that has been silent for 15s,
// so the desktop must answer pings and send its own, or every paired connection dies after 15s.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

// Trust-on-first-use server certificate verifier: any certificate is accepted at the TLS layer
// (trust is pinned per device after pairing), but the handshake signature is still verified so the
// peer must hold the key of the certificate it presents. The full ring scheme list matters:
// Android's RSA certificate can only sign TLS 1.3 handshakes with RSA-PSS.
#[derive(Debug)]
struct TofuCertVerifier;

impl rustls::client::danger::ServerCertVerifier for TofuCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// Accepts any client certificate (trust is pinned per device after pairing, not by CA). Client
// certs are requested but optional, matching the Android server's setWantClientAuth(true): the
// peer's certificate is what its identity is bound to, since Android sends no certPem in its
// identity packet.
#[derive(Debug)]
struct AnyClientCert;

impl rustls::server::danger::ClientCertVerifier for AnyClientCert {
    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[]
    }

    fn client_auth_mandatory(&self) -> bool {
        false
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::server::danger::ClientCertVerified, rustls::Error> {
        Ok(rustls::server::danger::ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub struct PeerSession {
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub ip: String,
    pub cert_pem: String,
    pub cert_der: Vec<u8>,
    pub trusted: bool,
    pub incoming_capabilities: Vec<String>,
    pub outgoing_capabilities: Vec<String>,
    pub tx: mpsc::Sender<LinkPacket>,
    pub pairing_timestamp: Option<i64>,
}

fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

impl PeerSession {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "deviceId": self.device_id,
            "deviceName": self.device_name,
            "deviceType": self.device_type,
            "ipAddress": self.ip,
            "trusted": self.trusted,
            "incomingCapabilities": self.incoming_capabilities,
            "outgoingCapabilities": self.outgoing_capabilities,
        })
    }
}

pub struct DeviceManager {
    identity: DeviceIdentity,
    pub(crate) trust_store: Arc<RwLock<TrustStore>>,
    pub(crate) discovery: Arc<DiscoveryManager>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    active_peers: Arc<RwLock<HashMap<String, PeerSession>>>,
    server_config: Arc<ServerConfig>,
    client_config: Arc<ClientConfig>,
    my_cert_der: Vec<u8>,
    speedtest_waiters: Arc<tokio::sync::Mutex<HashMap<String, mpsc::Sender<LinkPacket>>>>,
    fs_clients: Arc<tokio::sync::Mutex<HashMap<String, Arc<FsClient>>>>,
    pub(crate) permission_store: Arc<std::sync::Mutex<PermissionStore>>,
    pub(crate) plugin_state: Arc<tokio::sync::Mutex<PluginState>>,
    pub(crate) run_commands: Arc<std::sync::Mutex<RunCommands>>,
    pub(crate) settings: Arc<std::sync::Mutex<SettingsStore>>,
    pub(crate) blocklist: Arc<std::sync::Mutex<Blocklist>>,
    pub(crate) device_name: Arc<tokio::sync::RwLock<String>>,
    pub(crate) transfers: Arc<Transfers>,
    pub(crate) mounts: Arc<tokio::sync::Mutex<HashMap<String, MountService>>>,
    pub(crate) guests: Arc<GuestHub>,
    pub(crate) input_guests: Arc<InputGuests>,
    pub(crate) joystick: Arc<Joystick>,
    pub(crate) walkie: Arc<WalkieTalkie>,
    pub(crate) portal: Arc<Portal>,
    pub(crate) audio: Arc<AudioSink>,
    pub(crate) config_dir: std::path::PathBuf,
}

impl DeviceManager {
    pub fn new(
        identity: DeviceIdentity,
        trust_store: Arc<RwLock<TrustStore>>,
        discovery: Arc<DiscoveryManager>,
            config_dir: &std::path::Path,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error + Send + Sync>> {
        let (certs, key, cert_der) = parse_pem(&identity.cert_pem, &identity.key_pem)?;

        // Server TLS 1.3 config
        let server_config = ServerConfig::builder()
            .with_client_cert_verifier(Arc::new(AnyClientCert))
            .with_single_cert(certs.clone(), key.clone_key())?;

        // Client TLS 1.3 config with TOFU verifier
        let client_config = ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(TofuCertVerifier))
            .with_client_auth_cert(certs, key)?;

        let initial_name = identity.device_name.clone();
        Ok(Arc::new(Self {
            identity,
            trust_store,
            discovery,
            app_handle: Arc::new(RwLock::new(None)),
            active_peers: Arc::new(RwLock::new(HashMap::new())),
            server_config: Arc::new(server_config),
            client_config: Arc::new(client_config),
            my_cert_der: cert_der,
            speedtest_waiters: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            fs_clients: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            permission_store: Arc::new(std::sync::Mutex::new(PermissionStore::load(config_dir))),
            plugin_state: Arc::new(tokio::sync::Mutex::new(PluginState::default())),
            run_commands: Arc::new(std::sync::Mutex::new(RunCommands::load(config_dir))),
            settings: Arc::new(std::sync::Mutex::new(SettingsStore::load(config_dir))),
            blocklist: Arc::new(std::sync::Mutex::new(Blocklist::load(config_dir))),
            device_name: Arc::new(tokio::sync::RwLock::new(initial_name)),
            transfers: Arc::new(Transfers::default()),
            mounts: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            guests: Arc::new(GuestHub::default()),
            input_guests: Arc::new(InputGuests::default()),
            joystick: Arc::new(Joystick::default()),
            walkie: Arc::new(WalkieTalkie::default()),
            portal: Arc::new(Portal::default()),
            audio: Arc::new(AudioSink::default()),
            config_dir: config_dir.to_path_buf(),
        }))
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        let app = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let mut w = app.write().await;
            *w = Some(handle);
        });
    }

    pub async fn start_server(self: Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let addr: SocketAddr = format!("0.0.0.0:{}", LINK_PORT).parse()?;
        let listener = TcpListener::bind(addr).await?;
        log::info!("Link TCP TLS Server listening on port {}", LINK_PORT);

        let manager = self.clone();
        tokio::spawn(async move {
            let acceptor = TlsAcceptor::from(manager.server_config.clone());
            loop {
                if let Ok((stream, remote_addr)) = listener.accept().await {
                    let acc = acceptor.clone();
                    let mgr = manager.clone();
                    tokio::spawn(async move {
                        match acc.accept(stream).await {
                            Ok(tls_stream) => {
                                let peer_cert = tls_stream.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
                                let (read_half, write_half) = tokio::io::split(tls_stream);
                                mgr.handle_connection(read_half, write_half, remote_addr.ip().to_string(), peer_cert).await;
                            }
                            Err(e) => log::warn!("TLS accept from {} failed: {}", remote_addr, e),
                        }
                    });
                }
            }
        });

        Ok(())
    }

    pub async fn connect_to(&self, host: &str, port: u16) -> Result<String, String> {
        let addr = format!("{}:{}", host, port);
        let stream = TcpStream::connect(&addr).await.map_err(|e| format!("Connect error: {}", e))?;
        let connector = TlsConnector::from(self.client_config.clone());
        let server_name = ServerName::try_from("link.local".to_string()).map_err(|e| e.to_string())?;

        let tls_stream = connector.connect(server_name, stream).await.map_err(|e| {
            log::warn!("TLS handshake with {} failed: {}", addr, e);
            format!("TLS Handshake error: {}", e)
        })?;
        let peer_cert = tls_stream.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
        let (read_half, write_half) = tokio::io::split(tls_stream);
        let mgr_self = self.clone_arc();
        let ip = host.to_string();
        tokio::spawn(async move {
            mgr_self.handle_connection(read_half, write_half, ip, peer_cert).await;
        });

        Ok("Connected".to_string())
    }

    fn clone_arc(&self) -> Arc<Self> {
        Arc::new(Self {
            identity: self.identity.clone(),
            trust_store: self.trust_store.clone(),
            discovery: self.discovery.clone(),
            app_handle: self.app_handle.clone(),
            active_peers: self.active_peers.clone(),
            server_config: self.server_config.clone(),
            client_config: self.client_config.clone(),
            my_cert_der: self.my_cert_der.clone(),
            speedtest_waiters: self.speedtest_waiters.clone(),
            fs_clients: self.fs_clients.clone(),
            permission_store: self.permission_store.clone(),
            plugin_state: self.plugin_state.clone(),
            run_commands: self.run_commands.clone(),
            settings: self.settings.clone(),
            blocklist: self.blocklist.clone(),
            device_name: self.device_name.clone(),
            transfers: self.transfers.clone(),
            mounts: self.mounts.clone(),
            guests: self.guests.clone(),
            input_guests: self.input_guests.clone(),
            joystick: self.joystick.clone(),
            walkie: self.walkie.clone(),
            portal: self.portal.clone(),
            audio: self.audio.clone(),
            config_dir: self.config_dir.clone(),
        })
    }

    async fn handle_connection<R, W>(
        self: Arc<Self>,
        mut reader: R,
        mut writer: W,
        remote_ip: String,
        peer_cert: Option<Vec<u8>>,
    ) where
        R: AsyncReadExt + Unpin + Send + 'static,
        W: AsyncWriteExt + Unpin + Send + 'static,
    {
        let (tx, mut rx) = mpsc::channel::<LinkPacket>(64);

        // Send our local identity packet immediately
        let identity_body = serde_json::json!({
            "deviceId": self.identity.device_id,
            "deviceName": self.device_name.read().await.clone(),
            "deviceType": self.identity.device_type,
            "protocolVersion": self.identity.protocol_version,
            "incomingCapabilities": self.identity.incoming_capabilities,
            "outgoingCapabilities": self.identity.outgoing_capabilities,
            "certPem": self.identity.cert_pem,
        });
        let initial_packet = LinkPacket::new(PACKET_TYPE_IDENTITY, identity_body);
        let _ = tx.send(initial_packet).await;

        // Task to write outgoing packets to socket
        tokio::spawn(async move {
            while let Some(pkt) = rx.recv().await {
                if let Ok(bytes) = pkt.serialize() {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = writer.flush().await;
                }
            }
        });

        let mut stream_reader = PacketStreamReader::new();
        let mut buf = [0u8; 4096];
        let mut peer_dev_id: Option<String> = None;

        let heartbeat_tx = tx.clone();
        let heartbeat = tokio::spawn(async move {
            let mut tick = tokio::time::interval(HEARTBEAT_INTERVAL);
            loop {
                tick.tick().await;
                let ping = LinkPacket::new(PACKET_TYPE_HEARTBEAT, serde_json::json!({ "reply": false }));
                if heartbeat_tx.send(ping).await.is_err() {
                    break;
                }
            }
        });

        loop {
            match tokio::time::timeout(HEARTBEAT_TIMEOUT, reader.read(&mut buf)).await {
                Err(_) => break, // silent past the heartbeat timeout: treat the peer as dead
                Ok(Ok(0)) => break, // EOF
                Ok(Ok(n)) => {
                    let packets = stream_reader.push(&buf[..n]);
                    for pkt in packets {
                        self.process_incoming_packet(&pkt, &remote_ip, peer_cert.as_deref(), &tx, &mut peer_dev_id).await;
                    }
                }
                Ok(Err(_)) => break,
            }
        }
        heartbeat.abort();

        // Cleanup disconnected peer
        if let Some(dev_id) = peer_dev_id {
            let mut peers = self.active_peers.write().await;
            // A newer connection may have replaced this one; only remove our own entry.
            if peers.get(&dev_id).is_some_and(|p| p.tx.same_channel(&tx)) {
                peers.remove(&dev_id);
            } else {
                return;
            }
            drop(peers);
            self.unmount_device(&dev_id).await;
            if let Some(app) = self.app_handle.read().await.as_ref() {
                let _ = app.emit("device-disconnected", serde_json::json!({ "deviceId": dev_id }));
            }
        }
    }

    async fn process_incoming_packet(
        self: &Arc<Self>,
        pkt: &LinkPacket,
        remote_ip: &str,
        peer_cert: Option<&[u8]>,
        tx: &mpsc::Sender<LinkPacket>,
        peer_dev_id: &mut Option<String>,
    ) {
        match pkt.packet_type.as_str() {
            PACKET_TYPE_IDENTITY => {
                if let (Some(dev_id), Some(name)) = (
                    pkt.body.get("deviceId").and_then(|v| v.as_str()),
                    pkt.body.get("deviceName").and_then(|v| v.as_str()),
                ) {
                    let dev_type = pkt.body.get("deviceType").and_then(|v| v.as_str()).unwrap_or("phone").to_string();
                    // The TLS session's certificate is authoritative; Android sends no certPem.
                    let body_pem = pkt.body.get("certPem").and_then(|v| v.as_str()).unwrap_or("");
                    let cert_der = peer_cert.map(<[u8]>::to_vec).unwrap_or_else(|| parse_raw_der(body_pem));
                    let cert_pem = if body_pem.is_empty() { der_to_pem(&cert_der) } else { body_pem.to_string() };

                    if self.is_blocked(dev_id) || self.is_blocked(remote_ip) {
                        return;
                    }
                    let is_trusted = {
                        let store = self.trust_store.read().await;
                        store.is_paired(dev_id)
                    };

                    *peer_dev_id = Some(dev_id.to_string());

                    let session = PeerSession {
                        device_id: dev_id.to_string(),
                        device_name: name.to_string(),
                        device_type: dev_type.clone(),
                        ip: remote_ip.to_string(),
                        cert_pem: cert_pem.clone(),
                        cert_der,
                        trusted: is_trusted,
                        incoming_capabilities: string_list(pkt.body.get("incomingCapabilities")),
                        outgoing_capabilities: string_list(pkt.body.get("outgoingCapabilities")),
                        tx: tx.clone(),
                        pairing_timestamp: None,
                    };

                    let connected = session.to_json();
                    let mut peers = self.active_peers.write().await;
                    peers.insert(dev_id.to_string(), session);

                    if let Some(app) = self.app_handle.read().await.as_ref() {
                        let _ = app.emit("device-connected", connected);
                    }
                    drop(peers);
                    if is_trusted {
                        self.initial_sync(dev_id).await;
                    }
                }
            }
            PACKET_TYPE_HEARTBEAT => {
                let is_reply = pkt.body.get("reply").and_then(|v| v.as_bool()).unwrap_or(false);
                if !is_reply {
                    let _ = tx.send(LinkPacket::new(PACKET_TYPE_HEARTBEAT, serde_json::json!({ "reply": true }))).await;
                }
            }
            PACKET_TYPE_PAIR => {
                let wants_pair = pkt.body.get("pair").and_then(|v| v.as_bool()).unwrap_or(false);
                let timestamp = pkt.body.get("timestamp").and_then(|v| v.as_i64());

                if let Some(ref dev_id) = *peer_dev_id {
                    let mut peers = self.active_peers.write().await;
                    if let Some(peer) = peers.get_mut(dev_id) {
                        if wants_pair {
                            if let Some(ts) = timestamp {
                                // Incoming pair request from peer
                                peer.pairing_timestamp = Some(ts);
                                let verification_pin = compute_verification_code(&public_key_der(&self.my_cert_der), &public_key_der(&peer.cert_der), &ts.to_string());

                                if let Some(app) = self.app_handle.read().await.as_ref() {
                                    let _ = app.emit("incoming-pair-request", serde_json::json!({
                                        "deviceId": peer.device_id,
                                        "deviceName": peer.device_name,
                                        "deviceType": peer.device_type,
                                        "verificationKey": verification_pin,
                                    }));
                                }
                            } else {
                                // Peer accepted our pair request!
                                peer.trusted = true;
                                {
                                    let mut store = self.trust_store.write().await;
                                    store.pair(TrustedDevice {
                                        device_id: peer.device_id.clone(),
                                        device_name: peer.device_name.clone(),
                                        cert_pem: peer.cert_pem.clone(),
                                        protocol_version: 1,
                                        paired_at: chrono::Utc::now().timestamp_millis(),
                                        ip_address: Some(remote_ip.to_string()),
                                    });
                                }

                                if let Some(app) = self.app_handle.read().await.as_ref() {
                                    let _ = app.emit("pairing-successful", serde_json::json!({
                                        "deviceId": peer.device_id,
                                    }));
                                }
                                let paired_id = peer.device_id.clone();
                                let mgr = self.clone();
                                tokio::spawn(async move { mgr.on_paired(&paired_id).await });
                            }
                        } else {
                            // Pairing rejected / unpair
                            peer.trusted = false;
                            {
                                let mut store = self.trust_store.write().await;
                                store.unpair(&peer.device_id);
                                self.forget_permissions(&peer.device_id);
                            }
                            if let Some(app) = self.app_handle.read().await.as_ref() {
                                let _ = app.emit("unpaired", serde_json::json!({
                                    "deviceId": peer.device_id,
                                }));
                            }
                        }
                    }
                }
            }
            speedtest::REQUEST => {
                let Some(dev_id) = peer_dev_id.clone() else { return };
                if self.active_peers.read().await.get(&dev_id).is_some_and(|p| p.trusted) {
                    let mgr = self.clone();
                    let pkt = pkt.clone();
                    tokio::spawn(async move { mgr.answer_speed_test(&dev_id, pkt).await });
                }
            }
            speedtest::RESPONSE => {
                if let Some(test_id) = pkt.body.get("testId").and_then(|v| v.as_str()) {
                    if let Some(tx) = self.speedtest_waiters.lock().await.get(test_id) {
                        let _ = tx.send(pkt.clone()).await;
                    }
                }
            }
            // Plugin traffic (battery, lock, flashlight, ...) is interpreted by the UI layer; the
            // core only gates it on the peer being paired.
            other => {
                let Some(dev_id) = peer_dev_id.as_deref() else { return };
                let trusted = self.active_peers.read().await.get(dev_id).is_some_and(|p| p.trusted);
                if trusted {
                    if self.handle_host_packet(dev_id, pkt).await {
                        return;
                    }
                    if let Some(app) = self.app_handle.read().await.as_ref() {
                        let _ = app.emit("peer-packet", serde_json::json!({
                            "deviceId": dev_id,
                            "type": other,
                            "body": pkt.body,
                        }));
                    }
                }
            }
        }
    }

    pub async fn connected_peers(&self) -> Vec<serde_json::Value> {
        let mut peers: Vec<serde_json::Value> = self.active_peers.read().await.values().map(PeerSession::to_json).collect();
        let mounts = self.mounts.lock().await;
        for peer in &mut peers {
            if let Some(mount) = peer["deviceId"].as_str().and_then(|id| mounts.get(id)) {
                peer["driveLetter"] = serde_json::json!(mount.drive_letter);
            }
        }
        peers
    }

    pub fn is_blocked(&self, id_or_ip: &str) -> bool {
        self.blocklist.lock().is_ok_and(|b| b.is_blocked(id_or_ip))
    }

    pub(crate) async fn set_peer_name(&self, device_id: &str, name: &str) {
        if let Some(peer) = self.active_peers.write().await.get_mut(device_id) {
            peer.device_name = name.to_string();
        }
    }

    pub(crate) fn own_cert_der(&self) -> Vec<u8> {
        self.my_cert_der.clone()
    }

    pub(crate) fn tls_acceptor(&self) -> TlsAcceptor {
        TlsAcceptor::from(self.server_config.clone())
    }

    pub(crate) fn tls_client_config(&self) -> Arc<ClientConfig> {
        self.client_config.clone()
    }

    pub(crate) fn fs_clients(&self) -> &tokio::sync::Mutex<HashMap<String, Arc<FsClient>>> {
        &self.fs_clients
    }

    pub(crate) fn tls_connector(&self) -> TlsConnector {
        TlsConnector::from(self.client_config.clone())
    }

    pub(crate) async fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle.read().await.clone()
    }

    /// Address and pinned certificate fingerprint of a paired peer, for opening payload channels.
    pub(crate) async fn peer_endpoint(&self, device_id: &str) -> Option<(String, String)> {
        let peers = self.active_peers.read().await;
        let peer = peers.get(device_id).filter(|p| p.trusted)?;
        let store = self.trust_store.read().await;
        let pinned = store
            .get(device_id)
            .map(|d| compute_cert_fingerprint(&d.cert_pem))
            .unwrap_or_else(|| hex::encode(sha2::Sha256::digest(&peer.cert_der)));
        Some((peer.ip.clone(), pinned))
    }

    pub(crate) async fn register_speedtest(&self, test_id: &str) -> mpsc::Receiver<LinkPacket> {
        let (tx, rx) = mpsc::channel(8);
        self.speedtest_waiters.lock().await.insert(test_id.to_string(), tx);
        rx
    }

    pub(crate) async fn unregister_speedtest(&self, test_id: &str) {
        self.speedtest_waiters.lock().await.remove(test_id);
    }

    pub(crate) async fn send_link_packet(&self, target_device_id: &str, packet: LinkPacket) -> Result<(), String> {
        let tx = {
            let peers = self.active_peers.read().await;
            let peer = peers.get(target_device_id).ok_or_else(|| format!("Device {} is not connected", target_device_id))?;
            if !peer.trusted {
                return Err(format!("Device {} is not paired", target_device_id));
            }
            peer.tx.clone()
        };
        tx.send(packet).await.map_err(|_| "Connection closed".to_string())
    }

    /// Sends a plugin packet to a paired, connected peer.
    pub async fn send_packet(&self, target_device_id: &str, packet_type: &str, body: serde_json::Value) -> Result<(), String> {
        self.send_link_packet(target_device_id, LinkPacket::new(packet_type, body)).await
    }

    // The identity handshake finishes some time after the TLS connection does, and only then does
    // the peer appear in active_peers, so callers poll instead of assuming a fixed delay.
    async fn find_peer<F: Fn(&PeerSession) -> bool>(&self, matches: F) -> Option<String> {
        for _ in 0..50 {
            if let Some(id) = self.active_peers.read().await.values().find(|p| matches(p)).map(|p| p.device_id.clone()) {
                return Some(id);
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
        None
    }

    /// Connects to a discovered-but-not-yet-connected device, then sends the pair request.
    /// Returns the verification PIN both screens show.
    pub async fn request_pairing(&self, target_device_id: &str) -> Result<String, String> {
        if !self.active_peers.read().await.contains_key(target_device_id) {
            let ip = {
                let peers_map = self.discovery.get_discovered_peers();
                let map = peers_map.read().await;
                map.get(target_device_id).map(|p| p.ip.clone())
            }
            .ok_or_else(|| format!("Device {} is not in range", target_device_id))?;
            self.connect_to(&ip, LINK_PORT).await?;
            self.find_peer(|p| p.device_id == target_device_id)
                .await
                .ok_or_else(|| format!("Device {} connected but never identified itself", target_device_id))?;
        }
        self.send_pair_request(target_device_id).await
    }

    /// Manual pairing by address: the device ID isn't known until the peer identifies itself.
    pub async fn request_pairing_by_ip(&self, ip: &str) -> Result<(String, String), String> {
        self.connect_to(ip, LINK_PORT).await?;
        let device_id = self
            .find_peer(|p| p.ip == ip)
            .await
            .ok_or_else(|| format!("{} connected but never identified itself", ip))?;
        let pin = self.send_pair_request(&device_id).await?;
        Ok((pin, device_id))
    }

    async fn send_pair_request(&self, target_device_id: &str) -> Result<String, String> {
        let now_secs = chrono::Utc::now().timestamp();
        let mut peers = self.active_peers.write().await;
        let peer = peers
            .get_mut(target_device_id)
            .ok_or_else(|| format!("Device {} not found or offline", target_device_id))?;
        peer.pairing_timestamp = Some(now_secs);
        let pin = compute_verification_code(&public_key_der(&self.my_cert_der), &public_key_der(&peer.cert_der), &now_secs.to_string());
        let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({
            "pair": true,
            "timestamp": now_secs,
        }));
        let _ = peer.tx.send(pair_pkt).await;
        Ok(pin)
    }

    pub async fn accept_pairing(self: &Arc<Self>, target_device_id: &str) -> Result<(), String> {
        let mut peers = self.active_peers.write().await;
        if let Some(peer) = peers.get_mut(target_device_id) {
            peer.trusted = true;
            let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({
                "pair": true,
            }));
            let _ = peer.tx.send(pair_pkt).await;

            {
                let mut store = self.trust_store.write().await;
                store.pair(TrustedDevice {
                    device_id: peer.device_id.clone(),
                    device_name: peer.device_name.clone(),
                    cert_pem: peer.cert_pem.clone(),
                    protocol_version: 1,
                    paired_at: chrono::Utc::now().timestamp_millis(),
                    ip_address: Some(peer.ip.clone()),
                });
            }

            if let Some(app) = self.app_handle.read().await.as_ref() {
                let _ = app.emit("pairing-successful", serde_json::json!({
                    "deviceId": peer.device_id,
                }));
            }

            let paired_id = peer.device_id.clone();
            let mgr = self.clone();
            tokio::spawn(async move { mgr.on_paired(&paired_id).await });
            return Ok(());
        }
        Err(format!("Peer session {} not active", target_device_id))
    }

    pub async fn reject_pairing(&self, target_device_id: &str) -> Result<(), String> {
        let mut peers = self.active_peers.write().await;
        if let Some(peer) = peers.get_mut(target_device_id) {
            peer.trusted = false;
            let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({
                "pair": false,
            }));
            let _ = peer.tx.send(pair_pkt).await;

            if let Some(app) = self.app_handle.read().await.as_ref() {
                let _ = app.emit("pairing-failed", serde_json::json!({
                    "deviceId": peer.device_id,
                    "reason": "Cancelled by user",
                }));
            }
            return Ok(());
        }
        Ok(())
    }

    pub async fn unpair(&self, target_device_id: &str) -> Result<(), String> {
        {
            let mut store = self.trust_store.write().await;
            store.unpair(target_device_id);
        }
        self.forget_permissions(target_device_id);

        let mut peers = self.active_peers.write().await;
        if let Some(peer) = peers.get_mut(target_device_id) {
            peer.trusted = false;
            let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({
                "pair": false,
            }));
            let _ = peer.tx.send(pair_pkt).await;
        }

        if let Some(app) = self.app_handle.read().await.as_ref() {
            let _ = app.emit("unpaired", serde_json::json!({
                "deviceId": target_device_id,
            }));
        }

        Ok(())
    }
}

// The verification PIN hashes each device's public key (SubjectPublicKeyInfo), not the whole
// certificate, so both ends compute the same code regardless of how each encodes its certificate.
pub(crate) fn public_key_der(cert_der: &[u8]) -> Vec<u8> {
    x509_parser::parse_x509_certificate(cert_der)
        .map(|(_, cert)| cert.tbs_certificate.subject_pki.raw.to_vec())
        .unwrap_or_else(|_| cert_der.to_vec())
}

fn der_to_pem(der: &[u8]) -> String {
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der);
    let body = b64.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("\n");
    format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n")
}

fn parse_raw_der(pem_str: &str) -> Vec<u8> {
    let clean = pem_str
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, clean.as_bytes()).unwrap_or_default()
}

fn parse_pem(
    cert_pem: &str,
    key_pem: &str,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>, Vec<u8>), Box<dyn std::error::Error + Send + Sync>> {
    let cert_der = parse_raw_der(cert_pem);
    let key_der = parse_raw_der(key_pem);

    let cert = CertificateDer::from(cert_der.clone());
    let key = PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(key_der));

    Ok((vec![cert], key, cert_der))
}
