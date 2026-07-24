package in.rodix.link;

import android.content.Context;
import android.hardware.camera2.CameraManager;
import android.util.Log;
import org.json.JSONObject;

public class LinkFlashlight {
    public static final String PACKET_TYPE_FLASHLIGHT = "link.flashlight";
    private static final String TAG = "LinkFlashlight";
    private static boolean isFlashlightOn = false;

    public static boolean toggle(Context context) {
        try {
            CameraManager cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
            String[] cameraIdList = cameraManager.getCameraIdList();
            if (cameraIdList.length > 0) {
                String cameraId = cameraIdList[0];
                isFlashlightOn = !isFlashlightOn;
                cameraManager.setTorchMode(cameraId, isFlashlightOn);
                return isFlashlightOn;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to toggle flashlight", e);
        }
        return false;
    }

    public static void setTorchMode(Context context, boolean enabled) {
        try {
            CameraManager cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
            String[] cameraIdList = cameraManager.getCameraIdList();
            if (cameraIdList.length > 0) {
                String cameraId = cameraIdList[0];
                isFlashlightOn = enabled;
                cameraManager.setTorchMode(cameraId, enabled);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to set torch mode", e);
        }
    }

    public static boolean isTorchOn() {
        return isFlashlightOn;
    }

    /** Syncs cached state after an external torch change (e.g. Quick Settings tile) was already applied by the OS. */
    public static void setTorchState(boolean enabled) {
        isFlashlightOn = enabled;
    }

    public static LinkPacket createStatusPacket(boolean enabled) {
        try {
            JSONObject body = new JSONObject();
            body.put("enabled", enabled);
            return new LinkPacket(PACKET_TYPE_FLASHLIGHT, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
