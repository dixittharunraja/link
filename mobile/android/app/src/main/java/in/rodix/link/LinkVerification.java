package in.rodix.link;

// Standalone version of the same "eyeball-compare" hash LinkPairingHandler.verificationKey()
// already computes for normal pairing — pulled out here as its own small utility (not by
// refactoring LinkPairingHandler, which stays untouched) so Audio Relay's ephemeral guest-session
// PIN (LinkAudioSinkClient) can reuse the identical algorithm without depending on the pairing
// state machine or LinkTrustStore at all. Mirrors desktop's computeVerificationCode() in
// core/pairing.ts exactly (same byte ordering, same SHA-256-first-4-bytes truncation).

import java.security.MessageDigest;
import java.util.Locale;

public class LinkVerification {
    /** salt may be empty — pass a session-specific value if a fresh code per session is wanted
     *  rather than a fixed one per device-pair. */
    public static String computeCode(byte[] keyDerA, byte[] keyDerB, String salt) {
        byte[] a = keyDerA;
        byte[] b = keyDerB;
        if (compareBytes(a, b) < 0) {
            byte[] tmp = a;
            a = b;
            b = tmp;
        }

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(a);
            digest.update(b);
            digest.update(salt.getBytes());
            byte[] hash = digest.digest();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 4; i++) sb.append(String.format("%02x", hash[i]));
            return sb.toString().toUpperCase(Locale.ROOT);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static int compareBytes(byte[] a, byte[] b) {
        int len = Math.min(a.length, b.length);
        for (int i = 0; i < len; i++) {
            int cmp = Integer.compare(a[i] & 0xFF, b[i] & 0xFF);
            if (cmp != 0) return cmp;
        }
        return Integer.compare(a.length, b.length);
    }
}
