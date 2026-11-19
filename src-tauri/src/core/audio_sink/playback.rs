// Native playback of a received stream (a phone's audio sink or microphone) through a WASAPI
// shared-mode render client, on a thread of its own registered with MMCSS as "Pro Audio" and woken
// by the engine's event each period.
//
// Audio arrives from the network in 10 ms packets with jitter, so it passes through a small adaptive
// buffer: playback starts once START_BUFFER_MS is queued, the target grows a step each time the
// buffer runs dry, gives a step back after SHRINK_AFTER_MS without running dry, and a backlog more
// than BACKLOG_SLACK_MS above the target is dropped (the stream arrives as fast as it plays, so a
// backlog left by a burst would otherwise never drain).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

const START_BUFFER_MS: u32 = 30;
const MAX_BUFFER_MS: u32 = 120;
const GROW_STEP_MS: u32 = 15;
const SHRINK_AFTER_MS: u32 = 15_000;
const BACKLOG_SLACK_MS: u32 = 60;
// The most audio ever held; anything older is stale by the time it could play.
const CAPACITY_MS: u32 = 2_000;

/// Where and how loud one service plays, changed from the UI at any time. A running player picks a
/// new volume up on its next period and reopens its endpoint when the device changes.
pub struct OutputSettings {
    volume_bits: AtomicU32,
    device: Mutex<Option<String>>,
    generation: AtomicU32,
}

impl Default for OutputSettings {
    fn default() -> Self {
        Self { volume_bits: AtomicU32::new(1.0f32.to_bits()), device: Mutex::new(None), generation: AtomicU32::new(0) }
    }
}

impl OutputSettings {
    pub fn set_volume(&self, volume: f32) {
        let volume = if volume.is_finite() { volume.clamp(0.0, 4.0) } else { 1.0 };
        self.volume_bits.store(volume.to_bits(), Ordering::Relaxed);
    }

    fn volume(&self) -> f32 {
        f32::from_bits(self.volume_bits.load(Ordering::Relaxed))
    }

    /// An empty or missing id follows the system default output.
    pub fn set_device(&self, id: Option<String>) {
        if let Ok(mut device) = self.device.lock() {
            *device = id.filter(|i| !i.is_empty());
        }
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    fn device(&self) -> Option<String> {
        self.device.lock().ok().and_then(|d| d.clone())
    }
}

/// The adaptive buffer between the network and the render thread, in interleaved f32 samples.
pub(crate) struct Jitter {
    channels: usize,
    queue: VecDeque<f32>,
    capacity: usize,
    min_target: usize,
    max_target: usize,
    step: usize,
    slack: usize,
    shrink_after: usize,
    // In frames.
    target: usize,
    calm: usize,
    playing: bool,
}

impl Jitter {
    pub(crate) fn new(sample_rate: u32, channels: usize) -> Self {
        let frames = |ms: u32| (sample_rate as u64 * ms as u64 / 1000) as usize;
        let channels = channels.max(1);
        Self {
            channels,
            queue: VecDeque::with_capacity(frames(MAX_BUFFER_MS + BACKLOG_SLACK_MS) * channels),
            capacity: frames(CAPACITY_MS) * channels,
            min_target: frames(START_BUFFER_MS),
            max_target: frames(MAX_BUFFER_MS),
            step: frames(GROW_STEP_MS),
            slack: frames(BACKLOG_SLACK_MS),
            shrink_after: frames(SHRINK_AFTER_MS),
            target: frames(START_BUFFER_MS),
            calm: 0,
            playing: false,
        }
    }

    fn queued_frames(&self) -> usize {
        self.queue.len() / self.channels
    }

    pub(crate) fn push(&mut self, samples: &[i16]) {
        let whole = samples.len() - samples.len() % self.channels;
        self.queue.extend(samples[..whole].iter().map(|&s| s as f32 / 32768.0));
        if self.queue.len() > self.capacity {
            let excess = self.queue.len() - self.capacity;
            self.queue.drain(..excess);
        }
        let queued = self.queued_frames();
        if queued > self.target + self.slack {
            self.queue.drain(..(queued - self.target) * self.channels);
        }
    }

