package in.rodix.link;

import android.content.Context;

// Consolidated broadcast patterns — eliminates repeated loops across MPRIS, Notification,
// Telephony, System Volume, Flashlight, DND, etc.
// Mirrors desktop's broadcastToPermittedPeers() pattern.

public class LinkBroadcastHelper {

    // Shared by every plugin that broadcasts state updates to all connected peers, gated on each
    // peer's own permission for that key.
    public static void broadcastToPermittedPeers(Context context, LinkDeviceManager deviceManager,
                                                  String permKey, LinkPacket packet) {
        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
            if (!LinkDevicePermissions.check(context, peerId, permKey)) continue;
            deviceManager.sendTo(peerId, packet);
        }
    }

    // Broadcast to ALL pool members, but check notification permission for each
    public static void broadcastNotificationsToPool(Context context, LinkDeviceManager deviceManager,
                                                     LinkPacket packet) {
        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
            if (LinkDevicePermissions.check(context, peerId, "notificationMirroring")) {
                deviceManager.sendTo(peerId, packet);
            }
        }
    }

    // Broadcast to ALL pool members without permission gates (for mesh-wide sync)
    public static void broadcastToAllPeers(LinkDeviceManager deviceManager, LinkPacket packet) {
        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
            deviceManager.sendTo(peerId, packet);
        }
    }

    private LinkBroadcastHelper() {
        // Utility class, non-instantiable
    }
}
