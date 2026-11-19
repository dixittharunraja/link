package in.rodix.link;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;

// System-wide presenter pointer dot drawn as a WindowManager overlay, so it appears over whatever
// app is in the foreground. The Android counterpart of core/presenter.rs (click-through,
// auto-hides when idle). Requires "Display over other apps" (SYSTEM_ALERT_WINDOW); without it,
// LinkInputRelay falls back to the in-app PresenterDotOverlay.tsx.
//
// Moves arrive on the network thread many times a second. They only update the position; one
// pending update on the main thread draws whatever the latest position is, so moves that come
// faster than the screen refreshes are folded together instead of each queueing its own redraw.
public class LinkPresenterOverlay {
    private static final int DOT_SIZE_DP = 14;
    private static final long HIDE_DELAY_MS = 500; // matches desktop's HIDE_AFTER in core/presenter.rs
    /** How long the screen size is trusted before it is read again (it changes when the phone turns). */
    private static final long METRICS_MAX_AGE_MS = 1000;

    private static WindowManager windowManager;
    private static View dotView;
    private static WindowManager.LayoutParams layoutParams;
    private static volatile float posX = 0.5f;
    private static volatile float posY = 0.5f;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static final Runnable hideRunnable = LinkPresenterOverlay::hide;
    // Only touched on the main thread.
    private static int sizePx;
    private static int screenWidth;
    private static int screenHeight;
    private static long metricsReadAt;
    // A redraw is queued on the main thread; set from the network thread, cleared by the redraw.
    private static final java.util.concurrent.atomic.AtomicBoolean applyPending = new java.util.concurrent.atomic.AtomicBoolean();
    private static volatile Context applyContext;
    private static final Runnable applyRunnable = () -> {
        applyPending.set(false);
        Context context = applyContext;
        if (context == null) return;
        ensureShown(context);
        applyPosition(context);
    };

    public static boolean isPermissionGranted(Context context) {
        return Settings.canDrawOverlays(context);
    }

    public static void requestPermission(Context context) {
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    /** dx/dy are normalized deltas, applied as in Presenter::move_dot() in core/presenter.rs. */
    public static void updatePosition(Context context, double dx, double dy, double aspectRatio) {
        synchronized (LinkPresenterOverlay.class) {
            posX = clamp01((float) (posX + dx));
            posY = clamp01((float) (posY + dy * aspectRatio));
        }
        applyContext = context;
        if (applyPending.compareAndSet(false, true)) {
            mainHandler.post(applyRunnable);
        }
        mainHandler.removeCallbacks(hideRunnable);
        mainHandler.postDelayed(hideRunnable, HIDE_DELAY_MS);
    }

    public static void hide() {
        hide(false);
    }

    public static void hide(boolean resetPos) {
        mainHandler.post(() -> {
            mainHandler.removeCallbacks(hideRunnable);
            mainHandler.removeCallbacks(applyRunnable);
            applyPending.set(false);
            if (windowManager != null && dotView != null) {
                try {
                    windowManager.removeView(dotView);
                } catch (Exception ignored) {
                    // already detached (e.g. permission revoked mid-session)
                }
            }
            dotView = null;
            if (resetPos) {
                synchronized (LinkPresenterOverlay.class) {
                    posX = 0.5f;
                    posY = 0.5f;
                }
            }
        });
    }

    /** Reads the screen and dot sizes again when they are older than METRICS_MAX_AGE_MS. */
    private static void refreshMetrics(Context context) {
        long now = SystemClock.uptimeMillis();
        if (screenWidth > 0 && now - metricsReadAt < METRICS_MAX_AGE_MS) return;
        android.util.DisplayMetrics dm = context.getResources().getDisplayMetrics();
        sizePx = (int) (DOT_SIZE_DP * dm.density);
        screenWidth = dm.widthPixels;
        screenHeight = dm.heightPixels;
        metricsReadAt = now;
    }

    private static void ensureShown(Context context) {
        if (dotView != null) return;

        windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        // A new dot is a good moment to catch up with a turned screen.
        metricsReadAt = 0;
        refreshMetrics(context);

        FrameLayout dot = new FrameLayout(context);
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(Color.argb(217, 255, 0, 0)); // rgba(255,0,0,0.85)
        dot.setBackground(shape);
        dotView = dot;

        int overlayType = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;

        layoutParams = new WindowManager.LayoutParams(
                sizePx, sizePx,
                overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        layoutParams.gravity = Gravity.TOP | Gravity.START;

        try {
            windowManager.addView(dotView, layoutParams);
        } catch (Exception e) {
            android.util.Log.e("LinkPresenterOverlay", "Failed to add overlay view", e);
            dotView = null;
        }
    }

    private static void applyPosition(Context context) {
        if (dotView == null || windowManager == null || layoutParams == null) return;
        refreshMetrics(context);
        layoutParams.x = (int) (posX * screenWidth) - sizePx / 2;
        layoutParams.y = (int) (posY * screenHeight) - sizePx / 2;
        try {
            windowManager.updateViewLayout(dotView, layoutParams);
        } catch (Exception ignored) {
            // view already detached — next updatePosition's ensureShown will recreate it
        }
    }

    private static float clamp01(float v) {
        return Math.max(0, Math.min(1, v));
    }
}
