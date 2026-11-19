package in.rodix.link;

import app.tauri.plugin.JSObject;

// Media and volume: this phone's media sessions (MPRIS) and stream volumes pushed to paired
// devices when they change, and a peer's players and volumes controlled from here.
final class LinkMediaVolume extends LinkFeature {
    LinkMediaVolume(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put(LinkSystemVolume.PACKET_TYPE_SYSTEMVOLUME, this::handleSystemVolumePacket);
        handlers.put(LinkSystemVolume.PACKET_TYPE_SYSTEMVOLUME_REQUEST, this::handleSystemVolumeRequestPacket);
        handlers.put(LinkMpris.PACKET_TYPE_MPRIS, this::handleMprisStatePacket);
        handlers.put(LinkMpris.PACKET_TYPE_MPRIS_REQUEST, this::handleMprisRequestPacket);
    }

    /** Part of LinkPlugin.releaseSystemHooks(): drops pending media reads and the session callbacks. */
    void release() {
        mprisHandler.removeCallbacksAndMessages(null);
        // Runs on the worker thread (which owns the media callbacks) before it quits.
        mprisHandler.post(this::stopWatchingMediaSessions);
    }

    private String lastMprisState = null; // last broadcast state, to skip unchanged reads
    // Media state is pushed when a player reports a change (watchMediaSessions), not polled. All of
    // it runs on the worker thread.
    private final android.os.Handler mprisHandler = new android.os.Handler(plugin.workerThread.getLooper());
    private static final long MPRIS_SETTLE_MS = 300;
    private final Runnable mprisBroadcastRunnable = () -> {
        if (plugin.deviceManager != null && !plugin.deviceManager.trustedConnectedDeviceIds().isEmpty()) {
            broadcastMprisState();
        }
    };
    private android.media.session.MediaSessionManager.OnActiveSessionsChangedListener mediaSessionsListener;
    private final java.util.List<android.util.Pair<android.media.session.MediaController, android.media.session.MediaController.Callback>> mediaControllerCallbacks = new java.util.ArrayList<>();

    // A track change reports metadata and playback state separately; one read covers both.
    private void scheduleMprisBroadcast(long delayMs) {
        mprisHandler.removeCallbacks(mprisBroadcastRunnable);
        mprisHandler.postDelayed(mprisBroadcastRunnable, delayMs);
    }

    /** Starts listening for players coming and going and for their changes, once notification
     *  access (which reading media sessions needs) is granted. Retried on resume and on each
     *  connect, since the user grants that access in Settings. */
    void watchMediaSessions() {
        mprisHandler.post(() -> {
            if (mediaSessionsListener != null || !LinkNotificationReceiver.isPermissionGranted(getContext())) return;
            try {
                android.media.session.MediaSessionManager manager =
                    (android.media.session.MediaSessionManager) getContext().getSystemService(android.content.Context.MEDIA_SESSION_SERVICE);
                if (manager == null) return;
                android.content.ComponentName component = new android.content.ComponentName(getContext(), LinkNotificationReceiver.class);
                android.media.session.MediaSessionManager.OnActiveSessionsChangedListener listener = controllers -> {
                    trackMediaControllers(controllers);
                    scheduleMprisBroadcast(MPRIS_SETTLE_MS);
                };
                manager.addOnActiveSessionsChangedListener(listener, component, mprisHandler);
                mediaSessionsListener = listener;
                trackMediaControllers(manager.getActiveSessions(component));
                scheduleMprisBroadcast(MPRIS_SETTLE_MS);
            } catch (Exception e) {
                android.util.Log.w(TAG, "Cannot watch media sessions yet", e);
            }
        });
    }

    private void trackMediaControllers(java.util.List<android.media.session.MediaController> controllers) {
        for (android.util.Pair<android.media.session.MediaController, android.media.session.MediaController.Callback> pair : mediaControllerCallbacks) {
            try { pair.first.unregisterCallback(pair.second); } catch (Exception ignored) {}
        }
        mediaControllerCallbacks.clear();
        if (controllers == null) return;
        for (android.media.session.MediaController controller : controllers) {
            android.media.session.MediaController.Callback callback = new android.media.session.MediaController.Callback() {
                // Players also republish their state to move the position along; only a change in
                // play state or available controls is worth a read.
                private int lastState = -1;
                private long lastActions = -1;

                @Override
                public void onPlaybackStateChanged(android.media.session.PlaybackState state) {
                    int code = state != null ? state.getState() : -1;
                    long actions = state != null ? state.getActions() : -1;
                    if (code == lastState && actions == lastActions) return;
                    lastState = code;
                    lastActions = actions;
                    scheduleMprisBroadcast(MPRIS_SETTLE_MS);
                }

                @Override
                public void onMetadataChanged(android.media.MediaMetadata metadata) {
                    scheduleMprisBroadcast(MPRIS_SETTLE_MS);
                }

                @Override
                public void onSessionDestroyed() {
                    scheduleMprisBroadcast(MPRIS_SETTLE_MS);
                }
            };
            try {
                controller.registerCallback(callback, mprisHandler);
                mediaControllerCallbacks.add(new android.util.Pair<>(controller, callback));
            } catch (Exception ignored) {}
        }
    }

    private void stopWatchingMediaSessions() {
        if (mediaSessionsListener != null) {
            try {
                android.media.session.MediaSessionManager manager =
                    (android.media.session.MediaSessionManager) getContext().getSystemService(android.content.Context.MEDIA_SESSION_SERVICE);
                if (manager != null) manager.removeOnActiveSessionsChangedListener(mediaSessionsListener);
            } catch (Exception ignored) {}
            mediaSessionsListener = null;
        }
        trackMediaControllers(null);
    }

