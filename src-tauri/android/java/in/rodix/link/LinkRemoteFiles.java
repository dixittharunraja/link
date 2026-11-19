package in.rodix.link;

import app.tauri.plugin.Invoke;
import app.tauri.plugin.JSArray;
import app.tauri.plugin.JSObject;

// File explorer: browsing a paired device, transfers to and from it, and streaming its media.
// Every request (listings, bytes, thumbnails) goes over LinkFsClient to the device's file server:
// another phone's LinkFsServer or a PC's core/fs_server.rs, which speak one protocol. The only
// control packet is link.fs.request { action: "open" }, answered with the port to connect to. Also
// answers that packet for this phone's own LinkFsServer.
final class LinkRemoteFiles extends LinkFeature {
    LinkRemoteFiles(LinkPlugin plugin) {
        super(plugin);
    }

    @Override
    void registerPackets(java.util.Map<String, LinkPlugin.PacketHandler> handlers) {
        handlers.put("link.fs.request", this::handleFsRequestPacket);
        handlers.put("link.fs.response", (deviceId, packet) -> handleFsResponsePacket(packet));
    }

    private final java.util.Map<String, LinkFsClient> fsClients = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Map<String, java.util.function.Consumer<org.json.JSONObject>> pendingFsOpens = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicInteger fsRequestCounter = new java.util.concurrent.atomic.AtomicInteger();
    private final java.util.Set<String> cancelledTransfers = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
    // Runs explorer calls, the files of a folder transfer and the chunks each file keeps in flight.
    private final java.util.concurrent.ExecutorService fsPool = java.util.concurrent.Executors.newCachedThreadPool();
    private static final int FS_CHUNK_SIZE = 1024 * 1024;
    private static final int FS_CHUNKS_IN_FLIGHT = 4;
    // Files of one folder transfer moved at once, as desktop's core/fs_transfer.rs does.
    private static final int FS_FILES_IN_FLIGHT = 4;
    private static final long FS_OPEN_TIMEOUT_MS = 15_000;

    private interface FsOp<T> {
        T run(LinkFsClient client) throws Exception;
    }

    /** Asks the device where its file server listens. Blocking. */
    private int fsServerPort(String deviceId) throws Exception {
        String requestId = "fs-open-" + System.currentTimeMillis() + "-" + fsRequestCounter.getAndIncrement();
        final org.json.JSONObject[] holder = new org.json.JSONObject[1];
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        pendingFsOpens.put(requestId, body -> {
            holder[0] = body;
            latch.countDown();
        });
        try {
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("requestId", requestId);
            body.put("action", "open");
            plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.fs.request", body));
            if (!latch.await(FS_OPEN_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                throw new Exception("The device did not answer");
            }
        } finally {
            pendingFsOpens.remove(requestId);
        }
        if (!holder[0].optBoolean("success", false)) throw new Exception(holder[0].optString("error", "File access is not available"));
        return holder[0].getJSONObject("result").getInt("port");
    }

    private LinkFsClient fsClient(String deviceId) throws Exception {
        LinkFsClient client = fsClients.get(deviceId);
        if (client != null && !client.isClosed()) return client;
        synchronized (fsClients) {
            client = fsClients.get(deviceId);
            if (client != null && !client.isClosed()) return client;
            int port = fsServerPort(deviceId);
            client = new LinkFsClient(plugin.deviceManager.remoteAddressOf(deviceId), port,
                plugin.deviceManager.getMyCert(), plugin.deviceManager.getMyKey(), plugin.deviceManager.pinnedFingerprintOf(deviceId));
            fsClients.put(deviceId, client);
            return client;
        }
    }

    /** Runs `op` on the device's file connection. When the connection is gone for good (the device
     *  restarted, or came back on another address) the device is asked again where to connect. */
    private <T> T withFs(String deviceId, FsOp<T> op) throws Exception {
        LinkFsClient client = fsClient(deviceId);
        try {
            return op.run(client);
        } catch (java.io.IOException e) {
            fsClients.remove(deviceId, client);
            client.close();
            return op.run(fsClient(deviceId));
        }
    }

    private static org.json.JSONObject fsArgs(String path) throws org.json.JSONException {
        org.json.JSONObject args = new org.json.JSONObject();
        args.put("path", path);
        return args;
    }

    /** Runs one explorer call off the bridge thread and resolves it with what `op` returns. */
    private void runFsCall(LinkCall call, FsOp<JSObject> op) {
        String deviceId = call.getString("deviceId");
        if (deviceId == null || plugin.deviceManager == null) {
            call.reject("Missing deviceId, or not initialized");
            return;
        }
        fsPool.execute(() -> {
            try {
                call.resolve(withFs(deviceId, op));
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "File request failed");
            }
        });
    }

