// Screen sharing for Remote Control over WebRTC: the screen is captured, encoded as H.264 and sent
// to the viewer as a real-time video track. The offer/answer and ICE candidates travel as
// `link.remotecontrol.signal` bodies (`webrtc_offer`, `webrtc_answer`, `webrtc_candidate`), as
// expected by the viewer in RemoteControlViewer.tsx: inside the TLS control channel for a paired
// device, or over the guest socket for an unpaired guest (see Viewer and core/input_guest.rs).
// Keyframe requests and loss reports come back as RTCP on the video track itself.
//
// One session is one task. It owns the peer connection and the encoder, so aborting the task (see
// DeviceManager::stop_screen_share) tears the whole session down. Sessions showing the same monitor
// share one capture of it (screen_capture::Subscription).

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use image::imageops::FilterType;
use crate::core::h264_encoder::H264Encoder;
use rtc::interceptor::{Attribute, AttributedPacket, Interceptor, Packet, Slot, StreamInfo, TaggedPacket};
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_H264, MIME_TYPE_OPUS};
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use rtc::rtcp::receiver_report::ReceiverReport;
use rtc::rtp_transceiver::rtp_sender::{RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::media_stream::Track;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceCandidateInit, RTCIceGatheringState, RTCPeerConnectionState, RTCSessionDescription, Registry,
};

use crate::core::packet::LinkPacket;
use crate::core::transport::DeviceManager;

/// Biggest frame that is encoded when the viewer does not say how large its screen is, by its long
/// and short edges, so a portrait screen gets the same detail as a landscape one.
const MAX_LONG_EDGE: u32 = 1920;
const MAX_SHORT_EDGE: u32 = 1080;
/// What a viewer's own screen size is held to: never smaller than HD, so text stays sharp when the
/// viewer is a small window, and never larger than this, which the encoder can keep up with.
const MIN_VIEWPORT: (u32, u32) = (1280, 720);
const MAX_VIEWPORT: (u32, u32) = (2560, 1440);
/// The most frames a second that are sent. A frame is only made when the screen changed.
const FRAME_RATE: f32 = 60.0;
/// The most a full HD picture may cost, in bits a second. A ceiling, not a target: the encoder
/// spends only what a picture needs, and a still screen costs next to nothing. Screen content at
/// 1080p stays sharp within about 8 Mbps; more only fills the Wi-Fi and the phone's buffers when a
/// whole page scrolls. Bigger pictures get proportionally more, up to `MAX_BITRATE_BPS`.
const BITRATE_BPS_1080P: u32 = 8_000_000;
const MAX_BITRATE_BPS: u32 = 12_000_000;
/// The least the bitrate is cut to when the viewer reports loss: below this text turns to mush.
const MIN_BITRATE_BPS: u32 = 1_000_000;
/// How long the capture waits for the screen to change before it checks on the session.
const CAPTURE_WAIT: Duration = Duration::from_millis(50);
/// A still screen is sent again this often, so a viewer that lost a packet or just arrived catches
/// up. Once the viewer is known to send feedback (it asks for lost packets and for a keyframe when
/// it cannot decode), that is how it catches up, and the still screen is only sent now and then so
/// the viewer can tell the stream is alive.
const IDLE_REFRESH: Duration = Duration::from_millis(500);
const IDLE_REFRESH_WITH_FEEDBACK: Duration = Duration::from_secs(5);
/// A full picture (keyframe) this often lets a viewer that joins late, or loses packets, recover:
/// often at the start, when the viewer is still connecting, and less often afterwards. A viewer
/// that sends feedback asks for one itself when it needs it (PLI/FIR), so for it timed keyframes
/// are only a rare safety net.
const KEYFRAME_INTERVAL_AT_START: Duration = Duration::from_secs(1);
const KEYFRAME_INTERVAL: Duration = Duration::from_secs(3);
const KEYFRAME_INTERVAL_WITH_FEEDBACK: Duration = Duration::from_secs(30);
const START_PHASE: Duration = Duration::from_secs(10);
/// Keyframe requests closer together than this are answered once: a keyframe takes a moment to
/// arrive, and the viewer keeps asking until it has.
const KEYFRAME_REQUEST_GAP: Duration = Duration::from_millis(250);
/// How long to wait for ICE gathering before sending the offer with whatever was found.
const GATHER_TIMEOUT: Duration = Duration::from_secs(3);
const H264_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
const H264_PAYLOAD_TYPE: u8 = 102;
const OPUS_PAYLOAD_TYPE: u8 = 111;
/// Opus frame length. 20 ms is the usual balance between delay and packet overhead.
const AUDIO_FRAME_MS: usize = 20;

/// Which screen a session streams: the main one (remote control), or a second monitor that the
/// phone shows as an extended screen. The second monitor can be a real one or a virtual display.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Display {
    #[default]
    Primary,
    Extended,
}

impl Display {
    /// The screen a viewer's `request` signal asks for; `"display": "extended"` means the second screen.
    pub fn from_request(body: &Value) -> Self {
        if body.get("display").and_then(|v| v.as_str()) == Some("extended") {
            Display::Extended
        } else {
            Display::Primary
        }
    }
}

