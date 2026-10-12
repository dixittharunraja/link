package in.rodix.link;

// Local media-streaming HTTP server — the Android counterpart of desktop's LinkFsMountService
// HTTP layer (see fs-mount-service.ts). Its whole job is to turn an HTTP Range request into the
// FS protocol's existing read(path, offset, length), so a video player can seek through a file
// that physically lives on a peer device without downloading it first.
//
// Why a server at all, rather than handing the player a content:// Uri: playback is delegated to
// whatever app the user has registered for the MIME type (VLC, MX Player, the gallery). That app
// is a SEPARATE process, so it can't call back into this one — but it can make HTTP requests to
// loopback. An http://127.0.0.1 URL is the one handle every player already knows how to consume,
// and it gets seeking for free because Range is part of HTTP.
//
// SECURITY: on Android, 127.0.0.1 is reachable by every other app on the device, not just by this
// process — loopback binding is NOT an isolation boundary here. Every request therefore has to
// carry the random token minted at start(), otherwise any installed app could read the peer's
// files through this port for as long as it is open. Desktop's equivalent carries the same token
// for the same reason (a stream URL there is handed to the system browser/player too).
//
// Deliberately minimal HTTP: GET and HEAD only, one request per connection (Connection: close),
// no keep-alive parsing. Players reconnect per seek anyway, and every byte of protocol surface
// here is reachable by untrusted local apps, so there is real value in it staying tiny.

