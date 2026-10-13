use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;
use crate::core::audio_sink::Service;
use crate::core::discovery::{DiscoveredPeer, DiscoveryManager};
use crate::core::identity::DeviceIdentity;
use crate::core::trust::{TrustStore, TrustedDevice};
use crate::core::plugins::runcommand::CommandEntry;
use crate::core::settings::BlockEntry;
use crate::core::transport::{DeviceManager, LINK_PORT};

pub struct AppState {
    pub identity: DeviceIdentity,
    pub trust_store: Arc<RwLock<TrustStore>>,
    pub discovery: Arc<DiscoveryManager>,
    pub device_manager: Arc<DeviceManager>,
}

#[tauri::command]
pub async fn get_identity(state: State<'_, AppState>) -> Result<DeviceIdentity, String> {
    let mut id = state.identity.clone();
    id.device_name = state.device_manager.device_name.read().await.clone();
    let (ip_address, ip_addresses) = crate::core::identity::get_local_ips();
    id.ip_address = ip_address;
    id.ip_addresses = ip_addresses;
    Ok(id)
}

#[tauri::command]
pub async fn get_visibility(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.device_manager.settings.lock().map_err(|e| e.to_string())?.get_bool("visibility", true))
}

#[tauri::command]
pub async fn set_visibility(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.discovery.set_visibility(enabled);
    state.device_manager.settings.lock().map_err(|e| e.to_string())?.set_bool("visibility", enabled);
    Ok(())
}

#[tauri::command]
pub async fn get_discovered_devices(state: State<'_, AppState>) -> Result<Vec<DiscoveredPeer>, String> {
    let peers_map = state.discovery.get_discovered_peers();
    let map = peers_map.read().await;
    Ok(map.values().cloned().collect())
}

#[tauri::command]
pub async fn get_trusted_devices(state: State<'_, AppState>) -> Result<Vec<TrustedDevice>, String> {
    let store = state.trust_store.read().await;
    Ok(store.list())
}

#[tauri::command]
pub async fn request_pairing(device_id: String, state: State<'_, AppState>) -> Result<String, String> {
    state.device_manager.request_pairing(&device_id).await
}

#[tauri::command]
pub async fn request_pairing_by_ip(ip: String, state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let (pin, device_id) = state.device_manager.request_pairing_by_ip(&ip).await?;
    Ok(Some(serde_json::json!({ "pin": pin, "deviceId": device_id })))
}

#[tauri::command]
pub async fn accept_pairing(device_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.accept_pairing(&device_id).await
}

#[tauri::command]
pub async fn cancel_pairing(device_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.reject_pairing(&device_id).await
}

#[tauri::command]
pub async fn reject_pairing(device_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.reject_pairing(&device_id).await
}

#[tauri::command]
pub async fn unpair(device_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.unpair(&device_id).await
}

#[tauri::command]
pub async fn connect_to(host: String, state: State<'_, AppState>) -> Result<(), String> {
    let (ip, port) = if host.contains(':') {
        let parts: Vec<&str> = host.split(':').collect();
        let port = parts.get(1).and_then(|p| p.parse::<u16>().ok()).unwrap_or(LINK_PORT);
        (parts[0], port)
    } else {
        (host.as_str(), LINK_PORT)
    };
    state.device_manager.connect_to(ip, port).await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_device(new_name: String, state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.device_manager.rename_self(&new_name).await)
}

#[tauri::command]
pub async fn rename_trusted_device(device_id: String, new_name: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.device_manager.request_peer_rename(&device_id, &new_name).await?;
    Ok(true)
}

#[tauri::command]
pub async fn get_pool_hash(state: State<'_, AppState>) -> Result<String, String> {
    let store = state.trust_store.read().await;
    Ok(store.compute_pool_hash())
}

#[tauri::command]
pub async fn get_connected_devices(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.device_manager.connected_peers().await)
}

#[tauri::command]
pub async fn send_packet(
    device_id: String,
    packet_type: String,
    body: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.device_manager.send_packet(&device_id, &packet_type, body).await
}

