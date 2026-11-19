use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

use crate::core::packet::LinkPacket;
use crate::core::{camera_rx, openh264_lib, rtc_share};
use crate::core::permissions::PermissionStore;
use crate::core::plugins::media::{self, Session};
use crate::core::plugins::power::{self, Battery};
use crate::core::plugins::volume::{self, Sink};
use crate::core::plugins::{clipboard, input, location, ring, screensaver};
use crate::core::sysevents;
use crate::core::transport::DeviceManager;

// The plugins this desktop hosts for paired devices: it answers their requests, pushes state
// changes, and tells each peer which features it may use. Requests and outbound broadcasts are
// gated on the per-device permission store; display-only packets from a peer (notifications,
// battery, ...) are never gated here, the sending phone decides what to share.
//
// handle_host_packet returns true when it fully consumed a packet; otherwise the packet is also
// forwarded to the UI as a 'peer-packet' event.

// A player reports its new state through a media event a moment after a control is applied, and that
// event's state is what the peers get. A control the player ignores raises no event, so the state is
// sent anyway after this long (the phone may have shown the control as applied).
const MEDIA_CONTROL_SAFETY: Duration = Duration::from_secs(1);
const LOW_BATTERY_PERCENT: u32 = 15;
const RING_AUTO_STOP: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct PluginState {
    volume: Vec<Sink>,
    media: Vec<Session>,
    battery: Option<Battery>,
    // Device whose find-my-device request is currently ringing this PC.
    ringer: Option<String>,
    paused_by_call: bool,
    // Size of the phone's drawing surface for the digitizer, to normalise its coordinates.
    digitizer: (f64, f64),
    // One screen-share loop per phone: remote control of the main screen, or an extended screen.
    captures: std::collections::HashMap<String, Capture>,
    // The extra screen each extending phone owns, as a monitor id (0 until it has one). Phones keep
    // their own monitor when others come and go, so nobody else's windows move.
    screens: std::collections::HashMap<String, Arc<std::sync::atomic::AtomicU32>>,
    // The virtual monitor each phone switched on; dropping a lease removes only that phone's monitor.
    display_leases: std::collections::HashMap<String, crate::core::display_helper::DisplayLease>,
    // Phones whose camera this PC receives natively for the virtual webcam (see camera_rx.rs).
    camera_rx: std::collections::HashMap<String, CameraRx>,
    // When the UI was last asked to download the H.264 component, so a viewer's retries do not stack prompts.
    h264_prompted_at: Option<std::time::Instant>,
    // Last capability list each peer pushed, to notice when file access is granted or revoked.
    peer_capabilities: std::collections::HashMap<String, Vec<String>>,
    // When each paired device last drove the presenter dot or the remote input, by (device, mode).
    input_activity: std::collections::HashMap<(String, &'static str), std::time::Instant>,
    // The one device allowed to drive the presenter dot right now.
    presenter: Option<PresenterHolder>,
    // Volume requests not yet applied, by sink. A slider drag sends a request per step; only the
    // newest per sink is applied, and one reply goes out once the drag settles (apply_volume_requests).
    volume_pending: std::collections::HashMap<String, VolumeRequest>,
    volume_worker: bool,
    // The Windows change subscriptions for volume and media, alive only while a paired device is
    // connected (refresh_state_watchers), and where they deliver (set once by start_watchers).
    volume_watch: Option<volume::Watcher>,
    media_watch: Option<media::Watcher>,
    volume_events: Option<tokio::sync::mpsc::UnboundedSender<()>>,
    media_events: Option<tokio::sync::mpsc::UnboundedSender<Vec<Session>>>,
    // Set by a media control until the state that follows it has been sent (see media_control_sent);
    // the number tells a later control's wait apart from an earlier one's.
    media_control: Option<u64>,
    media_control_seq: u64,
}

#[derive(Default)]
struct VolumeRequest {
    volume: Option<u32>,
    muted: Option<bool>,
}

/// Whoever currently holds the single presenter slot. A guest holds it for as long as its socket
/// stays admitted; a paired device holds it while it keeps sending.
struct PresenterHolder {
    key: String,
    guest: bool,
    seen: std::time::Instant,
}

/// How long a paired device keeps the presenter slot after its last input.
const PRESENTER_LEASE: Duration = Duration::from_secs(15);

/// A running screen-share session to one phone.
struct Capture {
    handle: tokio::task::AbortHandle,
    started: std::time::Instant,
    display: crate::core::rtc_share::Display,
    // Where this phone's WebRTC answer and ICE candidates go.
    signals: tokio::sync::mpsc::UnboundedSender<crate::core::rtc_share::Signal>,
}

/// A running native camera session from one phone.
struct CameraRx {
    handle: tokio::task::AbortHandle,
    // Where the phone's WebRTC offer and ICE candidates go.
    signals: tokio::sync::mpsc::UnboundedSender<crate::core::camera_rx::CamSignal>,
    status: Arc<crate::core::camera_rx::Status>,
}

impl PluginState {
    /// Ends a phone's screen-share session and gives its screen up. Only this phone's virtual
    /// monitor is switched off, so the other phones' screens are left exactly as they are.
    fn drop_capture(&mut self, device_id: &str) {
        if let Some(capture) = self.captures.remove(device_id) {
            capture.handle.abort();
        }
        self.screens.remove(device_id);
        self.display_leases.remove(device_id);
    }
}

/// Only one phone at a time looks for a screen, so two never claim the same monitor.
static SCREENS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn volume_packet(sinks: &[Sink]) -> LinkPacket {
    let list: Vec<_> = sinks
        .iter()
        .map(|s| json!({ "name": s.id, "description": s.name, "volume": s.volume, "muted": s.muted, "maxVolume": 100, "enabled": true }))
        .collect();
    LinkPacket::new("link.systemvolume", json!({ "sinkList": list }))
}

fn battery_packet(b: Battery) -> LinkPacket {
    let low = b.charge <= LOW_BATTERY_PERCENT && !b.is_charging;
    LinkPacket::new(
        "link.battery",
        json!({ "isCharging": b.is_charging, "currentCharge": b.charge, "batteryQuantity": 1, "thresholdEvent": if low { 1 } else { 0 } }),
    )
}

fn lock_packet(is_locked: bool, result: Option<bool>) -> LinkPacket {
    let mut body = json!({ "isLocked": is_locked });
    if let Some(ok) = result {
        body["lockResult"] = json!(ok);
    }
    LinkPacket::new("link.lock", body)
}

fn media_packet(sessions: &[Session]) -> LinkPacket {
    let Some(active) = sessions.iter().find(|s| s.is_playing).or_else(|| sessions.first()) else {
        return LinkPacket::new(
            "link.mpris",
            json!({
                "playerList": [], "player": "", "title": "No Active Media", "artist": "", "album": "", "isPlaying": false,
                "canPlay": false, "canPause": false, "canGoNext": false, "canGoPrevious": false, "canSeek": false,
                "volume": 100, "length": 0, "pos": 0, "supportAlbumArtPayload": false,
            }),
        );
    };
    LinkPacket::new(
        "link.mpris",
        json!({
            "playerList": sessions.iter().map(|s| s.player.clone()).collect::<Vec<_>>(),
            "player": active.player, "title": active.title, "artist": active.artist, "album": active.album,
            "isPlaying": active.is_playing, "canPlay": active.can_play, "canPause": active.can_pause,
            "canGoNext": active.can_go_next, "canGoPrevious": active.can_go_previous, "canSeek": active.can_seek,
            "volume": 100, "length": active.length_ms, "pos": active.pos_ms, "supportAlbumArtPayload": false,
        }),
    )
}

// Playback position moves every second; sending the whole state each time it does would cost bandwidth
// for nothing (no screen shows it), so only a real change (track, play state, controls) counts.
fn same_media(a: &[Session], b: &[Session]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| Session { pos_ms: 0, ..x.clone() } == Session { pos_ms: 0, ..y.clone() })
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => false,
    }
}

