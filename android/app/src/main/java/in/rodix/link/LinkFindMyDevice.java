package in.rodix.link;

// Find My Device plugin — scoped-down port of kdeconnect-android's FindMyPhonePlugin.java.
// Real upstream loops a ringtone at max ALARM volume + flashes the camera flashlight + shows a
// full-screen notification that only stops when the user taps it (there's no "stop" packet in
// the protocol — it rings until manually acknowledged). We don't have that notification/activity
// infrastructure built yet, so this implements the core "make noise to help locate it" behavior
// with a fixed auto-stop duration instead of tap-to-dismiss. Disclosed deviation — see
// docs/features.txt, and desktop's findmydevice.ts has the matching note.

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.os.VibrationEffect;
import android.provider.Settings;

import org.json.JSONObject;

public class LinkFindMyDevice {
    public static final String PACKET_TYPE_FINDMYDEVICE_REQUEST = "link.findmydevice.request";
    private static final long RING_DURATION_MS = 60000;

    public static LinkPacket createPacket() {
        return createPacket(false);
    }

    public static LinkPacket createPacket(boolean cancel) {
        JSONObject body = new JSONObject();
        if (cancel) {
            try {
                body.put("cancel", true);
            } catch (Exception ignored) {}
        }
        return new LinkPacket(PACKET_TYPE_FINDMYDEVICE_REQUEST, body);
    }

    public static boolean isFindMyDevicePacket(LinkPacket packet) {
        return PACKET_TYPE_FINDMYDEVICE_REQUEST.equals(packet.type);
    }

    private static MediaPlayer mediaPlayer;
    private static int previousVolume = -1;
    private static Handler blinkHandler;
    private static Runnable blinkRunnable;
    private static boolean blinkState = false;
    private static Vibrator vibrator;

    public static void ring(Context context) {
        stopRinging(context);
        try {
            AudioManager audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setDataSource(context, Settings.System.DEFAULT_RINGTONE_URI);
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_UNKNOWN)
                    .setFlags(AudioAttributes.FLAG_AUDIBILITY_ENFORCED)
                    .build();
            mediaPlayer.setAudioAttributes(audioAttributes);
            mediaPlayer.setLooping(true);
            mediaPlayer.prepare();

            previousVolume = audioManager.getStreamVolume(AudioManager.STREAM_ALARM);
            audioManager.setStreamVolume(AudioManager.STREAM_ALARM, audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            mediaPlayer.start();

            // Trigger strong locating vibration pattern (vibrate 1s, pause 0.5s, repeating)
            vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = {0, 1000, 500};
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }

            blinkState = false;
            blinkHandler = new Handler(Looper.getMainLooper());
            blinkRunnable = new Runnable() {
                @Override
                public void run() {
                    blinkState = !blinkState;
                    LinkFlashlight.setTorchMode(context, blinkState);
                    if (blinkHandler != null) {
                        blinkHandler.postDelayed(this, 500);
                    }
                }
            };
            blinkHandler.post(blinkRunnable);

            new Handler(Looper.getMainLooper()).postDelayed(() -> stopRinging(context), RING_DURATION_MS);
        } catch (Exception e) {
            android.util.Log.e("LinkFindMyDevice", "Failed to ring", e);
        }
    }

    public static void stopRinging(Context context) {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) mediaPlayer.stop();
                mediaPlayer.release();
            } catch (Exception ignored) {
            }
            mediaPlayer = null;
        }
        if (previousVolume != -1) {
            AudioManager audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            audioManager.setStreamVolume(AudioManager.STREAM_ALARM, previousVolume, 0);
            previousVolume = -1;
        }
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (Exception ignored) {}
            vibrator = null;
        }
        if (blinkHandler != null && blinkRunnable != null) {
            blinkHandler.removeCallbacks(blinkRunnable);
            blinkHandler = null;
            blinkRunnable = null;
        }
        LinkFlashlight.setTorchMode(context, false);
    }
}