/// Where a monitor sits on the Windows desktop, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// An extra monitor (not the main one) that phones can extend onto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtraScreen {
    /// Stays the same for as long as the monitor is connected, so a phone keeps its own screen
    /// when others come and go.
    pub id: u32,
    /// One of the virtual monitors Link switches on, as opposed to a physical one. The virtual
    /// display driver names its monitors "... (VDD by MTT)".
    pub is_virtual: bool,
}

/// The monitors besides the main one that are on the desktop right now.
pub fn extra_screens() -> Vec<ExtraScreen> {
    xcap::Monitor::all()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| !m.is_primary().unwrap_or(true))
        .filter_map(|m| {
            let name = m.name().unwrap_or_default().to_ascii_lowercase();
            Some(ExtraScreen { id: m.id().ok()?, is_virtual: name.contains("vdd") || name.contains("mtt") })
        })
        .collect()
}

/// Windows hands out new monitor ids when the display set changes, which happens whenever another
/// phone's virtual monitor comes or goes. A phone holding a virtual monitor whose id has vanished
/// is moved onto a virtual monitor nobody else holds, so its stream carries on instead of freezing.
/// `phones` is each phone's current id and whether it holds a virtual monitor; ids are updated in place.
pub fn rebind_virtual_screens(phones: &mut [(u32, bool)], screens: &[ExtraScreen]) {
    let present = |id: u32| screens.iter().any(|s| s.id == id);
    let mut taken: Vec<u32> = phones.iter().map(|(id, _)| *id).filter(|id| *id != 0 && present(*id)).collect();
    for (id, virtual_lease) in phones.iter_mut() {
        if *id == 0 || present(*id) || !*virtual_lease {
            continue;
        }
        if let Some(free) = screens.iter().find(|s| s.is_virtual && !taken.contains(&s.id)) {
            *id = free.id;
            taken.push(free.id);
        }
    }
}

/// `screen` is the id of the extra monitor an extended session shows, so each phone has its own.
pub(crate) fn pick_monitor(display: Display, screen: u32) -> Option<xcap::Monitor> {
    let monitors = xcap::Monitor::all().ok()?;
    match display {
        Display::Primary => {
            let primary = monitors.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0);
            monitors.into_iter().nth(primary)
        }
        Display::Extended => monitors.into_iter().find(|m| m.id().is_ok_and(|id| id == screen) && !m.is_primary().unwrap_or(true)),
    }
}

/// How much a captured screen is shrunk before encoding (1.0 when it already fits).
#[cfg(test)]
pub fn fit_scale(width: u32, height: u32) -> f64 {
    fit_scale_within(width, height, (MAX_LONG_EDGE, MAX_SHORT_EDGE))
}

/// How much a screen is shrunk to fit `limit` (its long and short edges); 1.0 when it already fits.
pub fn fit_scale_within(width: u32, height: u32, limit: (u32, u32)) -> f64 {
    let (long, short) = (width.max(height).max(1) as f64, width.min(height).max(1) as f64);
    (limit.0 as f64 / long).min(limit.1 as f64 / short).min(1.0)
}

/// The size of the viewer's own screen in pixels, from its `request` signal, as (long edge, short
/// edge). Streaming more than the viewer can show only costs time, and streaming less looks soft.
pub fn viewport_from_request(body: &Value) -> Option<(u32, u32)> {
    let viewport = body.get("viewport")?;
    let (w, h) = (viewport.get("width")?.as_u64()?, viewport.get("height")?.as_u64()?);
    if w == 0 || h == 0 || w > 20_000 || h > 20_000 {
        return None;
    }
    let (long, short) = (w.max(h) as u32, w.min(h) as u32);
    Some((long.clamp(MIN_VIEWPORT.0, MAX_VIEWPORT.0), short.clamp(MIN_VIEWPORT.1, MAX_VIEWPORT.1)))
}

/// The position and size of the extra screen with this id, or None when it is no longer connected.
pub fn second_screen(screen: u32) -> Option<Rect> {
    let m = pick_monitor(Display::Extended, screen)?;
    Some(Rect { x: m.x().ok()?, y: m.y().ok()?, width: m.width().ok()?, height: m.height().ok()? })
}

/// Who a session streams to, and where its signalling goes.
pub enum Viewer {
    /// A paired device, by id: signalling rides its control channel as `link.remotecontrol.signal`
    /// packets.
    Paired(String),
    /// An admitted guest: signalling bodies go to its socket, which wraps them as packets.
    Guest { name: String, signals: mpsc::UnboundedSender<Value> },
}

impl Viewer {
    fn label(&self) -> &str {
        match self {
            Viewer::Paired(id) => id,
            Viewer::Guest { name, .. } => name,
        }
    }

    async fn signal(&self, manager: &DeviceManager, body: Value) -> Result<(), String> {
        match self {
            Viewer::Paired(id) => manager.send_link_packet(id, LinkPacket::new("link.remotecontrol.signal", body)).await,
            Viewer::Guest { signals, .. } => signals.send(body).map_err(|_| "the guest left".to_string()),
        }
    }
}

/// Signalling coming back from the viewer.
pub enum Signal {
    Answer(String),
    Candidate(RTCIceCandidateInit),
}

