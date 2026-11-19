package in.rodix.link;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;

public class LinkPauseMusic {
    private static final String TAG = "LinkPauseMusic";
    private static boolean pausedByCall = false;
    private static AudioFocusRequest audioFocusRequest = null;
    private static final AudioManager.OnAudioFocusChangeListener focusChangeListener = focusChange -> {
        Log.d(TAG, "Audio focus changed: " + focusChange);
    };

    /**
     * Reacts to incoming telephony call states (ringing, talking, cancelled, missedCall)
     * from paired trusted devices and automatically pauses/resumes active music/media on Android.
     */
    public static synchronized void onCallStateChanged(Context context, String event, boolean isCancel) {
        if (context == null) return;
        AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;

        boolean isActiveCall = !isCancel && ("ringing".equalsIgnoreCase(event) || "talking".equalsIgnoreCase(event));

        if (isActiveCall) {
            if (!pausedByCall) {
                boolean isMusicActive = am.isMusicActive();
                if (isMusicActive) {
                    Log.i(TAG, "Active call detected (" + event + "). Pausing local media playback.");
                    pausedByCall = true;
                    requestTransientAudioFocus(am);
                    dispatchMediaKey(am, KeyEvent.KEYCODE_MEDIA_PAUSE);
                }
            }
        } else {
            if (pausedByCall) {
                Log.i(TAG, "Call ended or cancelled (" + event + "). Resuming local media playback.");
                pausedByCall = false;
                abandonTransientAudioFocus(am);
                dispatchMediaKey(am, KeyEvent.KEYCODE_MEDIA_PLAY);
            }
        }
    }

    private static void requestTransientAudioFocus(AudioManager am) {
        try {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(focusChangeListener)
                    .build();
            am.requestAudioFocus(audioFocusRequest);
        } catch (Exception e) {
            Log.e(TAG, "Failed to request audio focus", e);
        }
    }

    private static void abandonTransientAudioFocus(AudioManager am) {
        try {
            if (audioFocusRequest != null) {
                am.abandonAudioFocusRequest(audioFocusRequest);
                audioFocusRequest = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to abandon audio focus", e);
        }
    }

    private static void dispatchMediaKey(AudioManager am, int keyCode) {
        try {
            long eventTime = SystemClock.uptimeMillis();
            KeyEvent downEvent = new KeyEvent(eventTime, eventTime, KeyEvent.ACTION_DOWN, keyCode, 0);
            am.dispatchMediaKeyEvent(downEvent);
            KeyEvent upEvent = new KeyEvent(eventTime, eventTime, KeyEvent.ACTION_UP, keyCode, 0);
            am.dispatchMediaKeyEvent(upEvent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to dispatch media key " + keyCode, e);
        }
    }
}
