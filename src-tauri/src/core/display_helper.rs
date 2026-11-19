// The virtual monitors behind Second Screen, one per phone that is extending this PC.
//
// Creating or disabling a display device needs administrator rights. The installer already has them,
// so it registers a small Windows service (this same executable run with `--display-service`) that
// only sets how many virtual monitors are on. Link talks to it over a local named pipe, so no prompt
// ever appears.
//
// Each pipe connection is a lease on one monitor: the count goes up when a connection opens and down
// when it closes, including when Link crashes. The driver reads its monitor count at start-up, so a
// change in number restarts it briefly. The service takes no other parameters, so it can do nothing
// else with the access it has.

#[cfg(windows)]
pub use imp::{DisplayLease, acquire, run_service};

#[cfg(not(windows))]
pub struct DisplayLease;

#[cfg(not(windows))]
pub fn acquire() -> Result<DisplayLease, String> {
    Err("The virtual display is only available on Windows".into())
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use std::sync::Mutex;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        DICD_GENERATE_ID, DICS_DISABLE, DICS_ENABLE, DICS_FLAG_GLOBAL, DIF_PROPERTYCHANGE,
        DIF_REGISTERDEVICE, HDEVINFO, INSTALLFLAG_FORCE, SP_CLASSINSTALL_HEADER, SP_DEVINFO_DATA,
        SP_PROPCHANGE_PARAMS, SPDRP_HARDWAREID, SetupDiCallClassInstaller, SetupDiCreateDeviceInfoList,
        SetupDiCreateDeviceInfoW, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceRegistryPropertyW, SetupDiSetClassInstallParamsW, SetupDiSetDeviceRegistryPropertyW,
        UpdateDriverForPlugAndPlayDevicesW,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    const SERVICE_NAME: &str = "LinkDisplayHelper";
    const PIPE_NAME: &str = r"\\.\pipe\link-display-helper";
    const HARDWARE_ID: &str = "Root\\MttVDD";
    const DEVICE_NAME: &str = "MttVDD";
    /// The most phones that can extend this PC at once, one virtual monitor each.
    const MAX_MONITORS: usize = 4;
    /// SYSTEM and administrators have full access; any logged-in user may open the pipe, never a remote one.
    const PIPE_SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)";
    // {4d36e968-e325-11ce-bfc1-08002be10318}: the Display device class.
    const DISPLAY_CLASS: windows_sys::core::GUID = windows_sys::core::GUID {
        data1: 0x4d36e968,
        data2: 0xe325,
        data3: 0x11ce,
        data4: [0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18],
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // ---- Client (Link itself) -------------------------------------------------------------

    /// Keeps the virtual display switched on for as long as it lives.
    pub struct DisplayLease(#[allow(dead_code)] File);

    /// Asks the helper service to switch the virtual display on. Fails when the service is not
    /// installed (a development run) or the display driver is missing.
    pub fn acquire() -> Result<DisplayLease, String> {
        let mut pipe = OpenOptions::new()
            .read(true)
            .write(true)
            .open(PIPE_NAME)
            .map_err(|_| "The display helper is not running (it is installed with Link)".to_string())?;
        pipe.write_all(b"on\n").map_err(|e| e.to_string())?;
        let mut reply = [0u8; 256];
        let n = pipe.read(&mut reply).map_err(|e| e.to_string())?;
        let reply = String::from_utf8_lossy(&reply[..n]).trim().to_string();
        if reply == "ok" { Ok(DisplayLease(pipe)) } else { Err(reply) }
    }

    // ---- Service --------------------------------------------------------------------------

    /// Runs the service until Windows stops it. Called from `main` with `--display-service`.
    pub fn run_service() {
        let _ = service_dispatcher::start(SERVICE_NAME, ffi_service_main);
    }

    define_windows_service!(ffi_service_main, service_main);

    fn service_main(_args: Vec<std::ffi::OsString>) {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let handler = move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let Ok(status_handle) = service_control_handler::register(SERVICE_NAME, handler) else { return };
        let status = |state, accept| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };
        let _ = status_handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN));

        // Start clean: a monitor left on by a crash or an upgrade is not held by any phone.
        switch_all_off();
        std::thread::spawn(serve);
        let _ = stop_rx.recv();

        let _ = status_handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()));
        switch_all_off();
        std::process::exit(0);
    }

    static SLOTS: Mutex<[bool; MAX_MONITORS]> = Mutex::new([false; MAX_MONITORS]);
    static DEVICE_LOCK: Mutex<()> = Mutex::new(());

    fn serve() {
        loop {
            let Some(pipe) = create_pipe() else {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            };
            // SAFETY: `pipe` is a valid pipe handle created above.
            let connected = unsafe { ConnectNamedPipe(pipe, null_mut()) } != 0 || unsafe { GetLastError() } == 535; // ERROR_PIPE_CONNECTED
            if !connected {
                // SAFETY: closing the handle created above.
                unsafe { CloseHandle(pipe) };
                continue;
            }
            let pipe = pipe as usize;
            std::thread::spawn(move || handle_client(pipe as HANDLE));
        }
    }

    fn create_pipe() -> Option<HANDLE> {
        let sddl = wide(PIPE_SDDL);
        let mut descriptor: *mut c_void = null_mut();
        // SAFETY: `sddl` is NUL-terminated and `descriptor` receives a LocalAlloc'd buffer freed below.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut())
        };
        if converted == 0 {
            return None;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name = wide(PIPE_NAME);
        // SAFETY: all pointers are valid for the duration of the call.
        let pipe = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                3, // PIPE_ACCESS_DUPLEX
                PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                512,
                512,
                0,
                &attributes,
            )
        };
        // SAFETY: `descriptor` was allocated by the conversion call above.
        unsafe { LocalFree(descriptor) };
        (pipe != INVALID_HANDLE_VALUE).then_some(pipe)
    }

    fn handle_client(pipe: HANDLE) {
        let mut buffer = [0u8; 64];
        let mut read = 0u32;
        // SAFETY: `buffer` is valid for `buffer.len()` bytes.
        let ok = unsafe { ReadFile(pipe, buffer.as_mut_ptr().cast(), buffer.len() as u32, &mut read, null_mut()) } != 0;
        let command = std::str::from_utf8(&buffer[..if ok { read as usize } else { 0 }]).unwrap_or("").trim().to_string();
        if command == "on" {
            let slot = lease_on();
            let reply = match &slot {
                Ok(_) => "ok
".to_string(),
                Err(message) => format!("{message}
"),
            };
            write_pipe(pipe, reply.as_bytes());
            if let Ok(slot) = slot {
                // Hold the lease until the client closes the pipe, which also happens if it crashes.
                loop {
                    let mut sink = [0u8; 16];
                    let mut got = 0u32;
                    // SAFETY: `sink` is valid for its length.
                    let ok = unsafe { ReadFile(pipe, sink.as_mut_ptr().cast(), sink.len() as u32, &mut got, null_mut()) } != 0;
                    if !ok || got == 0 {
                        break;
                    }
                }
                lease_off(slot);
            }
        } else {
            write_pipe(pipe, b"unknown command\n");
        }
        // SAFETY: closing the handle this thread owns.
        unsafe {
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
        }
    }

    fn write_pipe(pipe: HANDLE, bytes: &[u8]) {
        let mut written = 0u32;
        // SAFETY: `bytes` is valid for its length.
        unsafe { WriteFile(pipe, bytes.as_ptr().cast(), bytes.len() as u32, &mut written, null_mut()) };
    }

    /// Each lease is one virtual monitor on a device of its own, so each phone extending onto the PC
    /// holds its own and leaving never disturbs the others. Returns the slot the lease occupies.
    fn lease_on() -> Result<usize, String> {
        let _guard = DEVICE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut slots = SLOTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(slot) = slots.iter().position(|taken| !taken) else {
            return Err(format!("At most {MAX_MONITORS} phones can extend this PC at once"));
        };
        switch_on(slot)?;
        slots[slot] = true;
        Ok(slot)
    }

    fn lease_off(slot: usize) {
        let _guard = DEVICE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        switch_off(slot);
        SLOTS.lock().unwrap_or_else(|e| e.into_inner())[slot] = false;
    }

    // ---- Device control -------------------------------------------------------------------

    /// The driver package installed next to this executable by the installer.
    fn inf_path() -> Result<PathBuf, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let inf = exe.parent().ok_or("no install folder")?.join("vendor").join("vdd").join("MttVDD.inf");
        if inf.exists() { Ok(inf) } else { Err("The display driver is not installed".into()) }
    }

    struct DeviceSet(HDEVINFO);
    impl Drop for DeviceSet {
        fn drop(&mut self) {
            // SAFETY: the set was created by SetupDi and is destroyed once.
            unsafe { SetupDiDestroyDeviceInfoList(self.0) };
        }
    }

    fn device_data() -> SP_DEVINFO_DATA {
        SP_DEVINFO_DATA { cbSize: size_of::<SP_DEVINFO_DATA>() as u32, ClassGuid: DISPLAY_CLASS, DevInst: 0, Reserved: 0 }
    }


    fn change_state(set: &DeviceSet, data: &mut SP_DEVINFO_DATA, state: u32) -> Result<(), String> {
        let params = SP_PROPCHANGE_PARAMS {
            ClassInstallHeader: SP_CLASSINSTALL_HEADER {
                cbSize: size_of::<SP_CLASSINSTALL_HEADER>() as u32,
                InstallFunction: DIF_PROPERTYCHANGE,
            },
            StateChange: state,
            Scope: DICS_FLAG_GLOBAL,
            HwProfile: 0,
        };
        // SAFETY: `params` begins with the header the API requires and outlives both calls.
        unsafe {
            if SetupDiSetClassInstallParamsW(set.0, data, &params.ClassInstallHeader, size_of::<SP_PROPCHANGE_PARAMS>() as u32) == 0
                || SetupDiCallClassInstaller(DIF_PROPERTYCHANGE, set.0, data) == 0
            {
                return Err(format!("Could not change the display state (error {})", GetLastError()));
            }
        }
        Ok(())
    }

    /// The driver's settings file, which says how many virtual monitors it brings up.
    fn settings_path() -> PathBuf {
        PathBuf::from(r"C:\VirtualDisplayDriver\vdd_settings.xml")
    }

    /// Writes the number of monitors into the driver's settings, restoring the packaged file first
    /// if it is missing. The driver reads it when its device starts.
    fn write_monitor_count(count: usize) -> Result<(), String> {
        let path = settings_path();
        if !path.exists() {
            let packaged = inf_path()?.with_file_name("vdd_settings.xml");
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            std::fs::copy(&packaged, &path).map_err(|e| format!("Could not set up the display settings: {e}"))?;
        }
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let updated = with_monitor_count(&text, count).ok_or("The display settings have no monitor count")?;
        std::fs::write(&path, updated).map_err(|e| format!("Could not change the display settings: {e}"))
    }

    /// `text` with the first `<count>` value (the monitor count) replaced.
    fn with_monitor_count(text: &str, count: usize) -> Option<String> {
        let open = text.find("<count>")? + "<count>".len();
        let close = open + text[open..].find("</count>")?;
        Some(format!("{}{}{}", &text[..open], count, &text[close..]))
    }

    /// Every virtual display device Link has created, in a fixed order (by instance id), so slot `n`
    /// is always the same device. Each phone gets a device of its own: switching one on or off
    /// restarts only that device, never the monitors other phones are using.
    struct Devices {
        set: DeviceSet,
        items: Vec<SP_DEVINFO_DATA>,
    }

    fn list_devices() -> Devices {
        // SAFETY: the class GUID is a valid constant; null enumerator and window are allowed.
        let raw = unsafe { SetupDiGetClassDevsW(&DISPLAY_CLASS, null(), null_mut(), 0) };
        let set = DeviceSet(raw);
        let mut found: Vec<(String, SP_DEVINFO_DATA)> = Vec::new();
        if raw != INVALID_HANDLE_VALUE as HDEVINFO {
            let mut index = 0;
            loop {
                let mut data = device_data();
                // SAFETY: `data` is initialised with its size as the API requires.
                if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut data) } == 0 {
                    break;
                }
                index += 1;
                let mut buffer = [0u16; 256];
                // SAFETY: `buffer` is valid for the byte length passed.
                let got = unsafe {
                    SetupDiGetDeviceRegistryPropertyW(set.0, &data, SPDRP_HARDWAREID, null_mut(), buffer.as_mut_ptr().cast(), (buffer.len() * 2) as u32, null_mut())
                };
                if got == 0 {
                    continue;
                }
                let id = String::from_utf16_lossy(&buffer).trim_end_matches('\0').to_string();
                // A multi-string: the first entry is enough.
                if !id.split('\0').next().is_some_and(|first| first.eq_ignore_ascii_case(HARDWARE_ID)) {
                    continue;
                }
                let mut instance = [0u16; 256];
                // SAFETY: `instance` is valid for its length in characters.
                let ok = unsafe { SetupDiGetDeviceInstanceIdW(set.0, &data, instance.as_mut_ptr(), instance.len() as u32, null_mut()) };
                let name = if ok != 0 { String::from_utf16_lossy(&instance).trim_end_matches('\0').to_string() } else { String::new() };
                found.push((name, data));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        Devices { set, items: found.into_iter().map(|(_, data)| data).collect() }
    }

    /// Brings slot `slot`'s monitor up, creating its device if this is the first time it is used.
    /// Other slots are not touched.
    fn switch_on(slot: usize) -> Result<(), String> {
        // Each device brings up one monitor.
        write_monitor_count(1)?;
        let mut devices = list_devices();
        while devices.items.len() <= slot {
            create_device(devices.items.is_empty())?;
            devices = list_devices();
        }
        let mut data = devices.items[slot];
        change_state(&devices.set, &mut data, DICS_ENABLE)
    }

    /// Takes slot `slot`'s monitor away, leaving every other one exactly as it is.
    fn switch_off(slot: usize) {
        let mut devices = list_devices();
        if let Some(mut data) = devices.items.get(slot).copied() {
            let _ = change_state(&devices.set, &mut data, DICS_DISABLE);
        }
        devices.items.clear();
    }

    /// Switches every virtual monitor off.
    fn switch_all_off() {
        let devices = list_devices();
        for mut data in devices.items.iter().copied() {
            let _ = change_state(&devices.set, &mut data, DICS_DISABLE);
        }
    }

    /// Creates one more display device. The very first one force-installs the driver; later ones only
    /// install it for themselves, so the devices that are already running are not restarted.
    fn create_device(first: bool) -> Result<(), String> {
        let inf = inf_path()?;
        // SAFETY: the class GUID is a valid constant.
        let set = unsafe { SetupDiCreateDeviceInfoList(&DISPLAY_CLASS, null_mut()) };
        if set == INVALID_HANDLE_VALUE as HDEVINFO {
            return Err("Could not create the display device".into());
        }
        let set = DeviceSet(set);
        let name = wide(DEVICE_NAME);
        let mut data = device_data();
        // The hardware id is a multi-string, so it ends with two NULs.
        let id: Vec<u16> = HARDWARE_ID.encode_utf16().chain([0, 0]).collect();
        let inf = wide(&inf.to_string_lossy());
        let hardware = wide(HARDWARE_ID);
        let mut reboot = 0;
        // SAFETY: every pointer is valid for the duration of its call.
        unsafe {
            if SetupDiCreateDeviceInfoW(set.0, name.as_ptr(), &DISPLAY_CLASS, null(), null_mut(), DICD_GENERATE_ID, &mut data) == 0
                || SetupDiSetDeviceRegistryPropertyW(set.0, &mut data, SPDRP_HARDWAREID, id.as_ptr().cast(), (id.len() * 2) as u32) == 0
                || SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set.0, &mut data) == 0
            {
                return Err(format!("Could not create the display device (error {})", GetLastError()));
            }
            if UpdateDriverForPlugAndPlayDevicesW(null_mut(), hardware.as_ptr(), inf.as_ptr(), if first { INSTALLFLAG_FORCE } else { 0 }, &mut reboot) == 0 {
                return Err(format!("Could not install the display driver (error {})", GetLastError()));
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::with_monitor_count;

        #[test]
        fn the_monitor_count_is_rewritten_and_nothing_else() {
            let xml = "<vdd_settings><monitors><count>1</count></monitors><x><count>9</count></x></vdd_settings>";
            assert_eq!(
                with_monitor_count(xml, 3).as_deref(),
                Some("<vdd_settings><monitors><count>3</count></monitors><x><count>9</count></x></vdd_settings>")
            );
            assert_eq!(with_monitor_count("<vdd_settings/>", 2), None);
        }
    }
}

/// Puts every connected monitor on the desktop side by side. Windows can leave freshly added virtual
/// monitors duplicated onto another screen ("1|2") instead, and then a phone has nothing to show.
#[cfg(windows)]
pub fn extend_desktop() {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetDisplayConfig(paths: u32, path_info: *const u8, modes: u32, mode_info: *const u8, flags: u32) -> i32;
    }
    const SDC_TOPOLOGY_EXTEND: u32 = 0x4;
    const SDC_APPLY: u32 = 0x80;
    // SAFETY: with SDC_TOPOLOGY_EXTEND no path or mode arrays are passed, so all pointers are null.
    let code = unsafe { SetDisplayConfig(0, std::ptr::null(), 0, std::ptr::null(), SDC_APPLY | SDC_TOPOLOGY_EXTEND) };
    if code != 0 {
        log::info!("could not extend the desktop (error {code})");
    }
}

#[cfg(not(windows))]
pub fn extend_desktop() {}
