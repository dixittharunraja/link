use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use socket2::{Domain, Socket, Type};
use tokio::net::UdpSocket;

use crate::core::plugins::input;
use crate::core::transport::DeviceManager;

// Low-latency path for phone input: one text line per UDP datagram on port 1717 ("move dx dy",
// "click left", "pmove dx dy", "dig x y true", ...). The sender is identified by its address, so a
// line only acts when it comes from a paired device holding the matching permission.

pub const INPUT_RELAY_PORT: u16 = 1717;

fn presenter() -> &'static crate::core::presenter::Presenter {
    static PRESENTER: std::sync::OnceLock<crate::core::presenter::Presenter> = std::sync::OnceLock::new();
    PRESENTER.get_or_init(Default::default)
}

pub fn stop_presenter(app: &tauri::AppHandle) {
    presenter().stop(app);
}

impl DeviceManager {
    pub async fn start_input_relay(self: &Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let raw = Socket::new(Domain::IPV4, Type::DGRAM, None)?;
        let _ = raw.set_reuse_address(true);
        raw.set_nonblocking(true)?;
        raw.bind(&SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), INPUT_RELAY_PORT).into())?;
        let socket = UdpSocket::from_std(raw.into())?;
        log::info!("Input relay listening on UDP port {}", INPUT_RELAY_PORT);

        let manager = self.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            loop {
                let Ok((len, from)) = socket.recv_from(&mut buf).await else { continue };
                let ip = from.ip().to_string();
                if manager.is_blocked(&ip) {
                    continue;
                }
                let line = String::from_utf8_lossy(&buf[..len]).trim().to_string();
                manager.handle_input_line(&ip, &line).await;
            }
        });
        Ok(())
    }

    async fn handle_input_line(&self, ip: &str, line: &str) {
        let sender = self.paired_device_at(ip).await;
        let allowed = |key: &str| sender.as_deref().is_some_and(|id| self.allowed(id, key));
        let presenter_ok = allowed("presenter") || self.input_guest_admitted(ip, "presenter");
        let input_ok = allowed("remoteinput") || self.input_guest_admitted(ip, "touchpad");
        let num = |i: usize| line.split_whitespace().nth(i).and_then(|p| p.parse::<f64>().ok());

        // Controller state goes straight to the joystick helper; only joined controllers are heard.
        if let Some(state) = line.strip_prefix("js ") {
            self.joystick_state(ip, state).await;
            return;
        }

        if let Some(id) = sender.as_deref() {
            if line.starts_with("pmove ") && allowed("presenter") {
                self.note_input_activity(id, "presenter").await;
            } else if input_ok && !line.starts_with("special ") && line != "pstop" {
                self.note_input_activity(id, "touchpad").await;
            }
        }

        if line.starts_with("pmove ") {
            if let (true, Some(app), Some(dx), Some(dy)) = (presenter_ok, self.app_handle().await, num(1), num(2)) {
                presenter().move_dot(app, dx, dy).await;
            }
        } else if line == "pstop" {
            if let (true, Some(app)) = (presenter_ok, self.app_handle().await) {
                presenter().stop(&app);
            }
        } else if line.starts_with("special ") {
            if presenter_ok || input_ok {
                input::run_line(line);
            }
        } else if line.starts_with("dig ") {
            if let (true, Some(x), Some(y)) = (input_ok, num(1), num(2)) {
                let touching = line.split_whitespace().nth(3) == Some("true");
                let (width, height) = self.digitizer_size().await;
                let (screen_w, screen_h) = input::screen_size();
                let rx = (x / width.max(1.0)).clamp(0.0, 1.0);
                let ry = (y / height.max(1.0)).clamp(0.0, 1.0);
                input::run_line(&format!("setpos {} {}", (rx * screen_w).round(), (ry * screen_h).round()));
                input::run_line(&format!("touch {}", touching));
            }
        } else if input_ok && !line.starts_with("js ") {
            // move / click / hold / release / scroll / key / unicode / undo / redo
            input::run_line(line);
        }
    }

    /// Sends one input line to a paired phone's input relay (desktop acting as the controller).
    pub async fn send_input_line(&self, device_id: &str, line: &str) -> Result<(), String> {
        static SOCKET: std::sync::OnceLock<std::net::UdpSocket> = std::sync::OnceLock::new();
        let ip = self
            .connected_peers()
            .await
            .iter()
            .find(|p| p["deviceId"].as_str() == Some(device_id))
            .and_then(|p| p["ipAddress"].as_str().map(str::to_string))
            .ok_or_else(|| format!("Device {} is not connected", device_id))?;
        let socket = match SOCKET.get() {
            Some(s) => s,
            None => {
                let bound = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
                SOCKET.get_or_init(|| bound)
            }
        };
        socket.send_to(line.as_bytes(), (ip.as_str(), INPUT_RELAY_PORT)).map_err(|e| e.to_string())?;
        Ok(())
    }
}
