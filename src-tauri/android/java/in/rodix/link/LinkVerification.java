package in.rodix.link;

// Verification code shown to both sides of a guest session (Audio Relay, Remote Mic, Portal,
// input, joystick and Walkie Talkie guests), independent of the pairing state machine. Must match
// compute_verification_code() in core/pairing.rs: SHA-256 over the larger key DER first, then the
// smaller, then the salt, truncated to the first 4 bytes.

import java.security.MessageDigest;
import java.util.Locale;

public class LinkVerification {
    /** With an empty salt the code is fixed per device pair; a session value makes it per session. */
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
