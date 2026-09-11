package in.rodix.link;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Path;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

public class LinkAccessibilityService extends AccessibilityService {
    public static final int DIRECTION_UP = 0;
    public static final int DIRECTION_DOWN = 1;
    public static final int DIRECTION_LEFT = 2;
    public static final int DIRECTION_RIGHT = 3;

    private static LinkAccessibilityService instance;

    public static LinkAccessibilityService getInstance() {
        return instance;
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        android.util.Log.i("LinkAccessibility", "LinkAccessibilityService connected");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // No-op event listening needed — service is used for action/key injection
    }

    @Override
    public void onInterrupt() {
        instance = null;
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    // Real global D-pad actions (Android 13 / API 33+) — these dispatch genuine synthetic
    // KEYCODE_DPAD_* key events system-wide, the same mechanism real Android TV remote apps use.
    // Remote Input's D-pad controls are TV-only (gated in the desktop UI), so no phone-oriented
    // fallback is needed here — Android TV devices are essentially always at or above this API
    // level. Values confirmed directly from the compiled AccessibilityService.class constant
    // pool (compileSdk 35): GLOBAL_ACTION_DPAD_UP=16, DOWN=17, LEFT=18, RIGHT=19, CENTER=20.
    public void moveFocus(int direction) {
        int action;
        switch (direction) {
            case DIRECTION_UP: action = AccessibilityService.GLOBAL_ACTION_DPAD_UP; break;
            case DIRECTION_DOWN: action = AccessibilityService.GLOBAL_ACTION_DPAD_DOWN; break;
            case DIRECTION_LEFT: action = AccessibilityService.GLOBAL_ACTION_DPAD_LEFT; break;
            case DIRECTION_RIGHT: action = AccessibilityService.GLOBAL_ACTION_DPAD_RIGHT; break;
            default: return;
        }
        performGlobalAction(action);
    }

    public void clickFocused() {
        performGlobalAction(AccessibilityService.GLOBAL_ACTION_DPAD_CENTER);
    }

    // Android 16 (API 36) added GLOBAL_ACTION_MENU (21) and GLOBAL_ACTION_MEDIA_PLAY_PAUSE (22),
    // also confirmed directly from the compiled class file — these post-date this project's
    // compileSdkVersion (35), so the symbolic constants aren't available to compile against yet;
    // the literal values are used directly instead (performGlobalAction takes a plain int, so
    // this doesn't need the symbol) and gated behind a runtime SDK check so it's simply absent
    // on any device below API 36 rather than doing something unintended.
    public void performMenu() {
        if (android.os.Build.VERSION.SDK_INT >= 36) {
            performGlobalAction(21);
        }
    }

    public void performPlayPause() {
        if (android.os.Build.VERSION.SDK_INT >= 36) {
            performGlobalAction(22);
        }
    }

    // Real absolute touch injection for Digitizer's TV target — dispatchGesture is the one
    // AccessibilityService capability that goes beyond node actions/global actions: it injects a
    // genuine synthetic touch stream system-wide (whatever app currently has focus), which is
    // exactly what a stylus/drawing-tablet target needs. requires canPerformGestures="true" in
    // accessibility_service_config.xml (already set). Each call continues the SAME gesture via
    // StrokeDescription.continueStroke rather than starting a new one, so a drag arrives as one
    // continuous stroke instead of a series of disconnected taps — continueStroke requires its
    // path to start exactly where the previous stroke ended, hence tracking the last point here.
    private GestureDescription.StrokeDescription digitizerStroke;
    private float digitizerLastX;
    private float digitizerLastY;
    private static final long DIGITIZER_STROKE_MS = 16; // ~one frame, matches the sender's own batching interval

    public void injectDigitizerTouch(float x, float y, boolean touching) {
        Path path = new Path();
        if (!touching) {
            if (digitizerStroke == null) return;
            path.moveTo(digitizerLastX, digitizerLastY);
            path.lineTo(x, y);
            GestureDescription.StrokeDescription end = digitizerStroke.continueStroke(path, 0, DIGITIZER_STROKE_MS, false);
            dispatchGesture(new GestureDescription.Builder().addStroke(end).build(), null, null);
            digitizerStroke = null;
            return;
        }

        if (digitizerStroke == null) {
            path.moveTo(x, y);
            digitizerStroke = new GestureDescription.StrokeDescription(path, 0, DIGITIZER_STROKE_MS, true);
        } else {
            path.moveTo(digitizerLastX, digitizerLastY);
            path.lineTo(x, y);
            digitizerStroke = digitizerStroke.continueStroke(path, 0, DIGITIZER_STROKE_MS, true);
        }
        digitizerLastX = x;
        digitizerLastY = y;
        dispatchGesture(new GestureDescription.Builder().addStroke(digitizerStroke).build(), null, null);
    }

    // Called when a digitizer session ends (pen mode toggled off / overlay closed) while a
    // stroke is still down, so the target doesn't end up with a permanently "stuck" touch.
    public void endDigitizerTouch() {
        if (digitizerStroke != null) {
            injectDigitizerTouch(digitizerLastX, digitizerLastY, false);
        }
    }

    public void deleteBeforeFocused() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        try {
            AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused == null) return;
            try {
                CharSequence existingText = focused.getText();
                if (existingText == null || existingText.length() == 0) return;
                
                int start = focused.getTextSelectionStart();
                int end = focused.getTextSelectionEnd();
                String existing = existingText.toString();
                String newText;
                int newCursorPos;
                
                if (start == 0 && end == 0) {
                    // Cursor already at the very start — nothing before it to delete. Falling
                    // through to the "unknown selection" branch below used to wrongly delete the
                    // LAST character of the whole field instead of doing nothing.
                    return;
                } else if (start > 0 && end > 0 && start == end && start <= existing.length()) {
                    newText = existing.substring(0, start - 1) + existing.substring(start);
                    newCursorPos = start - 1;
                } else if (start >= 0 && end >= 0 && start != end && start <= existing.length() && end <= existing.length()) {
                    newText = existing.substring(0, start) + existing.substring(end);
                    newCursorPos = start;
                } else {
                    // Selection info unavailable/invalid (start or end < 0) — best-effort fallback.
                    newText = existing.substring(0, existing.length() - 1);
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

    // Ctrl+A/C/V/X — real AccessibilityNodeInfo actions, unlike raw KeyEvent injection (see
    // LinkRemoteInput.injectSpecialKey's comment) these don't need INJECT_EVENTS/shell privilege,
    // so they work on a normal signed app the same way TalkBack's own text actions do.
    public void selectAllFocused() {
        withFocusedNode((focused, existing) -> {
            Bundle arguments = new Bundle();
            arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0);
            arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, existing.length());
            focused.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, arguments);
        });
    }

    public void copyFocused() {
        withFocusedNode((focused, existing) -> focused.performAction(AccessibilityNodeInfo.ACTION_COPY));
    }

    public void pasteFocused() {
        withFocusedNode((focused, existing) -> focused.performAction(AccessibilityNodeInfo.ACTION_PASTE));
    }

    public void cutFocused() {
        withFocusedNode((focused, existing) -> focused.performAction(AccessibilityNodeInfo.ACTION_CUT));
    }

    private interface FocusedNodeAction {
        void run(AccessibilityNodeInfo focused, String existingText);
    }

    private void withFocusedNode(FocusedNodeAction action) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        try {
            AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused == null) return;
            try {
                CharSequence text = focused.getText();
                action.run(focused, text == null ? "" : text.toString());
            } finally {
                focused.recycle();
            }
        } finally {
            root.recycle();
        }
    }
}
