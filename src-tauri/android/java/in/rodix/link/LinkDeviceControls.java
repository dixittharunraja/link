package in.rodix.link;

import app.tauri.plugin.JSObject;

// Small device controls between paired devices: battery, Find My Device, run commands, flashlight,
// Do Not Disturb, screen lock and Speed Test, each a packet from the peer and a call from the UI.
final class LinkDeviceControls extends LinkFeature {
    LinkDeviceControls(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put(LinkBattery.PACKET_TYPE_BATTERY, this::handleBatteryPacket);
        handlers.put(LinkFindMyDevice.PACKET_TYPE_FINDMYDEVICE_REQUEST, this::handleFindMyDevicePacket);
        handlers.put(LinkRunCommand.PACKET_TYPE_RUNCOMMAND, (deviceId, packet) -> {
            if (LinkRunCommand.isCommandListPacket(packet)) handleRunCommandListPacket(deviceId, packet);
        });
        handlers.put(LinkFlashlight.PACKET_TYPE_FLASHLIGHT, this::handleFlashlightPacket);
        handlers.put(LinkDND.PACKET_TYPE_DND, this::handleDndPacket);
        handlers.put(LinkLock.PACKET_TYPE_LOCK, this::handleLockPacket);
        handlers.put(LinkLock.PACKET_TYPE_LOCK_REQUEST, this::handleLockRequestPacket);
        handlers.put(LinkLocation.PACKET_TYPE_REQUEST, this::handleLocationRequestPacket);
        handlers.put(LinkLocation.PACKET_TYPE_LOCATION, this::handleLocationPacket);
        handlers.put("link.speedtest.request", this::handleSpeedTestRequestPacket);
        handlers.put("link.speedtest.response", (deviceId, packet) -> handleSpeedTestResponsePacket(packet));
    }

    // The peer that made this device ring with Find My Device; stopFindMyDevice tells it the ringing stopped.
    private String activeRingerDeviceId = null;

    LinkSpeedTest speedTest;

    private void handleBatteryPacket(String deviceId, LinkPacket packet) {
        boolean isCharging = packet.body.optBoolean("isCharging", false);
        int currentCharge = packet.body.optInt("currentCharge", -1);
        android.util.Log.i(TAG, "BATTERY RECEIVED: " + currentCharge + "% charging=" + isCharging);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("isCharging", isCharging);
        data.put("currentCharge", currentCharge);
        notifyListeners("batteryReceived", data);
    }

    private void handleFindMyDevicePacket(String deviceId, LinkPacket packet) {
        // Not feature-gated or permission-gated: any connected paired device may ring, as with rename.
        boolean cancel = packet.body.optBoolean("cancel", false);
        android.util.Log.i(TAG, "FIND MY DEVICE (cancel=" + cancel + ") triggered by " + deviceId);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        if (cancel) {
            LinkFindMyDevice.stopRinging(getContext());
            activeRingerDeviceId = null;
            notifyListeners("findMyDeviceStopped", data);
        } else {
            activeRingerDeviceId = deviceId;
            LinkFindMyDevice.ring(getContext());
            notifyListeners("findMyDeviceTriggered", data);
        }
    }

    private void handleLocationRequestPacket(String deviceId, LinkPacket packet) {
        // On by default per device, like the other permissions; the user can switch it off.
        if (!LinkDevicePermissions.check(getContext(), deviceId, "location")) {
            android.util.Log.i(TAG, "Blocked location request from " + deviceId + " (Permission disabled)");
            plugin.deviceManager.sendTo(deviceId, LinkLocation.statusPacket("notAllowed"));
            return;
        }
        android.util.Log.i(TAG, "Location requested by " + deviceId);
        LinkLocation.locate(getContext(), (reply) -> plugin.deviceManager.sendTo(deviceId, reply));
    }

