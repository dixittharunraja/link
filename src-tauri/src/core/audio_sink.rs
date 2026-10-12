use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use opus_decoder::OpusDecoder;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::core::guest::{close_with, connect_guest_client, send_json, ClientWs, Decision, GuestSocket, CLOSE_MALFORMED, CLOSE_UNKNOWN_JOIN};
use crate::core::plugins::loopback::{self, Capture, Chunks, Format};
use crate::core::transport::{DeviceManager, LINK_PORT};

// Audio sink: this PC's system audio streamed to devices that join (hosting), and the same
// protocol in the other direction (listening to a phone's audio sink or microphone).
//
// Control (join, PIN, format, mute, end) is a TLS WebSocket. The audio itself is UDP, because a
// stale frame is worse than a dropped one and TCP would stall everything behind a lost packet.
// Each listener gets its own AES-256-GCM key inside the TLS-protected `admitted` message and
// announces its UDP address with a one-datagram hello (its connection id) before any audio is sent.
// Frame: [seq:4][ts:6 - sink only][nonce:12][AES-GCM(codec tag + payload) + tag].

pub const AUDIO_SINK_PORT: u16 = LINK_PORT + 3;
pub const AUDIO_SINK_UDP_PORT: u16 = LINK_PORT + 4;
const REMOTE_MIC_PORT: u16 = AUDIO_SINK_PORT + 2;

const CODEC_PCM: u8 = 0x00;
const CODEC_OPUS: u8 = 0x01;
const SEQ_BYTES: usize = 4;
const TS_BYTES: usize = 6;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
// Under the Wi-Fi MTU, so a lost packet costs a few milliseconds of audio rather than a whole
// IP-fragmented capture chunk. Divides evenly by every sample frame size the protocol produces.
const MAX_UDP_PCM_BYTES: usize = 1280;
// Pacing only catches unbounded drift; a low value reorders frames on every reset.
const MAX_SEND_AHEAD: Duration = Duration::from_millis(100);
// A connection can die without a close frame (a phone's WebView reloaded mid-session).
const HEARTBEAT: Duration = Duration::from_secs(15);
const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
// Burst-sent sub-packets reorder easily on Wi-Fi; a few late arrivals are held, not dropped.
const REORDER_WINDOW_MAX: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Service {
    Sink,
    Mic,
}

impl Service {
    fn port(self) -> u16 {
        match self {
            Service::Sink => AUDIO_SINK_PORT,
            Service::Mic => REMOTE_MIC_PORT,
        }
    }

    fn event(self, name: &str) -> String {
        let prefix = if self == Service::Sink { "audio-sink" } else { "remote-mic" };
        format!("{prefix}-{name}")
    }

    // The phone's microphone server predates the capture timestamp and never sends it.
    fn frame_header_bytes(self) -> usize {
        if self == Service::Sink { SEQ_BYTES + TS_BYTES } else { SEQ_BYTES }
    }
}

enum ListenerCmd {
    Json(Value),
    Close(&'static str),
}

struct Listener {
    tx: mpsc::Sender<ListenerCmd>,
    ip: String,
    device_id: Option<String>,
    label: String,
    key: LessSafeKey,
    seq: u32,
    udp: Option<SocketAddr>,
}

struct Hosting {
    server: tokio::task::AbortHandle,
    hello: tokio::task::AbortHandle,
    relay: tokio::task::AbortHandle,
    // Dropping it stops the capture thread.
    _capture: Capture,
    udp: Arc<UdpSocket>,
    format: Value,
    muted: bool,
    listeners: HashMap<String, Listener>,
    // One-time join tokens for paired devices: token -> (device id, device name).
    tokens: HashMap<String, (String, String)>,
}

struct ClientHandle {
    tx: mpsc::Sender<()>,
    label: String,
}

#[derive(Default)]
pub struct AudioSink {
    hosting: Mutex<Option<Hosting>>,
    sink_client: Mutex<Option<ClientHandle>>,
    mic_client: Mutex<Option<ClientHandle>>,
}

impl AudioSink {
    fn client_slot(&self, service: Service) -> &Mutex<Option<ClientHandle>> {
        match service {
            Service::Sink => &self.sink_client,
            Service::Mic => &self.mic_client,
        }
    }

