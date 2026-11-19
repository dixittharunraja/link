package in.rodix.link;

import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

// Identity, pairing and trust: this device's name and visibility, pairing windows and tool QR
// codes, accepting or refusing pairing requests, the blocklist, per-device permissions, and the
// lists of trusted and connected devices with the capabilities each peer sent.
final class LinkPairing extends LinkFeature {
    LinkPairing(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put(LinkCapabilities.PACKET_TYPE_CAPABILITIES, this::handleCapabilitiesPacket);
        handlers.put("link.rename.request", this::handleRenameRequestPacket);
        handlers.put("link.rename", this::handleRenamePacket);
    }

    // Last effective-capabilities list each connected peer sent, cached so a WebView reload can
    // restore gated-plugin visibility via getConnectedDevices without waiting for the peer to
    // resend (mirrors desktop's peer_capabilities in core/host.rs).
    final java.util.Map<String, org.json.JSONArray> peerCapabilities = new java.util.concurrent.ConcurrentHashMap<>();

    private void handleCapabilitiesPacket(String deviceId, LinkPacket packet) {
        // The peer's gated capabilities this device may currently use; the UI shows a section
        // only if its key is in this list.
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        org.json.JSONArray caps = packet.body.optJSONArray("capabilities");
        if (caps == null) caps = new org.json.JSONArray();
        android.util.Log.d(TAG, "Received capabilities from " + deviceId + ": " + caps.toString());
        peerCapabilities.put(deviceId, caps); // restored after a WebView reload
        data.put("capabilities", caps);
        notifyListeners("peerCapabilitiesReceived", data);
    }

    private void handleRenameRequestPacket(String deviceId, LinkPacket packet) {
        // A peer asks this device to rename itself. Names are self-owned, so apply it locally and
        // broadcast the result to every connected peer, the requester included (mirrors
        // link.rename.request in core/host.rs). Not feature-gated.
        String requestedName = packet.body.optString("deviceName", null);
        if (requestedName != null) {
            String applied = LinkIdentity.saveDeviceName(getContext(), requestedName);
            try {
                plugin.myIdentity = LinkIdentity.loadOrCreate(getContext(), LinkCapabilitiesSchema.CAPABILITIES, LinkCapabilitiesSchema.CAPABILITIES);
                if (plugin.deviceManager != null) {
                    plugin.deviceManager.updateMyIdentity(plugin.myIdentity);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to reload identity after rename request", e);
            }
            JSObject ownData = new JSObject();
            ownData.put("newName", applied);
            notifyListeners("ownDeviceRenamed", ownData);
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("deviceName", applied);
                LinkPacket renamePacket = new LinkPacket("link.rename", body);
                for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                    plugin.deviceManager.sendTo(peerId, renamePacket);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to broadcast rename", e);
            }
        }
    }

    private void handleRenamePacket(String deviceId, LinkPacket packet) {
        // A peer's own name change: update the trust-store alias and the UI without reconnecting.
        String newName = LinkIdentity.filterDeviceName(packet.body.optString("deviceName", ""));
        if (!newName.isEmpty()) {
            LinkTrustStore store = LinkTrustStore.getInstance(getContext());
            store.rename(deviceId, newName);
            if (plugin.deviceManager != null) {
                plugin.deviceManager.updatePeerName(deviceId, newName);
            }
            JSObject data = new JSObject();
            data.put("deviceId", deviceId);
            data.put("newName", newName);
            notifyListeners("deviceRenamed", data);
        }
    }

    @LinkMethod
    public void getIdentity(LinkCall call) {
        JSObject data = new JSObject();
        data.put("deviceId", plugin.myIdentity.deviceId);
        data.put("deviceName", plugin.myIdentity.deviceName);
        data.put("deviceType", plugin.myIdentity.deviceType);
        java.util.List<String> allIps = plugin.connections.getAllLocalIpAddresses();
        data.put("ipAddress", allIps.isEmpty() ? "127.0.0.1" : allIps.get(0));
        JSArray arr = new JSArray();
        for (String ip : allIps) {
            arr.put(ip);
        }
        data.put("ipAddresses", arr);
        call.resolve(data);
    }