    /// Fills `out` (interleaved, a whole number of frames) with the next audio at `gain`, or with
    /// silence while the buffer is refilling.
    pub(crate) fn pull(&mut self, out: &mut [f32], gain: f32) {
        let channels = self.channels;
        if !self.playing && self.queued_frames() >= self.target {
            self.playing = true;
        }
        let mut written = 0;
        if self.playing {
            let wanted = out.len() / channels;
            let available = self.queued_frames();
            let frames = wanted.min(available);
            for (slot, sample) in out[..frames * channels].iter_mut().zip(self.queue.drain(..frames * channels)) {
                *slot = (sample * gain).clamp(-1.0, 1.0);
            }
            written = frames * channels;
            if frames < wanted {
                // Ran dry: wait for a fuller buffer than before, so the next stall is covered.
                self.playing = false;
                self.calm = 0;
                self.target = (self.target + self.step).min(self.max_target);
            } else {
                self.calm += frames;
                if self.calm >= self.shrink_after && self.target > self.min_target {
                    self.calm = 0;
                    self.target = self.target.saturating_sub(self.step).max(self.min_target);
                }
            }
        }
        out[written..].fill(0.0);
    }
}

struct Shared {
    settings: Arc<OutputSettings>,
    jitter: Mutex<Jitter>,
    stop: AtomicBool,
    sample_rate: u32,
    channels: u16,
}

/// Plays until dropped.
pub struct Player {
    shared: Arc<Shared>,
}

impl Player {
    pub fn start(settings: Arc<OutputSettings>, sample_rate: u32, channels: u16) -> Self {
        let channels = channels.clamp(1, 8);
        let shared = Arc::new(Shared { settings, jitter: Mutex::new(Jitter::new(sample_rate, channels as usize)), stop: AtomicBool::new(false), sample_rate, channels });
        let thread_shared = shared.clone();
        let spawned = std::thread::Builder::new().name("link-audio-out".into()).spawn(move || imp::run(&thread_shared));
        if let Err(e) = spawned {
            log::warn!("Audio playback thread could not start: {}", e);
        }
        Self { shared }
    }