    private static JSObject fsResult(Object value) {
        JSObject ret = new JSObject();
        ret.put("result", value);
        return ret;
    }

    @LinkMethod
    public void fsListRoots(LinkCall call) {
        runFsCall(call, client -> fsResult(client.request("listRoots", null).optJSONArray("roots")));
    }

    /** One page of a folder (`limit` 0: all of it). Resolves { result: entries, hasMore }. */
    @LinkMethod
    public void fsReaddir(LinkCall call) {
        String path = call.getString("path");
        int offset = call.getInt("offset", 0);
        int limit = call.getInt("limit", 0);
        runFsCall(call, client -> {
            org.json.JSONObject args = fsArgs(path);
            args.put("offset", offset);
            args.put("limit", limit);
            org.json.JSONObject reply = client.request("readdir", args);
            JSObject ret = fsResult(reply.optJSONArray("files"));
            ret.put("hasMore", reply.optBoolean("hasMore", false));
            return ret;
        });
    }

    @LinkMethod
    public void fsStat(LinkCall call) {
        String path = call.getString("path");
        runFsCall(call, client -> {
            org.json.JSONObject reply = client.request("stat", fsArgs(path));
            org.json.JSONObject stat = new org.json.JSONObject();
            for (String key : new String[]{"name", "isDirectory", "size", "mtime"}) stat.put(key, reply.opt(key));
            return fsResult(stat);
        });
    }

    @LinkMethod
    public void fsCreateDirectory(LinkCall call) {
        String path = call.getString("path");
        runFsCall(call, client -> {
            org.json.JSONObject args = fsArgs(path);
            args.put("isDirectory", true);
            client.request("create", args);
            return fsResult(true);
        });
    }

    @LinkMethod
    public void fsDelete(LinkCall call) {
        String path = call.getString("path");
        runFsCall(call, client -> {
            client.request("delete", fsArgs(path));
            return fsResult(true);
        });
    }

    @LinkMethod
    public void fsRename(LinkCall call) {
        String path = call.getString("path");
        String newPath = call.getString("newPath");
        runFsCall(call, client -> {
            org.json.JSONObject args = fsArgs(path);
            args.put("newPath", newPath);
            client.request("rename", args);
            return fsResult(true);
        });
    }

    // ---- Thumbnails: the device's `thumbnail` action, cached on disk by path, size and mtime ----

    private static final int FS_THUMB_SIDE = 256;
    private static final int FS_THUMB_QUALITY = 70;
    private static final int FS_THUMB_CACHE_HIGH = 4000;
    private static final int FS_THUMB_CACHE_LOW = 3000;
    private final java.util.concurrent.atomic.AtomicInteger fsThumbWrites = new java.util.concurrent.atomic.AtomicInteger();

