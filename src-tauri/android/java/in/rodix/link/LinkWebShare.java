package in.rodix.link;

// Browser access to this phone, the same Web Portal the desktop offers (core/portal.rs): a small web page served over
// plain HTTP on the local network, so any device with a browser, Link installed or not, can exchange files with it.
// The browser asks to join and shows a short PIN; the same PIN appears in the app (the File Transfer tool's guest
// prompt) and the phone's owner accepts or rejects. An admitted browser can download the files staged in the app and
// upload files into the phone's Link folder. Downloads stream straight from the content:// URIs they were picked as, so
// nothing is copied.

import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class LinkWebShare {
    private static final String TAG = "LinkWebShare";
    private static final long PENDING_MS = 120_000; // how long a browser may wait to be accepted
    private static final int MAX_PENDING = 10;
    private static final long GONE_MS = 15_000; // an admitted browser silent this long has left

    public static final class Entry {
        final String id;
        final String name;
        final long size; // -1 when unknown
        final Uri uri;

        public Entry(String id, String name, long size, Uri uri) {
            this.id = id;
            this.name = name;
            this.size = size;
            this.uri = uri;
        }
    }

    /** Events for the app's File Transfer screen (approve mode). */
    public interface Listener {
        /** A browser asked to join. `pin` is shown on both screens; call acceptGuest or rejectGuest. */
        void onGuestPending(String connId, String pin, String remoteAddress);

        void onGuestAdmitted(String connId);

        /** An admitted browser left (closed the page, went quiet, or was disconnected), or a join request timed out. */
        void onGuestClosed(String connId);

        void onUploadStarted(String connId, String name, long size);

        void onUploadComplete(String connId, String path);

        void onError(String message);
    }

    private static final class Pending {
        final String ip;
        final String pin;
        final long createdAt = System.currentTimeMillis();
        volatile String state = "pending"; // pending | admitted | rejected | closed
        volatile String token;
        // Every request from the admitted browser refreshes this; a browser that goes quiet is considered gone.
        volatile long lastSeen = System.currentTimeMillis();
        // Transfers in progress, so a long upload or download is not mistaken for a browser that went quiet.
        final java.util.concurrent.atomic.AtomicInteger busy = new java.util.concurrent.atomic.AtomicInteger();

        Pending(String ip, String pin) {
            this.ip = ip;
            this.pin = pin;
        }
    }

    private final Context app;
    private volatile List<Entry> entries;
    private final Listener listener;
    private final File uploadDir;
    private final ServerSocket server;
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    private final Map<String, String> tokens = new HashMap<>(); // token -> connId ("" in PIN mode)
    private final Map<String, Pending> pending = new HashMap<>();
    private final SecureRandom random = new SecureRandom();
    // What the phone last saw, shown on the share screen so a browser that cannot connect can be told from one that
    // never reaches this phone at all.
    private volatile String lastEvent = "No visit yet";
    private volatile boolean stopped = false;
    private volatile int downloads = 0;

    private LinkWebShare(Context app, List<Entry> entries, Listener listener, File uploadDir, int port) throws IOException {
        this.app = app;
        this.entries = entries;
        this.listener = listener;
        this.uploadDir = uploadDir;
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(port));
        this.server = socket;
    }

    /** The File Transfer tab's Web Portal: browsers ask to join and the phone's owner accepts them. */
    public static LinkWebShare startPortal(Context context, int port, File uploadDir, Listener listener) throws IOException {
        LinkWebShare share = new LinkWebShare(context.getApplicationContext(), Collections.<Entry>emptyList(), listener, uploadDir, port);
        share.run();
        return share;
    }

    private void run() {
        Thread accept = new Thread(this::acceptLoop, "link-webshare-accept");
        accept.setDaemon(true);
        accept.start();

        // The page asks for the file list every few seconds, which doubles as a heartbeat: a browser that has stopped
        // (tab closed, Wi-Fi lost) is dropped, and so is a join request nobody answered, so the app can show its QR
        // code again instead of waiting for a connection that is gone.
        Thread watchdog = new Thread(() -> {
            while (!stopped) {
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    return;
                }
                long now = System.currentTimeMillis();
                java.util.List<String> idle = new java.util.ArrayList<>();
                java.util.List<String> expired = new java.util.ArrayList<>();
                synchronized (pending) {
                    java.util.Iterator<Map.Entry<String, Pending>> it = pending.entrySet().iterator();
                    while (it.hasNext()) {
                        Map.Entry<String, Pending> entry = it.next();
                        Pending p = entry.getValue();
                        if ("pending".equals(p.state) && now - p.createdAt > PENDING_MS) {
                            p.state = "rejected";
                            expired.add(entry.getKey());
                        } else if ("admitted".equals(p.state) && p.busy.get() == 0 && now - p.lastSeen > GONE_MS) {
                            idle.add(entry.getKey());
                        } else if (("closed".equals(p.state) || "rejected".equals(p.state)) && now - p.lastSeen > 5 * 60_000) {
                            it.remove();
                        }
                    }
                }
                for (String id : expired) listener.onGuestClosed(id);
                for (String id : idle) closeGuest(id);
            }
        }, "link-webshare-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    public int port() {
        return server.getLocalPort();
    }

    public int downloadCount() {
        return downloads;
    }

    public String lastEvent() {
        return lastEvent;
    }

    public boolean isRunning() {
        return !stopped;
    }

    /** The files browsers may download right now, so a reopened screen can show them again. */
    public List<Entry> stagedEntries() {
        return entries;
    }

    /** Files browsers may download (approve mode: whatever the app staged). */
    public void setEntries(List<Entry> files) {
        this.entries = files;
    }

    /** The phone's owner accepted a browser that asked to join. */
    public void acceptGuest(String connId) {
        Pending p;
        synchronized (pending) {
            p = pending.get(connId);
            if (p == null || !"pending".equals(p.state)) return;
            p.token = newToken();
            p.state = "admitted";
        }
        synchronized (tokens) {
            tokens.put(p.token, connId);
        }
        lastEvent = p.ip + " was accepted";
        if (listener != null) listener.onGuestAdmitted(connId);
    }

    /** Ends an admitted browser's session: its token stops working and the app is told. */
    public void closeGuest(String connId) {
        Pending p;
        synchronized (pending) {
            p = pending.get(connId);
            if (p == null || "closed".equals(p.state) || "rejected".equals(p.state)) return;
            p.state = "closed";
            p.lastSeen = System.currentTimeMillis();
        }
        synchronized (tokens) {
            tokens.values().removeIf(connId::equals);
        }
        lastEvent = p.ip + " left";
        listener.onGuestClosed(connId);
    }

    /** The first admitted browser, if one is connected. */
    public String admittedGuest() {
        synchronized (pending) {
            for (Map.Entry<String, Pending> entry : pending.entrySet()) {
                if ("admitted".equals(entry.getValue().state)) return entry.getKey();
            }
        }
        return null;
    }

    public void rejectGuest(String connId) {
        synchronized (pending) {
            Pending p = pending.get(connId);
            if (p != null && "pending".equals(p.state)) p.state = "rejected";
        }
    }

    public String pendingAddress(String connId) {
        synchronized (pending) {
            Pending p = pending.get(connId);
            return p != null ? p.ip : null;
        }
    }

    /** The address a browser on the same network opens, or null when this phone has no local network address. */
    public String url() {
        String ip = localAddress();
        return ip == null ? null : "http://" + ip + ":" + port() + "/";
    }

    public synchronized void stop() {
        if (stopped) return;
        stopped = true;
        try {
            server.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
        synchronized (tokens) {
            tokens.clear();
        }
    }

    // Prefers the Wi-Fi / hotspot interface so the link works for the person next to you.
    static String localAddress() {
        String fallback = null;
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface nif = interfaces.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName();
                Enumeration<InetAddress> addresses = nif.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (!(address instanceof Inet4Address) || !address.isSiteLocalAddress()) continue;
                    if (name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("swlan")) return address.getHostAddress();
                    if (fallback == null) fallback = address.getHostAddress();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read the local address", e);
        }
        return fallback;
    }

    private String newToken() {
        byte[] raw = new byte[16];
        random.nextBytes(raw);
        StringBuilder token = new StringBuilder();
        for (byte value : raw) token.append(String.format(java.util.Locale.ROOT, "%02x", value));
        return token.toString();
    }

    private void acceptLoop() {
        while (!stopped) {
            Socket socket = null;
            try {
                socket = server.accept();
                socket.setSoTimeout(15_000);
                final Socket accepted = socket;
                pool.execute(() -> handle(accepted));
            } catch (Throwable e) {
                if (stopped) return;
                // One bad connection must not end the listener.
                Log.w(TAG, "accept failed", e);
                lastEvent = "Error while accepting: " + e;
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (IOException ignored) {
                    }
                }
                if (server.isClosed()) return;
            }
        }
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length < 2) return;
            String method = request[0];
            String target = request[1];
            String path = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path = target.substring(0, q);
                query = target.substring(q + 1);
            }
            String ip = s.getInetAddress().getHostAddress();

            if ("GET".equals(method) && ("/".equals(path) || "/index.html".equals(path))) {
                lastEvent = ip + " opened the page";
                respond(out, 200, "text/html; charset=utf-8", LinkWebPage.PAGE.getBytes(StandardCharsets.UTF_8));
            } else if ("POST".equals(method) && "/join".equals(path)) {
                join(out, ip);
            } else if ("GET".equals(method) && "/status".equals(path)) {
                status(out, queryParam(query, "c"), ip);
            } else if ("GET".equals(method) && "/files".equals(path)) {
                String token = queryParam(query, "token");
                if (!validToken(token)) {
                    respond(out, 403, "text/plain", "Not admitted".getBytes(StandardCharsets.UTF_8));
                } else {
                    respond(out, 200, "application/json", filesJson().toString().getBytes(StandardCharsets.UTF_8));
                }
            } else if ("GET".equals(method) && path.startsWith("/f/")) {
                download(out, path.substring(3), queryParam(query, "token"), header(lines, "Range"));
            } else if ("POST".equals(method) && "/leave".equals(path)) {
                // Sent by the page as it closes, so the app learns at once instead of after the quiet period.
                String connId = connFor(queryParam(query, "token"));
                if (connId != null) closeGuest(connId);
                respond(out, 200, "text/plain", "OK".getBytes(StandardCharsets.UTF_8));
            } else if ("POST".equals(method) && "/up".equals(path)) {
                upload(in, out, lines, ip, queryParam(query, "token"), queryParam(query, "name"));
            } else {
                respond(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable e) {
            // A browser that goes away mid-download is normal; anything else is shown on the share screen.
            Log.w(TAG, "connection ended: " + e);
            if (!(e instanceof java.net.SocketException) && !(e instanceof java.net.SocketTimeoutException)) {
                lastEvent = "Error: " + e;
            }
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int window = 0;
        int b;
        while ((b = in.read()) != -1) {
            buffer.write(b);
            window = (window << 8) | b;
            if (window == 0x0D0A0D0A) return buffer.toString("ISO-8859-1"); // end of the headers
            if (buffer.size() > 8192) return null;
        }
        return null;
    }

    private static long headerLong(String[] headerLines, String name) {
        for (String line : headerLines) {
            if (line.toLowerCase(java.util.Locale.ROOT).startsWith(name + ":")) {
                try {
                    return Long.parseLong(line.substring(name.length() + 1).trim());
                } catch (NumberFormatException e) {
                    return -1;
                }
            }
        }
        return -1;
    }

    /** The session a token belongs to, or null when it is not valid. Any use of a token counts as the browser being alive. */
    private String connFor(String token) {
        if (token == null || token.isEmpty()) return null;
        String connId;
        synchronized (tokens) {
            connId = tokens.get(token);
        }
        if (connId != null) {
            synchronized (pending) {
                Pending p = pending.get(connId);
                if (p != null) p.lastSeen = System.currentTimeMillis();
            }
        }
        return connId;
    }

    private boolean validToken(String token) {
        return connFor(token) != null;
    }

    private Pending sessionOf(String connId) {
        synchronized (pending) {
            return pending.get(connId);
        }
    }

    // ---- Joining: the browser asks, the phone's owner compares the PIN and accepts ----

    private void join(OutputStream out, String ip) throws Exception {
        String connId;
        String shownPin;
        synchronized (pending) {
            long now = System.currentTimeMillis();
            java.util.Iterator<Map.Entry<String, Pending>> it = pending.entrySet().iterator();
            int waiting = 0;
            int fromThisAddress = 0;
            while (it.hasNext()) {
                Map.Entry<String, Pending> e = it.next();
                Pending p = e.getValue();
                if ("pending".equals(p.state) && now - p.createdAt > PENDING_MS) p.state = "rejected";
                if ("pending".equals(p.state)) {
                    waiting++;
                    if (p.ip.equals(ip)) fromThisAddress++;
                }
            }
            if (waiting >= MAX_PENDING || fromThisAddress >= 3) {
                respond(out, 429, "text/plain", "Too many requests".getBytes(StandardCharsets.UTF_8));
                return;
            }
            byte[] raw = new byte[4];
            random.nextBytes(raw);
            connId = String.format(java.util.Locale.ROOT, "web-%02x%02x%02x%02x", raw[0], raw[1], raw[2], raw[3]);
            shownPin = String.format(java.util.Locale.ROOT, "%08X", random.nextInt());
            pending.put(connId, new Pending(ip, shownPin));
        }
        lastEvent = ip + " asked to join";
        listener.onGuestPending(connId, shownPin, ip);
        respond(out, 200, "application/json", new JSONObject().put("conn", connId).put("pin", shownPin).toString().getBytes(StandardCharsets.UTF_8));
    }

    private void status(OutputStream out, String connId, String ip) throws Exception {
        Pending p;
        synchronized (pending) {
            p = pending.get(connId);
        }
        if (p == null || !p.ip.equals(ip)) {
            respond(out, 404, "text/plain", "Unknown request".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if ("pending".equals(p.state) && System.currentTimeMillis() - p.createdAt > PENDING_MS) p.state = "rejected";
        JSONObject result = new JSONObject().put("state", p.state);
        if ("admitted".equals(p.state)) result.put("token", p.token).put("files", filesJson());
        respond(out, 200, "application/json", result.toString().getBytes(StandardCharsets.UTF_8));
    }

    private JSONArray filesJson() {
        JSONArray files = new JSONArray();
        try {
            for (Entry entry : entries) {
                files.put(new JSONObject().put("id", entry.id).put("name", entry.name).put("size", entry.size));
            }
        } catch (Exception ignored) {
        }
        return files;
    }

    // ---- Browser -> phone: the file arrives as the raw request body and is saved into the Link folder ----

    private void upload(InputStream in, OutputStream out, String[] headerLines, String ip, String token, String rawName) throws Exception {
        String connId = connFor(token);
        Pending session = connId != null ? sessionOf(connId) : null;
        if (session != null) session.busy.incrementAndGet();
        try {
            uploadNow(in, out, headerLines, ip, connId, rawName);
        } finally {
            if (session != null) {
                session.busy.decrementAndGet();
                session.lastSeen = System.currentTimeMillis();
            }
        }
    }

    private void uploadNow(InputStream in, OutputStream out, String[] headerLines, String ip, String connId, String rawName) throws Exception {
        if (connId == null) {
            respond(out, 403, "text/plain", "Not admitted".getBytes(StandardCharsets.UTF_8));
            return;
        }
        long length = headerLong(headerLines, "content-length");
        if (length < 0) {
            respond(out, 411, "text/plain", "Length required".getBytes(StandardCharsets.UTF_8));
            return;
        }
        String name = safeName(rawName);
        File dir = uploadDir;
        if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) {
            respond(out, 500, "text/plain", "Cannot save here".getBytes(StandardCharsets.UTF_8));
            return;
        }
        File target = uniqueFile(dir, name);
        File part = new File(dir, target.getName() + ".part");
        lastEvent = ip + " is sending " + name;
        listener.onUploadStarted(connId, name, length);
        boolean complete = false;
        try (FileOutputStream file = new FileOutputStream(part)) {
            byte[] chunk = new byte[131072];
            long left = length;
            while (left > 0) {
                int n = in.read(chunk, 0, (int) Math.min(chunk.length, left));
                if (n < 0) throw new IOException("The browser closed the connection early");
                file.write(chunk, 0, n);
                left -= n;
            }
            complete = true;
        } finally {
            if (!complete) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
            }
        }
        if (!part.renameTo(target)) throw new IOException("Could not save " + name);
        lastEvent = name + " received";
        listener.onUploadComplete(connId, target.getAbsolutePath());
        respond(out, 200, "text/plain", "OK".getBytes(StandardCharsets.UTF_8));
    }

    static String safeName(String raw) {
        if (raw == null) return "file";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            sb.append(c < 0x20 || c == 0x7f || c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|' ? '_' : c);
        }
        String name = sb.toString().trim();
        while (name.startsWith(".")) name = name.substring(1);
        if (name.isEmpty()) return "file";
        return name.length() > 200 ? name.substring(name.length() - 200) : name;
    }

    static File uniqueFile(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists() && !new File(dir, name + ".part").exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; n < 10_000; n++) {
            candidate = new File(dir, stem + " (" + n + ")" + ext);
            if (!candidate.exists() && !new File(dir, candidate.getName() + ".part").exists()) return candidate;
        }
        return new File(dir, stem + "-" + System.currentTimeMillis() + ext);
    }

    // ---- Phone -> browser ----

    private static String header(String[] lines, String name) {
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0 && lines[i].substring(0, colon).trim().equalsIgnoreCase(name)) return lines[i].substring(colon + 1).trim();
        }
        return null;
    }

    /** A single "bytes=a-b" range (either bound optional) against a known size, as {start, end}
     *  inclusive; null when absent, malformed or unsatisfiable, in which case the whole file is sent. */
    private static long[] parseRange(String header, long size) {
        if (header == null || size <= 0 || !header.startsWith("bytes=") || header.indexOf(',') >= 0) return null;
        String spec = header.substring(6).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        try {
            String a = spec.substring(0, dash).trim();
            String b = spec.substring(dash + 1).trim();
            long start;
            long end = size - 1;
            if (a.isEmpty()) {
                if (b.isEmpty()) return null;
                start = Math.max(0, size - Long.parseLong(b));
            } else {
                start = Long.parseLong(a);
                if (!b.isEmpty()) end = Math.min(end, Long.parseLong(b));
            }
            return start <= end && start >= 0 ? new long[]{start, end} : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private void download(OutputStream out, String id, String token, String range) throws Exception {
        String connId = connFor(token);
        Pending session = connId != null ? sessionOf(connId) : null;
        if (session != null) session.busy.incrementAndGet();
        try {
            downloadNow(out, id, token, range);
        } finally {
            if (session != null) {
                session.busy.decrementAndGet();
                session.lastSeen = System.currentTimeMillis();
            }
        }
    }

    private void downloadNow(OutputStream out, String id, String token, String rangeHeader) throws Exception {
        if (!validToken(token)) {
            respond(out, 403, "text/plain", "Not admitted".getBytes(StandardCharsets.UTF_8));
            return;
        }
        Entry entry = null;
        for (Entry candidate : entries) {
            if (candidate.id.equals(id)) entry = candidate;
        }
        if (entry == null) {
            respond(out, 404, "text/plain", "File not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        ContentResolver resolver = app.getContentResolver();
        InputStream source;
        try {
            source = resolver.openInputStream(entry.uri);
        } catch (Exception e) {
            source = null;
        }
        if (source == null) {
            respond(out, 410, "text/plain", "The file is no longer available on the sender's phone".getBytes(StandardCharsets.UTF_8));
            return;
        }
        // A browser resuming an interrupted download asks for the rest with a Range header.
        long[] range = parseRange(rangeHeader, entry.size);
        try (InputStream in = new BufferedInputStream(source, 131072)) {
            long remaining = -1;
            StringBuilder head;
            if (range != null) {
                long toSkip = range[0];
                while (toSkip > 0) {
                    long skipped = in.skip(toSkip);
                    if (skipped <= 0) {
                        if (in.read() < 0) break;
                        skipped = 1;
                    }
                    toSkip -= skipped;
                }
                remaining = range[1] - range[0] + 1;
                head = new StringBuilder("HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\n");
                head.append("Content-Range: bytes ").append(range[0]).append('-').append(range[1]).append('/').append(entry.size).append("\r\n");
                head.append("Content-Length: ").append(remaining).append("\r\n");
            } else {
                head = new StringBuilder("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n");
                if (entry.size >= 0) head.append("Content-Length: ").append(entry.size).append("\r\n");
            }
            if (entry.size >= 0) head.append("Accept-Ranges: bytes\r\n");
            head.append("Content-Disposition: attachment; filename*=UTF-8''")
                    .append(URLEncoder.encode(entry.name, "UTF-8").replace("+", "%20"))
                    .append("\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
            out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            lastEvent = "Sending " + entry.name;
            byte[] chunk = new byte[131072];
            int n;
            if (remaining < 0) {
                while ((n = in.read(chunk)) != -1) out.write(chunk, 0, n);
            } else {
                while (remaining > 0 && (n = in.read(chunk, 0, (int) Math.min(chunk.length, remaining))) != -1) {
                    out.write(chunk, 0, n);
                    remaining -= n;
                }
            }
            out.flush();
            downloads++;
            lastEvent = entry.name + " downloaded";
        }
    }

    private static void respond(OutputStream out, int status, String type, byte[] body) throws IOException {
        String reason = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 403 ? "Forbidden" : status == 404 ? "Not Found"
                : status == 410 ? "Gone" : status == 411 ? "Length Required" : status == 429 ? "Too Many Requests" : "Error";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private static String queryParam(String query, String key) {
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(key)) {
                try {
                    return java.net.URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                } catch (Exception e) {
                    return "";
                }
            }
        }
        return "";
    }

    /** Describes a shared content URI as a downloadable entry (name and size as the provider reports them). */
    public static Entry describe(Context context, Uri uri, int index) {
        String name = null;
        long size = -1;
        try (android.database.Cursor cursor = context.getContentResolver().query(uri,
                new String[]{android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int n = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                int s = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE);
                if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n);
                if (s >= 0 && !cursor.isNull(s)) size = cursor.getLong(s);
            }
        } catch (Exception ignored) {
        }
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.trim().isEmpty()) name = "file";
        return new Entry(Integer.toString(index), name, size, uri);
    }
}