    @LinkMethod
    public void getVisibility(LinkCall call) {
        if (plugin.settings == null) plugin.settings = new LinkSettings(getContext());
        plugin.settings.load();
        JSObject data = new JSObject();
        data.put("enabled", plugin.settings.discoveryVisibility);
        call.resolve(data);
    }

    @LinkMethod
    public void getRemoteTailscale(LinkCall call) {
        if (plugin.settings == null) plugin.settings = new LinkSettings(getContext());
        plugin.settings.load();
        JSObject data = new JSObject();
        data.put("enabled", plugin.settings.remoteTailscale);
        call.resolve(data);
    }

    @LinkMethod
    public void setRemoteTailscale(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (plugin.settings == null) plugin.settings = new LinkSettings(getContext());
        plugin.settings.saveRemoteTailscale(enabled);
        // Switching it on while away should connect now rather than at the next retry.
        plugin.connections.refreshConnections(false);
        call.resolve();
    }

    /** Whether the Tailscale app is connected on this device, which "Use Tailscale when away" needs. */
    @LinkMethod
    public void getTailscaleStatus(LinkCall call) {
        String ip = LinkTailscale.localAddress();
        JSObject data = new JSObject();
        data.put("running", ip != null);
        data.put("ip", ip);
        call.resolve(data);
    }

    @LinkMethod
    public void setVisibility(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        if (plugin.settings == null) plugin.settings = new LinkSettings(getContext());
        plugin.settings.saveDiscoveryVisibility(enabled);
        // Visibility only controls whether this device broadcasts its identity over UDP; it still
        // listens for and connects to peers that broadcast.
        LinkDiscovery.Watcher watcher = plugin.connections.discoveryWatcher != null ? plugin.connections.discoveryWatcher : LinkConnections.sDiscoveryWatcher;
        if (watcher != null) {
            watcher.setVisibility(enabled);
        }

        // Disconnect untrusted peers immediately instead of waiting for their discovery entries to
        // expire. Paired devices stay connected.
        if (!enabled && plugin.deviceManager != null) {
            for (LinkDeviceManager.ConnectedPeerInfo info : plugin.deviceManager.connectedPeers()) {
                if (!info.trusted) {
                    plugin.deviceManager.closeConnection(info.identity.deviceId);
                }
            }
        }
        call.resolve();
    }

    /** A tool is showing its QR code: returns the fingerprint and one-time token it carries. */
    @LinkMethod
    public void openGuestQr(LinkCall call) {
        int port = call.getInt("port", 0);
        JSObject ret = new JSObject();
        ret.put("token", LinkGuestAccess.openQr(port));
        ret.put("fingerprint", plugin.deviceManager.fingerprint());
        call.resolve(ret);
    }

    @LinkMethod
    public void refreshGuestQr(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("token", LinkGuestAccess.refreshQr(call.getInt("port", 0)));
        call.resolve(ret);
    }

    @LinkMethod
    public void closeGuestQr(LinkCall call) {
        LinkGuestAccess.closeQr(call.getInt("port", 0));
        call.resolve(new JSObject());
    }

    /** A tool's QR code was scanned: the next connection to its addresses verifies the host with it. */
    @LinkMethod
    public void rememberGuestScan(LinkCall call) {
        LinkGuestAccess.rememberScan(call.getString("addresses"), call.getString("fingerprint"), call.getString("token"));
        call.resolve(new JSObject());
    }

    @LinkMethod
    public void openPairingWindow(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("token", plugin.deviceManager.openPairingWindow());
        ret.put("fingerprint", plugin.deviceManager.fingerprint());
        call.resolve(ret);
    }

    @LinkMethod
    public void refreshPairingToken(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("token", plugin.deviceManager.refreshPairingToken());
        call.resolve(ret);
    }

