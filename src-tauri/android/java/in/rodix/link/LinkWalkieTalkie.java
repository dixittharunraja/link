package in.rodix.link;

import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

import org.json.JSONObject;

// Walkie Talkie (real-time multi-party voice, WebRTC full mesh). Signaling relay only: session
// membership and SDP/ICE live in WalkieTalkieTab.tsx, and audio runs in the WebView via
// getUserMedia/RTCPeerConnection. `body` is forwarded as opaque JSON. No per-device permission:
// pairing is the trust decision for this session tool.
final class LinkWalkieTalkie extends LinkFeature {
    LinkWalkieTalkie(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPacketPrefixes(java.util.Map<String, LinkPlugin.PacketHandler> prefixHandlers) {
        prefixHandlers.put("link.walkietalkie.", this::handleWalkieTalkieSignalPacket);
    }

    // Walkie Talkie signaling for unpaired participants (manual IP + PIN); paired members use the
    // trusted connection (handleWalkieTalkieSignalPacket).
    static LinkWalkieTalkieServer sWalkieTalkieGuestServer;
    static LinkWalkieTalkieClient sWalkieTalkieGuestClient;

    @Override
    void stopPreviousInstance() {
        if (sWalkieTalkieGuestClient != null) {
            sWalkieTalkieGuestClient.disconnect();
            sWalkieTalkieGuestClient = null;
        }
        if (sWalkieTalkieGuestServer != null) {
            try {
                sWalkieTalkieGuestServer.stop();
            } catch (Exception e) {
                android.util.Log.e(TAG, "Error stopping previous WalkieTalkieServer", e);
            }
            sWalkieTalkieGuestServer = null;
        }
    }

    private void handleWalkieTalkieSignalPacket(String deviceId, LinkPacket packet) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("type", packet.type);
        data.put("body", packet.body != null ? packet.body.toString() : "{}");
        notifyListeners("walkieTalkieSignal", data);
    }

