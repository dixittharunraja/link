use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::core::transport::DeviceManager;

// Explorer's right-click "Send to" menu. Link keeps one shortcut per paired device in the user's
// SendTo folder, named "<device> (Link)". Choosing one starts Link as
//     link.exe --send-to <deviceId> <file or folder> ...
// (or hands that command line to the running copy, see desktop.rs), which offers the items to the device.
pub const ARG: &str = "--send-to";
const SUFFIX: &str = " (Link).lnk";
const CONNECT_WAIT: Duration = Duration::from_secs(20);

/// The device and items named by a "Send to" command line, if it is one.
pub fn parse_args(args: &[String]) -> Option<(String, Vec<PathBuf>)> {
    let at = args.iter().position(|a| a == ARG)?;
    let device_id = args.get(at + 1)?.clone();
    let paths = args[at + 2..].iter().filter(|a| !a.starts_with("--")).map(PathBuf::from).collect::<Vec<_>>();
    (!paths.is_empty()).then_some((device_id, paths))
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Sends the items chosen in Explorer, waiting briefly for the device when Link has just started.
pub async fn handle(manager: Arc<DeviceManager>, app: tauri::AppHandle, device_id: String, paths: Vec<PathBuf>) {
    let name = manager.trust_store.read().await.get(&device_id).map(|d| d.device_name.clone());
    let Some(name) = name else {
        notify(&app, "Couldn't send files", "That device is no longer paired with this PC.");
        return;
    };
    let waited = tokio::time::Instant::now();
    loop {
        if manager.active_peers.read().await.get(&device_id).is_some_and(|p| p.trusted) {
            break;
        }
        if waited.elapsed() > CONNECT_WAIT {
            notify(&app, "Couldn't send files", &format!("{} is not connected. Open Link on it and try again.", name));
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if let Err(e) = manager.send_files(&device_id, paths).await {
        notify(&app, "Couldn't send files", &e);
    }
}

/// Brings the main window to the front (a second launch without a "Send to" request).
pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Keeps the SendTo shortcuts in step with the paired devices: new pairings and renames appear, unpaired
/// devices disappear. Checked every few seconds; the shortcuts are only rewritten when the set changed.
pub fn start_shortcut_sync(manager: Arc<DeviceManager>) {
    tauri::async_runtime::spawn(async move {
        let mut applied: Option<BTreeMap<String, String>> = None;
        loop {
            let wanted: BTreeMap<String, String> =
                manager.trust_store.read().await.list().into_iter().map(|d| (d.device_id, d.device_name)).collect();
            if applied.as_ref() != Some(&wanted) && apply(&wanted).await {
                applied = Some(wanted);
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

fn file_name(device_name: &str, taken: &mut Vec<String>) -> String {
    let mut base: String = device_name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    base = base.trim().trim_end_matches('.').to_string();
    if base.is_empty() {
        base = "Device".to_string();
    }
    let mut candidate = base.clone();
    let mut n = 2;
    while taken.iter().any(|t| t.eq_ignore_ascii_case(&candidate)) {
        candidate = format!("{} {}", base, n);
        n += 1;
    }
    taken.push(candidate.clone());
    candidate
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(windows)]
async fn apply(devices: &BTreeMap<String, String>) -> bool {
    use base64::Engine;

    let Ok(exe) = std::env::current_exe() else { return false };
    let exe = exe.display().to_string();
    let mut script = String::from(
        "$ErrorActionPreference = 'Stop'\n$dir = [Environment]::GetFolderPath('SendTo')\n\
         Get-ChildItem -LiteralPath $dir -Filter ('* (Link).lnk') | Remove-Item -Force\n\
         $shell = New-Object -ComObject WScript.Shell\n",
    );
    let mut taken = Vec::new();
    for (id, name) in devices {
        let file = format!("{}{}", file_name(name, &mut taken), SUFFIX);
        script.push_str(&format!(
            "$s = $shell.CreateShortcut((Join-Path $dir {})); $s.TargetPath = {}; $s.Arguments = {}; $s.IconLocation = {}; \
             $s.Description = 'Send with Link'; $s.Save()\n",
            ps_quote(&file),
            ps_quote(&exe),
            ps_quote(&format!("{} {}", ARG, id)),
            ps_quote(&format!("{},0", exe)),
        ));
    }
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let status = tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    let ok = status.is_ok_and(|s| s.success());
    if !ok {
        log::warn!("Could not update the Explorer Send to shortcuts");
    }
    ok
}

#[cfg(not(windows))]
async fn apply(_devices: &BTreeMap<String, String>) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_send_to_command_line() {
        let args: Vec<String> = ["link.exe", "--send-to", "abc", "C:\\a b\\x.txt", "D:\\pics"].iter().map(|s| s.to_string()).collect();
        let (id, paths) = parse_args(&args).unwrap();
        assert_eq!(id, "abc");
        assert_eq!(paths, vec![PathBuf::from("C:\\a b\\x.txt"), PathBuf::from("D:\\pics")]);
        assert!(parse_args(&["link.exe".to_string(), "--minimized".to_string()]).is_none());
        assert!(parse_args(&["link.exe".to_string(), "--send-to".to_string(), "abc".to_string()]).is_none());
    }

    #[test]
    fn names_are_unique_and_safe() {
        let mut taken = Vec::new();
        assert_eq!(file_name("Pixel 8", &mut taken), "Pixel 8");
        assert_eq!(file_name("pixel 8", &mut taken), "pixel 8 2");
        assert_eq!(file_name("a/b:c", &mut taken), "a_b_c");
    }
}