    @LinkMethod
    public void closePairingWindow(LinkCall call) {
        plugin.deviceManager.closePairingWindow();
        call.resolve(new JSObject());
    }

    @LinkMethod
    public void acceptPairing(LinkCall call) {
        plugin.deviceManager.acceptPairing(call.getString("deviceId"));
        call.resolve();
    }

    @LinkMethod
    public void cancelPairing(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (plugin.deviceManager != null && deviceId != null) {
            plugin.deviceManager.cancelPairing(deviceId);
        }
        call.resolve();
    }

    @LinkMethod
    public void rejectPairing(LinkCall call) {
        String deviceId = call.getString("deviceId");
        plugin.deviceManager.rejectPairing(deviceId);
        Boolean shouldBlock = call.getBoolean("shouldBlock");
        if (Boolean.TRUE.equals(shouldBlock) && deviceId != null) {
            String deviceName = call.getString("deviceName");
            String label = deviceName != null ? deviceName : (deviceId.length() >= 8 ? deviceId.substring(0, 8) : deviceId);
            // Store the IP too: guest joins of untrusted tools are checked by IP only (see
            // LinkBlocklist.isBlocked).
            String ip = plugin.deviceManager != null ? plugin.deviceManager.remoteAddressOf(deviceId) : null;
            LinkBlocklist.add(getContext(), deviceId, label, "device", call.getString("deviceType"), ip);
        }
        call.resolve();
    }

