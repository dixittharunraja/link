package in.rodix.link;

// Calls and notifications: this phone's call state and notifications mirrored to paired devices
// (with replies from them), and a peer's calls shown here with Mute, Answer and Decline.
final class LinkTelephonyNotifications extends LinkFeature {
    LinkTelephonyNotifications(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put(LinkTelephony.PACKET_TYPE_TELEPHONY, this::handleTelephonyPacket);
        handlers.put(LinkTelephony.PACKET_TYPE_TELEPHONY_REQUEST, this::handleTelephonyRequestPacket);
        handlers.put("link.notification.reply", this::handleNotificationReplyPacket);
    }

    private LinkPacket lastTelephonyPacket = null;
    private String lastCallState = "";
    private String lastIncomingNumber = null;

    private Runnable pendingRingingBroadcast = null;

    public static final String ACTION_MUTE_REMOTE_RINGER = "in.rodix.link.ACTION_MUTE_REMOTE_RINGER";
    public static final String EXTRA_MUTE_DEVICE_ID = "deviceId";

    private final java.util.Map<String, LinkRepliableNotification> pendingReplies = new java.util.concurrent.ConcurrentHashMap<>();
    // The reply id each posted notification holds, so a reply action is dropped from pendingReplies
    // when its notification is updated or removed instead of piling up.
    private final java.util.Map<String, String> replyIdByNotificationKey = new java.util.concurrent.ConcurrentHashMap<>();
    // Packages whose app icon each connected peer already received; later notifications from the
    // same app go to that peer without it. Cleared when the peer disconnects.
    final java.util.Map<String, java.util.Set<String>> notificationIconsSent = new java.util.concurrent.ConcurrentHashMap<>();

    void watchNotificationsAndCalls() {
        LinkNotificationReceiver.setListener(new LinkNotificationReceiver.Listener() {
            @Override
            public void onNotificationPosted(android.service.notification.StatusBarNotification sbn) {
                if (LinkNotification.isEligible(sbn, getContext().getPackageName())) {
                    String packageName = sbn.getPackageName();
                    String appName = LinkNotification.getAppLabel(getContext(), packageName);

                    // An updated notification replaces its earlier reply action.
                    String key = LinkNotification.getNotificationKey(sbn);
                    String staleReplyId = replyIdByNotificationKey.remove(key);
                    if (staleReplyId != null) pendingReplies.remove(staleReplyId);
                    LinkRepliableNotification rn = LinkNotification.extractRepliable(sbn.getNotification());
                    String replyId = null;
                    if (rn != null) {
                        replyId = rn.id;
                        pendingReplies.put(rn.id, rn);
                        replyIdByNotificationKey.put(key, rn.id);
                    }

                    LinkPacket np = LinkNotification.createPostedPacket(getContext(), sbn, appName, replyId);
                    boolean hasIcon = np.body.has("iconBase64");
                    LinkPacket npWithoutIcon = null;
                    java.util.Set<String> sentTo = new java.util.HashSet<>();
                    for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                        if (!LinkDevicePermissions.check(getContext(), peerId, "notification")) continue;
                        // The app icon goes to each peer once per connection.
                        java.util.Set<String> icons = notificationIconsSent.computeIfAbsent(peerId, k -> java.util.concurrent.ConcurrentHashMap.newKeySet());
                        if (!hasIcon || icons.add(packageName)) {
                            plugin.deviceManager.sendTo(peerId, np);
                        } else {
                            if (npWithoutIcon == null) npWithoutIcon = LinkNotification.withoutIcon(np);
                            plugin.deviceManager.sendTo(peerId, npWithoutIcon);
                        }
                        sentTo.add(peerId);
                    }

                    // Mesh-wide mirroring to peers with the notificationMirroring permission. A
                    // peer that just got the notification itself is not sent a second copy.
                    String deviceName = plugin.myIdentity != null ? plugin.myIdentity.deviceName : "Unknown Device";
                    LinkPacket meshNotif = null;
                    for (String peerId : plugin.deviceManager.trustedConnectedDeviceIds()) {
                        if (sentTo.contains(peerId) || !LinkDevicePermissions.check(getContext(), peerId, "notificationMirroring")) continue;
                        if (meshNotif == null) meshNotif = LinkNotificationBroadcast.createNotificationBroadcastPacket(sbn, deviceName);
                        if (meshNotif == null) break;
                        plugin.deviceManager.sendTo(peerId, meshNotif);
                    }
                }
            }

            @Override
            public void onNotificationRemoved(android.service.notification.StatusBarNotification sbn) {
                String staleReplyId = replyIdByNotificationKey.remove(LinkNotification.getNotificationKey(sbn));
                if (staleReplyId != null) pendingReplies.remove(staleReplyId);
                if (LinkNotification.isEligible(sbn, getContext().getPackageName())) {
                    LinkPacket np = LinkNotification.createCancelPacket(sbn);
                    broadcastToPermittedPeers("notification", np);
                }
            }
        });

