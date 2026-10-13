use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

use crate::core::packet::LinkPacket;
use crate::core::permissions::PermissionStore;
use crate::core::plugins::media::{self, Session};
use crate::core::plugins::power::{self, Battery};
use crate::core::plugins::volume::{self, Sink};
use crate::core::plugins::{clipboard, input, ring, screen, screensaver};
use crate::core::transport::DeviceManager;

// The plugins this desktop hosts for paired devices: it answers their requests, pushes state
// changes, and tells each peer which features it may use. Requests and outbound broadcasts are
// gated on the per-device permission store; display-only packets from a peer (notifications,
// battery, ...) are never gated here, the sending phone decides what to share.
//
// handle_host_packet returns true when it fully consumed a packet; otherwise the packet is also
// forwarded to the UI as a 'peer-packet' event.

const VOLUME_POLL: Duration = Duration::from_secs(2);
const LOCK_POLL: Duration = Duration::from_secs(2);
const MEDIA_POLL: Duration = Duration::from_secs(2);
const CLIPBOARD_POLL: Duration = Duration::from_secs(1);
const BATTERY_POLL: Duration = Duration::from_secs(30);
const HOUSEKEEPING_POLL: Duration = Duration::from_secs(5);
const LOW_BATTERY_PERCENT: u32 = 15;
const RING_AUTO_STOP: Duration = Duration::from_secs(60);
pub(crate) const CAPTURE_INTERVAL: Duration = Duration::from_millis(33); // ~30 FPS

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
    // Screen-share loop streaming this PC to the peer that asked to remote-control it.
    capture: Option<(String, tokio::task::AbortHandle)>,
    // Last capability list each peer pushed us, to notice when file access is granted or revoked.
    peer_capabilities: std::collections::HashMap<String, Vec<String>>,
    // When each paired device last drove the presenter dot or the remote input, by (device, mode).
    input_activity: std::collections::HashMap<(String, &'static str), std::time::Instant>,
}

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
pub(crate) fn remote_control_lines(body: &Value) -> Vec<String> {
    let num = |k: &str, default: f64| body.get(k).and_then(|v| v.as_f64()).unwrap_or(default);
    match body.get("action").and_then(|v| v.as_str()) {
        Some("tap") | Some("click") => vec![
            format!("abs {} {}", num("x", 0.5), num("y", 0.5)),
            format!("click {}", body.get("button").and_then(|v| v.as_str()).unwrap_or("left")),
        ],
        // The phone's swipe distance becomes wheel notches, inverted for natural desktop scrolling.
        Some("scroll") | Some("swipe") => vec![format!("scroll 0 {}", -(num("endY", 0.5) - num("startY", 0.5)) * 3.0)],
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

impl DeviceManager {
    pub(crate) fn permissions(&self) -> &std::sync::Mutex<PermissionStore> {
        &self.permission_store
    }

    pub(crate) fn allowed(&self, device_id: &str, key: &str) -> bool {
        self.permissions().lock().is_ok_and(|p| p.check(device_id, key))
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

    /// Pushes our state to every paired peer and asks each to push theirs back (UI reload).
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

    /// Capabilities first, so the peer's UI knows what to show before any state arrives.
    pub async fn initial_sync(&self, device_id: &str) {
        self.push_capabilities(device_id).await;
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
    }

    /// A new pairing starts with everything denied until the user opts features in.
    pub async fn on_paired(&self, device_id: &str) {
        if let Ok(mut store) = self.permissions().lock() {
            store.init_denied(device_id);
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

    pub(crate) async fn note_input_activity(&self, device_id: &str, mode: &'static str) {
        self.plugin_state.lock().await.input_activity.insert((device_id.to_string(), mode), std::time::Instant::now());
    }

    pub async fn clear_input_activity(&self, device_id: &str) {
        let mut state = self.plugin_state.lock().await;
        state.input_activity.retain(|(id, _), _| id != device_id);
        if let Some((target, handle)) = state.capture.take() {
            if target == device_id {
                handle.abort();
            } else {
                state.capture = Some((target, handle));
            }
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
        // Also include active screen share capture target (Remote Control session from paired peer)
        if let Some((target, _)) = &self.plugin_state.lock().await.capture {
            if !live.iter().any(|(id, mode)| id == target && *mode == "remotecontrol") {
                live.push((target.clone(), "remotecontrol"));
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
        let name = crate::core::identity::save_device_name(&self.config_dir, requested)
            .unwrap_or_else(|_| crate::core::identity::filter_device_name(requested));
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

    /// Streams this screen to `device_id` as JPEG frames until asked to stop or the peer goes away.
    async fn start_screen_share(self: &Arc<Self>, device_id: &str) {
        self.stop_screen_share().await;
        let mgr = self.clone();
        let target = device_id.to_string();
        let task = tokio::spawn({
            let target = target.clone();
            async move {
                let mut tick = tokio::time::interval(CAPTURE_INTERVAL);
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    let Ok(Some(frame)) = tokio::task::spawn_blocking(|| screen::capture_jpeg(1600, 900, 82)).await else { continue };
                    let body = json!({
                        "type": "frame",
                        "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &frame.jpeg),
                        "w": frame.width,
                        "h": frame.height,
                    });
                    if mgr.send_link_packet(&target, LinkPacket::new("link.remotecontrol.stream", body)).await.is_err() {
                        break;
                    }
                }
            }
        });
        self.plugin_state.lock().await.capture = Some((target, task.abort_handle()));
    }

    pub(crate) async fn stop_screen_share(&self) {
        if let Some((_, handle)) = self.plugin_state.lock().await.capture.take() {
            handle.abort();
        }
    }

    async fn broadcast_media(&self) {
        let sessions = media::sessions().await;
        self.plugin_state.lock().await.media = sessions.clone();
        self.broadcast_permitted("mpris", || media_packet(&sessions)).await;
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

    async fn on_telephony(&self, device_id: &str, body: &Value) {
        let event = body.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let is_cancel = truthy(body.get("isCancel"));

        // Pause whatever is playing while a call is active, resume afterwards.
        let any_playing = media::sessions().await.iter().any(|s| s.is_playing);
        let action = {
            let mut state = self.plugin_state.lock().await;
            if !is_cancel && matches!(event, "ringing" | "talking") {
                if any_playing && !state.paused_by_call {
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
            media::control(String::new(), action.to_string()).await;
            self.broadcast_media().await;
        }

        if is_cancel || matches!(event, "cancelled" | "talking") {
            ring::stop();
        }
        if is_cancel {
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
        if truthy(body.get("isCancel")) {
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
            "link.systemvolume.request" => {
                if self.allowed(device_id, "systemvolume") {
                    if let Some(sink) = body.get("name").and_then(|v| v.as_str()) {
                        if let Some(percent) = body.get("volume").and_then(|v| v.as_f64()) {
                            volume::set_volume(sink.to_string(), percent.round().max(0.0) as u32).await;
                        }
                        if let Some(muted) = body.get("muted").and_then(|v| v.as_bool()) {
                            volume::set_muted(sink.to_string(), muted).await;
                        }
                    }
                    let _ = self.send_link_packet(device_id, volume_packet(&volume::list().await)).await;
                }
                true
            }
            // Lock is open to every paired device (see UNGATED_KEYS), so there is no permission check.
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
            "link.clipboard" | "link.clipboard.connect" => {
                // Receiving is never gated: the sender already decided to share with us.
                let text = body.get("content").and_then(|v| v.as_str());
                let fresh = pkt.packet_type == "link.clipboard"
                    || body.get("timestamp").and_then(|v| v.as_i64()).is_some_and(|t| t >= clipboard::snapshot().1);
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
                        media::control(player, action.to_string()).await;
                    }
                    self.broadcast_media().await;
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
                let request_id = body.get("requestId").cloned().unwrap_or(Value::Null);
                let reply = if !self.allowed(device_id, "fileaccess") {
                    json!({ "requestId": request_id, "success": false, "error": "Permission denied: File access is disabled." })
                } else {
                    let request = body.clone();
                    match tokio::task::spawn_blocking(move || crate::core::fs_server::handle(&request)).await {
                        Ok(Ok(result)) => json!({ "requestId": request_id, "success": true, "result": result }),
                        Ok(Err(error)) => json!({ "requestId": request_id, "success": false, "error": error }),
                        Err(e) => json!({ "requestId": request_id, "success": false, "error": e.to_string() }),
                    }
                };
                let _ = self.send_link_packet(device_id, LinkPacket::new("link.fs.response", reply)).await;
                true
            }
            // Rename is open to every paired device. A peer asking us to rename ourselves: apply it,
            // then announce the authoritative result to everyone.
            "link.rename.request" => {
                if let Some(name) = body.get("deviceName").and_then(|v| v.as_str()) {
                    self.rename_self(name).await;
                }
                true
            }
            // A peer announcing its own (new) name: keep our alias for it in step.
            "link.rename" => {
                if let Some(name) = body.get("deviceName").and_then(|v| v.as_str()) {
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
                            self.start_screen_share(device_id).await;
                        } else {
                            let _ = self.send_link_packet(device_id, LinkPacket::new("link.remotecontrol.signal", json!({ "type": "denied" }))).await;
                        }
                    }
                    Some("stop") => {
                        self.stop_screen_share().await;
                        self.clear_input_activity(device_id).await;
                    }
                    _ => {}
                }
                // The UI also needs to see the signal (a viewer receives 'denied', etc.).
                false
            }
            "link.remotecontrol.input" => {
                if self.allowed(device_id, "remotecontrol") {
                    self.note_input_activity(device_id, "remotecontrol").await;
                    for line in remote_control_lines(body) {
                        input::run_line(&line);
                    }
                }
                true
            }
            // A peer's UI (re)loaded and wants our full state again.
            "link.resync.request" => {
                self.initial_sync(device_id).await;
                true
            }
            "link.audiosink.query" => {
                self.answer_audio_sink_query(device_id).await;
                true
            }
            "link.presenter" => {
                if truthy(body.get("stop")) {
                    self.clear_input_activity(device_id).await;
                    if self.allowed(device_id, "presenter") {
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
    pub fn start_watchers(self: &Arc<Self>) {
        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(VOLUME_POLL);
            loop {
                tick.tick().await;
                let sinks = volume::list().await;
                let changed = {
                    let mut state = mgr.plugin_state.lock().await;
                    let changed = !sinks.is_empty() && state.volume != sinks;
                    if changed {
                        state.volume = sinks.clone();
                    }
                    changed
                };
                if changed {
                    mgr.broadcast_permitted("systemvolume", || volume_packet(&sinks)).await;
                }
            }
        });

        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(MEDIA_POLL);
            loop {
                tick.tick().await;
                let sessions = media::sessions().await;
                let changed = {
                    let mut state = mgr.plugin_state.lock().await;
                    let changed = state.media != sessions;
                    if changed {
                        state.media = sessions.clone();
                    }
                    changed
                };
                if changed {
                    mgr.broadcast_permitted("mpris", || media_packet(&sessions)).await;
                }
            }
        });

        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(CLIPBOARD_POLL);
            loop {
                tick.tick().await;
                let changed = tokio::task::spawn_blocking(clipboard::poll).await.ok().flatten();
                if let Some(text) = changed {
                    mgr.broadcast_permitted("clipboard", || LinkPacket::new("link.clipboard", json!({ "content": text }))).await;
                }
            }
        });

        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(LOCK_POLL);
            let mut last = power::is_locked();
            loop {
                tick.tick().await;
                let now = power::is_locked();
                if now != last {
                    last = now;
                    mgr.broadcast_paired(|| lock_packet(now, None)).await;
                }
            }
        });

        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(BATTERY_POLL);
            loop {
                tick.tick().await;
                let now = power::battery();
                let changed = {
                    let mut state = mgr.plugin_state.lock().await;
                    let changed = now.is_some() && state.battery != now;
                    state.battery = now;
                    changed
                };
                if let (true, Some(b)) = (changed, now) {
                    mgr.broadcast_paired(|| battery_packet(b)).await;
                }
            }
        });

        // Keep the display awake only while the setting is on and a paired device is connected.
        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(HOUSEKEEPING_POLL);
            loop {
                tick.tick().await;
                let enabled = mgr.settings.lock().is_ok_and(|s| s.get_bool("screensaver_inhibit", true));
                screensaver::set_wanted(enabled && !mgr.paired_peer_ids().await.is_empty());
            }
        });
    }
}
