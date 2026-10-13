// Virtual Xbox 360 controllers through the ViGEmBus driver, for the joystick tool. The driver
// client is not thread-safe to share, so one dedicated thread owns it and everything else sends it
// commands. Rumble the games ask for comes back through a channel.

use tokio::sync::mpsc;

pub const MAX_PADS: usize = 4;

pub enum Command {
    Plug(usize),
    Unplug(usize),
    Report { slot: usize, lx: i32, ly: i32, rx: i32, ry: i32, lt: i32, rt: i32, buttons: i32 },
}

pub struct Rumble {
    pub slot: usize,
    pub large: u8,
    pub small: u8,
}

/// Why the driver could not be used.
#[derive(Debug, PartialEq, Eq)]
pub enum Unavailable {
    NotInstalled,
    Other(String),
}

pub struct Gamepads {
    commands: std::sync::mpsc::Sender<Command>,
}

impl Gamepads {
    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }
}

#[cfg(windows)]
mod imp {
    use super::{Command, Rumble, Unavailable, MAX_PADS};
    use tokio::sync::mpsc;
    use vigem_client::{Client, Error, TargetId, XButtons, XGamepad, Xbox360Wired};

    // The phone's button bits (see JoystickOverlay) against XInput's.
    const BUTTONS: [(i32, u16); 12] = [
        (1 << 0, XButtons::UP),
        (1 << 1, XButtons::DOWN),
        (1 << 2, XButtons::LEFT),
        (1 << 3, XButtons::RIGHT),
        (1 << 4, XButtons::START),
        (1 << 5, XButtons::BACK),
        (1 << 6, XButtons::LB),
        (1 << 7, XButtons::RB),
        (1 << 8, XButtons::A),
        (1 << 9, XButtons::B),
        (1 << 10, XButtons::X),
        (1 << 11, XButtons::Y),
    ];

    fn axis(value: i32) -> i16 {
        // -1000..1000 onto XInput's signed 16-bit range.
        (value.clamp(-1000, 1000) as f64 * 32.767).round() as i16
    }

    fn gamepad(rx: [i32; 4], lt: i32, rt: i32, buttons: i32) -> XGamepad {
        XGamepad {
            buttons: XButtons { raw: BUTTONS.iter().filter(|(bit, _)| buttons & bit != 0).fold(0, |raw, (_, flag)| raw | flag) },
            left_trigger: lt.clamp(0, 255) as u8,
            right_trigger: rt.clamp(0, 255) as u8,
            thumb_lx: axis(rx[0]),
            thumb_ly: axis(rx[1]),
            thumb_rx: axis(rx[2]),
            thumb_ry: axis(rx[3]),
        }
    }

    fn plug(client: &Client, slot: usize, rumble: &mpsc::UnboundedSender<Rumble>) -> Result<Xbox360Wired<Client>, Error> {
        let mut pad = Xbox360Wired::new(client.try_clone()?, TargetId::XBOX360_WIRED);
        pad.plugin()?;
        pad.wait_ready()?;
        let rumble = rumble.clone();
        pad.request_notification()?.spawn_thread(move |_, data| {
            let _ = rumble.send(Rumble { slot, large: data.large_motor, small: data.small_motor });
        });
        Ok(pad)
    }

    pub fn run(commands: std::sync::mpsc::Receiver<Command>, rumble: mpsc::UnboundedSender<Rumble>, ready: std::sync::mpsc::Sender<Result<(), Unavailable>>) {
        let client = match Client::connect() {
            Ok(client) => client,
            Err(Error::BusNotFound) => {
                let _ = ready.send(Err(Unavailable::NotInstalled));
                return;
            }
            Err(e) => {
                let _ = ready.send(Err(Unavailable::Other(e.to_string())));
                return;
            }
        };
        let _ = ready.send(Ok(()));

        let mut pads: [Option<Xbox360Wired<Client>>; MAX_PADS] = [None, None, None, None];
        while let Ok(command) = commands.recv() {
            match command {
                Command::Plug(slot) if slot < MAX_PADS && pads[slot].is_none() => match plug(&client, slot, &rumble) {
                    Ok(pad) => pads[slot] = Some(pad),
                    Err(e) => log::warn!("Could not plug in virtual pad {}: {}", slot, e),
                },
                Command::Unplug(slot) if slot < MAX_PADS => {
                    if let Some(mut pad) = pads[slot].take() {
                        let _ = pad.unplug();
                    }
                }
                Command::Report { slot, lx, ly, rx, ry, lt, rt, buttons } if slot < MAX_PADS => {
                    if let Some(pad) = pads[slot].as_mut() {
                        let _ = pad.update(&gamepad([lx, ly, rx, ry], lt, rt, buttons));
                    }
                }
                _ => {}
            }
        }
        // Every sender is gone: take the pads off the bus.
        for mut pad in pads.into_iter().flatten() {
            let _ = pad.unplug();
        }
    }
}

/// Connects to the driver and starts the thread that owns it.
#[cfg(windows)]
pub async fn start(rumble: mpsc::UnboundedSender<Rumble>) -> Result<Gamepads, Unavailable> {
    let (commands_tx, commands_rx) = std::sync::mpsc::channel();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || imp::run(commands_rx, rumble, ready_tx));
    tokio::task::spawn_blocking(move || ready_rx.recv().unwrap_or(Err(Unavailable::Other("the driver thread ended".into()))))
        .await
        .unwrap_or(Err(Unavailable::Other("the driver thread ended".into())))?;
    Ok(Gamepads { commands: commands_tx })
}

#[cfg(not(windows))]
pub async fn start(_rumble: mpsc::UnboundedSender<Rumble>) -> Result<Gamepads, Unavailable> {
    Err(Unavailable::Other("Virtual controllers are only available on Windows".into()))
}