/// Parses a `link.remotecontrol.signal` body from the viewer. None for any other signal type.
pub fn parse_signal(body: &Value) -> Option<Signal> {
    match body.get("type")?.as_str()? {
        "webrtc_answer" => Some(Signal::Answer(body.get("sdp")?.as_str()?.to_string())),
        "webrtc_candidate" => {
            let c = body.get("candidate")?;
            Some(Signal::Candidate(RTCIceCandidateInit {
                candidate: c.get("candidate")?.as_str()?.to_string(),
                sdp_mid: c.get("sdpMid").and_then(|v| v.as_str()).map(str::to_string),
                sdp_mline_index: c.get("sdpMLineIndex").and_then(|v| v.as_u64()).map(|v| v as u16),
                ..Default::default()
            }))
        }
        _ => None,
    }
}

#[derive(Clone)]
struct Handler {
    gathered: mpsc::UnboundedSender<()>,
    ended: mpsc::UnboundedSender<()>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.send(());
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        log::info!("[RemoteControl] WebRTC connection state: {}", state);
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
            let _ = self.ended.send(());
        }
    }
}

/// Runs one screen-sharing session to `target` until the peer goes away, the connection fails, or
/// the task is aborted.
/// `screen` is shared with the host, which fills it in once this phone has a monitor of its own.
/// `viewport` is the viewer's screen size (long edge, short edge), when it said.
pub async fn run(manager: Arc<DeviceManager>, viewer: Viewer, display: Display, screen: Arc<AtomicU32>, viewport: Option<(u32, u32)>, mut signals: mpsc::UnboundedReceiver<Signal>) {
    if let Err(e) = run_inner(&manager, &viewer, display, &screen, viewport, &mut signals).await {
        log::warn!("[RemoteControl] screen share to {} ended: {}", viewer.label(), e);
    }
}

