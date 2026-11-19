package in.rodix.link;

import app.tauri.plugin.JSObject;

// This phone's own settings screens and window: the special-access grants Link needs (notification
// listener, all-files access, Do Not Disturb, battery optimization, accessibility), each checked and
// opened from the UI, plus immersive mode, gesture exclusion and moving the app to the background.
final class LinkSystemSettings extends LinkFeature {
    LinkSystemSettings(LinkPlugin plugin) {
        super(plugin);
    }

    @LinkMethod
    public void checkDndPermission(LinkCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", LinkDND.isDndGranted(getContext()));
        call.resolve(ret);
    }

    @LinkMethod
    public void requestDndPermission(LinkCall call) {
        // Opens the OS settings page whether or not access is granted, since the same page is
        // used to grant and to revoke it.
        android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
        if (getActivity() != null) {
            getActivity().startActivity(intent);
        } else {
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    /** Back button with no in-app view to close (see MainActivity.onBackPressed() and backNav.ts):
     *  moves the app to the background without finishing it. */
    @LinkMethod
    public void minimizeApp(LinkCall call) {
        if (getActivity() != null) {
            getActivity().moveTaskToBack(true);
        }
        call.resolve();
    }

    @LinkMethod
    public void checkNotificationAccess(LinkCall call) {
        boolean enabled = androidx.core.app.NotificationManagerCompat
                .getEnabledListenerPackages(getContext())
                .contains(getContext().getPackageName());
        JSObject data = new JSObject();
        data.put("enabled", enabled);
        call.resolve(data);
    }

    @LinkMethod
    public void requestNotificationAccess(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open notification settings: " + e.getMessage());
        }
    }

    // MANAGE_EXTERNAL_STORAGE ("All files access"): on Android 11+ scoped storage returns empty
    // java.io.File listings outside the app's own collections. It cannot be requested at runtime;
    // the user enables it on a dedicated Settings screen.
    @LinkMethod
    public void checkAllFilesAccess(LinkCall call) {
        boolean enabled = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R
                || android.os.Environment.isExternalStorageManager();
        JSObject data = new JSObject();
        data.put("enabled", enabled);
        call.resolve(data);
    }

    @LinkMethod
    public void requestAllFilesAccess(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                android.content.Intent fallback = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Failed to open all-files-access settings: " + e2.getMessage());
            }
        }
    }

    @LinkMethod
    public void openAppSettings(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            android.net.Uri uri = android.net.Uri.fromParts("package", getContext().getPackageName(), null);
            intent.setData(uri);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open app settings: " + e.getMessage());
        }
    }

    @LinkMethod
    public void isBatteryOptimizationIgnored(LinkCall call) {
        android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        boolean isIgnoring = pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject ret = new JSObject();
        ret.put("isIgnoring", isIgnoring);
        call.resolve(ret);
    }

    @LinkMethod
    public void requestIgnoreBatteryOptimizations(LinkCall call) {
        android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        try {
            if (!pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
                android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);

                try {
                    getContext().startActivity(intent);
                } catch (android.content.ActivityNotFoundException e) {
                    // Fall back to the general battery optimization list.
                    android.content.Intent fallback = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallback);
                }
            } else {
                // Revoking or viewing: the list screen, which takes no package URI.
                android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getContext().startActivity(intent);
                } catch (android.content.ActivityNotFoundException e) {
                    android.content.Intent fallback = new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    fallback.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                    fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallback);
                }
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to launch battery optimization settings", e);
        }
        call.resolve();
    }

    // Remote Input (LinkRemoteInput/LinkAccessibilityService) needs the accessibility service.
    // Android offers no dialog or API to enable it, so this opens the Accessibility settings.
    @LinkMethod
    public void checkAccessibility(LinkCall call) {
        boolean enabled = false;
        try {
            String enabledServices = android.provider.Settings.Secure.getString(
                getContext().getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String myService = getContext().getPackageName() + "/" + LinkAccessibilityService.class.getName();
            enabled = enabledServices != null && enabledServices.contains(myService);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to check accessibility service state", e);
        }
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @LinkMethod
    public void requestAccessibility(LinkCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to launch accessibility settings", e);
        }
        call.resolve();
    }

    @LinkMethod
    public void setImmersiveMode(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                try {
                    android.view.Window window = getActivity().getWindow();
                    if (window != null) {
                        // With the status bar hidden, Android's default keeps the app out of the camera
                        // cutout strip, which leaves a black band where the bar was. Draw into it while
                        // full screen, and go back to the default afterwards.
                        android.view.WindowManager.LayoutParams attrs = window.getAttributes();
                        int mode = !enabled
                            ? android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
                            : android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R
                                ? android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                                : android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                        if (attrs.layoutInDisplayCutoutMode != mode) {
                            attrs.layoutInDisplayCutoutMode = mode;
                            window.setAttributes(attrs);
                        }
                        androidx.core.view.WindowInsetsControllerCompat controller =
                            androidx.core.view.WindowCompat.getInsetsController(window, window.getDecorView());
                        if (controller != null) {
                            if (enabled) {
                                controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
                                controller.setSystemBarsBehavior(
                                    androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                                );
                            } else {
                                controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars());
                            }
                        }
                    }
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to set immersive mode: " + e.getMessage());
                }
            });
        }
        call.resolve();
    }

    // Remote Control's fullscreen mirror needs edge touches too, but gesture navigation claims
    // edge swipes even in immersive mode. Excluding the decor view from system gestures gives
    // them to the WebView; the UI clears it on unmount so normal back gestures return.
    private android.view.View.OnLayoutChangeListener gestureExclusionListener;

    @LinkMethod
    public void setSystemGestureExclusion(LinkCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                try {
                    android.view.View decorView = getActivity().getWindow().getDecorView();
                    if (gestureExclusionListener != null) {
                        decorView.removeOnLayoutChangeListener(gestureExclusionListener);
                        gestureExclusionListener = null;
                    }
                    if (enabled) {
                        // The rect must follow the view's size: the session rotates to landscape after
                        // this is first set, which would leave a stale portrait-sized rect.
                        gestureExclusionListener = (v, l, t, r, b, ol, ot, or, ob) ->
                            v.setSystemGestureExclusionRects(java.util.Collections.singletonList(
                                new android.graphics.Rect(0, 0, r - l, b - t)));
                        decorView.addOnLayoutChangeListener(gestureExclusionListener);
                        decorView.post(() -> decorView.setSystemGestureExclusionRects(
                            java.util.Collections.singletonList(
                                new android.graphics.Rect(0, 0, decorView.getWidth(), decorView.getHeight()))));
                    } else {
                        decorView.setSystemGestureExclusionRects(java.util.Collections.emptyList());
                    }
                } catch (Exception e) {
                    android.util.Log.e(TAG, "Failed to set system gesture exclusion: " + e.getMessage());
                }
            });
        }
        call.resolve();
    }
}
