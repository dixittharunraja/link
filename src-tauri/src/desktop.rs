use std::sync::Arc;
use tokio::sync::RwLock;
use crate::core::discovery::DiscoveryManager;
use crate::core::identity::{load_or_create_identity, get_config_dir};
use crate::core::trust::TrustStore;
use crate::core::transport::DeviceManager;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use crate::commands::{self, AppState};

pub fn attach(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    log::info!("Starting Link device identity initialization");
    let config_dir = get_config_dir();
    let identity = match load_or_create_identity(&config_dir) {
        Ok(id) => {
            log::info!("Device identity initialized: {} ({})", id.device_name, id.device_id);
            id
        },
        Err(e) => panic!("Failed to load/create device identity: {}", e),
    };

    let trust_store = Arc::new(RwLock::new(TrustStore::new(&config_dir)));
    let discovery = Arc::new(DiscoveryManager::new(identity.clone()));
    let device_manager = match DeviceManager::new(identity.clone(), trust_store.clone(), discovery.clone(), &config_dir) {
        Ok(dm) => dm,
        Err(e) => panic!("Failed to create DeviceManager: {}", e),
    };

    let app_state = AppState {
        identity,
        trust_store,
        discovery: discovery.clone(),
        device_manager: device_manager.clone(),
    };

    // A second launch (a double click, or Explorer's Send to) hands its command line to the running copy.
    let relay = device_manager.clone();
    builder
        .plugin(tauri_plugin_single_instance::init(move |app, args, _cwd| {
            match crate::core::sendto::parse_args(&args) {
                Some((device_id, paths)) => {
                    let (manager, app) = (relay.clone(), app.clone());
                    tauri::async_runtime::spawn(crate::core::sendto::handle(manager, app, device_id, paths));
                }
                None => crate::core::sendto::show_main_window(app),
            }
        }))
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(move |app| {
            device_manager.set_app_handle(app.handle().clone());
            discovery.set_app_handle(app.handle().clone());
            if !device_manager.settings.lock().is_ok_and(|s| s.get_bool("visibility", true)) {
                discovery.set_visibility(false);
            }
            device_manager.start_watchers();

            let guests = device_manager.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = guests.start_input_guest_server().await {
                    log::error!("[Link Input Guest Error]: {}", e);
                }
                if let Err(e) = guests.start_joystick_server().await {
                    log::error!("[Link Joystick Error]: {}", e);
                }
            });

            let relay = device_manager.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = relay.start_input_relay().await {
                    log::error!("[Link Input Relay Error]: {}", e);
                }
            });

            let disc = discovery.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = disc.start().await {
                    log::error!("[Link Discovery Error]: {}", e);
                } else {
                    log::info!("Discovery service active on port 1716");
                }
            });

            // Paired devices are also looked for over mDNS (core/mdns.rs); it follows the trust store and visibility.
            crate::core::mdns::start(device_manager.clone());

            // The reconnect loop needs the TLS server running first.
            let dm = device_manager.clone();
            tauri::async_runtime::spawn(async move {
                let reconnecting = dm.clone();
                match dm.start_server().await {
                    Ok(()) => reconnecting.start_reconnect_loop(),
                    Err(e) => log::error!("[Link Transport Error]: {}", e),
                }
            });

            let show_i = MenuItem::with_id(app, "show", "Open Link", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Link", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Link")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.set_focus();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // The window starts hidden (tauri.conf.json). Launched at sign-in (the autostart entry passes
            // --minimized) Link stays in the tray; opened by hand it shows, maximized.
            let args: Vec<String> = std::env::args().collect();
            let at_login = args.iter().any(|a| a == "--minimized" || a == crate::core::sendto::ARG);
            if let Some((device_id, paths)) = crate::core::sendto::parse_args(&args) {
                tauri::async_runtime::spawn(crate::core::sendto::handle(device_manager.clone(), app.handle().clone(), device_id, paths));
            }
            crate::core::sendto::start_shortcut_sync(device_manager.clone());
            if let Some(window) = app.get_webview_window("main").filter(|_| !at_login) {
                let _ = window.maximize();
                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Link running in the tray, so devices stay connected; Quit is in
            // the tray menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_identity,
            commands::get_visibility,
            commands::set_visibility,
            commands::get_discovered_devices,
            commands::get_trusted_devices,
            commands::request_pairing,
            commands::request_pairing_by_ip,
            commands::open_pairing_window,
            commands::refresh_pairing_token,
            commands::close_pairing_window,
            commands::accept_pairing,
            commands::cancel_pairing,
            commands::reject_pairing,
            commands::unpair,
            commands::exit_pool,
            commands::open_guest_qr,
            commands::refresh_guest_qr,
            commands::close_guest_qr,
            commands::remember_guest_scan,
            commands::connect_to,
            commands::set_packet_subscriptions,
            commands::rename_device,
            commands::rename_trusted_device,
            commands::get_pool_hash,
            commands::get_connected_devices,
            commands::send_packet,
            commands::run_speed_test,
            commands::fs_request,
            commands::get_permissions,
            commands::set_permissions,
            commands::get_commands,
            commands::set_command,
            commands::remove_command,
            commands::pick_command_file,
            commands::get_tailscale_status,
            commands::get_setting,
            commands::set_setting,
            commands::get_blocklist,
            commands::block_device,
            commands::unblock_device,
            commands::send_input_line,
            commands::stop_ringing_local,
            commands::broadcast_packet,
            commands::resync_devices,
            commands::get_open_at_login,
            commands::set_open_at_login,
            commands::fs_read,
            commands::fs_download_file,
            commands::fs_upload_item,
            commands::fs_cancel_transfer,
            commands::fs_open_document,
            commands::fs_get_stream_url,
            commands::open_external,
            commands::fs_pick_save_path,
            commands::fs_pick_save_directory,
            commands::fs_pick_upload_items,
            commands::fs_mount_device,
            commands::get_input_guest_status,
            commands::kick_input_guest,
            commands::join_input_guest,
            commands::leave_input_guest,
            commands::send_input_guest_packet,
            commands::accept_input_guest,
            commands::reject_input_guest,
            commands::block_input_guest,
            commands::get_joystick_status,
            commands::check_joystick_driver,
            commands::kick_joystick_controller,
            commands::block_joystick_controller,
            commands::accept_joystick_guest,
            commands::reject_joystick_guest,
            commands::block_joystick_guest,
            commands::start_walkie_talkie_guest_listener,
            commands::stop_walkie_talkie_guest_listener,
            commands::accept_walkie_talkie_guest,
            commands::reject_walkie_talkie_guest,
            commands::kick_walkie_talkie_guest,
            commands::block_walkie_talkie_guest,
            commands::block_walkie_talkie_member,
            commands::send_walkie_talkie_guest_signal,
            commands::join_walkie_talkie_guest,
            commands::leave_walkie_talkie_guest,
            commands::pick_portal_files,
            commands::pick_portal_save_dir,
            commands::start_portal_receive,
            commands::end_portal_receive,
            commands::hold_portal_guest,
            commands::accept_portal_guest,
            commands::reject_portal_guest,
            commands::block_portal_guest,
            commands::disconnect_portal_connection,
            commands::set_portal_downloads,
            commands::request_portal_download,
            commands::join_portal_guest,
            commands::leave_portal_send,
            commands::get_portal_status,
            commands::get_audio_sink_devices,
            commands::start_audio_sink,
            commands::switch_audio_sink_device,
            commands::set_audio_sink_muted,
            commands::kick_audio_sink_listener,
            commands::block_audio_sink_listener,
            commands::accept_audio_sink_guest,
            commands::reject_audio_sink_guest,
            commands::block_audio_sink_guest,
            commands::get_audio_sink_listeners,
            commands::get_audio_sink_status,
            commands::end_audio_sink,
            commands::join_audio_sink_guest,
            commands::join_audio_sink_paired,
            commands::leave_audio_sink,
            commands::join_remote_mic_guest,
            commands::join_remote_mic_paired,
            commands::leave_remote_mic,
            commands::get_remote_mic_status,
            commands::get_audio_output_devices,
            commands::set_listen_output_device,
            commands::set_listen_volume,
            commands::query_audio_sink_sessions,
            commands::query_remote_mic_sessions,
            commands::send_walkie_talkie_guest_message,
            commands::fs_unmount_device,
            commands::get_recent_photos,
            commands::get_photo_thumbnail,
            commands::copy_photo_to_clipboard,
            commands::get_device_mount_config,
            commands::set_device_mount_letter,
            commands::vcam_status,
            commands::vcam_start,
            commands::vcam_stop,
            commands::vcam_native_start,
            commands::vcam_native_stop,
            commands::vcam_native_status,
            commands::vcam_native_config,
            commands::camera_preview_frame,
            commands::vcam_open,
            commands::vcam_connected,
            commands::vcam_log,
            commands::h264_status,
            commands::h264_install,
            commands::accept_share,
            commands::reject_share,
            commands::send_files,
        ])
}
