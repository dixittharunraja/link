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
        private final Map<String, Long> discoveredPeerLastSeen = new ConcurrentHashMap<>();

        private static final long DISCOVERY_INTERVAL_MS = 2000;
        private static final long PEER_EXPIRY_MS = DISCOVERY_INTERVAL_MS * 3;

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

            try {
                WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                multicastLock = wifi.createMulticastLock("link-discovery");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            } catch (Exception e) {
                android.util.Log.e("LinkDiscovery", "Failed to acquire multicast lock", e);
            }

            // Receiver thread — always runs regardless of visibility, so we can hear broadcasts
            // from other devices and update their last-seen timestamps.
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
                                    LinkTrustStore trustStore = new LinkTrustStore(context);
                                    boolean isPaired = trustStore.isPaired(peer.deviceId);
                                    if (!peer.deviceId.equals(localIdentity.deviceId) && (isPaired || peer.visibility)) {
                                        discoveredPeerLastSeen.put(peer.deviceId, System.currentTimeMillis());
                                        String senderIp = datagram.getAddress().getHostAddress();
                                        listener.onDeviceDiscovered(senderIp, peer);
                                    }
                                }
                            } else if ("link.identity.anon".equals(packetType)) {
                                JSONObject body = packet.optJSONObject("body");
                                if (body != null) {
                                    String token = body.optString("token", "");
                                    if (!token.isEmpty()) {
                                        LinkTrustStore trustStore = new LinkTrustStore(context);
                                        for (LinkTrustStore.TrustedDevice dev : trustStore.list()) {
                                            try {
                                                String fp = LinkTls.fingerprint(dev.certificate());
                                                String expected = computePrivacyToken(dev.deviceId, fp);
                                                if (token.equals(expected) && !dev.deviceId.equals(localIdentity.deviceId)) {
                                                    discoveredPeerLastSeen.put(dev.deviceId, System.currentTimeMillis());
                                                    String senderIp = datagram.getAddress().getHostAddress();
                                                    LinkIdentity.Identity matched = new LinkIdentity.Identity(
                                                            dev.deviceId,
                                                            dev.deviceName,
                                                            "desktop",
                                                            dev.protocolVersion,
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

            // Broadcaster + expiry thread — sends broadcasts in appropriate mode (Everyone vs Trusted Only)
            // and periodically checks for peers that have gone silent.
            txThread = new Thread(() -> {
                while (running) {
                    try (DatagramSocket txSocket = new DatagramSocket()) {
                        txSocket.setBroadcast(true);

                        JSONObject packet = new JSONObject();
                        packet.put("id", System.currentTimeMillis());

                        if (this.visibilityEnabled) {
                            // Mode 1: Visible to Everyone — announcement with full name and ID
                            localIdentity.visibility = true;
                            packet.put("type", "link.identity");
                            packet.put("body", localIdentity.toJson());
                        } else {
                            // Mode 2: Trusted Devices Only — anonymous token matching paired trust stores
                            String token = computePrivacyToken(localIdentity.deviceId, myCertFingerprint);
                            JSONObject body = new JSONObject();
                            body.put("token", token);
                            body.put("port", 1716);
                            packet.put("type", "link.identity.anon");
                            packet.put("body", body);
                        }

                        String payload = packet.toString() + "\n";
                        byte[] data = payload.getBytes(StandardCharsets.UTF_8);

                        java.util.List<InetAddress> targets = getBroadcastAddresses();
                        for (InetAddress addr : targets) {
                            DatagramPacket datagram = new DatagramPacket(data, data.length, addr, 1716);
                            txSocket.send(datagram);
                        }
                    } catch (Exception e) {
                        android.util.Log.e("LinkDiscovery", "Failed to send UDP broadcast", e);
                    }

                    // Expiry check
                    long now = System.currentTimeMillis();
                    for (Map.Entry<String, Long> entry : discoveredPeerLastSeen.entrySet()) {
                        if (now - entry.getValue() > PEER_EXPIRY_MS) {
                            String expiredId = entry.getKey();
                            discoveredPeerLastSeen.remove(expiredId);
                            if (expiryListener != null) {
                                expiryListener.onDeviceExpired(expiredId);
                            }
                        }
                    }

                    try {
                        Thread.sleep(DISCOVERY_INTERVAL_MS);
                    } catch (InterruptedException e) {
                        if (!running) break;
                    }
                }
            }, "link-discovery-tx");
            txThread.setDaemon(true);
            txThread.start();
        }

        public synchronized void setVisibility(boolean enabled) {
            this.visibilityEnabled = enabled;
            if (txThread != null) {
                txThread.interrupt();
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
