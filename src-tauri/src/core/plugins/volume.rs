// Playback-device volume and mute through the Windows Core Audio endpoint API. Each call runs on
// a blocking thread because COM must be initialised on the thread that uses it.
//
// Changes are pushed by Windows: `watch` registers a device notification client (devices added,
// removed, enabled, disabled, renamed) and a volume callback on every active playback device, kept in
// step as devices come and go, on a thread of its own.

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Sink {
    pub id: String,
    pub name: String,
    pub volume: u32,
    pub muted: bool,
}

/// Id of the built-in display brightness entry. It travels as one more sink so peers show it as a
/// slider beside the volumes, under the same permission.
pub const BRIGHTNESS_ID: &str = "brightness";

// Built-in display brightness through the video driver's `\\.\LCD` device. Only laptop and
// all-in-one panels have it; elsewhere `read` is None and no brightness entry is offered.
#[cfg(windows)]
mod brightness {
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const IOCTL_QUERY_SUPPORTED: u32 = 0x0023_0496;
    const IOCTL_QUERY_DISPLAY: u32 = 0x0023_0498;
    const IOCTL_SET_DISPLAY: u32 = 0x0023_049C;
    const POLICY_BOTH: u8 = 3;

    #[repr(C)]
    #[derive(Default)]
    struct DisplayBrightness {
        policy: u8,
        ac: u8,
        dc: u8,
    }

    struct Panel(windows_sys::Win32::Foundation::HANDLE);

    impl Drop for Panel {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by `open` and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn open() -> Option<Panel> {
        let path: Vec<u16> = r"\\.\LCD".encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `path` is NUL-terminated and outlives the call.
        let handle = unsafe {
            CreateFileW(path.as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut())
        };
        (handle != INVALID_HANDLE_VALUE).then_some(Panel(handle))
    }

    fn on_battery() -> bool {
        let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        // SAFETY: `status` is a valid out-pointer.
        unsafe { GetSystemPowerStatus(&mut status) != 0 && status.ACLineStatus == 0 }
    }

    /// The brightness levels the panel accepts, ascending (usually 0-100 in steps).
    fn levels(panel: &Panel) -> Vec<u8> {
        let mut out = [0u8; 256];
        let mut returned = 0u32;
        // SAFETY: `out` and `returned` are valid for the sizes passed.
        let ok = unsafe { DeviceIoControl(panel.0, IOCTL_QUERY_SUPPORTED, std::ptr::null(), 0, out.as_mut_ptr().cast(), out.len() as u32, &mut returned, std::ptr::null_mut()) };
        if ok == 0 {
            return Vec::new();
        }
        out[..returned as usize].to_vec()
    }

    pub fn read() -> Option<u32> {
        let panel = open()?;
        let mut current = DisplayBrightness::default();
        let mut returned = 0u32;
        // SAFETY: `current` is a valid out-buffer of the size passed.
        let ok = unsafe {
            DeviceIoControl(panel.0, IOCTL_QUERY_DISPLAY, std::ptr::null(), 0, (&mut current as *mut DisplayBrightness).cast(), std::mem::size_of::<DisplayBrightness>() as u32, &mut returned, std::ptr::null_mut())
        };
        (ok != 0).then(|| u32::from(if on_battery() { current.dc } else { current.ac }))
    }

