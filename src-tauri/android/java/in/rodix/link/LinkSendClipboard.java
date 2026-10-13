package in.rodix.link;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;
import android.widget.Toast;

// Invisible trampoline for the "Send Clipboard" notification action.
//
// Android 10+ denies clipboard reads to apps that aren't currently in focus (an Activity actually
// resumed) — a plain BroadcastReceiver fired by tapping a notification action never satisfies
// that, so ClipboardManager.getPrimaryClip() silently returns null there (confirmed via logcat:
// "ClipboardService: Denying clipboard access ... application is not in focus"). Launching this
// no-UI Activity instead briefly puts the app in focus, which is enough for the OS to allow the
// read; it then sends the content to peers and finishes itself immediately with no visible frame
// (see the Theme.Translucent.NoTitleBar + noHistory/excludeFromRecents manifest entry).
//
// The read must happen in onWindowFocusChanged(true), not onCreate()/onResume() — those fire
// before the window manager has actually granted real input focus to this window, so a clipboard
// read performed there is still treated as "not in focus" and silently denied (confirmed via
// logcat: even with this Activity as the resumed topActivity, the read was still denied in
// onCreate). onWindowFocusChanged(true) is the actual signal that focus has been granted.
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
