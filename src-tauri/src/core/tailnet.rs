// The devices on this PC's tailnet, so Link can announce itself to them directly.
//
// Discovery on a local network is a broadcast, and a broadcast does not cross Tailscale. While the Add
// Device screen is open, Link asks the Tailscale client for the tailnet's devices (`tailscale status
// --json`) and sends its announcement straight to each online one. A device running Link hears that,
// shows up in its list, and answers the same way. Pairing from there is the ordinary flow, approval
// included. The rest of the time announcements go only to known Link devices (core/reconnect.rs).

use std::io::Read;
use std::net::Ipv4Addr;
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
pub struct TailnetPeer {
    pub name: String,
    pub address: Ipv4Addr,
}

/// The online devices in `tailscale status --json`, by their IPv4 address.
pub fn parse_status(json: &str) -> Vec<TailnetPeer> {
    let Ok(status) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    let Some(peers) = status.get("Peer").and_then(|p| p.as_object()) else { return Vec::new() };
    peers
        .values()
        .filter(|peer| peer.get("Online").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|peer| {
            let address = peer
                .get("TailscaleIPs")?
                .as_array()?
                .iter()
                .filter_map(|ip| ip.as_str()?.parse::<Ipv4Addr>().ok())
                .next()?;
            let name = peer.get("HostName").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Some(TailnetPeer { name, address })
        })
        .collect()
}

#[cfg(windows)]
const CLI_CANDIDATES: &[&str] = &["tailscale", r"C:\Program Files\Tailscale\tailscale.exe"];
#[cfg(not(windows))]
const CLI_CANDIDATES: &[&str] = &["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

// A Tailscale client that is starting up, signing in or wedged can leave `status` hanging; the
// reconnect loop waits on this, so the child is killed past this long.
const CLI_TIMEOUT: Duration = Duration::from_secs(5);

/// The tailnet's online devices, or none when Tailscale is not installed or not signed in. Blocks while
/// the client answers (at most CLI_TIMEOUT per candidate), so call it off the async runtime.
pub fn peers() -> Vec<TailnetPeer> {
    for cli in CLI_CANDIDATES {
        if let Some(stdout) = run_status(cli) {
            return parse_status(&String::from_utf8_lossy(&stdout));
        }
    }
    Vec::new()
}

/// `<cli> status --json`'s output when it exits successfully within CLI_TIMEOUT.
fn run_status(cli: &str) -> Option<Vec<u8>> {
    let mut command = std::process::Command::new(cli);
    command.args(["status", "--json"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().ok()?;
    // Drained on its own thread so a large status cannot fill the pipe and stall the child.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                log::info!("`{} status` did not answer in time; giving up on it", cli);
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
