package in.rodix.link;

import android.content.Context;
import android.content.SharedPreferences;

// App settings stored in SharedPreferences. Android counterpart of core/settings.rs.

public class LinkSettings {
    private static final String PREFS_NAME = "link_prefs";
    private final Context context;
    private final SharedPreferences prefs;

    public boolean discoveryVisibility = false;
    /** "Use Tailscale when away": off by default, because away from the LAN it uses internet data. */
    public boolean remoteTailscale = false;

    public LinkSettings(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public void load() {
        discoveryVisibility = prefs.getBoolean("discovery_visibility", false);
        remoteTailscale = prefs.getBoolean("remote_tailscale", false);
    }

    public void saveRemoteTailscale(boolean enabled) {
        remoteTailscale = enabled;
        prefs.edit().putBoolean("remote_tailscale", enabled).apply();
    }

    public void saveDiscoveryVisibility(boolean enabled) {
        discoveryVisibility = enabled;
        prefs.edit().putBoolean("discovery_visibility", enabled).apply();
    }
}
