package in.rodix.link;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.Toast;

import org.json.JSONObject;

// A remote cursor for a TV (or any Android screen without a mouse), driven by a paired phone's
// touchpad: relative moves, click buttons, click-drag and scroll, the same vocabulary the PC's
// Remote Input understands. The pointer position lives here and is drawn by LinkCursorOverlay; clicks
// are injected at that position through LinkAccessibilityService. Arrives as link.pointer packets over
// the authenticated TCP link (see LinkInputRelay.sendToAndroidOverLink for why not UDP).
final class LinkPointer {
    static final String PACKET_TYPE_POINTER = "link.pointer";

    /** The cursor stays on screen this long after the last movement. */
    private static final long CURSOR_HIDE_MS = 5000;
    /** Touch deltas arrive in phone pixels scaled for a 1080p-wide display; larger screens scale up. */
    private static final float REFERENCE_WIDTH = 1920f;
    /** Scroll is applied as a swipe, at most this often, so gestures do not cancel each other. */
    private static final long SCROLL_INTERVAL_MS = 120;
    private static final float SCROLL_PIXELS_PER_UNIT = 28f;

    private static final Handler main = new Handler(Looper.getMainLooper());
    // Only touched on the main thread.
    private static float x = -1;
    private static float y = -1;
    private static boolean held = false;
    private static float scrollX = 0;
    private static float scrollY = 0;
    private static long lastScrollAt = 0;
    private static long lastNoServiceToastAt = 0;

    private LinkPointer() {
    }

    static void handle(Context context, JSONObject body) {
        final Context app = context.getApplicationContext();
        final String action = body.optString("action");
        final double dx = body.optDouble("dx", 0);
        final double dy = body.optDouble("dy", 0);
        final String button = body.optString("button", "left");
        main.post(() -> apply(app, action, dx, dy, button));
    }

    private static void apply(Context context, String action, double dx, double dy, String button) {
        int[] screen = LinkRemoteControlServer.realScreenSize(context);
        if (x < 0 || y < 0) {
            x = screen[0] / 2f;
            y = screen[1] / 2f;
        }
        LinkAccessibilityService service = LinkAccessibilityService.getInstance();

        switch (action) {
            case "move": {
                float scale = screen[0] / REFERENCE_WIDTH;
                // Pointer acceleration: slow strokes stay precise, fast ones cross the screen in one flick.
                float speed = (float) Math.hypot(dx, dy);
                float accel = 1f + Math.min(speed / 30f, 1.5f);
                x = clamp(x + (float) dx * scale * accel, 0, screen[0] - 1);
                y = clamp(y + (float) dy * scale * accel, 0, screen[1] - 1);
                // While held the touch follows the cursor, which is a drag.
                if (held && service != null) service.injectDigitizerTouch(x, y, true);
                LinkCursorOverlay.showArrow(context, x, y, CURSOR_HIDE_MS);
                break;
            }
            case "click": {
                LinkCursorOverlay.showArrow(context, x, y, CURSOR_HIDE_MS);
                if (service == null) {
                    warnNoService(context);
                } else if ("right".equals(button)) {
                    // No context menu on a TV: the right button is Back, as on most remote cursors.
                    service.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
                } else if ("middle".equals(button)) {
                    // Press and hold, which is what opens the context actions of an item.
                    service.injectScroll(x, y, x + 1, y, 700);
                } else {
                    service.injectTap(x, y);
                }
                break;
            }
            case "hold": {
                held = true;
                if (service != null) service.injectDigitizerTouch(x, y, true);
                else warnNoService(context);
                LinkCursorOverlay.showArrow(context, x, y, CURSOR_HIDE_MS);
                break;
            }
            case "release": {
                if (held && service != null) service.injectDigitizerTouch(x, y, false);
                held = false;
                LinkCursorOverlay.showArrow(context, x, y, CURSOR_HIDE_MS);
                break;
            }
            case "scroll": {
                scrollX += (float) dx;
                scrollY += (float) dy;
                long now = SystemClock.uptimeMillis();
                if (service == null) {
                    warnNoService(context);
                    scrollX = 0;
                    scrollY = 0;
                } else if (now - lastScrollAt >= SCROLL_INTERVAL_MS) {
                    float sx = clamp(scrollX * SCROLL_PIXELS_PER_UNIT, -screen[0] / 2f, screen[0] / 2f);
                    float sy = clamp(scrollY * SCROLL_PIXELS_PER_UNIT, -screen[1] / 2f, screen[1] / 2f);
                    if (Math.abs(sx) >= 4 || Math.abs(sy) >= 4) {
                        // The swipe follows the fingers on the phone, so the content moves with them.
                        service.injectScroll(x, y, clamp(x + sx, 0, screen[0] - 1), clamp(y + sy, 0, screen[1] - 1), SCROLL_INTERVAL_MS);
                        lastScrollAt = now;
                    }
                    scrollX = 0;
                    scrollY = 0;
                }
                LinkCursorOverlay.showArrow(context, x, y, CURSOR_HIDE_MS);
                break;
            }
            default:
                break;
        }
    }

    /** Clicks need the accessibility service; say so, but not on every movement. */
    private static void warnNoService(Context context) {
        long now = SystemClock.uptimeMillis();
        if (now - lastNoServiceToastAt < 8000) return;
        lastNoServiceToastAt = now;
        Toast.makeText(context,
                "Link Accessibility Service is disabled. Enable it in Settings -> Accessibility to click from the touchpad.",
                Toast.LENGTH_LONG).show();
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
