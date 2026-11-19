package in.rodix.link;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.telephony.TelephonyManager;
import org.json.JSONObject;

public class LinkTelephony {
    public static final String PACKET_TYPE_TELEPHONY = "link.telephony";
    public static final String PACKET_TYPE_TELEPHONY_REQUEST = "link.telephony.request";
    private static final String CALL_CHANNEL_ID = "link_call_channel_v2";

    public static boolean isTelephonyPacket(LinkPacket packet) {
        return PACKET_TYPE_TELEPHONY.equals(packet.type);
    }

    public static boolean isTelephonyRequestPacket(LinkPacket packet) {
        return PACKET_TYPE_TELEPHONY_REQUEST.equals(packet.type);
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

    /** Asks the ringing peer to "mute", "reject" or "accept" its call (handleTelephonyRequestPacket). */
    public static LinkPacket createRequestPacket(String action) {
        try {
            JSONObject body = new JSONObject();
            body.put("action", action);
            return new LinkPacket(PACKET_TYPE_TELEPHONY_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createCancelPacket(LinkPacket lastPacket) {
        try {
            JSONObject body = new JSONObject(lastPacket.body.toString());
            body.put("isCancel", "true");
            // A cancel only clears the call, so the contact photo is not sent again.
            body.remove("iconBase64");
            return new LinkPacket(PACKET_TYPE_TELEPHONY, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // Name and photo per number for the call in progress: one call sends ringing, talking and
    // missed-call packets for the same number, and each would otherwise query the contacts and
    // re-encode the photo. Cleared when the call ends, so contact edits show on the next call.
    private static final java.util.Map<String, String[]> contactCache = new java.util.concurrent.ConcurrentHashMap<>();

    /** { name, photoBase64 } for the number, either possibly null; looked up once per call. */
    public static String[] lookupContact(Context context, String phoneNumber) {
        if (phoneNumber == null || phoneNumber.isEmpty()) return new String[]{ null, null };
        String[] cached = contactCache.get(phoneNumber);
        if (cached != null) return cached;
        String[] found = new String[]{ lookupContactName(context, phoneNumber), lookupContactPhotoBase64(context, phoneNumber) };
        contactCache.put(phoneNumber, found);
        return found;
    }

    public static void clearContactCache() {
        contactCache.clear();
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

    /** The matching contact's photo as a small base64 PNG, or null if there is none; the desktop
     *  then shows a generic call icon. */
    public static String lookupContactPhotoBase64(Context context, String phoneNumber) {
        if (phoneNumber == null || phoneNumber.isEmpty()) return null;
        Cursor cursor = null;
        try {
            Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phoneNumber));
            String[] projection = new String[]{ ContactsContract.PhoneLookup.PHOTO_URI };
            cursor = context.getContentResolver().query(uri, projection, null, null, null);
            if (cursor == null || !cursor.moveToFirst()) return null;

            int photoIndex = cursor.getColumnIndex(ContactsContract.PhoneLookup.PHOTO_URI);
            String photoUriStr = photoIndex != -1 ? cursor.getString(photoIndex) : null;
            if (photoUriStr == null) return null;

            return encodePhotoUri(context, Uri.parse(photoUriStr));
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to lookup contact photo", e);
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private static String encodePhotoUri(Context context, Uri photoUri) {
        try (java.io.InputStream is = context.getContentResolver().openInputStream(photoUri)) {
            if (is == null) return null;
            android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeStream(is);
            if (bitmap == null) return null;

            android.graphics.Bitmap resized = android.graphics.Bitmap.createScaledBitmap(bitmap, 96, 96, true);
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            resized.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, baos);
            return android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception ignored) {
            return null;
        }
    }

    /** Shows or clears a notification for a peer's call state. Mirrors on_telephony() in
     *  core/host.rs. Each source device gets its own notification ID, so calls on different
     *  devices do not overwrite each other. */
    public static void showRemoteCallNotification(Context context, String deviceId, String event, String phoneNumber, String contactName, String iconBase64) {
        android.app.NotificationManager nm = (android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        int notifId = ("link-call-" + deviceId).hashCode();

        if ("cancelled".equals(event)) {
            nm.cancel(notifId);
            return;
        }
        if (!"ringing".equals(event) && !"talking".equals(event) && !"missedCall".equals(event)) return;

        ensureNotificationChannel(context, nm);

        String name = contactName != null ? contactName : (phoneNumber != null ? phoneNumber : "Unknown Caller");
        String text = getNotificationText(event, phoneNumber);
        boolean ongoing = "ringing".equals(event) || "talking".equals(event);

        android.app.Notification.Builder builder = createNotificationBuilder(context);
        builder.setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(name)
            .setContentText(text)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setCategory(android.app.Notification.CATEGORY_CALL);

        if ("ringing".equals(event)) {
            android.net.Uri ringtoneUri = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE);
            builder.setSound(ringtoneUri);
            builder.setVibrate(new long[]{0, 1000, 1000, 1000});

            try {
                android.content.Intent fullScreenIntent = new android.content.Intent(context, MainActivity.class);
                fullScreenIntent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP);
                android.app.PendingIntent fullScreenPendingIntent = android.app.PendingIntent.getActivity(
                    context,
                    notifId,
                    fullScreenIntent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
                );
                builder.setFullScreenIntent(fullScreenPendingIntent, true);
            } catch (Exception ignored) {}
        }

        if (iconBase64 != null) {
            try {
                byte[] bytes = android.util.Base64.decode(iconBase64, android.util.Base64.NO_WRAP);
                android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp != null) builder.setLargeIcon(bmp);
            } catch (Exception ignored) {
                // Malformed icon from the peer: show no large icon.
            }
        }

        if ("ringing".equals(event)) {
            // The peer is the one ringing, so "Mute" asks it to silence its ringer (handled by
            // LinkTelephonyNotifications via ACTION_MUTE_REMOTE_RINGER).
            android.content.Intent muteIntent = new android.content.Intent(LinkTelephonyNotifications.ACTION_MUTE_REMOTE_RINGER);
            muteIntent.setPackage(context.getPackageName());
            muteIntent.putExtra(LinkTelephonyNotifications.EXTRA_MUTE_DEVICE_ID, deviceId);
            android.app.PendingIntent mutePendingIntent = android.app.PendingIntent.getBroadcast(
                context,
                notifId,
                muteIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
            );
            android.app.Notification.Action muteAction = new android.app.Notification.Action.Builder(
                android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.ic_lock_silent_mode),
                "Mute",
                mutePendingIntent
            ).build();
            builder.addAction(muteAction);
        }

        android.app.Notification notification = builder.build();
        if ("ringing".equals(event)) {
            // Loops the ringtone until the user interacts or the call ends.
            notification.flags |= android.app.Notification.FLAG_INSISTENT;
        }
        nm.notify(notifId, notification);
    }

    private static void ensureNotificationChannel(Context context, android.app.NotificationManager nm) {
        android.app.NotificationChannel channel = new android.app.NotificationChannel(
            CALL_CHANNEL_ID, "Incoming Calls (Linked Devices)", android.app.NotificationManager.IMPORTANCE_HIGH);
        android.net.Uri ringtoneUri = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE);
        channel.setSound(ringtoneUri, new android.media.AudioAttributes.Builder()
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .build());
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 1000, 1000, 1000});
        nm.createNotificationChannel(channel);
    }

    private static String getNotificationText(String event, String phoneNumber) {
        if ("ringing".equals(event)) {
            return phoneNumber != null ? "Ringing: " + phoneNumber : "Incoming Call";
        }
        if ("talking".equals(event)) {
            return "On call" + (phoneNumber != null ? " — " + phoneNumber : "");
        }
        return phoneNumber != null ? "Missed call from: " + phoneNumber : "Missed Call";
    }

    private static android.app.Notification.Builder createNotificationBuilder(Context context) {
        return new android.app.Notification.Builder(context, CALL_CHANNEL_ID);
    }

    // Set when silenceRinger muted the ring stream, so restoreRinger unmutes it once the call is
    // answered or over; otherwise the phone would stay silent for every later call.
    private static volatile boolean ringerMutedByLink = false;

    public static void silenceRinger(Context context) {
        try {
            android.media.AudioManager am = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                // A ringer the user had already muted is left for them to unmute.
                boolean alreadyMuted = am.isStreamMute(android.media.AudioManager.STREAM_RING);
                am.adjustStreamVolume(android.media.AudioManager.STREAM_RING, android.media.AudioManager.ADJUST_MUTE, 0);
                if (!alreadyMuted) ringerMutedByLink = true;
                android.util.Log.i("LinkTelephony", "Ringer silenced remotely via AudioManager");
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to silence ringer", e);
        }
    }

    /** Unmutes the ring stream if silenceRinger muted it. Called when the call is answered or ends. */
    public static void restoreRinger(Context context) {
        if (!ringerMutedByLink) return;
        ringerMutedByLink = false;
        try {
            android.media.AudioManager am = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.adjustStreamVolume(android.media.AudioManager.STREAM_RING, android.media.AudioManager.ADJUST_UNMUTE, 0);
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to restore ringer", e);
        }
    }

    public static void acceptCall(Context context) {
        try {
            android.telecom.TelecomManager tm = (android.telecom.TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
            if (tm != null) {
                if (context.checkSelfPermission(android.Manifest.permission.ANSWER_PHONE_CALLS) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    tm.acceptRingingCall();
                    android.util.Log.i("LinkTelephony", "Accepted ringing call via TelecomManager.acceptRingingCall()");
                    return;
                } else {
                    android.util.Log.w("LinkTelephony", "Cannot accept call: ANSWER_PHONE_CALLS permission not granted");
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to accept call via TelecomManager", e);
        }
    }

    public static void endCall(Context context) {
        try {
            android.telecom.TelecomManager tm = (android.telecom.TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
            if (tm != null) {
                if (context.checkSelfPermission(android.Manifest.permission.ANSWER_PHONE_CALLS) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    boolean ended = tm.endCall();
                    android.util.Log.i("LinkTelephony", "Ended call via TelecomManager.endCall(): " + ended);
                    return;
                } else {
                    android.util.Log.w("LinkTelephony", "Cannot end call: ANSWER_PHONE_CALLS permission not granted");
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to end call via TelecomManager", e);
        }
        // If the call could not be ended, at least silence the ringer.
        silenceRinger(context);
    }
}
