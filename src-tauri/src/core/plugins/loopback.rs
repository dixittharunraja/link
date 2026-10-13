// Capture of the audio Windows is playing through a render endpoint (WASAPI loopback), for the
// audio sink. COM objects stay on one dedicated thread; the PCM they produce is handed to async
// code through a channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug)]
pub struct Format {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub is_float: bool,
}

pub struct Device {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Capture runs until this is dropped.
pub struct Capture {
    stop: Arc<AtomicBool>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub type Chunks = mpsc::UnboundedReceiver<Vec<u8>>;

#[cfg(windows)]
mod imp {
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc as std_mpsc, Arc};
    use std::time::Duration;

    use tokio::sync::mpsc;
    use windows::core::{Result, PCWSTR};
    use windows::Win32::Media::Audio::{eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, AUDCLNT_SHAREMODE_SHARED, WAVEFORMATEX};
    use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

    use super::Format;
    use crate::core::plugins::volume::enumerator;

    const STREAMFLAGS_LOOPBACK: u32 = 0x0002_0000;
    const STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x8000_0000;
    const STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x0800_0000;
    const BUFFERFLAGS_SILENT: u32 = 0x2;
    // Opus accepts only a handful of rates, and the phone's low-latency output path wants the
    // stream to match its native 48 kHz, so the engine is asked to resample whenever the mixer
    // runs at something else.
    const TARGET_RATE: u32 = 48_000;
    // 20 ms: enough for the engine to hand over a period at a time, half the delay of the old 40 ms.
const BUFFER_100NS: i64 = 200_000;

    pub fn default_render_id() -> Option<String> {
        // SAFETY: plain COM calls on a live device; the returned id string is freed exactly once.
        unsafe {
            let id = enumerator().ok()?.GetDefaultAudioEndpoint(eRender, eConsole).ok()?.GetId().ok()?;
            let text = id.to_string().ok();
            CoTaskMemFree(Some(id.0 as _));
            text
        }
    }

    fn open_device(id: Option<&str>) -> Result<IMMDevice> {
        let enumerator = enumerator()?;
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        unsafe {
            if let Some(id) = id.filter(|i| !i.is_empty()) {
                let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
                match enumerator.GetDevice(PCWSTR(wide.as_ptr())) {
                    Ok(device) => return Ok(device),
                    Err(e) => log::warn!("Selected playback device is unavailable ({}); using the system default", e),
                }
            }
            enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
        }
    }

    /// The engine's mix format as owned bytes (WAVEFORMATEX plus any extensible tail), so a copy
    /// with another sample rate can be built.
    struct MixFormat(Vec<u8>);

    impl MixFormat {
        fn of(client: &IAudioClient) -> Result<Self> {
            // SAFETY: GetMixFormat returns a CoTaskMem block of 18 + cbSize bytes, freed once here.
            unsafe {
                let format = client.GetMixFormat()?;
                let length = 18 + ptr::read_unaligned(ptr::addr_of!((*format).cbSize)) as usize;
                let bytes = std::slice::from_raw_parts(format as *const u8, length).to_vec();
                CoTaskMemFree(Some(format as _));
                Ok(Self(bytes))
            }
        }

        fn header(&self) -> WAVEFORMATEX {
            // SAFETY: the buffer always starts with a complete WAVEFORMATEX (packed, so unaligned reads).
            unsafe { ptr::read_unaligned(self.0.as_ptr() as *const WAVEFORMATEX) }
        }

        fn at_rate(&self, rate: u32) -> Self {
            let mut bytes = self.0.clone();
            let mut header = self.header();
            header.nSamplesPerSec = rate;
            header.nAvgBytesPerSec = rate * header.nBlockAlign as u32;
            // SAFETY: as in `header`.
            unsafe { ptr::write_unaligned(bytes.as_mut_ptr() as *mut WAVEFORMATEX, header) };
            Self(bytes)
        }

        fn as_ptr(&self) -> *const WAVEFORMATEX {
            self.0.as_ptr() as *const WAVEFORMATEX
        }

        fn describe(&self) -> Format {
            let header = self.header();
            Format { sample_rate: header.nSamplesPerSec, channels: header.nChannels, bits_per_sample: header.wBitsPerSample, is_float: header.wBitsPerSample == 32 }
        }
    }

    struct Session {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        // A silent stream on the same endpoint: loopback delivers nothing while nothing renders.
        keep_alive: Option<IAudioClient>,
        format: Format,
    }