    pub fn set(percent: u32) -> bool {
        let Some(panel) = open() else { return false };
        let want = percent.min(100) as i32;
        // The driver rejects values that are not one of its levels, so snap to the nearest.
        let level = levels(&panel).into_iter().min_by_key(|l| (i32::from(*l) - want).abs()).unwrap_or(want as u8);
        let request = DisplayBrightness { policy: POLICY_BOTH, ac: level, dc: level };
        let mut returned = 0u32;
        // SAFETY: `request` is a valid in-buffer of the size passed.
        unsafe {
            DeviceIoControl(panel.0, IOCTL_SET_DISPLAY, (&request as *const DisplayBrightness).cast(), std::mem::size_of::<DisplayBrightness>() as u32, std::ptr::null_mut(), 0, &mut returned, std::ptr::null_mut()) != 0
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::Sink;
    use windows::core::{implement, Result, PCWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl};
    use windows::Win32::Media::Audio::{
        eRender, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator,
        AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

    pub fn enumerator() -> Result<IMMDeviceEnumerator> {
        // SAFETY: plain COM calls; CoInitializeEx fails harmlessly when this thread already
        // initialised COM in another mode.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        }
    }

    fn device_id(device: &IMMDevice) -> Result<String> {
        // SAFETY: `device` is a live COM interface; the id string is freed exactly once.
        unsafe {
            let id = device.GetId()?;
            let id_string = id.to_string().unwrap_or_default();
            CoTaskMemFree(Some(id.0 as _));
            Ok(id_string)
        }
    }

    fn read(device: &IMMDevice) -> Result<Sink> {
        let id = device_id(device)?;
        // SAFETY: `device` is a live COM interface.
        unsafe {
            let store = device.OpenPropertyStore(STGM_READ)?;
            let name = store.GetValue(&PKEY_Device_FriendlyName)?.to_string();

            let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
            let volume = (endpoint.GetMasterVolumeLevelScalar()? * 100.0).round() as u32;
            let muted = endpoint.GetMute()?.as_bool();
            Ok(Sink { id, name, volume, muted })
        }
    }

    pub fn list() -> Vec<Sink> {
        (|| -> Result<Vec<Sink>> {
            // SAFETY: enumeration over a live collection, indices bounded by GetCount.
            let devices = unsafe { enumerator()?.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
            (0..unsafe { devices.GetCount()? }).map(|i| read(&unsafe { devices.Item(i)? })).collect()
        })()
        .unwrap_or_default()
    }

    fn with_endpoint(id: &str, apply: impl FnOnce(&IAudioEndpointVolume) -> Result<()>) -> bool {
        (|| -> Result<()> {
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: `wide` is NUL-terminated and outlives the call.
            let endpoint: IAudioEndpointVolume = unsafe {
                enumerator()?.GetDevice(PCWSTR(wide.as_ptr()))?.Activate(CLSCTX_ALL, None)?
            };
            apply(&endpoint)
        })()
        .is_ok()
    }

    pub fn set_volume(id: &str, percent: u32) -> bool {
        let scalar = percent.min(100) as f32 / 100.0;
        // SAFETY: a null event-context GUID is allowed by the API.
        with_endpoint(id, |e| unsafe { e.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) })
    }

    pub fn set_muted(id: &str, muted: bool) -> bool {
        // SAFETY: as above.
        with_endpoint(id, |e| unsafe { e.SetMute(muted, std::ptr::null()) })
    }

    // ---- change notifications ----

    pub enum Msg {
        // The set of playback devices (or a name) may have changed: re-register the volume callbacks.
        Devices,
        // A device's volume or mute changed.
        Volume,
        Stop,
    }

    type Tx = std::sync::mpsc::Sender<Msg>;

    // Windows calls these on its own threads and asks that they return quickly and never register or
    // unregister from inside, so they only hand the event to the watcher thread.
    #[implement(IMMNotificationClient)]
    struct DeviceEvents(Tx);

    impl IMMNotificationClient_Impl for DeviceEvents_Impl {
        fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> Result<()> {
            let _ = self.0.send(Msg::Devices);
            Ok(())
        }
        fn OnDeviceAdded(&self, _id: &PCWSTR) -> Result<()> {
            let _ = self.0.send(Msg::Devices);
            Ok(())
        }
        fn OnDeviceRemoved(&self, _id: &PCWSTR) -> Result<()> {
            let _ = self.0.send(Msg::Devices);
            Ok(())
        }
        fn OnDefaultDeviceChanged(&self, flow: EDataFlow, _role: ERole, _id: &PCWSTR) -> Result<()> {
            if flow == eRender {
                let _ = self.0.send(Msg::Devices);
            }
            Ok(())
        }
        fn OnPropertyValueChanged(&self, _id: &PCWSTR, key: &PROPERTYKEY) -> Result<()> {
            // Drivers change many properties all the time; only the name is part of what peers see.
            if *key == PKEY_Device_FriendlyName {
                let _ = self.0.send(Msg::Volume);
            }
            Ok(())
        }
    }

    #[implement(IAudioEndpointVolumeCallback)]
    struct VolumeEvents(Tx);

    impl IAudioEndpointVolumeCallback_Impl for VolumeEvents_Impl {
        fn OnNotify(&self, _data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
            let _ = self.0.send(Msg::Volume);
            Ok(())
        }
    }

    /// Registers `callback` on every active playback device not yet watched and drops the devices
    /// that are gone (their registration is undone first).
    fn sync_endpoints(
        enumerator: &IMMDeviceEnumerator,
        callback: &IAudioEndpointVolumeCallback,
        watched: &mut std::collections::HashMap<String, IAudioEndpointVolume>,
    ) {
        let mut active = std::collections::HashMap::new();
        // SAFETY: enumeration over a live collection, indices bounded by GetCount.
        if let Ok(devices) = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) } {
            for i in 0..unsafe { devices.GetCount() }.unwrap_or(0) {
                let Ok(device) = (unsafe { devices.Item(i) }) else { continue };
                let Ok(id) = device_id(&device) else { continue };
                if let Some(endpoint) = watched.remove(&id) {
                    active.insert(id, endpoint);
                    continue;
                }
                // SAFETY: `device` is live; the endpoint is kept alive for as long as it is registered.
                let registered = unsafe {
                    device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).and_then(|e| e.RegisterControlChangeNotify(callback).map(|_| e))
                };
                match registered {
                    Ok(endpoint) => {
                        active.insert(id, endpoint);
                    }
                    Err(e) => log::warn!("[Volume] could not watch a playback device: {e}"),
                }
            }
        }
        for endpoint in watched.values() {
            // SAFETY: undoes the registration made above on the same live endpoint.
            let _ = unsafe { endpoint.UnregisterControlChangeNotify(callback) };
        }
        *watched = active;
    }

