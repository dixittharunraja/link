package in.rodix.link;

// Payload transfer for plugins that move bytes rather than JSON (share, link.clipboard.file,
// speed test). The sender opens a one-shot TLS server and announces its port in
// payloadTransferInfo; the receiver connects and checks the server certificate against the
// paired device's pinned fingerprint, and the sender requires a client certificate and serves
// only the pinned certificate of the device the transfer is for.

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;

public class LinkPayloadTransfer {
    public interface UploadListener {
        void onComplete();
        void onError(Exception e);
    }

    public static class UploadHandle {
        public final int port;
        private final SSLServerSocket serverSocket;

        UploadHandle(int port, SSLServerSocket serverSocket) {
            this.port = port;
            this.serverSocket = serverSocket;
        }

        public void cancel() {
            try {
                serverSocket.close();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Starts a one-shot TLS server that streams `data` to the first client presenting the
     * certificate pinned as expectedPeerFingerprint, then closes. Other clients are dropped and
     * the server keeps waiting until cancelled.
     */
    public static UploadHandle startUpload(X509Certificate cert, PrivateKey key, String expectedPeerFingerprint,
                                           byte[] data, UploadListener listener) throws Exception {
        if (expectedPeerFingerprint == null) throw new Exception("No pinned certificate for the payload receiver");
        SSLContext context = LinkTransport.buildSslContext(cert, key);
        SSLServerSocket serverSocket = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0);
        serverSocket.setNeedClientAuth(true);
        int port = serverSocket.getLocalPort();

        Thread acceptThread = new Thread(() -> {
            try {
                SSLSocket socket;
                while (true) {
                    socket = (SSLSocket) serverSocket.accept();
                    if (isExpectedPeer(socket, expectedPeerFingerprint)) break;
                    try { socket.close(); } catch (Exception ignored) { }
                }
                // A 64KB buffer packs TLS records efficiently and keeps the TCP window full.
                OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 65536);
                int offset = 0;
                final int CHUNK = 65536;
                while (offset < data.length) {
                    int len = Math.min(CHUNK, data.length - offset);
                    out.write(data, offset, len);
                    offset += len;
                }
                out.flush();
                socket.close();
                serverSocket.close();
                listener.onComplete();
            } catch (Exception e) {
                listener.onError(e);
            }
        }, "link-payload-upload");
        acceptThread.setDaemon(true);
        acceptThread.start();

        return new UploadHandle(port, serverSocket);
    }

    /** One file's worth of payload bytes for the streaming upload; open() is called once, in order. */
    public interface StreamSource {
        InputStream open() throws java.io.IOException;
        long size();
    }

    public interface ProgressListener {
        void onProgress(long bytesSent);
    }

    public interface StreamHandler {
        void handle(InputStream in) throws Exception;
    }

    /**
     * Streaming variant of startUpload: sends each source's exact byte count, back to back, to the
     * first client presenting the pinned certificate. Nothing is held in memory. The server gives
     * up (onError) if the right peer has not connected within acceptTimeoutMs.
     */
    public static UploadHandle startUploadStreams(X509Certificate cert, PrivateKey key, String expectedPeerFingerprint,
                                                  java.util.List<StreamSource> sources, long acceptTimeoutMs,
                                                  ProgressListener progress, UploadListener listener) throws Exception {
        if (expectedPeerFingerprint == null) throw new Exception("No pinned certificate for the payload receiver");
        SSLContext context = LinkTransport.buildSslContext(cert, key);
        SSLServerSocket serverSocket = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0);
        serverSocket.setNeedClientAuth(true);
        int port = serverSocket.getLocalPort();

