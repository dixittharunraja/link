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
        final JSONObject body = packet.body;
        final String text = body.has("text") ? body.optString("text") : null;
        final String key = body.has("specialKey") ? body.optString("specialKey") : null;

        // Typing into Link's own screens (the pairing IP field, renaming) cannot go through the
        // accessibility service: a WebView exposes none of its page to it. When Link is in front, the
        // page is offered the text, Enter and Delete first; it answers whether a text box took them.
        if (MainActivity.offerRemoteInputToPage(text, key, handled -> {
            if (!handled) injectViaAccessibility(context, text, key);
        })) {
            return;
        }
        injectViaAccessibility(context, text, key);
    }

    private static void injectViaAccessibility(Context context, String text, String key) {
        if (LinkAccessibilityService.getInstance() == null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                android.widget.Toast.makeText(context,
                    "Link Accessibility Service is disabled. Please enable it in Settings -> Accessibility to receive remote input.",
                    android.widget.Toast.LENGTH_LONG).show();
            });
            return;
        }

        try {
            if (text != null) {
                injectText(text);
            }
            if (key != null) {
                injectSpecialKey(context, key);
            }
        } catch (Exception e) {
            android.util.Log.e("LinkRemoteInput", "Failed to handle remote input packet", e);
        }
    }

    // Requires a focused editable field: a normal app cannot inject text system-wide (see
    // injectSpecialKey).
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
                CharSequence hintText = focused.getHintText();
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

    // Raw KeyEvent injection needs INJECT_EVENTS, which only the shell/system UID holds. Keys are
    // therefore mapped to accessibility actions (LinkAccessibilityService: global D-pad actions,
    // node text actions), and volume goes through AudioManager.
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
