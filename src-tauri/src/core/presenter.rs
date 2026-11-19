use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{mpsc, Arc, OnceLock};

use tauri::AppHandle;

// The red pointer dot a phone drives while presenting: a small native window over the primary
// display, always on top, click-through and never focused, that holds an anti-aliased dot drawn
// once into a layered (per-pixel alpha) bitmap and is only moved after that. Moves arrive from the
// UDP input relay as fractions of the screen, and the dot hides itself shortly after the last one.
//
// The relay only hands each move over (it must never wait, or every phone's input would wait with
// it); one thread owns the window and its message loop, takes moves that arrive together as one,
// and keeps a single hide timer that each move pushes back.

const HIDE_AFTER_MS: u32 = 500;

enum Command {
    Move(f64, f64),
    Stop,
}

/// The dot's thread: where commands go, and its window, once it exists, to wake it up with.
struct Dot {
    commands: mpsc::Sender<Command>,
    window: Arc<AtomicIsize>,
}

#[derive(Default)]
pub struct Presenter {
    dot: OnceLock<Dot>,
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

impl Dot {
    fn start() -> Self {
        let (commands, receiver) = mpsc::channel();
        let window = Arc::new(AtomicIsize::new(0));
        #[cfg(windows)]
        {
            let window = window.clone();
            if let Err(e) = std::thread::Builder::new().name("presenter-dot".into()).spawn(move || native::run(receiver, window)) {
                log::warn!("Presenter dot: could not start its thread: {}", e);
            }
        }
        #[cfg(not(windows))]
        drop(receiver);
        Self { commands, window }
    }

    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
        // Before the window exists the thread takes what is queued as soon as it has made it.
        #[cfg(windows)]
        native::wake(self.window.load(Ordering::SeqCst));
        #[cfg(not(windows))]
        let _ = self.window.load(Ordering::SeqCst);
    }
}

impl Presenter {
    /// Moves the dot by (dx, dy) in screen fractions (dy is scaled by the aspect ratio) and shows
    /// it. Returns at once; the window is updated by the dot's own thread.
    pub fn move_dot(&self, _app: &AppHandle, dx: f64, dy: f64) {
        self.dot.get_or_init(Dot::start).send(Command::Move(dx, dy));
    }

    /// Presentation ended: hide the dot and forget its position.
    pub fn stop(&self, _app: &AppHandle) {
        // A dot that never moved in this run of the app has nothing to hide.
        if let Some(dot) = self.dot.get() {
            dot.send(Command::Stop);
        }
    }
}

#[cfg(windows)]
mod native {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::{mpsc, Arc};

