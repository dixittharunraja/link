// Grabs a monitor for streaming (remote control, extended screens and the guest remote control).
//
// The picture comes from DXGI Desktop Duplication: the GPU tells us the moment the screen changes and
// hands over the new image, so a frame is on its way within a millisecond or two of the change
// instead of waiting for the next tick of a timer, and an unchanged screen costs nothing. Every
// supported Windows (10 and later) has it.
//
// A monitor is captured once however many sessions show it (a guest and a paired phone, or two
// phones on the main screen): the first session to ask for it starts a capture thread (a hub), every
// session subscribes to it, and the thread ends when the last one leaves. Windows lets one process
// duplicate an output only so many times, and capturing twice would cost twice anyway.
//
// The picture is kept in one BGRA buffer, the GPU's own byte order, from one frame to the next. DXGI
// says which parts of the desktop changed, so only those are copied out of the GPU's texture, and the
// mouse pointer is drawn into the buffer with the pixels under it saved, so moving it only touches
// the pointer's own small square. Each frame also says which rows changed since the subscriber took
// its previous one, so its encoder's colour conversion can skip the rest.

use std::collections::VecDeque;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use crate::core::cursor;
use crate::core::rtc_share::{pick_monitor, Display};

/// The most pictures a second a monitor is captured at.
const HUB_FRAME_RATE: f32 = 60.0;
/// How long the capture thread waits for the screen to change before it checks whether anyone is
/// still watching.
const HUB_WAIT: Duration = Duration::from_millis(50);
/// How many pictures' changed rows the hub remembers. A subscriber further behind than this gets the
/// whole picture as changed.
const HUB_HISTORY: usize = 64;
/// How long the monitor that was looked up is trusted while it is not being duplicated. Looking a
/// monitor up enumerates every display, which is too slow to do for every frame; while DXGI
/// duplicates it, a monitor that goes away shows up as an error instead, so it is not looked up at all.
const MONITOR_RECHECK: Duration = Duration::from_secs(1);
/// After DXGI could not open a monitor, how long before it is tried again.
const REOPEN_AFTER_FAILURE: Duration = Duration::from_secs(2);
/// After a duplication was interrupted (usually a display mode change), how long before reopening.
const REOPEN_AFTER_INTERRUPTION: Duration = Duration::from_millis(200);

/// The current picture of the monitor, mouse pointer included.
pub struct Frame<'a> {
    /// `width * height * 4` bytes, blue, green, red and an unused byte per pixel, rows top-down.
    pub bgra: &'a [u8],
    pub width: u32,
    pub height: u32,
    /// The rows that changed since the previous frame was taken. Every row after the size changed.
    pub changed: Range<u32>,
}

/// What waiting for the screen gave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// The picture changed; the frame has it.
    Fresh,
    /// Nothing changed in the time waited.
    Idle,
    /// There is no such monitor right now.
    Missing,
}

/// The smallest range covering both.
fn union(a: Option<Range<u32>>, b: Option<Range<u32>>) -> Option<Range<u32>> {
    match (a, b) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => Some(a.start.min(b.start)..a.end.max(b.end)),
        (Some(a), Some(b)) => Some(if a.is_empty() { b } else { a }),
        (a, b) => a.or(b),
    }
}

// ---- the shared capture of one monitor ----

/// Which monitor a hub captures: the main one, or the extra monitor with this id.
type Key = (Display, u32);

fn key(display: Display, screen: u32) -> Key {
    match display {
        Display::Primary => (Display::Primary, 0),
        Display::Extended => (Display::Extended, screen),
    }
}

/// The newest picture of a monitor, as every subscriber sees it.
#[derive(Default)]
struct Picture {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
    /// Counts the pictures published; 0 before the first.
    seq: u64,
    /// The rows each of the latest pictures changed, oldest first.
    history: VecDeque<(u64, Range<u32>)>,
}

impl Picture {
    /// The rows changed since picture `seen` (which the subscriber already has).
    fn changed_since(&self, seen: u64) -> Range<u32> {
        if seen >= self.seq {
            return 0..0;
        }
        match self.history.front() {
            Some((oldest, _)) if *oldest <= seen + 1 => {
                self.history.iter().filter(|(seq, _)| *seq > seen).fold(0..0, |all, (_, rows)| union(Some(all), Some(rows.clone())).unwrap_or(0..0))
            }
            _ => 0..self.height,
        }
    }

    /// Takes in a new picture from the capturer; false when nothing in it changed.
    fn publish(&mut self, frame: Frame<'_>) -> bool {
        let resized = (self.width, self.height) != (frame.width, frame.height) || self.bgra.len() != frame.bgra.len();
        let rows = if resized {
            self.bgra.clear();
            self.bgra.extend_from_slice(frame.bgra);
            (self.width, self.height) = (frame.width, frame.height);
            self.history.clear();
            0..frame.height
        } else {
            let row_bytes = frame.width as usize * 4;
            let rows = frame.changed.start.min(frame.height)..frame.changed.end.min(frame.height);
            let bytes = rows.start as usize * row_bytes..rows.end as usize * row_bytes;
            self.bgra[bytes.clone()].copy_from_slice(&frame.bgra[bytes]);
            rows
        };
        if rows.is_empty() {
            return false;
        }
        self.seq += 1;
        self.history.push_back((self.seq, rows));
        if self.history.len() > HUB_HISTORY {
            self.history.pop_front();
        }
        true
    }
}

struct Hub {
    picture: RwLock<Picture>,
    /// The newest picture's `seq`, signalled through `news` whenever it changes.
    latest: Mutex<u64>,
    news: Condvar,
    /// The monitor could not be found the last time the capture thread looked.
    missing: AtomicBool,
}

