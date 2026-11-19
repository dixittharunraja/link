// The H.264 encoder screen sharing uses (rtc_share.rs).
//
// The GPU's own encoder (NVIDIA NVENC, Intel Quick Sync, AMD AMF), reached through Media Foundation,
// is used whenever the PC has one: it costs next to no CPU, adds only a few milliseconds and needs no
// download. Cisco's OpenH264 (openh264_lib.rs) is kept only for PCs without one (virtual machines,
// old or basic display adapters), and for a session whose hardware encoder fails: then this session
// switches to OpenH264 once and stays on it. Both produce Constrained Baseline, which is what the
// offer's profile-level-id (42e01f) promises, so the viewer never notices the switch beyond a
// keyframe.

use std::path::{Path, PathBuf};

use openh264::encoder::{BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, Profile, QpRange, UsageType};
use openh264::formats::YUVSource;

use crate::core::screen_capture::I420;

/// True when this PC has a hardware H.264 encoder that has not failed to start, so sharing the screen
/// does not need Cisco's library. Looked up once (the list of encoders does not change while the app
/// runs); a hardware encoder that could not encode a single picture counts as missing from then on.
pub fn hardware_available() -> bool {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering;
        static PROBE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        // On a thread of its own: COM is set up for the lookup, and the caller's thread (often a
        // tokio worker) is left as it was.
        !hardware::FAILED.load(Ordering::Relaxed) && *PROBE.get_or_init(|| std::thread::spawn(hardware::probe).join().unwrap_or(false))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub struct H264Encoder {
    backend: Backend,
    config_dir: PathBuf,
    max_bitrate: u32,
    frame_rate: f32,
    /// The bitrate asked for last, kept for an encoder that is started later (a new picture size,
    /// or the switch to OpenH264).
    bitrate: u32,
    /// The next picture is to be a keyframe.
    keyframe: bool,
    /// The bitrate OpenH264 was given, and for which picture size: it starts over with its configured
    /// bitrate whenever the size changes.
    software_bitrate: Option<(u32, (usize, usize))>,
}

enum Backend {
    /// The hardware encoder, started with the first picture (it is set up for one picture size).
    #[cfg(windows)]
    Hardware { encoder: Option<hardware::MfEncoder>, worked: bool },
    Software(Encoder),
}

fn software(config_dir: &Path, max_bitrate: u32, frame_rate: f32) -> Result<Encoder, String> {
    let config = EncoderConfig::new()
        // The highest any picture may get, which is also the encoder's own limit; the real one is
        // set once the picture's size is known, and follows the viewer's feedback.
        .bitrate(BitRate::from_bps(max_bitrate))
        .max_frame_rate(FrameRate::from_hz(frame_rate))
        .usage_type(UsageType::ScreenContentRealTime)
        // The fastest encoding setting: every millisecond saved here is latency saved on the phone.
        .complexity(Complexity::Low)
        // Keyframes are asked for explicitly, by time rather than by frame count, because frames only
        // exist while the screen is changing.
        .intra_frame_period(IntraFramePeriod::auto())
        // Keeps text sharp: the encoder may not trade it away to save bits.
        .qp(QpRange::new(10, 36))
        // Constrained Baseline, which is what the offer's profile-level-id (42e01f) promises.
        .profile(Profile::Baseline);
    Encoder::with_api_config(crate::core::openh264_lib::load_api(config_dir)?, config).map_err(|e| e.to_string())
}

impl H264Encoder {
    /// The hardware encoder when there is one, OpenH264 otherwise (an error if it is not installed).
    pub fn new(config_dir: &Path, max_bitrate: u32, frame_rate: f32) -> Result<Self, String> {
        #[cfg(windows)]
        let backend = if hardware_available() {
            Backend::Hardware { encoder: None, worked: false }
        } else {
            Backend::Software(software(config_dir, max_bitrate, frame_rate)?)
        };
        #[cfg(not(windows))]
        let backend = Backend::Software(software(config_dir, max_bitrate, frame_rate)?);
        Ok(Self { backend, config_dir: config_dir.to_path_buf(), max_bitrate, frame_rate, bitrate: max_bitrate, keyframe: false, software_bitrate: None })
    }

    /// Makes the next picture a keyframe.
    pub fn force_keyframe(&mut self) {
        self.keyframe = true;
    }

    /// Changes the bitrate, effective from the next picture.
    pub fn set_bitrate(&mut self, bps: u32) {
        self.bitrate = bps;
        #[cfg(windows)]
        if let Backend::Hardware { encoder: Some(encoder), .. } = &mut self.backend {
            encoder.set_bitrate(bps);
        }
    }

    /// Encodes one picture as H.264 (Annex B). Empty when the encoder produced nothing for it; an
    /// error only when there is no encoder left to use, which ends the session.
    pub fn encode(&mut self, picture: &I420) -> Result<Vec<u8>, String> {
        let keyframe = std::mem::take(&mut self.keyframe);
        #[cfg(windows)]
        if let Backend::Hardware { encoder, worked } = &mut self.backend {
            match hardware::encode(encoder, picture, keyframe, self.bitrate, self.frame_rate) {
                Ok(bytes) => {
                    *worked = true;
                    return Ok(bytes);
                }
                Err(e) => {
                    // One that never produced a picture is not tried again by later sessions either.
                    if !*worked {
                        hardware::FAILED.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    log::warn!("[H264] the hardware encoder failed ({e}); OpenH264 encodes the rest of this session");                    // Shut down before OpenH264 starts.
                    *encoder = None;
                    self.backend = Backend::Software(software(&self.config_dir, self.max_bitrate, self.frame_rate)?);
                    // A new encoder starts with a keyframe anyway.
                }
            }
        }
        #[allow(irrefutable_let_patterns)]
        let Backend::Software(encoder) = &mut self.backend else { unreachable!("the hardware encoder returned above") };
        if keyframe {
            encoder.force_intra_frame();
        }
        let bytes = match encoder.encode(picture) {
            Ok(stream) => stream.to_vec(),
            Err(e) => {
                log::debug!("[H264] OpenH264 could not encode a picture: {e}");
                return Ok(Vec::new());
            }
        };
        // Only after an encode: before its first one the encoder is not set up yet.
        let wanted = (self.bitrate, picture.dimensions());
        if self.software_bitrate != Some(wanted) {
            // OpenH264's own SBitrateInfo and option numbers, which the crate does not export.
            #[repr(C)]
            struct BitrateInfo {
                layer: std::os::raw::c_int,
                bitrate: std::os::raw::c_int,
            }
            const ENCODER_OPTION_BITRATE: std::os::raw::c_int = 5;
            const SPATIAL_LAYER_ALL: std::os::raw::c_int = 4;
            let mut info = BitrateInfo { layer: SPATIAL_LAYER_ALL, bitrate: self.bitrate as std::os::raw::c_int };
            // SAFETY: the encoder is initialised (it has just encoded a picture of this size), and the
            // option takes a pointer to an SBitrateInfo, which only has to live for the call.
            let status = unsafe { encoder.raw_api().set_option(ENCODER_OPTION_BITRATE, (&raw mut info).cast()) };
            if status != 0 {
                log::debug!("[H264] OpenH264 refused a bitrate of {}: {status}", self.bitrate);
            }
            self.software_bitrate = Some(wanted);
        }
        Ok(bytes)
    }

    /// Which encoder is in use, for the logs.
    pub fn name(&self) -> &str {
        match &self.backend {
            #[cfg(windows)]
            Backend::Hardware { encoder: Some(encoder), .. } => &encoder.name,
            #[cfg(windows)]
            Backend::Hardware { encoder: None, .. } => "hardware (not started)",
            Backend::Software(_) => "OpenH264",
        }
    }
}

/// A Media Foundation hardware encoder (MFT). These are asynchronous: the encoder says, by events,
/// when it wants a picture and when it has a finished one. A picture is handed over when it asks, and
/// the call waits for that picture's output; in low-latency mode every picture comes out on its own,
/// before the next goes in, so nothing is held back while the screen is still.
#[cfg(windows)]
mod hardware {
    use std::mem::ManuallyDrop;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use openh264::formats::YUVSource;
    use windows::core::{implement, Interface, Ref, GUID, HRESULT};
    use windows::Win32::Foundation::E_NOTIMPL;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VARIANT;

    use crate::core::screen_capture::I420;

    /// Set when a hardware encoder failed before it produced a single picture.
    pub static FAILED: AtomicBool = AtomicBool::new(false);

    /// The longest an encoder is waited for. A hardware encoder answers in milliseconds; one that
    /// does not answer within this is stuck (a driver reset, say), and OpenH264 takes over.
    const EVENT_TIMEOUT: Duration = Duration::from_secs(2);
    /// H.264 Baseline profile (eAVEncH264VProfile_Base). Hardware encoders never use the Baseline
    /// tools that Constrained Baseline leaves out (FMO, ASO, redundant slices), so this is
    /// Constrained Baseline in practice; every encoder MFT supports it, which is not true of
    /// eAVEncH264VProfile_ConstrainedBase.
    const PROFILE_BASELINE: u32 = 66;
    /// Keyframes are asked for explicitly (by time, and when the viewer asks), so the encoder's own
    /// are a minute apart at the frame rate it is told.
    const GOP_SECONDS: u32 = 60;

    fn error(what: &str, e: windows::core::Error) -> String {
        format!("{what}: {e}")
    }

    /// COM and Media Foundation, started for as long as this lives on the thread that made it.
    struct Runtime {
        com: bool,
    }

    impl Runtime {
        fn start() -> Result<Self, String> {
            // S_FALSE (already initialised) also has to be balanced; a thread already in a
            // single-threaded apartment keeps it, which Media Foundation works in as well.
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            if let Err(e) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) } {
                if com {
                    unsafe { CoUninitialize() };
                }
                return Err(error("Media Foundation did not start", e));
            }
            Ok(Self { com })
        }
    }

    impl Drop for Runtime {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                if self.com {
                    CoUninitialize();
                }
            }
        }
    }

    /// The hardware encoders that take NV12 and make H.264, best first.
    fn encoders() -> Result<Vec<IMFActivate>, String> {
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        unsafe {
            MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG(MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0),
                Some(&input),
                Some(&output),
                &mut list,
                &mut count,
            )
            .map_err(|e| error("the encoders could not be listed", e))?;
        }
        if list.is_null() {
            return Ok(Vec::new());
        }
        // SAFETY: MFTEnumEx returned an array of `count` activation objects, allocated with
        // CoTaskMemAlloc; each is taken out (so it is released by its new owner) before the array
        // itself is freed.
        let found = (0..count as usize).filter_map(|i| unsafe { (*list.add(i)).take() }).collect();
        unsafe { CoTaskMemFree(Some(list as *const _)) };
        Ok(found)
    }

    fn friendly_name(activate: &IMFActivate) -> String {
        let mut name = [0u16; 128];
        let mut len = 0u32;
        match unsafe { activate.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut name, Some(&mut len)) } {
            Ok(()) => String::from_utf16_lossy(&name[..(len as usize).min(name.len())]),
            Err(_) => "hardware H.264 encoder".into(),
        }
    }

    /// Whether this PC has a hardware H.264 encoder at all.
    pub fn probe() -> bool {
        let Ok(_runtime) = Runtime::start() else { return false };
        match encoders() {
            Ok(found) if !found.is_empty() => {
                let names: Vec<String> = found.iter().map(friendly_name).collect();
                log::info!("[H264] hardware encoders: {}", names.join(", "));
                true
            }
            Ok(_) => {
                log::info!("[H264] no hardware encoder; screen sharing uses OpenH264");
                false
            }
            Err(e) => {
                log::warn!("[H264] {e}; screen sharing uses OpenH264");
                false
            }
        }
    }

    /// Encodes with the encoder in `slot`, starting one first when there is none or the picture's
    /// size changed (an encoder is set up for one size).
    pub fn encode(slot: &mut Option<MfEncoder>, picture: &I420, keyframe: bool, bitrate: u32, frame_rate: f32) -> Result<Vec<u8>, String> {
        let size = picture.dimensions();
        if slot.as_ref().is_none_or(|encoder| encoder.size != size) {
            // The old one goes first: consumer GPUs allow only a few encoding sessions at once.
            *slot = None;
            let encoder = MfEncoder::new(size, bitrate, frame_rate)?;
            log::info!("[H264] encoding {}x{} with {}", size.0, size.1, encoder.name);
            *slot = Some(encoder);
        }
        let encoder = slot.as_mut().expect("started above");
        // A new encoder starts with a keyframe anyway.
        encoder.encode(picture, keyframe)
    }

    /// Passes the encoder's events (asked for one at a time with BeginGetEvent) back to the thread
    /// that encodes, which waits for them with a time limit.
    #[implement(IMFAsyncCallback)]
    struct EventSink {
        generator: IMFMediaEventGenerator,
        events: mpsc::Sender<windows::core::Result<(u32, HRESULT)>>,
    }

    impl IMFAsyncCallback_Impl for EventSink_Impl {
        fn GetParameters(&self, _flags: *mut u32, _queue: *mut u32) -> windows::core::Result<()> {
            // The default work queue.
            Err(E_NOTIMPL.into())
        }

        fn Invoke(&self, result: Ref<'_, IMFAsyncResult>) -> windows::core::Result<()> {
            let event = result.ok().and_then(|result| unsafe { self.generator.EndGetEvent(result) });
            let event = event.and_then(|event| unsafe { Ok((event.GetType()?, event.GetStatus()?)) });
            // The encoder may already be gone (its session ended while this was pending).
            let _ = self.events.send(event);
            Ok(())
        }
    }

    pub struct MfEncoder {
        pub name: String,
        pub size: (usize, usize),
        activate: IMFActivate,
        transform: IMFTransform,
        codec: ICodecAPI,
        generator: IMFMediaEventGenerator,
        callback: IMFAsyncCallback,
        events: mpsc::Receiver<windows::core::Result<(u32, HRESULT)>>,
        /// An event has been asked for and has not arrived yet.
        waiting: bool,
        /// How many pictures the encoder has asked for that it has not been given.
        wanted: u32,
        /// The encoder makes its own output samples (hardware encoders do); otherwise one of
        /// `output_size` bytes is handed to it.
        provides_samples: bool,
        output_size: u32,
        clock: Instant,
        last_time: i64,
        /// Last, so COM and Media Foundation outlive every object above.
        _runtime: Runtime,
    }

    // SAFETY: the encoder is created, used and dropped on the screen-capture thread only; it is
    // moved there before its first picture, while it holds no COM object yet (see Backend). Its
    // objects live in the multithreaded apartment, where they may be used from any thread anyway.
    unsafe impl Send for MfEncoder {}

    fn set(codec: &ICodecAPI, api: &GUID, value: VARIANT, what: &str) {
        if let Err(e) = unsafe { codec.SetValue(api, &value) } {
            log::debug!("[H264] the encoder did not take {what}: {e}");
        }
    }

    /// The bitrate is a ceiling, as for OpenH264, not a target: the average and the peak are both
    /// set to it, and a picture that needs less gets less. Constant bitrate would pad every picture
    /// up to bitrate / frame rate (AMD's encoder does, measured: a still screen cost the full 8
    /// Mbit/s), which fills the Wi-Fi for nothing while the screen is still.
    fn set_bitrate(codec: &ICodecAPI, bps: u32) {
        set(codec, &CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bps), "the bitrate");
        set(codec, &CODECAPI_AVEncCommonMaxBitRate, VARIANT::from(bps), "the peak bitrate");
    }

    fn pack(high: u32, low: u32) -> u64 {
        ((high as u64) << 32) | low as u64
    }

    impl MfEncoder {
        /// Starts the best hardware encoder that accepts this picture size.
        fn new(size: (usize, usize), bitrate: u32, frame_rate: f32) -> Result<Self, String> {
            let runtime = Runtime::start()?;
            let mut errors = Vec::new();
            // One that cannot start (NVIDIA's, on a laptop whose NVIDIA GPU is asleep, fails with
            // E_UNEXPECTED) or refuses this size gives way to the next.
            for activate in encoders()? {
                let name = friendly_name(&activate);
                match Self::open(&activate, size, bitrate, frame_rate) {
                    Ok((transform, codec, generator, provides_samples, output_size)) => {
                        let (events_tx, events) = mpsc::channel();
                        let callback: IMFAsyncCallback = EventSink { generator: generator.clone(), events: events_tx }.into();
                        return Ok(Self {
                            name,
                            size,
                            activate,
                            transform,
                            codec,
                            generator,
                            callback,
                            events,
                            waiting: false,
                            wanted: 0,
                            provides_samples,
                            output_size,
                            clock: Instant::now(),
                            last_time: 0,
                            _runtime: runtime,
                        });
                    }
                    Err(e) => {
                        unsafe {
                            let _ = activate.ShutdownObject();
                        }
                        errors.push(format!("{name}: {e}"));
                    }
                }
            }
            Err(if errors.is_empty() { "no hardware encoder".into() } else { errors.join("; ") })
        }

        #[allow(clippy::type_complexity)]
        fn open(activate: &IMFActivate, (width, height): (usize, usize), bitrate: u32, frame_rate: f32) -> Result<(IMFTransform, ICodecAPI, IMFMediaEventGenerator, bool, u32), String> {
            let (width, height) = (width as u32, height as u32);
            let fps = (frame_rate.round() as u32).max(1);
            unsafe {
                let transform: IMFTransform = activate.ActivateObject().map_err(|e| error("could not start", e))?;
                let attributes = transform.GetAttributes().map_err(|e| error("no attributes", e))?;
                // Hardware encoders are asynchronous; the event model below depends on it.
                if attributes.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 0 {
                    return Err("not an asynchronous encoder".into());
                }
                attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(|e| error("could not be unlocked", e))?;
                let codec: ICodecAPI = transform.cast().map_err(|e| error("no ICodecAPI", e))?;

                // Rate control and latency are set before the media types, as some encoders read
                // them only then.
                set(&codec, &CODECAPI_AVLowLatencyMode, VARIANT::from(true), "low-latency mode");
                set(&codec, &CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32), "peak-constrained rate control");
                set_bitrate(&codec, bitrate);
                set(&codec, &CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps * GOP_SECONDS), "the keyframe interval");
                set(&codec, &CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32), "no B-frames");

                // An encoder takes its output type first, then offers the input types that go with it.
                let output = MFCreateMediaType().map_err(|e| error("no media type", e))?;
                output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| error("output type", e))?;
                output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|e| error("output type", e))?;
                output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).map_err(|e| error("output type", e))?;
                output.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height)).map_err(|e| error("output type", e))?;
                output.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1)).map_err(|e| error("output type", e))?;
                output.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(|e| error("output type", e))?;
                output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| error("output type", e))?;
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, PROFILE_BASELINE).map_err(|e| error("output type", e))?;
                transform.SetOutputType(0, &output, 0).map_err(|e| error("refused H.264 Baseline at this size", e))?;

                let mut index = 0;
                let input = loop {
                    let offered = transform.GetInputAvailableType(0, index).map_err(|e| error("does not take NV12", e))?;
                    if offered.GetGUID(&MF_MT_SUBTYPE).is_ok_and(|subtype| subtype == MFVideoFormat_NV12) {
                        break offered;
                    }
                    index += 1;
                };
                input.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height)).map_err(|e| error("input type", e))?;
                input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1)).map_err(|e| error("input type", e))?;
                input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(|e| error("input type", e))?;
                input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| error("input type", e))?;
                transform.SetInputType(0, &input, 0).map_err(|e| error("refused NV12 at this size", e))?;

                let info = transform.GetOutputStreamInfo(0).map_err(|e| error("no output stream", e))?;
                let provides_samples = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
                let generator: IMFMediaEventGenerator = transform.cast().map_err(|e| error("no events", e))?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(|e| error("did not begin streaming", e))?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(|e| error("did not start the stream", e))?;
                Ok((transform, codec, generator, provides_samples, info.cbSize))
            }
        }

        pub fn set_bitrate(&mut self, bps: u32) {
            set_bitrate(&self.codec, bps);
        }

        /// Hands one picture over and returns what the encoder made for it.
        fn encode(&mut self, picture: &I420, keyframe: bool) -> Result<Vec<u8>, String> {
            let deadline = Instant::now() + EVENT_TIMEOUT;
            // Output still owed from an earlier picture leads, so the stream stays in order.
            let mut out = Vec::new();
            while self.wanted == 0 {
                self.next_event(deadline, &mut out)?;
            }
            let sample = self.sample(picture).map_err(|e| error("the picture could not be handed over", e))?;
            if keyframe {
                set(&self.codec, &CODECAPI_AVEncVideoForceKeyFrame, VARIANT::from(1u32), "a keyframe request");
            }
            unsafe { self.transform.ProcessInput(0, &sample, 0) }.map_err(|e| error("the picture was refused", e))?;
            self.wanted -= 1;
            while !self.next_event(deadline, &mut out)? {}
            Ok(out)
        }

        /// Waits for the encoder's next event and acts on it; true when it was a finished picture.
        fn next_event(&mut self, deadline: Instant, out: &mut Vec<u8>) -> Result<bool, String> {
            if !self.waiting {
                unsafe { self.generator.BeginGetEvent(&self.callback, None) }.map_err(|e| error("no events", e))?;
                self.waiting = true;
            }
            let timeout = deadline.saturating_duration_since(Instant::now());
            let (kind, status) = match self.events.recv_timeout(timeout) {
                Ok(event) => {
                    self.waiting = false;
                    event.map_err(|e| error("event", e))?
                }
                // Still asked for: the next call waits for the same event.
                Err(_) => return Err("the encoder stopped answering".into()),
            };
            status.ok().map_err(|e| error("the encoder reported an error", e))?;
            let kind = MF_EVENT_TYPE(kind as i32);
            if kind == METransformNeedInput {
                self.wanted += 1;
            } else if kind == METransformHaveOutput {
                return self.take_output(out);
            } else if kind == MEError {
                return Err("the encoder reported an error".into());
            }
            Ok(false)
        }

        /// Collects a finished picture; false when the encoder changed its output format instead.
        fn take_output(&mut self, out: &mut Vec<u8>) -> Result<bool, String> {
            let sample = if self.provides_samples {
                None
            } else {
                unsafe {
                    let sample = MFCreateSample().map_err(|e| error("no output sample", e))?;
                    let buffer = MFCreateMemoryBuffer(self.output_size.max(1 << 20)).map_err(|e| error("no output buffer", e))?;
                    sample.AddBuffer(&buffer).map_err(|e| error("no output buffer", e))?;
                    Some(sample)
                }
            };
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(sample), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let result = unsafe { self.transform.ProcessOutput(0, &mut buffers, &mut status) };
            let [buffer] = buffers;
            drop(ManuallyDrop::into_inner(buffer.pEvents));
            let sample = ManuallyDrop::into_inner(buffer.pSample);
            match result {
                Ok(()) => {}
                // The encoder settled its output format (some do this before the first picture):
                // take the one it offers; the picture itself follows with another event.
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => unsafe {
                    let offered = self.transform.GetOutputAvailableType(0, 0).map_err(|e| error("no new output type", e))?;
                    self.transform.SetOutputType(0, &offered, 0).map_err(|e| error("the new output type was refused", e))?;
                    return Ok(false);
                },
                Err(e) => return Err(error("no output", e)),
            }
            let Some(sample) = sample else { return Err("the encoder returned no sample".into()) };
            unsafe {
                let buffer = sample.ConvertToContiguousBuffer().map_err(|e| error("output", e))?;
                let mut data = std::ptr::null_mut();
                let mut len = 0u32;
                buffer.Lock(&mut data, None, Some(&mut len)).map_err(|e| error("output", e))?;
                // SAFETY: a locked buffer holds `len` valid bytes at `data` until it is unlocked.
                out.extend_from_slice(std::slice::from_raw_parts(data, len as usize));
                let _ = buffer.Unlock();
            }
            Ok(true)
        }

        /// The picture as an NV12 sample: the luma plane as it is, then the two chroma planes
        /// interleaved, which is the only difference between NV12 and the I420 OpenH264 takes.
        fn sample(&mut self, picture: &I420) -> windows::core::Result<IMFSample> {
            let (width, height) = picture.dimensions();
            let luma = width * height;
            let len = luma + luma / 2;
            unsafe {
                let buffer = MFCreateMemoryBuffer(len as u32)?;
                let mut data = std::ptr::null_mut();
                buffer.Lock(&mut data, None, None)?;
                // SAFETY: the buffer was made with room for `len` bytes and is locked.
                let target = std::slice::from_raw_parts_mut(data, len);
                let (y, uv) = target.split_at_mut(luma);
                y.copy_from_slice(&picture.y()[..luma]);
                for ((pair, u), v) in uv.chunks_exact_mut(2).zip(picture.u()).zip(picture.v()) {
                    pair[0] = *u;
                    pair[1] = *v;
                }
                buffer.Unlock()?;
                buffer.SetCurrentLength(len as u32)?;
                let sample = MFCreateSample()?;
                sample.AddBuffer(&buffer)?;
                // Real time, in 100 ns units: pictures only exist while the screen changes.
                let time = (self.clock.elapsed().as_nanos() / 100) as i64;
                let time = time.max(self.last_time + 1);
                sample.SetSampleTime(time)?;
                sample.SetSampleDuration((time - self.last_time).max(1))?;
                self.last_time = time;
                Ok(sample)
            }
        }
    }

    impl Drop for MfEncoder {
        fn drop(&mut self) {
            unsafe {
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                // Ends the encoder's session on the GPU and cancels the event still asked for.
                let _ = self.activate.ShutdownObject();
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A page of text-like lines, taller than the screen, so pictures can scroll through it.
    fn document(width: usize, height: usize) -> Vec<u8> {
        (0..width * height)
            .flat_map(|i| {
                let (x, y) = (i % width, i / width);
                let ink = y % 20 < 12 && (x * 7 + y * 13) % 11 < 4 && x % 400 < 360;
                if ink { [20, 20, 20, 255] } else { [240, 240, 240, 255] }
            })
            .collect()
    }

    /// The document scrolled down by `offset` rows, as the encoder takes it.
    fn view(document: &[u8], width: usize, height: usize, offset: usize) -> I420 {
        let mut yuv = I420::default();
        yuv.fill(&document[offset * width * 4..], width * 4, width, height, None);
        yuv
    }

    /// The NAL unit types in an Annex B stream.
    fn nal_types(stream: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut i = 0;
        while i + 3 < stream.len() {
            if stream[i..i + 3] == [0, 0, 1] {
                types.push(stream[i + 3] & 0x1f);
                i += 3;
            } else {
                i += 1;
            }
        }
        types
    }

    /// Needs a GPU with an H.264 encoder: scrolls a page at 60 pictures a second, asks for a
    /// keyframe and lowers the bitrate on the way, then holds still, then changes size. Checks the
    /// stream is Baseline with SPS/PPS before every keyframe and a still screen costs next to
    /// nothing. `cargo test --lib -- --ignored hardware_encoder_encodes --nocapture`
    #[test]
    #[ignore = "needs a hardware H.264 encoder"]
    fn hardware_encoder_encodes() {
        assert!(hardware_available(), "no hardware encoder on this PC");
        // OpenH264 is not installed here, so a failing hardware encoder fails the test.
        let config_dir = std::env::temp_dir().join("link-h264-hw-test");
        let mut encoder = H264Encoder::new(&config_dir, 8_000_000, 60.0).expect("an encoder");
        let (width, height) = (1920, 1080);
        let page = document(width, height + 1000);
        let mut sizes = Vec::new();
        let mut slowest = std::time::Duration::ZERO;
        let tick = std::time::Duration::from_micros(16_667);
        let started = std::time::Instant::now();
        for frame in 0..240 {
            if frame == 120 {
                encoder.force_keyframe();
                encoder.set_bitrate(2_000_000);
            }
            // Real time, so the rate control sees real timestamps.
            if let Some(wait) = (started + tick * frame as u32).checked_duration_since(std::time::Instant::now()) {
                std::thread::sleep(wait);
            }
            let picture = view(&page, width, height, frame * 4);
            let t = std::time::Instant::now();
            let bytes = encoder.encode(&picture).expect("the hardware encoder failed");
            if frame > 0 {
                slowest = slowest.max(t.elapsed());
            }
            let types = nal_types(&bytes);
            if frame == 0 || frame == 120 {
                assert!(types.contains(&7) && types.contains(&8) && types.contains(&5), "picture {frame} is not a keyframe with SPS/PPS: {types:?}");
                let sps = bytes.windows(4).position(|w| w == [0, 0, 1, 0x67]).unwrap() + 4;
                assert_eq!(bytes[sps], 66, "not Baseline");
                println!("picture {frame}: keyframe of {} bytes in {:?}, SPS profile {} constraints {:08b} level {}", bytes.len(), t.elapsed(), bytes[sps], bytes[sps + 1], bytes[sps + 2]);
            }
            assert!(!bytes.is_empty(), "picture {frame} produced nothing");
            sizes.push(bytes.len());
        }
        let kbps = |range: std::ops::Range<usize>| sizes[range].iter().sum::<usize>() * 8 / 1000;
        println!("{}: scrolling cost {} kbit/s at 8 Mbit/s, {} kbit/s at 2 Mbit/s; slowest picture {slowest:?}", encoder.name(), kbps(60..120), kbps(180..240));
        assert!(kbps(180..240) < kbps(60..120), "lowering the bitrate changed nothing");

        // The screen stops: the same picture again, as the idle refresh sends it.
        let still = view(&page, width, height, 239 * 4);
        let still_sizes: Vec<usize> = (0..6).map(|_| encoder.encode(&still).unwrap().len()).collect();
        println!("still screen: {still_sizes:?} bytes");
        // The encoder may still spend a little sharpening a picture that stopped moving, but nothing
        // pads a picture up to a per-picture budget (constant bitrate costs 16 kB each at 8 Mbit/s).
        assert!(still_sizes.iter().any(|&s| s < 100), "a still screen is padded: {still_sizes:?}");

        // A new size restarts the encoder, with a keyframe.
        let small = view(&document(1280, 720), 1280, 720, 0);
        let bytes = encoder.encode(&small).unwrap();
        assert!(nal_types(&bytes).contains(&5), "a new size did not start with a keyframe");
    }
}
