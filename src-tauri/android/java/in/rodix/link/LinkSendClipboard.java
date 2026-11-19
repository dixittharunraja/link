package in.rodix.link;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;
import android.widget.Toast;

// Invisible trampoline Activity for the "Send Clipboard" notification action.
//
// Android 10+ only allows clipboard reads from the app that has input focus, so a
// BroadcastReceiver gets null from getPrimaryClip(). This translucent, no-history Activity
// briefly takes focus, sends the clipboard to peers and finishes.
//
// The read happens in onWindowFocusChanged(true): in onCreate()/onResume() the window does not
// have focus yet and the read is still denied.
public class LinkSendClipboard extends Activity {
    private static final String TAG = "LinkSendClipboard";
    private boolean handled = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus || handled) return;
        handled = true;

        Context context = getApplicationContext();
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null && clipboard.hasPrimaryClip()) {
            ClipData clip = clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence text = clip.getItemAt(0).getText();
                if (text != null) {
                    String content = text.toString();
                    Log.i(TAG, "Send Clipboard (trampoline) content length: " + content.length());
                    LinkDeviceManager deviceManager = LinkPlugin.sDeviceManager;
                    if (deviceManager != null) {
                        for (String peerId : deviceManager.trustedConnectedDeviceIds()) {
                            if (!LinkPlugin.isEnabled("Clipboard")) continue;
                            if (!LinkDevicePermissions.canSendClipboardTo(context, peerId)) continue;
                            deviceManager.sendTo(peerId, LinkClipboard.createClipboardPacket(content));
                        }
                        Toast.makeText(context, "Clipboard sent to connected devices", Toast.LENGTH_SHORT).show();
                    }
                }
            }
        } else {
            Log.i(TAG, "Send Clipboard (trampoline): clipboard empty or inaccessible");
        }

        finish();
        overridePendingTransition(0, 0);
    }
}
