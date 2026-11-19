use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use audiopus::coder::Encoder as OpusEncoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};
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

mod playback;
use playback::{OutputSettings, Player};

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

// Opus carries music at near-transparent quality in about a tenth of the bandwidth of raw audio,
// which is what keeps a weak Wi-Fi link from dropping packets. 10 ms frames are the shortest the
// phone's decoder is known to keep up with.
const OPUS_FRAME_MS: usize = 10;
// Stereo music at this rate is indistinguishable from the original in listening tests, and is still
// only a fraction of what even a weak Wi-Fi link carries.
const OPUS_BITRATE: i32 = 192_000;
const MAX_OPUS_PACKET_BYTES: usize = 1275;
// A home Wi-Fi link loses a few percent of packets at worst; see new_encoder.
const OPUS_EXPECTED_LOSS_PERCENT: u8 = 5;
// After a gap the decoder fills in at most this many lost frames with concealment. Longer gaps are
// a stall rather than a lost packet, and inventing more audio would only add delay.
const MAX_CONCEALED_FRAMES: u32 = 4;

const CODEC_OPUS: u8 = 0x01;
const SEQ_BYTES: usize = 4;
const TS_BYTES: usize = 6;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
// Pacing only catches drift. Frames are sent strictly in sequence, so resetting the schedule
// cannot reorder them, which is why this can be small.
const MAX_SEND_AHEAD: Duration = Duration::from_millis(40);
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

/// Windows wakes sleeping threads only every ~15.6 ms by default, which turns the few-millisecond
/// pacing of audio packets into bursts and gaps. Asking for 1 ms keeps the stream even; undone on drop.
struct TimerResolution;

impl TimerResolution {
    fn request() -> Self {
        #[cfg(windows)]
        // SAFETY: plain Win32 call, balanced by timeEndPeriod in Drop.
        unsafe {
            windows_sys::Win32::Media::timeBeginPeriod(1);
        }
        Self
    }
}

impl Drop for TimerResolution {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: matches the request above.
        unsafe {
            windows_sys::Win32::Media::timeEndPeriod(1);
        }
    }
}

// Headroom for a burst of packets; the OS default is sized for request/response traffic.
const UDP_SEND_BUFFER_BYTES: usize = 1 << 18;

struct Hosting {
    _timer: TimerResolution,
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
    // Held for a whole start or stop, so a second start (a double click) waits for the first
    // instead of binding the UDP port again.
    lifecycle: tokio::sync::Mutex<()>,
    sink_client: Mutex<Option<ClientHandle>>,
    mic_client: Mutex<Option<ClientHandle>>,
    // Output device and volume for what this PC hears from each service, kept across sessions.
    sink_output: Arc<OutputSettings>,
    mic_output: Arc<OutputSettings>,
}

impl AudioSink {
    fn client_slot(&self, service: Service) -> &Mutex<Option<ClientHandle>> {
        match service {
            Service::Sink => &self.sink_client,
            Service::Mic => &self.mic_client,
        }
    }

    fn output(&self, service: Service) -> &Arc<OutputSettings> {
        match service {
            Service::Sink => &self.sink_output,
            Service::Mic => &self.mic_output,
        }
    }

    fn with_host<R>(&self, f: impl FnOnce(&mut Hosting) -> R) -> Option<R> {
        self.hosting.lock().ok().and_then(|mut host| host.as_mut().map(f))
    }
}

fn unix_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
static RNG: std::sync::LazyLock<SystemRandom> = std::sync::LazyLock::new(SystemRandom::new);


fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    let _ = RNG.fill(&mut bytes);
    bytes
}

fn session_key(bytes: &[u8]) -> Option<LessSafeKey> {
    UnboundKey::new(&AES_256_GCM, bytes).ok().map(LessSafeKey::new)
}

