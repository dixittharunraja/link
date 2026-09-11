package in.rodix.link;

// Payload transfer — Java port of desktop/src/core/payload-transfer.ts. Core mechanism used by
// any plugin that moves bytes rather than just JSON (share, link.clipboard.file). See that
// file's header comment for the full design rationale (ephemeral one-shot TLS server per
// transfer, port embedded in payloadTransferInfo, cert-pinned against the already-paired peer).

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

    /** Starts a one-shot TLS server that accepts exactly one connection, streams `data`, then closes. */
    public static UploadHandle startUpload(X509Certificate cert, PrivateKey key, byte[] data, UploadListener listener) throws Exception {
        SSLContext context = LinkTransport.buildSslContext(cert, key);
        SSLServerSocket serverSocket = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0);
        int port = serverSocket.getLocalPort();

        Thread acceptThread = new Thread(() -> {
            try {
                SSLSocket socket = (SSLSocket) serverSocket.accept();
                // Use a large write buffer (64 KB) so TLS records are packed efficiently
                // and the TCP window stays full — matching raw-socket throughput.
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

    /**
     * Connects to a peer's ephemeral upload server and downloads the full payload.
     * `expectedPeerFingerprint` must match the SHA-256 fingerprint already pinned for that
     * device — this is a fresh TLS connection, not automatically covered by the main control
     * channel's established trust.
     */
    public static byte[] downloadPayload(String host, int port, X509Certificate cert, PrivateKey key, String expectedPeerFingerprint) throws Exception {
        SSLContext context = LinkTransport.buildSslContext(cert, key);
        SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(host, port);

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
        // Use a 128 KB read buffer — small buffers cause repeated syscalls and starve the
        // TLS receive window, which is the main reason app throughput was ~3× below raw TCP.
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