        // After an app update or reinstall the notification listener can show as enabled in
        // Settings without being bound, so onNotificationPosted never fires. requestRebind()
        // reconnects it and is a no-op if already bound.
        if (LinkNotificationReceiver.isPermissionGranted(getContext())) {
            try {
                android.service.notification.NotificationListenerService.requestRebind(
                        new android.content.ComponentName(getContext(), LinkNotificationReceiver.class));
                android.util.Log.i(TAG, "Requested NotificationListenerService rebind");
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to request notification listener rebind", e);
            }
        }

        android.content.BroadcastReceiver telephonyReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context context, android.content.Intent intent) {
                if (android.telephony.TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) {
                    String state = intent.getStringExtra(android.telephony.TelephonyManager.EXTRA_STATE);
                    String number = intent.getStringExtra(android.telephony.TelephonyManager.EXTRA_INCOMING_NUMBER);
                    // Contact lookups and the photo encode run on the worker thread, in order,
                    // not on the main thread this receiver is called on.
                    plugin.telephonyHandler.post(() -> onPhoneStateChanged(state, number));
                }
            }
        };
        android.content.IntentFilter filter = new android.content.IntentFilter(android.telephony.TelephonyManager.ACTION_PHONE_STATE_CHANGED);
        plugin.registerSystemReceiver(telephonyReceiver, filter, android.content.Context.RECEIVER_EXPORTED);

        // "Mute" action on a peer's incoming-call notification (LinkTelephony.
        // showRemoteCallNotification): asks the ringing peer to silence its ringer through a
        // telephony request, the same path the desktop's mute button uses. The peer's
        // silenceRinger remembers that it muted the ring stream and restoreRinger unmutes it
        // once the call is answered or over. Not exported; only this app's PendingIntents send it.
        android.content.BroadcastReceiver muteRemoteRingerReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context context, android.content.Intent intent) {
                String targetDeviceId = intent.getStringExtra(EXTRA_MUTE_DEVICE_ID);
                if (targetDeviceId == null || plugin.deviceManager == null) return;
                plugin.deviceManager.sendTo(targetDeviceId, LinkTelephony.createRequestPacket("mute"));
            }
        };
        android.content.IntentFilter muteFilter = new android.content.IntentFilter(ACTION_MUTE_REMOTE_RINGER);
        plugin.registerSystemReceiver(muteRemoteRingerReceiver, muteFilter, android.content.Context.RECEIVER_NOT_EXPORTED);
    }

    private void handleTelephonyPacket(String deviceId, LinkPacket packet) {
        // Shows a peer phone's call (mirrors on_telephony() in core/host.rs). The sending phone
        // already applied its own permission for this device; only telephony switched off for that
        // device here refuses a new call. Ending one always goes through, so nothing keeps ringing.
        String event = packet.body.optString("event", null);
        boolean isCancel = packet.body.optBoolean("isCancel", false);
        if (!isCancel && !"cancelled".equals(event) && !LinkPermissionGuards.acceptsFrom(getContext(), deviceId, "telephony")) return;
        String effectiveEvent = isCancel ? "cancelled" : event;
        String phoneNumber = packet.body.has("phoneNumber") ? packet.body.optString("phoneNumber") : null;
        String contactName = packet.body.has("contactName") ? packet.body.optString("contactName") : null;
        String iconBase64 = packet.body.has("iconBase64") ? packet.body.optString("iconBase64") : null;
        LinkTelephony.showRemoteCallNotification(getContext(), deviceId, effectiveEvent, phoneNumber, contactName, iconBase64);
        LinkPauseMusic.onCallStateChanged(getContext(), effectiveEvent, isCancel);
    }

    /** This phone's call state changed (from telephonyReceiver). Runs on the worker thread, so the
     *  contact lookups stay off the main thread; each number is looked up once per call. */
    private void onPhoneStateChanged(String state, String number) {
        boolean stateChanged = state != null && !state.equals(lastCallState);
        boolean numberArrived = state != null && state.equals(lastCallState) && number != null && lastIncomingNumber == null;
        if (!stateChanged && !numberArrived) return;

        // Keep the previous event's number: the IDLE broadcast carries none, and the missed-call
        // packet below needs the ringing number.
        String previousIncomingNumber = lastIncomingNumber;
        lastCallState = state;
        lastIncomingNumber = number;

        if (pendingRingingBroadcast != null) {
            plugin.telephonyHandler.removeCallbacks(pendingRingingBroadcast);
            pendingRingingBroadcast = null;
        }

        if (android.telephony.TelephonyManager.EXTRA_STATE_RINGING.equals(state) && number == null) {
            // No number yet: wait briefly for the follow-up broadcast. If it never arrives (hidden
            // caller ID, no READ_CALL_LOG), the call is still sent after the delay.
            pendingRingingBroadcast = () -> {
                if (!android.telephony.TelephonyManager.EXTRA_STATE_RINGING.equals(lastCallState)) return;
                String n = lastIncomingNumber;
                String[] contact = LinkTelephony.lookupContact(getContext(), n);
                LinkPacket np2 = LinkTelephony.createCallPacket("ringing", n, contact[0], contact[1]);
                lastTelephonyPacket = np2;
                broadcastToPermittedPeers("telephony", np2);
            };
            plugin.telephonyHandler.postDelayed(pendingRingingBroadcast, 800);
        } else if (android.telephony.TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
            String[] contact = LinkTelephony.lookupContact(getContext(), number);
            LinkPacket np = LinkTelephony.createCallPacket("ringing", number, contact[0], contact[1]);
            lastTelephonyPacket = np;
            broadcastToPermittedPeers("telephony", np);
        } else if (android.telephony.TelephonyManager.EXTRA_STATE_OFFHOOK.equals(state)) {
            // Answered: a ringer a peer muted rings again for the next call.
            LinkTelephony.restoreRinger(getContext());
            String talkingNumber = number != null ? number : (previousIncomingNumber != null ? previousIncomingNumber : lastIncomingNumber);
            String[] contact = LinkTelephony.lookupContact(getContext(), talkingNumber);
            LinkPacket np = LinkTelephony.createCallPacket("talking", talkingNumber, contact[0], contact[1]);
            lastTelephonyPacket = np;
            broadcastToPermittedPeers("telephony", np);
        } else if (android.telephony.TelephonyManager.EXTRA_STATE_IDLE.equals(state)) {
            LinkTelephony.restoreRinger(getContext());
            if (lastTelephonyPacket != null) {
                LinkPacket cancelNp = LinkTelephony.createCancelPacket(lastTelephonyPacket);
                broadcastToPermittedPeers("telephony", cancelNp);

                if ("ringing".equals(lastTelephonyPacket.body.optString("event"))) {
                    String missedNumber = number != null ? number : previousIncomingNumber;
                    String[] contact = LinkTelephony.lookupContact(getContext(), missedNumber);
                    LinkPacket missedNp = LinkTelephony.createCallPacket("missedCall", missedNumber, contact[0], contact[1]);
                    broadcastToPermittedPeers("telephony", missedNp);
                }
                lastTelephonyPacket = null;
            }
            lastIncomingNumber = null;
            LinkTelephony.clearContactCache();
        }
    }

    private void handleTelephonyRequestPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "telephony")) {
            android.util.Log.w(TAG, "Blocked telephony request from " + deviceId + " (Permission disabled)");
            return;
        }
        String action = packet.body.optString("action", "");
        android.util.Log.i(TAG, "Received telephony request action: " + action + " from " + deviceId);
        if ("mute".equalsIgnoreCase(action)) {
            LinkTelephony.silenceRinger(getContext());
        } else if ("reject".equalsIgnoreCase(action) || "decline".equalsIgnoreCase(action)) {
            LinkTelephony.endCall(getContext());
        } else if ("accept".equalsIgnoreCase(action)) {
            LinkTelephony.acceptCall(getContext());
        }
    }

    private void handleNotificationReplyPacket(String deviceId, LinkPacket packet) {
        if (!LinkDevicePermissions.check(getContext(), deviceId, "notification")) {
            android.util.Log.i(TAG, "Blocked notification reply from " + deviceId + " (Permission disabled)");
            return;
        }
        String replyId = packet.body.optString("requestReplyId");
        String message = packet.body.optString("message");
        if (replyId != null && message != null) {
            replyToNotification(replyId, message);
        }
    }

    private void replyToNotification(String replyId, String message) {
        LinkRepliableNotification rn = pendingReplies.remove(replyId);
        if (rn == null) return;

        android.content.Intent localIntent = new android.content.Intent();
        localIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        android.os.Bundle localBundle = new android.os.Bundle();
        for (android.app.RemoteInput remoteInput : rn.remoteInputs) {
            localBundle.putCharSequence(remoteInput.getResultKey(), message);
        }
        android.app.RemoteInput.addResultsToIntent(rn.remoteInputs, localIntent, localBundle);
        try {
            rn.pendingIntent.send(getContext(), 0, localIntent);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to reply to notification", e);
        }
    }
}
