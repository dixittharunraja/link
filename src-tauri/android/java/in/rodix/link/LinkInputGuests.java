package in.rodix.link;

import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

// Input sessions joined by address rather than pairing: Joystick (this phone as a controller, or
// hosting one through LinkUinputGamepad) and the input guest host/client for presenter and
// touchpad guests. Their UDP lines go through LinkInputRelay.
final class LinkInputGuests extends LinkFeature {
    LinkInputGuests(LinkPlugin plugin) {
        super(plugin);
    }

    static LinkJoystickServer sJoystickServer;
    private static LinkJoystickClient sJoystickClient;
    static LinkInputGuestServer sInputGuestServer;
    private static LinkInputGuestClient sInputGuestClient;

    /** Joins a joystick host at the scanned or typed address over a LinkJoystickClient TLS
     *  WebSocket. An unpaired phone needs its PIN confirmed on the host (joystickPinRequired); a
     *  paired one is admitted directly (see the header of desktop's core/joystick.rs). After
     *  joystickHelloAck, state is sent as UDP "js ..." lines through LinkInputRelay.sendUdpMessageToHost. */
    @LinkMethod
    public void sendJoystickHello(LinkCall call) {
        String host = call.getString("host");
        String name = call.getString("name", "Controller");
        if (host != null) {
            if (sJoystickClient != null) sJoystickClient.disconnect();
            sJoystickClient = new LinkJoystickClient(new LinkJoystickClient.Listener() {
                @Override
                public void onPinComputed(String pin) {
                    JSObject data = new JSObject();
                    data.put("pin", pin);
                    notifyListeners("joystickPinRequired", data);
                }

                @Override
                public void onAdmitted(int padIndex, String inputToken) {
                    LinkJoystickClient admittedClient = sJoystickClient;
                    if (admittedClient != null && admittedClient.getResolvedHost() != null) {
                        LinkInputRelay.sUdpHostOverrides.put(host, admittedClient.getResolvedHost());
                    }
                    LinkInputRelay.sJoystickInputTokens.clear();
                    if (inputToken != null && !inputToken.isEmpty()) {
                        LinkInputRelay.sJoystickInputTokens.put(LinkInputRelay.udpTargetIp(host), inputToken);
                    }
                    JSObject data = new JSObject();
                    data.put("ok", true);
                    data.put("padIndex", padIndex);
                    notifyListeners("joystickHelloAck", data);
                }

                @Override
                public void onRumble(int large, int small) {
                    // Game rumble is a held motor state, sent on every change. Android has no
                    // indefinite vibration, so a long one-shot runs until the all-zero "motors off"
                    // message cancels it.
                    if (large == 0 && small == 0) {
                        stopVibration(getContext());
                    } else {
                        vibrateNative(getContext(), Math.max(large, small), 60000);
                    }
                }

                @Override
                public void onPing() {
                    notifyListeners("joystickPing", new JSObject());
                }

                @Override
                public void onClosed(String reason) {
                    LinkInputRelay.sJoystickInputTokens.clear();
                    stopVibration(getContext());
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", reason);
                    notifyListeners("joystickHelloAck", data);
                    notifyListeners("joystickForcedDisconnect", new JSObject().put("reason", reason));
                }

                @Override
                public void onError(String message) {
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", message);
                    notifyListeners("joystickHelloAck", data);
                }
            });
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), plugin.myIdentity != null ? plugin.myIdentity.deviceId : "device");
            sJoystickClient.connect(host, LinkTransport.JOYSTICK_PORT, name, tls.certificate, tls.privateKey);
        }
        call.resolve();
    }

    @LinkMethod
    public void sendJoystickBye(LinkCall call) {
        LinkInputRelay.sJoystickInputTokens.clear();
        stopVibration(getContext());
        if (sJoystickClient != null) {
            sJoystickClient.disconnect();
            sJoystickClient = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void startJoystickHost(LinkCall call) {
        if (sJoystickServer != null) {
            call.resolve();
            return;
        }
        try {
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), plugin.myIdentity != null ? plugin.myIdentity.deviceId : "device");
            sJoystickServer = new LinkJoystickServer(getContext(), LinkTransport.JOYSTICK_PORT, tls.certificate, tls.privateKey, new LinkJoystickServer.Listener() {
                @Override
                public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                    JSObject data = new JSObject();
                    data.put("connId", connId);
                    data.put("pin", pin);
                    data.put("remoteAddress", remoteAddress);
                    data.put("name", deviceName);
                    notifyListeners("joystickGuestPinPending", data);
                }

                @Override
                public void onControllerJoined(String remoteAddress, String deviceName, int padIndex) {
                    notifyListeners("joystickRosterChanged", new JSObject());
                }

                @Override
                public void onControllerLeft(String remoteAddress) {
                    notifyListeners("joystickRosterChanged", new JSObject());
                }

                @Override
                public void onDriverStatusChanged(String status, String error) {
                    JSObject data = new JSObject();
                    data.put("status", status);
                    data.put("error", error);
                    notifyListeners("joystickDriverStatus", data);
                }

                @Override
                public void onError(String message) {
                    android.util.Log.e(TAG, "JoystickServer error: " + message);
                }
            });
            sJoystickServer.start();
            call.resolve();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start JoystickServer", e);
            call.reject("Failed to start Joystick host: " + e.getMessage());
        }
    }

    @LinkMethod
    public void stopJoystickHost(LinkCall call) {
        if (sJoystickServer != null) {
            sJoystickServer.stopServer();
            sJoystickServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void getJoystickStatus(LinkCall call) {
        JSObject ret = new JSObject();
        boolean hosting = sJoystickServer != null;
        ret.put("hosting", hosting);

        JSArray controllers = new JSArray();
        if (sJoystickServer != null) {
            for (LinkJoystickServer.ControllerInfo ci : sJoystickServer.getConnectedControllers()) {
                JSObject c = new JSObject();
                c.put("ip", ci.ip);
                c.put("name", ci.name);
                c.put("padIndex", ci.padIndex);
                controllers.put(c);
            }
            LinkUinputGamepad driver = sJoystickServer.getGamepadDriver();
            boolean shizukuReady = driver != null && driver.hasShizukuPermission();
            boolean shizukuRunning = driver != null && driver.isShizukuAvailable();
            ret.put("driverStatus", shizukuReady ? "ready" : "missing");
            ret.put("driverError", shizukuReady ? null : (shizukuRunning ? "permission_needed" : "shizuku_not_running"));
        } else {
            ret.put("driverStatus", "unknown");
            ret.put("driverError", null);
        }
        ret.put("connectedControllers", controllers);
        call.resolve(ret);
    }

    @LinkMethod
    public void checkJoystickDriver(LinkCall call) {
        JSObject ret = new JSObject();
        LinkUinputGamepad driver = sJoystickServer != null ? sJoystickServer.getGamepadDriver() : new LinkUinputGamepad(getContext(), null);
        boolean shizukuReady = driver.hasShizukuPermission();
        boolean shizukuRunning = driver.isShizukuAvailable();
        ret.put("driverStatus", shizukuReady ? "ready" : "missing");
        ret.put("driverError", shizukuReady ? null : (shizukuRunning ? "permission_needed" : "shizuku_not_running"));
        call.resolve(ret);
    }

    @LinkMethod
    public void requestShizukuPermission(LinkCall call) {
        LinkUinputGamepad driver = sJoystickServer != null ? sJoystickServer.getGamepadDriver() : new LinkUinputGamepad(getContext(), null);
        driver.requestShizukuPermission(1748);
        call.resolve();
    }

    @LinkMethod
    public void acceptJoystickGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sJoystickServer != null && connId != null) {
            sJoystickServer.acceptGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void rejectJoystickGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sJoystickServer != null && connId != null) {
            sJoystickServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void blockJoystickGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sJoystickServer != null && connId != null) {
            sJoystickServer.blockGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickJoystickController(LinkCall call) {
        String ip = call.getString("ip");
        if (sJoystickServer != null && ip != null) {
            sJoystickServer.kickController(ip, "removed by host");
        }
        call.resolve();
    }

    @LinkMethod
    public void joinInputGuest(LinkCall call) {
        String host = call.getString("host");
        String name = call.getString("name", plugin.myIdentity != null && plugin.myIdentity.deviceName != null ? plugin.myIdentity.deviceName : "Phone Remote");
        String mode = call.getString("mode", "touchpad");
        if (host != null) {
            if (sInputGuestClient != null) sInputGuestClient.disconnect();
            sInputGuestClient = new LinkInputGuestClient(new LinkInputGuestClient.Listener() {
                @Override
                public void onPinComputed(String pin) {
                    JSObject data = new JSObject();
                    data.put("pin", pin);
                    notifyListeners("inputGuestPinRequired", data);
                }

                @Override
                public void onAdmitted(String admittedMode, String resolvedHost, String hostDeviceType, String inputToken) {
                    if (resolvedHost != null) LinkInputRelay.sUdpHostOverrides.put(host, resolvedHost);
                    LinkInputRelay.sGuestInputTokens.clear();
                    if (inputToken != null && !inputToken.isEmpty()) {
                        LinkInputRelay.sGuestInputTokens.put(LinkInputRelay.udpTargetIp(resolvedHost != null ? resolvedHost : host), inputToken);
                    }
                    JSObject data = new JSObject();
                    data.put("ok", true);
                    data.put("mode", admittedMode);
                    if (resolvedHost != null) data.put("host", resolvedHost);
                    if (hostDeviceType != null) data.put("hostDeviceType", hostDeviceType);
                    notifyListeners("inputGuestAdmitted", data);
                }

                @Override
                public void onMessage(String json) {
                    JSObject data = new JSObject();
                    data.put("message", json);
                    notifyListeners("inputGuestMessage", data);
                }

                @Override
                public void onClosed(String reason) {
                    LinkInputRelay.sGuestInputTokens.clear();
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", reason);
                    notifyListeners("inputGuestClosed", data);
                }

                @Override
                public void onError(String message) {
                    JSObject data = new JSObject();
                    data.put("ok", false);
                    data.put("error", message);
                    notifyListeners("inputGuestError", data);
                }
            });
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), plugin.myIdentity != null ? plugin.myIdentity.deviceId : "device");
            sInputGuestClient.connect(host, LinkTransport.INPUT_GUEST_PORT, name, mode, tls.certificate, tls.privateKey);
        }
        call.resolve();
    }

    @LinkMethod
    public void startInputGuestHost(LinkCall call) {
        if (sInputGuestServer != null) {
            call.resolve();
            return;
        }
        try {
            LinkTls.TlsIdentity tls = LinkTls.loadOrCreate(getContext(), plugin.myIdentity != null ? plugin.myIdentity.deviceId : "device");
            sInputGuestServer = new LinkInputGuestServer(getContext(), LinkTransport.INPUT_GUEST_PORT, tls.certificate, tls.privateKey, plugin.myIdentity != null ? plugin.myIdentity.deviceType : "phone", new LinkInputGuestServer.Listener() {
                // Settles `call` only once: onError() can also fire later for per-connection
                // problems on a running server.
                private boolean startResultSent = false;

                @Override
                public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName, String mode) {
                    JSObject data = new JSObject();
                    data.put("connId", connId);
                    data.put("pin", pin);
                    data.put("remoteAddress", remoteAddress);
                    data.put("name", deviceName);
                    data.put("mode", mode);
                    notifyListeners("inputGuestPinPending", data);
                }

                @Override
                public void onGuestJoined(String remoteAddress, String deviceName, String mode) {
                    if ("remotecontrol".equals(mode) && plugin.deviceManager != null) {
                        // The screen-share code addresses its viewer by device id; a guest gets a
                        // stand-in id whose packets travel over the socket it joined on.
                        plugin.deviceManager.registerVirtualPeer(LinkRemoteControlServer.GUEST_PREFIX + remoteAddress, packet -> {
                            LinkInputGuestServer server = sInputGuestServer;
                            if (server != null) server.sendPacket(remoteAddress, packet);
                        });
                    }
                    notifyListeners("inputGuestRosterChanged", new JSObject());
                }

                @Override
                public void onGuestLeft(String remoteAddress) {
                    String guestId = LinkRemoteControlServer.GUEST_PREFIX + remoteAddress;
                    if (plugin.deviceManager != null) plugin.deviceManager.unregisterVirtualPeer(guestId);
                    // The guest was the viewer: stop sharing the screen with nobody.
                    if (LinkRemoteControl.sRemoteControlServer != null && guestId.equals(LinkRemoteControl.sRemoteControlServer.getTargetDeviceId())) {
                        LinkRemoteControl.sRemoteControlServer.stop();
                        LinkRemoteControl.sRemoteControlServer = null;
                    }
                    notifyListeners("inputGuestRosterChanged", new JSObject());
                }

                @Override
                public void onGuestPacket(String remoteAddress, String packetType, String bodyJson) {
                    String guestId = LinkRemoteControlServer.GUEST_PREFIX + remoteAddress;
                    try {
                        LinkPacket packet = new LinkPacket(packetType, new org.json.JSONObject(bodyJson));
                        if ("link.remotecontrol.signal".equals(packetType)) {
                            plugin.remoteControl.handleRemoteControlSignalPacket(guestId, packet);
                        } else if ("link.remotecontrol.input".equals(packetType)) {
                            plugin.remoteControl.handleRemoteControlInputPacket(guestId, packet);
                        }
                    } catch (Exception e) {
                        android.util.Log.w(TAG, "Bad packet from remote control guest " + remoteAddress, e);
                    }
                }

                @Override
                public void onStarted() {
                    if (!startResultSent) {
                        startResultSent = true;
                        call.resolve();
                    }
                }

                @Override
                public void onError(String message) {
                    android.util.Log.e(TAG, "InputGuestServer error: " + message);
                    if (!startResultSent) {
                        startResultSent = true;
                        // The bind failed, so clear the unusable server (as the catch block does)
                        // or later calls would think it is running.
                        sInputGuestServer = null;
                        call.reject("Failed to start Input Guest server: " + message);
                    }
                }
            });
            sInputGuestServer.start();
        } catch (Exception e) {
            sInputGuestServer = null;
            android.util.Log.e(TAG, "Failed to start InputGuestServer", e);
            call.reject("Failed to start Input Guest server: " + e.getMessage());
        }
    }

    @LinkMethod
    public void stopInputGuestHost(LinkCall call) {
        if (sInputGuestServer != null) {
            sInputGuestServer.stopServer();
            sInputGuestServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void getInputGuestStatus(LinkCall call) {
        JSObject ret = new JSObject();
        boolean hosting = sInputGuestServer != null;
        ret.put("hosting", hosting);

        JSArray guests = new JSArray();
        if (sInputGuestServer != null) {
            for (LinkInputGuestServer.GuestInfo gi : sInputGuestServer.getAdmittedGuests()) {
                JSObject g = new JSObject();
                g.put("ip", gi.ip);
                g.put("name", gi.name);
                g.put("mode", gi.mode);
                guests.put(g);
            }
        }
        ret.put("admittedGuests", guests);

        // A paired device controlling this screen through its device panel has no guest socket;
        // the screen share itself is the session.
        JSArray pairedSessions = new JSArray();
        LinkRemoteControlServer sharing = LinkRemoteControl.sRemoteControlServer;
        String viewerId = sharing != null && sharing.isRunning() ? sharing.getTargetDeviceId() : null;
        if (viewerId != null && !viewerId.startsWith(LinkRemoteControlServer.GUEST_PREFIX)) {
            LinkTrustStore.TrustedDevice viewer = plugin.deviceManager != null ? plugin.deviceManager.getTrustStore().get(viewerId) : null;
            JSObject session = new JSObject();
            session.put("deviceId", viewerId);
            session.put("name", viewer != null ? viewer.deviceName : viewerId);
            session.put("mode", "remotecontrol");
            pairedSessions.put(session);
        }
        ret.put("pairedSessions", pairedSessions);
        call.resolve(ret);
    }

    @LinkMethod
    public void acceptInputGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sInputGuestServer != null && connId != null) {
            sInputGuestServer.acceptGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void rejectInputGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sInputGuestServer != null && connId != null) {
            sInputGuestServer.rejectGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void blockInputGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sInputGuestServer != null && connId != null) {
            sInputGuestServer.blockGuest(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void kickInputGuest(LinkCall call) {
        String ip = call.getString("ip");
        if (sInputGuestServer != null && ip != null) {
            sInputGuestServer.kickGuest(ip);
        }
        // The argument is a device id when the session belongs to a paired device.
        if (ip != null && LinkRemoteControl.sRemoteControlServer != null && ip.equals(LinkRemoteControl.sRemoteControlServer.getTargetDeviceId())) {
            LinkRemoteControl.sRemoteControlServer.stop("ended");
            LinkRemoteControl.sRemoteControlServer = null;
        }
        // A paired controller (by device id or address) has no socket to close: it is told to close
        // its screen, as desktop's kick_input does, and its UDP input token is replaced so lines
        // already in flight under the old one are dropped.
        String pairedId = null;
        if (ip != null && plugin.deviceManager != null) {
            pairedId = plugin.deviceManager.hasTrustedPeer(ip) ? ip : plugin.deviceManager.deviceIdForAddress(ip);
        }
        if (pairedId != null) {
            LinkInputRelay.sIssuedInputTokens.remove(pairedId);
            plugin.deviceManager.sendTo(pairedId, new LinkPacket("link.input.kicked", new org.json.JSONObject()));
            plugin.inputRelay.sendInputToken(pairedId);
        }
        call.resolve();
    }

    @LinkMethod
    public void sendInputGuestMessage(LinkCall call) {
        String message = call.getString("message");
        if (sInputGuestClient != null && message != null) sInputGuestClient.send(message);
        call.resolve();
    }

    @LinkMethod
    public void leaveInputGuest(LinkCall call) {
        LinkInputRelay.sGuestInputTokens.clear();
        if (sInputGuestClient != null) {
            sInputGuestClient.disconnect();
            sInputGuestClient = null;
        }
        call.resolve();
    }

    /** Stick/button/trigger state at about 60 Hz as raw UDP to `host` (not a paired deviceId).
     *  Line format "js lx ly rx ry lt rt buttons", parsed by joystick_state() in core/joystick.rs. */
    @LinkMethod
    public void sendJoystickState(LinkCall call) {
        String host = call.getString("host");
        if (host == null) { call.resolve(); return; }
        int lx = call.getInt("lx", 0);
        int ly = call.getInt("ly", 0);
        int rx = call.getInt("rx", 0);
        int ry = call.getInt("ry", 0);
        int lt = call.getInt("lt", 0);
        int rt = call.getInt("rt", 0);
        int buttons = call.getInt("buttons", 0);
        plugin.inputRelay.sendUdpMessageToHost(host, "js " + lx + " " + ly + " " + rx + " " + ry + " " + lt + " " + rt + " " + buttons);
        call.resolve();
    }

    /** Local haptic pulse for JoystickOverlay.tsx's button feedback. Host rumble arrives over
     *  the joystick WebSocket and calls vibrateNative() directly (sendJoystickHello's onRumble). */
    @LinkMethod
    public void vibrate(LinkCall call) {
        int amplitude = call.getInt("amplitude", 128);
        long durationMs = call.getInt("durationMs", 100);
        vibrateNative(getContext(), amplitude, durationMs);
        call.resolve();
    }

    static void stopVibration(android.content.Context context) {
        android.os.Vibrator vibrator = (android.os.Vibrator) context.getSystemService(android.content.Context.VIBRATOR_SERVICE);
        if (vibrator != null) vibrator.cancel();
    }

    static void vibrateNative(android.content.Context context, int amplitude, long durationMs) {
        android.os.Vibrator vibrator = (android.os.Vibrator) context.getSystemService(android.content.Context.VIBRATOR_SERVICE);
        if (vibrator == null || !vibrator.hasVibrator()) return;
        int clampedAmplitude = Math.max(1, Math.min(255, amplitude));
        vibrator.vibrate(android.os.VibrationEffect.createOneShot(durationMs, clampedAmplitude));
    }
}
