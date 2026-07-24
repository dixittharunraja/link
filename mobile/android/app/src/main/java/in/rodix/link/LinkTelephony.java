package in.rodix.link;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.telephony.TelephonyManager;
import org.json.JSONObject;

public class LinkTelephony {
    public static final String PACKET_TYPE_TELEPHONY = "link.telephony";
    private static final String CALL_CHANNEL_ID = "link_call_channel";

    public static boolean isTelephonyPacket(LinkPacket packet) {
        return PACKET_TYPE_TELEPHONY.equals(packet.type);
    }

    public static LinkPacket createCallPacket(String event, String phoneNumber, String contactName, String contactPhotoBase64) {
        try {
            JSONObject body = new JSONObject();
            body.put("event", event);
            if (phoneNumber != null) {
                body.put("phoneNumber", phoneNumber);
            }
            if (contactName != null) {
                body.put("contactName", contactName);
            } else if (phoneNumber != null) {
                body.put("contactName", phoneNumber);
            }
            if (contactPhotoBase64 != null) {
                body.put("iconBase64", contactPhotoBase64);
            }
            return new LinkPacket(PACKET_TYPE_TELEPHONY, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createCancelPacket(LinkPacket lastPacket) {
        try {
            JSONObject body = new JSONObject(lastPacket.body.toString());
            body.put("isCancel", "true");
            return new LinkPacket(PACKET_TYPE_TELEPHONY, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static String lookupContactName(Context context, String phoneNumber) {
        if (phoneNumber == null || phoneNumber.isEmpty()) return null;
        Cursor cursor = null;
        try {
            Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phoneNumber));
            String[] projection = new String[]{ ContactsContract.PhoneLookup.DISPLAY_NAME };
            cursor = context.getContentResolver().query(uri, projection, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME);
                if (nameIndex != -1) {
                    return cursor.getString(nameIndex);
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to lookup contact name", e);
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    /** Resolves the caller's saved contact photo as a small base64 PNG, if this number matches a
     * contact that has one. Returns null (no match, no photo, or any failure) — the desktop falls
     * back to a generic call icon in that case, never the misleading Link app icon. */
    public static String lookupContactPhotoBase64(Context context, String phoneNumber) {
        if (phoneNumber == null || phoneNumber.isEmpty()) return null;
        Cursor cursor = null;
        try {
            Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phoneNumber));
            String[] projection = new String[]{ ContactsContract.PhoneLookup.PHOTO_URI };
            cursor = context.getContentResolver().query(uri, projection, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int photoIndex = cursor.getColumnIndex(ContactsContract.PhoneLookup.PHOTO_URI);
                String photoUriStr = photoIndex != -1 ? cursor.getString(photoIndex) : null;
                if (photoUriStr != null) {
                    Uri photoUri = Uri.parse(photoUriStr);
                    try (java.io.InputStream is = context.getContentResolver().openInputStream(photoUri)) {
                        if (is != null) {
                            android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeStream(is);
                            if (bitmap != null) {
                                android.graphics.Bitmap resized = android.graphics.Bitmap.createScaledBitmap(bitmap, 96, 96, true);
                                java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                                resized.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, baos);
                                return android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP);
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to lookup contact photo", e);
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    /** Displays (or clears) a native notification for a peer's call state — the receiving/display
     * half that was entirely missing on Android before: this device could only ever SEND its own
     * call events, never show a peer's. Mirrors desktop main.ts's isTelephonyPacket handler. One
     * notification slot per source deviceId, so simultaneous calls on different linked devices
     * don't clobber each other. */
    public static void showRemoteCallNotification(Context context, String deviceId, String event, String phoneNumber, String contactName, String iconBase64) {
        android.app.NotificationManager nm = (android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        int notifId = ("link-call-" + deviceId).hashCode();

        if ("cancelled".equals(event)) {
            nm.cancel(notifId);
            return;
        }
        if (!"ringing".equals(event) && !"talking".equals(event) && !"missedCall".equals(event)) return;

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                CALL_CHANNEL_ID, "Incoming Calls (Linked Devices)", android.app.NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(channel);
        }

        String name = contactName != null ? contactName : (phoneNumber != null ? phoneNumber : "Unknown Caller");
        String text;
        boolean ongoing;
        if ("ringing".equals(event)) {
            text = phoneNumber != null ? "Ringing: " + phoneNumber : "Incoming Call";
            ongoing = true;
        } else if ("talking".equals(event)) {
            // Answered — was previously just cancelling the notification outright here, so
            // picking up the call gave no feedback at all beyond the ringing notif disappearing.
            // Swap it for an ongoing "in call" notification instead of clearing it; only the
            // "cancelled" event (hangup, either side) above should ever remove it now.
            text = "On call" + (phoneNumber != null ? " — " + phoneNumber : "");
            ongoing = true;
        } else {
            text = phoneNumber != null ? "Missed call from: " + phoneNumber : "Missed Call";
            ongoing = false;
        }

        android.app.Notification.Builder builder;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            builder = new android.app.Notification.Builder(context, CALL_CHANNEL_ID);
        } else {
            builder = new android.app.Notification.Builder(context);
        }
        builder.setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(name)
            .setContentText(text)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setCategory(android.app.Notification.CATEGORY_CALL);

        if (iconBase64 != null) {
            try {
                byte[] bytes = android.util.Base64.decode(iconBase64, android.util.Base64.NO_WRAP);
                android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp != null) builder.setLargeIcon(bmp);
            } catch (Exception ignored) {
                // Malformed icon data from the peer — fall back to no large icon.
            }
        }

        if ("ringing".equals(event)) {
            // This device isn't the one physically ringing — "Mute" relays a request back to the
            // peer (deviceId) to silence its own ringer, via LinkPlugin's muteRemoteRingerReceiver.
            android.content.Intent muteIntent = new android.content.Intent(LinkPlugin.ACTION_MUTE_REMOTE_RINGER);
            muteIntent.setPackage(context.getPackageName());
            muteIntent.putExtra(LinkPlugin.EXTRA_MUTE_DEVICE_ID, deviceId);
            android.app.PendingIntent mutePendingIntent = android.app.PendingIntent.getBroadcast(
                context,
                notifId,
                muteIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
            );
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                android.app.Notification.Action muteAction = new android.app.Notification.Action.Builder(
                    android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.ic_lock_silent_mode),
                    "Mute",
                    mutePendingIntent
                ).build();
                builder.addAction(muteAction);
            } else {
                builder.addAction(android.R.drawable.ic_lock_silent_mode, "Mute", mutePendingIntent);
            }
        }

        nm.notify(notifId, builder.build());
    }
}
