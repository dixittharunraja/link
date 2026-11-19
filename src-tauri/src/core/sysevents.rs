use tokio::sync::mpsc;

// Windows tells a program when the clipboard changes, when the session is locked or unlocked, and when
// the power source or battery level changes, but only through messages to a window. One hidden
// message-only window on its own thread receives them and forwards them, so nothing has to wake up on
// a timer to ask.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// Something was copied.
    Clipboard,
    /// The session was locked (true) or unlocked (false).
    Locked(bool),
    /// The power source or battery level changed, or the PC woke from sleep.
    Power,
}

/// Starts listening and returns the stream of events.
pub fn start() -> mpsc::UnboundedReceiver<Event> {
    let (tx, rx) = mpsc::unbounded_channel();
    imp::spawn(tx);
    rx
}

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use tokio::sync::mpsc::UnboundedSender;
    use windows_sys::core::GUID;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::DataExchange::AddClipboardFormatListener;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Power::RegisterPowerSettingNotification;
    use windows_sys::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG,
        WM_CLIPBOARDUPDATE, WM_POWERBROADCAST, WNDCLASSW,
    };

    use super::Event;

    // Not exported by windows-sys under a feature we already build with.
    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
    const WTS_SESSION_LOCK: usize = 7;
    const WTS_SESSION_UNLOCK: usize = 8;
    const PBT_APMPOWERSTATUSCHANGE: usize = 0x000A;
    const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
    const PBT_POWERSETTINGCHANGE: usize = 0x8013;
    const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0;
    // GUID_ACDC_POWER_SOURCE and GUID_BATTERY_PERCENTAGE_REMAINING.
    const ACDC_POWER_SOURCE: GUID = GUID { data1: 0x5d3e9a59, data2: 0xe9d5, data3: 0x4b00, data4: [0xa6, 0xbd, 0xff, 0x34, 0xff, 0x51, 0x65, 0x48] };
    const BATTERY_PERCENTAGE: GUID = GUID { data1: 0xa7ad8041, data2: 0xb45a, data3: 0x4cae, data4: [0x87, 0xa3, 0xee, 0xcb, 0xb4, 0x68, 0xa9, 0xe1] };

    static SINK: OnceLock<UnboundedSender<Event>> = OnceLock::new();

    fn send(event: Event) {
        if let Some(tx) = SINK.get() {
            let _ = tx.send(event);
        }
    }

    unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match message {
            WM_CLIPBOARDUPDATE => send(Event::Clipboard),
            WM_WTSSESSION_CHANGE => match wparam {
                WTS_SESSION_LOCK => send(Event::Locked(true)),
                WTS_SESSION_UNLOCK => send(Event::Locked(false)),
                _ => {}
            },
            WM_POWERBROADCAST => {
                if matches!(wparam, PBT_APMPOWERSTATUSCHANGE | PBT_APMRESUMEAUTOMATIC | PBT_POWERSETTINGCHANGE) {
                    send(Event::Power);
                }
                return 1; // TRUE: the request is granted
            }
            _ => {}
        }
        // SAFETY: forwards the window procedure's own arguments unchanged.
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    pub fn spawn(tx: UnboundedSender<Event>) {
        if SINK.set(tx).is_err() {
            return;
        }
        let spawned = std::thread::Builder::new().name("link-sysevents".into()).spawn(|| unsafe {
            let class: Vec<u16> = "LinkSystemEvents\0".encode_utf16().collect();
            let instance = GetModuleHandleW(std::ptr::null());
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(window_proc);
            wc.hInstance = instance;
            wc.lpszClassName = class.as_ptr();
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), instance, std::ptr::null());
            if hwnd.is_null() {
                log::error!("Could not create the system event window");
                return;
            }
            AddClipboardFormatListener(hwnd);
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            RegisterPowerSettingNotification(hwnd as _, &ACDC_POWER_SOURCE, DEVICE_NOTIFY_WINDOW_HANDLE);
            RegisterPowerSettingNotification(hwnd as _, &BATTERY_PERCENTAGE, DEVICE_NOTIFY_WINDOW_HANDLE);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
        if spawned.is_err() {
            log::error!("Could not start the system event thread");
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Event;
    use tokio::sync::mpsc::UnboundedSender;

    // No events elsewhere; keep the sender alive so the receiver simply stays quiet.
    pub fn spawn(tx: UnboundedSender<Event>) {
        std::mem::forget(tx);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_a_clipboard_change() {
        let mut events = start();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        arboard::Clipboard::new().unwrap().set_text(format!("link-sysevents-{}", std::process::id())).unwrap();
        let got = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while let Some(event) = events.recv().await {
                if event == Event::Clipboard {
                    return true;
                }
            }
            false
        })
        .await;
        assert_eq!(got, Ok(true));
    }
}
