// Receives a paired phone's camera natively and feeds it straight to the virtual webcam.
//
// Rust answers the phone's WebRTC offer itself: RTP -> H.264 depacketizer -> OpenH264 decoder ->
// mirror/crop/zoom -> the camera's own frame buffer. No WebView or JPEG step sits in between, so it
// keeps working when the UI is hidden or throttled.
//
// The UI still owns the session (it asks the phone for its camera, lens and flip), it just does not
// open a peer connection. The virtual webcam requires the H.264 component (the UI offers the
// download); when a stream fails or stalls the UI starts the session again (see cameraManager.ts).
// The Camera panel uses this same session: while it polls `preview_frame` (~15 fps) the composed frame
// is also downscaled and JPEG-encoded for it, so the phone's single stream feeds both. Nothing is
// encoded once the panel stops polling.
//
// The offer/answer and ICE candidates travel as `link.remotecontrol.signal` packets, like screen sharing,
// with the roles reversed: the phone offers and this PC answers.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openh264::decoder::{Decoder, DecoderConfig};
use openh264::formats::YUVSource;
use rtc::interceptor::NackGeneratorBuilder;
use rtc::peer_connection::configuration::interceptor_registry::{register_default_interceptors, Slot};
use rtc::peer_connection::configuration::media_engine::MIME_TYPE_H264;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp::codec::h264::H264Packet;
use rtc::rtp::packetizer::Depacketizer;
use rtc::rtp_transceiver::rtp_sender::{RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RtpCodecKind};
use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceCandidateInit,
    RTCIceGatheringState, RTCPeerConnectionState, RTCSessionDescription, Registry,
};

use crate::core::packet::LinkPacket;
use crate::core::plugins::vcam::{self, HEIGHT, WIDTH};
use crate::core::transport::DeviceManager;

