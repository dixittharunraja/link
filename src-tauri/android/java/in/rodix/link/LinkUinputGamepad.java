package in.rodix.link;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.lang.reflect.Method;

import rikka.shizuku.Shizuku;
import rikka.shizuku.ShizukuBinderWrapper;
import rikka.shizuku.SystemServiceHelper;

/**
 * Injects gamepad input as KeyEvents (buttons, D-pad) and joystick MotionEvents (sticks,
 * triggers) through IInputManager.injectInputEvent, reached via a Shizuku binder because
 * injection needs shell privileges. Falls back to the app's own InputManager when Shizuku is
 * unavailable, which normally lacks the permission.
 */
public class LinkUinputGamepad {
    private static final String TAG = "LinkUinputGamepad";

    // Button bitmask; must match JoystickOverlay.tsx.
    public static final int BTN_DPAD_UP    = 1 << 0;
    public static final int BTN_DPAD_DOWN  = 1 << 1;
    public static final int BTN_DPAD_LEFT  = 1 << 2;
    public static final int BTN_DPAD_RIGHT = 1 << 3;
    public static final int BTN_START      = 1 << 4;
    public static final int BTN_BACK       = 1 << 5;
    public static final int BTN_LB         = 1 << 6;
    public static final int BTN_RB         = 1 << 7;
    public static final int BTN_A          = 1 << 8;
    public static final int BTN_B          = 1 << 9;
    public static final int BTN_X          = 1 << 10;
    public static final int BTN_Y          = 1 << 11;

    public interface StatusListener {
        void onStatusChanged(String status, String error);
    }

    private final Context context;
    private final StatusListener statusListener;
    private Object inputManagerInstance = null;
    private Method injectInputEventMethod = null;
    private int injectMode = 0; // INJECT_INPUT_EVENT_MODE_ASYNC
    private boolean initialized = false;

    // Last button bitmask per pad (0-3), to detect presses and releases.
    private final int[] lastButtons = new int[4];
    private final long[] downTimes = new long[KeyEvent.getMaxKeyCode() + 1];

    public LinkUinputGamepad(Context context, StatusListener statusListener) {
        this.context = context;
        this.statusListener = statusListener;
    }

