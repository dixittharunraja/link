package in.rodix.link;

import android.content.Context;
import android.media.projection.MediaProjection;
import android.util.DisplayMetrics;
import android.util.Log;

import org.json.JSONObject;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.util.ArrayList;
import java.util.List;

/**
 * WebRTC sender for Remote Control: streams this device's screen (MediaProjection, 60 fps) or,
 * in camera mode, a camera to a viewer, using the hardware H.264/VP8 encoders.
 */
public class LinkRemoteControlServer {
    /** Prefix of the stand-in device id for an unpaired guest viewing this screen by address. */
    public static final String GUEST_PREFIX = "guest-rc:";

    private static final String TAG = "LinkRemoteControlServer";

    private final Context context;
    private final MediaProjection projection;
    private final String targetDeviceId;
    private final LinkDeviceManager deviceManager;

    private EglBase eglBase;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private LinkScreenCapturer screenCapturer;
    // Camera mode (phone used as a webcam): same signalling and peer connection, but the video
    // comes from a camera instead of the screen, and no MediaProjection is involved.
    private final boolean cameraMode;
    private final boolean frontCamera;
    private org.webrtc.CameraVideoCapturer cameraCapturer;
    private SurfaceTextureHelper surfaceTextureHelper;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private volatile boolean isRunning = false;

    private int width;
    private int height;

    public LinkRemoteControlServer(Context context, MediaProjection projection, String targetDeviceId, LinkDeviceManager deviceManager) {
        this.context = context;
        this.projection = projection;
        this.targetDeviceId = targetDeviceId;
        this.deviceManager = deviceManager;
        this.cameraMode = false;
        this.frontCamera = false;

        int[] screen = realScreenSize(context);
        int screenWidth = screen[0];
        int screenHeight = screen[1];

        float maxDim = 1600.0f;
        float scale = Math.min(1.0f, maxDim / Math.max(screenWidth, screenHeight));
        this.width = (int) (screenWidth * scale);
        this.height = (int) (screenHeight * scale);

        if (this.width % 2 != 0) this.width--;
        if (this.height % 2 != 0) this.height--;
    }

