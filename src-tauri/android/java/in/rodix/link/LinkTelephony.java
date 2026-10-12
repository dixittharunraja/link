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
                // Malformed icon data from the peer — fall back to no large icon.
            }
        }

        if ("ringing".equals(event)) {
            // This device isn't the one physically ringing — "Mute" relays a request back to the
            // peer (deviceId) to silence its own ringer, via LinkPlugin's ringer-mute request.
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

        android.app.Notification notification = builder.build();
        if ("ringing".equals(event)) {
            // INSISTENT loops the ringtone audio continuously until the user interacts or the call ends.
            notification.flags |= android.app.Notification.FLAG_INSISTENT;
        }
        nm.notify(notifId, notification);
    }

    private static void ensureNotificationChannel(Context context, android.app.NotificationManager nm) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
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
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            return new android.app.Notification.Builder(context, CALL_CHANNEL_ID);
        }
        return new android.app.Notification.Builder(context);
    }

    public static void silenceRinger(Context context) {
        try {
            android.media.AudioManager am = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.adjustStreamVolume(android.media.AudioManager.STREAM_RING, android.media.AudioManager.ADJUST_MUTE, 0);
                android.util.Log.i("LinkTelephony", "Ringer silenced remotely via AudioManager");
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to silence ringer", e);
        }
    }

    public static void acceptCall(Context context) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
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
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to accept call via TelecomManager", e);
        }
    }

    public static void endCall(Context context) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
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
            }
        } catch (Exception e) {
            android.util.Log.e("LinkTelephony", "Failed to end call via TelecomManager", e);
        }
        // Fallback: at minimum silence ringer so phone stops buzzing
        silenceRinger(context);
    }
}