    fn with_host<R>(&self, f: impl FnOnce(&mut Hosting) -> R) -> Option<R> {
        self.hosting.lock().ok().and_then(|mut host| host.as_mut().map(f))
    }
}

fn unix_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    let _ = SystemRandom::new().fill(&mut bytes);
    bytes
}

fn session_key(bytes: &[u8]) -> Option<LessSafeKey> {
    UnboundKey::new(&AES_256_GCM, bytes).ok().map(LessSafeKey::new)
}

/// Opus-less capture is sent as 16-bit PCM: the engine mixes in 32-bit float, which would double
/// the bandwidth for no audible gain.
fn wire_format(format: Format) -> (Value, bool) {
    let to_int16 = format.is_float && format.bits_per_sample == 32;
    let (bits, float) = if to_int16 { (16, false) } else { (format.bits_per_sample, format.is_float) };
    let message = json!({ "type": "format", "sampleRate": format.sample_rate, "channels": format.channels, "bitsPerSample": bits, "isFloat": float, "codec": "pcm" });
    (message, to_int16)
}

fn float_to_int16(raw: &[u8]) -> Vec<u8> {
    raw.chunks_exact(4)
        .flat_map(|b| {
            let sample = f32::from_le_bytes([b[0], b[1], b[2], b[3]]).clamp(-1.0, 1.0);
            ((sample * 32767.0).round() as i16).to_le_bytes()
        })
        .collect()
}

// ---- hosting ----

async fn begin_capture(manager: &Arc<DeviceManager>, device_id: Option<String>, udp: Arc<UdpSocket>) -> Result<(Capture, tokio::task::AbortHandle, Value), String> {
    let (capture, format, chunks) = loopback::start(device_id).await?;
    let (format_message, to_int16) = wire_format(format);
    let frame_bytes = format.channels as usize * if to_int16 { 2 } else { format.bits_per_sample as usize / 8 };
    let relay = tokio::spawn(relay_audio(manager.clone(), chunks, udp, to_int16, frame_bytes.max(1), format.sample_rate.max(1)));
    Ok((capture, relay.abort_handle(), format_message))
}

/// Forwards capture chunks to every listener, paced to real time so a burst from the capture
/// thread doesn't turn into a burst on the wire.
async fn relay_audio(manager: Arc<DeviceManager>, mut chunks: Chunks, udp: Arc<UdpSocket>, to_int16: bool, frame_bytes: usize, sample_rate: u32) {
    let mut cursor: Option<Instant> = None;
    while let Some(chunk) = chunks.recv().await {
        let captured_at = unix_millis();
        let audible = manager.audio.with_host(|h| !h.muted && !h.listeners.is_empty()).unwrap_or(false);
        if !audible {
            continue;
        }
        let pcm = if to_int16 { float_to_int16(&chunk) } else { chunk };
        let now = Instant::now();
        let mut at = match cursor {
            Some(c) if c >= now && c - now <= MAX_SEND_AHEAD => c,
            _ => now,
        };
        for slice in pcm.chunks(MAX_UDP_PCM_BYTES) {
            if at > Instant::now() {
                tokio::time::sleep_until(at.into()).await;
            }
            manager.send_audio_frame(&udp, CODEC_PCM, slice, captured_at);
            at += Duration::from_secs_f64(slice.len() as f64 / frame_bytes as f64 / sample_rate as f64);
        }
        cursor = Some(at);
    }
}

async fn receive_hello(manager: Arc<DeviceManager>, udp: Arc<UdpSocket>) {
    let mut buffer = [0u8; 256];
    loop {
        let Ok((length, from)) = udp.recv_from(&mut buffer).await else { continue };
        let Ok(conn_id) = std::str::from_utf8(&buffer[..length]) else { continue };
        // A hello for a connection that is no longer admitted is stale, or noise from the network.
        manager.audio.with_host(|h| {
            if let Some(listener) = h.listeners.get_mut(conn_id.trim()) {
                listener.udp = Some(from);
            }
        });
    }
}

