package in.rodix.link;

import org.json.JSONObject;

public class LinkMpris {
    public static final String PACKET_TYPE_MPRIS = "link.mpris";
    public static final String PACKET_TYPE_MPRIS_REQUEST = "link.mpris.request";

    public static boolean isMprisPacket(LinkPacket packet) {
        return PACKET_TYPE_MPRIS.equals(packet.type);
    }

    public static LinkPacket createActionPacket(String player, String action) {
        try {
            JSONObject body = new JSONObject();
            body.put("player", player);
            body.put("action", action);
            return new LinkPacket(PACKET_TYPE_MPRIS_REQUEST, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
    public static void handleMediaRequest(android.content.Context context, LinkPacket packet) {
        String action = packet.body.optString("action");
        if (action == null) return;

        android.media.AudioManager audioManager = (android.media.AudioManager) context.getSystemService(android.content.Context.AUDIO_SERVICE);
        if (audioManager == null) return;

        int keyCode = 0;
        if ("Play".equalsIgnoreCase(action) || "PlayPause".equalsIgnoreCase(action)) {
            keyCode = android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
        } else if ("Pause".equalsIgnoreCase(action)) {
            keyCode = android.view.KeyEvent.KEYCODE_MEDIA_PAUSE;
        } else if ("Next".equalsIgnoreCase(action) || "NextTrack".equalsIgnoreCase(action)) {
            keyCode = android.view.KeyEvent.KEYCODE_MEDIA_NEXT;
        } else if ("Previous".equalsIgnoreCase(action) || "PrevTrack".equalsIgnoreCase(action)) {
            keyCode = android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS;
        } else if ("Stop".equalsIgnoreCase(action)) {
            keyCode = android.view.KeyEvent.KEYCODE_MEDIA_STOP;
        }

        if (keyCode != 0) {
            long eventtime = android.os.SystemClock.uptimeMillis();
            android.view.KeyEvent downEvent = new android.view.KeyEvent(eventtime, eventtime, android.view.KeyEvent.ACTION_DOWN, keyCode, 0);
            audioManager.dispatchMediaKeyEvent(downEvent);
            android.view.KeyEvent upEvent = new android.view.KeyEvent(eventtime, eventtime, android.view.KeyEvent.ACTION_UP, keyCode, 0);
            audioManager.dispatchMediaKeyEvent(upEvent);
        }
    }

    public static LinkPacket createLocalStatePacket(android.content.Context context) {
        try {
            android.media.session.MediaSessionManager mediaSessionManager =
                    (android.media.session.MediaSessionManager) context.getSystemService(android.content.Context.MEDIA_SESSION_SERVICE);
            android.content.ComponentName componentName = new android.content.ComponentName(context, LinkNotificationReceiver.class);
            
            java.util.List<String> playerList = new java.util.ArrayList<>();
            String activePlayer = "";
            String title = "No Active Media";
            String artist = "";
            String album = "";
            boolean isPlaying = false;
            boolean canPlay = false;
            boolean canPause = false;
            boolean canGoNext = false;
            boolean canGoPrevious = false;
            boolean canSeek = false;
            long length = 0;
            long pos = 0;

            if (LinkNotificationReceiver.isPermissionGranted(context)) {
                try {
                    java.util.List<android.media.session.MediaController> controllers = mediaSessionManager.getActiveSessions(componentName);
                    if (controllers != null && !controllers.isEmpty()) {
                        android.media.session.MediaController activeController = null;
                        for (android.media.session.MediaController controller : controllers) {
                            String pkg = controller.getPackageName();
                            String name = pkg;
                            if (pkg.contains("spotify")) name = "Spotify";
                            else if (pkg.contains("youtube")) name = "YouTube";
                            else if (pkg.contains("musicolet")) name = "Musicolet";
                            else {
                                int lastDot = pkg.lastIndexOf('.');
                                if (lastDot != -1 && lastDot < pkg.length() - 1) {
                                    name = pkg.substring(lastDot + 1);
                                    name = name.substring(0, 1).toUpperCase() + name.substring(1);
                                }
                            }
                            playerList.add(name);

                            android.media.session.PlaybackState pbState = controller.getPlaybackState();
                            boolean controllerPlaying = pbState != null && pbState.getState() == android.media.session.PlaybackState.STATE_PLAYING;
                            
                            if (activeController == null || controllerPlaying) {
                                activeController = controller;
                                isPlaying = controllerPlaying;
                            }
                        }

                        if (activeController != null) {
                            String pkg = activeController.getPackageName();
                            if (pkg.contains("spotify")) activePlayer = "Spotify";
                            else if (pkg.contains("youtube")) activePlayer = "YouTube";
                            else if (pkg.contains("musicolet")) activePlayer = "Musicolet";
                            else {
                                int lastDot = pkg.lastIndexOf('.');
                                if (lastDot != -1 && lastDot < pkg.length() - 1) {
                                    activePlayer = pkg.substring(lastDot + 1);
                                    activePlayer = activePlayer.substring(0, 1).toUpperCase() + activePlayer.substring(1);
                                }
                            }

                            android.media.MediaMetadata metadata = activeController.getMetadata();
                            if (metadata != null) {
                                title = metadata.getString(android.media.MediaMetadata.METADATA_KEY_TITLE);
                                if (title == null || title.isEmpty()) {
                                    title = "Unknown Track";
                                }
                                artist = metadata.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST);
                                if (artist == null) artist = "";
                                album = metadata.getString(android.media.MediaMetadata.METADATA_KEY_ALBUM);
                                if (album == null) album = "";
                                length = metadata.getLong(android.media.MediaMetadata.METADATA_KEY_DURATION);
                            }

                            android.media.session.PlaybackState pbState = activeController.getPlaybackState();
                            if (pbState != null) {
                                pos = pbState.getPosition();
                                long actions = pbState.getActions();
                                canPlay = (actions & android.media.session.PlaybackState.ACTION_PLAY) != 0;
                                canPause = (actions & android.media.session.PlaybackState.ACTION_PAUSE) != 0;
                                canGoNext = (actions & android.media.session.PlaybackState.ACTION_SKIP_TO_NEXT) != 0;
                                canGoPrevious = (actions & android.media.session.PlaybackState.ACTION_SKIP_TO_PREVIOUS) != 0;
                                canSeek = (actions & android.media.session.PlaybackState.ACTION_SEEK_TO) != 0;
                            }
                        }
                    }
                } catch (SecurityException se) {
                    android.util.Log.e("LinkMpris", "SecurityException on active sessions", se);
                } catch (Exception e) {
                    android.util.Log.e("LinkMpris", "Error building mpris state", e);
                }
            }

            JSONObject body = new JSONObject();
            body.put("playerList", new org.json.JSONArray(playerList));
            body.put("player", activePlayer);
            body.put("title", title);
            body.put("artist", artist);
            body.put("album", album);
            body.put("isPlaying", isPlaying);
            body.put("canPlay", canPlay);
            body.put("canPause", canPause);
            body.put("canGoNext", canGoNext);
            body.put("canGoPrevious", canGoPrevious);
            body.put("canSeek", canSeek);
            body.put("volume", 100);
            body.put("length", length);
            body.put("pos", pos);
            body.put("supportAlbumArtPayload", false);

            return new LinkPacket(PACKET_TYPE_MPRIS, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