async fn run_inner(manager: &Arc<DeviceManager>, viewer: &Viewer, display: Display, screen: &Arc<AtomicU32>, viewport: Option<(u32, u32)>, signals: &mut mpsc::UnboundedReceiver<Signal>) -> Result<(), String> {
    let video_codec = RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: H264_FMTP.to_owned(),
            // Besides these, the default interceptors below add "nack" (lost packets are sent
            // again) and "nack pli" (the viewer asks for a keyframe when it cannot decode). FIR is
            // the older form of that request, and REMB is the viewer's estimate of how much it can
            // receive, which the bitrate follows (see Feedback).
            rtcp_feedback: vec![
                RTCPFeedback { typ: "ccm".to_owned(), parameter: "fir".to_owned() },
                RTCPFeedback { typ: "goog-remb".to_owned(), parameter: String::new() },
            ],
        },
        payload_type: H264_PAYLOAD_TYPE,
        ..Default::default()
    };

    let mut media_engine = MediaEngine::default();
    media_engine.register_codec(video_codec.clone(), RtpCodecKind::Video).map_err(|e| e.to_string())?;
    let opus_codec = RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: 48000,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
            rtcp_feedback: vec![],
        },
        payload_type: OPUS_PAYLOAD_TYPE,
        ..Default::default()
    };
    media_engine.register_codec(opus_codec.clone(), RtpCodecKind::Audio).map_err(|e| e.to_string())?;
    let registry = register_default_interceptors(Registry::new(), &mut media_engine).map_err(|e| e.to_string())?;
    // Last in the chain, after the interceptors that act on RTCP themselves (the NACK responder
    // resends lost packets), so the feedback only this session can act on reaches it.
    let registry = registry.with(Slot::from(14_000), FeedbackForwarder::default());

    let (gathered_tx, mut gathered_rx) = mpsc::unbounded_channel();
    let (ended_tx, mut ended_rx) = mpsc::unbounded_channel();

    // No STUN server: both ends are on the same network, and a public one would only leak that
    // this device is about to start a session.
    let peer: Arc<dyn PeerConnection> = Arc::new(
        PeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_handler(Arc::new(Handler { gathered: gathered_tx, ended: ended_tx }))
            .with_runtime(webrtc::runtime::default_runtime().ok_or("no async runtime for WebRTC")?)
            .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
            .build()
            .await
            .map_err(|e| e.to_string())?,
    );

    let ssrc = rand_ssrc();
    let track = Arc::new(
        TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "link-screen-stream".to_string(),
                "link-screen-track".to_string(),
                "link-screen".to_string(),
                RtpCodecKind::Video,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(ssrc), ..Default::default() },
                    codec: video_codec.rtp_codec.clone(),
                    ..Default::default()
                }],
            ),
        )
        .map_err(|e| e.to_string())?,
    );
    let sender = peer.add_track(track.clone() as Arc<dyn TrackLocal>).await.map_err(|e| e.to_string())?;

    // The PC's sound goes with the picture for both remote control and the second screen, so a video or a
    // call on either can be heard on the phone. If capture cannot start, the picture still works.
    let mut audio = None;
    {
        match crate::core::plugins::loopback::start(None).await {
            Ok((capture, format, chunks)) => {
                let audio_ssrc = rand_ssrc();
                let audio_track = TrackLocalStaticSample::new(
                    Instant::now(),
                    MediaStreamTrack::new(
                        // The same stream as the video, so the viewer plays them together.
                        "link-screen-stream".to_string(),
                        "link-audio-track".to_string(),
                        "link-audio".to_string(),
                        RtpCodecKind::Audio,
                        vec![RTCRtpEncodingParameters {
                            rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(audio_ssrc), ..Default::default() },
                            codec: opus_codec.rtp_codec.clone(),
                            ..Default::default()
                        }],
                    ),
                );
                match audio_track {
                    Ok(audio_track) => {
                        let audio_track = Arc::new(audio_track);
                        match peer.add_track(audio_track.clone() as Arc<dyn TrackLocal>).await {
                            Ok(audio_sender) => audio = Some((capture, format, chunks, audio_track, audio_sender)),
                            Err(e) => log::warn!("[RemoteControl] audio track not added: {e}"),
                        }
                    }
                    Err(e) => log::warn!("[RemoteControl] audio track not created: {e}"),
                }
            }
            Err(e) => log::info!("[RemoteControl] no audio for this session: {e}"),
        }
    }

    // Offer with every candidate already inside it (no trickle), so the viewer never receives a
    // candidate before it has a remote description to attach it to.
    let offer = peer.create_offer(None).await.map_err(|e| e.to_string())?;
    peer.set_local_description(offer).await.map_err(|e| e.to_string())?;
    let _ = tokio::time::timeout(GATHER_TIMEOUT, gathered_rx.recv()).await;
    let sdp = peer.local_description().await.ok_or("no local description")?.sdp;
    viewer.signal(manager, json!({ "type": "webrtc_offer", "sdp": sdp })).await?;

    // Wait for the viewer's answer, then start sending. Candidates that arrive first are held back
    // until the remote description is set.
    let mut early_candidates = Vec::new();
    loop {
        match signals.recv().await.ok_or("signalling closed before an answer arrived")? {
            Signal::Answer(sdp) => {
                let answer = RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?;
                peer.set_remote_description(answer).await.map_err(|e| e.to_string())?;
                break;
            }
            Signal::Candidate(c) => early_candidates.push(c),
        }
    }
    for c in early_candidates {
        let _ = peer.add_ice_candidate(c).await;
    }

    let payload_type = sender
        .get_parameters()
        .await
        .map_err(|e| e.to_string())?
        .rtp_parameters
        .codecs
        .first()
        .map(|c| c.payload_type)
        .ok_or("the viewer did not accept H.264 video")?;
    let ssrc = *track.ssrcs().await.first().ok_or("the video track has no SSRC")?;

    // The viewer's feedback: keyframe requests, loss reports and bandwidth estimates. It can arrive
    // on either track (a report covering both is filed under whichever it names first), so both are
    // read, and only what concerns the video is acted on.
    let feedback = Arc::new(Feedback::default());
    let (rtcp_tx, rtcp_rx) = mpsc::unbounded_channel();
    let mut _feedback_tasks = vec![
        AbortOnDrop(tokio::spawn(poll_feedback(track.clone() as Arc<dyn TrackLocal>, rtcp_tx.clone()))),
        AbortOnDrop(tokio::spawn(read_feedback(rtcp_rx, ssrc, feedback.clone()))),
    ];

    let _audio_task = match audio {
        Some((capture, format, chunks, audio_track, audio_sender)) => {
            _feedback_tasks.push(AbortOnDrop(tokio::spawn(poll_feedback(audio_track.clone() as Arc<dyn TrackLocal>, rtcp_tx))));
            let audio_payload = audio_sender.get_parameters().await.ok().and_then(|p| p.rtp_parameters.codecs.first().map(|c| c.payload_type));
            let audio_ssrc = audio_track.ssrcs().await.first().copied();
            match (audio_payload, audio_ssrc) {
                (Some(payload), Some(ssrc)) => Some(AbortOnDrop(tokio::spawn(send_audio(capture, format, chunks, audio_track, ssrc, payload)))),
                _ => {
                    log::info!("[RemoteControl] the viewer did not accept audio");
                    None
                }
            }
        }
        None => None,
    };

    // The GPU's encoder, or OpenH264 on a PC without one. The highest bitrate any picture may get;
    // the real one is set once the picture's size is known, and follows the viewer's feedback (see
    // Feedback). Keyframes are asked for explicitly (see Pipeline::run).
    let encoder = H264Encoder::new(&manager.config_dir, MAX_BITRATE_BPS, FRAME_RATE)?;

    // Capturing and encoding wait for the screen on a thread of their own, so a frame is encoded the
    // moment the screen changes; the finished frames come back here to be sent.
    let (frames_tx, mut frames) = mpsc::channel::<EncodedFrame>(4);
    let on_screen_missing = {
        let (runtime, manager) = (tokio::runtime::Handle::current(), manager.clone());
        move || {
            let manager = manager.clone();
            runtime.spawn(async move { manager.reclaim_extended_screen().await });
        }
    };
    let pipeline = Pipeline {
        encoder,
        display,
        screen: screen.clone(),
        viewport,
        frames: frames_tx,
        on_screen_missing: Box::new(on_screen_missing),
        feedback,
        bitrate: None,
    };
    std::thread::Builder::new().name("screen-capture".into()).spawn(move || pipeline.run()).map_err(|e| e.to_string())?;

    loop {
        tokio::select! {
            frame = frames.recv() => {
                let Some(frame) = frame else { return Err("screen capture stopped".into()) };
                let sample = Sample { data: Bytes::from(frame.data), duration: frame.duration, ..Sample::new(Instant::now()) };
                if let Err(e) = track.sample_writer(ssrc, payload_type).write_sample(&sample).await {
                    return Err(e.to_string());
                }
            }
            signal = signals.recv() => match signal {
                Some(Signal::Candidate(c)) => { let _ = peer.add_ice_candidate(c).await; }
                Some(Signal::Answer(_)) => {}
                None => return Ok(()),
            },
            _ = ended_rx.recv() => return Ok(()),
        }
    }
}

