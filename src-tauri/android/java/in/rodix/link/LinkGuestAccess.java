package in.rodix.link;

// The QR codes of the tools that accept unpaired devices (audio sink, file transfer, joystick,
// walkie-talkie, remote mic, input guests), on both sides. Mirrors the guest layer in core/guest.rs on
// the desktop; keep the two in step.
//
// A tool's QR carries the host's key fingerprint and a one-time token. The guest that scans it checks
// the fingerprint before saying anything (so there is no PIN to compare) and presents the token in the
// address it dials (wss://host:port/?t=TOKEN). The host takes each token once. The host's Accept
// button is still the gate: a token only proves the guest scanned the code on this screen. A guest
// that typed the address has no token and goes through the PIN as before.

import org.java_websocket.client.WebSocketClient;

import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

import javax.net.ssl.SSLSocket;

public final class LinkGuestAccess {
    private LinkGuestAccess() {}

    static final String MISMATCH = "That is not the device in the QR code. Connection stopped.";
    private static final long SCAN_LIFETIME_MS = 120_000;

    // ---- Host: the QR each tool is showing, by port ----

    private static final Map<Integer, LinkPairingWindow> windows = new ConcurrentHashMap<>();
    private static volatile Consumer<String> conflictListener;

    private static LinkPairingWindow window(int port) {
        return windows.computeIfAbsent(port, p -> new LinkPairingWindow());
    }

    /** A tool is showing its QR: returns the token it carries. */
    public static String openQr(int port) {
        return window(port).open(System.currentTimeMillis());
    }

    public static String refreshQr(int port) {
        return window(port).refresh(System.currentTimeMillis());
    }

    public static void closeQr(int port) {
        window(port).close();
    }

    /**
     * Judges a guest by the token it presented. A guest without one is an ordinary guest: the host is
     * running the tool on purpose, so it is asked about via the PIN.
     */
    public static LinkPairingWindow.Admission admit(int port, String token) {
        return window(port).admit(token, true, System.currentTimeMillis());
    }

    /** True when the guest must be refused outright (a token this tool did not issue, or one already used). */
    public static boolean refuses(LinkPairingWindow.Admission admission) {
        return admission == LinkPairingWindow.Admission.CLOSED
                || admission == LinkPairingWindow.Admission.BAD_TOKEN
                || admission == LinkPairingWindow.Admission.CONFLICT;
    }

    /** Whom to tell when a second guest presents a token that was already used (set by LinkPlugin). */
    public static void setConflictListener(Consumer<String> listener) {
        conflictListener = listener;
    }

    public static void reportConflict(String deviceName) {
        Consumer<String> listener = conflictListener;
        if (listener != null) listener.accept(deviceName);
    }

    /** The token in a handshake address such as "/?t=abc" (null when there is none). */
    public static String tokenFromDescriptor(String descriptor) {
        if (descriptor == null) return null;
        int query = descriptor.indexOf('?');
        if (query < 0) return null;
        for (String pair : descriptor.substring(query + 1).split("&")) {
            if (pair.startsWith("t=") && pair.length() > 2) return pair.substring(2);
        }
        return null;
    }

    // ---- Guest: QR codes this device scanned and has not used yet, by host address ----

    /** What a scanned QR proves about the host it names. */
    public static final class Scan {
        public final String fingerprint;
        public final String token;
        final long at = System.currentTimeMillis();

        Scan(String fingerprint, String token) {
            this.fingerprint = fingerprint;
            this.token = token;
        }
    }

    private static final Map<String, Scan> scans = new ConcurrentHashMap<>();

    /** Remembers a scanned QR for the addresses it names; the next dial to one of them uses it. */
    public static void rememberScan(String addresses, String fingerprint, String token) {
        if (addresses == null || fingerprint == null || token == null) return;
        long now = System.currentTimeMillis();
        scans.values().removeIf(scan -> now - scan.at > SCAN_LIFETIME_MS);
        for (String raw : addresses.split(",")) {
            String host = raw.trim();
            if (!host.isEmpty()) scans.put(host, new Scan(fingerprint.toLowerCase(Locale.ROOT), token));
        }
    }

    /** The scan for this host, used up by the call (null when there is none, or it is too old). */
    public static Scan takeScan(String host) {
        Scan scan = host != null ? scans.remove(host.trim()) : null;
        return scan != null && System.currentTimeMillis() - scan.at <= SCAN_LIFETIME_MS ? scan : null;
    }

    /** The address to dial: with the scan's token when there is one. */
    public static String address(String host, int port, Scan scan) {
        String base = "wss://" + host + ":" + port;
        return scan != null ? base + "/?t=" + scan.token : base;
    }

    /**
     * Whether the host that answered holds the key named by the QR (true when there was no QR to check).
     * Call from onOpen, once the TLS handshake is done; on false, close the connection and report
     * MISMATCH without sending anything.
     */
    public static boolean verifyHost(Scan scan, WebSocketClient client) {
        if (scan == null) return true;
        try {
            Socket socket = client.getSocket();
            if (!(socket instanceof SSLSocket)) return false;
            Certificate[] chain = ((SSLSocket) socket).getSession().getPeerCertificates();
            if (chain.length == 0) return false;
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
            StringBuilder hex = new StringBuilder();
            for (byte b : hash) hex.append(String.format("%02x", b));
            return hex.toString().equals(scan.fingerprint);
        } catch (Exception e) {
            return false;
        }
    }
}
