package in.rodix.link;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;

public class MainActivity extends TauriActivity {
    private WebView webView;

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

        // Overriding onBackPressed() alone doesn't reliably catch the gesture-nav swipe on modern
        // Android (13+ predictive back / MIUI's gesture bar): the system's predictive-back
        // dispatch goes through OnBackPressedDispatcher's registered callbacks, NOT the legacy
        // onBackPressed() method, once android:enableOnBackInvokedCallback is set (see manifest).
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
    }

    @Override
    public void onWebViewCreate(WebView view) {
        webView = view;
        WebSettings settings = view.getSettings();
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    }
}