    /** A small JPEG of an image file on the device, as a data URL. `size` and `mtime` come from the
     *  listing, so a cached thumbnail costs no request at all. Resolves { dataUrl }. */
    @LinkMethod
    public void fsThumbnail(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String path = call.getString("path");
        long size = (long) call.getDouble("size", -1);
        long mtime = (long) call.getDouble("mtime", -1);
        runFsCall(call, client -> {
            java.io.File dir = new java.io.File(getContext().getCacheDir(), "thumbnails");
            java.io.File cached = new java.io.File(dir, fsThumbKey(deviceId, path, size, mtime) + ".jpg");
            byte[] jpeg = null;
            if (size >= 0 && mtime >= 0 && cached.isFile()) {
                try {
                    jpeg = java.nio.file.Files.readAllBytes(cached.toPath());
                } catch (java.io.IOException ignored) { }
            }
            if (jpeg == null) {
                org.json.JSONObject args = fsArgs(path);
                args.put("max", FS_THUMB_SIDE);
                args.put("quality", FS_THUMB_QUALITY);
                jpeg = client.requestData("thumbnail", args);
                if (size >= 0 && mtime >= 0) storeFsThumbnail(dir, cached, jpeg);
            }
            JSObject ret = new JSObject();
            ret.put("dataUrl", "data:image/jpeg;base64," + android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP));
            return ret;
        });
    }

    private static String fsThumbKey(String deviceId, String path, long size, long mtime) throws Exception {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(
            (deviceId + "\n" + path + "\n" + size + "\n" + mtime + "\n" + FS_THUMB_SIDE).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 16; i++) hex.append(String.format(java.util.Locale.ROOT, "%02x", digest[i]));
        return hex.toString();
    }

    /** Writes through a temp file so a half-written thumbnail is never read, and now and then trims the cache. */
    private void storeFsThumbnail(java.io.File dir, java.io.File file, byte[] jpeg) {
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        java.io.File partial = new java.io.File(dir, file.getName() + ".part");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(partial)) {
            out.write(jpeg);
        } catch (java.io.IOException e) {
            //noinspection ResultOfMethodCallIgnored
            partial.delete();
            return;
        }
        if (!partial.renameTo(file)) {
            //noinspection ResultOfMethodCallIgnored
            partial.delete();
            return;
        }
        if (fsThumbWrites.getAndIncrement() % 200 != 0) return;
        java.io.File[] all = dir.listFiles();
        if (all == null || all.length <= FS_THUMB_CACHE_HIGH) return;
        java.util.Arrays.sort(all, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < all.length - FS_THUMB_CACHE_LOW; i++) {
            //noinspection ResultOfMethodCallIgnored
            all[i].delete();
        }
    }

    // ---- Downloads and uploads ----
    // Chunks are pipelined (FS_CHUNKS_IN_FLIGHT per file) and a folder moves FS_FILES_IN_FLIGHT
    // files at once after a single listing walk, so neither a large file nor a tree of small ones is
    // paced by one round trip at a time.

    /** Progress shared by the files of one transfer, which may be in flight together. */
    private final class FsProgress {
        final String transferId;
        final String direction;
        final String deviceId;
        final String path;
        volatile long total;
        private final java.util.concurrent.atomic.AtomicLong transferred = new java.util.concurrent.atomic.AtomicLong();
        private long lastEmitAt;

        FsProgress(String transferId, String direction, String deviceId, String path) {
            this.transferId = transferId;
            this.direction = direction;
            this.deviceId = deviceId;
            this.path = path;
        }

        void check() throws Exception {
            if (cancelledTransfers.contains(transferId)) throw new Exception("Transfer cancelled");
        }

        void advance(long bytes) {
            transferred.addAndGet(bytes);
            emit(false);
        }

        synchronized void emit(boolean force) {
            long now = System.currentTimeMillis();
            if (!force && now - lastEmitAt < 100) return;
            lastEmitAt = now;
            emitFsTransferProgress(transferId, direction, deviceId, path, transferred.get(), total);
        }
    }

    private interface FsJob<T> {
        void run(T item) throws Exception;
    }

    /** Runs `job` over `items`, FS_FILES_IN_FLIGHT at a time. The first failure cancels the rest and is thrown. */
    private <T> void runFsJobs(java.util.List<T> items, FsJob<T> job) throws Exception {
        java.util.concurrent.ExecutorCompletionService<Void> done = new java.util.concurrent.ExecutorCompletionService<>(fsPool);
        java.util.List<java.util.concurrent.Future<Void>> started = new java.util.ArrayList<>();
        java.util.Iterator<T> next = items.iterator();
        int running = 0;
        try {
            while (next.hasNext() || running > 0) {
                while (running < FS_FILES_IN_FLIGHT && next.hasNext()) {
                    T item = next.next();
                    started.add(done.submit(() -> {
                        job.run(item);
                        return null;
                    }));
                    running++;
                }
                java.util.concurrent.Future<Void> finished = done.take();
                running--;
                awaitChunk(finished);
            }
        } finally {
            for (java.util.concurrent.Future<Void> future : started) future.cancel(true);
        }
    }

    /** The result of a pool task, with the task's own exception rethrown rather than wrapped. */
    private static <T> T awaitChunk(java.util.concurrent.Future<T> future) throws Exception {
        try {
            return future.get();
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw e;
        }
    }

    private void emitFsTransferProgress(String transferId, String direction, String deviceId, String path, long transferred, long total) {
        JSObject data = new JSObject();
        data.put("transferId", transferId);
        data.put("direction", direction);
        data.put("deviceId", deviceId);
        data.put("path", path);
        data.put("transferred", transferred);
        data.put("total", total);
        notifyListeners("fsTransferProgress", data);
    }

    private String joinRemotePath(String parent, String name) {
        return (parent.endsWith("/") || parent.endsWith("\\")) ? parent + name : parent + "/" + name;
    }

    private java.io.File uniqueDestFile(java.io.File dir, String fileName) {
        java.io.File destFile = new java.io.File(dir, fileName);
        int counter = 1;
        String base = fileName;
        String ext = "";
        int dot = fileName.lastIndexOf('.');
        if (dot > 0) {
            base = fileName.substring(0, dot);
            ext = fileName.substring(dot);
        }
        while (destFile.exists()) {
            destFile = new java.io.File(dir, base + " (" + counter + ")" + ext);
            counter++;
        }
        return destFile;
    }

    @LinkMethod
    public void fsDownloadFile(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String remotePath = call.getString("remotePath");
        if (deviceId == null || remotePath == null || plugin.deviceManager == null) {
            call.reject("Missing deviceId/remotePath, or not initialized");
            return;
        }
        String transferId = "fs-" + System.currentTimeMillis() + "-" + Math.random();
        fsPool.execute(() -> downloadFsFile(call, deviceId, remotePath, transferId));
    }

    /** One file or folder of a remote tree, found by the single listing walk of a folder download. */
    private static final class RemoteItem {
        final String remote;
        final java.io.File local;
        final boolean isDir;
        final long size;

        RemoteItem(String remote, java.io.File local, boolean isDir, long size) {
            this.remote = remote;
            this.local = local;
            this.isDir = isDir;
            this.size = size;
        }
    }

    private void downloadFsFile(LinkCall call, String deviceId, String remotePath, String transferId) {
        try {
            org.json.JSONObject stat = withFs(deviceId, client -> client.request("stat", fsArgs(remotePath)));
            String name = remotePath.substring(Math.max(remotePath.lastIndexOf('/'), remotePath.lastIndexOf('\\')) + 1);
            if (name.isEmpty()) name = "download";
            java.io.File dir = new java.io.File(android.os.Environment.getExternalStorageDirectory(), "Link/Downloads");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            FsProgress progress = new FsProgress(transferId, "download", deviceId, remotePath);

            if (stat.optBoolean("isDirectory", false)) {
                java.io.File destDir = uniqueDestFile(dir, name);
                java.util.List<RemoteItem> items = new java.util.ArrayList<>();
                walkRemote(deviceId, remotePath, destDir, items, progress);
                java.util.List<RemoteItem> files = new java.util.ArrayList<>();
                long total = 0;
                //noinspection ResultOfMethodCallIgnored
                destDir.mkdirs();
                for (RemoteItem item : items) {
                    if (item.isDir) {
                        //noinspection ResultOfMethodCallIgnored
                        item.local.mkdirs();
                    } else {
                        files.add(item);
                        total += item.size;
                    }
                }
                progress.total = total;
                runFsJobs(files, item -> downloadRemoteFile(deviceId, item.remote, item.local, item.size, progress));
            } else {
                long size = stat.optLong("size", 0);
                progress.total = size;
                downloadRemoteFile(deviceId, remotePath, uniqueDestFile(dir, name), size, progress);
            }
            progress.emit(true);
            call.resolve();
        } catch (Exception e) {
            call.reject("Download failed: " + e.getMessage());
        } finally {
            cancelledTransfers.remove(transferId);
        }
    }

    /** Every file and folder under a remote folder, parents before their children. */
    private void walkRemote(String deviceId, String remotePath, java.io.File localDir, java.util.List<RemoteItem> out, FsProgress progress) throws Exception {
        progress.check();
        org.json.JSONObject listing = withFs(deviceId, client -> client.request("readdir", fsArgs(remotePath)));
        org.json.JSONArray files = listing.optJSONArray("files");
        if (files == null) return;
        for (int i = 0; i < files.length(); i++) {
            org.json.JSONObject item = files.getJSONObject(i);
            String childName = item.optString("name", "");
            if (childName.isEmpty()) continue;
            String childRemote = joinRemotePath(remotePath, childName);
            java.io.File childLocal = new java.io.File(localDir, childName);
            if (item.optBoolean("isDirectory", false)) {
                out.add(new RemoteItem(childRemote, childLocal, true, 0));
                walkRemote(deviceId, childRemote, childLocal, out, progress);
            } else {
                out.add(new RemoteItem(childRemote, childLocal, false, item.optLong("size", 0)));
            }
        }
    }

    private void downloadRemoteFile(String deviceId, String remotePath, java.io.File destFile, long size, FsProgress progress) throws Exception {
        java.io.File parent = destFile.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        // Several chunks are requested ahead and written in order as they arrive.
        java.util.ArrayDeque<java.util.concurrent.Future<byte[]>> inFlight = new java.util.ArrayDeque<>();
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(destFile, "rw")) {
            long requested = 0;
            long offset = 0;
            while (offset < size) {
                progress.check();
                while (inFlight.size() < FS_CHUNKS_IN_FLIGHT && requested < size) {
                    org.json.JSONObject args = fsArgs(remotePath);
                    args.put("offset", requested);
                    args.put("length", (int) Math.min(FS_CHUNK_SIZE, size - requested));
                    inFlight.add(fsPool.submit(() -> withFs(deviceId, client -> client.requestData("read", args))));
                    requested += Math.min(FS_CHUNK_SIZE, size - requested);
                }
                int expected = (int) Math.min(FS_CHUNK_SIZE, size - offset);
                byte[] chunk = awaitChunk(inFlight.poll());
                if (chunk.length == 0) break;
                raf.write(chunk);
                offset += chunk.length;
                progress.advance(chunk.length);
                // A short chunk means the file shrank while it was copied: what follows is gone.
                if (chunk.length < expected) break;
            }
        } finally {
            for (java.util.concurrent.Future<byte[]> pending : inFlight) pending.cancel(true);
        }
    }

    @LinkMethod
    public void fsUploadItem(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String localPath = call.getString("localPath");
        String remoteParentPath = call.getString("remoteParentPath");
        if (deviceId == null || localPath == null || remoteParentPath == null || plugin.deviceManager == null) {
            call.reject("Missing deviceId/localPath/remoteParentPath, or not initialized");
            return;
        }
        String transferId = "fs-" + System.currentTimeMillis() + "-" + Math.random();
        fsPool.execute(() -> uploadFsItem(call, deviceId, android.net.Uri.parse(localPath), remoteParentPath, transferId));
    }

    private static final String[] FS_DOC_PROJECTION = {
        android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,
        android.provider.DocumentsContract.Document.COLUMN_SIZE,
    };

    /** One file or folder of a picked tree, found by the single listing walk of a folder upload. */
    private static final class LocalItem {
        final android.net.Uri uri;
        final String remote;
        final boolean isDir;
        final long size;

        LocalItem(android.net.Uri uri, String remote, boolean isDir, long size) {
            this.uri = uri;
            this.remote = remote;
            this.isDir = isDir;
            this.size = size;
        }
    }

    private void uploadFsItem(LinkCall call, String deviceId, android.net.Uri uri, String remoteParentPath, String transferId) {
        try {
            if (android.provider.DocumentsContract.isTreeUri(uri)) {
                String rootDocId = android.provider.DocumentsContract.getTreeDocumentId(uri);
                String treeName = queryDocumentDisplayName(uri, rootDocId);
                if (treeName == null || treeName.isEmpty()) treeName = "Folder";
                String remoteRootPath = joinRemotePath(remoteParentPath, treeName);
                FsProgress progress = new FsProgress(transferId, "upload", deviceId, remoteRootPath);
                java.util.List<LocalItem> items = new java.util.ArrayList<>();
                items.add(new LocalItem(uri, remoteRootPath, true, 0));
                walkTree(uri, rootDocId, remoteRootPath, items, progress);
                java.util.List<LocalItem> files = new java.util.ArrayList<>();
                long total = 0;
                // Folders first, in walk order (parents before children), then the files several at a time.
                for (LocalItem item : items) {
                    if (item.isDir) {
                        progress.check();
                        org.json.JSONObject args = fsArgs(item.remote);
                        args.put("isDirectory", true);
                        withFs(deviceId, client -> client.request("create", args));
                    } else {
                        files.add(item);
                        total += item.size;
                    }
                }
                progress.total = total;
                runFsJobs(files, item -> uploadFileBytes(deviceId, item.uri, item.remote, progress));
                progress.emit(true);
            } else {
                String name = "file";
                long size = 0;
                try (android.database.Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        int sizeIdx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE);
                        if (nameIdx >= 0) name = cursor.getString(nameIdx);
                        if (sizeIdx >= 0) size = cursor.getLong(sizeIdx);
                    }
                } catch (Exception ignored) {}
                String remotePath = joinRemotePath(remoteParentPath, name);
                FsProgress progress = new FsProgress(transferId, "upload", deviceId, remotePath);
                progress.total = size;
                uploadFileBytes(deviceId, uri, remotePath, progress);
                progress.emit(true);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Upload failed: " + e.getMessage());
        } finally {
            cancelledTransfers.remove(transferId);
        }
    }

    private String queryDocumentDisplayName(android.net.Uri treeUri, String documentId) {
        android.net.Uri docUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
                docUri, new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {}
        return null;
    }

    /** Every file and folder under a picked tree, parents before their children. */
    private void walkTree(android.net.Uri treeUri, String documentId, String remoteParentPath, java.util.List<LocalItem> out, FsProgress progress) throws Exception {
        progress.check();
        android.net.Uri childrenUri = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
        java.util.List<String[]> folders = new java.util.ArrayList<>();
        try (android.database.Cursor cursor = getContext().getContentResolver().query(childrenUri, FS_DOC_PROJECTION, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String childId = cursor.getString(0);
                String name = cursor.getString(1);
                if (name == null || name.isEmpty()) name = "item";
                String remotePath = joinRemotePath(remoteParentPath, name);
                if (android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2))) {
                    folders.add(new String[]{childId, remotePath});
                } else {
                    out.add(new LocalItem(android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, childId), remotePath, false, cursor.getLong(3)));
                }
            }
        }
        // Recursing after the cursor is closed keeps one cursor open at a time however deep the tree.
        for (String[] folder : folders) {
            out.add(new LocalItem(null, folder[1], true, 0));
            walkTree(treeUri, folder[0], folder[1], out, progress);
        }
    }

    private void uploadFileBytes(String deviceId, android.net.Uri fileUri, String remotePath, FsProgress progress) throws Exception {
        progress.check();
        org.json.JSONObject createArgs = fsArgs(remotePath);
        createArgs.put("isDirectory", false);
        withFs(deviceId, client -> client.request("create", createArgs));

        // A bounded producer: each chunk is read as the previous ones are still being written, with
        // at most FS_CHUNKS_IN_FLIGHT chunks (and their buffers) outstanding.
        java.util.ArrayDeque<java.util.concurrent.Future<Integer>> inFlight = new java.util.ArrayDeque<>();
        try (java.io.InputStream in = getContext().getContentResolver().openInputStream(fileUri)) {
            if (in == null) throw new Exception("Failed to open file for reading");
            long offset = 0;
            boolean eof = false;
            while (!eof || !inFlight.isEmpty()) {
                progress.check();
                while (!eof && inFlight.size() < FS_CHUNKS_IN_FLIGHT) {
                    byte[] chunk = new byte[FS_CHUNK_SIZE];
                    int filled = 0;
                    int n;
                    while (filled < chunk.length && (n = in.read(chunk, filled, chunk.length - filled)) != -1) filled += n;
                    if (filled < chunk.length) eof = true;
                    if (filled == 0) break;
                    final long chunkOffset = offset;
                    final int length = filled;
                    inFlight.add(fsPool.submit(() -> {
                        withFs(deviceId, client -> {
                            client.write(remotePath, chunkOffset, chunk, length);
                            return null;
                        });
                        return length;
                    }));
                    offset += filled;
                }
                if (inFlight.isEmpty()) break;
                progress.advance(awaitChunk(inFlight.poll()));
            }
        } finally {
            for (java.util.concurrent.Future<Integer> pending : inFlight) pending.cancel(true);
        }
    }

    @LinkMethod
    public void fsPickUploadItems(LinkCall call) {
        String mode = call.getString("mode", "file");
        if ("directory".equals(mode)) {
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT_TREE);
            startActivityForResult(call.invoke(), intent, "onFsUploadTreePicked");
        } else {
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
            intent.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.setType("*/*");
            startActivityForResult(call.invoke(), intent, "onFsUploadFilesPicked");
        }
    }

    // ===== Media streaming =====
    // One loopback HTTP server for all devices (the deviceId is in the URL), started on first use
    // and kept running, since restarting it would invalidate URLs a player may still be seeking in.

    // Instance-scoped, unlike the static hosting servers: its Source uses this instance's
    // file connections (withFs), so a static server could outlive the instance it serves through.
    private LinkFsStreamServer fsStreamServer;

    private synchronized LinkFsStreamServer ensureStreamServer() throws java.io.IOException {
        if (fsStreamServer == null || !fsStreamServer.isRunning()) {
            fsStreamServer = new LinkFsStreamServer(new LinkFsStreamServer.Source() {
                @Override
                public long size(String deviceId, String path) throws Exception {
                    return withFs(deviceId, client -> client.request("stat", fsArgs(path))).optLong("size", 0);
                }

                @Override
                public byte[] read(String deviceId, String path, long offset, int length) throws Exception {
                    org.json.JSONObject args = fsArgs(path);
                    args.put("offset", offset);
                    args.put("length", length);
                    return withFs(deviceId, client -> client.requestData("read", args));
                }
            });
            fsStreamServer.start();
        }
        return fsStreamServer;
    }

    @LinkMethod
    public void fsGetStreamUrl(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String remotePath = call.getString("remotePath");
        if (deviceId == null || remotePath == null || plugin.deviceManager == null) {
            call.reject("Missing deviceId/remotePath, or not initialized");
            return;
        }
        try {
            LinkFsStreamServer server = ensureStreamServer();
            JSObject ret = new JSObject();
            ret.put("url", server.buildUrl(deviceId, remotePath));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not start stream server: " + e.getMessage());
        }
    }

    private static final String VLC_PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=org.videolan.vlc";

    /** Opens a stream URL in the user's app for that media type. Only loopback URLs minted by this
     *  app are accepted; ACTION_VIEW on an arbitrary URL would let the web layer launch any
     *  registered handler. */
    @LinkMethod
    public void openExternal(LinkCall call) {
        String url = call.getString("url");
        // The one other URL accepted: VLC's Play Store page, offered when no app can play a file.
        // Android opens it in the Play Store app (or the browser where there is none).
        if (VLC_PLAY_STORE_URL.equals(url)) {
            try {
                android.content.Intent store = new android.content.Intent(
                    android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
                store.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(store);
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not open the Play Store: " + e.getMessage());
            }
            return;
        }
        if (url == null || !url.startsWith("http://127.0.0.1:")) {
            call.reject("Refusing to open a non-loopback URL");
            return;
        }
        try {
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            // Without an explicit MIME type Android resolves by the http scheme and offers browsers
            // instead of media players.
            intent.setDataAndType(android.net.Uri.parse(url), LinkFsStreamServer.mimeFor(url));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app available to open this file: " + e.getMessage());
        }
    }

    /** Documents are copied rather than streamed (as in desktop's fs-open-document handler), and
     *  Android viewers mostly refuse http:// anyway. The file is fetched into the app cache and
     *  shared through the manifest's FileProvider (file_paths.xml exposes the cache dir). The
     *  copy is read-only because edits could not reach the peer. */
    @LinkMethod
    public void fsOpenDocument(LinkCall call) {
        String deviceId = call.getString("deviceId");
        String remotePath = call.getString("remotePath");
        if (deviceId == null || remotePath == null || plugin.deviceManager == null) {
            call.reject("Missing deviceId/remotePath, or not initialized");
            return;
        }
        String transferId = "fs-" + System.currentTimeMillis() + "-" + Math.random();
        fsPool.execute(() -> openFsDocument(call, deviceId, remotePath, transferId));
    }

    private void openFsDocument(LinkCall call, String deviceId, String remotePath, String transferId) {
        try {
            org.json.JSONObject statInfo = withFs(deviceId, client -> client.request("stat", fsArgs(remotePath)));
            if (statInfo.optBoolean("isDirectory", false)) {
                call.reject("Cannot open a directory");
                return;
            }
            long size = statInfo.optLong("size", 0);

            String name = remotePath.substring(Math.max(remotePath.lastIndexOf('/'), remotePath.lastIndexOf('\\')) + 1);
            if (name.isEmpty()) name = "document";
            // Fresh subdirectory per open: same-named documents would otherwise collide, and the
            // read-only bit would block overwriting an old copy.
            java.io.File dir = new java.io.File(getContext().getCacheDir(),
                "documents/" + System.currentTimeMillis());
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            java.io.File destFile = new java.io.File(dir, name);

            FsProgress progress = new FsProgress(transferId, "download", deviceId, remotePath);
            progress.total = size;
            downloadRemoteFile(deviceId, remotePath, destFile, size, progress);
            progress.emit(true);

            //noinspection ResultOfMethodCallIgnored
            destFile.setReadOnly();

            android.net.Uri contentUri = androidx.core.content.FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", destFile);
            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            intent.setDataAndType(contentUri, LinkFsStreamServer.mimeFor(name));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);
            call.resolve();
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("No app installed that can open this file type");
        } catch (Exception e) {
            call.reject("Could not open document: " + e.getMessage());
        } finally {
            cancelledTransfers.remove(transferId);
        }
    }

    @LinkMethod
    public void fsCancelTransfer(LinkCall call) {
        String transferId = call.getString("transferId");
        if (transferId != null) {
            cancelledTransfers.add(transferId);
            call.resolve();
        } else {
            call.reject("Missing transferId");
        }
    }

    // Called through LinkPlugin's @ActivityCallback of the same name.
    void onFsUploadFilesPicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject());
            return;
        }
        android.content.Intent data = result.getData();
        java.util.List<android.net.Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null) {
            android.content.ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                android.net.Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        JSArray uriStrings = new JSArray();
        for (android.net.Uri uri : uris) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
            uriStrings.put(uri.toString());
        }
        JSObject ret = new JSObject();
        ret.put("paths", uriStrings);
        call.resolve(ret);
    }

    // Called through LinkPlugin's @ActivityCallback of the same name.
    void onFsUploadTreePicked(Invoke invoke, androidx.activity.result.ActivityResult result) {
        LinkCall call = invoke != null ? new LinkCall(invoke) : null;
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject());
            return;
        }
        android.net.Uri treeUri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {}
        JSArray uriStrings = new JSArray();
        uriStrings.put(treeUri.toString());
        JSObject ret = new JSObject();
        ret.put("paths", uriStrings);
        call.resolve(ret);
    }

    /** link.fs.request from a paired device: where this phone's file server (LinkFsServer) listens.
     *  Everything else, listings and bytes alike, goes over that server's own connections. */
    private void handleFsRequestPacket(String deviceId, LinkPacket packet) {
        try {
            org.json.JSONObject resp = new org.json.JSONObject();
            resp.put("requestId", packet.body.optString("requestId"));
            String action = packet.body.optString("action");
            if (!LinkDevicePermissions.check(getContext(), deviceId, "fileaccess")) {
                resp.put("success", false);
                resp.put("error", "Permission denied");
            } else if (!"open".equals(action)) {
                resp.put("success", false);
                resp.put("error", "Unknown file-system request: " + action);
            } else if (plugin.fsServer == null) {
                resp.put("success", false);
                resp.put("error", "The file server is not running");
            } else {
                org.json.JSONObject result = new org.json.JSONObject();
                result.put("port", plugin.fsServer.getPort());
                resp.put("success", true);
                resp.put("result", result);
            }
            plugin.deviceManager.sendTo(deviceId, new LinkPacket("link.fs.response", resp));
        } catch (Exception e) {
            android.util.Log.w(TAG, "Could not answer a file-system request", e);
        }
    }

    private void handleFsResponsePacket(LinkPacket packet) {
        java.util.function.Consumer<org.json.JSONObject> waiter = pendingFsOpens.remove(packet.body.optString("requestId"));
        if (waiter != null) waiter.accept(packet.body);
    }
}