/// Every running hub. Weak, so a hub goes away with its last subscriber.
static HUBS: Mutex<Vec<(Key, Weak<Hub>)>> = Mutex::new(Vec::new());

/// The hub capturing this monitor, started if nobody is watching it yet.
fn join_hub(key: Key) -> Option<Arc<Hub>> {
    let mut hubs = HUBS.lock().ok()?;
    if let Some(hub) = hubs.iter().find(|(k, _)| *k == key).and_then(|(_, hub)| hub.upgrade()) {
        return Some(hub);
    }
    hubs.retain(|(_, hub)| hub.strong_count() > 0);
    let hub = Arc::new(Hub { picture: RwLock::default(), latest: Mutex::new(0), news: Condvar::new(), missing: AtomicBool::new(false) });
    let worker = hub.clone();
    let name = match key.0 {
        Display::Primary => "capture-hub".to_string(),
        Display::Extended => format!("capture-hub-{}", key.1),
    };
    if let Err(e) = std::thread::Builder::new().name(name).spawn(move || run_hub(worker, key)) {
        log::warn!("[RemoteControl] could not start capturing the screen: {e}");
        return None;
    }
    hubs.push((key, Arc::downgrade(&hub)));
    Some(hub)
}

/// True, and the hub is unregistered, once nobody but its own thread holds it. Checked under the
/// registry's lock, so a newcomer either finds the hub still running or starts a new one.
fn hub_abandoned(hub: &Arc<Hub>) -> bool {
    let Ok(mut hubs) = HUBS.lock() else { return true };
    if Arc::strong_count(hub) > 1 {
        return false;
    }
    hubs.retain(|(_, h)| !std::ptr::eq(h.as_ptr(), Arc::as_ptr(hub)));
    true
}

/// The capture thread of one hub: captures until the last subscriber is gone.
fn run_hub(hub: Arc<Hub>, (display, screen): Key) {
    let mut capturer = Capturer::new(HUB_FRAME_RATE);
    while !hub_abandoned(&hub) {
        let changed = match capturer.next(display, screen, HUB_WAIT) {
            Next::Fresh => true,
            // DXGI reports pointer moves itself; this catches a pointer that changed shape in place.
            Next::Idle => capturer.refresh(),
            Next::Missing => {
                hub.missing.store(true, Ordering::Relaxed);
                false
            }
        };
        if !changed {
            continue;
        }
        let Some(frame) = capturer.frame() else { continue };
        hub.missing.store(false, Ordering::Relaxed);
        let Ok(mut picture) = hub.picture.write() else { continue };
        if !picture.publish(frame) {
            continue;
        }
        let seq = picture.seq;
        drop(picture);
        if let Ok(mut latest) = hub.latest.lock() {
            *latest = seq;
        }
        hub.news.notify_all();
    }
}

/// One session's view of a monitor's shared capture.
#[derive(Default)]
pub struct Subscription {
    hub: Option<(Key, Arc<Hub>)>,
    /// The `seq` of the picture this subscriber last took, and that picture's size.
    seen: u64,
    seen_size: (u32, u32),
}

impl Subscription {
    /// Waits up to `wait` for the screen to change since the last frame was taken. `screen` is the
    /// id of the extra monitor an extended session shows; it may change while the session runs.
    pub fn next(&mut self, display: Display, screen: u32, wait: Duration) -> Next {
        let key = key(display, screen);
        if self.hub.as_ref().is_none_or(|(k, _)| *k != key) {
            // Another monitor: start over from its current picture.
            self.hub = join_hub(key).map(|hub| (key, hub));
            (self.seen, self.seen_size) = (0, (0, 0));
        }
        let Some((_, hub)) = self.hub.as_ref() else {
            std::thread::sleep(wait.min(Duration::from_millis(33)));
            return Next::Missing;
        };
        let Ok(latest) = hub.latest.lock() else { return Next::Missing };
        let seen = self.seen;
        let (latest, _) = match hub.news.wait_timeout_while(latest, wait, |latest| *latest <= seen) {
            Ok(waited) => waited,
            Err(_) => return Next::Missing,
        };
        if *latest > seen {
            Next::Fresh
        } else if hub.missing.load(Ordering::Relaxed) {
            Next::Missing
        } else {
            Next::Idle
        }
    }

    /// Hands the current picture to `use_frame`, or None before the first one. Taking it starts a
    /// new count of changed rows. The picture is only read while `use_frame` runs, alongside other
    /// subscribers reading it; the next picture waits until they are done.
    pub fn with_frame<R>(&mut self, use_frame: impl FnOnce(Frame<'_>) -> R) -> Option<R> {
        let (_, hub) = self.hub.as_ref()?;
        let picture = hub.picture.read().ok()?;
        if picture.seq == 0 {
            return None;
        }
        let size = (picture.width, picture.height);
        let changed = if size != self.seen_size { 0..picture.height } else { picture.changed_since(self.seen) };
        (self.seen, self.seen_size) = (picture.seq, size);
        Some(use_frame(Frame { bgra: &picture.bgra, width: picture.width, height: picture.height, changed }))
    }
}

// ---- capturing one monitor ----

/// The monitor a display and screen id were last looked up as.
struct Chosen {
    display: Display,
    screen: u32,
    monitor: Option<xcap::Monitor>,
    at: Instant,
}

/// Captures one monitor with DXGI, for a hub's thread.
struct Capturer {
    chosen: Option<Chosen>,
    /// The monitor's id the current duplication was opened for.
    opened_for: Option<u32>,
    #[cfg(windows)]
    dxgi: Option<dxgi::Duplication>,
    /// Do not open a duplication again before this, after one failed or was interrupted.
    retry_at: Instant,
    /// The picture, pointer included, in BGRA.
    image: Vec<u8>,
    width: u32,
    height: u32,
    has_picture: bool,
    /// The buffer holds what the open duplication last copied, so its next picture can be copied in
    /// by the changed parts only. False after (re)opening, when the next one is copied whole.
    current: bool,
    /// Rows changed since the last [`Self::frame`].
    changed: Option<Range<u32>>,
    pointer: cursor::Drawn,
    origin: (i32, i32),
    last_output: Instant,
    min_interval: Duration,
}

impl Capturer {
    fn new(max_frame_rate: f32) -> Self {
        Self {
            chosen: None,
            opened_for: None,
            #[cfg(windows)]
            dxgi: None,
            retry_at: Instant::now(),
            image: Vec::new(),
            width: 0,
            height: 0,
            has_picture: false,
            current: false,
            changed: None,
            pointer: cursor::Drawn::default(),
            origin: (0, 0),
            last_output: Instant::now() - Duration::from_secs(1),
            min_interval: Duration::from_secs_f32(1.0 / max_frame_rate),
        }
    }

