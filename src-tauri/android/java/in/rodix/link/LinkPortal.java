package in.rodix.link;

import app.tauri.plugin.Invoke;
import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

// Portal Mode (one-time file transfer to an untrusted/unpaired device).
// The wire protocol matches the desktop (see the header of core/portal.rs). This phone can host a portal
// (startPortalReceive: a TLS WebSocket server that admits a stranger after PIN confirmation and saves what they
// send into the Link folder) and can join someone else's portal as a guest (joinPortalGuest). Browsers are served
// by LinkWebShare instead (the Web Portal). LinkFileTransferServer/Client also have a paired-token path, which is
// not wired up here.
final class LinkPortal extends LinkFeature {
    LinkPortal(LinkPlugin plugin) {
        super(plugin);
    }

    static LinkFileTransferServer sPortalTransferServer;
    // The Web Portal: browsers (no Link needed) served over plain HTTP, see LinkWebShare.
    private static LinkWebShare sPortalWebServer;

    static LinkFileTransferClient sPortalTransferClient;

    @Override
    void stopPreviousInstance() {
        if (sPortalTransferClient != null) {
            sPortalTransferClient.disconnect();
            sPortalTransferClient = null;
        }
        if (sPortalTransferServer != null) {
            try {
                sPortalTransferServer.stop();
            } catch (Exception e) {
                android.util.Log.e(TAG, "Error stopping previous PortalTransferServer", e);
            }
            sPortalTransferServer = null;
        }
        // The Web Portal is left running: it belongs to the app process, not to the screen, so closing and reopening
        // the screen keeps its connection and shared files (the page re-attaches through getPortalStatus).
    }

    /** Multi-select document picker. Returns content:// Uri strings that the renderer passes
     *  back to joinPortalGuest(). */
    @LinkMethod
    public void pickPortalFiles(LinkCall call) {
        android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        intent.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.setType("*/*");
        startActivityForResult(call.invoke(), intent, "onPortalFilesPicked");
    }

