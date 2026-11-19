package in.rodix.link;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

// Launching this device's apps from a paired device: the remote asks for the list of launchable
// apps (link.apps.request), gets names and small icons back (link.apps.list), and starts one by its
// package name (link.apps.launch). Used by the Remote Input screen to give a TV one-tap app buttons.
// Needs the <queries> entries in the manifest to see other apps, and "Display Over Other Apps" to be
// allowed to open an app while Link is not in front.
final class LinkApps {
    static final String PACKET_REQUEST = "link.apps.request";
    static final String PACKET_LIST = "link.apps.list";
    static final String PACKET_LAUNCH = "link.apps.launch";

    private static final int ICON_PX = 72;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private LinkApps() {
    }

    /** Every app with a launcher entry (TV or normal), Link included, sorted by name. */
    static LinkPacket buildListPacket(Context context) {
        PackageManager pm = context.getPackageManager();
        Map<String, JSONObject> byPackage = new LinkedHashMap<>();
        for (String category : new String[] {Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER}) {
            Intent query = new Intent(Intent.ACTION_MAIN).addCategory(category);
            for (ResolveInfo info : pm.queryIntentActivities(query, 0)) {
                String pkg = info.activityInfo.packageName;
                if (byPackage.containsKey(pkg)) continue;
                try {
                    JSONObject app = new JSONObject();
                    app.put("package", pkg);
                    app.put("label", info.loadLabel(pm).toString());
                    String icon = iconBase64(info.loadIcon(pm));
                    if (icon != null) app.put("icon", icon);
                    byPackage.put(pkg, app);
                } catch (Exception e) {
                    android.util.Log.w("LinkApps", "Skipping " + pkg, e);
                }
            }
        }
        List<JSONObject> apps = new ArrayList<>(byPackage.values());
        Collections.sort(apps, (a, b) -> a.optString("label").compareToIgnoreCase(b.optString("label")));
        JSONArray array = new JSONArray();
        for (JSONObject app : apps) array.put(app);
        try {
            return new LinkPacket(PACKET_LIST, new JSONObject().put("apps", array));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Opens the app, on the main thread. Returns false when it has no launcher entry. */
    static boolean launch(Context context, String packageName) {
        if (packageName == null || packageName.isEmpty()) return false;
        PackageManager pm = context.getPackageManager();
        Intent intent = pm.getLeanbackLaunchIntentForPackage(packageName);
        if (intent == null) intent = pm.getLaunchIntentForPackage(packageName);
        if (intent == null) return false;
        final Intent launch = intent;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        final Context app = context.getApplicationContext();
        main.post(() -> {
            try {
                app.startActivity(launch);
            } catch (Exception e) {
                android.util.Log.w("LinkApps", "Could not launch " + packageName, e);
            }
        });
        return true;
    }

    private static String iconBase64(Drawable drawable) {
        if (drawable == null) return null;
        Bitmap bitmap = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawable.setBounds(0, 0, ICON_PX, ICON_PX);
        drawable.draw(canvas);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        bitmap.recycle();
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }
}
