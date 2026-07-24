package in.rodix.link;

// Trusted Pool — owner-key engine. Java port of desktop/src/core/pool.ts (Wave 2 of the Trusted
// Pool transformation; see docs/backlog.txt). MUST stay byte-for-byte compatible with pool.ts:
// the signed-message layout (buildMembershipMessage) and the SPKI/PKCS8 + raw-Ed25519 key/sig
// encodings are chosen so a membership cert issued on one platform verifies on the other. Uses
// BouncyCastle's lightweight Ed25519 (java.security's own Ed25519 is only API 33+, minSdk is 23;
// BC is already a dependency and its provider is already registered by LinkTls).
//
// See pool.ts's header for the full model. This is the pure crypto/storage core — LinkDeviceManager
// wires it into the connection/pairing flow.

import android.content.Context;
import android.util.Base64;

import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator;
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.crypto.util.PrivateKeyFactory;
import org.bouncycastle.crypto.util.PrivateKeyInfoFactory;
import org.bouncycastle.crypto.util.PublicKeyFactory;
import org.bouncycastle.crypto.util.SubjectPublicKeyInfoFactory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.SecureRandom;

public class LinkPool {
    // Domain-separation prefixes — MUST equal the constants in pool.ts.
    private static final String MEMBERSHIP_MSG_PREFIX = "link-pool-membership-v1";
    private static final String REVOCATION_MSG_PREFIX = "link-pool-revocation-v1";
    private static final String FILE_NAME = "owner-key.json";
    private static final String REVOKED_FILE_NAME = "revoked-devices.json";

    // Pool control packet types (over an already-trusted connection) — mirror pool.ts.
    public static final String PACKET_TYPE_POOL_ENROLL = "link.pool.enroll";
    public static final String PACKET_TYPE_POOL_REVOKE = "link.pool.revoke";

    // ----- Owner keypair (portable SPKI/PKCS8 DER, base64 — matches pool.ts's OwnerKeyPair) -----
    public static class OwnerKeyPair {
        public final String publicKeyDerB64;
        public final String privateKeyDerB64;
        public OwnerKeyPair(String publicKeyDerB64, String privateKeyDerB64) {
            this.publicKeyDerB64 = publicKeyDerB64;
            this.privateKeyDerB64 = privateKeyDerB64;
        }
    }