    // Called through LinkPlugin's @ActivityCallback of the same name.
    void onPortalFilesPicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject());
            return;
        }
        android.content.Intent data = result.getData();
        java.util.List<android.net.Uri> uris = new java.util.ArrayList<>();
        // Several files come back as ClipData; a single file comes back as getData() instead.
        if (data.getClipData() != null) {
            android.content.ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                android.net.Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        // Persist read access: the transient grant can expire before sendFiles() runs, which
        // would fail with a SecurityException.
        JSArray uriStrings = new JSArray();
        for (android.net.Uri uri : uris) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
            uriStrings.put(uri.toString());
        }
        JSObject ret = new JSObject();
        ret.put("uris", uriStrings);
        call.resolve(ret);
    }

    // Web Portal: this phone serves a page that any browser on the network can open. The browser asks to join and
    // shows a PIN; the same PIN appears here through the usual guest prompt, and accepting lets it download the staged
    // files and upload into the Link folder.
    private void startPortalWeb(LinkCall call) {
        JSObject ret = new JSObject();
        try {
            if (sPortalWebServer == null || !sPortalWebServer.isRunning()) {
                if (sPortalTransferServer != null) {
                    // The secure app-to-app server holds the portal port; the page takes its place.
                    try { sPortalTransferServer.stop(); } catch (Exception ignored) { }
                    sPortalTransferServer = null;
                }
                java.io.File saveDir = new java.io.File(android.os.Environment.getExternalStorageDirectory(), "Link");
                LinkWebShare.Listener listener = new LinkWebShare.Listener() {
                    @Override
                    public void onGuestPending(String connId, String pin, String remoteAddress) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", "Browser");
                        LinkPlugin.emitStatic("portalGuestPinPending", data);
                    }

                    @Override
                    public void onGuestAdmitted(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("deviceName", "Browser");
                        LinkPlugin.emitStatic("portalConnectionAdmitted", data);
                    }

                    @Override
                    public void onGuestClosed(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        LinkPlugin.emitStatic("portalConnectionClosed", data);
                    }

                    @Override
                    public void onUploadStarted(String connId, String name, long size) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("name", name);
                        data.put("size", size);
                        LinkPlugin.emitStatic("portalTransferStarted", data);
                    }

                    @Override
                    public void onUploadComplete(String connId, String path) {
                        android.media.MediaScannerConnection.scanFile(getContext(), new String[]{path}, null, null);
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("destPath", path);
                        LinkPlugin.emitStatic("portalTransferComplete", data);
                    }

                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        LinkPlugin.emitStatic("portalError", data);
                    }
                };
                LinkWebShare server;
                try {
                    server = LinkWebShare.startPortal(getContext(), LinkTransport.PORTAL_TRANSFER_PORT, saveDir, listener);
                } catch (java.io.IOException busy) {
                    // The portal port is still held (the old server may take a moment to let go): use any free one.
                    server = LinkWebShare.startPortal(getContext(), 0, saveDir, listener);
                }
                sPortalWebServer = server;
            }
            ret.put("started", true);
            ret.put("port", sPortalWebServer.port());
            ret.put("saveDir", "Link");
            ret.put("webMode", true);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start the Web Portal", e);
            ret.put("started", false);
            ret.put("error", e.getMessage());
        }
        call.resolve(ret);
    }

    // A just-closed server socket can hold its port for a moment; wait (up to ~3 s) until it can be bound again.
    private static void waitForPortFree(int port) {
        for (int i = 0; i < 30; i++) {
            try (java.net.ServerSocket probe = new java.net.ServerSocket()) {
                probe.setReuseAddress(true);
                probe.bind(new java.net.InetSocketAddress(port));
                return;
            } catch (java.io.IOException busy) {
                try { Thread.sleep(100); } catch (InterruptedException e) { return; }
            }
        }
    }

    @LinkMethod
    public void startPortalReceive(LinkCall call) {
        if (call.getBoolean("webMode", false)) {
            startPortalWeb(call);
            return;
        }
        if (sPortalWebServer != null) {
            sPortalWebServer.stop();
            sPortalWebServer = null;
            waitForPortFree(LinkTransport.PORTAL_TRANSFER_PORT);
        }
        if (sPortalTransferServer != null) {
            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.PORTAL_TRANSFER_PORT);
            ret.put("saveDir", "Link");
            call.resolve(ret);
            return;
        }
        if (plugin.deviceManager == null) {
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", "Not initialized");
            call.resolve(ret);
            return;
        }
        try {
            LinkFileTransferServer server = new LinkFileTransferServer(
                getContext(), plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), LinkTransport.PORTAL_TRANSFER_PORT,
                plugin.myIdentity != null ? plugin.myIdentity.deviceName : "Device",
                new LinkFileTransferServer.Listener() {
                    @Override
                    public void onGuestPinPending(String connId, String pin, String remoteAddress, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("pin", pin);
                        data.put("remoteAddress", remoteAddress);
                        data.put("deviceName", deviceName);
                        notifyListeners("portalGuestPinPending", data);
                    }
                    @Override
                    public void onConnectionAdmitted(String connId, String deviceName) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("deviceName", deviceName);
                        notifyListeners("portalConnectionAdmitted", data);
                    }
                    @Override
                    public void onConnectionClosed(String connId) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        notifyListeners("portalConnectionClosed", data);
                    }
                    @Override
                    public void onPeerFilesChanged(String connId, org.json.JSONArray files) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("files", files);
                        notifyListeners("portalPeerFilesChanged", data);
                    }
                    @Override
                    public void onTransferStarted(String connId, String name, long size) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("name", name);
                        data.put("size", size);
                        notifyListeners("portalTransferStarted", data);
                    }
                    @Override
                    public void onTransferProgress(String connId, long received, long size) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("received", received);
                        data.put("size", size);
                        notifyListeners("portalTransferProgress", data);
                    }
                    @Override
                    public void onTransferComplete(String connId, String destPath) {
                        JSObject data = new JSObject();
                        data.put("connId", connId);
                        data.put("destPath", destPath);
                        notifyListeners("portalTransferComplete", data);
                    }
                    @Override
                    public void onFileStarted(int fileIndex, int fileCount, String name) {
                        JSObject data = new JSObject();
                        data.put("fileIndex", fileIndex);
                        data.put("fileCount", fileCount);
                        data.put("name", name);
                        notifyListeners("portalFileStarted", data);
                    }
                    @Override
                    public void onSendProgress(long sent, long total) {
                        JSObject data = new JSObject();
                        data.put("sent", sent);
                        data.put("total", total);
                        notifyListeners("portalSendProgress", data);
                    }
                    @Override
                    public void onSendComplete() {
                        notifyListeners("portalSendComplete", new JSObject());
                    }
                    @Override
                    public void onError(String message) {
                        JSObject data = new JSObject();
                        data.put("message", message);
                        notifyListeners("portalError", data);
                    }
                }, idOrIp -> LinkBlocklist.isBlocked(getContext(), idOrIp));
            server.start();
            sPortalTransferServer = server;

            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("port", LinkTransport.PORTAL_TRANSFER_PORT);
            ret.put("saveDir", "Link");
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to start Portal receive", e);
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    @LinkMethod
    public void acceptPortalGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) sPortalTransferServer.acceptGuest(connId);
        if (sPortalWebServer != null && connId != null) sPortalWebServer.acceptGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void rejectPortalGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) sPortalTransferServer.rejectGuest(connId);
        if (sPortalWebServer != null && connId != null) sPortalWebServer.rejectGuest(connId);
        call.resolve();
    }

    @LinkMethod
    public void blockPortalGuest(LinkCall call) {
        String connId = call.getString("connId");
        if (sPortalTransferServer != null && connId != null) {
            String ip = sPortalTransferServer.getPendingGuestRemoteAddress(connId);
            String name = sPortalTransferServer.getPendingGuestDeviceName(connId);
            if (ip != null) plugin.blockUntrustedGuest(ip, name);
            sPortalTransferServer.rejectGuest(connId);
        }
        if (sPortalWebServer != null && connId != null) {
            String ip = sPortalWebServer.pendingAddress(connId);
            if (ip != null) plugin.blockUntrustedGuest(ip, "Browser");
            sPortalWebServer.rejectGuest(connId);
        }
        call.resolve();
    }

    /** The host's Disconnect button: ends one connected guest, a browser or an app. */
    @LinkMethod
    public void disconnectPortalConnection(LinkCall call) {
        String connId = call.getString("connId");
        if (connId != null) {
            if (sPortalWebServer != null) sPortalWebServer.closeGuest(connId);
            if (sPortalTransferServer != null) sPortalTransferServer.disconnectConnection(connId);
        }
        call.resolve();
    }

    @LinkMethod
    public void endPortalReceive(LinkCall call) {
        if (sPortalWebServer != null) {
            sPortalWebServer.stop();
            sPortalWebServer = null;
            waitForPortFree(LinkTransport.PORTAL_TRANSFER_PORT);
        }
        if (sPortalTransferServer != null) {
            try { sPortalTransferServer.stop(); } catch (Exception ignored) {}
            sPortalTransferServer = null;
        }
        call.resolve();
    }

    @LinkMethod
    public void joinPortalGuest(LinkCall call) {
        String host = call.getString("host");
        if (plugin.deviceManager == null) {
            call.resolve();
            return;
        }
        java.util.List<android.net.Uri> fileUris = portalUris(call.getData().optJSONArray("uris"));

        // Web Portal: the staged files are what the browser may download.
        if (sPortalWebServer != null) {
            if (fileUris.size() > 0) sPortalWebServer.setEntries(webEntries(fileUris));
            call.resolve();
            return;
        }

        // While hosting with an admitted client, the staged files become its available downloads.
        if (sPortalTransferServer != null && sPortalTransferServer.getAdmittedConnectionIds().size() > 0) {
            if (fileUris.size() > 0) {
                sPortalTransferServer.setAvailableDownloads(getContext(), fileUris);
            }
            call.resolve();
            return;
        }

        if (sPortalTransferClient != null && sPortalTransferClient.isConnected()) {
            if (fileUris.size() > 0) {
                sPortalTransferClient.setAvailableDownloads(getContext(), fileUris);
            }
            call.resolve();
            return;
        }

        if (host == null) {
            call.resolve();
            return;
        }

        if (sPortalTransferClient != null) sPortalTransferClient.disconnect();
        LinkFileTransferClient client = new LinkFileTransferClient(getContext(), new LinkFileTransferClient.Listener() {
            @Override
            public void onPinComputed(String pin) {
                JSObject data = new JSObject();
                data.put("pin", pin);
                notifyListeners("portalPinComputed", data);
            }
            @Override
            public void onAdmitted(String receiverDeviceName) {
                JSObject admittedData = new JSObject();
                admittedData.put("deviceName", receiverDeviceName);
                notifyListeners("portalAdmitted", admittedData);
            }
            @Override
            public void onPeerFilesChanged(org.json.JSONArray files) {
                JSObject data = new JSObject();
                data.put("files", files);
                notifyListeners("portalPeerFilesChanged", data);
            }
            @Override
            public void onFileStarted(int fileIndex, int fileCount, String name) {
                JSObject data = new JSObject();
                data.put("fileIndex", fileIndex);
                data.put("fileCount", fileCount);
                data.put("name", name);
                notifyListeners("portalFileStarted", data);
            }
            @Override
            public void onProgress(long sent, long total) {
                JSObject data = new JSObject();
                data.put("sent", sent);
                data.put("total", total);
                notifyListeners("portalSendProgress", data);
            }
            @Override
            public void onComplete() {
                notifyListeners("portalSendComplete", new JSObject());
            }
            @Override
            public void onTransferStarted(String name, long size) {
                JSObject data = new JSObject();
                data.put("connId", "client-conn");
                data.put("name", name);
                data.put("size", size);
                notifyListeners("portalTransferStarted", data);
            }
            @Override
            public void onTransferProgress(long received, long size) {
                JSObject data = new JSObject();
                data.put("connId", "client-conn");
                data.put("received", received);
                data.put("size", size);
                notifyListeners("portalTransferProgress", data);
            }
            @Override
            public void onTransferComplete(String destPath) {
                JSObject data = new JSObject();
                data.put("connId", "client-conn");
                data.put("destPath", destPath);
                notifyListeners("portalTransferComplete", data);
            }
            @Override
            public void onEnded() {
                sPortalTransferClient = null;
                notifyListeners("portalEnded", new JSObject());
            }
            @Override
            public void onClosed(String reason) {
                sPortalTransferClient = null;
                JSObject data = new JSObject();
                data.put("reason", reason);
                notifyListeners("portalClosed", data);
            }
            @Override
            public void onError(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("portalError", data);
                sPortalTransferClient = null;
            }
        });
        sPortalTransferClient = client;
        client.connect(host, LinkTransport.PORTAL_TRANSFER_PORT, plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), null, plugin.myIdentity != null ? plugin.myIdentity.deviceName : "Guest");
        call.resolve();
    }

    @LinkMethod
    public void leavePortalSend(LinkCall call) {
        if (sPortalTransferClient != null) {
            sPortalTransferClient.disconnect();
            sPortalTransferClient = null;
        }
        call.resolve();
    }

    /** Files the user staged, as the screen sends them: plain URI strings or {name, localPath}
     *  objects. Anything unreadable is skipped, and the count is logged so an empty announcement
     *  can be told apart from a list that never arrived. */
    private java.util.List<android.net.Uri> portalUris(org.json.JSONArray items) {
        java.util.List<android.net.Uri> uris = new java.util.ArrayList<>();
        int received = items != null ? items.length() : 0;
        for (int i = 0; i < received; i++) {
            Object item = items.opt(i);
            String raw = item instanceof org.json.JSONObject ? ((org.json.JSONObject) item).optString("localPath", "") : String.valueOf(item);
            if (raw != null && !raw.isEmpty() && !"null".equals(raw)) uris.add(android.net.Uri.parse(raw));
        }
        android.util.Log.i(TAG, "Portal downloads: " + uris.size() + " usable of " + received + " staged");
        return uris;
    }

    private java.util.List<LinkWebShare.Entry> webEntries(java.util.List<android.net.Uri> uris) {
        java.util.List<LinkWebShare.Entry> entries = new java.util.ArrayList<>();
        for (int i = 0; i < uris.size(); i++) entries.add(LinkWebShare.describe(getContext(), uris.get(i), i));
        return entries;
    }

    @LinkMethod
    public void setPortalDownloads(LinkCall call) {
        java.util.List<android.net.Uri> uris = portalUris(call.getData().optJSONArray("files"));
        if (sPortalWebServer != null) {
            sPortalWebServer.setEntries(webEntries(uris));
        }
        if (sPortalTransferServer != null) {
            sPortalTransferServer.setAvailableDownloads(getContext(), uris);
        }
        if (sPortalTransferClient != null) {
            sPortalTransferClient.setAvailableDownloads(getContext(), uris);
        }
        call.resolve();
    }

    @LinkMethod
    public void requestPortalDownload(LinkCall call) {
        String fileId = call.getString("fileId");
        if (fileId != null) {
            if (sPortalTransferServer != null && sPortalTransferServer.getAdmittedConnectionIds().size() > 0) {
                String connId = sPortalTransferServer.getAdmittedConnectionIds().get(0);
                sPortalTransferServer.requestDownload(connId, fileId);
            } else if (sPortalTransferClient != null && sPortalTransferClient.isConnected()) {
                sPortalTransferClient.requestDownload(fileId);
            }
        }
        call.resolve();
    }

    @LinkMethod
    public void getPortalStatus(LinkCall call) {
        JSObject ret = new JSObject();
        boolean isHost = sPortalTransferServer != null && sPortalTransferServer.hasConnectedPeers();
        boolean isGuest = sPortalTransferClient != null && sPortalTransferClient.isConnected();
        java.util.Map.Entry<String, String> hostPeer = isHost ? sPortalTransferServer.getConnectedPeer() : null;
        String guestPeerName = isGuest ? sPortalTransferClient.getPeerDeviceName() : null;

        ret.put("receiving", sPortalTransferServer != null || sPortalWebServer != null);
        ret.put("webMode", sPortalWebServer != null);
        ret.put("sending", sPortalTransferClient != null);
        ret.put("connected", isHost || isGuest);
        ret.put("isHost", isHost);
        ret.put("peerName", isHost ? (hostPeer != null ? hostPeer.getValue() : "Peer") : (isGuest ? guestPeerName : null));
        ret.put("connId", isHost ? (hostPeer != null ? hostPeer.getKey() : null) : null);
        ret.put("transferring", sPortalTransferServer != null && sPortalTransferServer.hasActiveTransfer());
        // The files staged for sharing, so a reopened screen shows them again instead of an empty list.
        JSArray staged = new JSArray();
        if (sPortalWebServer != null) {
            for (LinkWebShare.Entry entry : sPortalWebServer.stagedEntries()) {
                JSObject file = new JSObject();
                file.put("name", entry.name);
                file.put("localPath", entry.uri.toString());
                staged.put(file);
            }
        } else if (sPortalTransferServer != null) {
            for (LinkFileTransferServer.SharedFileEntry entry : sPortalTransferServer.stagedFiles()) {
                JSObject file = new JSObject();
                file.put("name", entry.name);
                file.put("localPath", entry.uri.toString());
                staged.put(file);
            }
        }
        ret.put("stagedFiles", staged);
        if (sPortalWebServer != null) {
            // The Web Portal: its port may not be the usual one, and a browser may already be connected.
            ret.put("port", sPortalWebServer.port());
            String guest = sPortalWebServer.admittedGuest();
            if (guest != null) {
                ret.put("connected", true);
                ret.put("isHost", true);
                ret.put("peerName", "Browser");
                ret.put("connId", guest);
            }
        } else if (sPortalTransferServer != null) {
            ret.put("port", LinkTransport.PORTAL_TRANSFER_PORT);
        }
        call.resolve(ret);
    }
}
