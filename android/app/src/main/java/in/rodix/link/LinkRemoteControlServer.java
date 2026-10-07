package in.rodix.link;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public class LinkRemoteControlServer {
    private static final String TAG = "LinkRemoteControlServer";

    private final Context context;
    private final MediaProjection projection;
    private final String targetDeviceId;
    private final LinkDeviceManager deviceManager;

    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private volatile boolean isRunning = false;
    private long lastFrameTime = 0;
    private static final long FRAME_INTERVAL_MS = 33; // ~30 FPS throttle to preserve bandwidth and battery

    private int width;
    private int height;
    private int densityDpi;

    public LinkRemoteControlServer(Context context, MediaProjection projection, String targetDeviceId, LinkDeviceManager deviceManager) {
        this.context = context;
        this.projection = projection;
        this.targetDeviceId = targetDeviceId;
        this.deviceManager = deviceManager;

        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        // Scale down to 720p equivalent height or width preserving aspect ratio for low latency
        int screenWidth = metrics.widthPixels;
        int screenHeight = metrics.heightPixels;
        this.densityDpi = metrics.densityDpi;

        // Modest bump over the original 1280 cap (see screen-capture-server.ts's matching
        // comment) — frame rate stays at 30fps below since it's the biggest bandwidth/CPU cost.
        float maxDim = 1600.0f;
        float scale = Math.min(1.0f, maxDim / Math.max(screenWidth, screenHeight));
        this.width = (int) (screenWidth * scale);
        this.height = (int) (screenHeight * scale);

        // Ensure even dimensions
        if (this.width % 2 != 0) this.width--;
        if (this.height % 2 != 0) this.height--;
    }

    public void start() {
        if (isRunning) return;
        isRunning = true;

        captureThread = new HandlerThread("link-rc-capture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(reader -> {
            if (!isRunning) return;
            Image image = null;
            try {
                image = reader.acquireLatestImage();
                if (image == null) return;

                long now = System.currentTimeMillis();
                if (now - lastFrameTime < FRAME_INTERVAL_MS) {
                    image.close();
                    return;
                }
                lastFrameTime = now;

                Image.Plane[] planes = image.getPlanes();
                ByteBuffer buffer = planes[0].getBuffer();
                int pixelStride = planes[0].getPixelStride();
                int rowStride = planes[0].getRowStride();
                int rowPadding = rowStride - pixelStride * width;

                Bitmap bitmap = Bitmap.createBitmap(
                    width + rowPadding / pixelStride,
                    height,
                    Bitmap.Config.ARGB_8888
                );
                bitmap.copyPixelsFromBuffer(buffer);

                // Crop out padding if needed
                Bitmap finalBitmap = bitmap;
                if (rowPadding > 0) {
                    finalBitmap = Bitmap.createBitmap(bitmap, 0, 0, width, height);
                    bitmap.recycle();
                }

                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                finalBitmap.compress(Bitmap.CompressFormat.JPEG, 82, baos);
                finalBitmap.recycle();

                byte[] jpegBytes = baos.toByteArray();
                String base64Jpeg = Base64.encodeToString(jpegBytes, Base64.NO_WRAP);

                JSONObject frameBody = new JSONObject();
                frameBody.put("type", "frame");
                frameBody.put("data", base64Jpeg);
                frameBody.put("w", width);
                frameBody.put("h", height);

                if (deviceManager != null && targetDeviceId != null) {
                    deviceManager.sendTo(targetDeviceId, new LinkPacket("link.remotecontrol.stream", frameBody));
                }
            } catch (Exception e) {
                Log.e(TAG, "Error capturing/encoding frame", e);
            } finally {
                if (image != null) {
                    try { image.close(); } catch (Exception ignored) {}
                }
            }
        }, captureHandler);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    Log.i(TAG, "MediaProjection revoked/stopped by system notification or user action");
                    stop();
                }
            }, captureHandler);
        }

        virtualDisplay = projection.createVirtualDisplay(
            "LinkRemoteControl",
            width,
            height,
            densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            captureHandler
        );

        Log.i(TAG, "Remote control capture started: " + width + "x" + height + " for peer " + targetDeviceId);
    }

    public boolean isRunning() {
        return isRunning;
    }

    public void stop() {
        isRunning = false;
        if (virtualDisplay != null) {
            try { virtualDisplay.release(); } catch (Exception ignored) {}
            virtualDisplay = null;
        }
        if (imageReader != null) {
            try { imageReader.close(); } catch (Exception ignored) {}
            imageReader = null;
        }
        if (captureThread != null) {
            captureThread.quitSafely();
            try { captureThread.join(500); } catch (InterruptedException ignored) {}
            captureThread = null;
        }
        if (projection != null) {
            try { projection.stop(); } catch (Exception ignored) {}
        }
        Log.i(TAG, "Remote control capture stopped");
    }
}
