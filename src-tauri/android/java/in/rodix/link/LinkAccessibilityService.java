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
        // Unused: the service only injects actions and gestures.
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

    // Global D-pad actions (API 33+) dispatch system-wide KEYCODE_DPAD_* events, as TV remote apps
    // do. The desktop UI only offers D-pad controls for TV targets, so there is no fallback for
    // older phones.
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

    // GLOBAL_ACTION_MENU (21) and GLOBAL_ACTION_MEDIA_PLAY_PAUSE (22) were added in API 36, above
    // the compile SDK, so their literal values are used behind a runtime check.
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

    public boolean lockScreen() {
        return performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN);
    }

    // Absolute touch injection for the Digitizer TV target via dispatchGesture (requires
    // canPerformGestures="true" in accessibility_service_config.xml). Each call extends the
    // current gesture with continueStroke so a drag arrives as one stroke rather than separate
    // taps; continueStroke's path must start where the previous one ended, hence the last point.
    private GestureDescription.StrokeDescription digitizerStroke;
    private float digitizerLastX;
    private float digitizerLastY;
    private static final long DIGITIZER_STROKE_MS = 16; // about one frame, the sender's batching interval

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

    public void injectTap(float x, float y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 50);
        dispatchGesture(new GestureDescription.Builder().addStroke(stroke).build(), null, null);
    }

    public void injectScroll(float startX, float startY, float endX, float endY, long durationMs) {
        Path path = new Path();
        path.moveTo(startX, startY);
        path.lineTo(endX, endY);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, Math.max(50, durationMs));
        dispatchGesture(new GestureDescription.Builder().addStroke(stroke).build(), null, null);
    }

    // Lifts any stroke still down when a digitizer session ends, so no touch stays stuck.
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
                    // Cursor at the start: nothing to delete. Must not reach the fallback below,
                    // which would delete the last character.
                    return;
                } else if (start > 0 && end > 0 && start == end && start <= existing.length()) {
                    newText = existing.substring(0, start - 1) + existing.substring(start);
                    newCursorPos = start - 1;
                } else if (start >= 0 && end >= 0 && start != end && start <= existing.length() && end <= existing.length()) {
                    newText = existing.substring(0, start) + existing.substring(end);
                    newCursorPos = start;
                } else {
                    // Selection unknown: delete the last character.
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

    // Ctrl+A/C/V/X as AccessibilityNodeInfo actions, which unlike KeyEvent injection do not need
    // the INJECT_EVENTS permission.
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
