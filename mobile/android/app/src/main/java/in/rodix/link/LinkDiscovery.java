package in.rodix.link;

import android.net.DhcpInfo;
import android.net.wifi.WifiManager;
import android.content.Context;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class LinkDiscovery {
    public interface Listener {
        void onDeviceDiscovered(String ip, LinkIdentity.Identity identity);
    }

    public static class Watcher {
        private final LinkIdentity.Identity localIdentity;
        private final Listener listener;
        private final Context context;
        private DatagramSocket rxSocket;
        private Thread rxThread;
        private Thread txThread;
        private volatile boolean running = false;
        private volatile boolean visibilityEnabled = true;
        // Several Wi-Fi chipset drivers filter broadcast/multicast frames before they reach the
        // app processor to save power, unless the app explicitly holds a multicast lock — even
        // though broadcast isn't technically multicast, many OEM implementations gate both on the
        // same radio setting. Without this, receiving the PC's periodic broadcast was a coin flip
        // that happened to work more often right after a fresh app launch (a new Wi-Fi association
        // sometimes briefly resets the filter), matching the "reopening the app sometimes fixes
        // it" symptom.
        private android.net.wifi.WifiManager.MulticastLock multicastLock;

        public Watcher(Context context, LinkIdentity.Identity localIdentity, Listener listener) {
            this.context = context;
            this.localIdentity = localIdentity;
            this.listener = listener;
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

            // Receiver thread
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
                            if ("link.identity".equals(packet.optString("type"))) {
                                JSONObject body = packet.optJSONObject("body");
                                if (body != null) {
                                    LinkIdentity.Identity peer = LinkIdentity.Identity.fromJson(body);
                                    if (!peer.deviceId.equals(localIdentity.deviceId)) {
                                        String senderIp = datagram.getAddress().getHostAddress();
                                        listener.onDeviceDiscovered(senderIp, peer);
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

            // Broadcaster thread
            txThread = new Thread(() -> {
                while (running) {
                    if (this.visibilityEnabled) {
                        try (DatagramSocket txSocket = new DatagramSocket()) {
                            txSocket.setBroadcast(true);

                            JSONObject packet = new JSONObject();
                            packet.put("id", System.currentTimeMillis());
                            packet.put("type", "link.identity");
                            packet.put("body", localIdentity.toJson());

                            String payload = packet.toString() + "\n";
                            byte[] data = payload.getBytes(StandardCharsets.UTF_8);

                            InetAddress broadcastAddr = getBroadcastAddress();
                            DatagramPacket datagram = new DatagramPacket(data, data.length, broadcastAddr, 1716);
                            txSocket.send(datagram);
                        } catch (Exception e) {
                            android.util.Log.e("LinkDiscovery", "Failed to send UDP broadcast", e);
                        }
                    }

                    try {
                        // Shortened from an earlier 5000ms — combined with the heartbeat cycle
                        // now detecting a dead peer within ~9s instead of relying on slow/opaque
                        // OS TCP keepalive, a snappier rebroadcast means less time sitting between
                        // "peer confirmed dead" and "next chance to rediscover it."
                        Thread.sleep(3000);
                    } catch (InterruptedException e) {
                        break;
                    }
                }
            }, "link-discovery-tx");
            txThread.setDaemon(true);
            txThread.start();
        }

        public synchronized void setVisibility(boolean enabled) {
            this.visibilityEnabled = enabled;
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
        }

        private InetAddress getBroadcastAddress() throws Exception {
            try {
                WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                DhcpInfo dhcp = wifi.getDhcpInfo();
                if (dhcp != null && dhcp.netmask != 0) {
                    int broadcast = (dhcp.ipAddress & dhcp.netmask) | ~dhcp.netmask;
                    byte[] quads = new byte[4];
                    for (int k = 0; k < 4; k++) {
                        quads[k] = (byte) ((broadcast >> (k * 8)) & 0xFF);
                    }
                    return InetAddress.getByAddress(quads);
                }
            } catch (Exception ignored) {}
            return InetAddress.getByName("255.255.255.255");
        }
    }
}