    /// Redraws the pointer where it is now, if it moved; true when that changed the picture.
    fn refresh(&mut self) -> bool {
        if !self.has_picture {
            return false;
        }
        let now = cursor::current();
        if self.pointer.shows(now) {
            return false;
        }
        let erased = self.pointer.erase(&mut self.image, self.width);
        let drawn = self.pointer.draw(&mut self.image, self.width, self.height, self.origin, now);
        self.changed = union(self.changed.take(), union(erased, drawn));
        self.last_output = Instant::now();
        true
    }

    /// The current picture, or None before the first one. Taking it starts a new count of changed rows.
    fn frame(&mut self) -> Option<Frame<'_>> {
        if !self.has_picture {
            return None;
        }
        let changed = self.changed.take().unwrap_or(0..0);
        Some(Frame { bgra: &self.image, width: self.width, height: self.height, changed })
    }

    /// The monitor to capture, looked up again only when the request changed, or now and then while
    /// it is not being duplicated (see [`MONITOR_RECHECK`]).
    fn monitor(&mut self, display: Display, screen: u32) -> Option<xcap::Monitor> {
        #[cfg(windows)]
        let duplicating = self.dxgi.is_some();
        #[cfg(not(windows))]
        let duplicating = false;
        let reusable = self
            .chosen
            .as_ref()
            .is_some_and(|c| c.display == display && c.screen == screen && (duplicating || c.at.elapsed() < MONITOR_RECHECK));
        if !reusable {
            self.chosen = Some(Chosen { display, screen, monitor: pick_monitor(display, screen), at: Instant::now() });
        }
        self.chosen.as_ref().and_then(|c| c.monitor.clone())
    }

    fn pace(&mut self) {
        let since = self.last_output.elapsed();
        if since < self.min_interval {
            std::thread::sleep(self.min_interval - since);
        }
    }

    /// The buffer was rewritten (`rows` of it, or all after a resize): put the pointer back on top.
    fn after_new_picture(&mut self, rows: Option<Range<u32>>) {
        let drawn = self.pointer.draw(&mut self.image, self.width, self.height, self.origin, cursor::current());
        self.changed = union(self.changed.take(), union(rows, drawn));
        self.has_picture = true;
        self.last_output = Instant::now();
    }

    /// Waits up to `wait` for the screen to change.
    #[cfg(not(windows))]
    fn next(&mut self, _display: Display, _screen: u32, wait: Duration) -> Next {
        std::thread::sleep(wait);
        Next::Missing
    }

    /// Waits up to `wait` for the screen to change.
    #[cfg(windows)]
    fn next(&mut self, display: Display, screen: u32, wait: Duration) -> Next {
        let id = self.monitor(display, screen).and_then(|m| m.id().ok());
        if self.opened_for != id {
            // Another monitor (or none): the old duplication is of no use.
            self.dxgi = None;
            self.opened_for = id;
        }
        let Some(id) = id else {
            std::thread::sleep(wait.min(Duration::from_millis(33)));
            return Next::Missing;
        };
        if self.dxgi.is_none() {
            let now = Instant::now();
            if now < self.retry_at {
                std::thread::sleep(wait.min(self.retry_at - now));
                return Next::Idle;
            }
            match dxgi::Duplication::open(id) {
                Ok(d) => {
                    log::info!("[RemoteControl] capturing monitor {id} with DXGI ({}x{})", d.width, d.height);
                    self.origin = d.origin;
                    self.dxgi = Some(d);
                    // The first picture of a new duplication is the whole desktop, still or not.
                    self.current = false;
                    self.pointer.forget();
                }
                Err(reason) => {
                    // Possible for a moment while the desktop switches (a UAC prompt, the lock
                    // screen, a display mode change); nothing else can capture those either.
                    log::info!("[RemoteControl] cannot capture monitor {id} yet ({reason}); retrying");
                    self.retry_at = now + REOPEN_AFTER_FAILURE;
                    std::thread::sleep(wait.min(REOPEN_AFTER_FAILURE));
                    return Next::Idle;
                }
            }
        }
        self.pace();
        let Some(duplication) = self.dxgi.as_mut() else { return Next::Idle };
        let outcome = match duplication.wait(wait) {
            Ok(dxgi::Waited::Idle) => return Next::Idle,
            Ok(dxgi::Waited::PointerOnly) => return if self.refresh() { Next::Fresh } else { Next::Idle },
            Ok(dxgi::Waited::Picture) => {
                // The pointer comes out first, so the parts that did not change are left clean.
                let erased = self.pointer.erase(&mut self.image, self.width);
                let whole = !self.current;
                duplication.copy_picture(&mut self.image, whole).map(|(width, height, rows)| (erased, width, height, rows))
            }
            Err(reason) => Err(reason),
        };
        match outcome {
            Ok((erased, width, height, rows)) => {
                if (width, height) != (self.width, self.height) {
                    (self.width, self.height) = (width, height);
                    self.changed = Some(0..height);
                }
                self.current = true;
                self.after_new_picture(union(erased, Some(rows)));
                Next::Fresh
            }
            Err(reason) => {
                // Usually the display mode changed (another phone's monitor came or went): open it
                // again shortly. Viewers keep the last picture meanwhile.
                log::info!("[RemoteControl] DXGI capture of monitor {id} was interrupted ({reason}); reopening");
                self.dxgi = None;
                self.chosen = None;
                self.current = false;
                // The buffer may hold the pointer's pixels erased above but not redrawn.
                self.pointer.forget();
                self.retry_at = Instant::now() + REOPEN_AFTER_INTERRUPTION;
                Next::Idle
            }
        }
    }
}