async fn reply_clock_ping(ws: &mut crate::core::guest::GuestWs, msg: &Value) {
    // Lets a listener solve for the clock offset between the two machines (NTP style), which every
    // frame's capture timestamp is otherwise skewed by.
    send_json(ws, json!({ "type": "clock-pong", "t1": msg["t1"], "t2": unix_millis() })).await;
}

async fn listener_connection(manager: Arc<DeviceManager>, mut guest: GuestSocket) {
    let join = tokio::time::timeout(JOIN_TIMEOUT, async {
        loop {
            match guest.ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) else { return Err(CLOSE_MALFORMED) };
                    if msg["type"].as_str() == Some("clock-ping") {
                        reply_clock_ping(&mut guest.ws, &msg).await;
                        continue;
                    }
                    return Ok(msg);
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err(0),
                _ => {}
            }
        }
    })
    .await;
    let join = match join {
        Ok(Ok(msg)) => msg,
        Ok(Err(0)) => return,
        Ok(Err(code)) => return close_with(&mut guest.ws, code, "malformed join message").await,
        Err(_) => return close_with(&mut guest.ws, CLOSE_MALFORMED, "malformed join message").await,
    };

    let conn_id = uuid::Uuid::new_v4().to_string();
    let (device_id, label) = match join["type"].as_str() {
        Some("join-token") => {
            let token = join["token"].as_str().unwrap_or_default();
            let entry = manager.audio.with_host(|h| h.tokens.remove(token)).flatten();
            let Some((device_id, name)) = entry else { return close_with(&mut guest.ws, 4005, "invalid or expired token").await };
            if manager.is_blocked(&device_id) {
                return close_with(&mut guest.ws, crate::core::guest::CLOSE_BLOCKED, "blocked").await;
            }
            (Some(device_id), name)
        }
        Some("join-guest") => {
            let name = join["deviceName"].as_str().map(str::to_string);
            if manager.confirm_guest(&mut guest, &conn_id, name.clone(), "audio-sink-guest-pin-pending", vec![]).await != Decision::Accept {
                return;
            }
            (None, name.unwrap_or_else(|| "Guest Listener".to_string()))
        }
        _ => return close_with(&mut guest.ws, CLOSE_UNKNOWN_JOIN, "unknown join type").await,
    };

    let key_bytes = random_bytes::<32>();
    let Some(key) = session_key(&key_bytes) else { return };
    let host_name = manager.device_name.read().await.clone();
    send_json(
        &mut guest.ws,
        json!({ "type": "admitted", "connId": conn_id, "udpKey": base64::engine::general_purpose::STANDARD.encode(key_bytes), "hostName": host_name }),
    )
    .await;

    let (tx, mut commands) = mpsc::channel(16);
    let format = manager.audio.with_host(|h| {
        h.listeners.insert(conn_id.clone(), Listener { tx, ip: guest.remote_ip.clone(), device_id, label: label.clone(), key, seq: 0, udp: None });
        h.format.clone()
    });
    let Some(format) = format else { return };
    send_json(&mut guest.ws, format).await;
    manager.emit_event("audio-sink-listener-joined", json!({ "connId": conn_id, "label": label })).await;

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    let mut alive = true;
    loop {
        tokio::select! {
            incoming = guest.ws.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) {
                        if msg["type"].as_str() == Some("clock-ping") {
                            reply_clock_ping(&mut guest.ws, &msg).await;
                        }
                    }
                }
                Some(Ok(Message::Pong(_))) => alive = true,
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
            command = commands.recv() => match command {
                Some(ListenerCmd::Json(value)) => { send_json(&mut guest.ws, value).await; }
                Some(ListenerCmd::Close(reason)) => { close_with(&mut guest.ws, 1000, reason).await; break; }
                None => break,
            },
            _ = heartbeat.tick() => {
                if !alive { break; }
                alive = false;
                let _ = guest.ws.send(Message::Ping(Default::default())).await;
            }
        }
    }
    manager.audio.with_host(|h| h.listeners.remove(&conn_id));
    manager.emit_event("audio-sink-listener-left", json!({ "connId": conn_id })).await;
}

