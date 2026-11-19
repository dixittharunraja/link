// Virtual webcam: frames from a paired phone's camera are handed to a virtual camera that other
// programs can select as "Link Virtual Camera" in Zoom, Chrome, Teams, WhatsApp, OBS and so on.
//
// Two implementations, because Windows has two camera systems:
//   * Media Foundation (vendor/link-vcam, Link's own, Windows 11 and newer). Seen by Store apps such
//     as WhatsApp and the Camera app, and also by browsers and other DirectShow apps. Preferred.
//   * DirectShow (vendor/softcam, MIT). The only choice on Windows 10. On Windows 11 it would show up
//     next to the Media Foundation camera under the same name, so it is not registered there.
//
// Either filter DLL has to be registered with Windows once (needs administrator rights). The installer
// does that; when the app runs unpacked, `register` does it on first use behind a UAC prompt.
//
// The phone's picture normally arrives already decoded from core::camera_rx as BGR (send_bgr_frame).
// The camera's size is fixed when it is created, so every frame is WIDTH x HEIGHT.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use serde_json::{json, Value};
use tauri::Manager;

/// The name other programs list the camera under. It is compiled into vendor/softcam/softcam.dll, so
/// changing it means rebuilding that DLL too.
pub const CAMERA_NAME: &str = "Link Virtual Camera";

pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;

/// Helpers both backends use: reading registrations and running a command with administrator rights.
#[cfg(windows)]
mod win {
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// The default value of a registry key (the path Windows has registered for a COM class), if any.
    pub fn registered_path(key: &str) -> Option<String> {
        let out = Command::new("reg").args(["query", key, "/ve"]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find(|l| l.contains("REG_SZ"))
            .and_then(|l| l.split("REG_SZ").nth(1))
            .map(|p| p.trim().to_string())
    }

    pub fn same_path(a: &str, b: &Path) -> bool {
        let norm = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
        norm(a) == norm(&b.display().to_string())
    }

    /// A path as the command line wants it: no \\?\ prefix, safe inside single quotes.
    pub fn plain_path(p: &Path) -> String {
        p.display().to_string().trim_start_matches(r"\\?\").replace('\'', "''")
    }

    /// Runs a PowerShell snippet with administrator rights, behind a UAC prompt, and waits for it.
    pub fn run_elevated(inner: &str) -> Result<(), String> {
        // The elevated shell gets its script as an encoded command, which avoids every quoting problem.
        let utf16: Vec<u8> = inner.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, utf16);
        let script = format!("Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-EncodedCommand','{}' -Verb RunAs -Wait", encoded);
        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Could not start the registration: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err("The virtual camera was not installed. Windows needs administrator permission to add it.".into())
        }
    }

