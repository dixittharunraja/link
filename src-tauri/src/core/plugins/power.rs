// Lock-screen and battery state for the local machine. Windows only; other platforms report
// "no battery" and refuse to lock.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Battery {
    pub is_charging: bool,
    pub charge: u32,
}

#[cfg(windows)]
pub fn battery() -> Option<Battery> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
        return None;
    }
    // 128 = no battery fitted, 255 = charge level unknown.
    if status.BatteryFlag & 128 != 0 || status.BatteryLifePercent == 255 {
        return None;
    }
    // Plugged in counts as charging: a full or conservation-capped battery on the charger has no "charging" flag (8),
    // and showing it as discharging is wrong. ACLineStatus 1 = on AC power.
    Some(Battery { is_charging: status.BatteryFlag & 8 != 0 || status.ACLineStatus == 1, charge: status.BatteryLifePercent as u32 })
}

#[cfg(not(windows))]
pub fn battery() -> Option<Battery> {
    None
}

#[cfg(windows)]
pub fn lock_workstation() -> bool {
    unsafe { windows_sys::Win32::System::Shutdown::LockWorkStation() != 0 }
}

#[cfg(not(windows))]
pub fn lock_workstation() -> bool {
    false
}

/// True while the secure desktop (lock screen) is showing: the input desktop can't be opened then.
#[cfg(windows)]
pub fn is_locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, SwitchDesktop};
    const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if desktop.is_null() {
            return true;
        }
        let locked = SwitchDesktop(desktop) == 0;
        CloseDesktop(desktop);
        locked
    }
}

#[cfg(not(windows))]
pub fn is_locked() -> bool {
    false
}