#[cfg(windows)]
mod dxgi {
    use std::ops::Range;
    use std::time::Duration;

    use windows::core::Interface;
    use windows::Win32::Foundation::{HMODULE, RECT};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_MODE_ROTATION_ROTATE180, DXGI_MODE_ROTATION_ROTATE270, DXGI_MODE_ROTATION_ROTATE90};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
        DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_MOVE_RECT,
    };

    pub enum Waited {
        /// Nothing happened within the wait.
        Idle,
        /// Only the mouse pointer moved.
        PointerOnly,
        /// The desktop changed; call [`Duplication::copy_picture`] to have it.
        Picture,
    }

    pub struct Duplication {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        duplication: IDXGIOutputDuplication,
        staging: Option<(ID3D11Texture2D, u32, u32)>,
        /// The frame acquired by the last wait and not released yet, and the size of its list of
        /// changed areas.
        held: Option<(IDXGIResource, u32)>,
        /// No frame acquired yet: the first one is the whole desktop, whether or not it changed.
        first: bool,
        /// Clockwise quarter turns from the GPU's picture to the desktop (a monitor turned to
        /// portrait). The GPU hands the picture over unrotated.
        turns: u8,
        pub width: u32,
        pub height: u32,
        /// Where the monitor sits on the desktop.
        pub origin: (i32, i32),
    }

    // SAFETY: the duplication is created and used on one thread at a time (it moves with the
    // capturer that owns it, never shared), and D3D11 devices made without the single-threaded flag
    // may be used from any thread.
    unsafe impl Send for Duplication {}

    impl Duplication {
        /// Duplicates the monitor whose id (its `HMONITOR`) is `monitor_id`.
        pub fn open(monitor_id: u32) -> Result<Self, String> {
            // SAFETY: plain COM calls; every returned interface is owned and released on drop.
            unsafe {
                let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| e.to_string())?;
                let mut adapter_index = 0;
                while let Ok(adapter) = factory.EnumAdapters1(adapter_index) {
                    adapter_index += 1;
                    let mut output_index = 0;
                    while let Ok(output) = adapter.EnumOutputs(output_index) {
                        output_index += 1;
                        let description = output.GetDesc().map_err(|e| e.to_string())?;
                        if description.Monitor.0 as usize as u32 != monitor_id {
                            continue;
                        }
                        let turns = match description.Rotation {
                            DXGI_MODE_ROTATION_ROTATE90 => 1,
                            DXGI_MODE_ROTATION_ROTATE180 => 2,
                            DXGI_MODE_ROTATION_ROTATE270 => 3,
                            _ => 0,
                        };
                        let adapter: IDXGIAdapter = adapter.cast().map_err(|e: windows::core::Error| e.to_string())?;
                        let mut device = None;
                        let mut context = None;
                        D3D11CreateDevice(
                            &adapter,
                            D3D_DRIVER_TYPE_UNKNOWN,
                            HMODULE::default(),
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            None,
                            D3D11_SDK_VERSION,
                            Some(&mut device),
                            None,
                            Some(&mut context),
                        )
                        .map_err(|e| format!("no GPU device: {e}"))?;
                        let (device, context) = (device.ok_or("no GPU device")?, context.ok_or("no GPU context")?);
                        let output1: IDXGIOutput1 = output.cast().map_err(|e: windows::core::Error| e.to_string())?;
                        let duplication = output1.DuplicateOutput(&device).map_err(|e| format!("cannot duplicate the output: {e}"))?;
                        let area = description.DesktopCoordinates;
                        return Ok(Self {
                            device,
                            context,
                            duplication,
                            staging: None,
                            held: None,
                            first: true,
                            turns,
                            width: (area.right - area.left).max(0) as u32,
                            height: (area.bottom - area.top).max(0) as u32,
                            origin: (area.left, area.top),
                        });
                    }
                }
            }
            Err("the monitor was not found on any graphics adapter".into())
        }

        fn release(&mut self) {
            if self.held.take().is_some() {
                // SAFETY: a frame is held, so releasing it is valid.
                unsafe {
                    let _ = self.duplication.ReleaseFrame();
                }
            }
        }

        /// Waits up to `wait` for the desktop to change.
        pub fn wait(&mut self, wait: Duration) -> Result<Waited, String> {
            self.release();
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            // SAFETY: `info` and `resource` outlive the call; a frame that was acquired is released
            // here or by the next wait or copy.
            unsafe {
                match self.duplication.AcquireNextFrame(wait.as_millis().min(u32::MAX as u128) as u32, &mut info, &mut resource) {
                    Ok(()) => {}
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(Waited::Idle),
                    Err(e) => return Err(e.to_string()),
                }
                let first = std::mem::replace(&mut self.first, false);
                match resource {
                    Some(resource) if info.LastPresentTime != 0 || first => {
                        self.held = Some((resource, info.TotalMetadataBufferSize));
                        Ok(Waited::Picture)
                    }
                    _ => {
                        let _ = self.duplication.ReleaseFrame();
                        if info.LastPresentTime != 0 { Err("the frame has no picture".to_string()) } else { Ok(Waited::PointerOnly) }
                    }
                }
            }
        }

        /// Copies the picture the last wait found into `dst` (BGRA, rows top-down), only the parts
        /// that changed unless `whole` (or the size changed), and releases the frame. Returns the
        /// picture's size and the rows that were copied.
        pub fn copy_picture(&mut self, dst: &mut Vec<u8>, whole: bool) -> Result<(u32, u32, Range<u32>), String> {
            // SAFETY: see read.
            let result = unsafe { self.read(dst, whole) };
            self.release();
            result
        }

        /// The changed areas of the held frame: what was redrawn, and where things were moved to.
        /// None when the list cannot be had, and everything has to be copied.
        unsafe fn changed_areas(&self, metadata_size: u32) -> Option<Vec<RECT>> {
            if metadata_size == 0 {
                return None;
            }
            // SAFETY: the buffers are sized in bytes as the calls expect and outlive them.
            unsafe {
                let mut needed = 0u32;
                let mut moves = vec![DXGI_OUTDUPL_MOVE_RECT::default(); metadata_size as usize / size_of::<DXGI_OUTDUPL_MOVE_RECT>() + 1];
                let bytes = (moves.len() * size_of::<DXGI_OUTDUPL_MOVE_RECT>()) as u32;
                self.duplication.GetFrameMoveRects(bytes, moves.as_mut_ptr(), &mut needed).ok()?;
                moves.truncate(needed as usize / size_of::<DXGI_OUTDUPL_MOVE_RECT>());
                let mut dirty = vec![RECT::default(); metadata_size as usize / size_of::<RECT>() + 1];
                let bytes = (dirty.len() * size_of::<RECT>()) as u32;
                self.duplication.GetFrameDirtyRects(bytes, dirty.as_mut_ptr(), &mut needed).ok()?;
                dirty.truncate(needed as usize / size_of::<RECT>());
                // A moved area is copied whole from the new picture, which already shows it moved.
                dirty.extend(moves.iter().map(|m| m.DestinationRect));
                Some(dirty)
            }
        }

        /// Copies the held texture into a CPU-readable one and from there into `dst`.
        unsafe fn read(&mut self, dst: &mut Vec<u8>, whole: bool) -> Result<(u32, u32, Range<u32>), String> {
            // SAFETY: all COM calls below are on interfaces this struct owns; the mapped memory is
            // only read while it is mapped, within the rows and pitch it reports.
            unsafe {
                let (resource, metadata_size) = self.held.as_ref().ok_or("no frame is held")?;
                let texture: ID3D11Texture2D = resource.cast().map_err(|e| e.to_string())?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                let (width, height) = (desc.Width, desc.Height);
                if width == 0 || height == 0 {
                    return Err("the picture is empty".into());
                }
                let reuse = matches!(&self.staging, Some((_, w, h)) if *w == width && *h == height);
                if !reuse {
                    desc.BindFlags = 0;
                    desc.MiscFlags = 0;
                    desc.Usage = D3D11_USAGE_STAGING;
                    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                    let mut staging = None;
                    self.device.CreateTexture2D(&desc, None, Some(&mut staging)).map_err(|e| e.to_string())?;
                    self.staging = Some((staging.ok_or("no staging texture")?, width, height));
                }
                let row_bytes = width as usize * 4;
                let size = row_bytes * height as usize;
                // A rotated monitor's changed areas are in the unrotated picture; it is copied whole.
                let areas = if whole || self.turns != 0 || dst.len() != size { None } else { self.changed_areas(*metadata_size) };
                let staging = &self.staging.as_ref().ok_or("no staging texture")?.0;
                let (from, to): (ID3D11Resource, ID3D11Resource) = (texture.cast().map_err(|e| e.to_string())?, staging.cast().map_err(|e| e.to_string())?);
                self.context.CopyResource(&to, &from);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.context.Map(&to, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| e.to_string())?;
                let pitch = mapped.RowPitch as usize;
                if self.turns != 0 {
                    let picture = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * (height as usize - 1) + row_bytes);
                    let (width, height) = super::rotate_into(picture, pitch, width as usize, height as usize, self.turns, dst);
                    self.context.Unmap(&to, 0);
                    (self.width, self.height) = (width, height);
                    return Ok((width, height, 0..height));
                }
                let source = |y: usize, x: usize, len: usize| std::slice::from_raw_parts((mapped.pData as *const u8).add(y * pitch + x * 4), len);
                let rows = match areas {
                    None => {
                        dst.resize(size, 0);
                        for (y, out) in dst.chunks_exact_mut(row_bytes).enumerate() {
                            out.copy_from_slice(source(y, 0, row_bytes));
                        }
                        0..height
                    }
                    Some(areas) => {
                        let mut rows: Option<Range<u32>> = None;
                        for area in areas {
                            let (left, right) = (area.left.clamp(0, width as i32) as usize, area.right.clamp(0, width as i32) as usize);
                            let (top, bottom) = (area.top.clamp(0, height as i32) as u32, area.bottom.clamp(0, height as i32) as u32);
                            if left >= right || top >= bottom {
                                continue;
                            }
                            for y in top as usize..bottom as usize {
                                let at = y * row_bytes + left * 4;
                                dst[at..at + (right - left) * 4].copy_from_slice(source(y, left, (right - left) * 4));
                            }
                            rows = Some(rows.map_or(top..bottom, |r| r.start.min(top)..r.end.max(bottom)));
                        }
                        rows.unwrap_or(0..0)
                    }
                };
                self.context.Unmap(&to, 0);
                self.width = width;
                self.height = height;
                Ok((width, height, rows))
            }
        }
    }

    impl Drop for Duplication {
        fn drop(&mut self) {
            self.release();
        }
    }
}

