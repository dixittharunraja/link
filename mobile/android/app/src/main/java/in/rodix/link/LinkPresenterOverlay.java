package in.rodix.link;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;

// True system-level presenter pointer-dot overlay — draws over WHATEVER app is currently in the
// foreground (slides, PDF viewer, etc.), not just Link's own WebView. Mirrors desktop main.ts's
// showPresenterDot/hidePresenterDot (transparent, always-on-top, click-through, 500ms auto-hide-
// when-idle window), but via a real WindowManager overlay view instead of a second BrowserWindow,
// since Android has no per-app "always on top of everyone else" window concept outside this
// permission. Used only when the user has granted "Display over other apps" (SYSTEM_ALERT_WINDOW);
// LinkPlugin falls back to the in-app PresenterDotOverlay.tsx (JS layer) when it's not granted.
public class LinkPresenterOverlay {
    private static final int DOT_SIZE_DP = 14;
    private static final long HIDE_DELAY_MS = 500; // matches desktop's PRESENTER_HIDE_DELAY_MS

    private static WindowManager windowManager;
    private static View dotView;
    private static WindowManager.LayoutParams layoutParams;
    private static float posX = 0.5f;
    private static float posY = 0.5f;
    private static final Handler hideHandler = new Handler(Looper.getMainLooper());
    private static final Runnable hideRunnable = LinkPresenterOverlay::hide;

    public static boolean isPermissionGranted(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    public static void requestPermission(Context context) {
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    /** dx/dy are normalized deltas, same math as desktop's PresenterPosition.update(). */
    public static void updatePosition(Context context, double dx, double dy, double aspectRatio) {
        posX = clamp01((float) (posX + dx));
        posY = clamp01((float) (posY + dy * aspectRatio));

        hideHandler.removeCallbacks(hideRunnable);
        new Handler(Looper.getMainLooper()).post(() -> {
            ensureShown(context);
            applyPosition(context);
        });
        hideHandler.postDelayed(hideRunnable, HIDE_DELAY_MS);
    }

    public static void hide() {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (windowManager != null && dotView != null) {
                try {
                    windowManager.removeView(dotView);
                } catch (Exception ignored) {
                    // already detached (e.g. permission revoked mid-session)
                }
            }
            dotView = null;
            posX = 0.5f;
            posY = 0.5f;
        });
        hideHandler.removeCallbacks(hideRunnable);
    }

    private static void ensureShown(Context context) {
        if (dotView != null) return;

        windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        float density = context.getResources().getDisplayMetrics().density;
        int sizePx = (int) (DOT_SIZE_DP * density);

        FrameLayout dot = new FrameLayout(context);
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(Color.argb(217, 255, 0, 0)); // rgba(255,0,0,0.85)
        dot.setBackground(shape);
        dotView = dot;

        int overlayType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

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
        android.util.DisplayMetrics dm = context.getResources().getDisplayMetrics();
        float density = dm.density;
        int sizePx = (int) (DOT_SIZE_DP * density);
        layoutParams.x = (int) (posX * dm.widthPixels) - sizePx / 2;
        layoutParams.y = (int) (posY * dm.heightPixels) - sizePx / 2;
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
