// Desktop runs the protocol in Rust (core/); Android runs it in the Java layer under
// src-tauri/android and reaches the renderer through the `link` mobile plugin (mobile.rs).
#[cfg(not(target_os = "android"))]
mod commands;
#[cfg(not(target_os = "android"))]
mod core;
#[cfg(not(target_os = "android"))]
mod desktop;
#[cfg(target_os = "android")]
mod mobile;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
    );

    #[cfg(not(target_os = "android"))]
    let builder = desktop::attach(builder);
    #[cfg(target_os = "android")]
    let builder = mobile::attach(builder);

    builder
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
