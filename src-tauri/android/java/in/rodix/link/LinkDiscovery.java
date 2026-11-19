package in.rodix.link;

import android.net.wifi.WifiManager;
import android.content.Context;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class LinkDiscovery {
    public interface Listener {
        void onDeviceDiscovered(String ip, LinkIdentity.Identity identity);
    }

    public interface ExpiryListener {
        void onDeviceExpired(String deviceId);
    }

    public static class Watcher {
        private volatile LinkIdentity.Identity localIdentity;
        private final String myCertFingerprint;
        private final Listener listener;
        private final ExpiryListener expiryListener;
        private final Context context;
        private DatagramSocket rxSocket;
        private Thread rxThread;
        private Thread txThread;
        private volatile boolean running = false;
        private volatile boolean visibilityEnabled = false;

        private android.net.wifi.WifiManager.MulticastLock multicastLock;
        // mDNS for paired devices only (LinkMdns); it feeds the same listener as a UDP announcement.
        private LinkMdns mdns;
        // How long a device found over mDNS stays listed without being heard again; LinkMdns republishes it
        // every few seconds while its record lives.
        private static final long MDNS_INTERVAL_MS = 15000;
        private final Map<String, Long> discoveredPeerLastSeen = new ConcurrentHashMap<>();

        // Announce quickly while looking for someone (a paired device is not connected, or nothing is paired
        // yet) and slowly once every paired device is connected. A device that hears a stranger it has not seen
        // announces at once, so discovery stays quick whatever pace each side is at.
        private static final long FAST_INTERVAL_MS = 2000;
        private static final long SLOW_INTERVAL_MS = 30000;
        // The fast pace only lasts this long; after it a still-missing device is looked for every
        // FAST_BACKOFF_INTERVAL_MS, until the network changes or the search starts over. Matches
        // core/discovery.rs.
        private static final long FAST_WINDOW_MS = 30000;
        private static final long FAST_BACKOFF_INTERVAL_MS = 12000;
        private volatile boolean fastMode = true;
        private volatile long fastSince = System.currentTimeMillis();
        // One store for every datagram; it re-reads the file only when it changed (LinkTrustStore).
        private LinkTrustStore trustStore;
        private volatile long lastReplyAt = 0;
        private final Map<String, Long> tailnetRepliedAt = new ConcurrentHashMap<>();
        // How often each peer says it announces, so it is not expired between two slow announcements.
        private final Map<String, Long> discoveredPeerIntervalMs = new ConcurrentHashMap<>();

        public Watcher(Context context, LinkIdentity.Identity localIdentity, String myCertFingerprint, Listener listener, ExpiryListener expiryListener) {
            this.context = context;
            this.localIdentity = localIdentity;
            this.myCertFingerprint = myCertFingerprint != null ? myCertFingerprint : "";
            this.listener = listener;
            this.expiryListener = expiryListener;
        }

        public void updateLocalIdentity(LinkIdentity.Identity newIdentity) {
            this.localIdentity = newIdentity;
        }

        private synchronized LinkTrustStore trustStore() {
            if (trustStore == null) trustStore = LinkTrustStore.getInstance(context);
            return trustStore;
        }

        /** How long until the next announcement, which is also what the announcement says. */
        private long currentInterval() {
            if (!fastMode) return SLOW_INTERVAL_MS;
            return System.currentTimeMillis() - fastSince < FAST_WINDOW_MS ? FAST_INTERVAL_MS : FAST_BACKOFF_INTERVAL_MS;
        }

        // Until when the app is in use (open, or showing nearby devices); see listenFor().
        private volatile long listenUntil = 0;

        /**
         * Keeps hearing announcements for at least this long, even with every paired device connected. Without
         * it a phone whose paired devices are all connected cannot see a new PC to pair with: it only hears
         * broadcasts while the multicast lock is held.
         */
        public void listenFor(long ms) {
            listenUntil = Math.max(listenUntil, System.currentTimeMillis() + ms);
            updateMulticastLock();
        }

        // Broadcasts reach this device only while the lock is held, and holding it keeps the Wi-Fi
        // radio waking for every broadcast on the network. It is needed while looking for someone or
        // while the app is in use, not in the background once every paired device is connected.
        private synchronized void updateMulticastLock() {
            if (!running) return;
            try {
                if (multicastLock == null) {
                    WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                    multicastLock = wifi.createMulticastLock("link-discovery");
                    multicastLock.setReferenceCounted(false);
                }
                boolean wanted = fastMode || System.currentTimeMillis() < listenUntil;
                if (wanted && !multicastLock.isHeld()) {
                    multicastLock.acquire();
                } else if (!wanted && multicastLock.isHeld()) {
                    multicastLock.release();
                }
            } catch (Exception e) {
                android.util.Log.e("LinkDiscovery", "Failed to update the multicast lock", e);
            }
        }

        public static String computePrivacyToken(String deviceId, String fingerprint) {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] digest = md.digest((deviceId + ":" + (fingerprint != null ? fingerprint : "")).getBytes(StandardCharsets.UTF_8));
                StringBuilder hex = new StringBuilder();
                for (byte b : digest) {
                    String h = Integer.toHexString(0xff & b);
                    if (h.length() == 1) hex.append('0');
                    hex.append(h);
                }
                return hex.substring(0, Math.min(32, hex.length()));
            } catch (Exception e) {
                return "";
            }
        }

        public synchronized void start(boolean visibilityEnabled) {
            if (running) return;
            this.visibilityEnabled = visibilityEnabled;
            running = true;
            fastSince = System.currentTimeMillis();

            updateMulticastLock();

            try {
                mdns = new LinkMdns(context, localIdentity.deviceId, this::onMdnsPeer);
                mdns.start(visibilityEnabled);
            } catch (Exception e) {
                android.util.Log.e("LinkDiscovery", "Failed to start mDNS", e);
                mdns = null;
            }

            // The receiver runs regardless of this device's visibility setting, so other devices'
            // broadcasts keep their last-seen times current.
            rxThread = new Thread(() -> {
                try {
                    rxSocket = new DatagramSocket(null);
                    rxSocket.setReuseAddress(true);
                    rxSocket.bind(new InetSocketAddress(1716));

                    byte[] buffer = new byte[8192];
                    while (running) {
                        try {
                            DatagramPacket datagram = new DatagramPacket(buffer, buffer.length);
                            rxSocket.receive(datagram);

                            String jsonStr = new String(datagram.getData(), datagram.getOffset(), datagram.getLength(), StandardCharsets.UTF_8).trim();
                            JSONObject packet = new JSONObject(jsonStr);
                            String packetType = packet.optString("type");

                            if ("link.identity".equals(packetType)) {
                                JSONObject body = packet.optJSONObject("body");
                                if (body != null) {
                                    LinkIdentity.Identity peer = LinkIdentity.Identity.fromJson(body);
                                    boolean isPaired = trustStore().isPaired(peer.deviceId);
                                    if (!peer.deviceId.equals(localIdentity.deviceId) && (isPaired || peer.visibility)) {
                                        noteSeen(peer.deviceId, body);
                                        String senderIp = datagram.getAddress().getHostAddress();
                                        listener.onDeviceDiscovered(senderIp, peer);
                                        if (!body.optBoolean("reply", false)) replyOverTailscale(datagram.getAddress());
                                    }
                                }
                            } else if ("link.identity.anon".equals(packetType)) {
                                JSONObject body = packet.optJSONObject("body");
                                if (body != null) {
                                    String token = body.optString("token", "");
                                    if (!token.isEmpty()) {
                                        for (LinkTrustStore.TrustedDevice dev : trustStore().list()) {
                                            try {
                                                String fp = LinkTls.fingerprint(dev.certificate());
                                                String expected = computePrivacyToken(dev.deviceId, fp);
                                                if (token.equals(expected) && !dev.deviceId.equals(localIdentity.deviceId)) {
                                                    noteSeen(dev.deviceId, body);
                                                    String senderIp = datagram.getAddress().getHostAddress();
                                                    LinkIdentity.Identity matched = new LinkIdentity.Identity(
                                                            dev.deviceId,
                                                            dev.deviceName,
                                                            "desktop",
                                                            new String[0],
                                                            new String[0]
                                                    );
                                                    matched.visibility = false;
                                                    listener.onDeviceDiscovered(senderIp, matched);
                                                    break;
                                                }
                                            } catch (Exception ignored) {}
                                        }
                                    }
                                }
                            }
                        } catch (Exception e) {
                            if (!running) break;
                            android.util.Log.e("LinkDiscovery", "Error receiving UDP packet", e);
                        }
                    }
                } catch (Exception e) {
                    android.util.Log.e("LinkDiscovery", "Failed to bind receiver socket", e);
                }
            }, "link-discovery-rx");
            rxThread.setDaemon(true);
            rxThread.start();

            // Broadcasts this device's announcement and expires peers that have gone silent.
            txThread = new Thread(() -> {
                while (running) {
                    // Said in the announcement and then waited, so peers expire this device on the same pace.
                    long interval = currentInterval();
                    try (DatagramSocket txSocket = new DatagramSocket()) {
                        txSocket.setBroadcast(true);

                        byte[] data = announcementBytes(false, interval);

                        java.util.List<InetAddress> targets = getBroadcastAddresses();
                        for (InetAddress addr : targets) {
                            DatagramPacket datagram = new DatagramPacket(data, data.length, addr, 1716);
                            txSocket.send(datagram);
                        }
                    } catch (Exception e) {
                        android.util.Log.e("LinkDiscovery", "Failed to send UDP broadcast", e);
                    }

                    // Lets go of the lock once the app is no longer in use (listenFor has run out).
                    updateMulticastLock();
                    long now = System.currentTimeMillis();
                    for (Map.Entry<String, Long> entry : discoveredPeerLastSeen.entrySet()) {
                        long peerInterval = discoveredPeerIntervalMs.getOrDefault(entry.getKey(), FAST_INTERVAL_MS);
                        if (now - entry.getValue() > Math.max(6000, peerInterval * 3) + 1000) {
                            String expiredId = entry.getKey();
                            discoveredPeerLastSeen.remove(expiredId);
                            discoveredPeerIntervalMs.remove(expiredId);
                            if (expiryListener != null) {
                                expiryListener.onDeviceExpired(expiredId);
                            }
                        }
                    }

                    try {
                        Thread.sleep(interval);
                    } catch (InterruptedException e) {
                        if (!running) break;
                    }
                }
            }, "link-discovery-tx");
            txThread.setDaemon(true);
            txThread.start();
        }

        /** This device's announcement: full identity when visible, an anonymous token for paired devices otherwise. */
        private byte[] announcementBytes(boolean reply, long intervalMs) throws Exception {
            JSONObject packet = new JSONObject();
            packet.put("id", System.currentTimeMillis());

            if (this.visibilityEnabled) {
                // Visible to everyone: name, ID and type, which is all a listener shows or acts on before
                // it connects. Capabilities and the rest come in the identity packet on the TLS connection.
                localIdentity.visibility = true;
                packet.put("type", "link.identity");
                JSONObject identityBody = new JSONObject();
                identityBody.put("deviceId", localIdentity.deviceId);
                identityBody.put("deviceName", localIdentity.deviceName);
                identityBody.put("deviceType", localIdentity.deviceType);
                identityBody.put("announceIntervalMs", intervalMs);
                // An answer to someone else's announcement, which is not answered in turn.
                identityBody.put("reply", reply);
                packet.put("body", identityBody);
            } else {
                // Trusted devices only: an anonymous token that only paired devices can match.
                String token = computePrivacyToken(localIdentity.deviceId, myCertFingerprint);
                JSONObject body = new JSONObject();
                body.put("token", token);
                body.put("port", 1716);
                body.put("announceIntervalMs", intervalMs);
                body.put("reply", reply);
                packet.put("type", "link.identity.anon");
                packet.put("body", body);
            }

            String payload = packet.toString() + "\n";
            return payload.getBytes(StandardCharsets.UTF_8);
        }

        /** Forgets a device heard earlier, e.g. one that was just unpaired, so it is not listed as nearby. */
        public void forget(String deviceId) {
            discoveredPeerLastSeen.remove(deviceId);
            discoveredPeerIntervalMs.remove(deviceId);
            LinkMdns m = mdns;
            if (m != null) m.forget(deviceId);
        }

        // A paired device found over mDNS: the same as hearing its anonymous announcement, so the plugin's
        // listener connects to it the usual way. LinkMdns only reports ids it matched to a paired device.
        private void onMdnsPeer(String deviceId, String ip) {
            try {
                LinkTrustStore.TrustedDevice dev = trustStore().get(deviceId);
                if (dev == null || deviceId.equals(localIdentity.deviceId)) return;
                JSONObject body = new JSONObject();
                body.put("announceIntervalMs", MDNS_INTERVAL_MS);
                noteSeen(dev.deviceId, body);
                LinkIdentity.Identity matched = new LinkIdentity.Identity(
                        dev.deviceId,
                        dev.deviceName,
                        "desktop",
                        new String[0],
                        new String[0]
                );
                matched.visibility = false;
                listener.onDeviceDiscovered(ip, matched);
            } catch (Exception e) {
                android.util.Log.w("LinkDiscovery", "Failed to handle an mDNS peer", e);
            }
        }

        // A broadcast does not cross Tailscale, so a device there that announces itself is answered
        // directly, but only while this device is visible and the user allowed Tailscale, and at most every
        // few seconds per sender.
        private void replyOverTailscale(InetAddress to) {
            String ip = to.getHostAddress();
            if (!visibilityEnabled || !LinkTailscale.isTailscaleAddr(ip)) return;
            long now = System.currentTimeMillis();
            Long last = tailnetRepliedAt.get(ip);
            if (last != null && now - last < 4000) return;
            LinkSettings settings = new LinkSettings(context);
            settings.load();
            if (!settings.remoteTailscale) return;
            tailnetRepliedAt.put(ip, now);
            try (DatagramSocket socket = new DatagramSocket()) {
                // Says it announces about every 15 seconds, which is how often a PC announces over Tailscale.
                byte[] data = announcementBytes(true, 15000);
                socket.send(new DatagramPacket(data, data.length, to, 1716));
            } catch (Exception e) {
                android.util.Log.w("LinkDiscovery", "Failed to answer over Tailscale", e);
            }
        }

        public synchronized void setVisibility(boolean enabled) {
            this.visibilityEnabled = enabled;
            if (mdns != null) {
                mdns.setVisibility(enabled);
            }
            if (txThread != null) {
                txThread.interrupt();
            }
        }

        /** Fast while this device is looking for someone, slow once every paired device is connected. */
        public void setFastMode(boolean fast) {
            boolean wasFast = fastMode;
            fastMode = fast;
            if (fast != wasFast) updateMulticastLock();
            if (fast && !wasFast) {
                fastSince = System.currentTimeMillis();
                broadcastNow();
            }
        }

        /** The device joined or changed networks: search at the fast pace again, starting now. */
        public void networkChanged() {
            fastSince = System.currentTimeMillis();
            broadcastNow();
        }

        // Records an announcement. A device not heard before is looking for us: answer straight away, but at
        // most once every couple of seconds so forged announcements cannot make this device flood the network.
        private void noteSeen(String deviceId, JSONObject body) {
            if (!body.has("announceIntervalMs")) return;
            long now = System.currentTimeMillis();
            boolean isNew = discoveredPeerLastSeen.put(deviceId, now) == null;
            long interval = body.optLong("announceIntervalMs");
            discoveredPeerIntervalMs.put(deviceId, Math.max(1000L, Math.min(300000L, interval)));
            if (isNew && now - lastReplyAt >= 2000) {
                lastReplyAt = now;
                broadcastNow();
            }
        }

        public synchronized void broadcastNow() {
            if (txThread != null) {
                txThread.interrupt();
            }
        }

        public synchronized void stop() {
            if (!running) return;
            running = false;

            if (mdns != null) {
                mdns.stop();
                mdns = null;
            }

            if (multicastLock != null) {
                try {
                    if (multicastLock.isHeld()) multicastLock.release();
                } catch (Exception ignored) {}
                multicastLock = null;
            }

            if (rxSocket != null) {
                try {
                    rxSocket.close();
                } catch (Exception ignored) {}
                rxSocket = null;
            }

            if (rxThread != null) {
                rxThread.interrupt();
                rxThread = null;
            }

            if (txThread != null) {
                txThread.interrupt();
                txThread = null;
            }

            discoveredPeerLastSeen.clear();
            discoveredPeerIntervalMs.clear();
        }

        private java.util.List<InetAddress> getBroadcastAddresses() {
            java.util.List<InetAddress> addresses = new java.util.ArrayList<>();
            try {
                java.util.Enumeration<java.net.NetworkInterface> interfaces = java.net.NetworkInterface.getNetworkInterfaces();
                while (interfaces != null && interfaces.hasMoreElements()) {
                    java.net.NetworkInterface ni = interfaces.nextElement();
                    if (ni.isLoopback() || !ni.isUp()) continue;
                    for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                        InetAddress broadcast = ia.getBroadcast();
                        if (broadcast != null) {
                            addresses.add(broadcast);
                        }
                    }
                }
            } catch (Exception e) {
                android.util.Log.e("LinkDiscovery", "Failed to query network interfaces", e);
            }
            if (addresses.isEmpty()) {
                try {
                    addresses.add(InetAddress.getByName("255.255.255.255"));
                } catch (Exception ignored) {}
            }
            return addresses;
        }
    }
}