/// Copies a `width` x `height` BGRA picture of `pitch` bytes a row into `dst`, turned clockwise by
/// `turns` quarter turns, as the desktop of a monitor rotated that way shows it. Returns the turned
/// picture's size.
#[cfg_attr(not(windows), allow(dead_code))]
fn rotate_into(src: &[u8], pitch: usize, width: usize, height: usize, turns: u8, dst: &mut Vec<u8>) -> (u32, u32) {
    let (out_w, out_h) = if turns % 2 == 1 { (height, width) } else { (width, height) };
    dst.resize(out_w * out_h * 4, 0);
    for (y, row) in dst.chunks_exact_mut(out_w * 4).enumerate() {
        for (x, out) in row.chunks_exact_mut(4).enumerate() {
            // Where this desktop pixel is in the GPU's unrotated picture.
            let (sx, sy) = match turns % 4 {
                1 => (y, out_w - 1 - x),
                2 => (out_w - 1 - x, out_h - 1 - y),
                3 => (out_h - 1 - y, x),
                _ => (x, y),
            };
            let at = sy * pitch + sx * 4;
            out.copy_from_slice(&src[at..at + 4]);
        }
    }
    (out_w as u32, out_h as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_rows_are_merged() {
        assert_eq!(union(Some(5..9), Some(2..6)), Some(2..9));
        assert_eq!(union(None, Some(2..6)), Some(2..6));
        assert_eq!(union(Some(0..0), Some(2..6)), Some(2..6));
        assert_eq!(union(None, None), None);
    }

    fn frame(bgra: &[u8], width: u32, height: u32, changed: Range<u32>) -> Frame<'_> {
        Frame { bgra, width, height, changed }
    }

    #[test]
    fn each_subscriber_gets_the_rows_changed_since_its_own_last_picture() {
        let (w, h) = (4u32, 10u32);
        let mut screen = vec![0u8; (w * h * 4) as usize];
        let mut picture = Picture::default();
        assert!(picture.publish(frame(&screen, w, h, 0..h)), "the first picture is published whole");
        assert_eq!(picture.changed_since(0), 0..h);
        screen[(w * 4 * 2) as usize] = 9;
        assert!(picture.publish(frame(&screen, w, h, 2..3)));
        screen[(w * 4 * 7) as usize] = 9;
        assert!(picture.publish(frame(&screen, w, h, 7..8)));
        assert_eq!(picture.bgra, screen, "only the changed rows were copied, and that was enough");
        assert_eq!(picture.changed_since(2), 7..8, "a subscriber that is up to date with picture 2");
        assert_eq!(picture.changed_since(1), 2..8, "one that is a picture further behind");
        assert_eq!(picture.changed_since(3), 0..0);
        assert!(!picture.publish(frame(&screen, w, h, 0..0)), "nothing changed, nothing published");
    }

    #[test]
    fn a_subscriber_too_far_behind_gets_the_whole_picture() {
        let (w, h) = (2u32, 4u32);
        let screen = vec![0u8; (w * h * 4) as usize];
        let mut picture = Picture::default();
        for _ in 0..HUB_HISTORY + 5 {
            picture.publish(frame(&screen, w, h, 1..2));
        }
        assert_eq!(picture.changed_since(1), 0..h);
        assert_eq!(picture.changed_since(picture.seq - 1), 1..2);
    }

    #[test]
    fn a_rotated_monitor_is_turned_upright() {
        // A 3x2 picture with each pixel's first byte numbering it row by row.
        let (w, h) = (3usize, 2usize);
        let src: Vec<u8> = (0..(w * h) as u8).flat_map(|i| [i, 0, 0, 255]).collect();
        let firsts = |turns: u8| {
            let mut dst = Vec::new();
            let size = rotate_into(&src, w * 4, w, h, turns, &mut dst);
            (size, dst.chunks_exact(4).map(|p| p[0]).collect::<Vec<_>>())
        };
        // 0 1 2
        // 3 4 5
        assert_eq!(firsts(0), ((3, 2), vec![0, 1, 2, 3, 4, 5]));
        // Turned clockwise, the left column becomes the top row.
        assert_eq!(firsts(1), ((2, 3), vec![3, 0, 4, 1, 5, 2]));
        assert_eq!(firsts(2), ((3, 2), vec![5, 4, 3, 2, 1, 0]));
        assert_eq!(firsts(3), ((2, 3), vec![2, 5, 1, 4, 0, 3]));
    }

    /// Needs a desktop session with a GPU, so it only runs when asked for. Two subscribers of the
    /// main screen share one capture.
    #[test]
    #[ignore]
    fn the_primary_monitor_is_captured_once_for_two_subscribers() {
        let (mut a, mut b) = (Subscription::default(), Subscription::default());
        let started = Instant::now();
        let mut got = false;
        while !got && started.elapsed() < Duration::from_secs(5) {
            got = a.next(Display::Primary, 0, Duration::from_millis(100)) == Next::Fresh;
        }
        assert!(got, "no picture within 5 seconds");
        assert_eq!(b.next(Display::Primary, 0, Duration::from_millis(100)), Next::Fresh, "the second sees the same picture at once");
        let (width, height) = a.with_frame(|f| (f.width, f.height)).expect("a picture");
        assert!(width > 0 && height > 0);
        assert!(Arc::ptr_eq(&a.hub.as_ref().unwrap().1, &b.hub.as_ref().unwrap().1), "one capture");
        println!("captured {width}x{height}");
    }
}