// Maps a phone's touchpad request body onto the one-line input command protocol.
fn touchpad_line(body: &Value) -> Option<String> {
    let num = |k: &str| body.get(k).and_then(|v| v.as_f64());
    if truthy(body.get("scroll")) {
        return Some(format!("scroll {} {}", num("dx").unwrap_or(0.0), -num("dy").unwrap_or(0.0)));
    }
    if let (Some(dx), Some(dy)) = (num("dx"), num("dy")) {
        const SPEED: f64 = 2.0;
        return Some(format!("move {} {}", dx * SPEED, dy * SPEED));
    }
    let flag = |k: &str| truthy(body.get(k));
    if flag("singleclick") {
        Some("click left".into())
    } else if flag("doubleclick") {
        Some("click double".into())
    } else if flag("rightclick") {
        Some("click right".into())
    } else if flag("middleclick") {
        Some("click middle".into())
    } else if flag("singlehold") {
        Some("hold left".into())
    } else if flag("singlerelease") {
        Some("release left".into())
    } else {
        body.get("specialKey").and_then(|v| v.as_i64()).map(|k| format!("special {}", k))
    }
}

// Maps a viewer's remote-control input onto the one-line input command protocol.
/// Wheel notches for a finger moving the full height of the viewed screen.
const SCROLL_NOTCHES_PER_SCREEN: f64 = 6.0;

pub(crate) fn remote_control_lines(body: &Value) -> Vec<String> {
    let num = |k: &str, default: f64| body.get(k).and_then(|v| v.as_f64()).unwrap_or(default);
    match body.get("action").and_then(|v| v.as_str()) {
        Some("tap") | Some("click") => vec![
            format!("abs {} {}", num("x", 0.5), num("y", 0.5)),
            format!("click {}", body.get("button").and_then(|v| v.as_str()).unwrap_or("left")),
        ],
        // The wheel scrolls whatever is under the pointer, so the pointer first goes to where the finger is.
        // Then the finger's travel becomes wheel notches (six per full screen height), with the content
        // following the finger as on a touchscreen: a finger moving up scrolls the page down.
        Some("scroll") | Some("swipe") => vec![
            format!("abs {} {}", num("startX", 0.5), num("startY", 0.5)),
            format!("scroll 0 {}", (num("endY", 0.5) - num("startY", 0.5)) * SCROLL_NOTCHES_PER_SCREEN),
        ],
        Some("text") => body
            .get("text")
            .and_then(|v| v.as_str())
            .map(|t| t.encode_utf16().map(|unit| format!("unicode {}", unit)).collect())
            .unwrap_or_default(),
        Some("key") => match body.get("key").and_then(|v| v.as_str()) {
            Some("BACKSPACE") => vec!["special 1".into()],
            Some("ENTER") => vec!["special 12".into()],
            Some("BACK") => vec!["special 14".into()],
            _ => vec![],
        },
        _ => vec![],
    }
}

/// Moves an `abs` pointer position (0..1 across the main screen) onto the given monitor, in desktop
/// pixels. Other lines, and every line when there is no monitor, are left as they are.
pub(crate) fn place_on_monitor(line: String, monitor: Option<rtc_share::Rect>) -> String {
    let Some(m) = monitor else { return line };
    let parts: Vec<&str> = line.split_whitespace().collect();
    match parts.as_slice() {
        ["abs", x, y] => match (x.parse::<f64>(), y.parse::<f64>()) {
            (Ok(rx), Ok(ry)) => {
                let px = m.x + (rx.clamp(0.0, 1.0) * (m.width.saturating_sub(1)) as f64).round() as i32;
                let py = m.y + (ry.clamp(0.0, 1.0) * (m.height.saturating_sub(1)) as f64).round() as i32;
                format!("setpos {} {}", px, py)
            }
            _ => line,
        },
        _ => line,
    }
}

impl DeviceManager {
    pub(crate) fn permissions(&self) -> &std::sync::Mutex<PermissionStore> {
        &self.permission_store
    }

    pub(crate) fn allowed(&self, device_id: &str, key: &str) -> bool {
        self.permissions().lock().is_ok_and(|p| p.check(device_id, key))
    }

    /// Whether to act on something a peer pushed to this device (its clipboard, notifications, calls).
    /// The sender already applied its own permission, so only an explicit "off" for this device here
    /// refuses it; a device with no stored value keeps working as it always has.
    fn accepts_from(&self, device_id: &str, key: &str) -> bool {
        self.permissions().lock().map_or(true, |p| p.all().get(device_id).and_then(|d| d.get(key)) != Some(&Value::Bool(false)))
    }

    async fn emit(&self, event: &str, payload: Value) {
        if let Some(app) = self.app_handle().await {
            let _ = app.emit(event, payload);
        }
    }

    async fn toast(&self, title: &str, body: &str) {
        if let Some(app) = self.app_handle().await {
            let _ = app.notification().builder().title(title).body(body).show();
        }
    }

    pub(crate) async fn paired_peer_ids(&self) -> Vec<String> {
        self.connected_peers()
            .await
            .iter()
            .filter(|p| p["trusted"].as_bool() == Some(true))
            .filter_map(|p| p["deviceId"].as_str().map(str::to_string))
            .collect()
    }

    /// Paired device that currently owns this IP, if any (the UDP input relay identifies senders by address).
    pub(crate) async fn paired_device_at(&self, ip: &str) -> Option<String> {
        self.connected_peers()
            .await
            .iter()
            .find(|p| p["trusted"].as_bool() == Some(true) && p["ipAddress"].as_str() == Some(ip))
            .and_then(|p| p["deviceId"].as_str().map(str::to_string))
    }

    async fn broadcast_permitted(&self, key: &str, packet: impl Fn() -> LinkPacket) {
        for id in self.paired_peer_ids().await {
            if self.allowed(&id, key) {
                let _ = self.send_link_packet(&id, packet()).await;
            }
        }
    }

    async fn broadcast_paired(&self, packet: impl Fn() -> LinkPacket) {
        for id in self.paired_peer_ids().await {
            let _ = self.send_link_packet(&id, packet()).await;
        }
    }

    pub async fn broadcast_to_paired(&self, packet_type: &str, body: Value) {
        self.broadcast_paired(|| LinkPacket::new(packet_type, body.clone())).await;
    }

    /// Pushes this device's state to every paired peer and asks each to push theirs back (UI reload).
    pub async fn resync_all(&self) {
        for id in self.paired_peer_ids().await {
            self.initial_sync(&id).await;
            let _ = self.send_link_packet(&id, LinkPacket::new("link.resync.request", json!({}))).await;
        }
    }