    /// The watcher thread: waits for change notifications, lets a burst (a slider drag) settle, then
    /// calls `on_change` once. Ends on Msg::Stop or when every sender is gone.
    pub fn run(tx: Tx, rx: std::sync::mpsc::Receiver<Msg>, on_change: Box<dyn Fn() + Send>) {
        use std::time::{Duration, Instant};
        const QUIET: Duration = Duration::from_millis(50);
        const MAX_WAIT: Duration = Duration::from_millis(250);

        // SAFETY: this thread joins the multithreaded apartment and leaves it at the end.
        let joined = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        (|| -> Result<()> {
            // SAFETY: plain COM calls on this MTA thread.
            let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
            let client: IMMNotificationClient = DeviceEvents(tx.clone()).into();
            let callback: IAudioEndpointVolumeCallback = VolumeEvents(tx).into();
            // SAFETY: `client` stays alive until it is unregistered below.
            unsafe { enumerator.RegisterEndpointNotificationCallback(&client)? };
            let mut watched = std::collections::HashMap::new();
            sync_endpoints(&enumerator, &callback, &mut watched);

            'outer: while let Ok(first) = rx.recv() {
                let mut devices = false;
                let started = Instant::now();
                let mut next = Some(first);
                while let Some(msg) = next {
                    match msg {
                        Msg::Stop => break 'outer,
                        Msg::Devices => devices = true,
                        Msg::Volume => {}
                    }
                    // Whatever arrives after MAX_WAIT starts the next round.
                    let left = MAX_WAIT.saturating_sub(started.elapsed());
                    if left.is_zero() {
                        break;
                    }
                    next = match rx.recv_timeout(QUIET.min(left)) {
                        Ok(msg) => Some(msg),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                    };
                }
                if devices {
                    sync_endpoints(&enumerator, &callback, &mut watched);
                }
                on_change();
            }

            for endpoint in watched.values() {
                // SAFETY: undoes each registration made by sync_endpoints.
                let _ = unsafe { endpoint.UnregisterControlChangeNotify(&callback) };
            }
            // SAFETY: undoes the registration above.
            unsafe { enumerator.UnregisterEndpointNotificationCallback(&client)? };
            Ok(())
        })()
        .unwrap_or_else(|e| log::warn!("[Volume] change notifications unavailable: {e}"));
        if joined {
            // SAFETY: balances the successful CoInitializeEx above; every COM object is dropped by now.
            unsafe { CoUninitialize() };
        }
    }
}