    /// Whether this is Windows 11 or newer (build 22000), which has the Media Foundation virtual camera API.
    pub fn has_media_foundation_cameras() -> bool {
        let out = Command::new("reg")
            .args(["query", r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "/v", "CurrentBuildNumber"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(out) = out else { return false };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find(|l| l.contains("CurrentBuildNumber"))
            .and_then(|l| l.split_whitespace().last())
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|build| build >= 22000)
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;
    use std::sync::Mutex;

    use super::{HEIGHT, WIDTH};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const FRAMERATE: f32 = 30.0;
    // INSTANCE_KEY is where Windows lists video input devices, one subkey per camera name.
    // CLSID_KEY holds the registered path of the filter (CLSID from softcam.cpp).
    const INSTANCE_KEY: &str = r"HKCR\CLSID\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\Instance";
    const CLSID_KEY: &str = r"HKCR\CLSID\{AEF3B972-5FA5-4647-9571-358EB472BC9E}\InprocServer32";

    type CreateFn = unsafe extern "C" fn(i32, i32, f32) -> *mut c_void;
    type DeleteFn = unsafe extern "C" fn(*mut c_void);
    type SendFn = unsafe extern "C" fn(*mut c_void, *const c_void);
    type ConnectedFn = unsafe extern "C" fn(*mut c_void) -> bool;

    struct Camera {
        handle: *mut c_void,
        delete: DeleteFn,
        send: SendFn,
        connected: ConnectedFn,
        // Declared last so the DLL stays loaded until the camera has been deleted in Drop.
        _lib: libloading::Library,
    }

    // SAFETY: the handle is only ever used while the CAMERA mutex is held.
    unsafe impl Send for Camera {}

    impl Drop for Camera {
        fn drop(&mut self) {
            // SAFETY: `handle` came from scCreateCamera and is deleted exactly once, here.
            unsafe { (self.delete)(self.handle) };
        }
    }

    static CAMERA: Mutex<Option<Camera>> = Mutex::new(None);

    /// The path Windows currently has registered for the filter, if any.
    fn registered_path() -> Option<String> {
        super::win::registered_path(CLSID_KEY)
    }

    fn same_path(a: &str, b: &Path) -> bool {
        super::win::same_path(a, b)
    }

    /// The DirectShow camera is only used before Windows 11; there it is removed (see `unregister`).
    pub fn unregister(dll: &Path) -> String {
        format!("& regsvr32.exe /u /s '{}'", super::win::plain_path(dll))
    }

    /// Whether Windows lists the camera under CAMERA_NAME (entries are keyed by name).
    fn has_current_name() -> bool {
        let key = format!(r"{}\{}", INSTANCE_KEY, super::CAMERA_NAME);
        Command::new("reg").args(["query", &key]).creation_flags(CREATE_NO_WINDOW).output().map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn is_registered(dll: &Path) -> bool {
        registered_path().is_some_and(|p| same_path(&p, dll)) && has_current_name()
    }

    /// Registers the filter for every user. Asks for administrator rights through a UAC prompt.
    pub fn register(dll: &Path) -> Result<(), String> {
        let inner = format!("& regsvr32.exe /s '{}'", super::win::plain_path(dll));
        super::win::run_elevated(&inner)?;
        if !is_registered(dll) {
            return Err("The virtual camera was not installed. Windows needs administrator permission to add it.".into());
        }
        Ok(())
    }

    pub fn start(dll: &Path) -> Result<(), String> {
        let mut slot = CAMERA.lock().map_err(|_| "virtual camera state is poisoned".to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        // SAFETY: loading the bundled filter DLL and resolving its documented C entry points.
        unsafe {
            let lib = libloading::Library::new(dll).map_err(|e| format!("Could not load the virtual camera: {}", e))?;
            let create: CreateFn = *lib.get::<CreateFn>(b"scCreateCamera\0").map_err(|e| e.to_string())?;
            let delete: DeleteFn = *lib.get::<DeleteFn>(b"scDeleteCamera\0").map_err(|e| e.to_string())?;
            let send: SendFn = *lib.get::<SendFn>(b"scSendFrame\0").map_err(|e| e.to_string())?;
            let connected: ConnectedFn = *lib.get::<ConnectedFn>(b"scIsConnected\0").map_err(|e| e.to_string())?;
            let handle = create(WIDTH as i32, HEIGHT as i32, FRAMERATE);
            if handle.is_null() {
                return Err("The virtual camera is already in use by another program.".into());
            }
            *slot = Some(Camera { handle, delete, send, connected, _lib: lib });
        }
        Ok(())
    }

    pub fn stop() {
        if let Ok(mut slot) = CAMERA.lock() {
            *slot = None;
        }
    }

    pub fn is_active() -> bool {
        CAMERA.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    pub fn is_connected() -> bool {
        CAMERA.lock().ok().and_then(|s| s.as_ref().map(|c| unsafe { (c.connected)(c.handle) })).unwrap_or(false)
    }

    /// Sends a frame the caller drew (WIDTH x HEIGHT 24-bit BGR, top row first). Blocks briefly: the
    /// filter paces frames.
    pub fn send_bgr(bgr: &[u8]) -> Result<(), String> {
        if bgr.len() < (WIDTH * HEIGHT * 3) as usize {
            return Err("A camera frame of the wrong size was refused.".into());
        }
        let slot = CAMERA.lock().map_err(|_| "virtual camera state is poisoned".to_string())?;
        let camera = slot.as_ref().ok_or("The virtual camera is not running.")?;
        // SAFETY: `bgr` holds at least WIDTH * HEIGHT * 3 bytes, which is what the camera was created for.
        unsafe { (camera.send)(camera.handle, bgr.as_ptr() as *const c_void) };
        Ok(())
    }
}

/// The Media Foundation virtual camera (vendor/link-vcam, Windows 11 and newer).
#[cfg(windows)]
mod mf {
    use std::path::Path;
    use std::sync::Mutex;

    use super::{win, HEIGHT, WIDTH};

    // CLSID of the media source, from native/link-vcam/src/common.h.
    const CLSID_KEY: &str = r"HKCR\CLSID\{B4F5E2A1-6C3D-4E89-A17B-5D2C9E8F1A30}\InprocServer32";

    type StartFn = unsafe extern "C" fn() -> i32;
    type StopFn = unsafe extern "C" fn();
    type ConnectedFn = unsafe extern "C" fn() -> i32;
    type SendFn = unsafe extern "C" fn(*const u8, i32, i32) -> i32;

    struct Camera {
        stop: StopFn,
        connected: ConnectedFn,
        send: SendFn,
        // Declared last so the DLL stays loaded until the camera has been stopped in Drop.
        _lib: libloading::Library,
    }

    impl Drop for Camera {
        fn drop(&mut self) {
            // SAFETY: lvcStop is safe to call once the camera was started, and stops it.
            unsafe { (self.stop)() };
        }
    }

    static CAMERA: Mutex<Option<Camera>> = Mutex::new(None);

    pub fn is_registered(dll: &Path) -> bool {
        win::registered_path(CLSID_KEY).is_some_and(|p| win::same_path(&p, dll))
    }

    /// Registers the camera component for every user (UAC prompt) and, since Windows 11 would list
    /// the old DirectShow camera next to it under the same name, removes that one.
    pub fn register(dll: &Path, directshow: Option<&Path>) -> Result<(), String> {
        let mut inner = format!("& regsvr32.exe /s '{}'", win::plain_path(dll));
        if let Some(old) = directshow {
            inner.push_str(&format!("; {}", super::imp::unregister(old)));
        }
        win::run_elevated(&inner)?;
        if !is_registered(dll) {
            return Err("The virtual camera was not installed. Windows needs administrator permission to add it.".into());
        }
        Ok(())
    }

    pub fn start(dll: &Path) -> Result<(), String> {
        let mut slot = CAMERA.lock().map_err(|_| "virtual camera state is poisoned".to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        // SAFETY: loading Link's own camera DLL and resolving its documented C entry points.
        unsafe {
            let lib = libloading::Library::new(dll).map_err(|e| format!("Could not load the virtual camera: {}", e))?;
            let start: StartFn = *lib.get::<StartFn>(b"lvcStart\0").map_err(|e| e.to_string())?;
            let stop: StopFn = *lib.get::<StopFn>(b"lvcStop\0").map_err(|e| e.to_string())?;
            let connected: ConnectedFn = *lib.get::<ConnectedFn>(b"lvcIsConnected\0").map_err(|e| e.to_string())?;
            let send: SendFn = *lib.get::<SendFn>(b"lvcSendFrameBgr\0").map_err(|e| e.to_string())?;
            let hr = start();
            if hr < 0 {
                let code = hr as u32;
                return Err(match code {
                    // Also what a second copy of Link gets: the first one owns the frame pipe.
                    0x8007_0005 => "The virtual camera could not start. Another copy of Link may already be running it, or Windows' camera service cannot read Link's install folder.".to_string(),
                    _ => format!("The virtual camera could not start (error 0x{:08X}).", code),
                });
            }
            *slot = Some(Camera { stop, connected, send, _lib: lib });
        }
        Ok(())
    }

    pub fn stop() {
        if let Ok(mut slot) = CAMERA.lock() {
            *slot = None;
        }
    }

    pub fn is_active() -> bool {
        CAMERA.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    pub fn is_connected() -> bool {
        // SAFETY: the function pointer stays valid while the library is held in CAMERA.
        CAMERA.lock().ok().and_then(|s| s.as_ref().map(|c| unsafe { (c.connected)() } != 0)).unwrap_or(false)
    }

    /// Sends a frame the caller drew (WIDTH x HEIGHT 24-bit BGR, top row first), unless nothing is
    /// looking at the camera.
    pub fn send_bgr(bgr: &[u8]) -> Result<(), String> {
        if bgr.len() < (WIDTH * HEIGHT * 3) as usize {
            return Err("A camera frame of the wrong size was refused.".into());
        }
        let slot = CAMERA.lock().map_err(|_| "virtual camera state is poisoned".to_string())?;
        let camera = slot.as_ref().ok_or("The virtual camera is not running.")?;
        // SAFETY: the function pointer stays valid while the library is held in CAMERA.
        if unsafe { (camera.connected)() } == 0 {
            return Ok(());
        }
        // SAFETY: `bgr` holds at least WIDTH * HEIGHT * 3 bytes, which is what the camera expects.
        let hr = unsafe { (camera.send)(bgr.as_ptr(), WIDTH as i32, HEIGHT as i32) };
        if hr < 0 {
            return Err(format!("The virtual camera refused a frame (0x{:08X}).", hr as u32));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod mf {
    use std::path::Path;

    const NOT_SUPPORTED: &str = "The virtual webcam is only available on Windows.";
    pub fn is_registered(_: &Path) -> bool {
        false
    }
    pub fn register(_: &Path, _: Option<&Path>) -> Result<(), String> {
        Err(NOT_SUPPORTED.into())
    }
    pub fn start(_: &Path) -> Result<(), String> {
        Err(NOT_SUPPORTED.into())
    }
    pub fn stop() {}
    pub fn is_active() -> bool {
        false
    }
    pub fn is_connected() -> bool {
        false
    }
    pub fn send_bgr(_: &[u8]) -> Result<(), String> {
        Err(NOT_SUPPORTED.into())
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    const NOT_SUPPORTED: &str = "The virtual webcam is only available on Windows.";
    pub fn is_registered(_: &Path) -> bool {
        false
    }
    pub fn register(_: &Path) -> Result<(), String> {
        Err(NOT_SUPPORTED.into())
    }
    pub fn start(_: &Path) -> Result<(), String> {
        Err(NOT_SUPPORTED.into())
    }
    pub fn stop() {}
    pub fn is_active() -> bool {
        false
    }
    pub fn is_connected() -> bool {
        false
    }
    pub fn send_bgr(_: &[u8]) -> Result<(), String> {
        Err(NOT_SUPPORTED.into())
    }
}

fn find_in_vendor(app: &tauri::AppHandle, folder: &str, file: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("vendor").join(folder).join(file));
    }
    // Development: run from the source tree.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join(folder).join(file));
    candidates.into_iter().find(|p| p.exists()).and_then(|p| p.canonicalize().ok())
}

/// The DirectShow camera DLL (Windows 10). On Windows 11 it is only looked up to remove a
/// registration left from before the machine was upgraded.
fn find_dll(app: &tauri::AppHandle) -> Option<PathBuf> {
    find_in_vendor(app, "softcam", "softcam.dll")
}

/// Which camera this machine uses: the Media Foundation one on Windows 11, the DirectShow one before.
enum Backend {
    MediaFoundation(PathBuf),
    DirectShow(PathBuf),
}

fn backend(app: &tauri::AppHandle) -> Option<Backend> {
    #[cfg(windows)]
    if win::has_media_foundation_cameras() {
        return find_in_vendor(app, "link-vcam", "link-vcam-mf.dll").map(Backend::MediaFoundation);
    }
    find_dll(app).map(Backend::DirectShow)
}

pub fn status(app: &tauri::AppHandle) -> Value {
    let backend = backend(app);
    let (registered, name) = match &backend {
        Some(Backend::MediaFoundation(dll)) => (mf::is_registered(dll), format!("{} (Windows Virtual Camera)", CAMERA_NAME)),
        Some(Backend::DirectShow(dll)) => (imp::is_registered(dll), CAMERA_NAME.to_string()),
        None => (false, CAMERA_NAME.to_string()),
    };
    json!({
        "supported": cfg!(windows),
        "available": backend.is_some(),
        "registered": registered,
        "active": mf::is_active() || imp::is_active(),
        "connected": connected(),
        "width": WIDTH,
        "height": HEIGHT,
        "cameraName": name,
    })
}

/// Makes the camera available to other programs: registers the filter if needed (one UAC prompt),
/// then opens it.
pub fn start(app: &tauri::AppHandle) -> Result<Value, String> {
    match backend(app).ok_or("The virtual camera component is missing from this install.")? {
        Backend::MediaFoundation(dll) => {
            if !mf::is_registered(&dll) {
                mf::register(&dll, find_dll(app).as_deref())?;
            }
            mf::start(&dll)?;
        }
        Backend::DirectShow(dll) => {
            if !imp::is_registered(&dll) {
                imp::register(&dll)?;
            }
            imp::start(&dll)?;
        }
    }
    Ok(status(app))
}

/// Opens the camera only if it is already installed. Unlike `start` this never asks for
/// administrator rights, so it is safe to call when the app launches.
pub fn open(app: &tauri::AppHandle) -> Result<Value, String> {
    match backend(app).ok_or("The virtual camera component is missing from this install.")? {
        Backend::MediaFoundation(dll) => {
            if !mf::is_registered(&dll) {
                return Err("The virtual camera is not installed yet.".into());
            }
            mf::start(&dll)?;
        }
        Backend::DirectShow(dll) => {
            if !imp::is_registered(&dll) {
                return Err("The virtual camera is not installed yet.".into());
            }
            imp::start(&dll)?;
        }
    }
    Ok(status(app))
}

/// True while another program (Zoom, Chrome, ...) has the virtual camera open. Cheap enough to poll.
pub fn connected() -> bool {
    mf::is_connected() || imp::is_connected()
}

pub fn stop() {
    mf::stop();
    imp::stop();
}

/// When the last picture decoded natively (see core::camera_rx) was sent, in milliseconds since the app
/// started; 0 before the first one.
static NATIVE_FRAME_AT: AtomicU64 = AtomicU64::new(0);
/// How long after a native picture the stream still counts as flowing.
const NATIVE_FRESH_MS: u64 = 1000;

fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    // +1 so that "0" can mean "never".
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

/// True while pictures are arriving straight from a phone's stream.
pub fn native_frames_flowing() -> bool {
    let at = NATIVE_FRAME_AT.load(Ordering::Relaxed);
    at != 0 && now_ms().saturating_sub(at) < NATIVE_FRESH_MS
}

/// Called for every picture decoded natively. Records that the phone's stream is flowing and answers
/// whether drawing the picture is worth it: false while no program has the camera open, which saves
/// the colour conversion and scaling of every frame nobody would see.
pub fn want_native_frame() -> bool {
    NATIVE_FRAME_AT.store(now_ms(), Ordering::Relaxed);
    connected()
}

/// Sends one picture that was decoded natively, already drawn as tightly packed 24-bit BGR, WIDTH x
/// HEIGHT, top row first. The camera reads it in place, so no copy or JPEG step sits in between.
pub fn send_bgr_frame(bgr: &[u8]) -> Result<(), String> {
    NATIVE_FRAME_AT.store(now_ms(), Ordering::Relaxed);
    if mf::is_active() {
        mf::send_bgr(bgr)
    } else {
        imp::send_bgr(bgr)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{imp, win, HEIGHT, WIDTH};

    #[test]
    fn registered_paths_compare_without_case_slashes_or_the_verbatim_prefix() {
        let dll = std::path::Path::new(r"C:\Program Files\Link\vendor\link-vcam\link-vcam-mf.dll");
        assert!(win::same_path(r"c:/program files/link/vendor/link-vcam/LINK-VCAM-MF.DLL", dll));
        assert!(win::same_path(r"\\?\C:\Program Files\Link\vendor\link-vcam\link-vcam-mf.dll", dll));
        assert!(!win::same_path(r"C:\ProgramData\LinkVcam\link-vcam-mf.dll", dll));
    }

    #[test]
    fn paths_in_elevated_scripts_are_safe_inside_single_quotes() {
        let quoted = win::plain_path(std::path::Path::new(r"\\?\C:\Users\O'Neil\vcam.dll"));
        assert_eq!(quoted, r"C:\Users\O''Neil\vcam.dll");
    }

    #[test]
    fn opens_the_camera_and_sends_frames() {
        let dll = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/softcam/softcam.dll").canonicalize().unwrap();
        // The camera can be opened by one program at a time. When the installed Link (or anything else)
        // already has it, there is nothing to test here.
        if let Err(e) = imp::start(&dll) {
            assert!(e.contains("already in use"), "unexpected failure: {e}");
            eprintln!("skipped: {e}");
            return;
        }
        assert!(imp::is_active());

        let frame = vec![30u8; (WIDTH * HEIGHT * 3) as usize];
        for _ in 0..5 {
            imp::send_bgr(&frame).expect("a frame should be accepted");
        }
        assert!(imp::send_bgr(&frame[..10]).is_err(), "a frame of the wrong size is refused");

        imp::stop();
        assert!(!imp::is_active());
        assert!(imp::send_bgr(&frame).is_err(), "frames must be refused once the camera is closed");
    }
}