    /// Queues decoded interleaved 16-bit samples.
    pub fn push(&self, samples: &[i16]) {
        if let Ok(mut jitter) = self.shared.jitter.lock() {
            jitter.push(samples);
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    use windows::core::Result;
    use windows::Win32::Media::Audio::{IAudioRenderClient, AUDCLNT_SHAREMODE_SHARED};

    use super::Shared;
    use crate::core::plugins::loopback::imp::{activate, default_render_id, float_format, open_device, Event, ProAudioThread, STREAMFLAGS_EVENT_CONVERTED};

    // Bounds how long a stop or a device change takes to be noticed; the engine's event normally
    // wakes the thread every period (10 ms).
    const EVENT_WAIT_MS: u32 = 50;
    // How often a player that follows the system default checks whether the default changed.
    const DEFAULT_CHECK: Duration = Duration::from_secs(1);
    const REOPEN_DELAY: Duration = Duration::from_millis(500);

    enum Exit {
        Stopped,
        Reopen,
    }

    pub(super) fn run(shared: &Shared) {
        // Not having it is only a scheduling hint lost, never a reason to fail playback.
        let _pro_audio = ProAudioThread::register();
        while !shared.stop.load(Ordering::Relaxed) {
            match play(shared) {
                Ok(Exit::Stopped) => break,
                Ok(Exit::Reopen) => {}
                // A device unplugged or disabled mid-stream lands here: the selected device (or the
                // new default) is opened again shortly.
                Err(e) => {
                    log::warn!("Audio playback: {}; reopening the output", e);
                    std::thread::sleep(REOPEN_DELAY);
                }
            }
        }
    }

    /// Plays on one endpoint until stopped, until the device selection or the default changes, or
    /// until the endpoint fails.
    fn play(shared: &Shared) -> Result<Exit> {
        let generation = shared.settings.generation.load(Ordering::Relaxed);
        let selected = shared.settings.device();
        let device = open_device(selected.as_deref())?;
        // SAFETY: GetId on a live device; the string is freed exactly once.
        let opened_id = unsafe {
            let id = device.GetId()?;
            let text = id.to_string().ok();
            windows::Win32::System::Com::CoTaskMemFree(Some(id.0 as _));
            text
        };
        let follows_default = selected.is_none() || selected != opened_id;

        let client = activate(&device)?;
        let format = float_format(shared.sample_rate, shared.channels);
        let ready = Event::new().ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        // SAFETY: `format` is complete and outlives the call. A zero buffer duration asks for the
        // smallest buffer the engine allows in event mode. The event outlives the stream: it is
        // dropped after `client`, which is stopped first.
        let (buffer_frames, render) = unsafe {
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, STREAMFLAGS_EVENT_CONVERTED, 0, 0, &format, None)?;
            client.SetEventHandle(ready.handle())?;
            (client.GetBufferSize()?, client.GetService::<IAudioRenderClient>()?)
        };
        let channels = shared.channels as usize;
        // SAFETY: starts the initialised stream; the buffer starts out as silence.
        unsafe { client.Start()? };

        let mut last_default_check = Instant::now();
        let result = loop {
            ready.wait(EVENT_WAIT_MS);
            if shared.stop.load(Ordering::Relaxed) {
                break Ok(Exit::Stopped);
            }
            if shared.settings.generation.load(Ordering::Relaxed) != generation {
                break Ok(Exit::Reopen);
            }
            if follows_default && last_default_check.elapsed() >= DEFAULT_CHECK {
                last_default_check = Instant::now();
                if default_render_id() != opened_id {
                    break Ok(Exit::Reopen);
                }
            }
            // SAFETY: GetBuffer/ReleaseBuffer are paired; the engine's buffer holds exactly
            // `available` frames of `channels` f32 samples while it is held.
            let filled = unsafe {
                (|| -> Result<()> {
                    let padding = client.GetCurrentPadding()?;
                    let available = buffer_frames.saturating_sub(padding);
                    if available == 0 {
                        return Ok(());
                    }
                    let data = render.GetBuffer(available)?;
                    let out = std::slice::from_raw_parts_mut(data as *mut f32, available as usize * channels);
                    let gain = shared.settings.volume();
                    match shared.jitter.lock() {
                        Ok(mut jitter) => jitter.pull(out, gain),
                        Err(_) => out.fill(0.0),
                    }
                    render.ReleaseBuffer(available, 0)
                })()
            };
            if let Err(e) = filled {
                break Err(e);
            }
        };
        // SAFETY: stops the stream started above.
        unsafe {
            let _ = client.Stop();
        }
        result
    }

    /// Opens `device_id` (or the default) and plays `duration` of silence through the same path a
    /// stream uses. Used by an ignored test that needs a real audio device.
    #[cfg(test)]
    pub(super) fn play_silence(device_id: Option<&str>, duration: Duration) -> Result<()> {
        let device = open_device(device_id)?;
        let client = activate(&device)?;
        let format = float_format(48_000, 2);
        let ready = Event::new().ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        // SAFETY: as in `play`.
        unsafe {
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, STREAMFLAGS_EVENT_CONVERTED, 0, 0, &format, None)?;
            client.SetEventHandle(ready.handle())?;
            let buffer_frames = client.GetBufferSize()?;
            let render = client.GetService::<IAudioRenderClient>()?;
            client.Start()?;
            let started = Instant::now();
            let mut jitter = super::Jitter::new(48_000, 2);
            while started.elapsed() < duration {
                ready.wait(EVENT_WAIT_MS);
                let available = buffer_frames - client.GetCurrentPadding()?;
                if available == 0 {
                    continue;
                }
                let data = render.GetBuffer(available)?;
                let out = std::slice::from_raw_parts_mut(data as *mut f32, available as usize * 2);
                jitter.pull(out, 1.0);
                render.ReleaseBuffer(available, 0)?;
            }
            client.Stop()?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub(super) fn run(_shared: &super::Shared) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const FRAMES_10MS: usize = 480;

    fn ten_ms(value: i16) -> Vec<i16> {
        vec![value; FRAMES_10MS * 2]
    }

    #[test]
    fn playback_waits_for_the_start_buffer_then_plays() {
        let mut jitter = Jitter::new(RATE, 2);
        let mut out = vec![1.0f32; FRAMES_10MS * 2];
        jitter.push(&ten_ms(1000));
        jitter.push(&ten_ms(1000));
        jitter.pull(&mut out, 1.0);
        assert!(out.iter().all(|&s| s == 0.0), "20 ms queued is under the 30 ms start buffer");
        jitter.push(&ten_ms(1000));
        jitter.pull(&mut out, 1.0);
        assert!(out.iter().all(|&s| (s - 1000.0 / 32768.0).abs() < 1e-6));
    }

    #[test]
    fn an_underrun_grows_the_target_and_a_calm_stretch_shrinks_it() {
        let mut jitter = Jitter::new(RATE, 2);
        let start = jitter.target;
        for _ in 0..3 {
            jitter.push(&ten_ms(1));
        }
        let mut out = vec![0f32; FRAMES_10MS * 2];
        for _ in 0..4 {
            jitter.pull(&mut out, 1.0);
        }
        assert_eq!(jitter.target, start + jitter.step, "running dry adds one step");
        // Fifteen calm seconds give the step back.
        let mut fed = 0;
        while fed < SHRINK_AFTER_MS / 10 + 10 {
            jitter.push(&ten_ms(1));
            if jitter.playing || jitter.queued_frames() >= jitter.target {
                jitter.pull(&mut out, 1.0);
            }
            fed += 1;
        }
        assert_eq!(jitter.target, start);
    }

    #[test]
    fn a_backlog_beyond_the_slack_is_dropped_to_the_target() {
        let mut jitter = Jitter::new(RATE, 2);
        for _ in 0..20 {
            jitter.push(&ten_ms(1));
        }
        assert!(jitter.queued_frames() <= jitter.target + jitter.slack);
    }

    #[test]
    fn volume_scales_and_clips() {
        let mut jitter = Jitter::new(RATE, 1);
        jitter.push(&vec![16384i16; FRAMES_10MS * 4]);
        let mut out = vec![0f32; 4];
        jitter.pull(&mut out, 3.0);
        assert!(out.iter().all(|&s| s == 1.0));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a real audio output device"]
    fn the_default_render_endpoint_plays_200_ms_of_silence() {
        imp::play_silence(None, std::time::Duration::from_millis(200)).expect("the default output plays");
    }
}
