// Capture of the audio Windows is playing through a render endpoint (WASAPI loopback), for the
// audio sink. COM objects stay on one dedicated thread (registered with MMCSS as "Pro Audio" and
// woken by the engine's event); the PCM they produce is handed to async code through a channel.
//
// The stream is always opened as 48 kHz stereo 32-bit float, whatever the mixer runs at: the
// engine's converter (AUTOCONVERTPCM) resamples and down-mixes, which every Windows 10+ engine does
// for shared-mode streams, including loopback. Opus takes that format directly, and the phone's
// low-latency output path runs at 48 kHz natively.

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

/// What every capture delivers (see the top of this file).
pub const CAPTURE_FORMAT: Format = Format { sample_rate: 48_000, channels: 2, bits_per_sample: 32, is_float: true };

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
pub(crate) mod imp {
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc as std_mpsc, Arc};
    use std::time::Duration;

    use tokio::sync::mpsc;
    use windows::core::{Result, PCWSTR};
    use windows::Win32::Media::Audio::{eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, AUDCLNT_SHAREMODE_SHARED, WAVEFORMATEX};
    use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

    use super::{Format, CAPTURE_FORMAT};
    use crate::core::plugins::volume::enumerator;

    const STREAMFLAGS_LOOPBACK: u32 = 0x0002_0000;
    const STREAMFLAGS_EVENTCALLBACK: u32 = 0x0004_0000;
    const STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x0800_0000;
    const STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x8000_0000;
    /// A stream in our own format, converted by the engine to and from its mix format.
    pub(crate) const STREAMFLAGS_CONVERTED: u32 = STREAMFLAGS_AUTOCONVERTPCM | STREAMFLAGS_SRC_DEFAULT_QUALITY;
    pub(crate) const STREAMFLAGS_EVENT_CONVERTED: u32 = STREAMFLAGS_CONVERTED | STREAMFLAGS_EVENTCALLBACK;
    // Longest wait for the engine's event before `stop` is looked at again. The engine signals every
    // period (10 ms) while it runs, so this only bounds how long a stop takes.
    const EVENT_WAIT_MS: u32 = 20;
    const BUFFERFLAGS_SILENT: u32 = 0x2;
    // 20 ms: enough for the engine to hand over a period at a time without adding latency.
    const BUFFER_100NS: i64 = 200_000;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;

    /// Interleaved 32-bit float at `rate` and `channels`.
    pub(crate) fn float_format(rate: u32, channels: u16) -> WAVEFORMATEX {
        let block = channels * 4;
        WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: channels,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * block as u32,
            nBlockAlign: block,
            wBitsPerSample: 32,
            cbSize: 0,
        }
    }

    pub fn default_render_id() -> Option<String> {
        // SAFETY: plain COM calls on a live device; the returned id string is freed exactly once.
        unsafe {
            let id = enumerator().ok()?.GetDefaultAudioEndpoint(eRender, eConsole).ok()?.GetId().ok()?;
            let text = id.to_string().ok();
            CoTaskMemFree(Some(id.0 as _));
            text
        }
    }

    /// The render endpoint `id`, or the system default when it is empty or no longer exists.
    pub(crate) fn open_device(id: Option<&str>) -> Result<IMMDevice> {
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

    /// A Win32 auto-reset event, closed on drop.
    pub(crate) struct Event(pub(crate) windows_sys::Win32::Foundation::HANDLE);

    impl Event {
        pub(crate) fn new() -> Option<Self> {
            // SAFETY: plain Win32 call; a null handle (failure) is never wrapped.
            let handle = unsafe { windows_sys::Win32::System::Threading::CreateEventW(ptr::null(), 0, 0, ptr::null()) };
            (!handle.is_null()).then_some(Self(handle))
        }

        /// Waits up to `ms` for the event.
        pub(crate) fn wait(&self, ms: u32) {
            // SAFETY: waiting on an event this value owns.
            unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, ms) };
        }

        pub(crate) fn handle(&self) -> windows::Win32::Foundation::HANDLE {
            windows::Win32::Foundation::HANDLE(self.0)
        }
    }

    impl Drop for Event {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateEventW and is closed exactly once, here.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
        }
    }

    pub(crate) fn activate(device: &IMMDevice) -> Result<IAudioClient> {
        // SAFETY: activating a standard interface on a live device.
        unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) }
    }

    struct Session {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        // A silent stream on the same endpoint: loopback delivers nothing while nothing renders.
        keep_alive: Option<IAudioClient>,
        // Signalled by the engine each time a period of audio is ready. Declared after the clients,
        // so it is closed only once they are released.
        ready: Event,
    }

    fn open_session(device_id: Option<&str>) -> Result<Session> {
        let device = open_device(device_id)?;
        let format = float_format(CAPTURE_FORMAT.sample_rate, CAPTURE_FORMAT.channels);
        let client = activate(&device)?;
        let ready = Event::new().ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        // SAFETY: `format` is complete and outlives the call; the event outlives the stream (both
        // are owned by the Session, and the stream is stopped before the Session is dropped).
        unsafe {
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, STREAMFLAGS_LOOPBACK | STREAMFLAGS_EVENT_CONVERTED, BUFFER_100NS, 0, &format, None)?;
            client.SetEventHandle(ready.handle())?;
        }
        let keep_alive = activate(&device).ok().and_then(|silent| {
            // SAFETY: as above; a render stream that is never written plays silence.
            unsafe {
                silent.Initialize(AUDCLNT_SHAREMODE_SHARED, STREAMFLAGS_CONVERTED, BUFFER_100NS, 0, &format, None).ok()?;
                silent.Start().ok()?;
            }
            Some(silent)
        });
        // SAFETY: the client is initialised for loopback capture.
        let capture = unsafe { client.GetService::<IAudioCaptureClient>()? };
        Ok(Session { client, capture, keep_alive, ready })
    }

    /// Registers the calling thread with the Multimedia Class Scheduler ("Pro Audio"), so Windows
    /// keeps scheduling it on time while the rest of the machine is busy; undone on drop.
    pub(crate) struct ProAudioThread(windows_sys::Win32::Foundation::HANDLE);

    impl ProAudioThread {
        pub(crate) fn register() -> Option<Self> {
            let task: Vec<u16> = "Pro Audio".encode_utf16().chain(std::iter::once(0)).collect();
            let mut index = 0u32;
            // SAFETY: `task` is NUL-terminated and outlives the call.
            let handle = unsafe { windows_sys::Win32::System::Threading::AvSetMmThreadCharacteristicsW(task.as_ptr(), &mut index) };
            (!handle.is_null()).then_some(Self(handle))
        }
    }

    impl Drop for ProAudioThread {
        fn drop(&mut self) {
            // SAFETY: reverts the registration made in `register`, on the same thread.
            unsafe { windows_sys::Win32::System::Threading::AvRevertMmThreadCharacteristics(self.0) };
        }
    }

    pub fn run(device_id: Option<String>, ready: std_mpsc::Sender<std::result::Result<Format, String>>, chunks: mpsc::UnboundedSender<Vec<u8>>, stop: Arc<AtomicBool>) {
        // Not having it is only a scheduling hint lost, never a reason to fail capture.
        let _pro_audio = ProAudioThread::register();
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
        let _ = ready.send(Ok(CAPTURE_FORMAT));

        let frame_bytes = CAPTURE_FORMAT.channels as usize * (CAPTURE_FORMAT.bits_per_sample as usize / 8);
        'capture: while !stop.load(Ordering::Relaxed) {
            session.ready.wait(EVENT_WAIT_MS);
            // Everything the engine has ready, possibly several packets after a late wake-up.
            // SAFETY: GetBuffer/ReleaseBuffer are paired, and the slice is copied before release.
            unsafe {
                while session.capture.GetNextPacketSize().unwrap_or(0) > 0 {
                    let mut data = ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    if session.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() {
                        std::thread::sleep(Duration::from_millis(10));
                        continue 'capture;
                    }
                    let length = frames as usize * frame_bytes;
                    let chunk = if flags & BUFFERFLAGS_SILENT != 0 || data.is_null() { vec![0u8; length] } else { std::slice::from_raw_parts(data, length).to_vec() };
                    let _ = session.capture.ReleaseBuffer(frames);
                    if length > 0 && chunks.send(chunk).is_err() {
                        break 'capture;
                    }
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

/// Starts capturing `device_id` (the system default when empty). The PCM arrives as interleaved
/// chunks in CAPTURE_FORMAT, which is also returned for callers that check it.
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

#[cfg(all(test, windows))]
mod tests {
    /// The converted (48 kHz stereo float), event-driven loopback stream opens on this machine's
    /// default output and delivers audio, silent or not, while it runs.
    #[test]
    #[ignore = "needs a real audio output device"]
    fn loopback_capture_delivers_48_khz_stereo_float() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let (capture, format, mut chunks) = super::start(None).await.expect("loopback capture starts");
            assert_eq!((format.sample_rate, format.channels, format.bits_per_sample, format.is_float), (48_000, 2, 32, true));
            let mut bytes = 0;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(300);
            while let Ok(Some(chunk)) = tokio::time::timeout_at(deadline, chunks.recv()).await {
                bytes += chunk.len();
            }
            drop(capture);
            // About 300 ms at 384 kB/s; at least a third of it allows for a slow start.
            assert!(bytes > 38_000, "only {bytes} bytes captured");
        });
    }
}