    public boolean isShizukuAvailable() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable t) {
            return false;
        }
    }

    public boolean hasShizukuPermission() {
        try {
            if (!isShizukuAvailable()) return false;
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    public void requestShizukuPermission(int requestCode) {
        try {
            if (isShizukuAvailable()) {
                Shizuku.requestPermission(requestCode);
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to request Shizuku permission", t);
        }
    }

    public synchronized void initialize() {
        if (initialized) return;

        // IInputManager through Shizuku, which has the shell's injection permission.
        try {
            IBinder binder = SystemServiceHelper.getSystemService("input");
            if (binder != null) {
                IBinder wrapped = new ShizukuBinderWrapper(binder);
                Class<?> iInputManagerStub = Class.forName("android.hardware.input.IInputManager$Stub");
                Method asInterface = iInputManagerStub.getMethod("asInterface", IBinder.class);
                inputManagerInstance = asInterface.invoke(null, wrapped);

                if (inputManagerInstance != null) {
                    for (Method m : inputManagerInstance.getClass().getMethods()) {
                        if ("injectInputEvent".equals(m.getName())) {
                            injectInputEventMethod = m;
                            break;
                        }
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "Shizuku IInputManager reflection setup note: " + t.getMessage());
        }

        if (injectInputEventMethod == null) {
            try {
                android.hardware.input.InputManager im = (android.hardware.input.InputManager) context.getSystemService(Context.INPUT_SERVICE);
                if (im != null) {
                    inputManagerInstance = im;
                    for (Method m : im.getClass().getMethods()) {
                        if ("injectInputEvent".equals(m.getName())) {
                            injectInputEventMethod = m;
                            break;
                        }
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "InputManager fallback setup note: " + t.getMessage());
            }
        }

        initialized = true;
        updateStatus();
    }

    public void updateStatus() {
        if (hasShizukuPermission()) {
            if (statusListener != null) statusListener.onStatusChanged("ready", null);
        } else if (isShizukuAvailable()) {
            if (statusListener != null) statusListener.onStatusChanged("missing", "permission_needed");
        } else {
            if (statusListener != null) statusListener.onStatusChanged("missing", "shizuku_not_running");
        }
    }

    /**
     * Injects one joystick report.
     * @param padIndex Pad slot (0-3)
     * @param lx Left Stick X (-1000 to 1000)
     * @param ly Left Stick Y (-1000 to 1000)
     * @param rx Right Stick X (-1000 to 1000)
     * @param ry Right Stick Y (-1000 to 1000)
     * @param lt Left Trigger (0 to 255)
     * @param rt Right Trigger (0 to 255)
     * @param buttons Button bitmask
     */
    public void reportState(int padIndex, int lx, int ly, int rx, int ry, int lt, int rt, int buttons) {
        if (padIndex < 0 || padIndex >= 4) return;
        if (!initialized) initialize();

        int prev = lastButtons[padIndex];
        lastButtons[padIndex] = buttons;

        checkButton(prev, buttons, BTN_A, KeyEvent.KEYCODE_BUTTON_A);
        checkButton(prev, buttons, BTN_B, KeyEvent.KEYCODE_BUTTON_B);
        checkButton(prev, buttons, BTN_X, KeyEvent.KEYCODE_BUTTON_X);
        checkButton(prev, buttons, BTN_Y, KeyEvent.KEYCODE_BUTTON_Y);
        checkButton(prev, buttons, BTN_LB, KeyEvent.KEYCODE_BUTTON_L1);
        checkButton(prev, buttons, BTN_RB, KeyEvent.KEYCODE_BUTTON_R1);
        checkButton(prev, buttons, BTN_START, KeyEvent.KEYCODE_BUTTON_START);
        checkButton(prev, buttons, BTN_BACK, KeyEvent.KEYCODE_BUTTON_SELECT);

        checkButton(prev, buttons, BTN_DPAD_UP, KeyEvent.KEYCODE_DPAD_UP);
        checkButton(prev, buttons, BTN_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_DOWN);
        checkButton(prev, buttons, BTN_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_LEFT);
        checkButton(prev, buttons, BTN_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_RIGHT);

        dispatchMotionAxes(lx, ly, rx, ry, lt, rt);
    }

    private void checkButton(int prev, int current, int mask, int keyCode) {
        boolean wasPressed = (prev & mask) != 0;
        boolean isPressed = (current & mask) != 0;
        if (isPressed && !wasPressed) {
            injectKey(keyCode, KeyEvent.ACTION_DOWN);
        } else if (!isPressed && wasPressed) {
            injectKey(keyCode, KeyEvent.ACTION_UP);
        }
    }

    private void injectKey(int keyCode, int action) {
        long now = SystemClock.uptimeMillis();
        long downTime = now;
        if (action == KeyEvent.ACTION_DOWN) {
            if (keyCode >= 0 && keyCode < downTimes.length) {
                downTimes[keyCode] = now;
            }
        } else if (action == KeyEvent.ACTION_UP) {
            if (keyCode >= 0 && keyCode < downTimes.length && downTimes[keyCode] > 0) {
                downTime = downTimes[keyCode];
            }
        }

        KeyEvent event = new KeyEvent(
                downTime,
                now,
                action,
                keyCode,
                0,
                0,
                KeyCharacterMap.VIRTUAL_KEYBOARD,
                0,
                KeyEvent.FLAG_FROM_SYSTEM,
                InputDevice.SOURCE_GAMEPAD | InputDevice.SOURCE_JOYSTICK
        );

        injectEvent(event);
    }

    private void dispatchMotionAxes(int lx, int ly, int rx, int ry, int lt, int rt) {
        long now = SystemClock.uptimeMillis();
        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[1];
        props[0] = new MotionEvent.PointerProperties();
        props[0].id = 0;
        props[0].toolType = MotionEvent.TOOL_TYPE_UNKNOWN;

        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[1];
        coords[0] = new MotionEvent.PointerCoords();

        float normLx = Math.max(-1.0f, Math.min(1.0f, (float) lx / 1000.0f));
        float normLy = Math.max(-1.0f, Math.min(1.0f, (float) ly / 1000.0f));
        float normRx = Math.max(-1.0f, Math.min(1.0f, (float) rx / 1000.0f));
        float normRy = Math.max(-1.0f, Math.min(1.0f, (float) ry / 1000.0f));
        float normLt = Math.max(0.0f, Math.min(1.0f, (float) lt / 255.0f));
        float normRt = Math.max(0.0f, Math.min(1.0f, (float) rt / 255.0f));

        coords[0].setAxisValue(MotionEvent.AXIS_X, normLx);
        coords[0].setAxisValue(MotionEvent.AXIS_Y, normLy);
        coords[0].setAxisValue(MotionEvent.AXIS_Z, normRx);
        coords[0].setAxisValue(MotionEvent.AXIS_RZ, normRy);
        coords[0].setAxisValue(MotionEvent.AXIS_LTRIGGER, normLt);
        coords[0].setAxisValue(MotionEvent.AXIS_RTRIGGER, normRt);
        coords[0].setAxisValue(MotionEvent.AXIS_BRAKE, normLt);
        coords[0].setAxisValue(MotionEvent.AXIS_GAS, normRt);

        try {
            MotionEvent event = MotionEvent.obtain(
                    now,
                    now,
                    MotionEvent.ACTION_MOVE,
                    1,
                    props,
                    coords,
                    0,
                    0,
                    1.0f,
                    1.0f,
                    0,
                    0,
                    InputDevice.SOURCE_JOYSTICK | InputDevice.SOURCE_GAMEPAD,
                    0
            );

            injectEvent(event);
            event.recycle();
        } catch (Throwable t) {
            Log.e(TAG, "Failed to create MotionEvent", t);
        }
    }

    private void injectEvent(Object event) {
        if (injectInputEventMethod != null && inputManagerInstance != null) {
            try {
                injectInputEventMethod.invoke(inputManagerInstance, event, injectMode);
            } catch (Throwable t) {
                Log.e(TAG, "injectEvent failed via reflection: " + t.getMessage());
            }
        }
    }

    public void release() {
        for (int i = 0; i < 4; i++) {
            lastButtons[i] = 0;
        }
    }
}