    /**
     * The whole physical screen in pixels, {width, height}, in the current rotation. Unlike
     * Resources.getDisplayMetrics() this includes the area under an on-screen navigation bar, which
     * is part of the captured picture and where injected touches land. Using the smaller size made
     * a viewer's taps drift upward, more the further down they were, on phones with a navigation bar.
     */
    public static int[] realScreenSize(Context context) {
        try {
            android.view.WindowManager wm = (android.view.WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Rect bounds = wm.getMaximumWindowMetrics().getBounds();
                    if (bounds.width() > 0 && bounds.height() > 0) return new int[] { bounds.width(), bounds.height() };
                } else {
                    DisplayMetrics real = new DisplayMetrics();
                    wm.getDefaultDisplay().getRealMetrics(real);
                    if (real.widthPixels > 0 && real.heightPixels > 0) return new int[] { real.widthPixels, real.heightPixels };
                }
            }
        } catch (Exception ignored) {
            // Fall back to the app's own size below.
        }
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        return new int[] { metrics.widthPixels, metrics.heightPixels };
    }

    /** Camera mode: streams this phone's camera to {@code targetDeviceId}. */
    public LinkRemoteControlServer(Context context, String targetDeviceId, LinkDeviceManager deviceManager, boolean frontCamera) {
        this.context = context;
        this.projection = null;
        this.targetDeviceId = targetDeviceId;
        this.deviceManager = deviceManager;
        this.cameraMode = true;
        this.frontCamera = frontCamera;
        this.width = 1920;
        this.height = 1080;
    }

    /** One physical or logical camera on this phone. */
    private static final class CameraInfo {
        final String id;
        final boolean front;
        final double equivMm; // 35 mm-equivalent focal length; 0 when the phone does not report it
        String label;

        CameraInfo(String id, boolean front, double equivMm) {
            this.id = id;
            this.front = front;
            this.equivMm = equivMm;
        }
    }

    private volatile String currentCameraId;

    /** Every camera the phone exposes, labelled by what it actually is. The enumeration order from
     *  the system is not reliable (the ultra-wide is often listed before the main camera), so lenses
     *  are told apart by their 35 mm-equivalent focal length instead. Main camera first, front last. */
    private List<CameraInfo> listCameras() {
        List<CameraInfo> out = new ArrayList<>();
        try {
            android.hardware.camera2.CameraManager manager =
                (android.hardware.camera2.CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
            org.webrtc.Camera2Enumerator enumerator = new org.webrtc.Camera2Enumerator(context);
            for (String id : enumerator.getDeviceNames()) {
                android.hardware.camera2.CameraCharacteristics c = manager.getCameraCharacteristics(id);
                Integer facing = c.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING);
                if (facing == null || facing == android.hardware.camera2.CameraCharacteristics.LENS_FACING_EXTERNAL) continue;
                boolean front = facing == android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT;
                float[] focals = c.get(android.hardware.camera2.CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                android.util.SizeF sensor = c.get(android.hardware.camera2.CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                double equiv = 0;
                if (focals != null && focals.length > 0 && sensor != null) {
                    equiv = focals[0] * 43.27 / Math.hypot(sensor.getWidth(), sensor.getHeight());
                }
                out.add(new CameraInfo(id, front, equiv));
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read camera characteristics", e);
        }
        // Rear cameras ordered by closeness to a normal "main" lens, then the front one(s).
        java.util.Collections.sort(out, (a, b) -> {
            if (a.front != b.front) return a.front ? 1 : -1;
            return Double.compare(distanceFromMain(a), distanceFromMain(b));
        });
        for (CameraInfo info : out) {
            if (info.front) {
                info.label = "Front";
            } else if (info.equivMm <= 0) {
                info.label = "Back (camera " + info.id + ")";
            } else {
                String kind = info.equivMm < 20 ? "Ultra-wide" : info.equivMm <= 40 ? "Main" : "Telephoto";
                info.label = "Back - " + kind + " (" + Math.round(info.equivMm) + " mm)";
            }
        }
        return out;
    }

    private static double distanceFromMain(CameraInfo info) {
        return info.equivMm > 0 ? Math.abs(info.equivMm - 26.0) : 1000.0;
    }

    private org.webrtc.CameraVideoCapturer createCameraCapturer(boolean front) {
        org.webrtc.CameraEnumerator enumerator = new org.webrtc.Camera2Enumerator(context);
        List<CameraInfo> cameras = listCameras();
        for (CameraInfo info : cameras) {
            if (info.front == front) {
                org.webrtc.CameraVideoCapturer capturer = enumerator.createCapturer(info.id, null);
                if (capturer != null) {
                    currentCameraId = info.id;
                    Log.i(TAG, "Camera selected: " + info.label + " (id " + info.id + ")");
                    return capturer;
                }
            }
        }
        // Nothing of the requested facing worked: take whatever opens.
        for (String name : enumerator.getDeviceNames()) {
            org.webrtc.CameraVideoCapturer capturer = enumerator.createCapturer(name, null);
            if (capturer != null) {
                currentCameraId = name;
                return capturer;
            }
        }
        return null;
    }

    /** Tells the viewer which cameras exist and which one is live, so it can offer a choice. */
    private void sendCameraList() {
        if (!cameraMode || deviceManager == null || targetDeviceId == null) return;
        try {
            org.json.JSONArray list = new org.json.JSONArray();
            for (CameraInfo info : listCameras()) {
                list.put(new JSONObject().put("id", info.id).put("label", info.label));
            }
            deviceManager.sendTo(targetDeviceId, new LinkPacket("link.remotecontrol.signal",
                new JSONObject().put("type", "cameras").put("cameras", list).put("current", currentCameraId)));
        } catch (Exception e) {
            Log.w(TAG, "Could not send camera list", e);
        }
    }

    /** A stream starts WebRTC's bandwidth estimate far too low and ramps up slowly, which shows up as
     *  blocky video for the first seconds and again whenever the link hiccups. A start rate, a floor
     *  and a ceiling suited to what is sent keep it sharp; losing frames is preferred to losing
     *  detail. A 720p30 camera looks right within about 4 Mbps. A phone screen is mostly still
     *  text and UI, which the hardware encoder sends in very little, but scrolling and video need
     *  room, so it starts at 4 Mbps and may use up to 10. */
    private void tuneVideoSender() {
        if (peerConnection == null) return;
        int min = 1_000_000;
        int start = cameraMode ? 2_000_000 : 4_000_000;
        int max = cameraMode ? 4_000_000 : 10_000_000;
        try {
            peerConnection.setBitrate(min, start, max);
        } catch (Exception e) {
            Log.w(TAG, "setBitrate failed: " + e.getMessage());
        }
        try {
            for (org.webrtc.RtpSender sender : peerConnection.getSenders()) {
                if (sender.track() == null || !"video".equals(sender.track().kind())) continue;
                org.webrtc.RtpParameters params = sender.getParameters();
                for (org.webrtc.RtpParameters.Encoding encoding : params.encodings) {
                    encoding.maxBitrateBps = max;
                    encoding.minBitrateBps = min;
                    // Screen content is mostly static UI, so 30 fps is enough; a screen
                    // that is still sends no frames anyway.
                    encoding.maxFramerate = 30;
                }
                params.degradationPreference = org.webrtc.RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION;
                sender.setParameters(params);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not tune video sender: " + e.getMessage());
        }
    }

    /** Tells the viewer why sharing ended: "stopped" lets it reconnect instead of freezing on the
     *  last frame, "ended" (the host removed it) tells it to give up. */
    private void notifyStopped(String reason) {
        if (deviceManager == null || targetDeviceId == null) return;
        try {
            deviceManager.sendTo(targetDeviceId, new LinkPacket("link.remotecontrol.signal", new org.json.JSONObject().put("type", reason)));
        } catch (Exception ignored) {}
    }

    // One WebRTC factory and GL context for every session in this process, made on first use and
    // kept: making them starts several threads and loads the codecs, which every session (and every
    // "request" while the viewer reconnects) would otherwise pay for again. Capturers and texture
    // helpers stay per session, since each can serve only one capturer.
    private static EglBase sharedEglBase;
    private static PeerConnectionFactory sharedFactory;

    private static synchronized EglBase sharedEglBase() {
        if (sharedEglBase == null) sharedEglBase = EglBase.create();
        return sharedEglBase;
    }

    private static synchronized PeerConnectionFactory sharedFactory(Context context) {
        if (sharedFactory == null) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.getApplicationContext())
                    .setEnableInternalTracer(false)
                    .createInitializationOptions()
            );
            DefaultVideoEncoderFactory encoderFactory = new DefaultVideoEncoderFactory(
                sharedEglBase().getEglBaseContext(),
                true, /* enableIntelVp8 */
                true  /* enableH264HighProfile */
            );
            sharedFactory = PeerConnectionFactory.builder()
                .setOptions(new PeerConnectionFactory.Options())
                .setVideoEncoderFactory(encoderFactory)
                .createPeerConnectionFactory();
        }
        return sharedFactory;
    }

    public void start() {
        // The user can end sharing from the system's own indicator, which only reaches us here.
        if (projection != null) projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stop();
            }
        }, new android.os.Handler(android.os.Looper.getMainLooper()));
        if (isRunning) return;
        isRunning = true;

        try {
            eglBase = sharedEglBase();
            peerConnectionFactory = sharedFactory(context);

            surfaceTextureHelper = SurfaceTextureHelper.create("LinkCaptureThread", eglBase.getEglBaseContext());
            if (cameraMode) {
                cameraCapturer = createCameraCapturer(frontCamera);
                if (cameraCapturer == null) throw new IllegalStateException("No camera available");
                // Camera video is not a screencast (isScreencast=false), captured at 30 fps.
                videoSource = peerConnectionFactory.createVideoSource(false);
                cameraCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());
                cameraCapturer.startCapture(width, height, 30);
            } else {
                screenCapturer = new LinkScreenCapturer(projection, width, height, context.getResources().getDisplayMetrics().densityDpi);
                videoSource = peerConnectionFactory.createVideoSource(true);
                screenCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());
                screenCapturer.startCapture(width, height, 30);
            }

            videoTrack = peerConnectionFactory.createVideoTrack(cameraMode ? "LINK_CAMERA_TRACK" : "LINK_SCREEN_TRACK", videoSource);
            videoTrack.setEnabled(true);

            createPeerConnectionAndOffer();
            sendCameraList();

            Log.i(TAG, "WebRTC 60FPS screen stream session initialized for peer: " + targetDeviceId);
        } catch (Exception e) {
            Log.e(TAG, "Failed initializing WebRTC stream", e);
            stop();
        }
    }

    private synchronized void createPeerConnectionAndOffer() {
        if (!isRunning || peerConnectionFactory == null || videoTrack == null) return;

        if (peerConnection != null) {
            try {
                peerConnection.close();
                peerConnection.dispose();
            } catch (Exception ignored) {}
            peerConnection = null;
        }

        // No STUN/TURN server: both devices are on the same network, so host candidates suffice,
        // and a public server would only learn that a session is starting.
        List<PeerConnection.IceServer> iceServers = new ArrayList<>();

        PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
        rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        rtcConfig.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;

        peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, new PeerConnection.Observer() {
            @Override
            public void onIceCandidate(IceCandidate candidate) {
                if (candidate == null || !isRunning) return;
                try {
                    JSONObject body = new JSONObject();
                    body.put("type", "webrtc_candidate");
                    JSONObject candJson = new JSONObject();
                    candJson.put("candidate", candidate.sdp);
                    candJson.put("sdpMid", candidate.sdpMid);
                    candJson.put("sdpMLineIndex", candidate.sdpMLineIndex);
                    body.put("candidate", candJson);

                    if (deviceManager != null && targetDeviceId != null) {
                        deviceManager.sendTo(targetDeviceId, new LinkPacket("link.remotecontrol.signal", body));
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error sending ICE candidate", e);
                }
            }

            @Override public void onSignalingChange(PeerConnection.SignalingState signalingState) {}
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
                Log.i(TAG, "WebRTC ICE state: " + iceConnectionState);
            }
            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {}
            @Override public void onIceCandidatesRemoved(IceCandidate[] iceCandidates) {}
            @Override public void onAddStream(MediaStream mediaStream) {}
            @Override public void onRemoveStream(MediaStream mediaStream) {}
            @Override public void onDataChannel(org.webrtc.DataChannel dataChannel) {}
            @Override public void onRenegotiationNeeded() {}
            @Override public void onAddTrack(RtpReceiver rtpReceiver, MediaStream[] mediaStreams) {}
        });

        if (peerConnection != null) {
            List<String> streamIds = new ArrayList<>();
            streamIds.add("LINK_STREAM");
            peerConnection.addTrack(videoTrack, streamIds);

            MediaConstraints sdpConstraints = new MediaConstraints();
            sdpConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));
            sdpConstraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));

            peerConnection.createOffer(new SdpObserver() {
                @Override
                public void onCreateSuccess(SessionDescription sessionDescription) {
                    if (peerConnection == null || !isRunning) return;
                    peerConnection.setLocalDescription(new SdpObserver() {
                        @Override public void onCreateSuccess(SessionDescription s) {}
                        @Override
                        public void onSetSuccess() {
                            try {
                                JSONObject body = new JSONObject();
                                body.put("type", "webrtc_offer");
                                body.put("sdp", sessionDescription.description);
                                if (deviceManager != null && targetDeviceId != null) {
                                    deviceManager.sendTo(targetDeviceId, new LinkPacket("link.remotecontrol.signal", body));
                                }
                                Log.i(TAG, "WebRTC Offer sent to peer: " + targetDeviceId);
                                tuneVideoSender();
                            } catch (Exception e) {
                                Log.e(TAG, "Error sending WebRTC offer", e);
                            }
                        }
                        @Override public void onCreateFailure(String s) {}
                        @Override public void onSetFailure(String s) { Log.e(TAG, "setLocalDescription failure: " + s); }
                    }, sessionDescription);
                }
                @Override public void onSetSuccess() {}
                @Override public void onCreateFailure(String s) { Log.e(TAG, "createOffer failure: " + s); }
                @Override public void onSetFailure(String s) {}
            }, sdpConstraints);
        }
    }

    public synchronized void handleRemoteSignal(JSONObject signal) {
        if (!isRunning || signal == null) return;
        try {
            String type = signal.optString("type");
            if ("select-camera".equals(type)) {
                final String wanted = signal.optString("id");
                if (cameraCapturer != null && !wanted.isEmpty() && !wanted.equals(currentCameraId)) {
                    cameraCapturer.switchCamera(new org.webrtc.CameraVideoCapturer.CameraSwitchHandler() {
                        @Override public void onCameraSwitchDone(boolean isFrontCamera) {
                            currentCameraId = wanted;
                            sendCameraList();
                        }
                        @Override public void onCameraSwitchError(String errorDescription) {
                            Log.w(TAG, "Camera switch failed: " + errorDescription);
                            sendCameraList();
                        }
                    }, wanted);
                }
                return;
            }
            if ("switch-camera".equals(type)) {
                if (cameraCapturer != null) cameraCapturer.switchCamera(null);
                return;
            }
            if ("request".equals(type)) {
                Log.i(TAG, "Received new request signal from viewer, renegotiating WebRTC offer!");
                createPeerConnectionAndOffer();
                sendCameraList();
                return;
            }
            if (peerConnection == null) return;
            if ("webrtc_answer".equals(type)) {
                String sdp = signal.optString("sdp");
                SessionDescription answer = new SessionDescription(SessionDescription.Type.ANSWER, sdp);
                peerConnection.setRemoteDescription(new SdpObserver() {
                    @Override public void onCreateSuccess(SessionDescription sessionDescription) {}
                    @Override public void onSetSuccess() {
                        Log.i(TAG, "WebRTC Answer accepted from viewer!");
                        tuneVideoSender();
                    }
                    @Override public void onCreateFailure(String s) {}
                    @Override public void onSetFailure(String s) {
                        Log.e(TAG, "setRemoteDescription Answer failure: " + s);
                    }
                }, answer);
            } else if ("webrtc_candidate".equals(type)) {
                JSONObject cand = signal.optJSONObject("candidate");
                if (cand != null) {
                    IceCandidate iceCandidate = new IceCandidate(
                        cand.optString("sdpMid"),
                        cand.optInt("sdpMLineIndex"),
                        cand.optString("candidate")
                    );
                    peerConnection.addIceCandidate(iceCandidate);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling remote WebRTC signal", e);
        }
    }

    public String getTargetDeviceId() {
        return targetDeviceId;
    }

    public boolean isRunning() {
        return isRunning;
    }

    public void stop() {
        stop("stopped");
    }

    public void stop(String reason) {
        boolean wasRunning = isRunning;
        isRunning = false;
        if (wasRunning) notifyStopped(reason);
        try {
            if (cameraCapturer != null) {
                try { cameraCapturer.stopCapture(); } catch (Exception ignored) {}
                try { cameraCapturer.dispose(); } catch (Exception ignored) {}
                cameraCapturer = null;
            }
            if (screenCapturer != null) {
                try { screenCapturer.stopCapture(); } catch (Exception ignored) {}
                try { screenCapturer.dispose(); } catch (Exception ignored) {}
                screenCapturer = null;
            }
            if (videoSource != null) {
                try { videoSource.dispose(); } catch (Exception ignored) {}
                videoSource = null;
            }
            if (surfaceTextureHelper != null) {
                try { surfaceTextureHelper.dispose(); } catch (Exception ignored) {}
                surfaceTextureHelper = null;
            }
            if (peerConnection != null) {
                try { peerConnection.close(); } catch (Exception ignored) {}
                try { peerConnection.dispose(); } catch (Exception ignored) {}
                peerConnection = null;
            }
            // The factory and GL context are shared and kept for the next session (see sharedFactory).
            peerConnectionFactory = null;
            eglBase = null;
            if (projection != null) {
                try { projection.stop(); } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.e(TAG, "Error stopping WebRTC stream", e);
        }
        Log.i(TAG, "Remote control WebRTC capture stopped");
    }
}