    @LinkMethod
    public void sendWalkieTalkieSignal(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (plugin.deviceManager != null && deviceId != null && type != null) {
            try {
                plugin.deviceManager.sendTo(deviceId, new LinkPacket(type, new JSONObject(bodyStr)));
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @LinkMethod
    public void broadcastWalkieTalkieSignal(LinkCall call) {
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (plugin.deviceManager != null && type != null) {
            for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                try {
                    plugin.deviceManager.sendTo(peerId, new LinkPacket(type, new JSONObject(bodyStr)));
                } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    // --- Hosting for unpaired participants (manual IP + PIN) ---
    @LinkMethod
    public void startWalkieTalkieGuestListener(LinkCall call) {
        if (sWalkieTalkieGuestServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.WALKIE_TALKIE_PORT);
            call.resolve(ret);
            return;
        }
        if (plugin.deviceManager == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Not initialized");
            call.resolve(ret);
            return;
        }
        try {
            LinkWalkieTalkieServer server = new LinkWalkieTalkieServer(
                getContext(), plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), LinkTransport.WALKIE_TALKIE_PORT,
                new LinkWalkieTalkieServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("walkieTalkieGuestPinPending", data);
                    }
                    @Override
                    public void onTrustedGuestJoined(String connId, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("walkieTalkieGuestJoined", data);
                    }
                    @Override
                    public void onSignal(String connId, String type, String bodyJson) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("type", type);
                        data.put("body", bodyJson);
                        notifyListeners("walkieTalkieGuestSignal", data);
                    }
                    @Override
                    public void onGuestLeft(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("walkieTalkieGuestLeft", data);
                    }
                    @Override
                    public void onError(String message) {
                        android.util.Log.e(TAG, "Walkie Talkie guest listener error: " + message);
                    }
                },
                idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();
            sWalkieTalkieGuestServer = server;
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
            return;
        }
        JSObject ret = new JSObject();
        ret.put("started", true);
        ret.put("port", LinkTransport.WALKIE_TALKIE_PORT);
        call.resolve(ret);
    }

    @LinkMethod
    public void stopWalkieTalkieGuestListener(LinkCall call) {
        if (sWalkieTalkieGuestServer != null) {
            try { sWalkieTalkieGuestServer.stop(); } catch (Exception ignored) {}
            sWalkieTalkieGuestServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void acceptWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) {
            String ip = sWalkieTalkieGuestServer.getPendingGuestRemoteAddress(connId);
            if (ip != null) plugin.blockUntrustedGuest(ip, null);
            sWalkieTalkieGuestServer.rejectGuest(connId);
            sWalkieTalkieGuestServer.kickGuest(connId);
        }
        call.resolve();
    }

    // Disconnects an admitted guest without blocking, so they can rejoin (mirrors desktop's
    // kick_walkie_talkie_guest command).
    @LinkMethod
    public void kickWalkieTalkieGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sWalkieTalkieGuestServer != null && connId != null) sWalkieTalkieGuestServer.kickGuest(connId);
        call.resolve();
    }

    // Blocks a paired member by deviceId (mirrors desktop's block_walkie_talkie_member command).
    // The current IP is stored too, because guest joins of untrusted tools are checked by IP
    // only (see LinkBlocklist.isBlocked).
    @LinkMethod
    public void blockWalkieTalkieMember(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String label = call.getString("label", deviceId);
        if (deviceId != null) {
            String ip = plugin.deviceManager != null ? plugin.deviceManager.remoteAddressOf(deviceId) : null;
            LinkBlocklist.add(getContext(), deviceId, label, "device", null, ip);
        }
        call.resolve();
    }

    @LinkMethod
    public void sendWalkieTalkieGuestSignal(LinkCall call) {
        String connId = call.getString("connId");
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (sWalkieTalkieGuestServer != null && connId != null && type != null) {
            sWalkieTalkieGuestServer.sendTo(connId, type, bodyStr);
        }
        call.resolve();
    }

    // --- Joining another device's session as an unpaired guest (manual IP) ---
    @LinkMethod
    public void joinWalkieTalkieGuest(LinkCall call) {
        String host = call.getString("host");
        if (plugin.deviceManager == null || host == null) {
            call.resolve();
            return;
        }
        if (sWalkieTalkieGuestClient != null) sWalkieTalkieGuestClient.disconnect();
        LinkWalkieTalkieClient client = new LinkWalkieTalkieClient(new LinkWalkieTalkieClient.Listener() {
            @Override
            public void onPinComputed(String pin) {
                JSObject data = new JSObject();
                data.put("pin", pin);
                notifyListeners("walkieTalkieGuestPinComputed", data);
            }
            @Override
            public void onAdmitted() {
                // No event needed: the host follows admission with a join-accepted signal, which
                // onSignal forwards.
            }
            @Override
            public void onSignal(String type, String bodyJson) {
                JSObject data = new JSObject();
                data.put("type", type);
                data.put("body", bodyJson);
                notifyListeners("walkieTalkieHostSignal", data);
            }
            @Override
            public void onEnded(String reason) {
                sWalkieTalkieGuestClient = null;
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("walkieTalkieHostEnded", data);
            }
            @Override
            public void onClosed(String reason) {
                sWalkieTalkieGuestClient = null;
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("walkieTalkieHostClosed", data);
            }
            @Override
            public void onError(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("walkieTalkieHostError", data);
            }
        });
        sWalkieTalkieGuestClient = client;
        client.connect(host, LinkTransport.WALKIE_TALKIE_PORT, plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), plugin.myIdentity != null ? plugin.myIdentity.deviceName : "Guest");
        call.resolve();
    }

    @LinkMethod
    public void leaveWalkieTalkieGuest(LinkCall call) {
        if (sWalkieTalkieGuestClient != null) {
            sWalkieTalkieGuestClient.disconnect();
            sWalkieTalkieGuestClient = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void sendWalkieTalkieGuestMessage(LinkCall call) {
        String type = call.getString("type");
        String bodyStr = call.getString("body", "{}");
        if (sWalkieTalkieGuestClient != null && type != null) {
            sWalkieTalkieGuestClient.send(type, bodyStr);
        }
        call.resolve();
    }
}