impl DeviceManager {
    fn send_audio_frame(&self, udp: &UdpSocket, codec: u8, payload: &[u8], captured_at_ms: u64) {
        let mut plaintext = Vec::with_capacity(1 + payload.len() + TAG_BYTES);
        plaintext.push(codec);
        plaintext.extend_from_slice(payload);

        let mut timestamp = [0u8; TS_BYTES];
        timestamp[..2].copy_from_slice(&((captured_at_ms >> 32) as u16).to_be_bytes());
        timestamp[2..].copy_from_slice(&(captured_at_ms as u32).to_be_bytes());

        let frames: Vec<(SocketAddr, Vec<u8>)> = self
            .audio
            .with_host(|host| {
                host.listeners
                    .values_mut()
                    .filter_map(|listener| {
                        let address = listener.udp?;
                        let seq = listener.seq;
                        listener.seq = seq.wrapping_add(1);
                        let nonce = random_bytes::<NONCE_BYTES>();
                        let mut encrypted = plaintext.clone();
                        listener.key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut encrypted).ok()?;
                        let mut frame = Vec::with_capacity(SEQ_BYTES + TS_BYTES + NONCE_BYTES + encrypted.len());
                        frame.extend_from_slice(&seq.to_be_bytes());
                        frame.extend_from_slice(&timestamp);
                        frame.extend_from_slice(&nonce);
                        frame.extend_from_slice(&encrypted);
                        Some((address, frame))
                    })
                    .collect()
            })
            .unwrap_or_default();
        for (address, frame) in frames {
            let _ = udp.try_send_to(&frame, address);
        }
    }

    fn broadcast_to_listeners(&self, value: Value) {
        let senders: Vec<_> = self.audio.with_host(|h| h.listeners.values().map(|l| l.tx.clone()).collect::<Vec<_>>()).unwrap_or_default();
        for tx in senders {
            let _ = tx.try_send(ListenerCmd::Json(value.clone()));
        }
    }

    pub async fn audio_sink_devices(&self) -> Vec<Value> {
        loopback::list_devices().await.into_iter().map(|d| json!({ "id": d.id, "name": d.name, "isDefault": d.is_default })).collect()
    }

    pub async fn start_audio_sink(self: &Arc<Self>, device_id: Option<String>) -> Result<Value, String> {
        if self.audio.with_host(|_| ()).is_some() {
            return Ok(json!({ "started": true, "port": AUDIO_SINK_PORT }));
        }
        let udp = Arc::new(UdpSocket::bind(("0.0.0.0", AUDIO_SINK_UDP_PORT)).await.map_err(|e| format!("Audio sink could not use UDP port {}: {}", AUDIO_SINK_UDP_PORT, e))?);
        let (capture, relay, format) = begin_capture(self, device_id, udp.clone()).await?;
        let server = self.serve_guests(AUDIO_SINK_PORT, "Audio sink", listener_connection).await?;
        let hello = tokio::spawn(receive_hello(self.clone(), udp.clone())).abort_handle();
        if let Ok(mut host) = self.audio.hosting.lock() {
            *host = Some(Hosting { server, hello, relay, _capture: capture, udp, format, muted: false, listeners: HashMap::new(), tokens: HashMap::new() });
        }

        // Every paired device that is connected right now gets its own one-time token. A device
        // that connects later can ask for one (link.audiosink.query).
        for peer_id in self.paired_peer_ids().await {
            self.offer_audio_sink_to(&peer_id).await;
        }
        Ok(json!({ "started": true, "port": AUDIO_SINK_PORT }))
    }

    async fn offer_audio_sink_to(&self, device_id: &str) {
        let name = self.trust_store.read().await.get(device_id).map(|d| d.device_name.clone()).unwrap_or_else(|| device_id.to_string());
        let token = uuid::Uuid::new_v4().simple().to_string();
        if self.audio.with_host(|h| h.tokens.insert(token.clone(), (device_id.to_string(), name))).is_some() {
            let _ = self.send_packet(device_id, "link.audiosink.started", json!({ "token": token, "port": AUDIO_SINK_PORT })).await;
        }
    }

    /// A peer opened its audio sink tab and asks whether we are hosting.
    pub(crate) async fn answer_audio_sink_query(&self, device_id: &str) {
        self.offer_audio_sink_to(device_id).await;
    }

    pub async fn stop_audio_sink(&self) {
        let Some(host) = self.audio.hosting.lock().ok().and_then(|mut h| h.take()) else { return };
        for peer_id in self.paired_peer_ids().await {
            let _ = self.send_packet(&peer_id, "link.audiosink.ended", json!({})).await;
        }
        for listener in host.listeners.values() {
            let _ = listener.tx.try_send(ListenerCmd::Json(json!({ "type": "ended" })));
            let _ = listener.tx.try_send(ListenerCmd::Close("session ended"));
        }
        host.server.abort();
        host.hello.abort();
        host.relay.abort();
        self.emit_event("audio-sink-ended", json!({})).await;
    }

    pub async fn switch_audio_sink_device(self: &Arc<Self>, device_id: Option<String>) -> Result<(), String> {
        let Some(udp) = self.audio.with_host(|h| h.udp.clone()) else { return Ok(()) };
        let (capture, relay, format) = begin_capture(self, device_id, udp).await?;
        let previous = self.audio.with_host(|h| {
            h.relay.abort();
            h.format = format.clone();
            (std::mem::replace(&mut h._capture, capture), std::mem::replace(&mut h.relay, relay))
        });
        drop(previous);
        self.broadcast_to_listeners(format);
        Ok(())
    }

    pub fn set_audio_sink_muted(&self, muted: bool) {
        self.audio.with_host(|h| h.muted = muted);
        self.broadcast_to_listeners(json!({ "type": "hostMuted", "muted": muted }));
    }

    pub fn audio_sink_listeners(&self) -> Vec<Value> {
        self.audio.with_host(|h| h.listeners.iter().map(|(id, l)| json!({ "id": id, "label": l.label })).collect()).unwrap_or_default()
    }

    pub async fn kick_audio_sink_listener(&self, conn_id: &str) {
        let tx = self.audio.with_host(|h| h.listeners.get(conn_id).map(|l| l.tx.clone())).flatten();
        if let Some(tx) = tx {
            let _ = tx.send(ListenerCmd::Close("removed by host")).await;
        }
    }

    /// Blocks an admitted listener (a paired one by device, a guest by address) and removes it.
    pub async fn block_audio_sink_listener(&self, conn_id: &str) {
        let info = self.audio.with_host(|h| h.listeners.get(conn_id).map(|l| (l.device_id.clone(), l.label.clone(), l.ip.clone()))).flatten();
        let Some((device_id, label, ip)) = info else { return };
        match device_id {
            Some(id) => self.block_guest_device(&id, &label).await,
            None => self.block_guest(&ip, None).await,
        }
        self.kick_audio_sink_listener(conn_id).await;
    }

    pub fn audio_sink_status(&self) -> Value {
        let hosting = self.audio.with_host(|_| ()).is_some();
        let (listening, label) = match self.audio.sink_client.lock().ok().and_then(|c| c.as_ref().map(|c| c.label.clone())) {
            Some(label) => (true, label),
            None => (false, String::new()),
        };
        json!({ "hosting": hosting, "listening": listening, "hostLabel": label, "listeners": self.audio_sink_listeners() })
    }

    pub fn remote_mic_status(&self) -> Value {
        let streaming = self.audio.mic_client.lock().map(|c| c.is_some()).unwrap_or(false);
        json!({ "hosting": false, "streaming": streaming, "listeners": [] })
    }

    // ---- listening to someone else's session ----

    /// Joins a session on another device. `host` may list several addresses (comma separated); the
    /// first that answers wins. A token joins as a paired device, none joins as a guest.
    pub async fn join_audio_session(self: &Arc<Self>, service: Service, host: &str, token: Option<String>, label: String) -> Result<(), String> {
        self.leave_audio_session(service).await;
        let hosts: Vec<&str> = host.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
        if hosts.is_empty() {
            return Err("No address to connect to".into());
        }
        let attempts = hosts.iter().map(|h| Box::pin(connect_guest_client(self, h, service.port())));
        let (mut ws, server_cert) = match futures_util::future::select_ok(attempts).await {
            Ok((connected, _)) => connected,
            Err(message) => {
                self.emit_event(&service.event("error"), json!({ "message": message })).await;
                return Ok(());
            }
        };
        let Some(peer) = ws.get_ref().get_ref().0.peer_addr().ok() else { return Err("The connection closed immediately".into()) };

        match &token {
            Some(token) => {
                send_json(&mut ws, json!({ "type": "join-token", "token": token })).await;
            }
            None => {
                self.emit_event(&service.event("pin-computed"), json!({ "pin": self.guest_pin(&server_cert) })).await;
                let name = self.device_name.read().await.clone();
                send_json(&mut ws, json!({ "type": "join-guest", "deviceName": name })).await;
            }
        }

        let (tx, leave) = mpsc::channel(1);
        if let Ok(mut slot) = self.audio.client_slot(service).lock() {
            *slot = Some(ClientHandle { tx, label });
        }
        let manager = self.clone();
        tokio::spawn(async move {
            let (ended, reason) = run_listener(&manager, service, ws, peer, leave).await;
            if let Some(reason) = reason {
                manager.audio.client_slot(service).lock().map(|mut slot| slot.take()).ok();
                let event = if ended { "ended" } else { "closed" };
                manager.emit_event(&service.event(event), json!({ "reason": reason })).await;
            }
        });
        Ok(())
    }

    pub async fn leave_audio_session(&self, service: Service) {
        let handle = self.audio.client_slot(service).lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let _ = handle.tx.send(()).await;
        }
    }
}

