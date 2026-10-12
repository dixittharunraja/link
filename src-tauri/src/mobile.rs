use serde_json::{Value, json};
use tauri::ipc::Channel;
use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
use tauri::{Builder, Manager, State, Wry};

const ANDROID_PACKAGE: &str = "in.rodix.link";

struct LinkHandle(PluginHandle<Wry>);

fn init() -> TauriPlugin<Wry> {
    PluginBuilder::new("link")
        .setup(|app, api| {
            app.manage(LinkHandle(api.register_android_plugin(ANDROID_PACKAGE, "LinkPlugin")?));
            Ok(())
        })
        .build()
}

async fn run(link: &LinkHandle, command: &str, payload: Value) -> Result<Value, String> {
    link.0
        .run_mobile_plugin_async(command, payload)
        .await
        .map_err(|e| match e {
            tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => r.message.unwrap_or_default(),
            other => other.to_string(),
        })
}

// Single entry point for every renderer -> native call. Handlers in LinkPlugin.java are plain
// methods looked up by name behind one Tauri command, so adding one needs no Rust change.
// checkPermissions/requestPermissions are the exception: they are Tauri's own built-in commands.
#[tauri::command]
async fn link_call(link: State<'_, LinkHandle>, method: String, args: Value) -> Result<Value, String> {
    match method.as_str() {
        "checkPermissions" | "requestPermissions" => run(&link, &method, args).await,
        _ => run(&link, "call", json!({ "method": method, "args": args })).await,
    }
}

#[tauri::command]
async fn link_register_listener(
    link: State<'_, LinkHandle>,
    event: String,
    handler: Channel<Value>,
) -> Result<(), String> {
    run(&link, "registerListener", json!({ "event": event, "handler": handler })).await?;
    Ok(())
}

#[tauri::command]
async fn link_remove_listener(link: State<'_, LinkHandle>, event: String, channel_id: u32) -> Result<(), String> {
    run(&link, "removeListener", json!({ "event": event, "channelId": channel_id })).await?;
    Ok(())
}

pub fn attach(builder: Builder<Wry>) -> Builder<Wry> {
    builder.plugin(init()).invoke_handler(tauri::generate_handler![
        link_call,
        link_register_listener,
        link_remove_listener,
    ])
}
