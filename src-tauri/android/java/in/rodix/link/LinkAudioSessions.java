package in.rodix.link;

import app.tauri.plugin.Invoke;
import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

import org.json.JSONObject;

// Audio sessions: Audio Relay (hosting this phone's playback through AudioPlaybackCapture, or
// listening to another device's) and Remote Mic (this phone's microphone for a paired device), with
// the session notification that carries their Mute and End buttons.
final class LinkAudioSessions extends LinkFeature {
    LinkAudioSessions(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put("link.audiosink.started", this::handleAudioSinkStartedPacket);
        handlers.put("link.audiosink.ended", (deviceId, packet) -> handleAudioSinkEndedPacket(deviceId));
        handlers.put("link.audiosink.query", (deviceId, packet) -> handleAudioSinkQueryPacket(deviceId));
        handlers.put("link.remotemic.query", (deviceId, packet) -> handleRemoteMicQueryPacket(deviceId));
    }

    @Override
    void stopPreviousInstance() {
        if (sAudioSinkClient != null) {
            try {
                sAudioSinkClient.disconnect();
            } catch (Exception e) {
                android.util.Log.e(TAG, "Error disconnecting previous AudioSinkClient", e);
            }
            sAudioSinkClient = null;
        }
        if (sAudioSinkServer != null) {
            try {
                sAudioSinkServer.stop();
            } catch (Exception e) {
                android.util.Log.e(TAG, "Error stopping previous AudioSinkServer", e);
            }
            sAudioSinkServer = null;
        }
    }

    /** The session notification's Mute or End button (ACTION_SESSION_MUTE_TOGGLE / ACTION_SESSION_END). */
    void onSessionAction(android.content.Intent intent) {
        String kind = intent.getStringExtra(EXTRA_SESSION_KIND);
        boolean isEnd = ACTION_SESSION_END.equals(intent.getAction());
        if (SESSION_KIND_AUDIOSINK_HOST.equals(kind)) {
            if (isEnd) {
                stopAudioSinkHosting();
            } else if (sAudioSinkServer != null) {
                sAudioSinkServer.setMuted(!sAudioSinkServer.isMuted());
            }
        } else if (SESSION_KIND_AUDIOSINK_LISTEN.equals(kind)) {
            if (isEnd) {
                if (sAudioSinkClient != null) sAudioSinkClient.disconnect();
                sAudioSinkClient = null;
            } else if (sAudioSinkClient != null) {
                sAudioSinkClient.toggleLocalMute();
            }
        } else if (SESSION_KIND_REMOTEMIC_HOST.equals(kind)) {
            if (isEnd) {
                stopRemoteMicHosting();
            } else if (sRemoteMicServer != null) {
                sRemoteMicServer.setMuted(!sRemoteMicServer.isMuted());
            }
        }
        updateSessionNotification();
    }

    // Audio Relay listener, independent of deviceManager/LinkTrustStore. Static so a reloaded
    // plugin can disconnect it; otherwise the host keeps the old connection and lists this
    // device twice.
    static LinkAudioSinkClient sAudioSinkClient;
    private static String sAudioSinkHostLabel = "";
    static LinkAudioSinkServer sAudioSinkServer;
    private static LinkRemoteMicServer sRemoteMicServer;

    // Notification for an active Audio Relay or Remote Mic session. Separate from the always-on
    // NOTIFICATION_ID so it can be posted and cancelled independently.
    private static final int SESSION_NOTIFICATION_ID = 9992;
    private static final String SESSION_CHANNEL_ID = "link_session_channel";
    public static final String ACTION_SESSION_MUTE_TOGGLE = "in.rodix.link.ACTION_SESSION_MUTE_TOGGLE";
    public static final String ACTION_SESSION_END = "in.rodix.link.ACTION_SESSION_END";
    public static final String EXTRA_SESSION_KIND = "sessionKind";
    // Sessions the notification can represent, in priority order. If several are active at once,
    // only the first is shown.
    private static final String SESSION_KIND_AUDIOSINK_HOST = "audiosink_host";
    private static final String SESSION_KIND_AUDIOSINK_LISTEN = "audiosink_listen";
    private static final String SESSION_KIND_REMOTEMIC_HOST = "remotemic_host";