struct Reorder {
    next: Option<u32>,
    held: BTreeMap<u32, Vec<u8>>,
}

impl Reorder {
    /// Takes one decrypted payload and returns whatever is now ready to play, in order.
    fn push(&mut self, seq: u32, payload: Vec<u8>) -> Vec<Vec<u8>> {
        let next = *self.next.get_or_insert(seq);
        if seq < next {
            return Vec::new();
        }
        self.held.insert(seq, payload);
        // Too many later packets piled up without the gap filling: it was a loss, skip it.
        if self.held.len() > REORDER_WINDOW_MAX {
            self.next = self.held.keys().next().copied();
        }
        let mut ready = Vec::new();
        while let Some(payload) = self.next.and_then(|n| self.held.remove(&n)) {
            ready.push(payload);
            self.next = self.next.map(|n| n.wrapping_add(1));
        }
        ready
    }
}

fn decrypt_frame(service: Service, key: &LessSafeKey, frame: &[u8]) -> Option<(u32, Vec<u8>)> {
    let header = service.frame_header_bytes();
    if frame.len() < header + NONCE_BYTES + TAG_BYTES {
        return None;
    }
    let seq = u32::from_be_bytes(frame[..SEQ_BYTES].try_into().ok()?);
    let nonce: [u8; NONCE_BYTES] = frame[header..header + NONCE_BYTES].try_into().ok()?;
    let mut sealed = frame[header + NONCE_BYTES..].to_vec();
    // A wrong key, corrupted or spoofed packet fails authentication and is dropped silently.
    let plaintext_len = key.open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut sealed).ok()?.len();
    sealed.truncate(plaintext_len);
    Some((seq, sealed))
}