#[tauri::command]
pub async fn run_speed_test(
    device_id: String,
    state: State<'_, AppState>,
) -> Result<crate::core::speedtest::SpeedTestResult, String> {
    state.device_manager.run_speed_test(&device_id).await
}

#[tauri::command]
pub async fn fs_request(
    device_id: String,
    action: String,
    args: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.device_manager.fs_request(&device_id, &action, args).await
}

#[tauri::command]
pub async fn get_permissions(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.get_permissions())
}

#[tauri::command]
pub async fn set_permissions(permissions: serde_json::Value, state: State<'_, AppState>) -> Result<bool, String> {
    state.device_manager.set_permissions(permissions).await;
    Ok(true)
}

#[tauri::command]
pub async fn get_commands(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let commands = state.device_manager.run_commands.lock().map_err(|e| e.to_string())?.all();
    serde_json::to_value(commands).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_command(key: String, name: String, command: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.device_manager.run_commands.lock().map_err(|e| e.to_string())?.set(key, CommandEntry { name, command });
    state.device_manager.broadcast_command_list().await;
    get_commands(state).await
}

#[tauri::command]
pub async fn remove_command(key: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.device_manager.run_commands.lock().map_err(|e| e.to_string())?.remove(&key);
    state.device_manager.broadcast_command_list().await;
    get_commands(state).await
}

#[tauri::command]
pub async fn pick_command_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_file();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn get_setting(key: String, default: bool, state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.device_manager.settings.lock().map_err(|e| e.to_string())?.get_bool(&key, default))
}

#[tauri::command]
pub async fn set_setting(key: String, value: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.settings.lock().map_err(|e| e.to_string())?.set_bool(&key, value);
    Ok(())
}

#[tauri::command]
pub async fn get_blocklist(state: State<'_, AppState>) -> Result<Vec<BlockEntry>, String> {
    Ok(state.device_manager.blocklist.lock().map_err(|e| e.to_string())?.entries())
}

#[tauri::command]
pub async fn block_device(id: String, label: String, kind: String, state: State<'_, AppState>) -> Result<Vec<BlockEntry>, String> {
    state.device_manager.blocklist.lock().map_err(|e| e.to_string())?.add(BlockEntry {
        id,
        label,
        kind,
        blocked_at: chrono::Utc::now().timestamp_millis(),
        device_type: None,
        ip: None,
    });
    get_blocklist(state).await
}

#[tauri::command]
pub async fn unblock_device(id: String, state: State<'_, AppState>) -> Result<Vec<BlockEntry>, String> {
    state.device_manager.blocklist.lock().map_err(|e| e.to_string())?.remove(&id);
    get_blocklist(state).await
}

#[tauri::command]
pub async fn send_input_line(device_id: String, line: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.send_input_line(&device_id, &line).await
}

#[tauri::command]
pub async fn stop_ringing_local(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.stop_local_ringing().await;
    Ok(())
}

#[tauri::command]
pub async fn fs_read(device_id: String, path: String, offset: u64, length: u64, state: State<'_, AppState>) -> Result<String, String> {
    let bytes = state.device_manager.fs_read(&device_id, &path, offset, length).await?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes))
}

#[tauri::command]
pub async fn fs_download_file(device_id: String, remote_path: String, local_path: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.device_manager.fs_download(&device_id, &remote_path, &local_path).await
}

#[tauri::command]
pub async fn fs_upload_item(device_id: String, local_path: String, remote_parent_path: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.device_manager.fs_upload(&device_id, &local_path, &remote_parent_path).await
}

#[tauri::command]
pub async fn fs_cancel_transfer(transfer_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.device_manager.cancel_transfer(&transfer_id))
}

#[tauri::command]
pub async fn fs_open_document(device_id: String, remote_path: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.device_manager.fs_open_document(&device_id, &remote_path).await
}

#[tauri::command]
pub async fn fs_get_stream_url(device_id: String, remote_path: String, state: State<'_, AppState>) -> Result<String, String> {
    state.device_manager.fs_stream_url(&device_id, &remote_path).await
}