    // A peer's position or a status about it ("noPermission", "off", "done", ...), for the Locate screen.
    private void handleLocationPacket(String deviceId, LinkPacket packet) {
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("body", packet.body.toString());
        notifyListeners("locationReceived", data);
    }

    private void handleRunCommandListPacket(String deviceId, LinkPacket packet) {
        org.json.JSONObject commands = LinkRunCommand.parseCommandList(packet);
        android.util.Log.i(TAG, "Command list received from " + deviceId + " (" + commands.length() + " commands)");
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("commands", commands.toString());
        notifyListeners("commandListReceived", data);
    }

    private void handleFlashlightPacket(String deviceId, LinkPacket packet) {
        boolean enabled = packet.body.optBoolean("enabled", false);
        boolean isCommand = packet.body.optBoolean("isCommand", false);

        if (isCommand) {
            // A peer controlling this device's torch.
            if (!LinkDevicePermissions.check(getContext(), deviceId, "flashlight")) {
                android.util.Log.i(TAG, "Blocked flashlight command from " + deviceId + " (Permission disabled)");
                return;
            }
            LinkFlashlight.setTorchMode(getContext(), enabled);
            // The torch callback broadcasts the resulting state once it actually changes.
            return;
        }

        // A peer's state broadcast.
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("enabled", enabled);
        notifyListeners("flashlightStateReceived", data);
    }

    private void handleDndPacket(String deviceId, LinkPacket packet) {
        boolean enabled = packet.body.optBoolean("enabled", false);
        boolean isCommand = packet.body.optBoolean("isCommand", false);

        if (isCommand) {
            // A peer controlling this device's DND; also needs the OS "Do Not Disturb access" grant.
            if (!LinkDevicePermissions.check(getContext(), deviceId, "dnd")) {
                android.util.Log.i(TAG, "Blocked DND command from " + deviceId + " (Permission disabled)");
                return;
            }
            if (!LinkDND.isDndGranted(getContext())) {
                android.util.Log.i(TAG, "Cannot execute DND command from " + deviceId + " — app lacks 'Do Not Disturb access' permission in Android Settings");
                return;
            }
            LinkDND.setDnd(getContext(), enabled);
            // dndReceiver broadcasts the resulting state once it actually changes.
            return;
        }

        // A peer's state broadcast, shown whether or not this device has DND access.
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("enabled", enabled);
        data.put("granted", LinkDND.isDndGranted(getContext()));
        notifyListeners("dndStateReceived", data);
    }

    private void handleLockPacket(String deviceId, LinkPacket packet) {
        boolean isLocked = packet.body.optBoolean("isLocked", false);
        android.util.Log.i(TAG, "LOCK RECEIVED: locked=" + isLocked);
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        data.put("isLocked", isLocked);
        notifyListeners("lockStateReceived", data);

        if (packet.body.has("lockResult")) {
            boolean lockResult = packet.body.optBoolean("lockResult", false);
            JSObject resultData = new JSObject();
            resultData.put("deviceId", deviceId);
            resultData.put("success", lockResult);
            notifyListeners("lockResultReceived", resultData);
        }
    }

    private void handleLockRequestPacket(String deviceId, LinkPacket packet) {
        // Locking is open to every paired device, like the desktop side: it needs no permission.
        Boolean lockResult = null;
        if (packet.body != null && packet.body.optBoolean("setLocked", false)) {
            lockResult = LinkLock.lockDevice();
            android.util.Log.i(TAG, "Remote lock executed: success=" + lockResult);
        }
        plugin.deviceManager.sendTo(deviceId, LinkLock.createLockPacket(getContext(), lockResult));
    }

    private void handleSpeedTestRequestPacket(String deviceId, LinkPacket packet) {
        // LinkSpeedTest answers both roles over the binary payload channel.
        if (speedTest != null) {
            speedTest.handleIncomingRequest(packet, deviceId);
        }
    }

    private void handleSpeedTestResponsePacket(LinkPacket packet) {
        speedTest.handleResponse(packet);
    }