/// A picture in the colour format the H.264 encoder takes (planar YUV 4:2:0), made from BGRA pixels.
/// The coefficients are the same BT.601 ones the encoder crate's own converter uses, so colours do not
/// change; this one works on whole rows with integers, split over a few threads that are kept for the
/// whole session, which is several times faster on a full HD picture, and reuses its buffers from one
/// frame to the next, so only the rows that changed need converting again.
#[derive(Default)]
pub struct I420 {
    width: usize,
    height: usize,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
    pool: Option<pool::Pool>,
}

/// Below this many pairs of rows a conversion is done on the calling thread: handing it out costs
/// more than it saves.
const PARALLEL_PAIRS: usize = 64;

impl I420 {
    /// Fills this picture from a BGRA one of `stride` bytes a row, of which the first `width` x
    /// `height` pixels are used. Both sizes must be even. `rows` names the only rows that changed
    /// since the last fill, which is honoured when the size is the same as then.
    pub fn fill(&mut self, bgra: &[u8], stride: usize, width: usize, height: usize, rows: Option<Range<usize>>) {
        debug_assert!(width % 2 == 0 && height % 2 == 0 && stride >= width * 4 && bgra.len() >= stride * (height - 1) + width * 4);
        let same_size = self.width == width && self.height == height && !self.y.is_empty();
        self.width = width;
        self.height = height;
        let half = width / 2;
        self.y.resize(width * height, 0);
        self.u.resize(half * (height / 2), 0);
        self.v.resize(half * (height / 2), 0);

        let all_pairs = height / 2;
        let pairs = match rows {
            Some(rows) if same_size => (rows.start / 2).min(all_pairs)..rows.end.div_ceil(2).min(all_pairs),
            _ => 0..all_pairs,
        };
        if pairs.is_empty() {
            return;
        }
        let count = pairs.len();
        let threads = if count < PARALLEL_PAIRS { 1 } else { std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, 4) };
        if threads > 1 && self.pool.is_none() {
            self.pool = Some(pool::Pool::new(threads - 1));
        }
        let pairs_per_band = count.div_ceil(threads).max(1);
        let y = &mut self.y[pairs.start * 2 * width..pairs.end * 2 * width];
        let u = &mut self.u[pairs.start * half..pairs.end * half];
        let v = &mut self.v[pairs.start * half..pairs.end * half];
        let source = &bgra[pairs.start * 2 * stride..];
        let bands = y
            .chunks_mut(2 * width * pairs_per_band)
            .zip(u.chunks_mut(half * pairs_per_band))
            .zip(v.chunks_mut(half * pairs_per_band))
            .enumerate()
            .map(|(i, ((y, u), v))| {
                let start = (i * pairs_per_band * 2 * stride).min(source.len());
                pool::Band { bgra: &source[start..], stride, width, y, u, v }
            });
        match self.pool.as_ref() {
            Some(pool) if threads > 1 => pool.run(bands),
            _ => bands.for_each(pool::Band::convert),
        }
    }
}

