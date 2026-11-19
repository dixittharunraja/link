package in.rodix.link;

// Who may ask this device to pair, and the one-time token in its QR code.
// Mirrors core/pairing_window.rs on the desktop; keep the two in step.
//
// Pairing is the only door into a trusted relationship, so there are two ways in, and both end at an
// Accept button on this device:
//   - A visible device (Device Visibility on) accepts ordinary requests at any time, verified by
//     comparing the code on both screens.
//   - A hidden device accepts only a request that carries the one-time token from its QR. The QR
//     carries this device's key fingerprint (so the scanner can tell it reached the right device, with
//     no code to compare) and the token (so a photo of an old QR, or a second device racing the first,
//     gets nothing). The token is valid only while the Add Device screen that shows the QR is open.

import java.util.UUID;

public class LinkPairingWindow {
    public enum Admission {
        /** Not accepting this request: answer no, show nothing. */
        CLOSED,
        /** No token, from a visible device: an ordinary request, verified by comparing the code on both screens. */
        MANUAL,
        /** A valid one-time token: the scanner already verified this device, ask the user to approve. */
        QR,
        /** The token was already used, so someone else got there first (or replayed it). */
        CONFLICT,
        /** A token this device did not issue, or an expired one. */
        BAD_TOKEN
    }

    static final long TOKEN_LIFETIME_MS = 120_000;
    /** A safety cap: the window closes by itself if the screen that opened it never reports closing. */
    static final long WINDOW_LIFETIME_MS = 600_000;

    private long openUntil = 0;
    private String token;
    private long tokenExpires = 0;
    private String lastUsed;

    /** Opens the window and returns a fresh token for the QR. */
    public synchronized String open(long now) {
        openUntil = now + WINDOW_LIFETIME_MS;
        return mint(now);
    }

    /** A new token for the QR (the last was used or is about to expire); null while closed. */
    public synchronized String refresh(long now) {
        return isOpen(now) ? mint(now) : null;
    }

    public synchronized void close() {
        openUntil = 0;
        token = null;
    }

    public synchronized boolean isOpen(long now) {
        return now < openUntil;
    }

    private String mint(long now) {
        token = UUID.randomUUID().toString().replace("-", "");
        tokenExpires = now + TOKEN_LIFETIME_MS;
        return token;
    }

    /** Judges a pair request; visible is the Device Visibility setting. A valid token is used up by this call. */
    public synchronized Admission admit(String presented, boolean visible, long now) {
        if (presented == null || presented.isEmpty()) return visible ? Admission.MANUAL : Admission.CLOSED;
        // A token only exists while the QR is on screen.
        if (!isOpen(now)) return Admission.CLOSED;
        if (token != null && token.equals(presented) && now < tokenExpires) {
            lastUsed = token;
            token = null;
            return Admission.QR;
        }
        return presented.equals(lastUsed) ? Admission.CONFLICT : Admission.BAD_TOKEN;
    }
}
