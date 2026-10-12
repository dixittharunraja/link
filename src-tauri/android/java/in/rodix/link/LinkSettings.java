package in.rodix.link;

import android.content.Context;
import android.content.SharedPreferences;

// Centralized app settings management.
// Mirrors desktop's app-settings.ts.

public class LinkSettings {
    private static final String PREFS_NAME = "link_prefs";
    private final Context context;
    private final SharedPreferences prefs;

    // Settings with defaults
    public boolean discoveryVisibility = false;

    public LinkSettings(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public void load() {
        discoveryVisibility = prefs.getBoolean("discovery_visibility", false);
    }

    public void saveDiscoveryVisibility(boolean enabled) {
        discoveryVisibility = enabled;
        prefs.edit().putBoolean("discovery_visibility", enabled).apply();
    }
}
