package in.rodix.link;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.projection.MediaProjection;
import android.view.Surface;

import org.webrtc.CapturerObserver;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoCapturer;

/**
 * Screen capturer for WebRTC that bridges Android MediaProjection directly to WebRTC SurfaceTextureHelper.
 */
public class LinkScreenCapturer implements VideoCapturer {
    private final MediaProjection mediaProjection;
    private final int width;
    private final int height;
    private final int densityDpi;

    private SurfaceTextureHelper surfaceTextureHelper;
    private CapturerObserver capturerObserver;
    private VirtualDisplay virtualDisplay;

    public LinkScreenCapturer(MediaProjection mediaProjection, int width, int height, int densityDpi) {
        this.mediaProjection = mediaProjection;
        this.width = width;
        this.height = height;
        this.densityDpi = densityDpi;
    }

    @Override
    public void initialize(SurfaceTextureHelper surfaceTextureHelper, Context context, CapturerObserver capturerObserver) {
        this.surfaceTextureHelper = surfaceTextureHelper;
        this.capturerObserver = capturerObserver;
    }

    @Override
    public void startCapture(int width, int height, int framerate) {
        if (surfaceTextureHelper == null || mediaProjection == null) return;
        surfaceTextureHelper.setTextureSize(this.width, this.height);
        Surface surface = new Surface(surfaceTextureHelper.getSurfaceTexture());

        mediaProjection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stopCapture();
            }
        }, surfaceTextureHelper.getHandler());

        virtualDisplay = mediaProjection.createVirtualDisplay(
            "LinkWebRTCScreen",
            this.width,
            this.height,
            densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface,
            null,
            surfaceTextureHelper.getHandler()
        );

        surfaceTextureHelper.startListening(capturerObserver::onFrameCaptured);
        capturerObserver.onCapturerStarted(true);
    }

    @Override
    public void stopCapture() {
        if (surfaceTextureHelper != null) {
            surfaceTextureHelper.stopListening();
        }
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (capturerObserver != null) {
            capturerObserver.onCapturerStopped();
        }
    }

    @Override
    public void changeCaptureFormat(int width, int height, int framerate) {}

    @Override
    public void dispose() {
        stopCapture();
    }

    @Override
    public boolean isScreencast() {
        return true;
    }
}
