package in.rodix.link.connection;

import android.content.Context;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

import javax.net.ssl.KeyManager;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.io.File;
import java.io.FileOutputStream;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Security;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

public class LinkCryptoProvider {
    static {
        Security.addProvider(new org.bouncycastle.jce.provider.BouncyCastleProvider());
    }

    public static class TlsIdentity {
        public final X509Certificate certificate;
        public final PrivateKey privateKey;
        public final String fingerprint;

        public TlsIdentity(X509Certificate certificate, PrivateKey privateKey, String fingerprint) {
            this.certificate = certificate;
            this.privateKey = privateKey;
            this.fingerprint = fingerprint;
        }
    }

    private static File certFile(Context context) {
        return new File(context.getFilesDir(), "link-config/cert.der");
    }

    private static File keyFile(Context context) {
        return new File(context.getFilesDir(), "link-config/key.der");
    }

    public static TlsIdentity loadOrCreateIdentity(Context context, String deviceId) {
        File certF = certFile(context);
        File keyF = keyFile(context);

        try {
            if (certF.exists() && keyF.exists()) {
                CertificateFactory cf = CertificateFactory.getInstance("X.509");
                X509Certificate cert = (X509Certificate) cf.generateCertificate(
                        new java.io.FileInputStream(certF));
                byte[] keyBytes = java.nio.file.Files.readAllBytes(keyF.toPath());
                java.security.spec.PKCS8EncodedKeySpec spec = new java.security.spec.PKCS8EncodedKeySpec(keyBytes);
                PrivateKey key = java.security.KeyFactory.getInstance("RSA").generatePrivate(spec);
                String fp = computeFingerprint(cert);
                return new TlsIdentity(cert, key, fp);
            }
        } catch (Exception ignored) {
            // Corrupt or unreadable - fall through and regenerate
        }

        try {
            TlsIdentity generated = generate(deviceId);
            certF.getParentFile().mkdirs();
            try (FileOutputStream out = new FileOutputStream(certF)) {
                out.write(generated.certificate.getEncoded());
            }
            try (FileOutputStream out = new FileOutputStream(keyF)) {
                out.write(generated.privateKey.getEncoded());
            }
            return generated;
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate TLS identity", e);
        }
    }

    private static TlsIdentity generate(String deviceId) throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(2048);
        KeyPair keyPair = kpg.generateKeyPair();

        long now = System.currentTimeMillis();
        Date notBefore = new Date(now);
        Date notAfter = new Date(now + TimeUnit.DAYS.toMillis(3650));

        X500Name subject = new X500Name("CN=" + deviceId);
        X509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                subject,
                BigInteger.valueOf(now),
                notBefore,
                notAfter,
                subject,
                keyPair.getPublic()
        );

        ContentSigner signer = new JcaContentSignerBuilder("SHA256withRSA")
                .build(keyPair.getPrivate());

        X509Certificate cert = new JcaX509CertificateConverter()
                .getCertificate(builder.build(signer));

        String fp = computeFingerprint(cert);
        return new TlsIdentity(cert, keyPair.getPrivate(), fp);
    }

    public static String computeFingerprint(X509Certificate cert) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] hash = md.digest(cert.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
            sb.append(String.format(Locale.US, "%02x", b));
        }
        return sb.toString();
    }

    public static SSLContext createSSLContext(TlsIdentity identity) throws Exception {
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        ks.setKeyEntry("link-identity", identity.privateKey, "password".toCharArray(),
                new java.security.cert.Certificate[]{identity.certificate});

        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, "password".toCharArray());
        KeyManager[] keyManagers = kmf.getKeyManagers();

        TrustManager[] trustManagers = new TrustManager[]{
                new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {}

                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {}

                    @Override
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                }
        };

        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(keyManagers, trustManagers, new java.security.SecureRandom());
        return sslContext;
    }

    public static void configureTlsSocket(SSLSocket socket) {
        String[] supported = socket.getSupportedProtocols();
        java.util.List<String> enabled = new java.util.ArrayList<>();
        for (String p : supported) {
            if ("TLSv1.3".equals(p) || "TLSv1.2".equals(p)) {
                enabled.add(p);
            }
        }
        if (!enabled.isEmpty()) {
            socket.setEnabledProtocols(enabled.toArray(new String[0]));
        }
    }

    public static void configureServerSocket(SSLServerSocket serverSocket) {
        String[] supported = serverSocket.getSupportedProtocols();
        java.util.List<String> enabled = new java.util.ArrayList<>();
        for (String p : supported) {
            if ("TLSv1.3".equals(p) || "TLSv1.2".equals(p)) {
                enabled.add(p);
            }
        }
        if (!enabled.isEmpty()) {
            serverSocket.setEnabledProtocols(enabled.toArray(new String[0]));
        }
        serverSocket.setNeedClientAuth(true);
    }
}
