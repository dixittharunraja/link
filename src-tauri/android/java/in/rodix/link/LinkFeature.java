package in.rodix.link;

import app.tauri.plugin.Invoke;
import app.tauri.plugin.JSObject;

// One feature area split out of LinkPlugin: its state, its @LinkMethod handlers (found by
// LinkPlugin's dispatcher on every feature as well as on the plugin itself) and the packet types it
// handles. The plugin owns the connection and the system hooks; a feature reaches them through
// `plugin`.
abstract class LinkFeature {
    // Every split-out class logs under the plugin's tag, as it did before the split.
    static final String TAG = "LinkPlugin";

    final LinkPlugin plugin;

    LinkFeature(LinkPlugin plugin) {
        this.plugin = plugin;
    }

    /** Adds this feature's packet handlers, keyed by exact packet type. */
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {}

    /** Adds handlers for packet families addressed by type prefix (link.walkietalkie.*). */
    void registerPacketPrefixes(java.util.Map<String, LinkPlugin.PacketHandler> prefixHandlers) {}

    /** Called from LinkPlugin.load() before anything binds: stops the servers and sessions a
     *  previous plugin instance in this still-alive process left in this feature's statics, so
     *  their ports are free and nothing is orphaned. */
    void stopPreviousInstance() {}

    android.app.Activity getActivity() {
        return plugin.activity();
    }

    android.content.Context getContext() {
        return plugin.activity();
    }

    void notifyListeners(String event, JSObject data) {
        plugin.emit(event, data);
    }

    void broadcastToPermittedPeers(String permKey, LinkPacket packet) {
        plugin.broadcastToPermittedPeers(permKey, packet);
    }

    static boolean isEnabled(String name) {
        return LinkPlugin.isEnabled(name);
    }

    // Plugin's activity-result and permission helpers are protected in another package; these
    // route them through LinkPlugin, whose callback methods (found by name) then call back here.
    void startActivityForResult(Invoke invoke, android.content.Intent intent, String callbackName) {
        plugin.startActivityForResultFor(invoke, intent, callbackName);
    }

    void requestPermissionForAlias(String alias, Invoke invoke, String callbackName) {
        plugin.requestPermissionFor(alias, invoke, callbackName);
    }

    app.tauri.PermissionState getPermissionState(String alias) {
        return plugin.getPermissionState(alias);
    }
}