// Hands a stream URL this app minted (loopback only) to the system's default handler.
#[tauri::command]
pub async fn open_external(target: String) -> Result<serde_json::Value, String> {
    if !target.starts_with("http://127.0.0.1:") {
        return Err("Refusing to open a non-loopback URL".into());
    }
    crate::core::fs_transfer::open_with_default_app(&target)?;
    Ok(serde_json::json!({ "method": "browser" }))
}

#[tauri::command]
pub async fn fs_pick_save_path(default_name: String, app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_file_name(default_name).blocking_save_file();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn fs_pick_save_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Choose where to save the folder").blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn fs_pick_upload_items(mode: String, app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file();
    let picked = if mode == "directory" {
        dialog.set_title("Select folders to upload").blocking_pick_folders()
    } else {
        dialog.set_title("Select files to upload").blocking_pick_files()
    };
    Ok(picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.display().to_string()).collect())
}

#[tauri::command]
pub async fn broadcast_packet(packet_type: String, body: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.broadcast_to_paired(&packet_type, body).await;
    Ok(())
}

#[tauri::command]
pub async fn resync_devices(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.resync_all().await;
    Ok(())
}

#[tauri::command]
pub async fn get_open_at_login(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_open_at_login(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_mount_device(device_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.device_manager.set_mount_enabled(&device_id, true);
    state.device_manager.mount_device(&device_id).await?;
    Ok(true)
}

#[tauri::command]
pub async fn fs_unmount_device(device_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    state.device_manager.set_mount_enabled(&device_id, false);
    state.device_manager.unmount_device(&device_id).await;
    Ok(true)
}

#[tauri::command]
pub async fn get_device_mount_config(device_id: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.mount_config(&device_id).await)
}

#[tauri::command]
pub async fn set_device_mount_letter(device_id: String, drive_letter: String, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.device_manager.set_drive_letter(&device_id, &drive_letter).await;
    Ok(serde_json::json!({ "success": true }))
}

// ---- guest sessions (untrusted devices) ----

#[tauri::command]
pub async fn get_input_guest_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.input_guest_roster().await)
}

#[tauri::command]
pub async fn kick_input_guest(ip: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.kick_input(&ip).await;
    Ok(())
}

macro_rules! guest_decision {
    ($name:ident, $decision:expr) => {
        #[tauri::command]
        pub async fn $name(conn_id: String, state: State<'_, AppState>) -> Result<(), String> {
            state.device_manager.guests.decide(&conn_id, $decision);
            Ok(())
        }
    };
}

guest_decision!(accept_input_guest, crate::core::guest::Decision::Accept);
guest_decision!(reject_input_guest, crate::core::guest::Decision::Reject);
guest_decision!(block_input_guest, crate::core::guest::Decision::Block);
guest_decision!(accept_joystick_guest, crate::core::guest::Decision::Accept);
guest_decision!(reject_joystick_guest, crate::core::guest::Decision::Reject);
guest_decision!(block_joystick_guest, crate::core::guest::Decision::Block);
guest_decision!(accept_walkie_talkie_guest, crate::core::guest::Decision::Accept);
guest_decision!(reject_walkie_talkie_guest, crate::core::guest::Decision::Reject);

#[tauri::command]
pub async fn get_joystick_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.joystick_status().await)
}

#[tauri::command]
pub async fn check_joystick_driver(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.check_joystick_driver().await)
}

#[tauri::command]
pub async fn kick_joystick_controller(ip: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.joystick_bye(&ip, "kicked").await;
    Ok(())
}

#[tauri::command]
pub async fn block_joystick_controller(ip: String, name: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.block_guest(&ip, name.as_deref()).await;
    state.device_manager.joystick_bye(&ip, "blocked").await;
    Ok(())
}

#[tauri::command]
pub async fn start_walkie_talkie_guest_listener(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(match state.device_manager.start_walkie_talkie_listener().await {
        Ok(port) => serde_json::json!({ "started": true, "port": port }),
        Err(error) => serde_json::json!({ "started": false, "error": error }),
    })
}