/// How long to wait for ICE gathering before answering with whatever was found.
const GATHER_TIMEOUT: Duration = Duration::from_secs(3);
/// Access units waiting for the decoder. Small on purpose: a long queue is just latency.
const FRAME_QUEUE: usize = 6;
/// Least time between two requests for a new keyframe. Short, because until one arrives the camera
/// shows a frozen picture; the phone's encoder ignores requests faster than it can serve them anyway.
const KEYFRAME_REQUEST_GAP: Duration = Duration::from_millis(200);
/// How often missing packets are asked for again (NACK). The library default of 100 ms is longer than
/// the reorder window below, so a resent packet would always arrive too late to be used.
const NACK_INTERVAL: Duration = Duration::from_millis(20);
/// How many times one missing packet is asked for before it is given up.
const NACKS_PER_PACKET: u16 = 3;
/// How long later packets are held while a gap waits for its resent packet. On a home network a NACK
/// round trip is a few milliseconds plus up to one NACK_INTERVAL, so this catches most retransmits
/// while adding no delay at all when nothing is lost.
const REORDER_HOLD: Duration = Duration::from_millis(40);
/// Packets held at most; a 720p keyframe is around a hundred, so this is several pictures' worth.
const REORDER_MAX_PACKETS: usize = 512;
/// A packet this far behind the expected one is not late: the sender restarted its numbering.
const SEQUENCE_RESTART: i64 = 1000;
const H264_PROFILES: [(u8, &str); 4] = [
    // Constrained baseline, constrained high, main, baseline: what phones' hardware encoders offer.
    (102, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"),
    (104, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f"),
    (106, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f"),
    (108, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"),
];

/// How the picture is placed on the camera's frame, the same choices the Camera panel has.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Compose {
    pub mirror: bool,
    /// Fill the whole frame (cropping) instead of fitting inside it with bars.
    pub fill: bool,
    /// Zoom still to be done by cropping, after the best lens has been chosen. 1 = none.
    pub zoom: f32,
}

impl Default for Compose {
    fn default() -> Self {
        Compose { mirror: false, fill: false, zoom: 1.0 }
    }
}

static COMPOSE: Mutex<Compose> = Mutex::new(Compose { mirror: false, fill: false, zoom: 1.0 });

pub fn set_compose(compose: Compose) {
    if let Ok(mut current) = COMPOSE.lock() {
        *current = compose;
    }
}

fn compose_now() -> Compose {
    COMPOSE.lock().map(|c| *c).unwrap_or_default()
}

/// Width of the Camera panel's preview pictures.
const PREVIEW_WIDTH: u32 = 480;
/// Least time between two preview pictures (about 15 per second).
const PREVIEW_INTERVAL: Duration = Duration::from_millis(66);
/// The preview is produced for this long after the panel last asked for a picture.
const PREVIEW_KEEPALIVE: Duration = Duration::from_secs(2);

struct Preview {
    wanted_until: Option<Instant>,
    seq: u64,
    jpeg: Vec<u8>,
}

static PREVIEW: Mutex<Preview> = Mutex::new(Preview { wanted_until: None, seq: 0, jpeg: Vec::new() });

/// The newest preview picture for the Camera panel: 8 bytes (little-endian picture number) then the JPEG,
/// or nothing when there is no newer picture than `since`. Asking also keeps the preview being produced.
pub fn preview_frame(since: u64) -> Vec<u8> {
    let Ok(mut preview) = PREVIEW.lock() else { return Vec::new() };
    preview.wanted_until = Some(Instant::now() + PREVIEW_KEEPALIVE);
    if preview.seq == since || preview.jpeg.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(8 + preview.jpeg.len());
    out.extend_from_slice(&preview.seq.to_le_bytes());
    out.extend_from_slice(&preview.jpeg);
    out
}

fn preview_wanted() -> bool {
    PREVIEW.lock().is_ok_and(|p| p.wanted_until.is_some_and(|until| until > Instant::now()))
}

/// Shrinks the camera frame (BGR) to a preview JPEG and publishes it. `jpeg` is a reused buffer.
fn publish_preview(bgr: &[u8], jpeg: &mut Vec<u8>) {
    let Some(view) = image::ImageBuffer::<image::Rgb<u8>, &[u8]>::from_raw(WIDTH, HEIGHT, bgr) else { return };
    let mut small = image::imageops::thumbnail(&view, PREVIEW_WIDTH, (PREVIEW_WIDTH * HEIGHT / WIDTH).max(1));
    // The frame is BGR but was read as RGB: swap back on the small copy.
    for px in small.pixels_mut() {
        px.0.swap(0, 2);
    }
    jpeg.clear();
    if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut *jpeg, 70).encode_image(&small).is_err() {
        return;
    }
    if let Ok(mut preview) = PREVIEW.lock() {
        std::mem::swap(&mut preview.jpeg, jpeg);
        preview.seq += 1;
    }
}

/// What the UI can ask about a native session.
#[derive(Default)]
pub struct Status {
    offered: AtomicBool,
    error: Mutex<Option<String>>,
}

impl Status {
    fn fail(&self, reason: impl Into<String>) {
        let reason = reason.into();
        log::warn!("[CameraRx] {reason}");
        if let Ok(mut error) = self.error.lock() {
            error.get_or_insert(reason);
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "offered": self.offered.load(Ordering::Relaxed),
            "live": vcam::native_frames_flowing(),
            "error": self.error.lock().ok().and_then(|e| e.clone()),
        })
    }
}

/// Whether this PC can decode a phone's camera itself: it needs the H.264 component.
pub fn available(config_dir: &std::path::Path) -> bool {
    cfg!(windows) && crate::core::openh264_lib::is_installed(config_dir)
}

pub enum CamSignal {
    Offer(String),
    Candidate(RTCIceCandidateInit),
}

/// Parses a `link.remotecontrol.signal` body from the phone. None for anything this does not handle.
pub fn parse_signal(body: &Value) -> Option<CamSignal> {
    match body.get("type")?.as_str()? {
        "webrtc_offer" => Some(CamSignal::Offer(body.get("sdp")?.as_str()?.to_string())),
        "webrtc_candidate" => match crate::core::rtc_share::parse_signal(body)? {
            crate::core::rtc_share::Signal::Candidate(c) => Some(CamSignal::Candidate(c)),
            _ => None,
        },
        _ => None,
    }
}

/// Runs one camera session until the task is aborted. A new offer from the phone (it renegotiates when
/// asked again) replaces the previous connection.
pub async fn run(manager: Arc<DeviceManager>, target: String, mut signals: mpsc::UnboundedReceiver<CamSignal>, status: Arc<Status>) {
    let mut current: Option<(AbortOnDrop, mpsc::UnboundedSender<RTCIceCandidateInit>)> = None;
    while let Some(signal) = signals.recv().await {
        match signal {
            CamSignal::Offer(sdp) => {
                status.offered.store(true, Ordering::Relaxed);
                let (candidates_tx, candidates_rx) = mpsc::unbounded_channel();
                let task = tokio::spawn(session(manager.clone(), target.clone(), sdp, candidates_rx, status.clone()));
                // The previous connection is dropped (and closed) as it is replaced.
                current = Some((AbortOnDrop(task), candidates_tx));
            }
            CamSignal::Candidate(candidate) => {
                if let Some((_, candidates)) = &current {
                    let _ = candidates.send(candidate);
                }
            }
        }
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Closes the peer connection however the session ends, including by being aborted.
struct CloseOnDrop(Arc<dyn PeerConnection>);

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        let peer = self.0.clone();
        tokio::spawn(async move {
            let _ = peer.close().await;
        });
    }
}

#[derive(Clone)]
struct Handler {
    gathered: mpsc::UnboundedSender<()>,
    ended: mpsc::UnboundedSender<()>,
    frames: SyncSender<Vec<u8>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.send(());
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        log::info!("[CameraRx] WebRTC connection state: {}", state);
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
            let _ = self.ended.send(());
        }
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        if track.kind().await != RtpCodecKind::Video {
            return;
        }
        let Some(ssrc) = track.ssrcs().await.first().copied() else { return };
        tokio::spawn(read_video(track, ssrc, self.frames.clone()));
    }
}

