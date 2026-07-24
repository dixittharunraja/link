package in.rodix.link;

// System volume plugin — port of kdeconnect-android's plugins/systemvolume/SystemVolumePlugin.kt.
// Phone-side role: render the desktop's sinkList (SCOPED DOWN on the desktop side to a single
// "default" sink — see desktop/src/core/plugins/systemvolume.ts) and send request packets to
// change it. No Android permission needed for this direction — the phone only sends network
// packets, it never touches its own audio hardware.

import org.json.JSONArray;
import org.json.JSONObject;

public class LinkSystemVolume {
    public static final String PACKET_TYPE_SYSTEMVOLUME = "link.systemvolume";
    public static final String PACKET_TYPE_SYSTEMVOLUME_REQUEST = "link.systemvolume.request";

    public static class Sink {
        public final String name;
        public final String description;
        public final int volume;
        public final boolean muted;
        public final int maxVolume;
        public final boolean enabled;

        Sink(String name, String description, int volume, boolean muted, int maxVolume, boolean enabled) {
            this.name = name;
            this.description = description;
            this.volume = volume;
            this.muted = muted;
            this.maxVolume = maxVolume;
            this.enabled = enabled;
        }
    }

    /** Extracts the first (only, given our desktop's single-sink scope) sink from an incoming state packet. */
    public static Sink firstSink(LinkPacket packet) {
        try {
            JSONArray sinkList = packet.body.getJSONArray("sinkList");
            if (sinkList.length() == 0) return null;
            JSONObject sink = sinkList.getJSONObject(0);
            return new Sink(
                    sink.getString("name"),
                    sink.optString("description", sink.getString("name")),
                    sink.getInt("volume"),
                    sink.optBoolean("muted", false),
                    sink.optInt("maxVolume", 100),
                    sink.optBoolean("enabled", true)
            );
        } catch (Exception e) {
            return null;
        }
    }

    public static java.util.List<Sink> allSinks(LinkPacket packet) {
        java.util.List<Sink> list = new java.util.ArrayList<>();
        try {
            JSONArray sinkList = packet.body.getJSONArray("sinkList");
            for (int i = 0; i < sinkList.length(); i++) {
                JSONObject sink = sinkList.getJSONObject(i);
                list.add(new Sink(
                        sink.getString("name"),
                        sink.optString("description", sink.getString("name")),
                        sink.getInt("volume"),
                        sink.optBoolean("muted", false),
                        sink.optInt("maxVolume", 100),
                        sink.optBoolean("enabled", true)
                ));
            }
        } catch (Exception ignored) {}
        return list;
    }

    public static LinkPacket createSetVolumePacket(String sinkName, int volume) {
        try {
            JSONObject body = new JSONObject();
            body.put("name", sinkName);
            body.put("volume", volume);
            return new LinkPacket(PACKET_TYPE_SYSTEMVOLUME_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createSetMutePacket(String sinkName, boolean muted) {
        try {
            JSONObject body = new JSONObject();
            body.put("name", sinkName);
            body.put("muted", muted);
            return new LinkPacket(PACKET_TYPE_SYSTEMVOLUME_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createRequestSinksPacket() {
        try {
            JSONObject body = new JSONObject();
            body.put("requestSinks", true);
            return new LinkPacket(PACKET_TYPE_SYSTEMVOLUME_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static LinkPacket createLocalSinksPacket(android.media.AudioManager audio) {
        try {
            JSONArray sinkList = new JSONArray();
            int[] streams = {
                android.media.AudioManager.STREAM_MUSIC,
                android.media.AudioManager.STREAM_NOTIFICATION,
                android.media.AudioManager.STREAM_ALARM
            };
            String[] names = {"media", "notification", "alarm"};
            String[] descriptions = {"Media", "Notification", "Alarm"};

            for (int i = 0; i < streams.length; i++) {
                int stream = streams[i];
                JSONObject sink = new JSONObject();
                sink.put("name", names[i]);
                sink.put("description", descriptions[i]);
                sink.put("volume", audio.getStreamVolume(stream));
                sink.put("maxVolume", audio.getStreamMaxVolume(stream));
                boolean isMuted = false;
                if (android.os.Build.VERSION.SDK_INT >= 23) {
                    isMuted = audio.isStreamMute(stream);
                } else {
                    isMuted = audio.getStreamVolume(stream) == 0;
                }
                sink.put("muted", isMuted);
                sink.put("enabled", true);
                sinkList.put(sink);
            }

            JSONObject body = new JSONObject();
            body.put("sinkList", sinkList);
            return new LinkPacket(PACKET_TYPE_SYSTEMVOLUME, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static void handleLocalVolumeRequest(LinkPacket packet, android.media.AudioManager audio) {
        try {
            if (packet.body.optBoolean("requestSinks")) {
                return;
            }

            String name = packet.body.optString("name");
            if (name.isEmpty()) return;

            int streamType = -1;
            if ("media".equals(name)) streamType = android.media.AudioManager.STREAM_MUSIC;
            else if ("notification".equals(name)) streamType = android.media.AudioManager.STREAM_NOTIFICATION;
            else if ("ring".equals(name)) streamType = android.media.AudioManager.STREAM_RING;
            else if ("alarm".equals(name)) streamType = android.media.AudioManager.STREAM_ALARM;
            else if ("system".equals(name)) streamType = android.media.AudioManager.STREAM_SYSTEM;

            if (streamType == -1) return;

            if (packet.body.has("volume")) {
                int volume = packet.body.getInt("volume");
                audio.setStreamVolume(streamType, volume, 0);
            }

            if (packet.body.has("muted")) {
                boolean muted = packet.body.getBoolean("muted");
                if (streamType == android.media.AudioManager.STREAM_NOTIFICATION || streamType == android.media.AudioManager.STREAM_RING) {
                    try {
                        audio.setRingerMode(muted ? android.media.AudioManager.RINGER_MODE_SILENT : android.media.AudioManager.RINGER_MODE_NORMAL);
                    } catch (SecurityException e) {
                        audio.setRingerMode(muted ? android.media.AudioManager.RINGER_MODE_VIBRATE : android.media.AudioManager.RINGER_MODE_NORMAL);
                    }
                } else if (android.os.Build.VERSION.SDK_INT >= 23) {
                    int direction = muted ? android.media.AudioManager.ADJUST_MUTE : android.media.AudioManager.ADJUST_UNMUTE;
                    audio.adjustStreamVolume(streamType, direction, 0);
                }
            }
        } catch (Exception e) {
            android.util.Log.e("LinkSystemVolume", "Error handling volume request", e);
        }
    }
}