    fn activate(device: &IMMDevice) -> Result<IAudioClient> {
        // SAFETY: activating a standard interface on a live device.
        unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) }
    }

    fn open_session(device_id: Option<&str>) -> Result<Session> {
        let device = open_device(device_id)?;
        let mut client = activate(&device)?;
        let mix = MixFormat::of(&client)?;

        let native_rate = mix.header().nSamplesPerSec;
        let mut chosen = None;
        if native_rate != TARGET_RATE {
            let converted = mix.at_rate(TARGET_RATE);
            let flags = STREAMFLAGS_LOOPBACK | STREAMFLAGS_AUTOCONVERTPCM | STREAMFLAGS_SRC_DEFAULT_QUALITY;
            // SAFETY: `converted` holds a complete format and outlives the call.
            if unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_100NS, 0, converted.as_ptr(), None) }.is_ok() {
                chosen = Some(converted);
            } else {
                log::info!("48 kHz conversion unavailable; capturing at the native {} Hz", native_rate);
                // A client that failed to initialise can't be reused.
                client = activate(&device)?;
            }
        }
        let format = match chosen {
            Some(converted) => converted,
            None => {
                // SAFETY: as above.
                unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, STREAMFLAGS_LOOPBACK, BUFFER_100NS, 0, mix.as_ptr(), None)? };
                MixFormat(mix.0.clone())
            }
        };

        let keep_alive = activate(&device).ok().and_then(|silent| {
            // SAFETY: the render stream is started with the engine's own mix format.
            unsafe {
                silent.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, BUFFER_100NS, 0, mix.as_ptr(), None).ok()?;
                silent.Start().ok()?;
            }
            Some(silent)
        });
        // SAFETY: the client is initialised for loopback capture.
        let capture = unsafe { client.GetService::<IAudioCaptureClient>()? };
        Ok(Session { client, capture, keep_alive, format: format.describe() })
    }

    pub fn run(device_id: Option<String>, ready: std_mpsc::Sender<std::result::Result<Format, String>>, chunks: mpsc::UnboundedSender<Vec<u8>>, stop: Arc<AtomicBool>) {
        let session = match open_session(device_id.as_deref()) {
            Ok(session) => session,
            Err(e) => {
                let _ = ready.send(Err(format!("Audio capture could not start: {}", e)));
                return;
            }
        };
        // SAFETY: starts the initialised capture stream.
        if let Err(e) = unsafe { session.client.Start() } {
            let _ = ready.send(Err(format!("Audio capture could not start: {}", e)));
            return;
        }
        let _ = ready.send(Ok(session.format));

        let frame_bytes = session.format.channels as usize * (session.format.bits_per_sample as usize / 8);
        while !stop.load(Ordering::Relaxed) {
            // SAFETY: GetBuffer/ReleaseBuffer are paired, and the slice is copied before release.
            unsafe {
                if session.capture.GetNextPacketSize().unwrap_or(0) == 0 {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                let mut data = ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if session.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                let length = frames as usize * frame_bytes;
                let chunk = if flags & BUFFERFLAGS_SILENT != 0 || data.is_null() { vec![0u8; length] } else { std::slice::from_raw_parts(data, length).to_vec() };
                let _ = session.capture.ReleaseBuffer(frames);
                if length > 0 && chunks.send(chunk).is_err() {
                    break;
                }
            }
        }
        // SAFETY: stopping the streams started above.
        unsafe {
            let _ = session.client.Stop();
            if let Some(silent) = &session.keep_alive {
                let _ = silent.Stop();
            }
        }
    }
}

#[cfg(windows)]
pub async fn list_devices() -> Vec<Device> {
    let default_id = tokio::task::spawn_blocking(imp::default_render_id).await.ok().flatten();
    super::volume::list().await.into_iter().map(|sink| Device { is_default: default_id.as_deref() == Some(sink.id.as_str()), id: sink.id, name: sink.name }).collect()
}

/// Starts capturing `device_id` (the system default when empty). The format is known once the
/// stream is running; the PCM then arrives as interleaved chunks in that format.
#[cfg(windows)]
pub async fn start(device_id: Option<String>) -> Result<(Capture, Format, Chunks), String> {
    let (chunks_tx, chunks_rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    std::thread::spawn(move || imp::run(device_id, ready_tx, chunks_tx, thread_stop));
    let format = tokio::task::spawn_blocking(move || ready_rx.recv().map_err(|_| "Audio capture thread ended unexpectedly".to_string())?)
        .await
        .map_err(|e| e.to_string())??;
    Ok((Capture { stop }, format, chunks_rx))
}

#[cfg(not(windows))]
pub async fn list_devices() -> Vec<Device> {
    Vec::new()
}

#[cfg(not(windows))]
pub async fn start(_device_id: Option<String>) -> Result<(Capture, Format, Chunks), String> {
    Err("Audio sink hosting is only available on Windows".to_string())
}