async fn session(manager: Arc<DeviceManager>, target: String, offer: String, candidates: mpsc::UnboundedReceiver<RTCIceCandidateInit>, status: Arc<Status>) {
    if let Err(e) = session_inner(&manager, &target, offer, candidates, &status).await {
        status.fail(format!("camera from {target} ended: {e}"));
    }
}

async fn session_inner(
    manager: &Arc<DeviceManager>,
    target: &str,
    offer: String,
    mut candidates: mpsc::UnboundedReceiver<RTCIceCandidateInit>,
    status: &Arc<Status>,
) -> Result<(), String> {
    let feedback = || {
        vec![
            RTCPFeedback { typ: "nack".to_owned(), parameter: String::new() },
            RTCPFeedback { typ: "nack".to_owned(), parameter: "pli".to_owned() },
            RTCPFeedback { typ: "ccm".to_owned(), parameter: "fir".to_owned() },
        ]
    };
    let mut media_engine = MediaEngine::default();
    for (payload_type, fmtp) in H264_PROFILES {
        let codec = RTCRtpCodecParameters {
            rtp_codec: RTCRtpCodec {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: fmtp.to_owned(),
                rtcp_feedback: feedback(),
            },
            payload_type,
            ..Default::default()
        };
        media_engine.register_codec(codec, RtpCodecKind::Video).map_err(|e| e.to_string())?;
    }
    let registry = register_default_interceptors(Registry::new(), &mut media_engine)
        .map_err(|e| e.to_string())?
        // Replaces the default NACK generator (one slot holds one interceptor) with a quicker one, so
        // resent packets land inside the reorder window in read_video.
        .with(Slot::NackGenerator, NackGeneratorBuilder::new().with_interval(NACK_INTERVAL).with_max_nacks_per_packet(NACKS_PER_PACKET).build());

    // The decoder runs on its own thread: decoding must not hold up the async runtime, and the picture
    // goes straight from there to the camera.
    let (frames_tx, frames_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(FRAME_QUEUE);
    let config_dir = manager.config_dir.clone();
    let decode_status = status.clone();
    std::thread::Builder::new()
        .name("link-camera-decode".into())
        .spawn(move || decode_loop(config_dir, frames_rx, decode_status))
        .map_err(|e| format!("could not start the decoder: {e}"))?;

    let (gathered_tx, mut gathered_rx) = mpsc::unbounded_channel();
    let (ended_tx, mut ended_rx) = mpsc::unbounded_channel();
    // No STUN server: both ends are on the same network.
    let peer: Arc<dyn PeerConnection> = Arc::new(
        PeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_handler(Arc::new(Handler { gathered: gathered_tx, ended: ended_tx, frames: frames_tx }))
            .with_runtime(webrtc::runtime::default_runtime().ok_or("no async runtime for WebRTC")?)
            .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
            .build()
            .await
            .map_err(|e| e.to_string())?,
    );
    let _close = CloseOnDrop(peer.clone());

    peer.add_transceiver_from_kind(RtpCodecKind::Video, Some(RTCRtpTransceiverInit { direction: RTCRtpTransceiverDirection::Recvonly, ..Default::default() }))
        .await
        .map_err(|e| e.to_string())?;
    peer.set_remote_description(RTCSessionDescription::offer(offer).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
    let answer = peer.create_answer(None).await.map_err(|e| e.to_string())?;
    peer.set_local_description(answer).await.map_err(|e| e.to_string())?;
    // Answer with every candidate inside it, so the phone does not wait for trickled ones.
    let _ = tokio::time::timeout(GATHER_TIMEOUT, gathered_rx.recv()).await;
    let sdp = peer.local_description().await.ok_or("no local description")?.sdp;
    manager.send_link_packet(target, LinkPacket::new("link.remotecontrol.signal", json!({ "type": "webrtc_answer", "sdp": sdp }))).await?;
    log::info!("[CameraRx] answered the offer from {target}");

    loop {
        tokio::select! {
            candidate = candidates.recv() => match candidate {
                Some(c) => { let _ = peer.add_ice_candidate(c).await; }
                None => return Ok(()),
            },
            _ = ended_rx.recv() => return Err("the connection ended".to_string()),
        }
    }
}

async fn request_keyframe(track: &Arc<dyn TrackRemote>, media_ssrc: u32) {
    let _ = track.write_rtcp(vec![Box::new(PictureLossIndication { sender_ssrc: 0, media_ssrc })]).await;
}

/// Puts RTP packets back in sequence order. Wi-Fi reorders packets, and a lost one is asked for again
/// (NACK) and arrives late, so packets after a gap are held for up to REORDER_HOLD instead of the
/// picture being thrown away at once. Sequence numbers are widened to i64 so wrapping at 65535 needs
/// no special case.
struct Reorder<T> {
    /// The widened sequence number expected next.
    next: Option<i64>,
    held: BTreeMap<i64, T>,
    /// When the current gap opened, while packets are held behind it.
    gap_since: Option<Instant>,
}

impl<T> Reorder<T> {
    fn new() -> Self {
        Reorder { next: None, held: BTreeMap::new(), gap_since: None }
    }

    fn widen(&self, seq: u16) -> i64 {
        match self.next {
            Some(next) => next + i64::from(seq.wrapping_sub(next as u16) as i16),
            None => i64::from(seq),
        }
    }

    /// Takes one packet. Whatever is now in order is appended to `ready`, each with whether packets
    /// were given up as lost just before it.
    fn push(&mut self, seq: u16, item: T, now: Instant, ready: &mut Vec<(T, bool)>) {
        let at = self.widen(seq);
        let next = *self.next.get_or_insert(at);
        if at < next {
            if next - at < SEQUENCE_RESTART {
                // Late or repeated: its place has already been passed.
                return;
            }
            // The sender started counting again: begin from here, as after a loss.
            self.held.clear();
            self.next = Some(at);
            self.gap_since = None;
            ready.push((item, true));
            self.next = Some(at + 1);
            return;
        }
        self.held.entry(at).or_insert(item);
        self.release(now, false, ready);
    }

    /// Gives up on the gap once it has been waited for long enough (or too much piles up behind it).
    fn expire(&mut self, now: Instant, ready: &mut Vec<(T, bool)>) {
        let overdue = self.gap_since.is_some_and(|since| now.duration_since(since) >= REORDER_HOLD);
        if overdue || self.held.len() > REORDER_MAX_PACKETS {
            if let Some(&first) = self.held.keys().next() {
                self.next = Some(first);
                self.release(now, true, ready);
            }
        }
    }

    /// When the gap being waited on is to be given up, if one is open.
    fn deadline(&self) -> Option<Instant> {
        self.gap_since.map(|since| since + REORDER_HOLD)
    }

    fn release(&mut self, now: Instant, mut after_loss: bool, ready: &mut Vec<(T, bool)>) {
        let mut released = false;
        while let Some(next) = self.next {
            let Some(item) = self.held.remove(&next) else { break };
            ready.push((item, std::mem::take(&mut after_loss)));
            self.next = Some(next + 1);
            released = true;
        }
        // A gap still open after progress is a new gap, and gets the full hold time of its own.
        self.gap_since = match (self.held.is_empty(), released) {
            (true, _) => None,
            (false, true) => Some(now),
            (false, false) => Some(self.gap_since.unwrap_or(now)),
        };
    }
}

/// Builds whole pictures (access units, in Annex B form) from in-order RTP payloads.
struct Assembler {
    depacketizer: H264Packet,
    unit: Vec<u8>,
    /// Starts true: the first picture to decode has to be a keyframe.
    need_keyframe: bool,
    skip_to_marker: bool,
}

impl Assembler {
    fn new() -> Self {
        Assembler { depacketizer: H264Packet::default(), unit: Vec::new(), need_keyframe: true, skip_to_marker: false }
    }

    /// Takes the next payload in order; returns a picture when one is complete and decodable.
    fn packet(&mut self, payload: &bytes::Bytes, marker: bool, after_loss: bool) -> Option<Vec<u8>> {
        if after_loss {
            // Packets were lost: whatever picture was being built is unusable.
            self.unit.clear();
            self.depacketizer = H264Packet::default();
            self.need_keyframe = true;
            self.skip_to_marker = true;
        }
        if self.skip_to_marker {
            // The rest of the damaged picture.
            if marker {
                self.skip_to_marker = false;
            }
            return None;
        }
        match self.depacketizer.depacketize(payload) {
            Ok(data) => self.unit.extend_from_slice(&data),
            Err(_) => {
                self.unit.clear();
                self.depacketizer = H264Packet::default();
                self.need_keyframe = true;
                self.skip_to_marker = !marker;
            }
        }
        if !marker || self.unit.is_empty() {
            return None;
        }
        let picture = std::mem::take(&mut self.unit);
        if self.need_keyframe && has_keyframe(&picture) {
            self.need_keyframe = false;
        }
        (!self.need_keyframe).then_some(picture)
    }
}

/// Reads the phone's video track: puts RTP packets back in order and together into whole pictures and
/// hands them to the decoder. After lost packets it waits for the next keyframe, since decoding without
/// it only shows garbage, and asks for one.
async fn read_video(track: Arc<dyn TrackRemote>, ssrc: u32, frames: SyncSender<Vec<u8>>) {
    let mut reorder = Reorder::new();
    let mut assembler = Assembler::new();
    let mut ready = Vec::new();
    request_keyframe(&track, ssrc).await;
    let mut last_request = Instant::now();

    loop {
        // While a gap is open, wake up when it is due to be given up even if nothing else arrives.
        // The outer None is that wake-up; the inner None is the track ending.
        let event = match reorder.deadline() {
            Some(deadline) => match tokio::time::timeout_at(deadline.into(), track.poll()).await {
                Ok(event) => Some(event),
                Err(_) => {
                    reorder.expire(Instant::now(), &mut ready);
                    None
                }
            },
            None => Some(track.poll().await),
        };
        match event {
            Some(Some(TrackRemoteEvent::OnRtpPacket(packet))) => {
                let now = Instant::now();
                reorder.push(packet.header.sequence_number, packet, now, &mut ready);
                reorder.expire(now, &mut ready);
            }
            Some(Some(_)) => continue,
            Some(None) => return,
            None => {}
        }

        for (packet, after_loss) in ready.drain(..) {
            let Some(picture) = assembler.packet(&packet.payload, packet.header.marker, after_loss) else { continue };
            match frames.try_send(picture) {
                Ok(()) => {}
                // The decoder is behind: later pictures depend on this one, so wait for a keyframe.
                Err(TrySendError::Full(_)) => assembler.need_keyframe = true,
                Err(TrySendError::Disconnected(_)) => return,
            }
        }

        if assembler.need_keyframe && last_request.elapsed() >= KEYFRAME_REQUEST_GAP {
            request_keyframe(&track, ssrc).await;
            last_request = Instant::now();
        }
    }
}

/// Whether an Annex B access unit holds a keyframe: an IDR slice (5) or the stream's parameters (SPS, 7).
fn has_keyframe(unit: &[u8]) -> bool {
    let mut i = 0;
    while i + 4 < unit.len() {
        if unit[i] == 0 && unit[i + 1] == 0 && unit[i + 2] == 1 {
            if matches!(unit[i + 3] & 0x1f, 5 | 7) {
                return true;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    false
}

/// Decodes pictures and sends each to the camera. When several are waiting, all are decoded (later ones
/// depend on earlier ones) but only the newest is drawn, so a slow moment never turns into lasting delay.
fn decode_loop(config_dir: PathBuf, pictures: Receiver<Vec<u8>>, status: Arc<Status>) {
    let api = match crate::core::openh264_lib::load_api(&config_dir) {
        Ok(api) => api,
        Err(e) => return status.fail(format!("the H.264 component could not be loaded: {e}")),
    };
    let mut decoder = match Decoder::with_api_config(api, DecoderConfig::new()) {
        Ok(decoder) => decoder,
        Err(e) => return status.fail(format!("the H.264 decoder could not start: {e}")),
    };
    let mut rgb: Vec<u8> = Vec::new();
    // The camera frame is drawn here, outside the camera's lock, and only handed over to be sent; the
    // UI's status polls then never wait behind a conversion.
    let mut bgr: Vec<u8> = vec![0u8; (WIDTH * HEIGHT * 3) as usize];
    let mut jpeg: Vec<u8> = Vec::new();
    let mut last_preview = Instant::now();
    let mut shown = 0u32;
    let mut busy = Duration::ZERO;
    let mut errors = 0u32;

    while let Ok(first) = pictures.recv() {
        let mut batch = vec![first];
        loop {
            match pictures.try_recv() {
                Ok(next) => batch.push(next),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        let last = batch.len() - 1;
        for (index, picture) in batch.iter().enumerate() {
            let started = Instant::now();
            match decoder.decode(picture) {
                Ok(Some(yuv)) if index == last => {
                    let (width, height) = yuv.dimensions();
                    // Every picture is decoded (later ones depend on it), but turning it into a camera
                    // frame is only worth it while some program is reading the camera.
                    let to_camera = vcam::want_native_frame();
                    let to_preview = last_preview.elapsed() >= PREVIEW_INTERVAL && preview_wanted();
                    if to_camera || to_preview {
                        rgb.resize(width * height * 3, 0);
                        yuv.write_rgb8(&mut rgb);
                        compose_bgr(&rgb, width as u32, height as u32, &mut bgr, compose_now());
                        if to_camera {
                            if let Err(e) = vcam::send_bgr_frame(&bgr) {
                                errors += 1;
                                if errors <= 3 {
                                    log::warn!("[CameraRx] frame not sent: {e}");
                                }
                            }
                        }
                        if to_preview {
                            last_preview = Instant::now();
                            publish_preview(&bgr, &mut jpeg);
                        }
                    }
                    if shown == 0 {
                        log::info!("[CameraRx] first picture: {width}x{height}");
                    }
                    shown += 1;
                    busy += started.elapsed();
                    if shown % 150 == 0 {
                        log::info!("[CameraRx] {width}x{height}: {:?} per picture over the last 150", busy / 150);
                        busy = Duration::ZERO;
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    errors += 1;
                    if errors <= 3 {
                        log::warn!("[CameraRx] undecodable picture: {e}");
                    }
                }
            }
        }
    }
}

/// Draws `rgb` (`sw` x `sh`, tightly packed RGB) onto `out`, the camera's WIDTH x HEIGHT BGR frame, with
/// the same placing rules as the UI's canvas used (mirror, fill or fit, zoom), black where nothing lands.
pub fn compose_bgr(rgb: &[u8], sw: u32, sh: u32, out: &mut [u8], compose: Compose) {
    let (cw, ch) = (WIDTH as i64, HEIGHT as i64);
    out.fill(0);
    if sw == 0 || sh == 0 || rgb.len() < sw as usize * sh as usize * 3 || out.len() < cw as usize * ch as usize * 3 {
        return;
    }
    let fit_w = cw as f64 / sw as f64;
    let fit_h = ch as f64 / sh as f64;
    let base = if compose.fill { fit_w.max(fit_h) } else { fit_w.min(fit_h) };
    let scale = base * f64::from(compose.zoom.max(0.1));
    let tw = ((sw as f64 * scale).round() as i64).max(1);
    let th = ((sh as f64 * scale).round() as i64).max(1);
    // Where the scaled picture's corner is on the canvas (negative when it is cropped).
    let dx0 = (cw - tw).div_euclid(2);
    let dy0 = (ch - th).div_euclid(2);
    // The part of it that actually lands on the canvas.
    let (vx0, vx1) = (dx0.max(0), (dx0 + tw).min(cw));
    let (vy0, vy1) = (dy0.max(0), (dy0 + th).min(ch));
    if vx1 <= vx0 || vy1 <= vy0 {
        return;
    }
    let (vw, vh) = ((vx1 - vx0) as usize, (vy1 - vy0) as usize);
    // The same part in the source's own pixels, so only that is scaled.
    let to_source = |v: i64, d0: i64, target: i64, source: u32| (((v - d0) as f64) * source as f64 / target as f64).round().clamp(0.0, source as f64) as u32;
    let sx0 = to_source(vx0, dx0, tw, sw).min(sw - 1);
    let sy0 = to_source(vy0, dy0, th, sh).min(sh - 1);
    let sx1 = to_source(vx1, dx0, tw, sw).max(sx0 + 1);
    let sy1 = to_source(vy1, dy0, th, sh).max(sy0 + 1);
    let (crop_w, crop_h) = ((sx1 - sx0).min(sw - sx0), (sy1 - sy0).min(sh - sy0));

    let scaled;
    let (pixels, stride, origin): (&[u8], usize, usize) = if crop_w as usize == vw && crop_h as usize == vh {
        // One source pixel per camera pixel: no scaling, just copy.
        (rgb, sw as usize * 3, (sy0 as usize * sw as usize + sx0 as usize) * 3)
    } else {
        let Some(view) = image::ImageBuffer::<image::Rgb<u8>, &[u8]>::from_raw(sw, sh, &rgb[..sw as usize * sh as usize * 3]) else { return };
        let part = image::imageops::crop_imm(&view, sx0, sy0, crop_w, crop_h);
        scaled = image::imageops::resize(&*part, vw as u32, vh as u32, image::imageops::FilterType::Triangle).into_raw();
        (&scaled, vw * 3, 0)
    };

    let canvas_w = cw as usize;
    for y in 0..vh {
        let row = &pixels[origin + y * stride..origin + y * stride + vw * 3];
        let out_row = &mut out[(vy0 as usize + y) * canvas_w * 3..(vy0 as usize + y + 1) * canvas_w * 3];
        for (i, px) in row.chunks_exact(3).enumerate() {
            let x = vx0 as usize + i;
            // Mirroring flips the whole frame, like the canvas did.
            let x = if compose.mirror { canvas_w - 1 - x } else { x };
            let o = x * 3;
            out_row[o] = px[2];
            out_row[o + 1] = px[1];
            out_row[o + 2] = px[0];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_of(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
        std::iter::repeat(color).take((width * height) as usize).flatten().collect()
    }

    fn set(rgb: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 3]) {
        let at = ((y * width + x) * 3) as usize;
        rgb[at..at + 3].copy_from_slice(&color);
    }

    fn out_buffer() -> Vec<u8> {
        vec![7u8; (WIDTH * HEIGHT * 3) as usize]
    }

    fn at(out: &[u8], x: u32, y: u32) -> [u8; 3] {
        let i = ((y * WIDTH + x) * 3) as usize;
        [out[i], out[i + 1], out[i + 2]]
    }

    #[test]
    fn a_picture_of_the_cameras_size_is_copied_as_bgr() {
        let mut rgb = frame_of(WIDTH, HEIGHT, [0, 0, 0]);
        set(&mut rgb, WIDTH, 10, 20, [1, 2, 3]);
        let mut out = out_buffer();
        compose_bgr(&rgb, WIDTH, HEIGHT, &mut out, Compose::default());
        assert_eq!(at(&out, 10, 20), [3, 2, 1]);
        assert_eq!(at(&out, 11, 20), [0, 0, 0]);
    }

    #[test]
    fn mirroring_flips_the_whole_frame() {
        let mut rgb = frame_of(WIDTH, HEIGHT, [0, 0, 0]);
        set(&mut rgb, WIDTH, 0, 0, [1, 2, 3]);
        let mut out = out_buffer();
        compose_bgr(&rgb, WIDTH, HEIGHT, &mut out, Compose { mirror: true, ..Compose::default() });
        assert_eq!(at(&out, WIDTH - 1, 0), [3, 2, 1]);
        assert_eq!(at(&out, 0, 0), [0, 0, 0]);
    }

    #[test]
    fn a_square_picture_is_centred_with_black_bars() {
        let mut rgb = frame_of(HEIGHT, HEIGHT, [10, 20, 30]);
        set(&mut rgb, HEIGHT, 0, 0, [1, 2, 3]);
        let mut out = out_buffer();
        compose_bgr(&rgb, HEIGHT, HEIGHT, &mut out, Compose::default());
        let bar = (WIDTH - HEIGHT) / 2;
        assert_eq!(at(&out, 0, 0), [0, 0, 0], "bars are black, not left over from the last frame");
        assert_eq!(at(&out, bar - 1, 100), [0, 0, 0]);
        assert_eq!(at(&out, bar, 0), [3, 2, 1]);
        assert_eq!(at(&out, bar + 5, 5), [30, 20, 10]);
        assert_eq!(at(&out, WIDTH - 1, 100), [0, 0, 0]);
    }

    #[test]
    fn filling_crops_a_tall_picture_around_its_middle() {
        let (sw, sh) = (WIDTH, HEIGHT * 2);
        let mut rgb = frame_of(sw, sh, [0, 0, 0]);
        set(&mut rgb, sw, 0, HEIGHT / 2, [1, 2, 3]);
        let mut out = out_buffer();
        compose_bgr(&rgb, sw, sh, &mut out, Compose { fill: true, ..Compose::default() });
        assert_eq!(at(&out, 0, 0), [3, 2, 1], "the top of the frame is the source's row 360");
    }

    #[test]
    fn zooming_in_keeps_colours_and_fills_the_frame() {
        let rgb = frame_of(WIDTH, HEIGHT, [40, 50, 60]);
        let mut out = out_buffer();
        compose_bgr(&rgb, WIDTH, HEIGHT, &mut out, Compose { zoom: 2.0, ..Compose::default() });
        assert_eq!(at(&out, 0, 0), [60, 50, 40]);
        assert_eq!(at(&out, WIDTH - 1, HEIGHT - 1), [60, 50, 40]);
        assert_eq!(at(&out, WIDTH / 2, HEIGHT / 2), [60, 50, 40]);
    }

    #[test]
    fn a_smaller_picture_is_scaled_up_to_fit() {
        let rgb = frame_of(640, 360, [40, 50, 60]);
        let mut out = out_buffer();
        compose_bgr(&rgb, 640, 360, &mut out, Compose::default());
        assert_eq!(at(&out, 0, 0), [60, 50, 40]);
        assert_eq!(at(&out, WIDTH - 1, HEIGHT - 1), [60, 50, 40]);
    }

    #[test]
    fn a_truncated_picture_gives_a_black_frame_rather_than_reading_out_of_bounds() {
        let mut out = out_buffer();
        compose_bgr(&[1, 2, 3], WIDTH, HEIGHT, &mut out, Compose::default());
        assert!(out.iter().all(|b| *b == 0), "nothing is drawn for a truncated picture");
    }

    /// The receiving chain without a phone: encode 720p H.264, cut it into RTP-sized payloads the way a
    /// sender does, put it back together the way `read_video` does, decode it and place it on the camera
    /// frame. Uses the H.264 component installed for the app; skipped when this PC does not have it.
    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn a_packetized_stream_decodes_and_lands_on_the_camera_frame() {
        use bytes::Bytes;
        use openh264::encoder::{Encoder, EncoderConfig, Profile};
        use openh264::formats::{RgbSliceU8, YUVBuffer};
        use rtc::rtp::codec::h264::H264Payloader;
        use rtc::rtp::packetizer::Payloader;

        let Some(config_dir) = std::env::var_os("APPDATA").map(|d| std::path::PathBuf::from(d).join("Link")) else { return };
        if !crate::core::openh264_lib::is_installed(&config_dir) {
            eprintln!("skipped: the H.264 component is not installed on this PC");
            return;
        }
        let encode_api = crate::core::openh264_lib::load_api(&config_dir).unwrap();
        let mut encoder = Encoder::with_api_config(encode_api, EncoderConfig::new().profile(Profile::Baseline)).unwrap();
        let mut decoder = Decoder::with_api_config(crate::core::openh264_lib::load_api(&config_dir).unwrap(), DecoderConfig::new()).unwrap();

        // A left half of one colour and a right half of another, so placement and channel order both show.
        let (w, h) = (WIDTH as usize, HEIGHT as usize);
        let mut source = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let px = if x < w / 2 { [200, 30, 30] } else { [30, 30, 200] };
                source[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&px);
            }
        }

        let mut payloader = H264Payloader::default();
        let mut depacketizer = H264Packet::default();
        let mut shown = None;
        for _ in 0..3 {
            let yuv = YUVBuffer::from_rgb_source(RgbSliceU8::new(&source, (w, h)));
            let sent = encoder.encode(&yuv).unwrap().to_vec();
            // 1200 bytes is a typical RTP payload size, so a keyframe is split into many packets.
            let packets = payloader.payload(1200, &Bytes::from(sent)).unwrap();
            assert!(!packets.is_empty());
            let mut unit = Vec::new();
            for packet in &packets {
                unit.extend_from_slice(&depacketizer.depacketize(packet).unwrap());
            }
            if shown.is_none() {
                assert!(has_keyframe(&unit), "the first picture is a keyframe");
            }
            if let Some(yuv) = decoder.decode(&unit).unwrap() {
                let (dw, dh) = yuv.dimensions();
                assert_eq!((dw, dh), (w, h));
                let mut rgb = vec![0u8; dw * dh * 3];
                yuv.write_rgb8(&mut rgb);
                let mut out = out_buffer();
                compose_bgr(&rgb, dw as u32, dh as u32, &mut out, Compose::default());
                shown = Some(out);
            }
        }
        let out = shown.expect("a picture came out of the decoder");
        let close = |got: [u8; 3], want: [u8; 3]| got.iter().zip(want).all(|(g, w)| (*g as i32 - w as i32).abs() <= 12);
        // Stored as BGR: the left half is red (200,30,30), so bytes are [30,30,200].
        assert!(close(at(&out, 100, 100), [30, 30, 200]), "left half: {:?}", at(&out, 100, 100));
        assert!(close(at(&out, WIDTH - 100, 100), [200, 30, 30]), "right half: {:?}", at(&out, WIDTH - 100, 100));
    }

    fn pushed(reorder: &mut Reorder<u16>, seq: u16, now: Instant) -> Vec<(u16, bool)> {
        let mut ready = Vec::new();
        reorder.push(seq, seq, now, &mut ready);
        ready
    }

    #[test]
    fn a_late_packet_inside_the_window_fills_its_gap() {
        let now = Instant::now();
        let mut reorder = Reorder::new();
        assert_eq!(pushed(&mut reorder, 10, now), vec![(10, false)]);
        // 11 is missing: 12 and 13 wait for it.
        assert!(pushed(&mut reorder, 12, now).is_empty());
        assert!(pushed(&mut reorder, 13, now).is_empty());
        assert!(reorder.deadline().is_some());
        // The resent 11 arrives within the hold time; everything comes out in order, nothing lost.
        assert_eq!(pushed(&mut reorder, 11, now + Duration::from_millis(15)), vec![(11, false), (12, false), (13, false)]);
        assert!(reorder.deadline().is_none());
        // A duplicate of something already played is ignored.
        assert!(pushed(&mut reorder, 12, now).is_empty());
    }

    #[test]
    fn a_gap_is_given_up_after_the_hold_time() {
        let now = Instant::now();
        let mut reorder = Reorder::new();
        pushed(&mut reorder, 1, now);
        assert!(pushed(&mut reorder, 3, now).is_empty());
        let mut ready = Vec::new();
        reorder.expire(now + REORDER_HOLD / 2, &mut ready);
        assert!(ready.is_empty(), "still waiting for 2");
        reorder.expire(now + REORDER_HOLD, &mut ready);
        assert_eq!(ready, vec![(3, true)], "3 is released, marked as following a loss");
        // 2 turning up afterwards is too late.
        assert!(pushed(&mut reorder, 2, now).is_empty());
    }

    #[test]
    fn sequence_numbers_wrap_around() {
        let now = Instant::now();
        let mut reorder = Reorder::new();
        pushed(&mut reorder, 65534, now);
        assert_eq!(pushed(&mut reorder, 65535, now), vec![(65535, false)]);
        assert_eq!(pushed(&mut reorder, 0, now), vec![(0, false)]);
        assert_eq!(pushed(&mut reorder, 1, now), vec![(1, false)]);
    }

    #[test]
    fn a_restarted_sequence_is_followed_rather_than_dropped() {
        let now = Instant::now();
        let mut reorder = Reorder::new();
        pushed(&mut reorder, 30000, now);
        assert_eq!(pushed(&mut reorder, 5, now), vec![(5, true)]);
        assert_eq!(pushed(&mut reorder, 6, now), vec![(6, false)]);
    }

    #[test]
    fn keyframes_are_recognised_by_their_parameter_sets_or_idr_slice() {
        // SPS (type 7), then an IDR slice (type 5).
        assert!(has_keyframe(&[0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x65, 9, 9]));
        assert!(has_keyframe(&[0, 0, 0, 1, 0x65, 9, 9, 9, 9]));
        // A plain P slice (type 1).
        assert!(!has_keyframe(&[0, 0, 0, 1, 0x41, 9, 9, 9, 9]));
        assert!(!has_keyframe(&[]));
    }
}