    private void handleAudioSinkStartedPacket(String deviceId, LinkPacket packet) {
        String token = packet.body.optString("token", null);
        // The host address comes from the sender's connection, not the packet: the sender only
        // knows this device's address on the link, not the one this device should dial.
        String host = plugin.deviceManager != null ? plugin.deviceManager.remoteAddressOf(deviceId) : null;
        if (token == null || host == null) return;
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("token", token);
        data.put("host", host);
        notifyListeners("audioSinkPairedSessionStarted", data);
    }

    private void handleAudioSinkEndedPacket(String deviceId) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        notifyListeners("audioSinkPairedSessionEnded", data);
    }

    /** A peer opened its Audio Relay tab after the session started: if hosting, send it a fresh
     *  one-time token as at session start (mirrors link.audiosink.query in core/host.rs). */
    private void handleAudioSinkQueryPacket(String deviceId) {
        if (sAudioSinkServer == null || plugin.deviceManager == null) return;
        String token = sAudioSinkServer.issueToken(deviceId, plugin.getDeviceDisplayName(deviceId));
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("port", LinkTransport.AUDIO_RELAY_PORT);
            // No "host": the receiver takes it from this connection (see handleAudioSinkStartedPacket).
            plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.audiosink.started", body));
        } catch (Exception ignored) {}
    }

    private void handleRemoteMicQueryPacket(String deviceId) {
        if (sRemoteMicServer == null || plugin.deviceManager == null) return;
        String token = sRemoteMicServer.issueToken(deviceId, plugin.getDeviceDisplayName(deviceId));
        try {
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.remotemic.started", body));
        } catch (Exception ignored) {}
    }

    // ===== Audio Relay (host + listener) =====
    @LinkMethod
    public void joinAudioSinkGuest(LinkCall call) {
        String host = call.getString("host");
        if (host == null || plugin.deviceManager == null) {
            call.reject("Missing host, or not initialized");
            return;
        }
        startAudioSinkListener(host, null);
        call.resolve();
    }

    @LinkMethod
    public void joinAudioSinkPaired(LinkCall call) {
        String host = call.getString("host");
        String token = call.getString("token");
        if (host == null || token == null || plugin.deviceManager == null) {
            call.reject("Missing host/token, or not initialized");
            return;
        }
        startAudioSinkListener(host, token);
        call.resolve();
    }

    @LinkMethod
    public void leaveAudioSink(LinkCall call) {
        if (sAudioSinkClient != null) {
            sAudioSinkClient.disconnect();
            sAudioSinkClient = null;
        }
        sAudioSinkHostLabel = "";
        updateSessionNotification();
        call.resolve();
    }

    @LinkMethod
    public void setAudioSinkListenerVolume(LinkCall call) {
        Double volume = call.getDouble("volume");
        if (sAudioSinkClient != null && volume != null) {
            sAudioSinkClient.setVolume(volume.floatValue());
        }
        call.resolve();
    }

    /** Called when the Audio Relay tab opens. A host's 'link.audiosink.started' is sent once, so
     *  a peer that opens the tab later asks for it (answered by handleAudioSinkQueryPacket()). */
    @LinkMethod
    public void queryAudioSinkSessions(LinkCall call) {
        if (plugin.deviceManager != null) {
            for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                plugin.deviceManager.sendTo(peerId, new LinkPacket("link.audiosink.query", new JSONObject()));
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void setAudioSinkMuted(LinkCall call) {
        Boolean muted = call.getBoolean("muted");
        if (sAudioSinkServer != null && muted != null) sAudioSinkServer.setMuted(muted);
        updateSessionNotification();
        call.resolve();
    }

    @LinkMethod
    public void acceptAudioSinkGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectAudioSinkGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockAudioSinkGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) {
            String remoteAddress = sAudioSinkServer.getPendingGuestRemoteAddress(connId);
            if (remoteAddress != null) {
                plugin.blockUntrustedGuest(remoteAddress, null);
            }
            sAudioSinkServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickAudioSinkListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) sAudioSinkServer.kickListener(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockAudioSinkListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sAudioSinkServer != null && connId != null) {
            LinkAudioSinkServer.ListenerBlockInfo info = sAudioSinkServer.getListenerBlockInfo(connId);
            if (info != null) {
                if (info.deviceId != null) {
                    // Store the IP too: guest joins are checked by IP only (mirrors desktop's
                    // block_guest_device()).
                    LinkBlocklist.add(getContext(), info.deviceId, plugin.getDeviceDisplayName(info.deviceId), "device", null, info.remoteAddress);
                } else {
                    plugin.blockUntrustedGuest(info.remoteAddress, null);
                }
            }
            sAudioSinkServer.kickListener(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void getAudioSinkListeners(LinkCall call) {
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        if (sAudioSinkServer != null) {
            for (LinkAudioSinkServer.ListenerInfo l : sAudioSinkServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    // AudioSinkTab.tsx calls this on mount to restore the hosting/listening state of a running
    // session. Same shape as desktop's get_audio_sink_status command.
    @LinkMethod
    public void getAudioSinkStatus(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("hosting", sAudioSinkServer != null);
        ret.put("listening", sAudioSinkClient != null);
        ret.put("hostLabel", sAudioSinkHostLabel);
        JSArray arr = new JSArray();
        if (sAudioSinkServer != null) {
            for (LinkAudioSinkServer.ListenerInfo l : sAudioSinkServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    @LinkMethod
    public void endAudioSink(LinkCall call) {
        stopAudioSinkHosting();
        call.resolve();
    }

    /** Teardown shared by the End Session button and the OS "Stop casting" control
     *  (MediaProjection.Callback.onStop() in onMediaProjectionResult()). */
    private void stopAudioSinkHosting() {
        if (sAudioSinkServer == null) return;
        if (plugin.deviceManager != null) {
            for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                plugin.deviceManager.sendTo(peerId, new LinkPacket("link.audiosink.ended", new JSONObject()));
            }
        }
        try {
            sAudioSinkServer.stop();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Error stopping AudioSinkServer", e);
        }
        sAudioSinkServer = null;
        updateSessionNotification();
    }

    /** RECORD_AUDIO is requested before the MediaProjection consent dialog, because building the
     *  capture config (AudioPlaybackCaptureConfiguration) without it throws a SecurityException. */
    @LinkMethod
    public void startAudioSink(LinkCall call) {
        if (sAudioSinkServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call.invoke(), "onRecordAudioPermissionResult");
            return;
        }
        launchMediaProjectionConsent(call);
    }

    // Called through LinkPlugin's @PermissionCallback of the same name.
    void onRecordAudioPermissionResult(Invoke invoke) {
        LinkCall call = new LinkCall(invoke);
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Microphone permission denied");
            call.resolve(ret);
            return;
        }
        launchMediaProjectionConsent(call);
    }

    private void launchMediaProjectionConsent(LinkCall call) {
        android.media.projection.MediaProjectionManager mgr =
            (android.media.projection.MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
        android.content.Intent intent = mgr.createScreenCaptureIntent();
        startActivityForResult(call.invoke(), intent, "onMediaProjectionResult");
    }

    // Called through LinkPlugin's @ActivityCallback of the same name.
    void onMediaProjectionResult(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Audio capture permission was not granted");
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
            android.media.projection.MediaProjectionManager mgr =
                (android.media.projection.MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
            android.media.projection.MediaProjection projection = mgr.getMediaProjection(result.getResultCode(), result.getData());

            LinkAudioSinkServer server = new LinkAudioSinkServer(
                getContext(), plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), LinkTransport.AUDIO_RELAY_PORT,
                new LinkAudioSinkServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("audioSinkGuestPinPending", data);
                    }
                    @Override
                    public void onListenerJoined(String connId, String label) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("label", label);
                        notifyListeners("audioSinkListenerJoined", data);
                    }
                    @Override
                    public void onListenerLeft(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("audioSinkListenerLeft", data);
                    }
                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        notifyListeners("audioSinkError", data);
                    }
                }, idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();

            // The OS "Stop casting" control tears down like End Session, so the UI does not keep
            // showing a dead capture as hosting.
            projection.registerCallback(new android.media.projection.MediaProjection.Callback() {
                @Override
                public void onStop() {
                    JSObject data = new JSObject();
                    data.put("message", "Capture stopped by the system");
                    notifyListeners("audioSinkError", data);
                    stopAudioSinkHosting();
                }
            }, new android.os.Handler(android.os.Looper.getMainLooper()));

            server.startCapture(projection);
            sAudioSinkServer = server;

            for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                String token = server.issueToken(peerId, plugin.getDeviceDisplayName(peerId));
                try {
                    JSONObject body = new JSONObject();
                    body.put("token", token);
                    body.put("port", LinkTransport.AUDIO_RELAY_PORT);
                    // No "host" — see handleAudioSinkQueryPacket.
                    plugin.deviceManager.sendTo(peerId, new LinkPacket("link.audiosink.started", body));
                } catch (Exception ignored) {}
            }

            updateSessionNotification();
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT);
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start Audio Relay hosting", e);
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    private void stopRemoteMicHosting() {
        if (sRemoteMicServer == null) return;
        if (plugin.deviceManager != null) {
            for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                plugin.deviceManager.sendTo(peerId, new LinkPacket("link.remotemic.ended", new JSONObject()));
            }
        }
        try {
            sRemoteMicServer.stop();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Error stopping RemoteMicServer", e);
        }
        sRemoteMicServer = null;
        updateSessionNotification();
    }

    @LinkMethod
    public void startRemoteMic(LinkCall call) {
        if (sRemoteMicServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call.invoke(), "onRecordAudioPermissionResultMic");
            return;
        }
        launchRemoteMic(call);
    }

    // Called through LinkPlugin's @PermissionCallback of the same name.
    void onRecordAudioPermissionResultMic(Invoke invoke) {
        LinkCall call = new LinkCall(invoke);
        if (getPermissionState("microphone") != app.tauri.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Microphone permission denied");
            call.resolve(ret);
            return;
        }
        launchRemoteMic(call);
    }

    private void launchRemoteMic(LinkCall call) {
        if (plugin.deviceManager == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Not initialized");
            call.resolve(ret);
            return;
        }
        try {
            LinkRemoteMicServer server = new LinkRemoteMicServer(
                getContext(), plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), LinkTransport.AUDIO_RELAY_PORT + 2,
                new LinkRemoteMicServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("remoteMicGuestPinPending", data);
                    }
                    @Override
                    public void onListenerJoined(String connId, String label) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("label", label);
                        notifyListeners("remoteMicListenerJoined", data);
                    }
                    @Override
                    public void onListenerLeft(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("remoteMicListenerLeft", data);
                    }
                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        notifyListeners("remoteMicError", data);
                    }
                }, idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();
            server.startCapture();
            sRemoteMicServer = server;

            for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                String token = server.issueToken(peerId, plugin.getDeviceDisplayName(peerId));
                try {
                    JSONObject body = new JSONObject();
                    body.put("token", token);
                    body.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
                    plugin.deviceManager.sendTo(peerId, new LinkPacket("link.remotemic.started", body));
                } catch (Exception ignored) {}
            }

            updateSessionNotification();
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.AUDIO_RELAY_PORT + 2);
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start Remote Mic hosting", e);
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    // RemoteMicTab.tsx's Mute Mic button.
    @LinkMethod
    public void setRemoteMicMuted(LinkCall call) {
        Boolean muted = call.getBoolean("muted");
        if (sRemoteMicServer != null && muted != null) sRemoteMicServer.setMuted(muted);
        updateSessionNotification();
        call.resolve();
    }

    @LinkMethod
    public void acceptRemoteMicGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectRemoteMicGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockRemoteMicGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) {
            String remoteAddress = sRemoteMicServer.getPendingGuestRemoteAddress(connId);
            if (remoteAddress != null) {
                plugin.blockUntrustedGuest(remoteAddress, sRemoteMicServer.getPendingGuestDeviceName(connId));
            }
            sRemoteMicServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickRemoteMicListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) sRemoteMicServer.kickListener(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockRemoteMicListener(LinkCall call) {
        String connId = call.getString("connId");
        if (sRemoteMicServer != null && connId != null) {
            LinkRemoteMicServer.ListenerBlockInfo info = sRemoteMicServer.getListenerBlockInfo(connId);
            if (info != null) {
                if (info.deviceId != null) {
                    // Store the IP too: guest joins are checked by IP only (mirrors desktop's
                    // block_guest_device()).
                    LinkBlocklist.add(getContext(), info.deviceId, plugin.getDeviceDisplayName(info.deviceId), "device", null, info.remoteAddress);
                } else {
                    plugin.blockUntrustedGuest(info.remoteAddress, null);
                }
            }
            sRemoteMicServer.kickListener(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void getRemoteMicListeners(LinkCall call) {
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        if (sRemoteMicServer != null) {
            for (LinkRemoteMicServer.ListenerInfo l : sRemoteMicServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    // RemoteMicTab.tsx calls this on mount to restore a running session, including listeners
    // that joined while the tab was closed (same shape as getRemoteMicListeners()). There is no
    // "streaming" field because Android only hosts Remote Mic.
    @LinkMethod
    public void getRemoteMicStatus(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("hosting", sRemoteMicServer != null);
        JSArray arr = new JSArray();
        if (sRemoteMicServer != null) {
            for (LinkRemoteMicServer.ListenerInfo l : sRemoteMicServer.listenersSnapshot()) {
                JSObject o = new JSObject();
                o.put("id", l.id);
                o.put("label", l.label);
                arr.put(o);
            }
        }
        ret.put("listeners", arr);
        call.resolve(ret);
    }

    @LinkMethod
    public void endRemoteMic(LinkCall call) {
        stopRemoteMicHosting();
        call.resolve();
    }

    /** A null token joins as a guest (PIN confirmation); a token joins as a paired device. Both
     *  use LinkAudioSinkClient against the same relay server. */
    private void startAudioSinkListener(String host, String token) {
        if (sAudioSinkClient != null) {
            sAudioSinkClient.disconnect();
        }
        sAudioSinkClient = new LinkAudioSinkClient(getContext(), new LinkAudioSinkClient.Listener() {
            @Override
            public void onPinComputed(String pin) {
                JSObject data = new JSObject();
                data.put("pin", pin);
                notifyListeners("audioSinkPinComputed", data);
            }

            @Override
            public void onAdmitted(String hostName) {
                sAudioSinkHostLabel = hostName != null ? hostName : "";
                updateSessionNotification();
                JSObject data = new JSObject();
                data.put("hostName", hostName);
                notifyListeners("audioSinkAdmitted", data);
            }

            @Override
            public void onFormat(int sampleRate, int channels, int bitsPerSample, boolean isFloat) {
                JSObject data = new JSObject();
                data.put("sampleRate", sampleRate);
                data.put("channels", channels);
                data.put("bitsPerSample", bitsPerSample);
                data.put("isFloat", isFloat);
                notifyListeners("audioSinkFormat", data);
            }

            @Override
            public void onHostMuted(boolean muted) {
                JSObject data = new JSObject();
                data.put("muted", muted);
                notifyListeners("audioSinkHostMuted", data);
            }

            @Override
            public void onEnded() {
                // Clear the static so getAudioSinkStatus reports listening:false after a kick or
                // host end.
                sAudioSinkClient = null;
                sAudioSinkHostLabel = "";
                updateSessionNotification();
                notifyListeners("audioSinkEnded", new JSObject());
            }

            @Override
            public void onClosed(String reason) {
                sAudioSinkClient = null;
                sAudioSinkHostLabel = "";
                updateSessionNotification();
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("audioSinkClosed", data);
            }

            @Override
            public void onError(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("audioSinkError", data);
            }

            @Override
            public void onStats(long latencyMs, int bufferMs, int underruns, int dropped, boolean clockSynced) {
                JSObject data = new JSObject();
                data.put("latencyMs", latencyMs);
                data.put("bufferMs", bufferMs);
                data.put("underruns", underruns);
                data.put("dropped", dropped);
                data.put("clockSynced", clockSynced);
                notifyListeners("audioSinkStats", data);
            }
        });
        sAudioSinkClient.connect(host, LinkTransport.AUDIO_RELAY_PORT, plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), token, plugin.myIdentity != null ? plugin.myIdentity.deviceName : "Guest");
    }

    /** Posts, rebuilds or cancels the session notification. Call it whenever Audio Relay hosting,
     *  Audio Relay listening or Remote Mic hosting starts, ends or changes mute state. Rebuilt in
     *  full each time; cancelled when no session is active. */
    void updateSessionNotification() {
        android.content.Context context = getContext();
        if (context == null) return;
        android.app.NotificationManager notificationManager =
            (android.app.NotificationManager) context.getSystemService(android.content.Context.NOTIFICATION_SERVICE);

        String kind = null;
        String title = null;
        boolean muted = false;
        if (sAudioSinkServer != null) {
            kind = SESSION_KIND_AUDIOSINK_HOST;
            title = "Hosting Audio Relay";
            muted = sAudioSinkServer.isMuted();
        } else if (sAudioSinkClient != null) {
            kind = SESSION_KIND_AUDIOSINK_LISTEN;
            title = "Listening to Audio Relay";
            muted = sAudioSinkClient.isLocallyMuted();
        } else if (sRemoteMicServer != null) {
            kind = SESSION_KIND_REMOTEMIC_HOST;
            title = "Hosting Remote Mic";
            muted = sRemoteMicServer.isMuted();
        }

        if (kind == null) {
            notificationManager.cancel(SESSION_NOTIFICATION_ID);
            return;
        }

        boolean isHost = !SESSION_KIND_AUDIOSINK_LISTEN.equals(kind);

        android.app.NotificationChannel channel = new android.app.NotificationChannel(
            SESSION_CHANNEL_ID,
            "Active Audio Session",
            android.app.NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows controls for an active Audio Relay or Remote Mic session");
        notificationManager.createNotificationChannel(channel);

        android.content.Intent muteIntent = new android.content.Intent(ACTION_SESSION_MUTE_TOGGLE);
        muteIntent.setPackage(context.getPackageName());
        muteIntent.putExtra(EXTRA_SESSION_KIND, kind);
        android.app.PendingIntent mutePendingIntent = android.app.PendingIntent.getBroadcast(
            context, 1, muteIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );

        android.content.Intent endIntent = new android.content.Intent(ACTION_SESSION_END);
        endIntent.setPackage(context.getPackageName());
        endIntent.putExtra(EXTRA_SESSION_KIND, kind);
        android.app.PendingIntent endPendingIntent = android.app.PendingIntent.getBroadcast(
            context, 2, endIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );

        android.app.Notification.Builder builder = new android.app.Notification.Builder(context, SESSION_CHANNEL_ID);

        builder.setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(muted ? "Muted" : "Live")
            .setOngoing(true);

        String muteLabel = muted ? "Unmute" : "Mute";
        String endLabel = isHost ? "End Session" : "Disconnect";

        builder.addAction(new android.app.Notification.Action.Builder(
            android.graphics.drawable.Icon.createWithResource(context, muted ? android.R.drawable.ic_lock_silent_mode_off : android.R.drawable.ic_lock_silent_mode),
            muteLabel, mutePendingIntent
        ).build());
        builder.addAction(new android.app.Notification.Action.Builder(
            android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.ic_menu_close_clear_cancel),
            endLabel, endPendingIntent
        ).build());

        notificationManager.notify(SESSION_NOTIFICATION_ID, builder.build());
    }
}