/// The Opus encoder for the capture format (always 48 kHz stereo, see loopback.rs).
fn new_encoder(format: Format) -> Result<OpusEncoder, String> {
    let channels = if format.channels == 1 { Channels::Mono } else { Channels::Stereo };
    let rate = SampleRate::try_from(format.sample_rate as i32).map_err(|e| format!("Opus cannot take {} Hz: {}", format.sample_rate, e))?;
    // Restricted low delay is Opus's music codec (CELT) on its own: it skips the speech codec's
    // extra 4 ms look-ahead, and at this bitrate music loses nothing by it.
    let mut encoder = OpusEncoder::new(rate, channels, Application::LowDelay).map_err(|e| format!("Opus encoder could not start: {}", e))?;
    encoder.set_bitrate(Bitrate::BitsPerSecond(OPUS_BITRATE)).map_err(|e| e.to_string())?;
    // The best (and still cheap at 10 ms frames) setting, tuned for music rather than voice.
    let _ = encoder.set_complexity(10);
    let _ = encoder.set_signal(audiopus::Signal::Music);
    // Tells CELT that packets do get lost on Wi-Fi: it then leans less on the previous frame when
    // coding band energies, so one lost packet spoils less of the next ones. In-band FEC is not set:
    // it exists only in the speech (SILK) modes, which low-delay mode never uses, so it would do nothing.
    let _ = encoder.set_packet_loss_perc(OPUS_EXPECTED_LOSS_PERCENT);
    Ok(encoder)
}

/// The `format` message for listeners. Opus always decodes to 16-bit integers.
fn wire_format(format: Format) -> Value {
    json!({ "type": "format", "sampleRate": format.sample_rate, "channels": format.channels, "bitsPerSample": 16, "isFloat": false, "codec": "opus" })
}

pub(crate) fn float_sample_to_int16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

// ---- hosting ----

async fn begin_capture(manager: &Arc<DeviceManager>, device_id: Option<String>, udp: Arc<UdpSocket>) -> Result<(Capture, tokio::task::AbortHandle, Value), String> {
    let (capture, format, chunks) = loopback::start(device_id).await?;
    let encoder = new_encoder(format)?;
    let relay = tokio::spawn(relay_audio(manager.clone(), chunks, udp, format, encoder));
    Ok((capture, relay.abort_handle(), wire_format(format)))
}

/// Relay counters logged every few seconds: frames sent, the longest silence between capture
/// chunks, and frames that left later than scheduled. A long gap or many late frames means this
/// PC stalled; choppy audio with neither points at the network.
struct RelayReport {
    since: Instant,
    last_chunk: Option<Instant>,
    chunks: u32,
    frames: u32,
    late_frames: u32,
    max_gap: Duration,
    max_lateness: Duration,
}

impl RelayReport {
    fn new() -> Self {
        Self { since: Instant::now(), last_chunk: None, chunks: 0, frames: 0, late_frames: 0, max_gap: Duration::ZERO, max_lateness: Duration::ZERO }
    }

    fn chunk_arrived(&mut self) {
        let now = Instant::now();
        if let Some(previous) = self.last_chunk {
            self.max_gap = self.max_gap.max(now - previous);
        }
        self.last_chunk = Some(now);
        self.chunks += 1;
        if self.since.elapsed() >= Duration::from_secs(5) {
            log::info!(
                "Audio sink relay: {} chunks, {} frames, longest gap between chunks {} ms, {} frames late (worst {} ms)",
                self.chunks, self.frames, self.max_gap.as_millis(), self.late_frames, self.max_lateness.as_millis()
            );
            *self = Self { last_chunk: self.last_chunk, ..Self::new() };
        }
    }

    fn frame_due(&mut self, scheduled: Instant) {
        self.frames += 1;
        let lateness = Instant::now().saturating_duration_since(scheduled);
        if lateness > Duration::from_millis(5) {
            self.late_frames += 1;
            self.max_lateness = self.max_lateness.max(lateness);
        }
    }
}