    // VOLUME_CHANGED_ACTION fires for every stream on each step of a volume key or slider, so the
    // broadcast is limited to one per VOLUME_THROTTLE_MS and skipped when nothing changed.
    private static final long VOLUME_THROTTLE_MS = 250;
    private final java.util.concurrent.atomic.AtomicBoolean volumeBroadcastPending = new java.util.concurrent.atomic.AtomicBoolean(false);
    private String lastVolumeState = null;
    private final Runnable volumeBroadcastRunnable = () -> {
        volumeBroadcastPending.set(false);
        if (plugin.deviceManager == null || plugin.deviceManager.trustedConnectedDeviceIds().isEmpty()) return;
        android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        LinkPacket np = LinkSystemVolume.createLocalSinksPacket(audio);
        String state = np.body.toString();
        if (state.equals(lastVolumeState)) return;
        lastVolumeState = state;
        broadcastToPermittedPeers("systemvolume", np);
    };

    private void broadcastMprisState() {
        if (plugin.deviceManager == null) return;
        LinkPacket packet = LinkMpris.createLocalStatePacket(getContext());
        // The playback position moves every second and no screen shows it, so it is left out of the comparison;
        // otherwise the whole state would be sent again every poll while something plays.
        String currentState;
        try {
            org.json.JSONObject comparable = new org.json.JSONObject(packet.body.toString());
            comparable.remove("pos");
            currentState = comparable.toString();
        } catch (org.json.JSONException e) {
            currentState = packet.body.toString();
        }
        // Only changes are broadcast, which avoids UI flicker on peers.
        if (currentState.equals(lastMprisState)) return;
        lastMprisState = currentState;
        broadcastToPermittedPeers("mpris", packet);
    }

    void watchVolume() {
        android.content.BroadcastReceiver volumeReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context context, android.content.Intent intent) {
                if ("android.media.VOLUME_CHANGED_ACTION".equals(intent.getAction())
                        && volumeBroadcastPending.compareAndSet(false, true)) {
                    // At most one read per VOLUME_THROTTLE_MS; see volumeBroadcastRunnable.
                    plugin.telephonyHandler.postDelayed(volumeBroadcastRunnable, VOLUME_THROTTLE_MS);
                }
            }
        };
        android.content.IntentFilter volumeFilter = new android.content.IntentFilter("android.media.VOLUME_CHANGED_ACTION");
        plugin.registerSystemReceiver(volumeReceiver, volumeFilter, 0);
    }

    private void handleSystemVolumePacket(String deviceId, LinkPacket packet) {
        java.util.List<LinkSystemVolume.Sink> sinks = LinkSystemVolume.allSinks(packet);
        android.util.Log.i(TAG, "SYSTEM VOLUME RECEIVED: " + sinks.size() + " sinks");
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        org.json.JSONArray arr = new org.json.JSONArray();
        for (LinkSystemVolume.Sink sink : sinks) {
            try {
                org.json.JSONObject obj = new org.json.JSONObject();
                obj.put("name", sink.name);
                obj.put("description", sink.description);
                obj.put("volume", sink.volume);
                obj.put("muted", sink.muted);
                arr.put(obj);
            } catch (Exception ignored) {}
        }
        data.put("sinks", arr);
        notifyListeners("systemVolumeReceived", data);
    }

    private void handleSystemVolumeRequestPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "systemvolume")) {
            android.util.Log.i(TAG, "Blocked System Volume request from " + deviceId + " (Permission disabled)");
            return;
        }
        android.media.AudioManager audio = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        LinkSystemVolume.handleLocalVolumeRequest(packet, audio);
        plugin.deviceManager.sendTo(deviceId, LinkSystemVolume.createLocalSinksPacket(audio));
    }

    private void handleMprisStatePacket(String deviceId, LinkPacket packet) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        try {
            data.put("state", new JSObject(packet.body.toString()));
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed parsing mpris json", e);
        }
        notifyListeners("mprisStateReceived", data);
    }

    private void handleMprisRequestPacket(String deviceId, LinkPacket packet) {
        String action = packet.body.optString("action");
        if (!LinkDevicePermissions.check(getContext(), deviceId, "mpris")) {
            android.util.Log.i(TAG, "Blocked MPRIS request from " + deviceId + " (Permission disabled)");
            return;
        }
        LinkMpris.handleMediaRequest(getContext(), packet);
        // The player's own callback usually reports the change too; both land in one read.
        scheduleMprisBroadcast(150);
    }

    @LinkMethod
    public void sendSetVolume(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String sinkName = call.getString("name", "default");
        int volume = call.getInt("volume", 0);
        plugin.deviceManager.sendTo(deviceId, LinkSystemVolume.createSetVolumePacket(sinkName, volume));
        call.resolve();
    }

    @LinkMethod
    public void sendSetMute(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String sinkName = call.getString("name", "default");
        boolean muted = call.getBoolean("muted", false);
        plugin.deviceManager.sendTo(deviceId, LinkSystemVolume.createSetMutePacket(sinkName, muted));
        call.resolve();
    }

    @LinkMethod
    public void sendMprisAction(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String player = call.getString("player", "Global Media Control");
        String action = call.getString("action");
        plugin.deviceManager.sendTo(deviceId, LinkMpris.createActionPacket(player, action));
        call.resolve();
    }
}
