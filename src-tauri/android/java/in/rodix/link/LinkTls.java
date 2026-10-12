package in.rodix.link;

// TLS identity — self-signed certificate generated once per device, reused forever.
// Java port of desktop/src/core/tls.ts, using Bouncy Castle for cert generation since Android's
// java.security stack has no built-in certificate builder (only parsing) — same library
// kdeconnect-android itself uses (SslHelper.kt).

import android.content.Context;

import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

import java.io.File;
import java.io.FileOutputStream;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Security;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Date;
import java.util.concurrent.TimeUnit;

public class LinkTls {
    static {
        Security.addProvider(new org.bouncycastle.jce.provider.BouncyCastleProvider());
    }

    public static class TlsIdentity {
        public final X509Certificate certificate;
        public final PrivateKey privateKey;

        TlsIdentity(X509Certificate certificate, PrivateKey privateKey) {
            this.certificate = certificate;
            this.privateKey = privateKey;
        }
    }

    private static File certFile(Context context) {
        return new File(context.getFilesDir(), "link-config/cert.der");
    }

    private static File keyFile(Context context) {
        return new File(context.getFilesDir(), "link-config/key.der");
    }

    public static TlsIdentity loadOrCreate(Context context, String deviceId) {
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
                return new TlsIdentity(cert, key);
            }
        } catch (Exception e) {
            // Corrupt/unreadable — fall through and regenerate.
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
                keyPair.getPublic());

        ContentSigner signer = new JcaContentSignerBuilder("SHA256withRSA").build(keyPair.getPrivate());
        X509Certificate cert = new JcaX509CertificateConverter().getCertificate(builder.build(signer));

        return new TlsIdentity(cert, keyPair.getPrivate());
    }

    /** SHA-256 fingerprint of a certificate, as a hex string — matches desktop's certFingerprint(). */
    public static String fingerprint(X509Certificate cert) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(cert.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