/// Forwards capture chunks to every listener, paced to real time so a burst from the capture
/// thread doesn't turn into a burst on the wire.
async fn relay_audio(manager: Arc<DeviceManager>, mut chunks: Chunks, udp: Arc<UdpSocket>, format: Format, encoder: OpusEncoder) {
    let opus_frame_samples = format.sample_rate as usize * OPUS_FRAME_MS / 1000 * format.channels.max(1) as usize;
    let mut pending: Vec<i16> = Vec::new();
    let mut packet = [0u8; MAX_OPUS_PACKET_BYTES];
    let mut cursor: Option<Instant> = None;
    let mut report = RelayReport::new();
    while let Some(chunk) = chunks.recv().await {
        report.chunk_arrived();
        let captured_at = unix_millis();
        let audible = manager.audio.with_host(|h| !h.muted && !h.listeners.is_empty()).unwrap_or(false);
        if !audible {
            pending.clear();
            continue;
        }
        let now = Instant::now();
        let mut at = match cursor {
            Some(c) if c >= now && c - now <= MAX_SEND_AHEAD => c,
            _ => now,
        };
        // The capture is 32-bit float, narrowed to the 16-bit integers the encoder takes.
        pending.extend(chunk.chunks_exact(4).map(|b| float_sample_to_int16(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))));
        while pending.len() >= opus_frame_samples {
            // Encoded straight from the queue, then dropped from it: no copy of each frame.
            let encoded = encoder.encode(&pending[..opus_frame_samples], &mut packet);
            pending.drain(..opus_frame_samples);
            let Ok(length) = encoded else { continue };
            if at > Instant::now() {
                tokio::time::sleep_until(at.into()).await;
            }
            report.frame_due(at);
            manager.send_audio_frame(&udp, CODEC_OPUS, &packet[..length], captured_at).await;
            at += Duration::from_millis(OPUS_FRAME_MS as u64);
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
    async fn send_audio_frame(&self, udp: &UdpSocket, codec: u8, payload: &[u8], captured_at_ms: u64) {
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
                        // The plaintext is written into the frame and encrypted where it lies, so each
                        // listener costs one buffer rather than a copy of the plaintext and then the frame.
                        let header = SEQ_BYTES + TS_BYTES + NONCE_BYTES;
                        let mut frame = Vec::with_capacity(header + 1 + payload.len() + TAG_BYTES);
                        frame.extend_from_slice(&seq.to_be_bytes());
                        frame.extend_from_slice(&timestamp);
                        frame.extend_from_slice(&nonce);
                        frame.push(codec);
                        frame.extend_from_slice(payload);
                        let tag = listener.key.seal_in_place_separate_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut frame[header..]).ok()?;
                        frame.extend_from_slice(tag.as_ref());
                        Some((address, frame))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Awaited rather than try-sent: a full send buffer must delay the next packet, not drop this one.
        for (address, frame) in frames {
            let _ = udp.send_to(&frame, address).await;
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

    /// The playback endpoints a received stream can be played on (the same render endpoints the
    /// sink captures from): id, friendly name and whether it is the system default.
    pub async fn audio_output_devices(&self) -> Vec<Value> {
        self.audio_sink_devices().await
    }

    /// Where this PC plays what it hears from `service`; an empty id follows the system default.
    /// Applies to a running session straight away.
    pub fn set_listen_output_device(&self, service: Service, device_id: Option<String>) {
        self.audio.output(service).set_device(device_id);
    }

    /// Playback gain for `service`, 1.0 being unchanged.
    pub fn set_listen_volume(&self, service: Service, volume: f32) {
        self.audio.output(service).set_volume(volume);
    }

    pub async fn start_audio_sink(self: &Arc<Self>, device_id: Option<String>) -> Result<Value, String> {
        let _lifecycle = self.audio.lifecycle.lock().await;
        if self.audio.with_host(|_| ()).is_some() {
            return Ok(json!({ "started": true, "port": AUDIO_SINK_PORT }));
        }
        let udp_error = |e: std::io::Error| format!("Audio sink could not use UDP port {}: {}", AUDIO_SINK_UDP_PORT, e);
        let raw = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, None).map_err(udp_error)?;
        let _ = raw.set_send_buffer_size(UDP_SEND_BUFFER_BYTES);
        raw.set_nonblocking(true).map_err(udp_error)?;
        // The previous session's tasks release the socket when their abort lands, which can trail
        // a stop by a moment, so a quick restart retries briefly.
        let address = SocketAddr::from(([0, 0, 0, 0], AUDIO_SINK_UDP_PORT)).into();
        let mut attempts = 0;
        while let Err(e) = raw.bind(&address) {
            attempts += 1;
            if e.kind() != std::io::ErrorKind::AddrInUse || attempts >= 20 {
                return Err(udp_error(e));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let udp = Arc::new(UdpSocket::from_std(raw.into()).map_err(udp_error)?);
        let (capture, relay, format) = begin_capture(self, device_id, udp.clone()).await?;
        let server = self.serve_guests(AUDIO_SINK_PORT, "Audio sink", listener_connection).await?;
        let hello = tokio::spawn(receive_hello(self.clone(), udp.clone())).abort_handle();
        if let Ok(mut host) = self.audio.hosting.lock() {
            *host = Some(Hosting { _timer: TimerResolution::request(), server, hello, relay, _capture: capture, udp, format, muted: false, listeners: HashMap::new(), tokens: HashMap::new() });
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

    /// A peer opened its audio sink tab and asks whether this PC is hosting.
    pub(crate) async fn answer_audio_sink_query(&self, device_id: &str) {
        self.offer_audio_sink_to(device_id).await;
    }

    pub async fn stop_audio_sink(&self) {
        let _lifecycle = self.audio.lifecycle.lock().await;
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
                self.emit_event(&service.event("pin-computed"), json!({ "pin": self.client_pin(&server_cert) })).await;
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
    /// Takes one decrypted payload and returns whatever is now ready to play, in order, each with
    /// how many packets were given up as lost just before it (so the decoder can conceal them).
    fn push(&mut self, seq: u32, payload: Vec<u8>) -> Vec<(Vec<u8>, u32)> {
        let next = *self.next.get_or_insert(seq);
        if seq < next {
            return Vec::new();
        }
        self.held.insert(seq, payload);
        let mut lost = 0;
        // Too many later packets piled up without the gap filling: it was a loss, skip it.
        if self.held.len() > REORDER_WINDOW_MAX {
            let first = self.held.keys().next().copied();
            lost = first.map_or(0, |f| f.saturating_sub(next));
            self.next = first;
        }
        let mut ready = Vec::new();
        while let Some(payload) = self.next.and_then(|n| self.held.remove(&n)) {
            ready.push((payload, std::mem::take(&mut lost)));
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

/// Runs a listening session until it ends. Returns whether it ended gracefully and the reason to
/// report, or no reason when the local side left.
async fn run_listener(manager: &DeviceManager, service: Service, mut ws: ClientWs, peer: SocketAddr, mut leave: mpsc::Receiver<()>) -> (bool, Option<String>) {
    let mut udp: Option<UdpSocket> = None;
    let mut key: Option<LessSafeKey> = None;
    let mut reorder = Reorder { next: None, held: BTreeMap::new() };
    // Set up by each "format" message: the decoder, the native player it feeds, and the channel count.
    let mut stream: Option<(OpusDecoder, Player, usize)> = None;
    let mut datagram = vec![0u8; 4096];
    let mut pcm = vec![0i16; 5760 * 2];
    // The hello is one UDP datagram with no acknowledgement. The first packet to a host this PC has not
    // talked to recently is often dropped (ARP resolution, firewall), and the host then never learns
    // where to send audio, so the first session stays silent while the next one works. Repeat it until
    // audio arrives.
    let mut hello_id: Option<String> = None;
    let mut heard_audio = false;
    let mut hello_attempts = 0u32;
    let mut hello_retry = tokio::time::interval(Duration::from_millis(250));
    hello_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
                            let bound = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, None).ok().and_then(|raw| {
                                let _ = raw.set_recv_buffer_size(UDP_SEND_BUFFER_BYTES);
                                raw.set_nonblocking(true).ok()?;
                                raw.bind(&SocketAddr::from(([0, 0, 0, 0], 0)).into()).ok()?;
                                UdpSocket::from_std(raw.into()).ok()
                            });
                            if let Some(socket) = bound {
                                let _ = socket.send_to(conn_id.as_bytes(), (peer.ip(), service.port() + 1)).await;
                                udp = Some(socket);
                                hello_id = Some(conn_id.to_string());
                                heard_audio = false;
                                hello_attempts = 0;
                            }
                            manager.emit_event(&service.event("admitted"), json!({ "hostName": msg["hostName"].as_str().unwrap_or_default() })).await;
                        }
                        Some("format") => {
                            // Every host sends Opus. The previous player stops when it is replaced.
                            stream = None;
                            let channels = msg["channels"].as_u64().unwrap_or(2).clamp(1, 2) as usize;
                            let sample_rate = msg["sampleRate"].as_u64().unwrap_or(48_000) as u32;
                            match OpusDecoder::new(sample_rate, channels) {
                                Ok(decoder) => stream = Some((decoder, Player::start(manager.audio.output(service).clone(), sample_rate, channels as u16), channels)),
                                Err(e) => manager.emit_event(&service.event("error"), json!({ "message": format!("Failed to initialize the Opus decoder: {e}") })).await,
                            }
                        }
                        Some("hostMuted") => manager.emit_event(&service.event("host-muted"), json!({ "muted": msg["muted"].as_bool().unwrap_or(false) })).await,
                        _ => {}
                    }
                }
                // 1000 and 1001 are how a host ends the session or removes this listener; the reason tells which.
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
                heard_audio = true;
                let Some((decoder, player, channels)) = stream.as_mut() else { continue };
                for (ready, lost) in reorder.push(seq, payload) {
                    let Some((&CODEC_OPUS, body)) = ready.split_first() else { continue };
                    // Lost packets are filled in by the decoder's concealment (it extends the last
                    // sound smoothly) instead of jumping straight to the next packet with a click.
                    for _ in 0..lost.min(MAX_CONCEALED_FRAMES) {
                        let Ok(per_channel) = decoder.decode(&[], &mut pcm, false) else { break };
                        player.push(&pcm[..per_channel * *channels]);
                    }
                    // A frame that fails to decode is dropped like a lost packet.
                    if let Ok(per_channel) = decoder.decode(body, &mut pcm, false) {
                        player.push(&pcm[..per_channel * *channels]);
                    }
                }
            },
            _ = hello_retry.tick() => {
                // About ten seconds of retries; a host with nothing to play stays quiet and is not an error.
                if !heard_audio && hello_attempts < 40 {
                    if let (Some(socket), Some(id)) = (&udp, &hello_id) {
                        let _ = socket.send_to(id.as_bytes(), (peer.ip(), service.port() + 1)).await;
                        hello_attempts += 1;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_frames_fit_in_a_packet_at_the_chosen_bitrate() {
        let format = Format { sample_rate: 48_000, channels: 2, bits_per_sample: 32, is_float: true };
        let encoder = new_encoder(format).expect("encoder starts for 48 kHz stereo");
        let frame_samples = 48_000 / 1000 * OPUS_FRAME_MS * 2;
        // A tone, so the encoder has something to spend bits on.
        let frame: Vec<i16> = (0..frame_samples).map(|i| (((i / 2) as f32 * 0.05).sin() * 12_000.0) as i16).collect();
        let mut packet = [0u8; MAX_OPUS_PACKET_BYTES];
        let length = encoder.encode(&frame, &mut packet).expect("a frame encodes");
        assert!(length > 0 && length < 500, "10 ms at 192 kbps is about 240 bytes, got {length}");
    }

    #[test]
    fn a_skipped_gap_reports_how_many_packets_were_lost() {
        let mut reorder = Reorder { next: None, held: BTreeMap::new() };
        assert_eq!(reorder.push(5, vec![5]), vec![(vec![5], 0)]);
        // 6 and 7 never arrive; later packets pile up until the window gives up on them.
        for seq in 8..8 + REORDER_WINDOW_MAX as u32 {
            assert!(reorder.push(seq, vec![seq as u8]).is_empty());
        }
        let ready = reorder.push(8 + REORDER_WINDOW_MAX as u32, vec![0]);
        assert_eq!(ready.len(), REORDER_WINDOW_MAX + 1);
        assert_eq!(ready[0], (vec![8], 2), "the first packet after the gap says two were lost");
        assert!(ready[1..].iter().all(|(_, lost)| *lost == 0));
    }

    /// Concealment for a lost packet gives a frame of the usual length, which is what the listener
    /// splices in place of the missing audio.
    #[test]
    fn the_decoder_conceals_a_lost_frame_with_audio_of_the_same_length() {
        let format = Format { sample_rate: 48_000, channels: 2, bits_per_sample: 16, is_float: false };
        let encoder = new_encoder(format).expect("encoder starts");
        let mut decoder = OpusDecoder::new(48_000, 2).expect("decoder starts");
        let per_frame = 48_000 / 1000 * OPUS_FRAME_MS;
        let frame = vec![1000i16; per_frame * 2];
        let mut packet = [0u8; MAX_OPUS_PACKET_BYTES];
        let mut pcm = vec![0i16; 5760 * 2];
        let length = encoder.encode(&frame, &mut packet).unwrap();
        assert_eq!(decoder.decode(&packet[..length], &mut pcm, false).unwrap(), per_frame);
        assert_eq!(decoder.decode(&[], &mut pcm, false).unwrap(), per_frame);
    }

    /// The low-delay stream must still be ordinary Opus that the listeners' decoders take, and come
    /// back close to the original: a tone through encode and decode keeps a high signal-to-noise ratio.
    #[test]
    fn a_tone_survives_the_low_delay_encoder_with_high_fidelity() {
        let format = Format { sample_rate: 48_000, channels: 2, bits_per_sample: 16, is_float: false };
        let encoder = new_encoder(format).expect("encoder starts");
        let mut decoder = OpusDecoder::new(48_000, 2).expect("decoder starts");
        let per_frame = 48_000 / 1000 * OPUS_FRAME_MS;
        let tone = |n: usize| ((n as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48_000.0).sin() * 12_000.0) as i16;
        let (mut sent, mut got) = (Vec::new(), Vec::new());
        let mut packet = [0u8; MAX_OPUS_PACKET_BYTES];
        let mut pcm = vec![0i16; 5760 * 2];
        for f in 0..50 {
            let frame: Vec<i16> = (0..per_frame).flat_map(|i| {
                let s = tone(f * per_frame + i);
                [s, s]
            }).collect();
            let length = encoder.encode(&frame, &mut packet).unwrap();
            let decoded = decoder.decode(&packet[..length], &mut pcm, false).unwrap();
            sent.extend(frame.iter().step_by(2).copied());
            got.extend(pcm[..decoded * 2].iter().step_by(2).copied());
        }
        // Line the output up with the input (the codec delays it a little), then compare.
        let window = 48_000 / 10;
        let best = (0..480)
            .map(|lag| {
                let (mut signal, mut noise) = (0f64, 0f64);
                for i in 0..window {
                    let (a, b) = (sent[i + 9600] as f64, got[i + 9600 + lag] as f64);
                    signal += a * a;
                    noise += (a - b) * (a - b);
                }
                (10.0 * (signal / noise.max(1.0)).log10(), lag)
            })
            .fold((f64::MIN, 0), |a, b| if b.0 > a.0 { b } else { a });
        println!("SNR {:.1} dB", best.0);
        assert!(best.0 > 30.0, "SNR only {:.1} dB", best.0);
    }
}