/// Worker threads for the colour conversion, started with the first frame and ended when the
/// picture that owns them is dropped, so no threads are started per frame.
mod pool {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::mpsc;

    /// A run of pairs of rows to convert.
    pub struct Band<'a> {
        pub bgra: &'a [u8],
        pub stride: usize,
        pub width: usize,
        pub y: &'a mut [u8],
        pub u: &'a mut [u8],
        pub v: &'a mut [u8],
    }

    impl Band<'_> {
        pub fn convert(self) {
            super::convert_band(self.bgra, self.stride, self.width, self.y, self.u, self.v);
        }
    }

    /// A band with its lifetime erased, to cross into a worker thread.
    struct Job {
        band: Band<'static>,
    }

    // SAFETY: a job only exists while `Pool::run` is blocked waiting for it to finish, so the memory
    // its band points into stays borrowed (and untouched by anyone else) for as long as it is used.
    unsafe impl Send for Job {}

    pub struct Pool {
        workers: Vec<mpsc::Sender<Job>>,
        done: mpsc::Receiver<()>,
    }

    impl Pool {
        pub fn new(workers: usize) -> Self {
            let (done_tx, done) = mpsc::channel();
            let workers = (0..workers)
                .filter_map(|i| {
                    let (tx, rx) = mpsc::channel::<Job>();
                    let done = done_tx.clone();
                    std::thread::Builder::new()
                        .name(format!("screen-convert-{i}"))
                        .spawn(move || {
                            while let Ok(job) = rx.recv() {
                                // Finished is reported even if the conversion panicked, or the
                                // frame waiting for it would wait forever.
                                let _ = catch_unwind(AssertUnwindSafe(|| job.band.convert()));
                                if done.send(()).is_err() {
                                    break;
                                }
                            }
                        })
                        .ok()
                        .map(|_| tx)
                })
                .collect();
            Self { workers, done }
        }

        /// Converts every band, the last one on this thread, and returns when all are done.
        pub fn run<'a>(&self, bands: impl Iterator<Item = Band<'a>>) {
            let mut bands = bands.peekable();
            let mut handed_out = 0;
            let mut workers = self.workers.iter();
            while let Some(band) = bands.next() {
                let worker = if bands.peek().is_some() { workers.next() } else { None };
                let Some(worker) = worker else {
                    band.convert();
                    continue;
                };
                // SAFETY: the band is used only until this function has collected every `done`
                // below, and its borrow lasts at least that long.
                let job = Job { band: unsafe { std::mem::transmute::<Band<'a>, Band<'static>>(band) } };
                match worker.send(job) {
                    Ok(()) => handed_out += 1,
                    // The worker is gone; the job comes back with the error and is done here.
                    Err(mpsc::SendError(job)) => job.band.convert(),
                }
            }
            for _ in 0..handed_out {
                if self.done.recv().is_err() {
                    break;
                }
            }
        }
    }
}