import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class LinkFsStreamServer {
    private static final String TAG = "LinkFsStreamServer";

    // Bigger than the 256KB used for plain file copies. Each read is a full request/response
    // round-trip over the peer link, and on the packet-relay path the bytes come back as a JSON
    // number array (~4x inflation), so smaller chunks would cap throughput well below the bitrate
    // of an ordinary video. This is the main throughput lever if playback ever stutters.
    private static final int CHUNK_SIZE = 512 * 1024;

    /** Supplies the actual bytes. Implemented by LinkPlugin against the FS protocol it already
     *  speaks — this class deliberately knows nothing about packets, devices, or permissions. */
    public interface Source {
        long size(String deviceId, String path) throws Exception;
        byte[] read(String deviceId, String path, long offset, int length) throws Exception;
    }

    private final Source source;
    private ServerSocket serverSocket;
    private ExecutorService pool;
    private Thread acceptThread;
    private volatile boolean running = false;
    private int port = 0;
    private String token;

    public LinkFsStreamServer(Source source) {
        this.source = source;
    }

    public int getPort() { return port; }
    public String getToken() { return token; }
    public boolean isRunning() { return running; }

    public synchronized void start() throws IOException {
        if (running) return;
        byte[] rnd = new byte[24];
        new SecureRandom().nextBytes(rnd);
        StringBuilder sb = new StringBuilder();
        for (byte b : rnd) sb.append(String.format("%02x", b));
        token = sb.toString();

        serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        port = serverSocket.getLocalPort();
        running = true;
        // A seeking player opens several overlapping connections; a couple of stale ones can sit
        // half-closed while it repositions, so this needs more than one or two threads to avoid
        // the accept loop stalling behind them.
        pool = Executors.newFixedThreadPool(8);

        acceptThread = new Thread(() -> {
            while (running) {
                try {
                    Socket client = serverSocket.accept();
                    pool.submit(() -> handleConnection(client));
                } catch (IOException e) {
                    if (running) Log.w(TAG, "accept failed", e);
                }
            }
        }, "link-fs-stream-accept");
        acceptThread.start();
        Log.i(TAG, "Media stream server listening on http://127.0.0.1:" + port);
    }

    public synchronized void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (Exception ignored) {}
        serverSocket = null;
        if (pool != null) { pool.shutdownNow(); pool = null; }
        acceptThread = null;
        port = 0;
        token = null;
    }

    /** Builds the URL a player should be pointed at. The filename is carried in the path (players
     *  routinely guess a container from the extension, and some refuse a URL without one) while
     *  the real remote path travels as an opaque encoded query param — which avoids having to
     *  reproduce desktop's root-name path translation on this side. */
    public String buildUrl(String deviceId, String remotePath) {
        String name = remotePath.substring(Math.max(remotePath.lastIndexOf('/'), remotePath.lastIndexOf('\\')) + 1);
        if (name.isEmpty()) name = "media";
        return "http://127.0.0.1:" + port + "/media/" + urlEncode(name)
            + "?token=" + token
            + "&device=" + urlEncode(deviceId)
            + "&path=" + urlEncode(remotePath);
    }

    private static String urlEncode(String s) {
        try {
            // URLEncoder is form-encoding, so it emits '+' for space — wrong inside a URL path
            // segment, where a literal '+' is a plus sign and a space must be %20.
            return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return s;
        }
    }

    private void handleConnection(Socket client) {
        try (Socket sock = client) {
            sock.setSoTimeout(30000);
            InputStream in = sock.getInputStream();
            OutputStream rawOut = sock.getOutputStream();
            BufferedOutputStream out = new BufferedOutputStream(rawOut, 64 * 1024);

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) { sendSimple(out, 400, "Bad Request"); return; }
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];

            String rangeHeader = null;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                if (line.substring(0, colon).trim().equalsIgnoreCase("Range")) {
                    rangeHeader = line.substring(colon + 1).trim();
                }
            }

            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                sendSimple(out, 405, "Method Not Allowed");
                return;
            }

            Map<String, String> q = parseQuery(target);
            String reqToken = q.get("token");
            if (token == null || reqToken == null || !constantTimeEquals(token, reqToken)) {
                sendSimple(out, 403, "Forbidden");
                return;
            }
            String deviceId = q.get("device");
            String path = q.get("path");
            if (deviceId == null || path == null) { sendSimple(out, 400, "Bad Request"); return; }

            long total;
            try {
                total = source.size(deviceId, path);
            } catch (Exception e) {
                sendSimple(out, 404, "Not Found");
                return;
            }

            long start = 0;
            long end = total - 1;
            boolean partial = false;
            if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                partial = true;
                String spec = rangeHeader.substring(6);
                int dash = spec.indexOf('-');
                if (dash < 0) { sendSimple(out, 416, "Range Not Satisfiable"); return; }
                String s = spec.substring(0, dash).trim();
                String e = spec.substring(dash + 1).trim();
                try {
                    if (s.isEmpty()) {
                        // Suffix form "bytes=-N" — the LAST n bytes. Players use this to read a
                        // trailing index (MP4 moov atom at the end of a non-faststart file), so
                        // getting it wrong makes exactly those files refuse to play.
                        long n = Long.parseLong(e);
                        start = Math.max(0, total - n);
                    } else {
                        start = Long.parseLong(s);
                        if (!e.isEmpty()) end = Long.parseLong(e);
                    }
                } catch (NumberFormatException nfe) {
                    sendSimple(out, 416, "Range Not Satisfiable");
                    return;
                }
                if (end > total - 1) end = total - 1;
                if (start > end || start < 0) {
                    StringBuilder h = new StringBuilder();
                    h.append("HTTP/1.1 416 Range Not Satisfiable\r\n");
                    h.append("Content-Range: bytes */").append(total).append("\r\n");
                    h.append("Connection: close\r\n\r\n");
                    out.write(h.toString().getBytes("UTF-8"));
                    out.flush();
                    return;
                }
            }

            long length = total == 0 ? 0 : (end - start + 1);
            StringBuilder head = new StringBuilder();
            head.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            head.append("Content-Type: ").append(mimeFor(path)).append("\r\n");
            head.append("Content-Length: ").append(length).append("\r\n");
            head.append("Accept-Ranges: bytes\r\n");
            if (partial) {
                head.append("Content-Range: bytes ").append(start).append('-').append(end)
                    .append('/').append(total).append("\r\n");
            }
            head.append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes("UTF-8"));

            if ("HEAD".equals(method)) { out.flush(); return; }

            long pos = start;
            long remaining = length;
            while (remaining > 0 && running) {
                int want = (int) Math.min(CHUNK_SIZE, remaining);
                byte[] chunk;
                try {
                    chunk = source.read(deviceId, path, pos, want);
                } catch (Exception e) {
                    Log.w(TAG, "read failed mid-stream", e);
                    break;
                }
                if (chunk == null || chunk.length == 0) break;
                out.write(chunk);
                out.flush();
                pos += chunk.length;
                remaining -= chunk.length;
            }
            out.flush();
        } catch (IOException e) {
            // Routine: the player closes the connection whenever the user seeks or stops.
        } catch (Exception e) {
            Log.w(TAG, "stream connection failed", e);
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
        return diff == 0;
    }

    private static void sendSimple(OutputStream out, int code, String reason) throws IOException {
        String body = reason;
        String resp = "HTTP/1.1 " + code + " " + reason + "\r\n"
            + "Content-Type: text/plain\r\n"
            + "Content-Length: " + body.getBytes("UTF-8").length + "\r\n"
            + "Connection: close\r\n\r\n" + body;
        out.write(resp.getBytes("UTF-8"));
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
            // Guards against a hostile local app streaming an unbounded "header" line at us.
            if (buf.size() > 8192) throw new IOException("header line too long");
        }
        if (c == -1 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), "UTF-8");
    }

    private static Map<String, String> parseQuery(String target) {
        Map<String, String> map = new HashMap<>();
        int q = target.indexOf('?');
        if (q < 0) return map;
        for (String pair : target.substring(q + 1).split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            try {
                map.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"),
                        URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
            } catch (Exception ignored) {}
        }
        return map;
    }

    // Kept in step with desktop's MIME_TYPES table in fs-mount-service.ts — the two describe the
    // same feature from each end, so a format added to one but not the other silently degrades to
    // application/octet-stream on that platform (a download instead of playback, or ACTION_VIEW
    // finding no handler at all).
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        // Video
        MIME.put("mp4", "video/mp4");
        MIME.put("m4v", "video/mp4");
        MIME.put("mkv", "video/x-matroska");
        MIME.put("webm", "video/webm");
        MIME.put("mov", "video/quicktime");
        MIME.put("avi", "video/x-msvideo");
        MIME.put("wmv", "video/x-ms-wmv");
        MIME.put("flv", "video/x-flv");
        MIME.put("mpg", "video/mpeg");
        MIME.put("mpeg", "video/mpeg");
        MIME.put("3gp", "video/3gpp");
        MIME.put("ts", "video/mp2t");
        MIME.put("m2ts", "video/mp2t");
        MIME.put("mts", "video/mp2t");
        MIME.put("ogv", "video/ogg");
        MIME.put("vob", "video/mpeg");
        MIME.put("asf", "video/x-ms-asf");
        MIME.put("f4v", "video/x-f4v");
        MIME.put("divx", "video/x-msvideo");
        // Images
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("png", "image/png");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("bmp", "image/bmp");
        MIME.put("ico", "image/x-icon");
        MIME.put("svg", "image/svg+xml");
        MIME.put("heic", "image/heic");
        MIME.put("heif", "image/heif");
        MIME.put("avif", "image/avif");
        MIME.put("tiff", "image/tiff");
        MIME.put("tif", "image/tiff");
        // Camera RAW
        MIME.put("dng", "image/x-adobe-dng");
        MIME.put("cr2", "image/x-canon-cr2");
        MIME.put("nef", "image/x-nikon-nef");
        MIME.put("arw", "image/x-sony-arw");
        MIME.put("orf", "image/x-olympus-orf");
        MIME.put("raf", "image/x-fuji-raf");
        // Audio
        MIME.put("mp3", "audio/mpeg");
        MIME.put("m4a", "audio/mp4");
        MIME.put("m4b", "audio/mp4");
        MIME.put("aac", "audio/aac");
        MIME.put("flac", "audio/flac");
        MIME.put("ogg", "audio/ogg");
        MIME.put("opus", "audio/opus");
        MIME.put("wav", "audio/wav");
        MIME.put("wma", "audio/x-ms-wma");
        MIME.put("aiff", "audio/aiff");
        MIME.put("aif", "audio/aiff");
        MIME.put("mid", "audio/midi");
        MIME.put("midi", "audio/midi");
        MIME.put("ape", "audio/x-ape");
        MIME.put("wv", "audio/x-wavpack");
        MIME.put("amr", "audio/amr");
        MIME.put("3ga", "audio/3gpp");
        // Documents — resolved for ACTION_VIEW on the download-to-cache path, not streamed.
        MIME.put("pdf", "application/pdf");
        MIME.put("epub", "application/epub+zip");
        MIME.put("rtf", "application/rtf");
        MIME.put("doc", "application/msword");
        MIME.put("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        MIME.put("xls", "application/vnd.ms-excel");
        MIME.put("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        MIME.put("ppt", "application/vnd.ms-powerpoint");
        MIME.put("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        MIME.put("odt", "application/vnd.oasis.opendocument.text");
        MIME.put("ods", "application/vnd.oasis.opendocument.spreadsheet");
        MIME.put("odp", "application/vnd.oasis.opendocument.presentation");
        MIME.put("txt", "text/plain");
        MIME.put("md", "text/markdown");
        MIME.put("csv", "text/csv");
    }

    /** Accepts either a bare path or a full stream URL — the query is stripped first, since a
     *  stream URL carries the remote path (dots and all) as a query param, and matching on the
     *  last dot in the whole string would read the extension out of the wrong place. */
    public static String mimeFor(String pathOrUrl) {
        String path = pathOrUrl;
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        int dot = path.lastIndexOf('.');
        if (dot >= 0 && dot < path.length() - 1) {
            String ext = path.substring(dot + 1).toLowerCase(Locale.US);
            String m = MIME.get(ext);
            if (m != null) return m;
        }
        return "application/octet-stream";
    }
}