/// One encoded picture, and how long after the previous one it was made (for the RTP timestamps).
struct EncodedFrame {
    data: Vec<u8>,
    duration: Duration,
}

/// Everything the capture thread owns.
struct Pipeline {
    encoder: H264Encoder,
    display: Display,
    screen: Arc<AtomicU32>,
    viewport: Option<(u32, u32)>,
    frames: mpsc::Sender<EncodedFrame>,
    /// Called when the monitor this session streams cannot be found (it was probably renumbered).
    on_screen_missing: Box<dyn Fn() + Send>,
    feedback: Arc<Feedback>,
    /// The bitrate the encoder was last given, and for which picture size (the encoder starts over
    /// with its configured bitrate whenever the size changes).
    bitrate: Option<(u32, (u32, u32))>,
}

impl Pipeline {
    /// Captures, encodes and queues pictures until the session ends (its receiving end is dropped).
    fn run(mut self) {
        use crate::core::screen_capture::Next;
        let mut capture = crate::core::screen_capture::Subscription::default();
        let mut yuv = crate::core::screen_capture::I420::default();
        let (started, mut last_sent, mut last_keyframe) = (Instant::now(), Instant::now(), Instant::now());
        let (mut missing, mut need_keyframe, mut counted, mut window_start) = (0u32, false, 0u32, Instant::now());
        let mut busy = Duration::ZERO;
        while !self.frames.is_closed() {
            let screen = self.screen.load(Ordering::Relaxed);
            let settled = started.elapsed() >= START_PHASE && self.feedback.seen.load(Ordering::Relaxed);
            let asked = self.feedback.keyframe_wanted.load(Ordering::Relaxed) && last_keyframe.elapsed() >= KEYFRAME_REQUEST_GAP;
            match capture.next(self.display, screen, CAPTURE_WAIT) {
                Next::Fresh => {}
                Next::Missing => {
                    // An extended screen that has gone missing was probably renumbered by Windows
                    // while another phone's monitor came or went; find this phone's monitor again.
                    missing += 1;
                    if self.display == Display::Extended && missing % 15 == 0 {
                        (self.on_screen_missing)();
                    }
                    continue;
                }
                Next::Idle => {
                    // Nothing changed. Now and then send the screen again anyway, and at once when
                    // the viewer asked for a keyframe.
                    let refresh = if settled { IDLE_REFRESH_WITH_FEEDBACK } else { IDLE_REFRESH };
                    if last_sent.elapsed() < refresh && !asked {
                        continue;
                    }
                }
            }
            missing = 0;
            let work = Instant::now();
            let interval = match (started.elapsed() < START_PHASE, settled) {
                (true, _) => KEYFRAME_INTERVAL_AT_START,
                (false, true) => KEYFRAME_INTERVAL_WITH_FEEDBACK,
                (false, false) => KEYFRAME_INTERVAL,
            };
            if asked {
                self.feedback.keyframe_wanted.store(false, Ordering::Relaxed);
                need_keyframe = true;
            }
            if need_keyframe || last_keyframe.elapsed() >= interval {
                self.encoder.force_keyframe();
                last_keyframe = Instant::now();
                need_keyframe = false;
            }
            let data = match capture.with_frame(|frame| self.encode(frame, &mut yuv)) {
                Some(Ok(Some(data))) => data,
                // No encoder left (the hardware one failed and OpenH264 is not installed): the
                // session ends, and the viewer's next request asks for the download.
                Some(Err(e)) => {
                    log::warn!("[RemoteControl] screen sharing stopped: {e}");
                    return;
                }
                _ => continue,
            };
            busy += work.elapsed();
            counted += 1;
            if window_start.elapsed() >= Duration::from_secs(5) {
                log::info!(
                    "[RemoteControl] {} frames in {:.1}s, {:?} to convert and encode each ({}), {} kbit/s allowed",
                    counted,
                    window_start.elapsed().as_secs_f32(),
                    busy / counted.max(1),
                    self.encoder.name(),
                    self.bitrate.map_or(0, |(bps, _)| bps / 1000)
                );
                (counted, busy, window_start) = (0, Duration::ZERO, Instant::now());
            }
            let duration = last_sent.elapsed().clamp(Duration::from_millis(1), Duration::from_secs(1));
            last_sent = Instant::now();
            // A queue that is full means the network is behind. Dropping a picture breaks the ones
            // that follow it, so the next one is a keyframe, and the viewer is never made to wait.
            if let Err(mpsc::error::TrySendError::Full(_)) = self.frames.try_send(EncodedFrame { data, duration }) {
                need_keyframe = true;
            }
        }
    }