    @LinkMethod
    public void sendFlashlightToggle(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean enabled = call.getBoolean("enabled", false);
        if (plugin.deviceManager != null && deviceId != null) {
            plugin.deviceManager.sendTo(deviceId, LinkFlashlight.createCommandPacket(enabled));
        }
        call.resolve();
    }

    @LinkMethod
    public void sendDndSet(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean enabled = call.getBoolean("enabled", false);
        if (plugin.deviceManager != null && deviceId != null) {
            plugin.deviceManager.sendTo(deviceId, LinkDND.createCommandPacket(enabled));
        }
        call.resolve();
    }

    @LinkMethod
    public void sendFindMyDevice(LinkCall call) {
        String deviceId = call.getString("deviceId");
        plugin.deviceManager.sendTo(deviceId, LinkFindMyDevice.createPacket());
        call.resolve();
    }

    @LinkMethod
    public void stopFindMyDevice(LinkCall call) {
        LinkFindMyDevice.stopRinging(getContext());
        String deviceId = call.getString("deviceId");
        if (deviceId == null) {
            deviceId = activeRingerDeviceId;
        }
        if (deviceId != null) {
            plugin.deviceManager.sendTo(deviceId, LinkFindMyDevice.createPacket(true));
            JSObject data = new JSObject();
            data.put("deviceId", deviceId);
            notifyListeners("findMyDeviceStopped", data);
            activeRingerDeviceId = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void requestDeviceLocation(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (plugin.deviceManager != null && deviceId != null) {
            plugin.deviceManager.sendTo(deviceId, LinkLocation.createRequestPacket());
        }
        call.resolve();
    }

    /** Whether this device may report its position: OS permission granted (precise or not). */
    @LinkMethod
    public void getLocationAccess(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", LinkLocation.hasPermission(getContext()));
        ret.put("precise", LinkLocation.hasPrecise(getContext()));
        call.resolve(ret);
    }

    /** Called after the OS location permission was granted: lets the background service use it. */
    @LinkMethod
    public void refreshLocationAccess(LinkCall call) {
        if (LinkLocation.hasPermission(getContext())) LinkForegroundService.refreshTypes(getContext());
        call.resolve();
    }

    @LinkMethod
    public void triggerCommand(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String key = call.getString("key");
        plugin.deviceManager.sendTo(deviceId, LinkRunCommand.createTriggerPacket(key));
        call.resolve();
    }

    @LinkMethod
    public void sendLockRequest(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean setLocked = call.getBoolean("setLocked", true);
        plugin.deviceManager.sendTo(deviceId, LinkLock.createLockRequestPacket(setLocked, null));
        call.resolve();
    }

    @LinkMethod
    public void sendLockQuery(LinkCall call) {
        String deviceId = call.getString("deviceId");
        plugin.deviceManager.sendTo(deviceId, LinkLock.createLockRequestPacket(null, true));
        call.resolve();
    }

    @LinkMethod
    public void runSpeedTest(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId == null) {
            call.reject("Missing deviceId");
            return;
        }

        if (speedTest == null) {
            call.reject("Speed test manager not initialized");
            return;
        }

        speedTest.startTest(deviceId, new LinkSpeedTest.Listener() {
            @Override
            public void onProgress(String message) {
                JSObject data = new JSObject();
                data.put("deviceId", deviceId);
                data.put("message", message);
                notifyListeners("speedTestProgress", data);
            }

            @Override
            public void onComplete(int latencyMs, double uploadSpeedMbps, double downloadSpeedMbps) {
                JSObject result = new JSObject();
                result.put("latencyMs", latencyMs);
                result.put("uploadSpeedMbps", Math.round(uploadSpeedMbps * 10) / 10.0);
                result.put("downloadSpeedMbps", Math.round(downloadSpeedMbps * 10) / 10.0);
                call.resolve(result);
            }

            @Override
            public void onError(String error) {
                call.reject(error);
            }
        });
    }
}
