package in.rodix.link;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;

public class MainActivity extends TauriActivity {
    private WebView webView;
    // The running activity, for LinkRemoteInput to offer typed text to the page (null when not in front).
    private static volatile MainActivity sForeground;

    // Wry's default back handling walks the WebView's history; Link is a single-page app that
    // routes back itself (see backNav.ts), so the renderer is told instead via 'linkHardwareBack'.
    @Override
    public boolean getHandleBackNavigation() {
        return false;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        if (isTv()) {
            // The manifest locks portrait for phones; a TV is always landscape.
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }

        // With android:enableOnBackInvokedCallback set (see manifest), back gestures are delivered
        // through OnBackPressedDispatcher callbacks rather than onBackPressed().
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null) {
                    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('linkHardwareBack'));", null);
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
        handleSharedFiles(getIntent());
    }

    // Files shared to "File Transfer (Link)" (ShareActivity) arrive here, as a new launch or into the running app.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSharedFiles(intent);
    }

    private void handleSharedFiles(Intent intent) {
        if (intent == null || !ShareActivity.ACTION_SHARED_FILES.equals(intent.getAction())) return;
        // Handled once: a rotation or recreation must not stage the same files again.
        intent.setAction(Intent.ACTION_MAIN);
        ClipData clip = intent.getClipData();
        if (clip == null) return;
        java.util.List<String> uris = new java.util.ArrayList<>();
        for (int i = 0; i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            if (uri == null) continue;
            try {
                // Only some providers allow it; when they do the files stay readable after this screen is gone.
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            uris.add(uri.toString());
        }
        LinkPlugin.deliverSharedFiles(uris);
    }

    // A TV remote's Back arrives as a key event that the WebView consumes itself (stepping back through
    // its history, which flips tabs behind the app's back). Take it before the WebView sees it and hand
    // it to the renderer like a back gesture.
    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        if (isTv() && event.getKeyCode() == android.view.KeyEvent.KEYCODE_BACK && webView != null) {
            if (event.getAction() == android.view.KeyEvent.ACTION_UP && !event.isCanceled()) {
                webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('linkHardwareBack'));", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private boolean isTv() {
        android.app.UiModeManager uiMode = (android.app.UiModeManager) getSystemService(UI_MODE_SERVICE);
        return uiMode != null && uiMode.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
    }

    @Override
    protected void onResume() {
        super.onResume();
        sForeground = this;
    }

    @Override
    protected void onPause() {
        if (sForeground == this) sForeground = null;
        super.onPause();
    }

    /**
     * Offers remote-input text, Enter or Delete to the page when Link is in front. The page answers true
     * when a text box took it; {@code result} is called on the main thread with that answer. Returns false
     * (and never calls {@code result}) when there is nothing to offer or Link is not in front.
     */
    static boolean offerRemoteInputToPage(String text, String key, android.webkit.ValueCallback<Boolean> result) {
        final MainActivity activity = sForeground;
        final boolean typing = text != null && !text.isEmpty();
        final String upper = key == null ? "" : key.toUpperCase();
        final boolean editKey = upper.equals("DELETE") || upper.equals("BACKSPACE") || upper.equals("ENTER");
        if (activity == null || activity.webView == null || (!typing && !editKey)) return false;
        final String script = "window.__linkRemoteText ? window.__linkRemoteText("
                + org.json.JSONObject.quote(typing ? text : "") + "," + org.json.JSONObject.quote(typing ? "" : upper) + ") : false";
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
            activity.webView.evaluateJavascript(script, value -> result.onReceiveValue("true".equals(value))));
        return true;
    }

    @Override
    public void onWebViewCreate(WebView view) {
        webView = view;
        WebSettings settings = view.getSettings();
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Read synchronously by platform.ts (IS_TV) to switch to the 10-foot layout.
        if (isTv()) settings.setUserAgentString(settings.getUserAgentString() + " LinkTV");
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    }
}