    /// Scales the picture to what the viewer can show and encodes it as H.264 (Annex B). None when
    /// it produced nothing to send; an error when there is no encoder left.
    fn encode(&mut self, frame: crate::core::screen_capture::Frame<'_>, yuv: &mut crate::core::screen_capture::I420) -> Result<Option<Vec<u8>>, String> {
        let limit = self.viewport.unwrap_or((MAX_LONG_EDGE, MAX_SHORT_EDGE));
        let scale = fit_scale_within(frame.width, frame.height, limit);
        // H.264 4:2:0 needs even dimensions.
        let width = ((frame.width as f64 * scale).round() as u32).max(2) & !1;
        let height = ((frame.height as f64 * scale).round() as u32).max(2) & !1;
        if scale >= 1.0 {
            // Already small enough: converted straight from the captured picture, dropping a last
            // odd row or column, and only the rows that changed.
            let rows = frame.changed.start as usize..frame.changed.end as usize;
            yuv.fill(frame.bgra, frame.width as usize * 4, width as usize, height as usize, Some(rows));
        } else {
            // Resizing treats the four channels alike, so BGRA comes out as BGRA.
            let Some(source) = image::ImageBuffer::<image::Rgba<u8>, &[u8]>::from_raw(frame.width, frame.height, frame.bgra) else { return Ok(None) };
            let resized = image::imageops::resize(&source, width, height, FilterType::Triangle);
            yuv.fill(resized.as_raw(), width as usize * 4, width as usize, height as usize, None);
        }
        let bytes = self.encoder.encode(&*yuv)?;
        self.follow_bitrate((width, height));
        Ok((!bytes.is_empty()).then_some(bytes))
    }

    /// Gives the encoder the bitrate this picture size and the viewer's feedback allow, when that
    /// changed.
    fn follow_bitrate(&mut self, size: (u32, u32)) {
        let wanted = self.feedback.bitrate(size);
        if self.bitrate.is_some_and(|(bps, at)| at == size && bps.abs_diff(wanted) < wanted / 50) {
            return;
        }
        self.encoder.set_bitrate(wanted);
        self.bitrate = Some((wanted, size));
    }
}

/// What the viewer's RTCP feedback says, shared between the task that reads it and the thread that
/// encodes.
struct Feedback {
    /// Any feedback at all has arrived, so the viewer is known to ask for what it misses.
    seen: AtomicBool,
    /// The viewer asked for a keyframe (PLI or FIR).
    keyframe_wanted: AtomicBool,
    /// The share of the picture's bitrate ceiling to use, in thousandths. Cut when the viewer
    /// reports loss, raised again slowly while it reports none.
    share: AtomicU32,
    /// The viewer's own estimate of what it can receive (REMB), in bits a second; 0 until it sends one.
    estimate: AtomicU32,
}

impl Default for Feedback {
    fn default() -> Self {
        Self { seen: AtomicBool::new(false), keyframe_wanted: AtomicBool::new(false), share: AtomicU32::new(1000), estimate: AtomicU32::new(0) }
    }
}

impl Feedback {
    /// The most a picture of this size may cost: about 8 Mbps at 1080p, more for bigger pictures.
    fn ceiling(size: (u32, u32)) -> u32 {
        let pixels = size.0 as u64 * size.1 as u64;
        ((BITRATE_BPS_1080P as u64 * pixels / (1920 * 1080)) as u32).clamp(BITRATE_BPS_1080P * 3 / 4, MAX_BITRATE_BPS)
    }

    /// The bitrate to encode a picture of this size at now.
    fn bitrate(&self, size: (u32, u32)) -> u32 {
        let mut bps = (Self::ceiling(size) as u64 * self.share.load(Ordering::Relaxed) as u64 / 1000) as u32;
        let estimate = self.estimate.load(Ordering::Relaxed);
        if estimate > 0 {
            // A little under the estimate, so the stream does not sit right at the edge of what fits.
            bps = bps.min(estimate / 10 * 9);
        }
        bps.max(MIN_BITRATE_BPS)
    }

    /// Takes in one receiver report's fraction of lost packets (out of 256) for the video.
    fn on_loss(&self, fraction_lost: u8) {
        let share = self.share.load(Ordering::Relaxed);
        let next = match fraction_lost {
            // Over 10% lost: the link is overloaded, back off a quarter.
            26.. => share * 3 / 4,
            // 2% to 10%: ease off a little.
            6..=25 => share * 95 / 100,
            // Clean: creep back up, about 8% a report (reports come roughly once a second).
            _ => (share * 108 / 100).max(share + 1),
        };
        self.share.store(next.clamp(100, 1000), Ordering::Relaxed);
    }
}

/// Lets the viewer's keyframe requests, receiver reports and bandwidth estimates through to the
/// session (see `TrackLocalEvent`), one packet at a time so each reaches the track it is about.
/// Everything else stops here, after the interceptors that act on it have seen it.
#[derive(Default)]
struct FeedbackForwarder {
    reads: VecDeque<TaggedPacket>,
    writes: VecDeque<TaggedPacket>,
}

impl rtc::sansio::Protocol<TaggedPacket, TaggedPacket, ()> for FeedbackForwarder {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = Instant;

    fn handle_read(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        let Packet::Rtcp(packets) = &msg.message.packet else {
            self.reads.push_back(msg);
            return Ok(());
        };
        for packet in packets {
            let any = packet.as_any();
            if any.is::<PictureLossIndication>() || any.is::<FullIntraRequest>() || any.is::<ReceiverReport>() || any.is::<ReceiverEstimatedMaximumBitrate>() {
                // A compound packet is filed under the first SSRC it names, which may be the audio's;
                // split up, a keyframe request always reaches the video track.
                let message = AttributedPacket::new(Packet::Rtcp(vec![packet.clone()])).with(Attribute::DeliverToApplication);
                self.reads.push_back(TaggedPacket { now: msg.now, transport: msg.transport, message });
            }
        }
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.reads.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.writes.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.writes.pop_front()
    }
}