    use windows_sys::Win32::Foundation::{HWND, POINT, SIZE};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetDeviceCaps, ReleaseDC, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, LOGPIXELSX,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetSystemMetrics, KillTimer, PostMessageW, RegisterClassW, SetTimer,
        SetWindowPos, ShowWindow, TranslateMessage, UpdateLayeredWindow, HWND_TOPMOST, MSG, SM_CXSCREEN, SM_CYSCREEN, SWP_NOACTIVATE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SW_HIDE, ULW_ALPHA, WM_APP, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_EX_TRANSPARENT, WS_POPUP,
    };

    use super::{clamp01, Command, HIDE_AFTER_MS};

    /// Posted to the window when commands are waiting.
    const WM_WAKE: u32 = WM_APP + 1;
    const HIDE_TIMER: usize = 1;
    /// The dot as the old overlay page drew it, in pixels at 100% scaling: 14 px across at 85% red,
    /// with a soft red glow (CSS box-shadow 0 0 8px 2px at 50%). The bitmap has room for the glow.
    const DOT_RADIUS: f32 = 7.0;
    const GLOW_SPREAD: f32 = 2.0;
    const GLOW_BLUR: f32 = 8.0;
    const BITMAP_SIZE: f32 = 40.0;

    pub fn wake(window: isize) {
        if window != 0 {
            // SAFETY: posting to a window handle is safe even if it has since been destroyed.
            unsafe { PostMessageW(window as HWND, WM_WAKE, 0, 0) };
        }
    }

    fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
        let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }

    /// The dot's pixels, premultiplied BGRA, `size` x `size`, at `scale` times 100%.
    fn draw(size: usize, scale: f32) -> Vec<u8> {
        let centre = size as f32 / 2.0;
        let radius = DOT_RADIUS * scale;
        let glow_edge = radius + GLOW_SPREAD * scale;
        // A CSS blur radius is twice the Gaussian's standard deviation; the shadow fades over about
        // two of them either side of its edge.
        let sigma = GLOW_BLUR * scale / 2.0;
        let mut pixels = vec![0u8; size * size * 4];
        for (i, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            let (x, y) = ((i % size) as f32 + 0.5 - centre, (i / size) as f32 + 0.5 - centre);
            let distance = (x * x + y * y).sqrt();
            let core = 0.85 * (radius + 0.5 - distance).clamp(0.0, 1.0);
            let glow = 0.5 * (1.0 - smoothstep(-2.0 * sigma, 2.0 * sigma, distance - glow_edge));
            let alpha = core + glow * (1.0 - core);
            let value = (alpha * 255.0).round() as u8;
            // Pure red, premultiplied: blue, green, red, alpha.
            pixel.copy_from_slice(&[0, 0, value, value]);
        }
        pixels
    }

    /// Makes the hidden dot window and gives it its picture; its handle, or None.
    fn create() -> Option<(HWND, i32)> {
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let class_name: Vec<u16> = "LinkPresenterDot\0".encode_utf16().collect();
            let class = WNDCLASSW {
                lpfnWndProc: Some(DefWindowProcW),
                hInstance: instance,
                lpszClassName: class_name.as_ptr(),
                // SAFETY: every other field of WNDCLASSW may be zero.
                ..std::mem::zeroed()
            };
            RegisterClassW(&class);

            let screen = GetDC(std::ptr::null_mut());
            let scale = GetDeviceCaps(screen, LOGPIXELSX as _).max(96) as f32 / 96.0;
            let size = (BITMAP_SIZE * scale).round() as i32;
            let window = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                size,
                size,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if window.is_null() {
                ReleaseDC(std::ptr::null_mut(), screen);
                return None;
            }

            let memory = CreateCompatibleDC(screen);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                // Negative: rows run top to bottom.
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = CreateDIBSection(memory, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            if !bitmap.is_null() && !bits.is_null() {
                let pixels = draw(size as usize, scale);
                // SAFETY: the section holds size x size 32-bit pixels, top-down, without padding.
                std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u8, pixels.len());
                let previous = SelectObject(memory, bitmap);
                let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
                let extent = SIZE { cx: size, cy: size };
                let origin = POINT { x: 0, y: 0 };
                // The system keeps the picture from here on; moving the window does not redraw it.
                UpdateLayeredWindow(window, screen, std::ptr::null(), &extent, memory, &origin, 0, &blend, ULW_ALPHA);
                SelectObject(memory, previous);
                DeleteObject(bitmap);
            }
            DeleteDC(memory);
            ReleaseDC(std::ptr::null_mut(), screen);
            Some((window, size))
        }
    }

    /// The dot's thread: makes the window, then runs its message loop for as long as the app runs.
    pub fn run(commands: mpsc::Receiver<Command>, published: Arc<AtomicIsize>) {
        let Some((window, size)) = create() else {
            log::warn!("Presenter dot: could not create its window");
            return;
        };
        published.store(window as isize, Ordering::SeqCst);
        let mut position: Option<(f64, f64)> = None;
        take(&commands, window, size, &mut position);
        // SAFETY: MSG is plain data; GetMessageW fills it.
        let mut message: MSG = unsafe { std::mem::zeroed() };
        while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
            match message.message {
                WM_WAKE => take(&commands, window, size, &mut position),
                WM_TIMER if message.wParam == HIDE_TIMER => unsafe {
                    KillTimer(window, HIDE_TIMER);
                    ShowWindow(window, SW_HIDE);
                },
                _ => unsafe {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                },
            }
        }
    }

    /// Takes everything waiting in one go (moves add up, a stop wins) and moves or hides the dot.
    fn take(commands: &mpsc::Receiver<Command>, window: HWND, size: i32, position: &mut Option<(f64, f64)>) {
        let (mut dx, mut dy, mut stop, mut any) = (0.0, 0.0, false, false);
        while let Ok(command) = commands.try_recv() {
            any = true;
            match command {
                Command::Move(x, y) => (dx, dy) = (dx + x, dy + y),
                Command::Stop => (dx, dy, stop) = (0.0, 0.0, true),
            }
        }
        if !any {
            return;
        }
        unsafe {
            if stop {
                // Presentation ended: hide the dot and forget its position.
                *position = None;
                KillTimer(window, HIDE_TIMER);
                ShowWindow(window, SW_HIDE);
                return;
            }
            // The primary display, in physical pixels (the app is DPI aware); it starts at (0, 0).
            let (width, height) = (GetSystemMetrics(SM_CXSCREEN).max(1), GetSystemMetrics(SM_CYSCREEN).max(1));
            let aspect = width as f64 / height as f64;
            let (px, py) = position.unwrap_or((0.5, 0.5));
            let (x, y) = (clamp01(px + dx), clamp01(py + dy * aspect));
            *position = Some((x, y));
            let (left, top) = ((x * width as f64).round() as i32 - size / 2, (y * height as f64).round() as i32 - size / 2);
            // Only ask to show the window when it is hidden; repeating it on every move is wasted work.
            let show = if windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(window) == 0 { SWP_SHOWWINDOW } else { 0 };
            SetWindowPos(window, HWND_TOPMOST, left, top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | show);
            // Setting the timer again restarts it.
            SetTimer(window, HIDE_TIMER, HIDE_AFTER_MS, None);
        }
    }

    /// Needs a desktop: shows the dot, moves it, and checks it hides by itself and on stop.
    /// `cargo test --lib -- --ignored the_dot_shows_moves_and_hides`
    #[test]
    #[ignore = "opens a window on the desktop"]
    fn the_dot_shows_moves_and_hides() {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible};
        let dot = super::Dot::start();
        dot.send(Command::Move(0.0, 0.0));
        std::thread::sleep(std::time::Duration::from_millis(200));
        let window = dot.window.load(Ordering::SeqCst) as HWND;
        assert!(!window.is_null(), "no window");
        let rect = |w| unsafe {
            let mut r: RECT = std::mem::zeroed();
            GetWindowRect(w, &mut r);
            r
        };
        assert!(unsafe { IsWindowVisible(window) } != 0, "the dot did not show");
        let centre = rect(window);
        dot.send(Command::Move(0.1, 0.0));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(rect(window).left > centre.left, "the dot did not move right");
        std::thread::sleep(std::time::Duration::from_millis(700));
        assert!(unsafe { IsWindowVisible(window) } == 0, "the dot did not hide after the last move");
        dot.send(Command::Move(0.0, 0.0));
        std::thread::sleep(std::time::Duration::from_millis(100));
        dot.send(Command::Stop);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(unsafe { IsWindowVisible(window) } == 0, "stop did not hide the dot");
        // After a stop the dot starts again from the middle.
        dot.send(Command::Move(0.0, 0.0));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(rect(window).left, centre.left, "stop did not forget the position");
    }
}
