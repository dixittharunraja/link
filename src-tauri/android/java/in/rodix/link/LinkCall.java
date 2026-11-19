package in.rodix.link;

import app.tauri.plugin.Invoke;
import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

// Typed view over one renderer call: the method's arguments plus resolve/reject. Absent keys read
// as null (or the supplied default), unlike app.tauri.plugin.JSObject.getString which returns "".
final class LinkCall {
    private final Invoke invoke;
    private final JSObject args;

    LinkCall(Invoke invoke) {
        this.invoke = invoke;
        JSObject callArgs = invoke.getArgs().getJSObject(LinkPlugin.ARGS_KEY);
        this.args = callArgs != null ? callArgs : new JSObject();
    }

    Invoke invoke() {
        return invoke;
    }

    String getString(String key) {
        return args.getString(key, null);
    }

    String getString(String key, String fallback) {
        return args.getString(key, fallback);
    }

    Integer getInt(String key) {
        return args.getInteger(key);
    }

    int getInt(String key, int fallback) {
        return args.getInteger(key, fallback);
    }

    Boolean getBoolean(String key) {
        return args.has(key) ? Boolean.valueOf(args.getBoolean(key, false)) : null;
    }

    boolean getBoolean(String key, boolean fallback) {
        return args.getBoolean(key, fallback);
    }

    Double getDouble(String key) {
        return args.has(key) ? Double.valueOf(args.optDouble(key)) : null;
    }

    double getDouble(String key, double fallback) {
        return args.optDouble(key, fallback);
    }

    JSObject getObject(String key) {
        return args.getJSObject(key);
    }

    JSArray getArray(String key) {
        org.json.JSONArray array = args.optJSONArray(key);
        return array != null ? JSArray.Companion.from(array) : null;
    }

    JSObject getData() {
        return args;
    }

    void resolve() {
        invoke.resolve();
    }

    void resolve(JSObject data) {
        invoke.resolve(data);
    }

    void reject(String message) {
        invoke.reject(message);
    }
}