    public static class MembershipCert {
        public final String deviceId;
        public final String certFingerprint;
        public final String ownerKeyFingerprint;
        public final long issuedAt;
        public final int epoch;
        public final String signature; // base64
        public MembershipCert(String deviceId, String certFingerprint, String ownerKeyFingerprint,
                              long issuedAt, int epoch, String signature) {
            this.deviceId = deviceId;
            this.certFingerprint = certFingerprint;
            this.ownerKeyFingerprint = ownerKeyFingerprint;
            this.issuedAt = issuedAt;
            this.epoch = epoch;
            this.signature = signature;
        }
        public JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("deviceId", deviceId);
            o.put("certFingerprint", certFingerprint);
            o.put("ownerKeyFingerprint", ownerKeyFingerprint);
            o.put("issuedAt", issuedAt);
            o.put("epoch", epoch);
            o.put("signature", signature);
            return o;
        }
        public static MembershipCert fromJson(JSONObject o) {
            if (o == null) return null;
            return new MembershipCert(
                    o.optString("deviceId"),
                    o.optString("certFingerprint"),
                    o.optString("ownerKeyFingerprint"),
                    o.optLong("issuedAt"),
                    o.optInt("epoch", 1),
                    o.optString("signature"));
        }
    }

    public static OwnerKeyPair generateOwnerKeyPair() {
        try {
            Ed25519KeyPairGenerator gen = new Ed25519KeyPairGenerator();
            gen.init(new Ed25519KeyGenerationParameters(new SecureRandom()));
            AsymmetricCipherKeyPair kp = gen.generateKeyPair();
            byte[] spkiDer = SubjectPublicKeyInfoFactory
                    .createSubjectPublicKeyInfo(kp.getPublic()).getEncoded();
            byte[] pkcs8Der = PrivateKeyInfoFactory
                    .createPrivateKeyInfo(kp.getPrivate()).getEncoded();
            return new OwnerKeyPair(b64(spkiDer), b64(pkcs8Der));
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate owner key", e);
        }
    }

    /** SHA-256 hex of the owner public key's SPKI DER — MUST match pool.ts's ownerKeyFingerprint(). */
    public static String ownerKeyFingerprint(String publicKeyDerB64) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(unb64(publicKeyDerB64));
            return hex(hash);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Exact bytes signed for a membership cert — MUST match pool.ts's buildMembershipMessage(). */
    public static byte[] buildMembershipMessage(String deviceId, String certFingerprint,
                                                String ownerKeyFp, long issuedAt, int epoch) {
        String joined = MEMBERSHIP_MSG_PREFIX + "\n" + deviceId + "\n" + certFingerprint + "\n"
                + ownerKeyFp + "\n" + issuedAt + "\n" + epoch;
        return joined.getBytes(StandardCharsets.UTF_8);
    }

    public static MembershipCert issueMembershipCert(OwnerKeyPair owner, String deviceId,
                                                     String certFingerprint, int epoch) {
        try {
            String ownerKeyFp = ownerKeyFingerprint(owner.publicKeyDerB64);
            long issuedAt = System.currentTimeMillis();
            byte[] message = buildMembershipMessage(deviceId, certFingerprint, ownerKeyFp, issuedAt, epoch);
            Ed25519PrivateKeyParameters priv =
                    (Ed25519PrivateKeyParameters) PrivateKeyFactory.createKey(unb64(owner.privateKeyDerB64));
            Ed25519Signer signer = new Ed25519Signer();
            signer.init(true, priv);
            signer.update(message, 0, message.length);
            String signature = b64(signer.generateSignature());
            return new MembershipCert(deviceId, certFingerprint, ownerKeyFp, issuedAt, epoch, signature);
        } catch (Exception e) {
            throw new RuntimeException("Failed to issue membership cert", e);
        }
    }

    public static boolean verifyMembershipCert(MembershipCert cert, String ownerPublicKeyDerB64,
                                               String expectedDeviceId, String expectedCertFingerprint) {
        try {
            if (cert == null) return false;
            if (!cert.deviceId.equals(expectedDeviceId)) return false;
            if (!cert.certFingerprint.equals(expectedCertFingerprint)) return false;
            if (!cert.ownerKeyFingerprint.equals(ownerKeyFingerprint(ownerPublicKeyDerB64))) return false;

            byte[] message = buildMembershipMessage(cert.deviceId, cert.certFingerprint,
                    cert.ownerKeyFingerprint, cert.issuedAt, cert.epoch);
            Ed25519PublicKeyParameters pub =
                    (Ed25519PublicKeyParameters) PublicKeyFactory.createKey(unb64(ownerPublicKeyDerB64));
            Ed25519Signer verifier = new Ed25519Signer();
            verifier.init(false, pub);
            verifier.update(message, 0, message.length);
            return verifier.verifySignature(unb64(cert.signature));
        } catch (Exception e) {
            return false;
        }
    }

    // ----- Revocation (item 9) — mirror pool.ts's Revocation / signRevocation / verifyRevocation -----
    public static class Revocation {
        public final String deviceId;
        public final long revokedAt;
        public final String signature; // base64
        public Revocation(String deviceId, long revokedAt, String signature) {
            this.deviceId = deviceId;
            this.revokedAt = revokedAt;
            this.signature = signature;
        }
        public JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("deviceId", deviceId);
            o.put("revokedAt", revokedAt);
            o.put("signature", signature);
            return o;
        }
        public static Revocation fromJson(JSONObject o) {
            if (o == null) return null;
            return new Revocation(o.optString("deviceId"), o.optLong("revokedAt"), o.optString("signature"));
        }
    }

    public static byte[] buildRevocationMessage(String deviceId, long revokedAt) {
        String joined = REVOCATION_MSG_PREFIX + "\n" + deviceId + "\n" + revokedAt;
        return joined.getBytes(StandardCharsets.UTF_8);
    }

    public static Revocation signRevocation(OwnerKeyPair owner, String deviceId) {
        try {
            long revokedAt = System.currentTimeMillis();
            byte[] message = buildRevocationMessage(deviceId, revokedAt);
            Ed25519PrivateKeyParameters priv =
                    (Ed25519PrivateKeyParameters) PrivateKeyFactory.createKey(unb64(owner.privateKeyDerB64));
            Ed25519Signer signer = new Ed25519Signer();
            signer.init(true, priv);
            signer.update(message, 0, message.length);
            return new Revocation(deviceId, revokedAt, b64(signer.generateSignature()));
        } catch (Exception e) {
            throw new RuntimeException("Failed to sign revocation", e);
        }
    }

    public static boolean verifyRevocation(Revocation rev, String ownerPublicKeyDerB64) {
        try {
            byte[] message = buildRevocationMessage(rev.deviceId, rev.revokedAt);
            Ed25519PublicKeyParameters pub =
                    (Ed25519PublicKeyParameters) PublicKeyFactory.createKey(unb64(ownerPublicKeyDerB64));
            Ed25519Signer verifier = new Ed25519Signer();
            verifier.init(false, pub);
            verifier.update(message, 0, message.length);
            return verifier.verifySignature(unb64(rev.signature));
        } catch (Exception e) {
            return false;
        }
    }

    // ----- Storage: owner-key.json holds {owner, membership}; same plaintext posture as the TLS key -----
    private static OwnerKeyPair cachedOwner = null;
    private static MembershipCert cachedMembership = null;
    private static boolean loaded = false;

    private static File file(Context context) {
        return new File(context.getFilesDir(), FILE_NAME);
    }

    private static synchronized void ensureLoaded(Context context) {
        if (loaded) return;
        loaded = true;
        try {
            File f = file(context);
            if (f.exists()) {
                String content = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
                JSONObject o = new JSONObject(content);
                JSONObject owner = o.optJSONObject("owner");
                JSONObject membership = o.optJSONObject("membership");
                if (owner != null && membership != null) {
                    String pub = owner.optString("publicKeyDerB64", null);
                    String priv = owner.optString("privateKeyDerB64", null);
                    if (pub != null && priv != null) {
                        cachedOwner = new OwnerKeyPair(pub, priv);
                        cachedMembership = MembershipCert.fromJson(membership);
                    }
                }
            }
        } catch (Exception ignored) {
            cachedOwner = null;
            cachedMembership = null;
        }
    }

    public static synchronized boolean hasKey(Context context) {
        ensureLoaded(context);
        return cachedOwner != null && cachedMembership != null;
    }

    public static synchronized OwnerKeyPair getOwner(Context context) {
        ensureLoaded(context);
        return cachedOwner;
    }

    public static synchronized MembershipCert getMembership(Context context) {
        ensureLoaded(context);
        return cachedMembership;
    }

    public static synchronized String fingerprint(Context context) {
        ensureLoaded(context);
        return cachedOwner != null ? ownerKeyFingerprint(cachedOwner.publicKeyDerB64) : null;
    }

    public static synchronized void setCredentials(Context context, OwnerKeyPair owner, MembershipCert membership) {
        ensureLoaded(context);
        cachedOwner = owner;
        cachedMembership = membership;
        try {
            JSONObject ownerJson = new JSONObject();
            ownerJson.put("publicKeyDerB64", owner.publicKeyDerB64);
            ownerJson.put("privateKeyDerB64", owner.privateKeyDerB64);
            JSONObject o = new JSONObject();
            o.put("owner", ownerJson);
            o.put("membership", membership.toJson());
            Files.write(file(context).toPath(), o.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            android.util.Log.e("LinkPool", "Failed to persist owner credentials", e);
        }
    }

    /** Leaving the pool: wipe our copy of the owner key + membership so we're no longer a member. */
    public static synchronized void clear(Context context) {
        cachedOwner = null;
        cachedMembership = null;
        loaded = true;
        try {
            File f = file(context);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {}
    }

    // ----- Revocation store (revoked-devices.json) -----
    public static synchronized boolean isRevoked(Context context, String deviceId) {
        return loadRevoked(context).containsKey(deviceId);
    }

    /** Records a revocation (idempotent). Returns true if it was new (caller should gossip it). */
    public static synchronized boolean addRevocation(Context context, Revocation rev) {
        java.util.Map<String, Revocation> map = loadRevoked(context);
        if (map.containsKey(rev.deviceId)) return false;
        map.put(rev.deviceId, rev);
        try {
            JSONArray arr = new JSONArray();
            for (Revocation r : map.values()) arr.put(r.toJson());
            Files.write(new File(context.getFilesDir(), REVOKED_FILE_NAME).toPath(),
                    arr.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            android.util.Log.e("LinkPool", "Failed to persist revocation", e);
        }
        return true;
    }

    private static java.util.Map<String, Revocation> revokedCache = null;
    private static synchronized java.util.Map<String, Revocation> loadRevoked(Context context) {
        if (revokedCache != null) return revokedCache;
        revokedCache = new java.util.HashMap<>();
        try {
            File f = new File(context.getFilesDir(), REVOKED_FILE_NAME);
            if (f.exists()) {
                String content = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
                JSONArray arr = new JSONArray(content);
                for (int i = 0; i < arr.length(); i++) {
                    Revocation r = Revocation.fromJson(arr.optJSONObject(i));
                    if (r != null) revokedCache.put(r.deviceId, r);
                }
            }
        } catch (Exception ignored) {}
        return revokedCache;
    }

    // ----- helpers (NO_WRAP base64 to match Node's standard, unwrapped base64) -----
    private static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }
    private static byte[] unb64(String s) {
        return Base64.decode(s, Base64.NO_WRAP);
    }
    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