fn base64_pcm(pcm: &[u8]) -> Value {
    json!(base64::engine::general_purpose::STANDARD.encode(pcm))
}

/// Runs a listening session until it ends. Returns whether it ended gracefully and the reason to
/// report, or no reason when we left it ourselves.
async fn run_listener(manager: &DeviceManager, service: Service, mut ws: ClientWs, peer: SocketAddr, mut leave: mpsc::Receiver<()>) -> (bool, Option<String>) {
    let mut udp: Option<UdpSocket> = None;
    let mut key: Option<LessSafeKey> = None;
    let mut reorder = Reorder { next: None, held: BTreeMap::new() };
    let mut decoder: Option<OpusDecoder> = None;
    let mut channels = 2usize;
    let mut datagram = vec![0u8; 4096];
    let mut pcm = vec![0i16; 5760 * 2];

    loop {
        tokio::select! {
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    match msg["type"].as_str() {
                        Some("admitted") => {
                            let (Some(conn_id), Some(encoded)) = (msg["connId"].as_str(), msg["udpKey"].as_str()) else { continue };
                            key = base64::engine::general_purpose::STANDARD.decode(encoded).ok().and_then(|bytes| session_key(&bytes));
                            reorder = Reorder { next: None, held: BTreeMap::new() };
                            if let Ok(socket) = UdpSocket::bind("0.0.0.0:0").await {
                                let _ = socket.send_to(conn_id.as_bytes(), (peer.ip(), service.port() + 1)).await;
                                udp = Some(socket);
                            }
                            manager.emit_event(&service.event("admitted"), json!({ "hostName": msg["hostName"].as_str().unwrap_or_default() })).await;
                        }
                        Some("format") => {
                            decoder = None;
                            channels = msg["channels"].as_u64().unwrap_or(2) as usize;
                            if msg["codec"].as_str() == Some("opus") {
                                match OpusDecoder::new(msg["sampleRate"].as_u64().unwrap_or(48_000) as u32, channels) {
                                    Ok(created) => decoder = Some(created),
                                    Err(e) => manager.emit_event(&service.event("error"), json!({ "message": format!("Failed to initialize the Opus decoder: {e}") })).await,
                                }
                            }
                            manager.emit_event(&service.event("format"), json!({
                                "sampleRate": msg["sampleRate"], "channels": msg["channels"], "bitsPerSample": msg["bitsPerSample"], "isFloat": msg["isFloat"],
                            })).await;
                        }
                        Some("hostMuted") => manager.emit_event(&service.event("host-muted"), json!({ "muted": msg["muted"].as_bool().unwrap_or(false) })).await,
                        _ => {}
                    }
                }
                // 1000 and 1001 are how a host ends a session or removes just us; the reason tells which.
                Some(Ok(Message::Close(frame))) => {
                    return match frame {
                        Some(f) if !matches!(u16::from(f.code), 1000 | 1001) => (false, Some(if f.reason.is_empty() { format!("code {}", u16::from(f.code)) } else { f.reason.to_string() })),
                        Some(f) => (true, Some(f.reason.to_string())),
                        None => (true, Some(String::new())),
                    };
                }
                None | Some(Err(_)) => return (false, Some("connection lost".to_string())),
                _ => {}
            },
            received = async {
                match &udp {
                    Some(socket) => socket.recv(&mut datagram).await,
                    None => std::future::pending().await,
                }
            } => {
                let Ok(length) = received else { continue };
                let Some((seq, payload)) = key.as_ref().and_then(|k| decrypt_frame(service, k, &datagram[..length])) else { continue };
                for ready in reorder.push(seq, payload) {
                    let Some((&codec, body)) = ready.split_first() else { continue };
                    let samples = match codec {
                        CODEC_PCM => Some(body.to_vec()),
                        CODEC_OPUS => decoder.as_mut().and_then(|d| d.decode(body, &mut pcm, false).ok()).map(|per_channel| {
                            pcm[..per_channel * channels].iter().flat_map(|s| s.to_le_bytes()).collect()
                        }),
                        _ => None,
                    };
                    // A frame that fails to decode is dropped like a lost packet; a rare, transient event.
                    if let Some(samples) = samples {
                        manager.emit_event(&service.event("audio-chunk"), base64_pcm(&samples)).await;
                    }
                }
            },
            _ = leave.recv() => {
                let _ = ws.close(None).await;
                return (true, None);
            }
        }
    }
}
