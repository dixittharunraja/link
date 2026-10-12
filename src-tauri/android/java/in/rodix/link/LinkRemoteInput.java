package in.rodix.link;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.media.AudioManager;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;

/**
 * Android receiver for PC -> Android Remote Keyboard and D-Pad navigation.
 * Receives `link.remoteinput.send` packets containing raw text or D-pad/system key codes,
 * and dispatches them to active input fields, accessibility focus, or system actions.
 */
public class LinkRemoteInput {
    public static final String PACKET_TYPE_REMOTEINPUT_SEND = "link.remoteinput.send";

    public static boolean isRemoteInputPacket(LinkPacket packet) {
        return PACKET_TYPE_REMOTEINPUT_SEND.equals(packet.type);
    }

    public static void handleRemoteInput(Context context, LinkPacket packet) {
        if (LinkAccessibilityService.getInstance() == null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                android.widget.Toast.makeText(context,
                    "Link Accessibility Service is disabled. Please enable it in Settings -> Accessibility to receive remote input.",
                    android.widget.Toast.LENGTH_LONG).show();
            });
            return;
        }

        try {
            JSONObject body = packet.body;
            if (body.has("text")) {
                String text = body.getString("text");
                injectText(text);
            }
            if (body.has("specialKey")) {
                String key = body.getString("specialKey");
                injectSpecialKey(context, key);
            }
        } catch (Exception e) {
            android.util.Log.e("LinkRemoteInput", "Failed to handle remote input packet", e);
        }
    }

    // Only works when a focused editable field already exists — there is no legitimate way for
    // a signed, non-shell app to inject arbitrary text system-wide on stock Android (see the
    // key-injection note on injectSpecialKey below for why the previous Instrumentation fallback
    // here was silently no-op-ing on every device).
    public static void injectText(final String text) {
        if (text == null || text.isEmpty()) return;

        LinkAccessibilityService service = LinkAccessibilityService.getInstance();
        if (service == null) return;

        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) return;
        try {
            AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused == null) return;
            try {
                CharSequence existingText = focused.getText();
                CharSequence hintText = null;
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    hintText = focused.getHintText();
                }
                String existing = "";
                if (existingText != null) {
                    existing = existingText.toString();
                    if (hintText != null && existing.equals(hintText.toString())) {
                        existing = "";
                    }
                }

                int start = focused.getTextSelectionStart();
                int end = focused.getTextSelectionEnd();
                String newText;
                int newCursorPos;

                if (start >= 0 && end >= 0 && start <= existing.length() && end <= existing.length()) {
                    newText = existing.substring(0, start) + text + existing.substring(end);
                    newCursorPos = start + text.length();
                } else {
                    newText = existing + text;
                    newCursorPos = newText.length();
                }

                Bundle arguments = new Bundle();
                arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText);
                focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);

                arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, newCursorPos);
                arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, newCursorPos);
                focused.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, arguments);
            } finally {
                focused.recycle();
            }
        } finally {
            root.recycle();
        }
    }

    // Raw KeyEvent injection (Instrumentation.sendKeyDownUpSync) requires INJECT_EVENTS, a
    // permission reserved for the shell/system UID — a normal signed app throws SecurityException
    // on every call, which is why D-pad/keyboard previously appeared to silently do nothing.
    // D-pad/Menu/Play-Pause instead use AccessibilityService's real global actions (see
    // LinkAccessibilityService.java) — genuine synthetic key dispatch, TV-remote-appropriate.
    // Volume goes straight through AudioManager, which needs no special injection at all.
    public static void injectSpecialKey(Context context, final int specialKeyCode) {
        String keyStr;
        switch (specialKeyCode) {
            case 1: keyStr = "BACKSPACE"; break;
            case 4: keyStr = "LEFT"; break;
            case 5: keyStr = "UP"; break;
            case 6: keyStr = "RIGHT"; break;
            case 7: keyStr = "DOWN"; break;
            case 8: keyStr = "PAGE_UP"; break;
            case 9: keyStr = "PAGE_DOWN"; break;
            case 12: keyStr = "ENTER"; break;
            case 14: keyStr = "ESCAPE"; break;
            case 25: keyStr = "FULLSCREEN"; break;
            case 40: keyStr = "SELECT_ALL"; break;
            case 41: keyStr = "COPY"; break;
            case 42: keyStr = "PASTE"; break;
            case 43: keyStr = "CUT"; break;
            default: return;
        }
        injectSpecialKey(context, keyStr);
    }

    public static void injectSpecialKey(Context context, final String specialKey) {
        if (specialKey == null) return;

        LinkAccessibilityService service = LinkAccessibilityService.getInstance();

        switch (specialKey.toUpperCase()) {
            case "BACK":
            case "ESCAPE":
            case "FULLSCREEN":
                if (service != null) service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
                return;
            case "HOME":
                if (service != null) service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
                return;
            case "RECENTS":
                if (service != null) service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS);
                return;
            case "LOCK":
            case "POWER":
            case "SLEEP":
                if (service != null) service.lockScreen();
                return;
            case "DPAD_UP":
            case "UP":
            case "PAGE_UP":
            case "PREV":
                if (service != null) service.moveFocus(LinkAccessibilityService.DIRECTION_UP);
                return;
            case "DPAD_DOWN":
            case "DOWN":
            case "PAGE_DOWN":
            case "NEXT":
            case "TAB":
                if (service != null) service.moveFocus(LinkAccessibilityService.DIRECTION_DOWN);
                return;
            case "DPAD_LEFT":
            case "LEFT":
                if (service != null) service.moveFocus(LinkAccessibilityService.DIRECTION_LEFT);
                return;
            case "DPAD_RIGHT":
            case "RIGHT":
                if (service != null) service.moveFocus(LinkAccessibilityService.DIRECTION_RIGHT);
                return;
            case "DPAD_CENTER":
            case "CENTER":
            case "ENTER":
                if (service != null) service.clickFocused();
                return;
            case "MENU":
                if (service != null) service.performMenu();
                return;
            case "PLAY_PAUSE":
            case "MEDIA_PLAY_PAUSE":
                if (service != null) service.performPlayPause();
                return;
            case "DELETE":
            case "BACKSPACE":
                if (service != null) service.deleteBeforeFocused();
                return;
            case "SELECT_ALL":
                if (service != null) service.selectAllFocused();
                return;
            case "COPY":
                if (service != null) service.copyFocused();
                return;
            case "PASTE":
                if (service != null) service.pasteFocused();
                return;
            case "CUT":
                if (service != null) service.cutFocused();
                return;
            case "VOLUME_UP": {
                AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                if (am != null) am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI);
                return;
            }
            case "VOLUME_DOWN": {
                AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                if (am != null) am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI);
                return;
            }
            default:
                return;
        }
    }
}