    @LinkMethod
    public void getBlocklist(LinkCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("entries", new JSArray(LinkBlocklist.getAll(getContext()).toString()));
        } catch (Exception ignored) {}
        call.resolve(ret);
    }

    @LinkMethod
    public void blockDevice(LinkCall call) {
        String id = call.getString("id");
        String label = call.getString("label");
        String type = call.getString("type");
        if (id != null) {
            // Store the IP too: guest joins of untrusted tools are checked by IP only (see
            // LinkBlocklist.isBlocked).
            String ip = "device".equals(type) && plugin.deviceManager != null ? plugin.deviceManager.remoteAddressOf(id) : null;
            LinkBlocklist.add(getContext(), id, label != null ? label : id, type != null ? type : "device", null, ip);
            if ("device".equals(type) && plugin.deviceManager != null) {
                plugin.deviceManager.closeConnection(id);
            }
        }
        getBlocklist(call);
    }

    @LinkMethod
    public void unblockDevice(LinkCall call) {
        String id = call.getString("id");
        if (id != null) LinkBlocklist.remove(getContext(), id);
        getBlocklist(call);
    }

    @LinkMethod
    public void unpair(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (plugin.deviceManager != null && deviceId != null) {
            // Tells the pool, remembers the removal (so members that are offline now cannot bring the
            // device back), then lets go of it.
            plugin.deviceManager.unpairFromPool(deviceId);
        }
        call.resolve();
    }

    @LinkMethod
    public void exitPool(LinkCall call) {
        if (plugin.deviceManager != null) {
            LinkTrustStore store = LinkTrustStore.getInstance(getContext());
            for (LinkTrustStore.TrustedDevice d : store.list()) {
                plugin.deviceManager.unpair(d.deviceId);
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void getTrustedDevices(LinkCall call) {
        try {
            LinkTrustStore store = LinkTrustStore.getInstance(getContext());
            JSArray arr = new JSArray();
            for (LinkTrustStore.TrustedDevice d : store.list()) {
                JSObject obj = new JSObject();
                obj.put("deviceId", d.deviceId);
                obj.put("deviceName", d.deviceName);
                if (d.lastKnownIp != null) obj.put("lastKnownIp", d.lastKnownIp);
                obj.put("deviceType", "desktop"); // default assume desktop, updated dynamically on connect
                obj.put("trusted", true);
                obj.put("connected", false);
                arr.put(obj);
            }
            JSObject result = new JSObject();
            result.put("devices", arr);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to list trusted devices: " + e.getMessage());
        }
    }

    // Called on UI mount: a WebView reload clears the UI's state without dropping connections, and
    // sendInitialSync() otherwise only runs on connect. Mirrors desktop's resync_devices command
    // (resync_all() in core/host.rs).
    @LinkMethod
    public void resyncDevices(LinkCall call) {
        if (plugin.connections.trustedReconnectRunnable != null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).post(plugin.connections.trustedReconnectRunnable);
        }
        if (plugin.deviceManager != null) {
            for (String deviceId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                // Send this device's state to the peer...
                plugin.sendInitialSync(deviceId);
                // ...and ask for the peer's, so its sections repopulate in one round trip (answered
                // by the peer's 'link.resync.request' handler).
                try {
                    plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.resync.request", new org.json.JSONObject()));
                } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    // Per-device permissions, stored natively by LinkDevicePermissions.
    @LinkMethod
    public void getPermissions(LinkCall call) {
        JSObject result = new JSObject();
        try {
            result = new JSObject(LinkDevicePermissions.getAll(getContext()).toString());
        } catch (Exception ignored) {}
        call.resolve(result);
    }

    @LinkMethod
    public void setPermissions(LinkCall call) {
        org.json.JSONObject newPermissions = call.getData();
        org.json.JSONObject oldPermissions = LinkDevicePermissions.getAll(getContext());
        LinkDevicePermissions.setAll(getContext(), newPermissions);

        // Send each affected peer its updated capabilities, which alone drive section visibility
        // in its UI. When systemvolume/mpris/flashlight/dnd has just been allowed, also send the
        // current state so the newly shown section is not empty. An unset key counts as allowed,
        // as in LinkDevicePermissions.check(), hence optBoolean(..., true).
        if (plugin.deviceManager != null) {
            java.util.Iterator<String> keys = newPermissions.keys();
            while (keys.hasNext()) {
                String deviceId = keys.next();
                if (!plugin.deviceManager.trustedConnectedDeviceIds().contains(deviceId)) continue;
                org.json.JSONObject oldPerm = oldPermissions.optJSONObject(deviceId);
                org.json.JSONObject newPerm = newPermissions.optJSONObject(deviceId);
                if (newPerm == null) continue;

                plugin.deviceManager.sendTo(deviceId, LinkCapabilities.createCapabilitiesPacket(getContext(), deviceId));

                boolean volumeWasAllowed = oldPerm == null || oldPerm.optBoolean("systemvolume", true);
                boolean volumeNowAllowed = newPerm.optBoolean("systemvolume", true);
                if (volumeNowAllowed && !volumeWasAllowed) {
                    android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
                    plugin.deviceManager.sendTo(deviceId, LinkSystemVolume.createLocalSinksPacket(audio));
                }

                boolean mprisWasAllowed = oldPerm == null || oldPerm.optBoolean("mpris", true);
                boolean mprisNowAllowed = newPerm.optBoolean("mpris", true);
                if (mprisNowAllowed && !mprisWasAllowed) {
                    plugin.deviceManager.sendTo(deviceId, LinkMpris.createLocalStatePacket(getContext()));
                }

                boolean flashlightWasAllowed = oldPerm == null || oldPerm.optBoolean("flashlight", true);
                boolean flashlightNowAllowed = newPerm.optBoolean("flashlight", true);
                if (flashlightNowAllowed && !flashlightWasAllowed) {
                    plugin.deviceManager.sendTo(deviceId, LinkFlashlight.createStatusPacket(LinkFlashlight.isTorchOn()));
                }

                boolean dndWasAllowed = oldPerm == null || oldPerm.optBoolean("dnd", true);
                boolean dndNowAllowed = newPerm.optBoolean("dnd", true);
                if (dndNowAllowed && !dndWasAllowed) {
                    plugin.deviceManager.sendTo(deviceId, LinkDND.createStatusPacket(getContext()));
                }
            }
        }

        call.resolve();
    }

    // Live connection state; getTrustedDevices() always reports connected:false (see
    // LinkDeviceManager.connectedPeers()).
    @LinkMethod
    public void getConnectedDevices(LinkCall call) {
        try {
            JSArray arr = new JSArray();
            if (plugin.deviceManager != null) {
                LinkTrustStore store = LinkTrustStore.getInstance(getContext());
                for (LinkDeviceManager.ConnectedPeerInfo info : plugin.deviceManager.connectedPeers()) {
                    JSObject obj = new JSObject();
                    obj.put("deviceId", info.identity.deviceId);
                    LinkTrustStore.TrustedDevice trustedDev = store.get(info.identity.deviceId);
                    String name = (trustedDev != null && trustedDev.deviceName != null) ? trustedDev.deviceName : info.identity.deviceName;
                    obj.put("deviceName", name);
                    String remoteIp = plugin.deviceManager.remoteAddressOf(info.identity.deviceId);
                    if (remoteIp != null) {
                        obj.put("ipAddress", remoteIp);
                        obj.put("link", LinkTailscale.isTailscaleAddr(remoteIp) ? "remote" : "lan");
                    }
                    obj.put("deviceType", info.identity.deviceType);
                    obj.put("incomingCapabilities", new JSArray(info.identity.incomingCapabilities));
                    obj.put("outgoingCapabilities", new JSArray(info.identity.outgoingCapabilities));
                    // Cached capabilities, so a WebView reload restores gated sections immediately.
                    org.json.JSONArray cachedCaps = peerCapabilities.get(info.identity.deviceId);
                    obj.put("allowedCapabilities", cachedCaps != null ? cachedCaps : new org.json.JSONArray());
                    obj.put("trusted", info.trusted);
                    arr.put(obj);
                }
            }
            JSObject result = new JSObject();
            result.put("devices", arr);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to list connected devices: " + e.getMessage());
        }
    }

    @LinkMethod
    public void renameTrustedDevice(LinkCall call) {
        // Names are self-owned, so this asks the peer to rename itself; its "link.rename" reply
        // updates the local trust store (handleRenamePacket). Only works while the peer is
        // connected. Mirrors desktop's rename_trusted_device command.
        String deviceId = call.getString("deviceId");
        String name = call.getString("name");
        if (deviceId == null || name == null) {
            call.reject("Missing deviceId or name");
            return;
        }
        if (plugin.deviceManager == null || !plugin.deviceManager.trustedConnectedDeviceIds().contains(deviceId)) {
            call.reject("Device must be connected to be renamed");
            return;
        }
        try {
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("deviceName", name);
            plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.rename.request", body));
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to send rename request: " + e.getMessage());
        }
    }

    @LinkMethod
    public void renameDevice(LinkCall call) {
        String newName = call.getString("name");
        String applied = LinkIdentity.saveDeviceName(getContext(), newName);
        try {
            plugin.myIdentity = LinkIdentity.loadOrCreate(getContext(), LinkCapabilitiesSchema.CAPABILITIES, LinkCapabilitiesSchema.CAPABILITIES);
            if (plugin.deviceManager != null) {
                plugin.deviceManager.updateMyIdentity(plugin.myIdentity);
            }
            if (plugin.connections.discoveryWatcher != null) {
                plugin.connections.discoveryWatcher.updateLocalIdentity(plugin.myIdentity);
            }
            if (LinkConnections.sDiscoveryWatcher != null) {
                LinkConnections.sDiscoveryWatcher.updateLocalIdentity(plugin.myIdentity);
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to reload identity in renameDevice", e);
        }
        // Tell connected peers so their view updates without reconnecting. Not feature-gated.
        if (plugin.deviceManager != null) {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("deviceName", applied);
                LinkPacket renamePacket = new LinkPacket("link.rename", body);
                for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                    plugin.deviceManager.sendTo(peerId, renamePacket);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to broadcast own rename", e);
            }
        }
        JSObject data = new JSObject();
        data.put("name", applied);
        call.resolve(data);
    }
}
