package in.rodix.link;

// mDNS discovery for PAIRED devices only, the Android counterpart of desktop's core/mdns.rs. It
// supplements the UDP broadcast in LinkDiscovery (some managed networks drop broadcasts but pass mDNS)
// and is never used by the guest tools: a stranger is never found this way.
//
// Privacy: the service is `_link._tcp` on LINK_PORT with no TXT data and no device name or type. Its
// instance name is an opaque id that rotates every hour:
//
//     id = hex( SHA-256( "link-mdns-v1" || device_id || epoch )[0..8] )   (16 lowercase hex digits)
//
// where "link-mdns-v1" is its 12 ASCII bytes, device_id its UTF-8 bytes and epoch an 8-byte big-endian
// long, unix_seconds / 3600. The desktop computes the same bytes (core/mdns.rs, with a test vector in
// core/tests/mdns.rs). A service is resolved only when its name matches a paired device's id for the
// previous, current or next hour, so a stranger's service is never even looked up.
//
// A match is handed to LinkDiscovery.Watcher, which feeds it to the same listener a UDP announcement
// reaches, so the plugin connects to it exactly as it does to a device heard by broadcast.
//
// NsdManager.resolveService is the only resolver before API 34 (minSdk is 29) and fails with
// FAILURE_ALREADY_ACTIVE if two resolves overlap, so resolves are queued and run one at a time.
// Note: on older Android versions the system, not this class, picks the host name in the records.

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class LinkMdns {
    private static final String TAG = "LinkMdns";
    private static final String SERVICE_TYPE = "_link._tcp";
    private static final String LABEL = "link-mdns-v1";
    private static final long EPOCH_SECS = 3600;
    // State is reconciled (trust, visibility, hour) and heard devices are re-published this often.
    private static final long TICK_MS = 5000;

    public interface Listener {
        /** A paired device was found at this IPv4 address; called again while its record lives. */
        void onPairedDeviceFound(String deviceId, String ip);
    }

    private final Context context;
    private final String myDeviceId;
    private final Listener listener;

    private NsdManager nsd;
    private Thread tickThread;
    private volatile boolean running = false;
    private volatile boolean visible = false;

    private NsdManager.DiscoveryListener discoveryListener;
    private NsdManager.RegistrationListener registrationListener;
    private long advertisedEpoch = -1;

    // Paired devices heard: device id -> address, and the record name that gave it.
    private final Map<String, String> heardIp = new HashMap<>();
    private final Map<String, String> heardName = new HashMap<>();
    // Record names waiting to be resolved, and whether a resolve is in flight.
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private final Set<String> queuedNames = new HashSet<>();
    private boolean resolving = false;

    public LinkMdns(Context context, String myDeviceId, Listener listener) {
        this.context = context.getApplicationContext();
        this.myDeviceId = myDeviceId;
        this.listener = listener;
    }

    /** The hour a rotating id belongs to. */
    static long epochAt(long unixSeconds) {
        return unixSeconds / EPOCH_SECS;
    }

    /** The opaque instance name a device advertises during {@code epoch}; identical to the desktop's. */
    static String instanceId(String deviceId, long epoch) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(LABEL.getBytes(StandardCharsets.US_ASCII));
            md.update(deviceId.getBytes(StandardCharsets.UTF_8));
            md.update(ByteBuffer.allocate(8).putLong(epoch).array());
            byte[] digest = md.digest();
            StringBuilder hex = new StringBuilder(16);
            for (int i = 0; i < 8; i++) hex.append(String.format("%02x", digest[i] & 0xff));
            return hex.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** Instance name -> device id for every paired device in the hours around {@code epoch}. */
    private Map<String, String> trustedInstances(long epoch) {
        Map<String, String> map = new HashMap<>();
        try {
            for (LinkTrustStore.TrustedDevice device : LinkTrustStore.getInstance(context).list()) {
                if (device.deviceId.equals(myDeviceId)) continue;
                for (long e = epoch - 1; e <= epoch + 1; e++) map.put(instanceId(device.deviceId, e), device.deviceId);
            }
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not read the trust store", e);
        }
        return map;
    }

    private static long epochNow() {
        return epochAt(System.currentTimeMillis() / 1000);
    }

    public synchronized void start(boolean visibilityEnabled) {
        if (running) return;
        running = true;
        visible = visibilityEnabled;
        try {
            nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        } catch (Exception e) {
            android.util.Log.w(TAG, "No NsdManager", e);
        }
        if (nsd == null) {
            running = false;
            return;
        }
        tickThread = new Thread(() -> {
            while (running) {
                try {
                    reconcile();
                } catch (Exception e) {
                    android.util.Log.w(TAG, "mDNS tick failed", e);
                }
                try {
                    Thread.sleep(TICK_MS);
                } catch (InterruptedException e) {
                    if (!running) break;
                }
            }
        }, "link-mdns");
        tickThread.setDaemon(true);
        tickThread.start();
    }

    public void setVisibility(boolean enabled) {
        visible = enabled;
        Thread t = tickThread;
        if (t != null) t.interrupt(); // reconcile now rather than at the next tick
    }

    public synchronized void stop() {
        if (!running) return;
        running = false;
        if (tickThread != null) {
            tickThread.interrupt();
            tickThread = null;
        }
        stopAdvertising();
        stopBrowsing();
        heardIp.clear();
        heardName.clear();
        resolveQueue.clear();
        queuedNames.clear();
        resolving = false;
    }

    /** Forgets a device (e.g. one just unpaired) so it is not published again. */
    public synchronized void forget(String deviceId) {
        heardIp.remove(deviceId);
        heardName.remove(deviceId);
    }

    private synchronized void reconcile() {
        if (!running || nsd == null) return;
        long epoch = epochNow();
        Map<String, String> trusted = trustedInstances(epoch);
        if (trusted.isEmpty()) {
            // Nobody paired: do nothing at all on the network.
            stopAdvertising();
            stopBrowsing();
            heardIp.clear();
            heardName.clear();
            return;
        }

        if (discoveryListener == null) startBrowsing();

        // Advertise only while visible, under this hour's id; a new hour means a new id.
        if (registrationListener != null && (!visible || advertisedEpoch != epoch)) stopAdvertising();
        if (visible && registrationListener == null) startAdvertising(epoch);

        // Keep devices whose records are still alive listed, and forget ones no longer paired.
        Set<String> trustedIds = new HashSet<>(trusted.values());
        heardIp.keySet().retainAll(trustedIds);
        heardName.keySet().retainAll(trustedIds);
        for (Map.Entry<String, String> entry : new HashMap<>(heardIp).entrySet()) {
            listener.onPairedDeviceFound(entry.getKey(), entry.getValue());
        }
    }

    private void startAdvertising(long epoch) {
        NsdServiceInfo info = new NsdServiceInfo();
        // Nothing here names the device, and there are no attributes.
        info.setServiceName(instanceId(myDeviceId, epoch));
        info.setServiceType(SERVICE_TYPE);
        info.setPort(LinkTransport.LINK_PORT);
        NsdManager.RegistrationListener registration = new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo serviceInfo) { }
            @Override public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                android.util.Log.w(TAG, "Advertising failed: " + errorCode);
                synchronized (LinkMdns.this) {
                    // Try again at the next tick.
                    if (registrationListener == this) registrationListener = null;
                }
            }
            @Override public void onServiceUnregistered(NsdServiceInfo serviceInfo) { }
            @Override public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) { }
        };
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
            registrationListener = registration;
            advertisedEpoch = epoch;
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not advertise", e);
        }
    }

    private void stopAdvertising() {
        NsdManager.RegistrationListener registration = registrationListener;
        registrationListener = null;
        advertisedEpoch = -1;
        if (registration != null && nsd != null) {
            try {
                nsd.unregisterService(registration);
            } catch (Exception ignored) { }
        }
    }

    private void startBrowsing() {
        NsdManager.DiscoveryListener discovery = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                android.util.Log.w(TAG, "Browsing failed: " + errorCode);
                synchronized (LinkMdns.this) {
                    if (discoveryListener == this) discoveryListener = null; // retried at the next tick
                }
            }
            @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) { }
            @Override public void onDiscoveryStarted(String serviceType) { }
            @Override public void onDiscoveryStopped(String serviceType) { }

            @Override public void onServiceFound(NsdServiceInfo serviceInfo) {
                onRecordFound(serviceInfo);
            }

            @Override public void onServiceLost(NsdServiceInfo serviceInfo) {
                onRecordLost(serviceInfo);
            }
        };
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
            discoveryListener = discovery;
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not browse", e);
        }
    }

    private void stopBrowsing() {
        NsdManager.DiscoveryListener discovery = discoveryListener;
        discoveryListener = null;
        resolveQueue.clear();
        queuedNames.clear();
        if (discovery != null && nsd != null) {
            try {
                nsd.stopServiceDiscovery(discovery);
            } catch (Exception ignored) { }
        }
    }

    /** The id part of a record name; the system may append " (2)" when two records share a name. */
    private static String baseName(String serviceName) {
        if (serviceName == null) return "";
        int space = serviceName.indexOf(' ');
        return space < 0 ? serviceName : serviceName.substring(0, space);
    }

    private synchronized void onRecordFound(NsdServiceInfo found) {
        if (!running || found.getServiceType() == null || !found.getServiceType().startsWith(SERVICE_TYPE)) return;
        String name = baseName(found.getServiceName());
        // Only a record whose name is a paired device's id is looked up; any other is ignored unseen.
        if (!trustedInstances(epochNow()).containsKey(name)) return;
        if (!queuedNames.add(found.getServiceName())) return;
        resolveQueue.add(found);
        resolveNext();
    }

    private synchronized void onRecordLost(NsdServiceInfo lost) {
        String name = lost.getServiceName();
        queuedNames.remove(name);
        heardName.values().removeIf(heard -> heard.equals(name));
        // Drop the address of any device whose record just went.
        heardIp.keySet().retainAll(heardName.keySet());
    }

    // Runs one resolve at a time; called with the lock held.
    private void resolveNext() {
        if (resolving || nsd == null) return;
        NsdServiceInfo next = resolveQueue.poll();
        if (next == null) return;
        resolving = true;
        final String recordName = next.getServiceName();
        try {
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    synchronized (LinkMdns.this) {
                        queuedNames.remove(recordName);
                        resolving = false;
                        resolveNext();
                    }
                }

                @Override public void onServiceResolved(NsdServiceInfo serviceInfo) {
                    String found = null;
                    String deviceId = null;
                    synchronized (LinkMdns.this) {
                        queuedNames.remove(recordName);
                        resolving = false;
                        deviceId = trustedInstances(epochNow()).get(baseName(recordName));
                        InetAddress host = serviceInfo.getHost();
                        if (deviceId != null && host instanceof Inet4Address && usable(host)) {
                            found = host.getHostAddress();
                            heardIp.put(deviceId, found);
                            heardName.put(deviceId, recordName);
                        }
                        resolveNext();
                    }
                    if (found != null) listener.onPairedDeviceFound(deviceId, found);
                }
            });
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not resolve", e);
            queuedNames.remove(recordName);
            resolving = false;
        }
    }

    private static boolean usable(InetAddress address) {
        return !(address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isMulticastAddress() || address.isAnyLocalAddress());
    }
}