#[tauri::command]
pub async fn stop_walkie_talkie_guest_listener(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.stop_walkie_talkie_listener().await;
    Ok(())
}

#[tauri::command]
pub async fn kick_walkie_talkie_guest(conn_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.kick_walkie_guest(&conn_id).await;
    Ok(())
}

#[tauri::command]
pub async fn block_walkie_talkie_guest(conn_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = &state.device_manager;
    // Waiting for confirmation: block through the pending answer. Already admitted: block its address.
    if !manager.guests.decide(&conn_id, crate::core::guest::Decision::Block) {
        if let Some(ip) = manager.walkie_guest_ip(&conn_id) {
            manager.block_guest(&ip, None).await;
        }
    }
    manager.kick_walkie_guest(&conn_id).await;
    Ok(())
}

// A paired member is not a guest the signalling server knows; blocking it is a plain device entry.
#[tauri::command]
pub async fn block_walkie_talkie_member(device_id: String, label: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.block_guest_device(&device_id, &label).await;
    Ok(())
}

#[tauri::command]
pub async fn send_walkie_talkie_guest_signal(conn_id: String, kind: String, body: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.walkie_guest_signal(&conn_id, &kind, body).await;
    Ok(())
}

#[tauri::command]
pub async fn join_walkie_talkie_guest(host: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.join_walkie_talkie_guest(&host).await
}

#[tauri::command]
pub async fn leave_walkie_talkie_guest(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.leave_walkie_talkie_guest().await;
    Ok(())
}

#[tauri::command]
pub async fn send_walkie_talkie_guest_message(kind: String, body: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.send_walkie_talkie_guest_message(&kind, body).await;
    Ok(())
}

// ---- file portal ----

#[tauri::command]
pub async fn pick_portal_files(mode: String, app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file();
    let picked = if mode == "directory" { dialog.blocking_pick_folders() } else { dialog.blocking_pick_files() };
    let paths = picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
    Ok(crate::core::portal::expand_picked(paths))
}

#[tauri::command]
pub async fn pick_portal_save_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title("Choose where to save the incoming files");
    if let Some(downloads) = dirs::download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    Ok(dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn start_portal_receive(web_mode: Option<bool>, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(match state.device_manager.start_portal_receive(web_mode.unwrap_or(false)).await {
        Ok(started) => started,
        Err(error) => serde_json::json!({ "started": false, "error": error }),
    })
}

#[tauri::command]
pub async fn end_portal_receive(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.stop_portal_receive().await;
    Ok(())
}

// The PIN timer is paused first, so choosing a save folder can't race the 30 s confirmation window.
#[tauri::command]
pub async fn hold_portal_guest(conn_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.guests.hold(&conn_id);
    Ok(())
}

#[tauri::command]
pub async fn accept_portal_guest(conn_id: String, save_dir: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.accept_portal_guest(&conn_id, save_dir);
    Ok(())
}

guest_decision!(reject_portal_guest, crate::core::guest::Decision::Reject);
guest_decision!(block_portal_guest, crate::core::guest::Decision::Block);

#[tauri::command]
pub async fn disconnect_portal_connection(conn_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.disconnect_portal_connection(&conn_id).await;
    Ok(())
}

#[tauri::command]
pub async fn set_portal_downloads(files: Vec<crate::core::portal::PortalFile>, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.set_portal_downloads(files).await;
    Ok(())
}

#[tauri::command]
pub async fn request_portal_download(file_id: String, save_dir: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.request_portal_download(file_id, save_dir).await;
    Ok(())
}

#[tauri::command]
pub async fn join_portal_guest(host: String, files: Vec<crate::core::portal::PortalFile>, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.join_portal_guest(&host, files).await
}

#[tauri::command]
pub async fn leave_portal_send(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.leave_portal_send().await;
    Ok(())
}

#[tauri::command]
pub async fn get_portal_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.portal_status())
}