impl Interceptor for FeedbackForwarder {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}

type RtcpPackets = Vec<Box<dyn rtc::rtcp::Packet>>;

/// Passes on the RTCP the viewer sends about one of this session's tracks.
async fn poll_feedback(track: Arc<dyn TrackLocal>, out: mpsc::UnboundedSender<RtcpPackets>) {
    loop {
        match track.poll().await {
            Some(TrackLocalEvent::OnRtcpPacket(packets)) => {
                if out.send(packets).is_err() {
                    return;
                }
            }
            #[allow(unreachable_patterns)]
            Some(_) => {}
            // Not bound to the connection yet (or no longer): look again shortly. The task ends
            // with the session.
            None => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

/// Acts on the viewer's feedback about the video track, whose SSRC is `video`.
async fn read_feedback(mut packets: mpsc::UnboundedReceiver<RtcpPackets>, video: u32, feedback: Arc<Feedback>) {
    while let Some(batch) = packets.recv().await {
        for packet in batch {
            let any = packet.as_any();
            if let Some(pli) = any.downcast_ref::<PictureLossIndication>() {
                if pli.media_ssrc == video {
                    feedback.keyframe_wanted.store(true, Ordering::Relaxed);
                }
            } else if let Some(fir) = any.downcast_ref::<FullIntraRequest>() {
                if fir.media_ssrc == video || fir.fir.iter().any(|entry| entry.ssrc == video) {
                    feedback.keyframe_wanted.store(true, Ordering::Relaxed);
                }
            } else if let Some(report) = any.downcast_ref::<ReceiverReport>() {
                for block in report.reports.iter().filter(|block| block.ssrc == video) {
                    feedback.on_loss(block.fraction_lost);
                }
            } else if let Some(remb) = any.downcast_ref::<ReceiverEstimatedMaximumBitrate>() {
                if remb.ssrcs.is_empty() || remb.ssrcs.contains(&video) {
                    feedback.estimate.store(remb.bitrate.clamp(0.0, u32::MAX as f32) as u32, Ordering::Relaxed);
                }
            } else {
                continue;
            }
            feedback.seen.store(true, Ordering::Relaxed);
        }
    }
}

/// Stops the task it holds when dropped, so the audio ends with the session.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Encodes what the PC is playing as Opus and sends it on the session's audio track. The capture
/// stops when this task is dropped.
async fn send_audio(
    capture: crate::core::plugins::loopback::Capture,
    format: crate::core::plugins::loopback::Format,
    mut chunks: crate::core::plugins::loopback::Chunks,
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
) {
    use audiopus::coder::Encoder as OpusEncoder;
    use audiopus::{Application, Bitrate, Channels, SampleRate};

    let _capture = capture;
    let channels = match format.channels {
        1 => Channels::Mono,
        2 => Channels::Stereo,
        _ => return,
    };
    let float = format.is_float && format.bits_per_sample == 32;
    let int16 = !format.is_float && format.bits_per_sample == 16;
    if !(float || int16) || format.sample_rate != 48_000 {
        log::info!("[RemoteControl] audio format {:?} cannot be sent", format);
        return;
    }
    // Low delay rather than the general audio mode: it skips the speech coder's lookahead, which
    // only pays off at low bitrates, so the sound keeps up with the picture.
    let Ok(mut encoder) = OpusEncoder::new(SampleRate::Hz48000, channels, Application::LowDelay) else { return };
    let _ = encoder.set_bitrate(Bitrate::BitsPerSecond(96_000));
    let frame_samples = 48 * AUDIO_FRAME_MS * format.channels as usize;
    let mut pending: Vec<i16> = Vec::new();
    let mut packet = [0u8; 1500];
    while let Some(chunk) = chunks.recv().await {
        // Converted straight into the pending queue, without an intermediate byte buffer.
        if float {
            pending.extend(chunk.chunks_exact(4).map(|b| crate::core::audio_sink::float_sample_to_int16(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))));
        } else {
            pending.extend(chunk.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])));
        }
        // Whole frames are encoded straight from the queue and dropped from it once, together.
        let mut used = 0;
        while pending.len() - used >= frame_samples {
            let frame = &pending[used..used + frame_samples];
            used += frame_samples;
            let Ok(length) = encoder.encode(frame, &mut packet) else { continue };
            let sample = Sample {
                data: Bytes::copy_from_slice(&packet[..length]),
                duration: Duration::from_millis(AUDIO_FRAME_MS as u64),
                ..Sample::new(Instant::now())
            };
            if track.sample_writer(ssrc, payload_type).write_sample(&sample).await.is_err() {
                return;
            }
        }
        pending.drain(..used);
    }
}

fn rand_ssrc() -> u32 {
    let mut bytes = [0u8; 4];
    bytes.copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..4]);
    u32::from_be_bytes(bytes)
}

#[cfg(test)]
mod screen_tests {
    use super::{ExtraScreen, rebind_virtual_screens};

    fn virtual_screen(id: u32) -> ExtraScreen {
        ExtraScreen { id, is_virtual: true }
    }