        Thread thread = new Thread(() -> {
            try {
                long deadline = System.currentTimeMillis() + acceptTimeoutMs;
                SSLSocket socket;
                while (true) {
                    long remaining = deadline - System.currentTimeMillis();
                    if (remaining <= 0) throw new java.net.SocketTimeoutException("Receiver never connected");
                    serverSocket.setSoTimeout((int) Math.min(remaining, Integer.MAX_VALUE));
                    socket = (SSLSocket) serverSocket.accept();
                    if (isExpectedPeer(socket, expectedPeerFingerprint)) break;
                    try { socket.close(); } catch (Exception ignored) { }
                }
                OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 65536);
                byte[] buffer = new byte[65536];
                long sent = 0;
                for (StreamSource source : sources) {
                    long remaining = source.size();
                    InputStream in = source.open();
                    try {
                        while (remaining > 0) {
                            int n = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                            if (n < 0) throw new java.io.IOException("A file ended before its announced size");
                            out.write(buffer, 0, n);
                            remaining -= n;
                            sent += n;
                            if (progress != null) progress.onProgress(sent);
                        }
                    } finally {
                        try { in.close(); } catch (Exception ignored) { }
                    }
                }
                out.flush();
                socket.close();
                listener.onComplete();
            } catch (Exception e) {
                listener.onError(e);
            } finally {
                try { serverSocket.close(); } catch (Exception ignored) { }
            }
        }, "link-payload-upload-stream");
        thread.setDaemon(true);
        thread.start();

        return new UploadHandle(port, serverSocket);
    }

    /**
     * Streaming variant of downloadPayload: connects, verifies the pinned certificate and hands the
     * socket's input stream to the handler instead of buffering everything.
     */
    public static void downloadStream(String host, int port, X509Certificate cert, PrivateKey key,
                                      String expectedPeerFingerprint, StreamHandler handler) throws Exception {
        SSLContext context = LinkTransport.buildSslContext(cert, key);
        // Connect with a deadline: an unreachable or firewalled host would otherwise hang the
        // transfer until the OS gives up, which can take minutes.
        SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket();
        try {
            socket.connect(new java.net.InetSocketAddress(host, port), 10000);
            socket.setSoTimeout(60000);
            java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
            if (chain.length == 0
                    || !expectedPeerFingerprint.equals(LinkTls.fingerprint((X509Certificate) chain[0]))) {
                throw new Exception("Payload connection certificate does not match pinned device — refusing transfer");
            }
            handler.handle(new BufferedInputStream(socket.getInputStream(), 131072));
        } finally {
            try { socket.close(); } catch (Exception ignored) { }
        }
    }

    // The handshake gets a read timeout so a client that stalls it cannot block the real receiver.
    private static boolean isExpectedPeer(SSLSocket socket, String expectedPeerFingerprint) {
        try {
            socket.setSoTimeout(10000);
            socket.startHandshake();
            socket.setSoTimeout(0);
            java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
            return chain.length > 0
                    && expectedPeerFingerprint.equals(LinkTls.fingerprint((X509Certificate) chain[0]));
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Downloads the full payload from a peer's upload server. The server certificate must match
     * expectedPeerFingerprint, since this connection is separate from the trusted main channel.
     */
    public static byte[] downloadPayload(String host, int port, X509Certificate cert, PrivateKey key, String expectedPeerFingerprint) throws Exception {
        SSLContext context = LinkTransport.buildSslContext(cert, key);
        SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket();
        try {
            socket.connect(new java.net.InetSocketAddress(host, port), 10000);
            socket.setSoTimeout(60000);
        } catch (Exception e) {
            socket.close();
            throw e;
        }

        java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
        if (chain.length == 0) {
            socket.close();
            throw new Exception("Payload connection presented no certificate");
        }
        String actualFingerprint = LinkTls.fingerprint((X509Certificate) chain[0]);
        if (!actualFingerprint.equals(expectedPeerFingerprint)) {
            socket.close();
            throw new Exception("Payload connection certificate does not match pinned device — refusing transfer");
        }

        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        // A 128KB read buffer; small buffers cost syscalls and throttle TLS throughput.
        InputStream in = new BufferedInputStream(socket.getInputStream(), 131072);
        byte[] chunk = new byte[131072];
        int n;
        while ((n = in.read(chunk)) != -1) {
            buffer.write(chunk, 0, n);
        }
        socket.close();
        return buffer.toByteArray();
    }
}
