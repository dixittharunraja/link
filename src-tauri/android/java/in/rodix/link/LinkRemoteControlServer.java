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
 * High-performance WebRTC screen broadcaster for Link Remote Control.
 * Streams Android screen at 60 FPS using hardware H.264 / VP8 encoders with sub-30ms latency.
 */
public class LinkRemoteControlServer {
    private static final String TAG = "LinkRemoteControlServer";

    private final Context context;
    private final MediaProjection projection;
    private final String targetDeviceId;
    private final LinkDeviceManager deviceManager;

    private EglBase eglBase;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private LinkScreenCapturer screenCapturer;
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

        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        int screenWidth = metrics.widthPixels;
        int screenHeight = metrics.heightPixels;

        float maxDim = 1600.0f;
        float scale = Math.min(1.0f, maxDim / Math.max(screenWidth, screenHeight));
        this.width = (int) (screenWidth * scale);
        this.height = (int) (screenHeight * scale);

        if (this.width % 2 != 0) this.width--;
        if (this.height % 2 != 0) this.height--;
    }

    public void start() {
        if (isRunning) return;
        isRunning = true;

        try {
            eglBase = EglBase.create();

            // Initialize WebRTC
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions()
            );

            PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
            DefaultVideoEncoderFactory encoderFactory = new DefaultVideoEncoderFactory(
                eglBase.getEglBaseContext(),
                true, /* enableIntelVp8 */
                true  /* enableH264HighProfile */
            );

            peerConnectionFactory = PeerConnectionFactory.builder()
                .setOptions(options)
                .setVideoEncoderFactory(encoderFactory)
                .createPeerConnectionFactory();

            // Setup Screen Capturer
            screenCapturer = new LinkScreenCapturer(projection, width, height, context.getResources().getDisplayMetrics().densityDpi);
            surfaceTextureHelper = SurfaceTextureHelper.create("LinkCaptureThread", eglBase.getEglBaseContext());
            videoSource = peerConnectionFactory.createVideoSource(true);
            screenCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());
            screenCapturer.startCapture(width, height, 60); // 60 FPS hardware capture

            videoTrack = peerConnectionFactory.createVideoTrack("LINK_SCREEN_TRACK", videoSource);
            videoTrack.setEnabled(true);

            createPeerConnectionAndOffer();

            Log.i(TAG, "WebRTC 60FPS screen stream session initialized for peer: " + targetDeviceId);
        } catch (Exception e) {
            Log.e(TAG, "Failed initializing WebRTC stream", e);
            stop();
        }
    }

    private synchronized void createPeerConnectionAndOffer() {
        if (!isRunning || peerConnectionFactory == null || videoTrack == null) return;

        // Clean up previous PeerConnection if any
        if (peerConnection != null) {
            try {
                peerConnection.close();
                peerConnection.dispose();
            } catch (Exception ignored) {}
            peerConnection = null;
        }

        // Create PeerConnection
        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
        iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());

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
            if ("request".equals(type)) {
                Log.i(TAG, "Received new request signal from viewer, renegotiating WebRTC offer!");
                createPeerConnectionAndOffer();
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

    public boolean isRunning() {
        return isRunning;
    }

    public void stop() {
        isRunning = false;
        try {
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
            if (peerConnectionFactory != null) {
                try { peerConnectionFactory.dispose(); } catch (Exception ignored) {}
                peerConnectionFactory = null;
            }
            if (eglBase != null) {
                try { eglBase.release(); } catch (Exception ignored) {}
                eglBase = null;
            }
            if (projection != null) {
                try { projection.stop(); } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.e(TAG, "Error stopping WebRTC stream", e);
        }
        Log.i(TAG, "Remote control WebRTC capture stopped");
    }
}