/// Converts whole pairs of rows: the luma of every pixel, and the chroma of every 2x2 block.
fn convert_band(bgra: &[u8], stride: usize, width: usize, y: &mut [u8], u: &mut [u8], v: &mut [u8]) {
    let half = width / 2;
    for (pair, (u_row, v_row)) in u.chunks_exact_mut(half).zip(v.chunks_exact_mut(half)).enumerate() {
        let top = &bgra[pair * 2 * stride..][..width * 4];
        let bottom = &bgra[(pair * 2 + 1) * stride..][..width * 4];
        let (y_top, y_bottom) = y[pair * 2 * width..][..2 * width].split_at_mut(width);
        for x in 0..width {
            y_top[x] = luma(&top[x * 4..]);
            y_bottom[x] = luma(&bottom[x * 4..]);
        }
        for x in 0..half {
            let block = [&top[x * 8..], &top[x * 8 + 4..], &bottom[x * 8..], &bottom[x * 8 + 4..]];
            let (mut r, mut g, mut b) = (0i32, 0i32, 0i32);
            for p in block {
                b += p[0] as i32;
                g += p[1] as i32;
                r += p[2] as i32;
            }
            u_row[x] = (((-38 * r - 74 * g + 112 * b) >> 10) + 128) as u8;
            v_row[x] = (((112 * r - 94 * g - 18 * b) >> 10) + 128) as u8;
        }
    }
}

#[inline]
fn luma(p: &[u8]) -> u8 {
    (((66 * p[2] as i32 + 129 * p[1] as i32 + 25 * p[0] as i32) >> 8) + 16) as u8
}

impl openh264::formats::YUVSource for I420 {
    fn dimensions(&self) -> (usize, usize) {
        (self.width, self.height)
    }
    fn strides(&self) -> (usize, usize, usize) {
        (self.width, self.width / 2, self.width / 2)
    }
    fn y(&self) -> &[u8] {
        &self.y
    }
    fn u(&self) -> &[u8] {
        &self.u
    }
    fn v(&self) -> &[u8] {
        &self.v
    }
}

#[cfg(test)]
mod i420_tests {
    use super::*;
    use openh264::formats::{RgbaSliceU8, YUVBuffer, YUVSource};

    fn to_bgra(rgba: &[u8]) -> Vec<u8> {
        rgba.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0], p[3]]).collect()
    }

    fn assert_close(mine: &I420, reference: &YUVBuffer) {
        for (name, a, b) in [("y", mine.y(), reference.y()), ("u", mine.u(), reference.u()), ("v", mine.v(), reference.v())] {
            let worst = a.iter().zip(b).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap_or(0);
            assert!(worst <= 2, "{name} differs by {worst}");
        }
    }

    #[test]
    fn it_matches_the_encoder_crates_own_conversion_within_rounding() {
        // Tall enough to be split over the worker threads.
        let (w, h) = (64usize, 480usize);
        let rgba: Vec<u8> = (0..w * h * 4).map(|i| ((i * 37 + i / 7) % 256) as u8).collect();
        let reference = YUVBuffer::from_rgba8_source(RgbaSliceU8::new(&rgba, (w, h)));
        let mut mine = I420::default();
        mine.fill(&to_bgra(&rgba), w * 4, w, h, None);
        assert_close(&mine, &reference);
    }

    #[test]
    fn only_the_changed_rows_are_converted_again_and_the_result_is_the_same() {
        let (w, h) = (32usize, 200usize);
        let first: Vec<u8> = (0..w * h * 4).map(|i| (i % 251) as u8).collect();
        let mut second = first.clone();
        for byte in &mut second[w * 4 * 101..w * 4 * 107] {
            *byte = byte.wrapping_add(90);
        }
        let mut mine = I420::default();
        mine.fill(&to_bgra(&first), w * 4, w, h, None);
        mine.fill(&to_bgra(&second), w * 4, w, h, Some(101..107));
        assert_close(&mine, &YUVBuffer::from_rgba8_source(RgbaSliceU8::new(&second, (w, h))));
    }

    #[test]
    fn a_wider_source_row_is_cropped_to_the_even_width() {
        // A 33-pixel-wide picture is encoded as 32 pixels by skipping its last column.
        let (w, h) = (33usize, 8usize);
        let rgba: Vec<u8> = (0..w * h * 4).map(|i| (i * 13 % 256) as u8).collect();
        let cropped: Vec<u8> = rgba.chunks_exact(w * 4).flat_map(|row| row[..32 * 4].to_vec()).collect();
        let mut mine = I420::default();
        mine.fill(&to_bgra(&rgba), w * 4, 32, h, None);
        assert_close(&mine, &YUVBuffer::from_rgba8_source(RgbaSliceU8::new(&cropped, (32, h))));
    }
}