    /// Tells one peer which of this device's features it may currently use.
    pub async fn push_capabilities(&self, device_id: &str) {
        let capabilities = self.permissions().lock().map(|p| p.effective(device_id)).unwrap_or_default();
        let _ = self.send_link_packet(device_id, LinkPacket::new("link.capabilities", json!({ "capabilities": capabilities }))).await;
    }

    pub async fn push_all_capabilities(&self) {
        for id in self.paired_peer_ids().await {
            self.push_capabilities(&id).await;
        }
    }

    fn command_list_packet(&self) -> LinkPacket {
        let list = self.run_commands.lock().map(|c| c.all()).unwrap_or_default();
        LinkPacket::new("link.runcommand", json!({ "commandList": serde_json::to_string(&list).unwrap_or_default(), "canAddCommand": false }))
    }

    /// Re-sends the command whitelist to every peer allowed to see it (after the user edits it).
    pub async fn broadcast_command_list(&self) {
        self.broadcast_permitted("runcommand", || self.command_list_packet()).await;
    }

    /// Sends a peer the full current state. Capabilities go first, so the peer's UI knows what to
    /// show before any state arrives.
    pub async fn initial_sync(&self, device_id: &str) {
        // Permissions added since this device was paired (Locate's "location") start on, as for a new pairing.
        if let Ok(mut store) = self.permissions().lock() {
            store.fill_missing(device_id);
        }
        self.push_capabilities(device_id).await;
        self.push_input_token(device_id).await;
        // The volume and media watchers do not run while nothing is paired and connected: this starts
        // them (with the display setting) and reads volume and media fresh, since nothing was heard.
        self.refresh_screensaver().await;
        if self.allowed(device_id, "systemvolume") {
            self.refresh_volume().await;
        }
        if self.allowed(device_id, "mpris") {
            self.refresh_media().await;
        }
        let (battery, sinks, sessions) = {
            let state = self.plugin_state.lock().await;
            (state.battery, state.volume.clone(), state.media.clone())
        };
        if let Some(b) = battery {
            let _ = self.send_link_packet(device_id, battery_packet(b)).await;
        }
        if self.allowed(device_id, "systemvolume") && !sinks.is_empty() {
            let _ = self.send_link_packet(device_id, volume_packet(&sinks)).await;
        }
        if self.allowed(device_id, "mpris") {
            let _ = self.send_link_packet(device_id, media_packet(&sessions)).await;
        }
        if self.allowed(device_id, "clipboard") {
            let (content, timestamp) = clipboard::snapshot();
            let _ = self
                .send_link_packet(device_id, LinkPacket::new("link.clipboard.connect", json!({ "content": content, "timestamp": timestamp })))
                .await;
        }
        if self.allowed(device_id, "runcommand") {
            let _ = self.send_link_packet(device_id, self.command_list_packet()).await;
        }
        // Mesh case: the peer may host its own command list.
        let _ = self.send_link_packet(device_id, LinkPacket::new("link.runcommand.request", json!({ "requestCommandList": true }))).await;
        // "Last seen": a device allowed to locate this one gets the newest remembered position, so it
        // still has one if this laptop is later lost. Last, and with a short timeout: this is not a search.
        if self.allowed(device_id, "location")
            && let Ok(Ok(fix)) = tokio::task::spawn_blocking(|| location::locate(Duration::from_secs(6 * 3600), Duration::from_secs(3), false)).await
        {
            let _ = self.send_link_packet(device_id, LinkPacket::new("link.location", fix)).await;
        }
    }

    /// A new pairing starts with every feature on; the user can switch any of them off.
    pub async fn on_paired(&self, device_id: &str) {
        if let Ok(mut store) = self.permissions().lock() {
            store.init_defaults(device_id);
        }
        self.initial_sync(device_id).await;
    }

    pub fn forget_permissions(&self, device_id: &str) {
        if let Ok(mut store) = self.permissions().lock() {
            store.delete(device_id);
        }
    }

    pub fn get_permissions(&self) -> Value {
        self.permissions().lock().map(|p| p.all()).unwrap_or_default()
    }

    pub async fn set_permissions(&self, all: Value) {
        if let Ok(mut store) = self.permissions().lock() {
            store.replace(all);
        }
        self.push_all_capabilities().await;
    }

    async fn peer_name(&self, device_id: &str) -> String {
        self.connected_peers()
            .await
            .iter()
            .find(|p| p["deviceId"].as_str() == Some(device_id))
            .and_then(|p| p["deviceName"].as_str().map(str::to_string))
            .unwrap_or_else(|| device_id.chars().take(8).collect())
    }

    /// Claims (or refreshes) the single presenter slot for `key`. Returns false while a different
    /// device holds it, in which case the caller must ignore that device's presenter input. Remote
    /// input and remote control are not limited: any number of devices may use them at once.
    pub(crate) async fn claim_presenter(&self, key: &str, guest: bool) -> bool {
        let mut state = self.plugin_state.lock().await;
        if let Some(holder) = &state.presenter {
            if holder.key != key && (holder.guest || holder.seen.elapsed() < PRESENTER_LEASE) {
                return false;
            }
        }
        state.presenter = Some(PresenterHolder { key: key.to_string(), guest, seen: std::time::Instant::now() });
        true
    }

    /// Frees the presenter slot if `key` holds it.
    pub(crate) async fn release_presenter(&self, key: &str) {
        let mut state = self.plugin_state.lock().await;
        if state.presenter.as_ref().is_some_and(|c| c.key == key) {
            state.presenter = None;
        }
    }

    pub(crate) async fn note_input_activity(&self, device_id: &str, mode: &'static str) {
        self.plugin_state.lock().await.input_activity.insert((device_id.to_string(), mode), std::time::Instant::now());
    }

    pub async fn clear_input_activity(&self, device_id: &str) {
        let mut state = self.plugin_state.lock().await;
        state.input_activity.retain(|(id, _), _| id != device_id);
        state.drop_capture(device_id);
        if state.presenter.as_ref().is_some_and(|c| c.key == device_id) {
            state.presenter = None;
        }
        drop(state);
        self.emit_event("input-guest-roster-changed", serde_json::Value::Null).await;
    }

