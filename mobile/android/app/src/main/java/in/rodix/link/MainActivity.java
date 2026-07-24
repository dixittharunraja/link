package in.rodix.link;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LinkPlugin.class);
        super.onCreate(savedInstanceState);

        android.webkit.WebView.setWebContentsDebuggingEnabled(true);

        // Overriding onBackPressed() alone doesn't reliably catch the gesture-nav swipe on modern
        // Android (13+ predictive back / MIUI's gesture bar): the system's predictive-back
        // dispatch goes through OnBackPressedDispatcher's registered callbacks, NOT the legacy
        // onBackPressed() method, once android:enableOnBackInvokedCallback is set (see manifest)
        // — a plain method override was being bypassed entirely for swipes, only ever catching an
        // actual hardware/software back button, which is why the gesture kept exiting the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                android.webkit.WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null) {
                    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('linkHardwareBack'));", null);
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        // Disable pinch-to-zoom in WebView settings
        this.runOnUiThread(() -> {
            try {
                android.webkit.WebView webView = this.getBridge().getWebView();
                if (webView != null) {
                    android.webkit.WebSettings settings = webView.getSettings();
                    settings.setSupportZoom(false);
                    settings.setBuiltInZoomControls(false);
                    settings.setDisplayZoomControls(false);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }
}
