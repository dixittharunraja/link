use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify, RwLock};
use tauri::{AppHandle, Emitter};
use sha2::Digest;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::server::ServerConfig;
use rustls::client::ClientConfig;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::core::identity::DeviceIdentity;
use crate::core::packet::{LinkPacket, PacketStreamReader, PACKET_TYPE_PAIR, PACKET_TYPE_IDENTITY, PACKET_TYPE_HEARTBEAT};
use crate::core::pairing::compute_verification_code;
use crate::core::pairing_window::Admission;
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
use crate::core::share;

// TCP port of the TLS control channel, shared with the Android core (LinkTransport.LINK_PORT).
// Distinct from the UDP discovery port (discovery.rs), which Android also uses.
pub const LINK_PORT: u16 = 1739;

// Both sides answer pings and send their own while idle: a ping every 4 s and a 12 s timeout
// (LinkPlugin.java's heartbeat cycle uses the same pair).
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(4);
const HEARTBEAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
// A connection silent this long loses a duplicate-connection tie-break to a fresh one (matches the
// Android core's LinkTransport.STALE_AFTER_MS). Well above the 10 s heartbeat, so a live connection
// that is merely between pings is never mistaken for a dead one.
const STALE_AFTER_MS: i64 = 10_000;
// No ping is needed while the peer is talking anyway: anything it sends proves it is alive.
const HEARTBEAT_SKIP_IF_RX_WITHIN_MS: i64 = 2_000;
const DIAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
// A TLS handshake that has not finished by then is not going to; generous for a slow phone.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
// A connection that has not identified itself by then is dropped, so silent or trickling sockets
// cannot pile up.
const IDENTIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
// Inbound connections that have not identified themselves yet; more are refused until one does.
const MAX_UNIDENTIFIED: usize = 32;
// Per connection, how many slow requests (see SPAWNED_PACKETS) may run at once before the read
// loop waits for one to finish.
const MAX_SLOW_IN_FLIGHT: usize = 8;
// Plugin packets whose handling can take a while (disk, a full resync) and whose order relative to
// the packets after them does not matter: each is answered on its own (fs replies carry their
// requestId). They run off the read loop so a big directory listing does not hold up input,
// heartbeats or audio. Anything order-sensitive (volume drags, media keys, input, signalling)
// stays inline.
const SPAWNED_PACKETS: &[&str] = &["link.fs.request", "link.resync.request", "link.audiosink.query"];
// The scanned QR's addresses are dialled this far apart, the first to identify itself winning.
const QR_DIAL_STAGGER: std::time::Duration = std::time::Duration::from_millis(250);
// How long a dialled device has to identify itself.
const FIND_PEER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
// How long a pair request may go unanswered before the requester is told it failed.
const PAIR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
// Bytes taken from a control connection per read.
const READ_BUF: usize = 64 * 1024;

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

/// What a scanned QR proves about the device it was shown on: its key fingerprint, and the one-time token.
pub struct ScanProof {
    pub fingerprint: String,
    pub token: String,
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
    // Timestamp of the pair request this side sent and has no answer to yet.
    outgoing_pairing: Option<i64>,
    // Whether this connection was already told it is not paired here.
    notified_not_paired: bool,
    // When this connection last received anything, and a way to end it.
    pub(crate) last_rx: Arc<AtomicI64>,
    pub(crate) shutdown: Arc<Notify>,
    // UDP input secrets (core/input_relay.rs): the one this side issued and expects on lines from
    // the peer, and the one the peer issued for lines sent to it.
    pub(crate) input_token: String,
    pub(crate) peer_input_token: Option<String>,
    // The Tailscale address the peer advertised, kept so pairing can remember it.
    tailscale_ip: Option<String>,
}

/// What the connection's own read loop shares with the packet handler.
#[derive(Clone)]
struct Link {
    outbound: bool,
    last_rx: Arc<AtomicI64>,
    shutdown: Arc<Notify>,
    // Bounds this connection's SPAWNED_PACKETS handlers.
    slow: Arc<tokio::sync::Semaphore>,
}

/// The packet types the UI listens for (bridge.ts reports them whenever its handlers change): a
/// type as is, or a prefix ending in "*". Plugin packets nobody listens for are not emitted.
#[derive(Default)]
pub struct PacketSubscriptions {
    exact: std::collections::HashSet<String>,
    prefixes: Vec<String>,
}

impl PacketSubscriptions {
    pub fn new(keys: Vec<String>) -> Self {
        let mut subs = Self::default();
        for key in keys {
            match key.strip_suffix('*') {
                Some(prefix) => subs.prefixes.push(prefix.to_string()),
                None => {
                    subs.exact.insert(key);
                }
            }
        }
        subs
    }

    pub fn wants(&self, packet_type: &str) -> bool {
        self.exact.contains(packet_type) || self.prefixes.iter().any(|p| packet_type.starts_with(p.as_str()))
    }
}

fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

impl PeerSession {
    pub(crate) fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "deviceId": self.device_id,
            "deviceName": self.device_name,
            "deviceType": self.device_type,
            "ipAddress": self.ip,
            "link": if crate::core::identity::is_tailscale_addr(&self.ip) { "remote" } else { "lan" },
            "trusted": self.trusted,
            "incomingCapabilities": self.incoming_capabilities,
            "outgoingCapabilities": self.outgoing_capabilities,
        })
    }
}

pub struct DeviceManager {
    pub(crate) identity: DeviceIdentity,
    pub(crate) trust_store: Arc<RwLock<TrustStore>>,
    // When new devices may pair, and the one-time token in this device's QR (core/pairing_window.rs).
    pub(crate) pairing_window: Arc<std::sync::Mutex<crate::core::pairing_window::PairingWindow>>,
    pub(crate) discovery: Arc<DiscoveryManager>,
    pub(crate) app_handle: Arc<RwLock<Option<AppHandle>>>,
    pub(crate) active_peers: Arc<RwLock<HashMap<String, PeerSession>>>,
    // Woken whenever a connection identifies itself, for callers waiting on a peer to appear.
    peers_changed: Arc<Notify>,
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
    // What the UI listens for. None until the UI first reports, so nothing is lost while it loads.
    ui_packets: std::sync::RwLock<Option<PacketSubscriptions>>,
}

impl DeviceManager {
    pub fn new(
        identity: DeviceIdentity,
        trust_store: Arc<RwLock<TrustStore>>,
        discovery: Arc<DiscoveryManager>,
            config_dir: &std::path::Path,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error + Send + Sync>> {
        let (certs, key, cert_der) = parse_pem(&identity.cert_pem, &identity.key_pem)?;

        let server_config = ServerConfig::builder()
            .with_client_cert_verifier(Arc::new(AnyClientCert))
            .with_single_cert(certs.clone(), key.clone_key())?;

        let client_config = ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(TofuCertVerifier))
            .with_client_auth_cert(certs, key)?;

        let initial_name = identity.device_name.clone();
        Ok(Arc::new(Self {
            identity,
            trust_store,
            pairing_window: Arc::new(std::sync::Mutex::new(Default::default())),
            discovery,
            app_handle: Arc::new(RwLock::new(None)),
            active_peers: Arc::new(RwLock::new(HashMap::new())),
            peers_changed: Arc::new(Notify::new()),
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
            ui_packets: std::sync::RwLock::new(None),
        }))
    }

    /// The UI's current packet subscriptions (types, or prefixes ending in "*").
    pub fn set_packet_subscriptions(&self, keys: Vec<String>) {
        if let Ok(mut subs) = self.ui_packets.write() {
            *subs = Some(PacketSubscriptions::new(keys));
        }
    }

    /// Hands a plugin packet the core did not consume to the UI, if anything there listens for it.
    async fn emit_peer_packet(&self, device_id: &str, pkt: &LinkPacket) {
        let wanted = self.ui_packets.read().map_or(true, |subs| subs.as_ref().is_none_or(|s| s.wants(&pkt.packet_type)));
        if !wanted {
            return;
        }
        if let Some(app) = self.app_handle.read().await.as_ref() {
            let _ = app.emit("peer-packet", serde_json::json!({
                "deviceId": device_id,
                "type": pkt.packet_type,
                "body": pkt.body,
            }));
        }
    }

    /// Opens pairing and returns the token for the QR now on screen.
    pub fn open_pairing_window(&self) -> String {
        let token = self.pairing_window.lock().map(|mut w| w.open(std::time::Instant::now())).unwrap_or_default();
        // The reconnect loop announces to the whole tailnet while the window is open (reconnect.rs).
        self.discovery.redial_signal().notify_one();
        token
    }

    /// A fresh QR token (the last was used or is expiring); None when pairing is closed.
    pub fn refresh_pairing_token(&self) -> Option<String> {
        self.pairing_window.lock().ok().and_then(|mut w| w.refresh(std::time::Instant::now()))
    }

    pub fn close_pairing_window(&self) {
        if let Ok(mut window) = self.pairing_window.lock() {
            window.close();
        }
    }