    #[test]
    fn a_phone_whose_monitor_was_renumbered_gets_a_free_one_and_others_keep_theirs() {
        // Phone A still has monitor 20; phone B's monitor 11 became 30 and a third, 40, is unused.
        let mut phones = [(20, true), (11, true)];
        rebind_virtual_screens(&mut phones, &[virtual_screen(20), virtual_screen(30)]);
        assert_eq!(phones, [(20, true), (30, true)]);
    }

    #[test]
    fn two_stale_phones_never_end_up_on_the_same_monitor() {
        let mut phones = [(1, true), (2, true)];
        rebind_virtual_screens(&mut phones, &[virtual_screen(7), virtual_screen(8)]);
        assert_ne!(phones[0].0, phones[1].0);
        assert!(phones.iter().all(|(id, _)| *id == 7 || *id == 8));
    }

    #[test]
    fn real_monitors_and_phones_without_a_screen_are_left_alone() {
        let mut phones = [(5, false), (0, true)];
        rebind_virtual_screens(&mut phones, &[virtual_screen(9)]);
        assert_eq!(phones, [(5, false), (0, true)]);
    }
}

#[cfg(test)]
mod pipeline_tests {
    use super::*;

    #[test]
    fn the_viewer_screen_size_is_read_and_kept_within_sane_limits() {
        let size = |w: u64, h: u64| viewport_from_request(&json!({ "viewport": { "width": w, "height": h } }));
        assert_eq!(size(2340, 1080), Some((2340, 1080)));
        assert_eq!(size(1080, 2340), Some((2340, 1080)), "portrait and landscape are the same budget");
        assert_eq!(size(800, 480), Some(MIN_VIEWPORT), "tiny windows still get HD");
        assert_eq!(size(7680, 4320), Some(MAX_VIEWPORT), "huge ones are held to what the encoder keeps up with");
        assert_eq!(size(0, 100), None);
        assert_eq!(viewport_from_request(&json!({})), None);
    }

    #[test]
    fn loss_cuts_the_bitrate_and_a_clean_link_brings_it_back() {
        let feedback = Feedback::default();
        let full_hd = (1920, 1080);
        assert_eq!(feedback.bitrate(full_hd), BITRATE_BPS_1080P);
        feedback.on_loss(64); // 25% lost
        assert!(feedback.bitrate(full_hd) < BITRATE_BPS_1080P * 4 / 5);
        for _ in 0..20 {
            feedback.on_loss(0);
        }
        assert_eq!(feedback.bitrate(full_hd), BITRATE_BPS_1080P);
        for _ in 0..50 {
            feedback.on_loss(255);
        }
        assert_eq!(feedback.bitrate(full_hd), MIN_BITRATE_BPS, "never below the floor");
        feedback.estimate.store(2_000_000, Ordering::Relaxed);
        for _ in 0..50 {
            feedback.on_loss(0);
        }
        assert_eq!(feedback.bitrate(full_hd), 1_800_000, "the viewer's estimate is a ceiling");
    }

    #[test]
    fn bigger_pictures_may_cost_more_up_to_a_limit() {
        assert_eq!(Feedback::ceiling((1920, 1080)), BITRATE_BPS_1080P);
        assert_eq!(Feedback::ceiling((3840, 2160)), MAX_BITRATE_BPS);
        assert_eq!(Feedback::ceiling((1280, 720)), BITRATE_BPS_1080P * 3 / 4);
    }

    #[test]
    fn a_screen_is_only_shrunk_to_the_viewer_never_enlarged() {
        assert_eq!(fit_scale_within(1920, 1080, (2340, 1080)), 1.0);
        assert_eq!(fit_scale_within(3840, 2160, (2340, 1080)), 0.5);
        assert_eq!(fit_scale_within(1280, 720, (2560, 1440)), 1.0);
    }

    /// Needs a desktop, and a GPU encoder or the downloaded H.264 library: captures, converts and
    /// encodes the real screen and prints how long that takes.
    #[test]
    #[ignore]
    fn the_real_screen_is_captured_and_encoded() {
        let config_dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("Link");
        let encoder = H264Encoder::new(&config_dir, MAX_BITRATE_BPS, FRAME_RATE).expect("no H.264 encoder");
        let (tx, _rx) = mpsc::channel(4);
        let mut pipeline = Pipeline {
            encoder,
            display: Display::Primary,
            screen: Arc::new(AtomicU32::new(0)),
            viewport: Some((2340, 1080)),
            frames: tx,
            on_screen_missing: Box::new(|| {}),
            feedback: Arc::new(Feedback::default()),
            bitrate: None,
        };
        let mut capture = crate::core::screen_capture::Subscription::default();
        let mut yuv = crate::core::screen_capture::I420::default();
        let (mut grab, mut encode, mut bytes, mut frames) = (Duration::ZERO, Duration::ZERO, 0usize, 0u32);
        while frames < 30 {
            let t = Instant::now();
            capture.next(Display::Primary, 0, Duration::from_millis(100));
            grab += t.elapsed();
            let t = Instant::now();
            if let Some(data) = capture.with_frame(|frame| pipeline.encode(frame, &mut yuv)).expect("no picture").expect("no encoder") {
                bytes += data.len();
            }
            encode += t.elapsed();
            frames += 1;
        }
        println!("{}: per frame: capture {:?}, convert+encode {:?}, {} bytes", pipeline.encoder.name(), grab / frames, encode / frames, bytes / frames as usize);
    }
}