    /// Paired devices that drove the presenter or remote input lately; phones send nothing while
    /// idle, so recent activity is the only sign of a session.
    pub async fn paired_input_sessions(&self) -> Vec<Value> {
        const LIVE_WINDOW: Duration = Duration::from_secs(15);
        let mut live: Vec<(String, &'static str)> = {
            let mut state = self.plugin_state.lock().await;
            state.input_activity.retain(|_, seen| seen.elapsed() < LIVE_WINDOW);
            state.input_activity.keys().cloned().collect()
        };
        // A peer receiving this screen for remote control counts as a session too.
        let streaming: Vec<(String, &'static str)> = self
            .plugin_state
            .lock()
            .await
            .captures
            .iter()
            .map(|(id, c)| (id.clone(), if c.display == rtc_share::Display::Extended { "extendscreen" } else { "remotecontrol" }))
            .collect();
        for (target, mode) in streaming {
            // Whichever way the phone is connected, it is one session, not two.
            live.retain(|(id, m)| *id != target || *m == mode || !matches!(*m, "remotecontrol" | "extendscreen"));
            if !live.iter().any(|(id, m)| *id == target && *m == mode) {
                live.push((target, mode));
            }
        }
        let store = self.trust_store.read().await;
        live.into_iter()
            .map(|(id, mode)| json!({ "deviceId": id, "name": store.get(&id).map(|d| d.device_name.clone()).unwrap_or_default(), "mode": mode }))
            .collect()
    }

    pub(crate) async fn digitizer_size(&self) -> (f64, f64) {
        self.plugin_state.lock().await.digitizer
    }

    /// Renames this device everywhere: identity file, discovery broadcasts, and every paired peer.
    pub async fn rename_self(&self, requested: &str) -> String {
        let current = self.device_name.read().await.clone();
        let name = crate::core::identity::save_device_name(&self.config_dir, requested)
            .unwrap_or_else(|_| crate::core::identity::received_device_name(requested).unwrap_or(current));
        *self.device_name.write().await = name.clone();
        self.discovery.set_device_name(name.clone());
        self.emit("own-device-renamed", json!({ "newName": name })).await;
        self.broadcast_paired(|| LinkPacket::new("link.rename", json!({ "deviceName": name }))).await;
        name
    }

    /// Asks a paired, connected peer to rename itself (names are self-owned, so this is a request).
    pub async fn request_peer_rename(&self, device_id: &str, name: &str) -> Result<(), String> {
        self.send_link_packet(device_id, LinkPacket::new("link.rename.request", json!({ "deviceName": name })))
            .await
            .map_err(|_| "Device must be connected to be renamed".to_string())
    }

    /// Whether this screen can be encoded: by the GPU's H.264 encoder, or else by Cisco's library.
    /// Only a PC without a working hardware encoder needs the library; if it is missing there the
    /// user is asked (at most once a minute) instead of failing quietly; viewers keep asking for
    /// the stream, so it starts by itself after the download.
    pub(crate) async fn h264_ready(&self) -> bool {
        // The hardware lookup is made once, on a blocking thread, and cached.
        let hardware = tokio::task::spawn_blocking(crate::core::h264_encoder::hardware_available).await.unwrap_or(false);
        if hardware || openh264_lib::is_installed(&self.config_dir) {
            return true;
        }
        let ask = {
            let mut state = self.plugin_state.lock().await;
            let due = state.h264_prompted_at.is_none_or(|t| t.elapsed() > Duration::from_secs(60));
            if due {
                state.h264_prompted_at = Some(std::time::Instant::now());
            }
            due
        };
        if ask {
            self.emit("h264-component-needed", Value::Null).await;
        }
        false
    }

    /// Streams this screen to `device_id` over WebRTC until asked to stop or the peer goes away.
    /// The viewer retries its request every few seconds until video arrives, so a request that
    /// lands while a session for the same peer is still being set up is ignored rather than
    /// restarting it.
    async fn start_screen_share(self: &Arc<Self>, device_id: &str, display: rtc_share::Display, viewport: Option<(u32, u32)>) {
        const SETTLE: Duration = Duration::from_secs(8);
        {
            let state = self.plugin_state.lock().await;
            let settling = state
                .captures
                .get(device_id)
                .is_some_and(|c| !c.handle.is_finished() && c.display == display && c.started.elapsed() < SETTLE);
            if settling {
                return;
            }
        }
        if !self.h264_ready().await {
            return;
        }
        // Only this phone's own session is replaced; other phones keep streaming, and the virtual
        // monitors stay on so restarting a stream does not switch them off and on again.
        let (signals_tx, signals_rx) = tokio::sync::mpsc::unbounded_channel();
        let screen = {
            let mut state = self.plugin_state.lock().await;
            match display {
                rtc_share::Display::Extended => state.screens.entry(device_id.to_string()).or_default().clone(),
                // A phone that switched back to the main screen no longer needs its own monitor.
                rtc_share::Display::Primary => {
                    state.screens.remove(device_id);
                    state.display_leases.remove(device_id);
                    Arc::new(std::sync::atomic::AtomicU32::new(0))
                }
            }
        };
        let viewer = rtc_share::Viewer::Paired(device_id.to_string());
        let task = tokio::spawn(rtc_share::run(self.clone(), viewer, display, screen.clone(), viewport, signals_rx));
        let mut state = self.plugin_state.lock().await;
        if let Some(old) = state.captures.remove(device_id) {
            old.handle.abort();
        }
        state.captures.insert(
            device_id.to_string(),
            Capture { handle: task.abort_handle(), started: std::time::Instant::now(), display, signals: signals_tx },
        );
    }

    /// Hands the viewer's WebRTC answer or ICE candidate to the running screen-share session.
    pub(crate) async fn forward_rtc_signal(&self, device_id: &str, body: &Value) -> bool {
        let Some(signal) = rtc_share::parse_signal(body) else { return false };
        let state = self.plugin_state.lock().await;
        // Only the peer this session is streaming to may steer it. For any other device these
        // packets are the other direction (this PC is the viewer and the phone is the host), so
        // they belong to the UI and must not be consumed here.
        if let Some(capture) = state.captures.get(device_id) {
            let _ = capture.signals.send(signal);
            return true;
        }
        false
    }

    /// Starts receiving `device_id`'s camera natively for the virtual webcam. Fails when the H.264
    /// component is missing; the UI then receives the camera itself.
    pub async fn start_camera_rx(self: &Arc<Self>, device_id: &str) -> Result<(), String> {
        if !camera_rx::available(&self.config_dir) {
            return Err("The H.264 component is not installed.".to_string());
        }
        let (signals_tx, signals_rx) = tokio::sync::mpsc::unbounded_channel();
        let status = Arc::new(camera_rx::Status::default());
        let task = tokio::spawn(camera_rx::run(self.clone(), device_id.to_string(), signals_rx, status.clone()));
        let session = CameraRx { handle: task.abort_handle(), signals: signals_tx, status };
        if let Some(old) = self.plugin_state.lock().await.camera_rx.insert(device_id.to_string(), session) {
            old.handle.abort();
        }
        Ok(())
    }

    pub async fn stop_camera_rx(&self, device_id: &str) {
        if let Some(old) = self.plugin_state.lock().await.camera_rx.remove(device_id) {
            old.handle.abort();
        }
    }

    /// How a native camera session is doing, for the UI.
    pub async fn camera_rx_status(&self, device_id: &str) -> Value {
        let session = self.plugin_state.lock().await.camera_rx.get(device_id).map(|s| s.status.clone());
        let mut status = session.map(|s| s.to_json()).unwrap_or_else(|| json!({ "offered": false, "live": false, "error": null }));
        status["available"] = json!(camera_rx::available(&self.config_dir));
        status
    }

    /// Hands the phone's WebRTC offer or ICE candidate to the native camera session, if there is one.
    pub(crate) async fn forward_camera_signal(&self, device_id: &str, body: &Value) -> bool {
        let Some(signal) = camera_rx::parse_signal(body) else { return false };
        match self.plugin_state.lock().await.camera_rx.get(device_id) {
            Some(session) => session.signals.send(signal).is_ok(),
            None => false,
        }
    }

    /// Gives `device_id` its own screen to extend onto: a real extra monitor nobody else is using,
    /// otherwise a virtual one that the installed helper service switches on just for this phone.
    /// Several phones can extend at once, and none of them disturbs the others' monitors. False
    /// when no screen could be found.
    async fn claim_extended_screen(&self, device_id: &str) -> bool {
        use std::sync::atomic::Ordering;
        let _serial = SCREENS.lock().await;
        self.rebind_screens().await;
        let (mine, claimed, mut leased) = {
            let mut state = self.plugin_state.lock().await;
            let mine = state.screens.entry(device_id.to_string()).or_default().clone();
            let claimed: Vec<u32> = state.screens.iter().filter(|(id, _)| *id != device_id).map(|(_, s)| s.load(Ordering::Relaxed)).collect();
            (mine, claimed, state.display_leases.contains_key(device_id))
        };
        // The viewer retries while it waits, so a phone that already has its screen is done.
        let connected = tokio::task::spawn_blocking(rtc_share::extra_screens).await.unwrap_or_default();
        if mine.load(Ordering::Relaxed) != 0 && connected.iter().any(|s| s.id == mine.load(Ordering::Relaxed)) {
            return true;
        }
        mine.store(0, Ordering::Relaxed);
        // Windows takes a moment to bring a new monitor up.
        for attempt in 0..50 {
            let screens = tokio::task::spawn_blocking(rtc_share::extra_screens).await.unwrap_or_default();
            let free = |wanted_virtual: bool| screens.iter().find(|s| s.is_virtual == wanted_virtual && !claimed.contains(&s.id)).copied();
            if let Some(screen) = free(leased) {
                mine.store(screen.id, Ordering::Relaxed);
                return true;
            }
            if !leased {
                // No spare real monitor: switch on a virtual one for this phone alone.
                match tokio::task::spawn_blocking(crate::core::display_helper::acquire).await {
                    Ok(Ok(lease)) => {
                        self.plugin_state.lock().await.display_leases.insert(device_id.to_string(), lease);
                        leased = true;
                        continue;
                    }
                    Ok(Err(reason)) => log::info!("virtual display unavailable: {reason}"),
                    Err(_) => {}
                }
                break;
            }
            if matches!(attempt, 6 | 16 | 30 | 44) {
                // New monitors can come up duplicated rather than extended; ask Windows to extend them.
                let _ = tokio::task::spawn_blocking(crate::core::display_helper::extend_desktop).await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        // Give up: this phone has no screen, and must not keep a monitor switched on for nothing.
        let mut state = self.plugin_state.lock().await;
        if !state.captures.contains_key(device_id) {
            state.screens.remove(device_id);
            state.display_leases.remove(device_id);
        }
        false
    }

    /// An unpaired guest extending this PC (input_guest.rs) gets its own screen the same way as a
    /// paired phone, keyed by its guest key. None when no screen could be found.
    pub(crate) async fn claim_guest_screen(&self, key: &str) -> Option<Arc<std::sync::atomic::AtomicU32>> {
        if !self.claim_extended_screen(key).await {
            return None;
        }
        self.plugin_state.lock().await.screens.get(key).cloned()
    }

    /// Gives a guest's extra screen up; a virtual monitor switched on for it goes off with its lease.
    pub(crate) async fn release_guest_screen(&self, key: &str) {
        let mut state = self.plugin_state.lock().await;
        state.screens.remove(key);
        state.display_leases.remove(key);
    }

    /// Points every phone that holds a virtual monitor at a monitor that still exists. Windows renumbers
    /// monitors when one comes or goes, so a phone's stored id can go stale while its monitor is fine.
    /// The caller holds `SCREENS`.
    async fn rebind_screens(&self) {
        use std::sync::atomic::Ordering;
        let screens = tokio::task::spawn_blocking(rtc_share::extra_screens).await.unwrap_or_default();
        let state = self.plugin_state.lock().await;
        let mut phones: Vec<(&String, u32, bool)> =
            state.screens.iter().map(|(id, s)| (id, s.load(Ordering::Relaxed), state.display_leases.contains_key(id))).collect();
        let mut ids: Vec<(u32, bool)> = phones.iter().map(|(_, id, leased)| (*id, *leased)).collect();
        rtc_share::rebind_virtual_screens(&mut ids, &screens);
        for ((device, old, _), (new, _)) in phones.drain(..).zip(ids) {
            if new != old {
                log::info!("[RemoteControl] {device}: its extended screen was renumbered ({old} -> {new})");
                state.screens[device].store(new, Ordering::Relaxed);
            }
        }
    }

    /// Called by a stream that cannot find its monitor any more.
    pub(crate) async fn reclaim_extended_screen(&self) {
        let _serial = SCREENS.lock().await;
        self.rebind_screens().await;
    }

    pub(crate) async fn stop_screen_share(&self, device_id: &str) {
        self.plugin_state.lock().await.drop_capture(device_id);
    }

    async fn broadcast_media(&self) {
        let sessions = media::sessions().await;
        self.plugin_state.lock().await.media = sessions.clone();
        self.broadcast_permitted("mpris", || media_packet(&sessions)).await;
    }

    /// After a media control: the state the player reports next (through the media watcher) is sent
    /// even if nothing changed, so a phone that showed the control as applied learns the truth. If the
    /// player raises no event, the state is read and sent after MEDIA_CONTROL_SAFETY.
    async fn media_control_sent(self: &Arc<Self>) {
        let seq = {
            let mut state = self.plugin_state.lock().await;
            state.media_control_seq += 1;
            state.media_control = Some(state.media_control_seq);
            state.media_control_seq
        };
        let mgr = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(MEDIA_CONTROL_SAFETY).await;
            let unanswered = {
                let mut state = mgr.plugin_state.lock().await;
                let unanswered = state.media_control == Some(seq);
                if unanswered {
                    state.media_control = None;
                }
                unanswered
            };
            if unanswered {
                mgr.broadcast_media().await;
            }
        });
    }

    /// Reads the media sessions and tells the permitted peers when something other than the
    /// playback position changed.
    async fn refresh_media(&self) {
        self.on_media_state(media::sessions().await).await;
    }

    /// Takes a media state (read fresh, or rebuilt by the media watcher after an event) and tells the
    /// permitted peers when something other than the playback position changed, or when a control is
    /// waiting for its answer.
    async fn on_media_state(&self, sessions: Vec<Session>) {
        let changed = {
            let mut state = self.plugin_state.lock().await;
            let changed = !same_media(&state.media, &sessions) || state.media_control.take().is_some();
            if changed {
                state.media = sessions.clone();
            }
            changed
        };
        if changed {
            self.broadcast_permitted("mpris", || media_packet(&sessions)).await;
        }
    }

    /// Reads the playback devices and tells the permitted peers when they changed. Nothing is sent
    /// while a peer's volume requests are being applied: apply_volume_requests replies with the
    /// result, and a read in between would send the requester a stale step.
    async fn refresh_volume(&self) {
        let sinks = volume::list().await;
        let changed = {
            let mut state = self.plugin_state.lock().await;
            let changed = !state.volume_worker && !sinks.is_empty() && state.volume != sinks;
            if changed {
                state.volume = sinks.clone();
            }
            changed
        };
        if changed {
            self.broadcast_permitted("systemvolume", || volume_packet(&sinks)).await;
        }
    }

    /// Applies queued volume requests, newest per sink, until none are left, then sends every
    /// permitted peer (the requester included) the result once. The stored state is updated too, so
    /// the change notifications this raises do not send the same state again and the requester's
    /// slider does not jump back.
    async fn apply_volume_requests(self: Arc<Self>) {
        loop {
            let next = {
                let mut state = self.plugin_state.lock().await;
                let sink = state.volume_pending.keys().next().cloned();
                sink.and_then(|s| state.volume_pending.remove_entry(&s))
            };
            match next {
                Some((sink, request)) => {
                    if let Some(percent) = request.volume {
                        volume::set_volume(sink.clone(), percent).await;
                    }
                    if let Some(muted) = request.muted {
                        volume::set_muted(sink, muted).await;
                    }
                }
                None => {
                    let sinks = volume::list().await;
                    {
                        let mut state = self.plugin_state.lock().await;
                        // A request that came in while the list was read is applied before replying.
                        if !state.volume_pending.is_empty() {
                            continue;
                        }
                        state.volume_worker = false;
                        if !sinks.is_empty() {
                            state.volume = sinks.clone();
                        }
                    }
                    self.broadcast_permitted("systemvolume", || volume_packet(&sinks)).await;
                    return;
                }
            }
        }
    }

    /// Keeps the display awake only while the setting is on and a paired device is connected.
    /// Called when a device connects, disconnects or is unpaired, and when the setting changes.
    pub async fn refresh_screensaver(&self) {
        let enabled = self.settings.lock().is_ok_and(|s| s.get_bool("screensaver_inhibit", true));
        let connected = !self.paired_peer_ids().await.is_empty();
        screensaver::set_wanted(enabled && connected);
        // Same lifecycle (every connect, disconnect and unpair passes through here).
        self.refresh_state_watchers(connected).await;
    }

    /// Subscribes to the Windows volume and media change events while a paired device is connected
    /// (nobody to tell otherwise) and drops the subscriptions when the last one goes.
    async fn refresh_state_watchers(&self, connected: bool) {
        let mut state = self.plugin_state.lock().await;
        if !connected {
            state.volume_watch = None;
            state.media_watch = None;
            return;
        }
        if state.volume_watch.is_none() {
            if let Some(tx) = state.volume_events.clone() {
                state.volume_watch = Some(volume::watch(move || {
                    let _ = tx.send(());
                }));
            }
        }
        if state.media_watch.is_none() {
            if let Some(tx) = state.media_events.clone() {
                state.media_watch = Some(media::watch(move |sessions| {
                    let _ = tx.send(sessions);
                }));
            }
        }
    }

    async fn stop_ringing(&self, device_id: &str, tell_peer: bool) {
        ring::stop();
        {
            let mut state = self.plugin_state.lock().await;
            if state.ringer.as_deref() == Some(device_id) {
                state.ringer = None;
            }
        }
        if tell_peer {
            let _ = self.send_link_packet(device_id, LinkPacket::new("link.findmydevice.request", json!({ "cancel": true }))).await;
        }
        self.emit("find-my-device-stopped", json!({ "deviceId": device_id })).await;
    }

    /// The user dismissed the ring on this PC: stop it and tell whoever asked.
    pub async fn stop_local_ringing(&self) {
        let ringer = self.plugin_state.lock().await.ringer.clone();
        match ringer {
            Some(id) => self.stop_ringing(&id, true).await,
            None => ring::stop(),
        }
    }

    /// Locate: a quick answer from a recent remembered fix, then a fresh precise one, then "done".
    /// On by default per device, like the other permissions; the user can switch it off.
    async fn on_location_request(self: &Arc<Self>, device_id: &str) {
        if !self.allowed(device_id, "location") {
            let _ = self.send_link_packet(device_id, LinkPacket::new("link.location", location::status_body("notAllowed"))).await;
            return;
        }
        let (host, id) = (self.clone(), device_id.to_string());
        tokio::spawn(async move {
            let send = |body: Value| {
                let (host, id) = (host.clone(), id.clone());
                async move {
                    let _ = host.send_link_packet(&id, LinkPacket::new("link.location", body)).await;
                }
            };
            let quick = tokio::task::spawn_blocking(|| location::locate(Duration::from_secs(1800), Duration::from_secs(3), false)).await;
            match quick {
                Ok(Err(e @ (location::Unavailable::NoPermission | location::Unavailable::Off))) => {
                    send(location::status_body(e.status())).await;
                    return;
                }
                Ok(Ok(fix)) => send(fix).await,
                _ => {}
            }
            let fresh = tokio::task::spawn_blocking(|| location::locate(Duration::ZERO, Duration::from_secs(25), true)).await;
            let status = match fresh {
                Ok(Ok(fix)) => {
                    send(fix).await;
                    "done"
                }
                Ok(Err(e)) => e.status(),
                Err(_) => "unavailable",
            };
            send(location::status_body(status)).await;
        });
    }

    async fn on_find_my_device(self: &Arc<Self>, device_id: &str, body: &Value) {
        // Ring is open to every paired device, like rename: no permission gate.
        if truthy(body.get("cancel")) {
            self.stop_ringing(device_id, false).await;
            return;
        }
        self.plugin_state.lock().await.ringer = Some(device_id.to_string());
        ring::start();
        self.emit("find-my-device-triggered", json!({ "deviceId": device_id })).await;
        let mgr = self.clone();
        let id = device_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(RING_AUTO_STOP).await;
            if mgr.plugin_state.lock().await.ringer.as_deref() == Some(id.as_str()) {
                mgr.stop_ringing(&id, true).await;
            }
        });
    }

    async fn on_telephony(self: &Arc<Self>, device_id: &str, body: &Value) {
        let event = body.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let is_cancel = truthy(body.get("isCancel"));
        // Only what a call starts is gated; whatever it already started (a pause, the ringing) is
        // always undone, even if the permission was switched off in between.
        let accepted = self.accepts_from(device_id, "telephony");

        // Pause whatever is playing while a call is active, resume afterwards.
        let any_playing = media::sessions().await.iter().any(|s| s.is_playing);
        let action = {
            let mut state = self.plugin_state.lock().await;
            if !is_cancel && matches!(event, "ringing" | "talking") {
                if accepted && any_playing && !state.paused_by_call {
                    state.paused_by_call = true;
                    Some("Pause")
                } else {
                    None
                }
            } else if state.paused_by_call {
                state.paused_by_call = false;
                Some("Play")
            } else {
                None
            }
        };
        if let Some(action) = action {
            self.media_control_sent().await;
            media::control(String::new(), action.to_string()).await;
        }

        if is_cancel || matches!(event, "cancelled" | "talking") {
            ring::stop();
        }
        if is_cancel || !accepted {
            return;
        }
        let name = body
            .get("contactName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| body.get("phoneNumber").and_then(|v| v.as_str()))
            .unwrap_or("Unknown Caller")
            .to_string();
        let number = body.get("phoneNumber").and_then(|v| v.as_str());
        match event {
            "ringing" => {
                ring::start();
                self.toast(&name, &number.map(|n| format!("Ringing: {}", n)).unwrap_or_else(|| "Incoming Call".into())).await;
            }
            "talking" => {
                self.toast(&name, &number.map(|n| format!("On call - {}", n)).unwrap_or_else(|| "On call".into())).await;
            }
            "missedCall" => {
                self.toast(&name, &number.map(|n| format!("Missed call from: {}", n)).unwrap_or_else(|| "Missed Call".into())).await;
            }
            _ => {}
        }
        let _ = device_id;
    }

    async fn on_notification(&self, device_id: &str, body: &Value) {
        if truthy(body.get("isCancel")) || !self.accepts_from(device_id, "notification") {
            return;
        }
        let app = body.get("appName").and_then(|v| v.as_str()).unwrap_or("").trim();
        let raw_title = body.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
        let text = body.get("text").and_then(|v| v.as_str()).or_else(|| body.get("ticker").and_then(|v| v.as_str())).unwrap_or("").trim();
        let peer = match body.get("sourceDeviceName").and_then(|v| v.as_str()) {
            Some(name) => name.trim().to_string(),
            None => self.peer_name(device_id).await,
        };

        let toast_title = if !peer.is_empty() && !app.is_empty() {
            format!("{} • {}", peer, app)
        } else if !peer.is_empty() {
            peer
        } else if !app.is_empty() {
            app.to_string()
        } else {
            "Notification".to_string()
        };

        let toast_body = if !raw_title.is_empty() && !text.is_empty() {
            format!("{}\n{}", raw_title, text)
        } else if !raw_title.is_empty() {
            raw_title.to_string()
        } else {
            text.to_string()
        };

        if !truthy(body.get("silent")) {
            self.toast(&toast_title, &toast_body).await;
        }
    }

    /// Handles a plugin packet from a paired peer; returns whether it was consumed.
    pub(crate) async fn handle_host_packet(self: &Arc<Self>, device_id: &str, pkt: &LinkPacket) -> bool {
        let body = &pkt.body;
        match pkt.packet_type.as_str() {
            crate::core::input_relay::PACKET_TYPE_INPUT_TOKEN => {
                self.store_peer_input_token(device_id, body).await;
                true
            }
            "link.systemvolume.request" => {
                if self.allowed(device_id, "systemvolume") {
                    let percent = body.get("volume").and_then(|v| v.as_f64()).map(|p| p.round().max(0.0) as u32);
                    let muted = body.get("muted").and_then(|v| v.as_bool());
                    match body.get("name").and_then(|v| v.as_str()).filter(|_| percent.is_some() || muted.is_some()) {
                        // Queued for apply_volume_requests, which replies once the drag settles.
                        Some(sink) => {
                            let start = {
                                let mut state = self.plugin_state.lock().await;
                                let pending = state.volume_pending.entry(sink.to_string()).or_default();
                                if percent.is_some() {
                                    pending.volume = percent;
                                }
                                if muted.is_some() {
                                    pending.muted = muted;
                                }
                                !std::mem::replace(&mut state.volume_worker, true)
                            };
                            if start {
                                tokio::spawn(self.clone().apply_volume_requests());
                            }
                        }
                        None => {
                            let _ = self.send_link_packet(device_id, volume_packet(&volume::list().await)).await;
                        }
                    }
                }
                true
            }
            // "lock" is in UNGATED_KEYS, so there is no permission check.
            "link.lock.request" => {
                let reply = if truthy(body.get("setLocked")) {
                    let ok = power::lock_workstation();
                    lock_packet(ok || power::is_locked(), Some(ok))
                } else {
                    lock_packet(power::is_locked(), None)
                };
                let _ = self.send_link_packet(device_id, reply).await;
                true
            }
            "link.findmydevice.request" => {
                self.on_find_my_device(device_id, body).await;
                true
            }
            "link.location.request" => {
                self.on_location_request(device_id).await;
                true
            }
            "link.clipboard" | "link.clipboard.connect" => {
                // The sender already decided to share; only clipboard sync switched off for this
                // device here refuses it (see accepts_from).
                let text = body.get("content").and_then(|v| v.as_str());
                let fresh = pkt.packet_type == "link.clipboard"
                    || body.get("timestamp").and_then(|v| v.as_i64()).is_some_and(|t| t >= clipboard::snapshot().1);
                // Not gated on this device's "clipboard" permission: that switch reads "send this device
                // your clipboard", so it only controls what goes out, never what a paired device sends in.
                if let (Some(text), true) = (text, fresh) {
                    clipboard::apply_remote(text);
                    self.emit("clipboard-received", json!({ "deviceId": device_id })).await;
                }
                true
            }
            "link.mpris.request" => {
                if self.allowed(device_id, "mpris") {
                    if let Some(action) = body.get("action").and_then(|v| v.as_str()) {
                        let player = body.get("player").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        self.media_control_sent().await;
                        media::control(player, action.to_string()).await;
                    } else {
                        self.broadcast_media().await;
                    }
                }
                true
            }
            "link.runcommand.request" => {
                if self.allowed(device_id, "runcommand") {
                    if truthy(body.get("requestCommandList")) {
                        let _ = self.send_link_packet(device_id, self.command_list_packet()).await;
                    } else if let Some(key) = body.get("key").and_then(|v| v.as_str()) {
                        if let Ok(commands) = self.run_commands.lock() {
                            commands.trigger(key);
                        }
                        self.emit("run-command-triggered", json!({ "deviceId": device_id, "key": key })).await;
                    }
                }
                true
            }
            "link.touchpad.request" => {
                if self.allowed(device_id, "remoteinput") {
                    self.note_input_activity(device_id, "touchpad").await;
                    if let Some(line) = touchpad_line(body) {
                        input::run_line(&line);
                    }
                }
                true
            }
            "link.digitizer.session" => {
                if self.allowed(device_id, "remoteinput") {
                    let mut state = self.plugin_state.lock().await;
                    if body.get("action").and_then(|v| v.as_str()) == Some("start") {
                        let size = |k: &str| body.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
                        state.digitizer = (size("width"), size("height"));
                    } else {
                        state.digitizer = (0.0, 0.0);
                        input::run_line("touch false");
                        drop(state);
                        self.clear_input_activity(device_id).await;
                    }
                }
                true
            }
            "link.digitizer" => {
                if self.allowed(device_id, "remoteinput") {
                    self.note_input_activity(device_id, "touchpad").await;
                    let (width, height) = self.plugin_state.lock().await.digitizer;
                    if body.get("active").and_then(|v| v.as_bool()) == Some(false) {
                        input::run_line("touch false");
                    } else {
                        if let Some(touching) = body.get("touching").and_then(|v| v.as_bool()) {
                            input::run_line(&format!("touch {}", touching));
                        }
                        if let (Some(x), Some(y), true) = (body.get("x").and_then(|v| v.as_f64()), body.get("y").and_then(|v| v.as_f64()), width > 0.0 && height > 0.0) {
                            input::run_line(&format!("abs {} {}", (x / width).clamp(0.0, 1.0), (y / height).clamp(0.0, 1.0)));
                        }
                    }
                }
                true
            }
            "link.fs.request" => {
                // Only "where is your file server" (fs_server.rs); the files themselves move over that
                // server's own connections. Spawned so binding the listener never holds up the packet reader.
                let (manager, device_id, request) = (self.clone(), device_id.to_string(), body.clone());
                tokio::spawn(async move {
                    let reply = crate::core::fs_server::handle_request(manager.clone(), device_id.clone(), request).await;
                    let _ = manager.send_link_packet(&device_id, LinkPacket::new("link.fs.response", reply)).await;
                });
                true
            }
            // Rename is open to every paired device. A peer asking this device to rename itself:
            // apply it, then announce the authoritative result to everyone.
            "link.rename.request" => {
                if let Some(name) = body.get("deviceName").and_then(|v| v.as_str()) {
                    self.rename_self(name).await;
                }
                true
            }
            // A peer announcing its own new name: keep the local alias for it in step.
            "link.rename" => {
                if let Some(name) = body.get("deviceName").and_then(|v| v.as_str()).and_then(crate::core::identity::received_device_name) {
                    let name = name.as_str();
                    self.trust_store.write().await.rename(device_id, name);
                    self.set_peer_name(device_id, name).await;
                    self.emit("device-renamed", json!({ "deviceId": device_id, "newName": name })).await;
                }
                true
            }
            "link.remotecontrol.signal" => {
                match body.get("type").and_then(|v| v.as_str()) {
                    Some("request") => {
                        if self.allowed(device_id, "remotecontrol") {
                            let display = rtc_share::Display::from_request(body);
                            if display == rtc_share::Display::Extended && !self.claim_extended_screen(device_id).await {
                                // Nothing to extend onto: the viewer says how to add a second screen.
                                let _ = self.send_link_packet(device_id, LinkPacket::new("link.remotecontrol.signal", json!({ "type": "no_second_screen" }))).await;
                            } else {
                                self.start_screen_share(device_id, display, rtc_share::viewport_from_request(body)).await;
                            }
                        } else {
                            let _ = self.send_link_packet(device_id, LinkPacket::new("link.remotecontrol.signal", json!({ "type": "denied" }))).await;
                        }
                    }
                    // The phone offering its camera to the native virtual-webcam receiver.
                    Some("webrtc_offer") => {
                        if self.forward_camera_signal(device_id, body).await {
                            return true;
                        }
                    }
                    Some("webrtc_answer") | Some("webrtc_candidate") => {
                        // A candidate may belong to either direction; each side ignores one that is not its own.
                        let camera = self.forward_camera_signal(device_id, body).await;
                        if self.forward_rtc_signal(device_id, body).await || camera {
                            return true;
                        }
                    }
                    Some("stop") => {
                        self.stop_screen_share(device_id).await;
                        self.clear_input_activity(device_id).await;
                    }
                    _ => {}
                }
                // The UI also needs to see the signal (a viewer receives 'denied', etc.).
                false
            }
            "link.remotecontrol.input" => {
                if self.allowed(device_id, "remotecontrol") {
                    // On the second screen, a tap lands on that monitor rather than the main one.
                    let screen = self.plugin_state.lock().await.screens.get(device_id).map(|s| s.load(std::sync::atomic::Ordering::Relaxed));
                    // A phone extending this PC is not remote-controlling it, and is listed as such.
                    self.note_input_activity(device_id, if screen.is_some() { "extendscreen" } else { "remotecontrol" }).await;
                    let monitor = match screen {
                        Some(screen) if screen != 0 => tokio::task::spawn_blocking(move || rtc_share::second_screen(screen)).await.ok().flatten(),
                        _ => None,
                    };
                    for line in remote_control_lines(body) {
                        input::run_line(&place_on_monitor(line, monitor));
                    }
                }
                true
            }
            // A peer's UI reloaded and wants the full state again.
            "link.resync.request" => {
                self.initial_sync(device_id).await;
                true
            }
            "link.audiosink.query" => {
                self.answer_audio_sink_query(device_id).await;
                true
            }
            "link.presenter" => {
                if truthy(body.get("stop")) && self.allowed(device_id, "presenter") && self.claim_presenter(device_id, false).await {
                    // Only the presenter can end the presentation; the claim is released with its activity.
                    self.clear_input_activity(device_id).await;
                    {
                        if let Some(app) = self.app_handle().await {
                            crate::core::input_relay::stop_presenter(&app);
                        }
                    }
                }
                true
            }
            "link.capabilities" => {
                let caps: Vec<String> = body
                    .get("capabilities")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let had = {
                    let mut state = self.plugin_state.lock().await;
                    let previous = state.peer_capabilities.insert(device_id.to_string(), caps.clone()).unwrap_or_default();
                    previous.iter().any(|c| c == "fileaccess")
                };
                let has = caps.iter().any(|c| c == "fileaccess");
                if has != had {
                    let mgr = self.clone();
                    let id = device_id.to_string();
                    tokio::spawn(async move { mgr.on_file_access_changed(&id, has).await });
                }
                // The UI needs the list too (it gates buttons on it).
                false
            }
            // Display-only packets from the phone: act on them here, and let the UI see them too.
            "link.telephony" => {
                self.on_telephony(device_id, body).await;
                false
            }
            "link.notification" => {
                self.on_notification(device_id, body).await;
                false
            }
            _ => false,
        }
    }

    /// Background pollers that push state changes to the peers allowed to see them.
    /// Reads the battery and tells paired devices when it changed.
    async fn refresh_battery(self: &Arc<Self>) {
        let now = power::battery();
        let changed = {
            let mut state = self.plugin_state.lock().await;
            let changed = now.is_some() && state.battery != now;
            state.battery = now;
            changed
        };
        if let (true, Some(b)) = (changed, now) {
            self.broadcast_paired(|| battery_packet(b)).await;
        }
    }

    pub fn start_watchers(self: &Arc<Self>) {
        // Volume and media changes are pushed by Windows too, through watchers that only exist while a
        // paired device is connected (refresh_state_watchers). They deliver here: the volume watcher
        // says something changed and the state is read fresh (refresh_volume skips it mid-drag), the
        // media watcher hands over the rebuilt state.
        let mgr = self.clone();
        let (volume_tx, mut volume_rx) = tokio::sync::mpsc::unbounded_channel();
        let (media_tx, mut media_rx) = tokio::sync::mpsc::unbounded_channel();
        tauri::async_runtime::spawn(async move {
            {
                let mut state = mgr.plugin_state.lock().await;
                state.volume_events = Some(volume_tx);
                state.media_events = Some(media_tx);
            }
            // A device may have connected before the senders were in place.
            mgr.refresh_state_watchers(!mgr.paired_peer_ids().await.is_empty()).await;
            loop {
                tokio::select! {
                    Some(()) = volume_rx.recv() => mgr.refresh_volume().await,
                    Some(sessions) = media_rx.recv() => mgr.on_media_state(sessions).await,
                    else => break,
                }
            }
        });

        // Clipboard, lock state and battery are pushed by Windows (see sysevents.rs) instead of being polled.
        let mgr = self.clone();
        let mut events = sysevents::start();
        tauri::async_runtime::spawn(async move {
            let mut locked = power::is_locked();
            mgr.refresh_battery().await;
            while let Some(event) = events.recv().await {
                match event {
                    sysevents::Event::Clipboard => {
                        // The program that copied may still hold the clipboard open for a moment.
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        let changed = tokio::task::spawn_blocking(clipboard::poll).await.ok().flatten();
                        if let Some(text) = changed {
                            mgr.broadcast_permitted("clipboard", || LinkPacket::new("link.clipboard", json!({ "content": text }))).await;
                        }
                    }
                    sysevents::Event::Locked(now) => {
                        if now != locked {
                            locked = now;
                            mgr.broadcast_paired(|| lock_packet(now, None)).await;
                        }
                    }
                    sysevents::Event::Power => mgr.refresh_battery().await,
                }
            }
        });

        // Keep the display awake only while the setting is on and a paired device is connected. A
        // connect applies it through initial_sync; a disconnect is heard here (transport.rs emits the
        // event after the peer is gone), and the settings and unpair commands apply it themselves.
        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            mgr.refresh_screensaver().await;
            if let Some(app) = mgr.app_handle().await {
                use tauri::Listener;
                let on_disconnect = mgr.clone();
                app.listen("device-disconnected", move |_| {
                    let mgr = on_disconnect.clone();
                    tauri::async_runtime::spawn(async move { mgr.refresh_screensaver().await });
                });
            }
        });
    }
}
