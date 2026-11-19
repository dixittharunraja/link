package in.rodix.link;

import app.tauri.plugin.JSObject;

// Input between paired devices: presenter pointer, touchpad, special keys and the digitizer, sent
// as raw UDP lines on port 1717 (and a few TCP packets), plus the receiving side of that relay and
// the per-peer tokens that authenticate its lines.
final class LinkInputRelay extends LinkFeature {
    LinkInputRelay(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void stopPreviousInstance() {
        if (sInputUdpSocket != null) {
            try {
                sInputUdpSocket.close();
            } catch (Exception ignored) {}
            sInputUdpSocket = null;
        }
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put(PACKET_TYPE_INPUT_TOKEN, (deviceId, packet) -> {
            String token = packet.body != null ? packet.body.optString("token", "") : "";
            if (!token.isEmpty()) sPeerInputTokens.put(deviceId, token);
        });
        handlers.put("link.input.kicked", (deviceId, packet) -> {
            // The controlled device removed this one; the presenter/touchpad screen closes.
            JSObject kicked = new JSObject();
            kicked.put("deviceId", deviceId);
            notifyListeners("inputKicked", kicked);
        });
        handlers.put(LinkPresenter.PACKET_TYPE_PRESENTER, this::handlePresenterPacket);
        handlers.put("link.digitizer.session", this::handleDigitizerSessionPacket);
        handlers.put("link.digitizer", this::handleDigitizerPacket);
        // Launching this device's apps from a paired remote (the TV's app buttons).
        handlers.put(LinkApps.PACKET_REQUEST, (deviceId, packet) -> {
            if (!LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
                android.util.Log.i(TAG, "Blocked app list request from " + deviceId + " (Permission disabled)");
                return;
            }
            // Reading every icon takes a moment; keep it off the network thread.
            new Thread(() -> plugin.deviceManager.sendTo(deviceId, LinkApps.buildListPacket(getContext())), "LinkApps-list").start();
        });
        handlers.put(LinkApps.PACKET_LAUNCH, (deviceId, packet) -> {
            if (!LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
                android.util.Log.i(TAG, "Blocked app launch from " + deviceId + " (Permission disabled)");
                return;
            }
            LinkApps.launch(getContext(), packet.getBody().optString("package"));
        });
        handlers.put(LinkApps.PACKET_LIST, (deviceId, packet) -> {
            JSObject data = new JSObject();
            data.put("deviceId", deviceId);
            org.json.JSONArray apps = packet.getBody().optJSONArray("apps");
            data.put("appsJson", apps != null ? apps.toString() : "[]");
            notifyListeners("deviceAppsReceived", data);
        });
        handlers.put(LinkPointer.PACKET_TYPE_POINTER, (deviceId, packet) -> {
            if (LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
                LinkPointer.handle(getContext(), packet.getBody());
            } else {
                android.util.Log.i(TAG, "Blocked pointer packet from " + deviceId + " (Permission disabled)");
            }
        });
        handlers.put(LinkRemoteInput.PACKET_TYPE_REMOTEINPUT_SEND, (deviceId, packet) -> {
            if (LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
                LinkRemoteInput.handleRemoteInput(getContext(), packet);
            } else {
                android.util.Log.w(TAG, "Blocked remoteinput packet from " + deviceId + " — permission denied");
            }
        });
    }

    private final java.util.concurrent.ExecutorService udpSendExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
    private java.net.DatagramSocket outboundUdpSocket = null;

    // Presenter packets with this device as the target (mirrors core/presenter.rs): after the
    // permission check, dx/dy (or stop) is forwarded to the WebView, which draws the pointer.
    private void handlePresenterPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "presenter")) {
            android.util.Log.i(TAG, "Blocked Presenter packet from " + deviceId + " (Permission disabled)");
            return;
        }
        boolean stop = packet.body.optBoolean("stop", false);
        if (stop) {
            // Hide the system overlay too in case it is showing; a no-op otherwise.
            LinkPresenterOverlay.hide(true);
        }
        if (!stop && LinkPresenterOverlay.isPermissionGranted(getContext())) {
            // System overlay, drawn over whichever app is in the foreground (as for the UDP path).
            android.util.DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            LinkPresenterOverlay.updatePosition(getContext(), packet.body.optDouble("dx", 0), packet.body.optDouble("dy", 0),
                    (double) dm.widthPixels / dm.heightPixels);
            return;
        }
        JSObject data = new JSObject();
        data.put("deviceId", deviceId);
        if (stop) {
            data.put("stop", true);
        } else {
            data.put("dx", packet.body.optDouble("dx", 0));
            data.put("dy", packet.body.optDouble("dy", 0));
        }
        notifyListeners("presenterPositionReceived", data);
    }

    // Coordinate space of the sender's digitizer events (10000x10000 unless the session says
    // otherwise), scaled to this screen's pixels for injection.
    private int digitizerSessionWidth = 10000;
    private int digitizerSessionHeight = 10000;

    private void handleDigitizerSessionPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
            android.util.Log.i(TAG, "Blocked Digitizer session from " + deviceId + " (Permission disabled)");
            return;
        }
        String action = packet.getBody().optString("action");
        if ("start".equals(action)) {
            digitizerSessionWidth = packet.getBody().optInt("width", 10000);
            digitizerSessionHeight = packet.getBody().optInt("height", 10000);
            if (LinkAccessibilityService.getInstance() == null) {
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                    android.widget.Toast.makeText(getContext(),
                        "Link Accessibility Service is disabled. Please enable it in Settings -> Accessibility to receive pen/digitizer input.",
                        android.widget.Toast.LENGTH_LONG).show());
            }
        } else {
            LinkAccessibilityService service = LinkAccessibilityService.getInstance();
            if (service != null) service.endDigitizerTouch();
        }
    }

    private void handleDigitizerPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "remoteinput")) {
            return;
        }
        injectDigitizerEvent(
            packet.getBody().optInt("x", 0),
            packet.getBody().optInt("y", 0),
            packet.getBody().optBoolean("touching", false)
        );
    }

    // Injects a system-wide touch through LinkAccessibilityService.injectDigitizerTouch. Posted to
    // the main thread because dispatchGesture needs a Looper and callers run on background threads.
    private void injectDigitizerEvent(int x, int y, boolean touching) {
        LinkAccessibilityService service = LinkAccessibilityService.getInstance();
        if (service == null) return;

        int[] screen = LinkRemoteControlServer.realScreenSize(getContext());
        float px = (x / (float) digitizerSessionWidth) * screen[0];
        float py = (y / (float) digitizerSessionHeight) * screen[1];

        new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
            service.injectDigitizerTouch(px, py, touching));
        // Shows where the pen is: the injected touch itself draws nothing.
        LinkCursorOverlay.showCrosshair(getContext(), px, py);
    }

    @LinkMethod
    public void sendRemoteInput(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String text = call.getString("text");
        String specialKey = call.getString("specialKey");
        if (plugin.deviceManager != null && deviceId != null) {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                if (text != null) body.put("text", text);
                if (specialKey != null) body.put("specialKey", specialKey);
                plugin.deviceManager.sendTo(deviceId, new LinkPacket(LinkRemoteInput.PACKET_TYPE_REMOTEINPUT_SEND, body));
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send remote input packet", e);
            }
        }
        call.resolve();
    }

    /** Asks a paired device (a TV) for its launchable apps; the answer arrives as deviceAppsReceived. */
    @LinkMethod
    public void requestDeviceApps(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (plugin.deviceManager != null && deviceId != null) {
            plugin.deviceManager.sendTo(deviceId, new LinkPacket(LinkApps.PACKET_REQUEST, new org.json.JSONObject()));
        }
        call.resolve();
    }

    @LinkMethod
    public void launchDeviceApp(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String packageName = call.getString("packageName");
        if (plugin.deviceManager != null && deviceId != null && packageName != null) {
            try {
                plugin.deviceManager.sendTo(deviceId, new LinkPacket(LinkApps.PACKET_LAUNCH, new org.json.JSONObject().put("package", packageName)));
            } catch (org.json.JSONException ignored) {
                // a plain string put cannot fail
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void sendPresenterMove(LinkCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "pmove " + dx + " " + dy);
        call.resolve();
    }

    // Presenter/digitizer "Switch Screen": cycles the monitor the peer targets. Sent over TCP
    // (link.target.display) since it is a rare control action, not a high-rate move.
    @LinkMethod
    public void cycleTargetDisplay(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (plugin.deviceManager != null && deviceId != null) {
            try {
                plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.target.display", new org.json.JSONObject()));
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @LinkMethod
    public void checkOverlayPermission(LinkCall call) {
        JSObject data = new JSObject();
        data.put("enabled", LinkPresenterOverlay.isPermissionGranted(getContext()));
        call.resolve(data);
    }

    @LinkMethod
    public void requestOverlayPermission(LinkCall call) {
        LinkPresenterOverlay.requestPermission(getContext());
        call.resolve();
    }

    @LinkMethod
    public void sendPresenterStop(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId != null) {
            plugin.deviceManager.sendTo(deviceId, LinkPresenter.createStopPacket());
            sendUdpMessage(deviceId, "pstop");
        }
        call.resolve();
    }

    @LinkMethod
    public void sendMouseMove(LinkCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "move " + dx + " " + dy);
        call.resolve();
    }

    @LinkMethod
    public void sendSpecialKey(LinkCall call) {
        String deviceId = call.getString("deviceId");
        int specialKey = call.getInt("specialKey", 0);
        sendUdpMessage(deviceId, "special " + specialKey);
        call.resolve();
    }

    @LinkMethod
    public void sendMouseClick(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String clickType = call.getString("clickType", "left");
        sendUdpMessage(deviceId, "click " + clickType);
        call.resolve();
    }

    @LinkMethod
    public void sendMouseDrag(LinkCall call) {
        String deviceId = call.getString("deviceId");
        boolean hold = call.getBoolean("hold", false);
        String line = hold ? "hold left" : "release left";
        sendUdpMessage(deviceId, line);
        // UDP can drop a datagram, and a lost "release" leaves the PC's mouse button stuck down.
        // Repeat it twice more; the PC ignores a repeat of the same line within 500 ms.
        android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
        handler.postDelayed(() -> sendUdpMessage(deviceId, line), 40);
        handler.postDelayed(() -> sendUdpMessage(deviceId, line), 120);
        call.resolve();
    }

    @LinkMethod
    public void sendMouseScroll(LinkCall call) {
        String deviceId = call.getString("deviceId");
        double dx = call.getDouble("dx", 0.0);
        double dy = call.getDouble("dy", 0.0);
        sendUdpMessage(deviceId, "scroll " + dx + " " + dy);
        call.resolve();
    }

    @LinkMethod
    public void sendDigitizerSession(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String action = call.getString("action");
        if (plugin.deviceManager != null && deviceId != null) {
            if ("start".equals(action)) {
                int width = call.getInt("width", 0);
                int height = call.getInt("height", 0);
                int resolutionX = call.getInt("resolutionX", 100);
                int resolutionY = call.getInt("resolutionY", 100);
                plugin.deviceManager.sendTo(deviceId, LinkDigitizer.createSessionStart(width, height, resolutionX, resolutionY));
            } else {
                plugin.deviceManager.sendTo(deviceId, LinkDigitizer.createSessionEnd());
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void sendDigitizerEvent(LinkCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId != null) {
            Integer x = call.getInt("x");
            Integer yVal = call.getInt("y");
            Boolean touching = call.getBoolean("touching", false);
            sendUdpMessage(deviceId, "dig " + (x != null ? x : 0) + " " + (yVal != null ? yVal : 0) + " " + touching);
        }
        call.resolve();
    }

    /** Digitizer toolbar undo/redo — sends the bare "undo"/"redo" line over the same fast UDP
     *  input relay the pen events use; the desktop maps it to Ctrl+Z / Ctrl+Y. */
    @LinkMethod
    public void sendDigitizerAction(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String action = call.getString("action");
        if (deviceId != null && ("undo".equals(action) || "redo".equals(action))) {
            sendUdpMessage(deviceId, action);
        }
        call.resolve();
    }

    static java.net.DatagramSocket sInputUdpSocket;

    // UDP input secrets (see core/input_relay.rs). Input lines are "<token> <command>"; each
    // receiver hands its senders a token over TLS. These hold the token this device issued to each
    // paired peer and expects on its lines, the token each paired peer issued for lines sent to it,
    // and the tokens hosts issued on guest and joystick admission, keyed by host address.
    static final String PACKET_TYPE_INPUT_TOKEN = "link.input.token";
    static final java.util.Map<String, String> sIssuedInputTokens = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.Map<String, String> sPeerInputTokens = new java.util.concurrent.ConcurrentHashMap<>();
    static final java.util.Map<String, String> sGuestInputTokens = new java.util.concurrent.ConcurrentHashMap<>();
    static final java.util.Map<String, String> sJoystickInputTokens = new java.util.concurrent.ConcurrentHashMap<>();

    /** Sends a paired peer the token its UDP input lines must carry to be heard here. */
    void sendInputToken(String deviceId) {
        if (plugin.deviceManager == null) return;
        String token = sIssuedInputTokens.computeIfAbsent(deviceId, id -> LinkTransport.newInputToken());
        try {
            plugin.deviceManager.sendTo(deviceId, new LinkPacket(PACKET_TYPE_INPUT_TOKEN, new org.json.JSONObject().put("token", token)));
        } catch (org.json.JSONException ignored) {}
    }

    static void forgetInputTokens(String deviceId) {
        sIssuedInputTokens.remove(deviceId);
        sPeerInputTokens.remove(deviceId);
    }

    /** The paired device that was issued this token and is connected from this address, or null. */
    private String pairedSenderFor(String token, String senderIp) {
        if (plugin.deviceManager == null) return null;
        for (java.util.Map.Entry<String, String> entry : sIssuedInputTokens.entrySet()) {
            String deviceId = entry.getKey();
            if (entry.getValue().equals(token) && plugin.deviceManager.hasTrustedPeer(deviceId) && senderIp.equals(plugin.deviceManager.remoteAddressOf(deviceId))) {
                return deviceId;
            }
        }
        return null;
    }

    // Receiving side of the raw UDP input relay on port 1717 (mirrors desktop's
    // core/input_relay.rs): joystick reports, presenter moves, special keys and digitizer events.
    // Datagrams are unauthenticated, so a line acts only when its token belongs to a paired peer,
    // admitted input guest or joystick controller connected from the sender's address.
    void startInputUdpServer() {
        new Thread(() -> {
            try {
                java.net.DatagramSocket socket = new java.net.DatagramSocket(null);
                socket.setReuseAddress(true);
                socket.bind(new java.net.InetSocketAddress(java.net.InetAddress.getByName("0.0.0.0"), 1717));
                sInputUdpSocket = socket;
                android.util.Log.i(TAG, "High-speed UDP Input Relay listening on port 1717");
                byte[] buf = new byte[1024];
                while (sInputUdpSocket != null && !sInputUdpSocket.isClosed()) {
                    java.net.DatagramPacket packet = new java.net.DatagramPacket(buf, buf.length);
                    sInputUdpSocket.receive(packet);
                    // Each datagram is handled on its own, so a malformed one cannot stop the listener.
                    try {
                        handleInputDatagram(packet);
                    } catch (Exception e) {
                        android.util.Log.w(TAG, "Dropped a malformed UDP input line", e);
                    }
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "UDP Input Relay error", e);
            }
        }, "udp-input-listener").start();
    }

    private void handleInputDatagram(java.net.DatagramPacket packet) throws Exception {
        String senderIp = packet.getAddress().getHostAddress();
        String line = new String(packet.getData(), 0, packet.getLength(), "UTF-8").trim();

        // Every line is "<token> <command>"; the token was issued over TLS to the sender.
        int space = line.indexOf(' ');
        if (space <= 0) return;
        String token = line.substring(0, space);
        line = line.substring(space + 1).trim();

        // Joystick report while this device hosts. The controller joined by address and need not
        // be paired; LinkJoystickServer checks its token and address.
        if (line.startsWith("js ")) {
            LinkJoystickServer joystickServer = LinkInputGuests.sJoystickServer;
            String[] parts = line.split(" ");
            if (joystickServer != null && parts.length >= 8) {
                joystickServer.handleUdpJoystickReport(senderIp, token,
                        Integer.parseInt(parts[1]), Integer.parseInt(parts[2]),
                        Integer.parseInt(parts[3]), Integer.parseInt(parts[4]),
                        Integer.parseInt(parts[5]), Integer.parseInt(parts[6]),
                        Integer.parseInt(parts[7]));
            }
            return;
        }

        String senderId = pairedSenderFor(token, senderIp);
        LinkInputGuestServer guestServer = LinkInputGuests.sInputGuestServer;
        String guestMode = senderId == null && guestServer != null ? guestServer.modeForToken(senderIp, token) : null;
        if (senderId == null && guestMode == null) return;
        // A guest may do only what it was admitted for; remote control rides its socket.
        boolean isPresenterAllowed = senderId != null
                ? LinkDevicePermissions.check(getContext(), senderId, "presenter")
                : "presenter".equals(guestMode);
        boolean isRemoteInputAllowed = senderId != null
                ? LinkDevicePermissions.check(getContext(), senderId, "remoteinput")
                : "touchpad".equals(guestMode);

        if (line.startsWith("pmove ")) {
            if (!isPresenterAllowed) return;
            String[] parts = line.split(" ");
            double dx = Double.parseDouble(parts[1]);
            double dy = Double.parseDouble(parts[2]);

            if (LinkPresenterOverlay.isPermissionGranted(getContext())) {
                // System overlay, drawn over whichever app is in the foreground.
                android.util.DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
                double aspectRatio = (double) dm.widthPixels / dm.heightPixels;
                LinkPresenterOverlay.updatePosition(getContext(), dx, dy, aspectRatio);
            } else {
                // Fallback: the in-app dot (PresenterDotOverlay.tsx), visible only while Link is
                // in the foreground.
                JSObject data = new JSObject();
                data.put("deviceId", senderId != null ? senderId : senderIp);
                data.put("dx", dx);
                data.put("dy", dy);
                notifyListeners("presenterPositionReceived", data);
            }
        } else if (line.equals("pstop")) {
            if (!isPresenterAllowed) return;
            LinkPresenterOverlay.hide(true);
            JSObject data = new JSObject();
            data.put("deviceId", senderId != null ? senderId : senderIp);
            data.put("stop", true);
            notifyListeners("presenterPositionReceived", data);
        } else if (line.startsWith("special ")) {
            if (!isPresenterAllowed && !isRemoteInputAllowed) return;
            String[] parts = line.split(" ");
            int key = Integer.parseInt(parts[1]);
            LinkRemoteInput.injectSpecialKey(getContext(), key);
        } else if (line.startsWith("dig ")) {
            if (!isRemoteInputAllowed) return;
            String[] parts = line.split(" ");
            int x = Integer.parseInt(parts[1]);
            int y = Integer.parseInt(parts[2]);
            boolean touching = Boolean.parseBoolean(parts[3]);
            injectDigitizerEvent(x, y, touching);
        }
    }

    private synchronized java.net.DatagramSocket getOrCreateOutboundSocket() {
        if (outboundUdpSocket == null || outboundUdpSocket.isClosed()) {
            try {
                outboundUdpSocket = new java.net.DatagramSocket();
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to create outbound UDP socket", e);
            }
        }
        return outboundUdpSocket;
    }

    /**
     * Presenter moves, pen events and touchpad input for an Android device (a TV or a phone) go over the
     * authenticated TCP link instead of UDP. Such a device may not be reachable by datagram (an emulator or
     * a router doing NAT puts another address in front of it, and the datagram never arrives or fails the
     * sender-address check), and the touchpad lines are only understood by desktops over UDP. The link the
     * peer already holds always works. Returns true when the line was sent that way.
     */
    private boolean sendToAndroidOverLink(String deviceId, String message) {
        if (plugin.deviceManager == null) return false;
        String type = plugin.deviceManager.deviceTypeOf(deviceId);
        if (!"tv".equals(type) && !"phone".equals(type) && !"tablet".equals(type)) return false;
        try {
            String[] parts = message.split(" ");
            if (parts.length == 3 && parts[0].equals("pmove")) {
                plugin.deviceManager.sendTo(deviceId, LinkPresenter.createMovePacket(Double.parseDouble(parts[1]), Double.parseDouble(parts[2])));
                return true;
            }
            // The phone touchpad: relative moves and clicks for the TV's own cursor (LinkPointer).
            if (parts.length == 3 && (parts[0].equals("move") || parts[0].equals("scroll"))) {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("action", parts[0]);
                body.put("dx", Double.parseDouble(parts[1]));
                body.put("dy", Double.parseDouble(parts[2]));
                plugin.deviceManager.sendTo(deviceId, new LinkPacket(LinkPointer.PACKET_TYPE_POINTER, body));
                return true;
            }
            if (parts.length == 2 && (parts[0].equals("click") || parts[0].equals("hold") || parts[0].equals("release"))) {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("action", parts[0]);
                body.put("button", parts[1]);
                plugin.deviceManager.sendTo(deviceId, new LinkPacket(LinkPointer.PACKET_TYPE_POINTER, body));
                return true;
            }
            if (parts.length == 4 && parts[0].equals("dig")) {
                plugin.deviceManager.sendTo(deviceId, LinkDigitizer.createEvent(
                        Integer.parseInt(parts[1]), Integer.parseInt(parts[2]), Boolean.parseBoolean(parts[3]), null, null, null));
                return true;
            }
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not send input to a TV over the link; falling back to UDP", e);
        }
        return false;
    }

    private void sendUdpMessage(String deviceId, String message) {
        if (deviceId == null) return;
        if (sendToAndroidOverLink(deviceId, message)) return;
        String ip = plugin.deviceManager != null ? plugin.deviceManager.remoteAddressOf(deviceId) : null;
        if (ip == null) {
            // Not a paired device: an address from a guest session.
            sendUdpMessageToHost(deviceId, message);
            return;
        }
        // The token the device issued over the control connection; failing that, one from a
        // guest admission to the same host.
        String token = sPeerInputTokens.get(deviceId);
        if (token == null) token = sGuestInputTokens.get(ip);
        if (token == null) {
            android.util.Log.w(TAG, "No input token from " + deviceId + " yet; dropping input line");
            return;
        }
        final String datagram = token + " " + message;

        udpSendExecutor.execute(() -> {
            try {
                java.net.DatagramSocket socket = getOrCreateOutboundSocket();
                if (socket == null) return;
                byte[] buffer = datagram.getBytes("UTF-8");
                java.net.InetAddress address = java.net.InetAddress.getByName(ip);
                java.net.DatagramPacket packet = new java.net.DatagramPacket(buffer, buffer.length, address, 1717);
                socket.send(packet);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send UDP input message: " + message, e);
            }
        });
    }

    // Raw host strings (possibly several comma-separated addresses) mapped to the address that
    // actually answered, for the UDP streams that follow a guest connection.
    static final java.util.Map<String, String> sUdpHostOverrides = new java.util.concurrent.ConcurrentHashMap<>();

    /** Like sendUdpMessage, but addressed to a host directly rather than a paired deviceId; used
     *  by guest sessions such as Joystick that join by address. */
    void sendUdpMessageToHost(String host, String message) {
        if (host == null) return;
        final String targetIp = udpTargetIp(host);
        boolean joystick = message.startsWith("js ");
        String token = (joystick ? sJoystickInputTokens : sGuestInputTokens).get(targetIp);
        if (token == null && !joystick && plugin.deviceManager != null) {
            // A paired device addressed by its IP.
            String pairedId = plugin.deviceManager.deviceIdForAddress(targetIp);
            if (pairedId != null) token = sPeerInputTokens.get(pairedId);
        }
        if (token == null) {
            android.util.Log.w(TAG, "No input token from " + targetIp + " yet; dropping input line");
            return;
        }
        final String datagram = token + " " + message;

        udpSendExecutor.execute(() -> {
            try {
                java.net.DatagramSocket socket = getOrCreateOutboundSocket();
                if (socket == null) return;
                byte[] buffer = datagram.getBytes("UTF-8");
                java.net.InetAddress address = java.net.InetAddress.getByName(targetIp);
                java.net.DatagramPacket packet = new java.net.DatagramPacket(buffer, buffer.length, address, 1717);
                socket.send(packet);
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to send UDP message to host " + targetIp + ": " + message, e);
            }
        });
    }

    /** The single address a host string (scanned, typed, or several comma separated) resolves to
     *  for UDP: the one that answered when known, else the first, without scheme or port. */
    static String udpTargetIp(String host) {
        String known = sUdpHostOverrides.get(host);
        if (known != null) host = known;
        else if (host.contains(",")) host = host.split(",")[0];
        String cleanHost = host.trim();
        if (cleanHost.startsWith("link:")) {
            String[] parts = cleanHost.split(":");
            if (parts.length >= 2) cleanHost = parts[1];
        } else if (cleanHost.startsWith("http://") || cleanHost.startsWith("https://")) {
            cleanHost = cleanHost.replaceFirst("^https?://", "").split("/")[0].split(":")[0];
        } else if (cleanHost.contains(":")) {
            cleanHost = cleanHost.split(":")[0];
        }
        return cleanHost;
    }
}
