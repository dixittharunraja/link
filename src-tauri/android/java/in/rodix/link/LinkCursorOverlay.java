package in.rodix.link;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

// A visible cursor for remote input. The touches are injected through the accessibility service,
// which draws nothing, so on a TV (no finger to see) the controlled screen showed no sign of where
// the input was. This draws one as a click-through WindowManager overlay (same permission and
// approach as LinkPresenterOverlay) and hides it a moment after the input stops:
//   - the familiar PC mouse arrow for the touchpad (relative movement, tip at the position), and
//   - a crosshair for pen mode (absolute positioning, centred on the position).
// The look never changes while a button or the pen is down.
public class LinkCursorOverlay {
    private enum Style { ARROW, CROSSHAIR }

    /** Height of the arrow, and the size of the crosshair; about a desktop pointer on a 1080p display. */
    private static final int SIZE_DP = 22;
    private static final long HIDE_DELAY_MS = 1500;

    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static final Runnable hideRunnable = LinkCursorOverlay::hide;
    // Only touched on the main thread.
    private static WindowManager windowManager;
    private static CursorView cursorView;
    private static Style shownStyle;
    private static WindowManager.LayoutParams layoutParams;

    /** The pointer arrow, tip at (x, y) in screen pixels, for the touchpad. */
    public static void showArrow(Context context, float x, float y, long hideAfterMs) {
        show(context, Style.ARROW, x, y, hideAfterMs);
    }

    /** A crosshair centred on (x, y) in screen pixels, for pen / digitizer input. */
    public static void showCrosshair(Context context, float x, float y) {
        show(context, Style.CROSSHAIR, x, y, HIDE_DELAY_MS);
    }

    private static void show(Context context, Style style, float x, float y, long hideAfterMs) {
        final Context appContext = context.getApplicationContext();
        mainHandler.post(() -> {
            if (!ensureShown(appContext, style)) return;
            // The arrow's tip is its top-left corner; the crosshair's centre is the middle of its view.
            int offset = style == Style.CROSSHAIR ? cursorView.widthPx() / 2 : 0;
            layoutParams.x = (int) x - offset;
            layoutParams.y = (int) y - offset;
            try {
                windowManager.updateViewLayout(cursorView, layoutParams);
            } catch (Exception ignored) {
                // detached under us; the next call shows it again
            }
            mainHandler.removeCallbacks(hideRunnable);
            mainHandler.postDelayed(hideRunnable, hideAfterMs);
        });
    }

    public static void hide() {
        mainHandler.post(LinkCursorOverlay::removeNow);
    }

    private static void removeNow() {
        mainHandler.removeCallbacks(hideRunnable);
        if (windowManager != null && cursorView != null) {
            try {
                windowManager.removeView(cursorView);
            } catch (Exception ignored) {
                // already detached (e.g. permission revoked mid-session)
            }
        }
        cursorView = null;
        shownStyle = null;
    }

    private static boolean ensureShown(Context context, Style style) {
        if (cursorView != null && shownStyle == style) return true;
        // A different cursor is wanted (touchpad after pen, or the reverse).
        if (cursorView != null) removeNow();
        if (!LinkPresenterOverlay.isPermissionGranted(context)) return false;

        windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        int sizePx = (int) (SIZE_DP * context.getResources().getDisplayMetrics().density);
        CursorView view = new CursorView(context, style, sizePx);

        layoutParams = new WindowManager.LayoutParams(
                view.widthPx(), sizePx,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        // The position is in screen pixels, status bar included, the same space the
                        // injected touches use. Without LAYOUT_IN_SCREEN the window is placed below the
                        // status bar, so the cursor is drawn lower than the point that is actually tapped.
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        layoutParams.gravity = Gravity.TOP | Gravity.START;
        // Nor may a display cutout (notch) shift it.
        layoutParams.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;

        try {
            windowManager.addView(view, layoutParams);
        } catch (Exception e) {
            android.util.Log.e("LinkCursorOverlay", "Failed to add cursor overlay", e);
            return false;
        }
        cursorView = view;
        shownStyle = style;
        return true;
    }

    /** White with a dark outline so it reads on any background. */
    private static final class CursorView extends View {
        // The arrow is drawn on a 12.5 x 20 grid; the crosshair on a 20 x 20 grid.
        private static final float ARROW_W = 12.5f;
        private static final float GRID = 20f;

        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint outline = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path shape = new Path();
        private final Style style;
        private final int sizePx;

        CursorView(Context context, Style style, int sizePx) {
            super(context);
            this.style = style;
            this.sizePx = sizePx;
            fill.setColor(Color.WHITE);
            outline.setColor(Color.BLACK);
            outline.setStyle(Paint.Style.STROKE);
            outline.setStrokeJoin(Paint.Join.ROUND);
            outline.setStrokeCap(Paint.Cap.ROUND);

            if (style == Style.ARROW) {
                fill.setStyle(Paint.Style.FILL);
                shape.moveTo(0.8f, 0.8f);
                shape.lineTo(0.8f, 17f);
                shape.lineTo(4.6f, 13.4f);
                shape.lineTo(7.2f, 19.2f);
                shape.lineTo(9.8f, 18.1f);
                shape.lineTo(7.2f, 12.4f);
                shape.lineTo(12f, 12.4f);
                shape.close();
            } else {
                // A thin cross with a small gap in the middle, so the exact point stays visible.
                fill.setStyle(Paint.Style.STROKE);
                shape.moveTo(10f, 1.5f);
                shape.lineTo(10f, 8f);
                shape.moveTo(10f, 12f);
                shape.lineTo(10f, 18.5f);
                shape.moveTo(1.5f, 10f);
                shape.lineTo(8f, 10f);
                shape.moveTo(12f, 10f);
                shape.lineTo(18.5f, 10f);
            }
        }

        int widthPx() {
            return style == Style.ARROW ? Math.round(sizePx * ARROW_W / GRID) : sizePx;
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float scale = sizePx / GRID;
            canvas.save();
            canvas.scale(scale, scale);
            if (style == Style.ARROW) {
                outline.setStrokeWidth(1.6f);
                canvas.drawPath(shape, fill);
                canvas.drawPath(shape, outline);
            } else {
                // A dark line under a lighter one: an outlined stroke.
                outline.setStrokeWidth(3.8f);
                fill.setStrokeWidth(1.9f);
                fill.setStrokeCap(Paint.Cap.ROUND);
                canvas.drawPath(shape, outline);
                canvas.drawPath(shape, fill);
            }
            canvas.restore();
        }
    }
}