// ---- audio sink and remote mic ----

#[tauri::command]
pub async fn get_audio_sink_devices(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.device_manager.audio_sink_devices().await)
}

#[tauri::command]
pub async fn start_audio_sink(audio_device_id: Option<String>, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(match state.device_manager.start_audio_sink(audio_device_id.filter(|id| !id.is_empty())).await {
        Ok(started) => started,
        Err(error) => serde_json::json!({ "started": false, "error": error }),
    })
}

#[tauri::command]
pub async fn switch_audio_sink_device(audio_device_id: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.switch_audio_sink_device(audio_device_id.filter(|id| !id.is_empty())).await
}

#[tauri::command]
pub async fn set_audio_sink_muted(muted: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.set_audio_sink_muted(muted);
    Ok(())
}

#[tauri::command]
pub async fn kick_audio_sink_listener(conn_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.kick_audio_sink_listener(&conn_id).await;
    Ok(())
}

#[tauri::command]
pub async fn block_audio_sink_listener(conn_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.block_audio_sink_listener(&conn_id).await;
    Ok(())
}

guest_decision!(accept_audio_sink_guest, crate::core::guest::Decision::Accept);
guest_decision!(reject_audio_sink_guest, crate::core::guest::Decision::Reject);
guest_decision!(block_audio_sink_guest, crate::core::guest::Decision::Block);

#[tauri::command]
pub async fn get_audio_sink_listeners(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.device_manager.audio_sink_listeners())
}

#[tauri::command]
pub async fn get_audio_sink_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.audio_sink_status())
}

#[tauri::command]
pub async fn end_audio_sink(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.stop_audio_sink().await;
    Ok(())
}

#[tauri::command]
pub async fn join_audio_sink_guest(host: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.join_audio_session(Service::Sink, &host, None, host.clone()).await
}

#[tauri::command]
pub async fn join_audio_sink_paired(host: String, token: String, host_name: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let label = host_name.unwrap_or_else(|| host.clone());
    state.device_manager.join_audio_session(Service::Sink, &host, Some(token), label).await
}

#[tauri::command]
pub async fn leave_audio_sink(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.leave_audio_session(Service::Sink).await;
    Ok(())
}

#[tauri::command]
pub async fn join_remote_mic_guest(host: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.join_audio_session(Service::Mic, &host, None, host.clone()).await
}

#[tauri::command]
pub async fn join_remote_mic_paired(host: String, token: String, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.join_audio_session(Service::Mic, &host, Some(token), host.clone()).await
}

#[tauri::command]
pub async fn leave_remote_mic(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.leave_audio_session(Service::Mic).await;
    Ok(())
}

#[tauri::command]
pub async fn get_remote_mic_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.device_manager.remote_mic_status())
}

// A session that started before this device connected is only found by asking for it.
async fn query_paired_peers(manager: &DeviceManager, packet_type: &str) {
    for id in manager.paired_peer_ids().await {
        let _ = manager.send_packet(&id, packet_type, serde_json::json!({})).await;
    }
}

#[tauri::command]
pub async fn query_audio_sink_sessions(state: State<'_, AppState>) -> Result<(), String> {
    query_paired_peers(&state.device_manager, "link.audiosink.query").await;
    Ok(())
}

#[tauri::command]
pub async fn query_remote_mic_sessions(state: State<'_, AppState>) -> Result<(), String> {
    query_paired_peers(&state.device_manager, "link.remotemic.query").await;
    Ok(())
}

// ---- joining another device's input-guest server (remote control viewer) ----

#[tauri::command]
pub async fn join_input_guest(host: String, name: Option<String>, mode: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.join_input_guest(&host, name, mode.as_deref().unwrap_or("remotecontrol")).await
}

#[tauri::command]
pub async fn leave_input_guest(state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.leave_input_guest().await;
    Ok(())
}

#[tauri::command]
pub async fn send_input_guest_packet(packet_type: String, body: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    state.device_manager.send_input_guest_packet(packet_type, body).await;
    Ok(())
}
