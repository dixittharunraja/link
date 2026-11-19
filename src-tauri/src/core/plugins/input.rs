// Mouse and keyboard injection for remote input. Takes the same one-line commands the phone sends
// over the UDP relay ("move dx dy", "click left", "special 12", ...), so the relay can hand lines
// straight through. Windows only; elsewhere every command is ignored.

#[cfg(windows)]
mod imp {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SetCursorPos, SM_CXSCREEN, SM_CYSCREEN};

    // Fractional motion that rounding dropped, carried into the next event so slow drags aren't lost.
    #[derive(Default)]
    struct Carry {
        x: f64,
        y: f64,
        scroll: f64,
    }
    static CARRY: Mutex<Carry> = Mutex::new(Carry { x: 0.0, y: 0.0, scroll: 0.0 });

    fn send(inputs: &[INPUT]) {
        unsafe {
            SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn mouse(flags: u32, dx: i32, dy: i32, data: i32) -> INPUT {
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.r#type = INPUT_MOUSE;
        input.Anonymous.mi = MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 };
        input
    }

    fn key(vk: u16, scan: u16, flags: u32) -> INPUT {
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.r#type = INPUT_KEYBOARD;
        input.Anonymous.ki = KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 };
        input
    }

    fn tap(vk: u16) {
        send(&[key(vk, 0, 0), key(vk, 0, KEYEVENTF_KEYUP)]);
    }

    fn chord(modifier: u16, vk: u16) {
        send(&[key(modifier, 0, 0), key(vk, 0, 0), key(vk, 0, KEYEVENTF_KEYUP), key(modifier, 0, KEYEVENTF_KEYUP)]);
    }

    fn unicode(code: u16) {
        send(&[key(0, code, KEYEVENTF_UNICODE), key(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]);
    }

    fn click(down: u32, up: u32) {
        send(&[mouse(down | up, 0, 0, 0)]);
    }

    fn special(code: i32) {
        if code < 0 {
            return unicode((-code) as u16);
        }
        match code {
            40 => chord(VK_CONTROL, b'A' as u16),
            41 => chord(VK_CONTROL, b'C' as u16),
            42 => chord(VK_CONTROL, b'V' as u16),
            43 => chord(VK_CONTROL, b'X' as u16),
            1 => tap(VK_BACK),
            4 => tap(VK_LEFT),
            5 => tap(VK_UP),
            6 => tap(VK_RIGHT),
            7 => tap(VK_DOWN),
            8 => tap(VK_PRIOR),
            9 => tap(VK_NEXT),
            12 => tap(VK_RETURN),
            14 => tap(VK_ESCAPE),
            25 => tap(VK_F5),
            31 => tap(VK_F11),
            _ => {}
        }
    }

    pub fn screen_size() -> (f64, f64) {
        unsafe { (GetSystemMetrics(SM_CXSCREEN) as f64, GetSystemMetrics(SM_CYSCREEN) as f64) }
    }

    /// When the left button was last pressed or released by a line, and which. A sender over UDP
    /// may repeat "hold left" and "release left" so a lost datagram cannot leave the button stuck;
    /// a repeat that arrives soon after the first is dropped, so it does not press or release twice.
    static LEFT_BUTTON: Mutex<Option<(bool, Instant)>> = Mutex::new(None);
    const REPEAT_WINDOW: Duration = Duration::from_millis(500);

    fn left_button(down: bool) {
        if let Ok(mut last) = LEFT_BUTTON.lock() {
            if last.is_some_and(|(was_down, at)| was_down == down && at.elapsed() < REPEAT_WINDOW) {
                return;
            }
            *last = Some((down, Instant::now()));
        }
        send(&[mouse(if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP }, 0, 0, 0)]);
    }

    pub fn run(line: &str) {
        // A line's words, split once into a fixed array (no command has more than three).
        let mut words = [""; 4];
        let mut count = 0;
        for (slot, word) in words.iter_mut().zip(line.split_whitespace()) {
            *slot = word;
            count += 1;
        }
        let parts = &words[..count];
        let num = |i: usize| parts.get(i).and_then(|p| p.parse::<f64>().ok());
        match parts {
            ["move", ..] => {
                let (Some(dx), Some(dy)) = (num(1), num(2)) else { return };
                let Ok(mut carry) = CARRY.lock() else { return };
                let (raw_x, raw_y) = (dx + carry.x, dy + carry.y);
                let (ix, iy) = (raw_x.round() as i32, raw_y.round() as i32);
                carry.x = raw_x - ix as f64;
                carry.y = raw_y - iy as f64;
                if ix != 0 || iy != 0 {
                    send(&[mouse(MOUSEEVENTF_MOVE, ix, iy, 0)]);
                }
            }
            ["abs", ..] => {
                let (Some(rx), Some(ry)) = (num(1), num(2)) else { return };
                send(&[mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, (rx * 65535.0) as i32, (ry * 65535.0) as i32, 0)]);
            }
            ["setpos", ..] => {
                let (Some(x), Some(y)) = (num(1), num(2)) else { return };
                unsafe { SetCursorPos(x as i32, y as i32) };
            }
            ["touch", state] => {
                let down = *state == "true";
                send(&[mouse(if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP }, 0, 0, 0)]);
            }
            ["click", button] => match *button {
                "left" => click(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                "right" => click(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle" => click(MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                "double" => {
                    click(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
                    click(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
                }
                _ => {}
            },
            ["hold", "left"] => left_button(true),
            ["release", "left"] => left_button(false),
            ["scroll", ..] => {
                let Some(dy) = num(2) else { return };
                let Ok(mut carry) = CARRY.lock() else { return };
                let raw = dy * 120.0 + carry.scroll;
                let notches = raw.round() as i32;
                carry.scroll = raw - notches as f64;
                if notches != 0 {
                    send(&[mouse(MOUSEEVENTF_WHEEL, 0, 0, notches)]);
                }
            }
            ["key", name] => match *name {
                "playpause" => tap(VK_MEDIA_PLAY_PAUSE),
                "next" => tap(VK_MEDIA_NEXT_TRACK),
                "prev" => tap(VK_MEDIA_PREV_TRACK),
                "stop" => tap(VK_MEDIA_STOP),
                _ => {}
            },
            ["unicode", code] => {
                if let Ok(c) = code.parse::<i32>() {
                    unicode(c as u16);
                }
            }
            ["special", code] => {
                if let Ok(c) = code.parse::<i32>() {
                    special(c);
                }
            }
            ["undo"] => chord(VK_CONTROL, b'Z' as u16),
            ["redo"] => chord(VK_CONTROL, b'Y' as u16),
            _ => {}
        }
    }
}

#[cfg(windows)]
pub use imp::{run as run_line, screen_size};

#[cfg(not(windows))]
pub fn run_line(_line: &str) {}

#[cfg(not(windows))]
pub fn screen_size() -> (f64, f64) {
    (1920.0, 1080.0)
}