    /// This device's key fingerprint, the one the QR carries.
    pub fn fingerprint(&self) -> &str {
        &self.identity.fingerprint
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
            // Held by each inbound connection until it identifies itself.
            let unidentified = Arc::new(tokio::sync::Semaphore::new(MAX_UNIDENTIFIED));
            loop {
                if let Ok((stream, remote_addr)) = listener.accept().await {
                    let Ok(permit) = unidentified.clone().try_acquire_owned() else {
                        log::warn!("Refusing a connection from {}: too many connections have not identified themselves", remote_addr);
                        continue;
                    };
                    let _ = stream.set_nodelay(true);
                    let acc = acceptor.clone();
                    let mgr = manager.clone();
                    tokio::spawn(async move {
                        match tokio::time::timeout(HANDSHAKE_TIMEOUT, acc.accept(stream)).await {
                            Ok(Ok(tls_stream)) => {
                                let peer_cert = tls_stream.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
                                let (read_half, write_half) = tokio::io::split(tls_stream);
                                mgr.handle_connection(read_half, write_half, remote_addr.ip().to_string(), peer_cert, false, Some(permit)).await;
                            }
                            Ok(Err(e)) => log::warn!("TLS accept from {} failed: {}", remote_addr, e),
                            Err(_) => log::warn!("TLS accept from {} timed out", remote_addr),
                        }
                    });
                }
            }
        });

        Ok(())
    }

    pub async fn connect_to(self: &Arc<Self>, host: &str, port: u16) -> Result<String, String> {
        let addr = format!("{}:{}", host, port);
        let stream = tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(&addr))
            .await
            .map_err(|_| format!("Connect error: {} did not answer", addr))?
            .map_err(|e| format!("Connect error: {}", e))?;
        let _ = stream.set_nodelay(true);
        let connector = TlsConnector::from(self.client_config.clone());
        let server_name = ServerName::try_from("link.local".to_string()).map_err(|e| e.to_string())?;

        let tls_stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connector.connect(server_name, stream))
            .await
            .map_err(|_| format!("TLS Handshake error: {} did not finish the handshake", addr))?
            .map_err(|e| {
                log::warn!("TLS handshake with {} failed: {}", addr, e);
                format!("TLS Handshake error: {}", e)
            })?;
        let peer_cert = tls_stream.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec());
        let (read_half, write_half) = tokio::io::split(tls_stream);
        let (mgr, ip) = (self.clone(), host.to_string());
        tokio::spawn(async move {
            mgr.handle_connection(read_half, write_half, ip, peer_cert, true, None).await;
        });

        Ok("Connected".to_string())
    }

    async fn handle_connection<R, W>(
        self: Arc<Self>,
        mut reader: R,
        mut writer: W,
        remote_ip: String,
        peer_cert: Option<Vec<u8>>,
        outbound: bool,
        // An inbound connection's place among those not yet identified, given up once it identifies.
        mut unidentified_permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) where
        R: AsyncReadExt + Unpin + Send + 'static,
        W: AsyncWriteExt + Unpin + Send + 'static,
    {
        let (tx, mut rx) = mpsc::channel::<LinkPacket>(64);

        let identity_body = serde_json::json!({
            "deviceId": self.identity.device_id,
            "deviceName": self.device_name.read().await.clone(),
            "deviceType": self.identity.device_type,
            "incomingCapabilities": self.identity.incoming_capabilities,
            "outgoingCapabilities": self.identity.outgoing_capabilities,
            "tailscaleIp": crate::core::identity::tailscale_ip(),
        });
        let initial_packet = LinkPacket::new(PACKET_TYPE_IDENTITY, identity_body);
        let _ = tx.send(initial_packet).await;

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
        // On the heap so the connection's future stays small; big enough for several TLS records
        // (16 KB each) per read, so a burst of packets is not taken 4 KB at a time.
        let mut buf = vec![0u8; READ_BUF];
        let mut peer_dev_id: Option<String> = None;
        let mut end_reason = "superseded by a better connection";
        let link = Link {
            outbound,
            last_rx: Arc::new(AtomicI64::new(chrono::Utc::now().timestamp_millis())),
            shutdown: Arc::new(Notify::new()),
            slow: Arc::new(tokio::sync::Semaphore::new(MAX_SLOW_IN_FLIGHT)),
        };

        let heartbeat_tx = tx.clone();
        let heartbeat_rx = link.last_rx.clone();
        let heartbeat = tokio::spawn(async move {
            let mut tick = tokio::time::interval(HEARTBEAT_INTERVAL);
            loop {
                tick.tick().await;
                // The peer was heard from moments ago; a ping would only cost a radio wakeup.
                if chrono::Utc::now().timestamp_millis() - heartbeat_rx.load(Ordering::Relaxed) < HEARTBEAT_SKIP_IF_RX_WITHIN_MS {
                    if heartbeat_tx.is_closed() {
                        break;
                    }
                    continue;
                }
                let ping = LinkPacket::new(PACKET_TYPE_HEARTBEAT, serde_json::json!({ "reply": false }));
                if heartbeat_tx.send(ping).await.is_err() {
                    break;
                }
            }
        });

        let identify_deadline = tokio::time::Instant::now() + IDENTIFY_TIMEOUT;
        loop {
            // Until the peer identifies itself it gets IDENTIFY_TIMEOUT in all, however it trickles bytes.
            let deadline = if peer_dev_id.is_none() {
                identify_deadline.min(tokio::time::Instant::now() + HEARTBEAT_TIMEOUT)
            } else {
                tokio::time::Instant::now() + HEARTBEAT_TIMEOUT
            };
            let read = tokio::select! {
                _ = link.shutdown.notified() => break, // superseded by a better connection to the same device
                read = tokio::time::timeout_at(deadline, reader.read(&mut buf)) => read,
            };
            match read {
                Err(_) => {
                    end_reason = if peer_dev_id.is_none() { "never identified itself" } else { "silent past the heartbeat timeout" };
                    break;
                }
                Ok(Ok(0)) => {
                    end_reason = "closed by the peer";
                    break;
                }
                Ok(Ok(n)) => {
                    link.last_rx.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
                    let packets = stream_reader.push(&buf[..n]);
                    for pkt in packets {
                        self.process_incoming_packet(&pkt, &remote_ip, peer_cert.as_deref(), &tx, &mut peer_dev_id, &link).await;
                    }
                    if stream_reader.overflowed() {
                        end_reason = "sent a packet past the size limit";
                        break;
                    }
                    if peer_dev_id.is_some() {
                        stream_reader.set_limit(crate::core::packet::MAX_LINE);
                        unidentified_permit.take();
                    }
                }
                Ok(Err(e)) => {
                    log::debug!("Read from {} failed: {}", remote_ip, e);
                    end_reason = "read error";
                    break;
                }
            }
        }
        heartbeat.abort();

        if let Some(dev_id) = peer_dev_id {
            let mut peers = self.active_peers.write().await;
            // A newer connection may have replaced this one; only remove this connection's entry.
            if peers.get(&dev_id).is_some_and(|p| p.tx.same_channel(&tx)) {
                log::info!("Disconnected from {} ({}): {}", dev_id, remote_ip, end_reason);
                peers.remove(&dev_id);
            } else {
                return;
            }
            drop(peers);
            // A paired device that dropped off is redialled at once, not on the reconnect loop's next tick.
            self.discovery.redial_signal().notify_one();
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
        link: &Link,
    ) {
        match pkt.packet_type.as_str() {
            PACKET_TYPE_IDENTITY => {
                if let (Some(dev_id), Some(name)) = (
                    pkt.body.get("deviceId").and_then(|v| v.as_str()),
                    pkt.body.get("deviceName").and_then(|v| v.as_str()).map(|n| crate::core::identity::received_device_name(n).unwrap_or_else(|| "Unknown device".into())),
                ) {
                    let name = name.as_str();
                    let dev_type = pkt.body.get("deviceType").and_then(|v| v.as_str()).unwrap_or("phone").to_string();
                    // The peer is the certificate it presented in the TLS handshake. Both apps always
                    // present one (as client too), so a connection without it is not a Link device.
                    let Some(cert_der) = peer_cert.map(<[u8]>::to_vec) else {
                        log::warn!("{} at {} presented no certificate; dropping it", dev_id, remote_ip);
                        link.shutdown.notify_one();
                        return;
                    };
                    let cert_pem = der_to_pem(&cert_der);

                    if self.is_blocked(dev_id) || self.is_blocked(remote_ip) {
                        // Nothing will ever be accepted on it, so it is not left holding a socket.
                        link.shutdown.notify_one();
                        return;
                    }
                    // A paired device is recognised by its pinned certificate, not by the id it
                    // claims: anyone can send an id.
                    let (is_trusted, pinned_matches) = {
                        let store = self.trust_store.read().await;
                        let paired = store.is_paired(dev_id);
                        let matches = store.get(dev_id).is_none_or(|d| compute_cert_fingerprint(&d.cert_pem) == hex::encode(sha2::Sha256::digest(&cert_der)));
                        (paired, matches)
                    };
                    if !pinned_matches {
                        log::warn!("{} at {} presented a certificate that differs from the one it was paired with; refusing it", dev_id, remote_ip);
                        if let Some(app) = self.app_handle.read().await.as_ref() {
                            let _ = app.emit("trust-mismatch", serde_json::json!({ "deviceId": dev_id }));
                        }
                        link.shutdown.notify_one();
                        return;
                    }

                    *peer_dev_id = Some(dev_id.to_string());

                    // The address this peer can be reached at through Tailscale: the one it dialled or
                    // was dialled from if that is a tailnet address, else the one it advertises.
                    let peer_tailscale_ip = Some(remote_ip.to_string())
                        .filter(|ip| crate::core::identity::is_tailscale_addr(ip))
                        .or_else(|| pkt.body.get("tailscaleIp").and_then(|v| v.as_str()).filter(|ip| crate::core::identity::is_tailscale_addr(ip)).map(str::to_string));
                    if let Some(ip) = peer_tailscale_ip.as_deref().filter(|_| is_trusted) {
                        self.trust_store.write().await.set_tailscale_ip(dev_id, ip);
                    }

                    let mut session = PeerSession {
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
                        outgoing_pairing: None,
                        notified_not_paired: false,
                        last_rx: link.last_rx.clone(),
                        shutdown: link.shutdown.clone(),
                        input_token: crate::core::input_relay::new_input_token(),
                        peer_input_token: None,
                        tailscale_ip: peer_tailscale_ip.clone(),
                    };

                    let connected = session.to_json();
                    let mut peers = self.active_peers.write().await;
                    if let Some(existing) = peers.get(dev_id).filter(|e| !e.tx.same_channel(tx)) {
                        // Both devices dialled each other at once. Each side applies the same rule, so
                        // both keep the same connection: the one the smaller device id dialled. Without
                        // it a side can end up holding a connection the other has already dropped.
                        let stale = chrono::Utc::now().timestamp_millis() - existing.last_rx.load(Ordering::Relaxed) > STALE_AFTER_MS;
                        let keep_new = self.identity.device_id.as_str() < dev_id;
                        // A LAN connection always beats one through Tailscale, so coming home leaves the
                        // data-using remote link; between two of the same kind the id rule decides.
                        let existing_remote = crate::core::identity::is_tailscale_addr(&existing.ip);
                        let new_remote = crate::core::identity::is_tailscale_addr(remote_ip);
                        let replace = if existing_remote != new_remote { existing_remote } else { link.outbound == keep_new };
                        if stale || replace {
                            log::info!("Replacing the connection to {} (stale: {}, new one dialled by us: {})", dev_id, stale, link.outbound);
                            // A pair request in flight must survive the swap.
                            session.pairing_timestamp = existing.pairing_timestamp;
                            session.outgoing_pairing = existing.outgoing_pairing;
                            // So do the UDP input tokens: the device session has not ended.
                            session.input_token = existing.input_token.clone();
                            session.peer_input_token = existing.peer_input_token.clone();
                            existing.shutdown.notify_one();
                        } else {
                            log::info!("Dropping a duplicate connection to {} (new one dialled by us: {})", dev_id, link.outbound);
                            link.shutdown.notify_one();
                            return;
                        }
                    }
                    log::info!("Connected to {} ({}) at {}, dialled by us: {}, paired: {}", name, dev_id, remote_ip, link.outbound, is_trusted);
                    let resend_pairing = session.outgoing_pairing;
                    peers.insert(dev_id.to_string(), session);
                    // Nothing below may wait while every other connection is locked out.
                    drop(peers);
                    self.peers_changed.notify_waiters();
                    if let Some(timestamp) = resend_pairing {
                        let _ = tx.send(LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({ "pair": true, "timestamp": timestamp }))).await;
                    }

                    if let Some(app) = self.app_handle.read().await.as_ref() {
                        let _ = app.emit("device-connected", connected);
                    }
                    if is_trusted {
                        // Off the read loop: the full state is a dozen packets and some reads of this
                        // machine, and the peer's own packets should not wait behind them.
                        let (mgr, id) = (self.clone(), dev_id.to_string());
                        tokio::spawn(async move {
                            mgr.initial_sync(&id).await;
                            // A device that was offline while others were paired learns of them now.
                            mgr.send_pool_sync(&id).await;
                        });
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

                // The peer table is only locked to read or change the session itself, never across a
                // send, an emit or the trust store, so one slow connection cannot stall the others.
                let Some(dev_id) = peer_dev_id.clone() else { return };
                if wants_pair {
                    if let Some(ts) = timestamp {
                        let Some((peer_tx, device_name, device_type, peer_cert_der)) = self
                            .active_peers
                            .read()
                            .await
                            .get(&dev_id)
                            .map(|p| (p.tx.clone(), p.device_name.clone(), p.device_type.clone(), p.cert_der.clone()))
                        else {
                            return;
                        };
                        // A visible device takes ordinary requests; a hidden one only a QR's one-time
                        // token, which works once. Anything else is refused without a prompt.
                        let presented = pkt.body.get("token").and_then(|v| v.as_str());
                        let visible = self.discovery.is_visible().await;
                        let admission = self.pairing_window.lock().map(|mut w| w.admit(presented, visible, std::time::Instant::now())).unwrap_or(Admission::Closed);
                        if matches!(admission, Admission::Closed | Admission::BadToken | Admission::Conflict) {
                            log::warn!("Refused a pair request from {}: {:?}", dev_id, admission);
                            let _ = peer_tx.send(LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({ "pair": false }))).await;
                            if let (Admission::Conflict, Some(app)) = (&admission, self.app_handle.read().await.as_ref()) {
                                let _ = app.emit("pairing-blocked", serde_json::json!({ "deviceName": device_name }));
                            }
                            return;
                        }
                        match self.active_peers.write().await.get_mut(&dev_id) {
                            Some(peer) => peer.pairing_timestamp = Some(ts),
                            None => return,
                        }
                        let verification_pin = compute_verification_code(&public_key_der(&self.my_cert_der), &public_key_der(&peer_cert_der), &ts.to_string());

                        if let Some(app) = self.app_handle.read().await.as_ref() {
                            let _ = app.emit("incoming-pair-request", serde_json::json!({
                                "deviceId": dev_id,
                                "deviceName": device_name,
                                "deviceType": device_type,
                                "verificationKey": verification_pin,
                                // The scanner already verified this device by its QR: nothing to compare.
                                "viaQr": admission == Admission::Qr,
                            }));
                        }
                    } else {
                        // A pair answer without a timestamp accepts this side's pending request.
                        let accepted = {
                            let mut peers = self.active_peers.write().await;
                            let Some(peer) = peers.get_mut(&dev_id) else { return };
                            if peer.outgoing_pairing.is_none() {
                                None
                            } else {
                                peer.trusted = true;
                                peer.outgoing_pairing = None;
                                Some(TrustedDevice {
                                    device_id: peer.device_id.clone(),
                                    device_name: peer.device_name.clone(),
                                    cert_pem: peer.cert_pem.clone(),
                                    paired_at: chrono::Utc::now().timestamp_millis(),
                                    ip_address: Some(remote_ip.to_string()),
                                    tailscale_ip: peer.tailscale_ip.clone(),
                                })
                            }
                        };
                        let Some(device) = accepted else {
                            // An answer without a request from this side: ignore it, or any device on the
                            // network could make itself trusted. LinkPairingHandler.java does the same.
                            log::warn!("Ignoring an unsolicited pairing answer from {}", dev_id);
                            return;
                        };
                        self.trust_store.write().await.pair(device);

                        if let Some(app) = self.app_handle.read().await.as_ref() {
                            let _ = app.emit("pairing-successful", serde_json::json!({
                                "deviceId": dev_id,
                            }));
                        }
                        let mgr = self.clone();
                        tokio::spawn(async move { mgr.pool_joined(&dev_id).await });
                    }
                } else if pkt.body.get("unpair").and_then(|v| v.as_bool()).unwrap_or(false) {
                    // The peer removed this device (or was removed itself): it lets go of it, and so does this one.
                    {
                        let mut peers = self.active_peers.write().await;
                        let Some(peer) = peers.get_mut(&dev_id) else { return };
                        peer.trusted = false;
                        peer.outgoing_pairing = None;
                    }
                    self.trust_store.write().await.unpair(&dev_id);
                    self.forget_permissions(&dev_id);
                    if let Some(app) = self.app_handle.read().await.as_ref() {
                        let _ = app.emit("unpaired", serde_json::json!({
                            "deviceId": dev_id,
                        }));
                    }
                } else {
                    // A refusal. It only ends a pairing this side asked for: a device that has not heard of
                    // this one yet (it was offline while it was paired) must never undo a pairing by saying so.
                    let declined = {
                        let mut peers = self.active_peers.write().await;
                        let Some(peer) = peers.get_mut(&dev_id) else { return };
                        peer.outgoing_pairing.take().is_some()
                    };
                    if declined {
                        if let Some(app) = self.app_handle.read().await.as_ref() {
                            let _ = app.emit("pairing-failed", serde_json::json!({ "deviceId": dev_id, "reason": "The other device declined" }));
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
            share::OFFER | share::ANSWER | share::START | share::DONE => {
                let Some(dev_id) = peer_dev_id.clone() else { return };
                if self.active_peers.read().await.get(&dev_id).is_some_and(|p| p.trusted) {
                    let mgr = self.clone();
                    let pkt = pkt.clone();
                    tokio::spawn(async move {
                        match pkt.packet_type.as_str() {
                            share::OFFER => mgr.on_share_offer(&dev_id, pkt).await,
                            share::ANSWER => mgr.on_share_answer(&dev_id, pkt).await,
                            share::START => mgr.on_share_start(&dev_id, pkt).await,
                            _ => mgr.on_share_done(&dev_id, pkt).await,
                        }
                    });
                }
            }
            crate::core::pool::SYNC | crate::core::pool::REMOVE => {
                // Only a paired device may change who is in the pool; the handlers check that.
                let Some(dev_id) = peer_dev_id.clone() else { return };
                let (mgr, pkt) = (self.clone(), pkt.clone());
                tokio::spawn(async move {
                    if pkt.packet_type == crate::core::pool::SYNC {
                        mgr.on_pool_sync(&dev_id, &pkt.body).await;
                    } else {
                        mgr.on_pool_remove(&dev_id, &pkt.body).await;
                    }
                });
            }
            // Plugin traffic is accepted only from paired peers. handle_host_packet acts on what the
            // desktop hosts; anything it does not consume goes to the UI.
            other => {
                let Some(dev_id) = peer_dev_id.as_deref() else { return };
                let trusted = self.active_peers.read().await.get(dev_id).is_some_and(|p| p.trusted);
                if !trusted {
                    // The sender believes it is paired but there is no record of it here. That is only worth
                    // telling it when this device REMOVED it (so it is dropped from the pool); a device that
                    // simply has not heard of the sender yet learns of it from the pool and must not be
                    // unpaired by the sender's confusion. Once, and not while a pairing is in flight.
                    let removed = self.trust_store.read().await.removed_at(dev_id).is_some() && !self.trust_store.read().await.is_paired(dev_id);
                    let notify = self.active_peers.write().await.get_mut(dev_id).filter(|p| removed && !p.notified_not_paired && p.pairing_timestamp.is_none()).map(|peer| {
                        peer.notified_not_paired = true;
                        peer.tx.clone()
                    });
                    if let Some(peer_tx) = notify {
                        let _ = peer_tx.send(LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({ "pair": false, "unpair": true }))).await;
                    }
                }
                if trusted && SPAWNED_PACKETS.contains(&other) {
                    // Waits here only once MAX_SLOW_IN_FLIGHT of them are already running.
                    let Ok(permit) = link.slow.clone().acquire_owned().await else { return };
                    let (mgr, id, pkt) = (self.clone(), dev_id.to_string(), pkt.clone());
                    tokio::spawn(async move {
                        let _permit = permit;
                        if !mgr.handle_host_packet(&id, &pkt).await {
                            mgr.emit_peer_packet(&id, &pkt).await;
                        }
                    });
                    return;
                }
                if trusted {
                    if !self.handle_host_packet(dev_id, pkt).await {
                        self.emit_peer_packet(dev_id, pkt).await;
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
        // Copied out so the peer table's lock is not held while waiting for the trust store's.
        let (ip, cert_der) = {
            let peers = self.active_peers.read().await;
            let peer = peers.get(device_id).filter(|p| p.trusted)?;
            (peer.ip.clone(), peer.cert_der.clone())
        };
        let store = self.trust_store.read().await;
        let pinned = store
            .get(device_id)
            .map(|d| compute_cert_fingerprint(&d.cert_pem))
            .unwrap_or_else(|| hex::encode(sha2::Sha256::digest(&cert_der)));
        Some((ip, pinned))
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
    // the peer appear in active_peers, so callers wait for it (woken on every identification)
    // instead of assuming a fixed delay.
    async fn find_peer<F: Fn(&PeerSession) -> bool>(&self, matches: F) -> Option<String> {
        let deadline = tokio::time::Instant::now() + FIND_PEER_TIMEOUT;
        loop {
            // Registered before looking, so an identification landing in between is not missed.
            let changed = self.peers_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(id) = self.active_peers.read().await.values().find(|p| matches(p)).map(|p| p.device_id.clone()) {
                return Some(id);
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return None;
            }
        }
    }

    /// Connects to a discovered-but-not-yet-connected device, then sends the pair request.
    /// Returns the verification PIN both screens show.
    pub async fn request_pairing(self: &Arc<Self>, target_device_id: &str) -> Result<String, String> {
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
        self.send_pair_request(target_device_id, None).await
    }

    /// Manual pairing by address: the device ID isn't known until the peer identifies itself. A
    /// scanned QR lists every address the device has ("a,b"); the first that answers is used.
    /// They are tried QR_DIAL_STAGGER apart, in the listed order, rather than each waiting out the
    /// one before, so an address on another network costs a quarter second instead of seconds.
    pub async fn request_pairing_by_ip(self: &Arc<Self>, addresses: &str, scan: Option<ScanProof>) -> Result<(String, String), String> {
        let mut last_error = "No address to connect to".to_string();
        let mut dials = tokio::task::JoinSet::new();
        for (i, ip) in addresses.split(',').map(str::trim).filter(|a| !a.is_empty()).enumerate() {
            let (mgr, ip) = (self.clone(), ip.to_string());
            dials.spawn(async move {
                tokio::time::sleep(QR_DIAL_STAGGER * i as u32).await;
                mgr.connect_to(&ip, LINK_PORT).await?;
                mgr.find_peer(|p| p.ip == ip).await.ok_or_else(|| format!("{} connected but never identified itself", ip))
            });
        }
        let mut found = None;
        while let Some(result) = dials.join_next().await {
            match result {
                Ok(Ok(device_id)) => {
                    found = Some(device_id);
                    break;
                }
                Ok(Err(e)) => last_error = e,
                Err(_) => {}
            }
        }
        // The rest are not needed (one that already connected is reconciled by the duplicate rule).
        dials.abort_all();
        let device_id = found.ok_or(last_error)?;
        // A scanned QR names the device's key. Whoever answered must hold it, or something sits between
        // this phone and the device.
        if let Some(scan) = &scan {
            let actual = self.active_peers.read().await.get(&device_id).map(|p| compute_cert_fingerprint(&p.cert_pem));
            if actual.as_deref() != Some(scan.fingerprint.as_str()) {
                return Err("That is not the device in the QR code. Pairing stopped.".to_string());
            }
        }
        let pin = self.send_pair_request(&device_id, scan.as_ref().map(|s| s.token.clone())).await?;
        Ok((pin, device_id))
    }

    async fn send_pair_request(&self, target_device_id: &str, token: Option<String>) -> Result<String, String> {
        let now_secs = chrono::Utc::now().timestamp();
        let (peer_tx, peer_cert_der) = {
            let mut peers = self.active_peers.write().await;
            let peer = peers
                .get_mut(target_device_id)
                .ok_or_else(|| format!("Device {} not found or offline", target_device_id))?;
            peer.pairing_timestamp = Some(now_secs);
            peer.outgoing_pairing = Some(now_secs);
            (peer.tx.clone(), peer.cert_der.clone())
        };
        let pin = compute_verification_code(&public_key_der(&self.my_cert_der), &public_key_der(&peer_cert_der), &now_secs.to_string());
        let mut body = serde_json::json!({
            "pair": true,
            "timestamp": now_secs,
        });
        if let Some(token) = token {
            body["token"] = token.into();
        }
        let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, body);
        let _ = peer_tx.send(pair_pkt).await;

        let (peers, app, device_id) = (self.active_peers.clone(), self.app_handle.clone(), target_device_id.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(PAIR_TIMEOUT).await;
            let timed_out = peers.write().await.get_mut(&device_id).is_some_and(|p| {
                let pending = p.outgoing_pairing == Some(now_secs);
                if pending {
                    p.outgoing_pairing = None;
                }
                pending
            });
            if let (true, Some(app)) = (timed_out, app.read().await.as_ref()) {
                let _ = app.emit("pairing-failed", serde_json::json!({ "deviceId": device_id, "reason": "The other device did not answer" }));
            }
        });
        Ok(pin)
    }

    pub async fn accept_pairing(self: &Arc<Self>, target_device_id: &str) -> Result<(), String> {
        // The session is changed under the lock; the send, the trust store and the event come after it.
        let accepted = self.active_peers.write().await.get_mut(target_device_id).map(|peer| {
            peer.trusted = true;
            let device = TrustedDevice {
                device_id: peer.device_id.clone(),
                device_name: peer.device_name.clone(),
                cert_pem: peer.cert_pem.clone(),
                paired_at: chrono::Utc::now().timestamp_millis(),
                ip_address: Some(peer.ip.clone()),
                tailscale_ip: peer.tailscale_ip.clone(),
            };
            (peer.tx.clone(), device)
        });
        let Some((peer_tx, device)) = accepted else {
            return Err(format!("Peer session {} not active", target_device_id));
        };
        let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({
            "pair": true,
        }));
        let _ = peer_tx.send(pair_pkt).await;

        let paired_id = device.device_id.clone();
        self.trust_store.write().await.pair(device);

        if let Some(app) = self.app_handle.read().await.as_ref() {
            let _ = app.emit("pairing-successful", serde_json::json!({
                "deviceId": paired_id,
            }));
        }

        let mgr = self.clone();
        tokio::spawn(async move { mgr.pool_joined(&paired_id).await });
        Ok(())
    }

    pub async fn reject_pairing(&self, target_device_id: &str) -> Result<(), String> {
        let rejected = self.active_peers.write().await.get_mut(target_device_id).map(|peer| {
            peer.trusted = false;
            peer.outgoing_pairing = None;
            peer.tx.clone()
        });
        if let Some(peer_tx) = rejected {
            let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({
                "pair": false,
            }));
            let _ = peer_tx.send(pair_pkt).await;

            if let Some(app) = self.app_handle.read().await.as_ref() {
                let _ = app.emit("pairing-failed", serde_json::json!({
                    "deviceId": target_device_id,
                    "reason": "Cancelled by user",
                }));
            }
        }
        Ok(())
    }

    pub async fn unpair(&self, target_device_id: &str) -> Result<(), String> {
        {
            let mut store = self.trust_store.write().await;
            store.unpair(target_device_id);
        }
        self.forget_permissions(target_device_id);

        let unpaired = self.active_peers.write().await.get_mut(target_device_id).map(|peer| {
            peer.trusted = false;
            peer.tx.clone()
        });
        if let Some(peer_tx) = unpaired {
            let pair_pkt = LinkPacket::new(PACKET_TYPE_PAIR, serde_json::json!({
                "pair": false,
                "unpair": true,
            }));
            let _ = peer_tx.send(pair_pkt).await;
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