/// Watches the playback devices while it is alive; dropping it unregisters everything.
pub struct Watcher {
    #[cfg(windows)]
    stop: std::sync::mpsc::Sender<imp::Msg>,
}

#[cfg(windows)]
impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.stop.send(imp::Msg::Stop);
    }
}

/// Calls `on_change` (on the watcher's own thread, after a burst settles) whenever a playback device's
/// volume, mute or name changes, or a device comes or goes. It carries no state: read it with `list`.
#[cfg(windows)]
pub fn watch(on_change: impl Fn() + Send + 'static) -> Watcher {
    let (tx, rx) = std::sync::mpsc::channel();
    let thread_tx = tx.clone();
    let spawned = std::thread::Builder::new()
        .name("volume-watch".into())
        .spawn(move || imp::run(thread_tx, rx, Box::new(on_change)));
    if let Err(e) = spawned {
        log::warn!("[Volume] could not start the change watcher: {e}");
    }
    Watcher { stop: tx }
}

#[cfg(not(windows))]
pub fn watch(_on_change: impl Fn() + Send + 'static) -> Watcher {
    Watcher {}
}

#[cfg(windows)]
pub(crate) use imp::enumerator;

#[cfg(windows)]
pub async fn list() -> Vec<Sink> {
    tokio::task::spawn_blocking(|| {
        let mut sinks = imp::list();
        // Last, so peers that show only the first sink keep showing a playback device.
        if let Some(level) = brightness::read() {
            sinks.push(Sink { id: BRIGHTNESS_ID.into(), name: "Brightness".into(), volume: level, muted: false });
        }
        sinks
    })
    .await
    .unwrap_or_default()
}

#[cfg(windows)]
pub async fn set_volume(id: String, percent: u32) -> bool {
    tokio::task::spawn_blocking(move || if id == BRIGHTNESS_ID { brightness::set(percent) } else { imp::set_volume(&id, percent) })
        .await
        .unwrap_or(false)
}

#[cfg(windows)]
pub async fn set_muted(id: String, muted: bool) -> bool {
    if id == BRIGHTNESS_ID {
        return false;
    }
    tokio::task::spawn_blocking(move || imp::set_muted(&id, muted)).await.unwrap_or(false)
}

#[cfg(not(windows))]
pub async fn list() -> Vec<Sink> {
    Vec::new()
}

#[cfg(not(windows))]
pub async fn set_volume(_id: String, _percent: u32) -> bool {
    false
}

#[cfg(not(windows))]
pub async fn set_muted(_id: String, _muted: bool) -> bool {
    false
}

#[cfg(all(test, windows))]
mod tests {
    // Runs against this machine's audio devices: `cargo test --lib -- --ignored volume_watcher --nocapture`.
    #[test]
    #[ignore]
    fn volume_watcher_reports_changes() {
        let sinks = super::imp::list();
        println!("playback devices: {sinks:#?}");
        let (tx, rx) = std::sync::mpsc::channel();
        let watcher = super::watch(move || {
            let _ = tx.send(());
        });
        // Give the watcher a moment to register, then nudge the first device and put it back.
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Some(first) = sinks.first() {
            let nudged = if first.volume >= 50 { first.volume - 1 } else { first.volume + 1 };
            assert!(super::imp::set_volume(&first.id, nudged));
            let heard = rx.recv_timeout(std::time::Duration::from_secs(3)).is_ok();
            super::imp::set_volume(&first.id, first.volume);
            println!("change notification received: {heard}; state now: {:#?}", super::imp::list());
            assert!(heard, "no volume change notification within 3 s");
        }
        drop(watcher);
    }
}
