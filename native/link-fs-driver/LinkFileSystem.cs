using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Fsp;
using FspFileInfo = Fsp.Interop.FileInfo;
using FspVolumeInfo = Fsp.Interop.VolumeInfo;

namespace Link.FsDriver;

/// <summary>
/// WinFsp user-mode filesystem that exposes a paired Android device's storage.
///
/// Writes are coalesced into 4 MB chunks and uploaded in the background with at
/// most <see cref="MaxPendingWriteTasks"/> chunks in flight, so Explorer's copy
/// engine is throttled to roughly the real network rate rather than filling a
/// local cache. Pending chunks are drained on Flush, Cleanup and Close.
///
/// Reads are served through an in-memory LRU chunk cache (512 MB by default), with read-ahead
/// once a file is read sequentially (see <see cref="ReadCache"/>).
///
/// Path mapping:
///   \Internal Storage\Movies\foo.mp4  →  /storage/emulated/0/Movies/foo.mp4
/// </summary>
public sealed class LinkFileSystem : FileSystemBase
{
    // NT status codes come from FileSystemBase; attribute flags are defined here.
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10u;
    private const uint FILE_ATTRIBUTE_ARCHIVE   = 0x20u;

    private readonly ApiClient _api;
    private readonly FsRoot[]  _roots;
    private readonly ReadCache _cache;

    // Directory listing cache: realPath → listing (with a by-name index) and expiry. Also guards
    // the stat cache: realPath → stat result (null when the path does not exist) and expiry.
    private readonly Dictionary<string, DirListing> _dirCache = new();
    private readonly Dictionary<string, (FsEntry? Entry, DateTime Expiry)> _statCache = new();
    private readonly object _dirCacheLock = new();
    private static readonly TimeSpan DirCacheTtl = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan StatCacheTtl = TimeSpan.FromSeconds(3);

    private sealed record DirListing(FsEntry[] Entries, Dictionary<string, FsEntry> ByName, DateTime Expiry);

    public LinkFileSystem(ApiClient api, FsRoot[] roots, long cacheSizeBytes)
    {
        _api   = api;
        _roots = roots;
        _cache = new ReadCache(cacheSizeBytes);
    }

    // -----------------------------------------------------------------------
    // Volume info
    // -----------------------------------------------------------------------

    public override int GetVolumeInfo(out FspVolumeInfo volumeInfo)
    {
        volumeInfo = default;
        long total = 0, free = 0;
        foreach (var r in _roots) { total += r.TotalSpace; free += r.FreeSpace; }
        if (total == 0) { total = 64L * 1024 * 1024 * 1024; free = 32L * 1024 * 1024 * 1024; }
        volumeInfo.TotalSize = (ulong)total;
        volumeInfo.FreeSize  = (ulong)free;
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // Name lookup
    // -----------------------------------------------------------------------

    public override int GetSecurityByName(
        string fileName,
        out uint fileAttributes,
        ref byte[] securityDescriptor)
    {
        fileAttributes = 0;

        if (IsVirtualRoot(fileName))
        {
            fileAttributes = FILE_ATTRIBUTE_DIRECTORY;
            return STATUS_SUCCESS;
        }

        if (IsVolumeRoot(fileName, out _))
        {
            fileAttributes = FILE_ATTRIBUTE_DIRECTORY;
            return STATUS_SUCCESS;
        }

        string? realPath = Translate(fileName);
        if (realPath == null) return STATUS_OBJECT_NAME_NOT_FOUND;

        FsEntry? entry = StatCached(realPath);
        if (entry == null) return STATUS_OBJECT_NAME_NOT_FOUND;

        fileAttributes = entry.IsDirectory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE;
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // Open / Create / Close
    // -----------------------------------------------------------------------

    public override int Open(
        string  fileName,
        uint    createOptions,
        uint    grantedAccess,
        out object? fileNode,
        out object? fileDesc,
        out FspFileInfo fileInfo,
        out string normalizedName)
    {
        fileNode       = null;
        fileDesc       = null;
        fileInfo       = default;
        normalizedName = fileName;

        if (IsVirtualRoot(fileName))
        {
            var ctx = new FileContext { WinPath = fileName, RealPath = "", IsDirectory = true, IsVirtualRoot = true };
            fileNode = fileDesc = ctx;
            FillFileInfo(ctx, ref fileInfo);
            return STATUS_SUCCESS;
        }

        if (IsVolumeRoot(fileName, out var volRoot))
        {
            var ctx = new FileContext { WinPath = fileName, RealPath = volRoot.Path, IsDirectory = true };
            fileNode = fileDesc = ctx;
            FillFileInfo(ctx, ref fileInfo);
            return STATUS_SUCCESS;
        }

        string? realPath = Translate(fileName);
        if (realPath == null) return STATUS_OBJECT_NAME_NOT_FOUND;

        FsEntry? entry = StatCached(realPath);
        if (entry == null) return STATUS_OBJECT_NAME_NOT_FOUND;

        var fctx = new FileContext
        {
            WinPath     = fileName,
            RealPath    = realPath,
            IsDirectory = entry.IsDirectory,
            FileSize    = entry.Size,
            Mtime       = entry.Mtime,
        };
        fileNode = fileDesc = fctx;
        FillFileInfo(fctx, ref fileInfo);
        return STATUS_SUCCESS;
    }

    public override int Create(
        string  fileName,
        uint    createOptions,
        uint    grantedAccess,
        uint    fileAttributes,
        byte[]  securityDescriptor,
        ulong   allocationSize,
        out object? fileNode,
        out object? fileDesc,
        out FspFileInfo fileInfo,
        out string normalizedName)
    {
        fileNode       = null;
        fileDesc       = null;
        fileInfo       = default;
        normalizedName = fileName;

        bool isDir = (createOptions & 1u) != 0; // FILE_DIRECTORY_FILE

        string? realPath = Translate(fileName);
        if (realPath == null) return STATUS_ACCESS_DENIED;

        bool ok = _api.Create(realPath, isDir);
        if (!ok) return STATUS_DEVICE_NOT_READY;

        InvalidateEntry(realPath);

        var ctx = new FileContext
        {
            WinPath     = fileName,
            RealPath    = realPath,
            IsDirectory = isDir,
            FileSize    = 0,
            Mtime       = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        fileNode = fileDesc = ctx;
        FillFileInfo(ctx, ref fileInfo);
        return STATUS_SUCCESS;
    }

    public override int Overwrite(
        object? fileNode,
        object? fileDesc,
        uint    fileAttributes,
        bool    replaceFileAttributes,
        ulong   allocationSize,
        out FspFileInfo fileInfo)
    {
        var ctx = (FileContext)fileDesc!;
        ctx.FileSize = 0;
        ctx.Wrote = true;
        _cache.Invalidate(ctx.RealPath);
        fileInfo = default;
        FillFileInfo(ctx, ref fileInfo);
        return STATUS_SUCCESS;
    }

    public override void Cleanup(object? fileNode, object? fileDesc, string? fileName, uint flags)
    {
        if (fileDesc is FileContext ctx)
        {
            // FspCleanupDelete = 0x01
            if ((flags & 0x01u) != 0 && !string.IsNullOrEmpty(ctx.RealPath))
            {
                _api.Delete(ctx.RealPath);
                _cache.Invalidate(ctx.RealPath);
                InvalidateEntry(ctx.RealPath);
            }
            else
            {
                try { WaitForAllWrites(ctx); } catch {}
                // The cached listing and stat still hold the size from before the writes.
                if (ctx.Wrote) InvalidateEntry(ctx.RealPath);
            }
        }
    }

    public override void Close(object? fileNode, object? fileDesc)
    {
        if (fileDesc is FileContext ctx)
        {
            try { WaitForAllWrites(ctx); } catch {}
            if (ctx.Wrote) InvalidateEntry(ctx.RealPath);
        }
    }

    // -----------------------------------------------------------------------
    // Read — served from LRU cache, fetches from device on miss
    // -----------------------------------------------------------------------

    public override int Read(
        object? fileNode,
        object? fileDesc,
        nint    buffer,
        ulong   offset,
        uint    length,
        out uint bytesTransferred)
    {
        bytesTransferred = 0;
        var ctx = (FileContext)fileDesc!;

        if ((long)offset >= ctx.FileSize && ctx.FileSize > 0) return STATUS_END_OF_FILE;

        int toRead = (int)Math.Min((long)length, ctx.FileSize - (long)offset);
        if (toRead <= 0) return STATUS_END_OF_FILE;

        int actual = _cache.Read(ctx.RealPath, (long)offset, toRead, buffer,
            (chunkOff, chunkLen) => _api.Read(ctx.RealPath, chunkOff, chunkLen));

        if (actual < 0) return STATUS_DEVICE_NOT_READY;

        bytesTransferred = (uint)actual;
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // Write — buffered into chunks, uploaded asynchronously
    // -----------------------------------------------------------------------

    private const int WriteChunkSize = 4 * 1024 * 1024; // one upload request per chunk
    private const int MaxPendingWriteTasks = 4;

    public override int Write(
        object? fileNode,
        object? fileDesc,
        nint    buffer,
        ulong   offset,
        uint    length,
        bool    writeToEndOfFile,
        bool    constrainedIo,
        out uint        bytesTransferred,
        out FspFileInfo fileInfo)
    {
        bytesTransferred = 0;
        fileInfo         = default;
        var ctx = (FileContext)fileDesc!;

        long writeOffset = writeToEndOfFile ? ctx.FileSize : (long)offset;

        byte[] data = new byte[length];
        Marshal.Copy(buffer, data, 0, (int)length);

        lock (ctx.WriteLock)
        {
            // Only contiguous writes are coalesced; a seek flushes the buffer.
            if (ctx.WriteBufferLen > 0 && ctx.WriteBufferOffset + ctx.WriteBufferLen == writeOffset)
            {
                if (ctx.WriteBufferLen + data.Length > WriteChunkSize)
                {
                    FlushCurrentBuffer(ctx);
                }
            }
            else if (ctx.WriteBufferLen > 0)
            {
                FlushCurrentBuffer(ctx);
            }

            if (ctx.WriteBufferLen == 0)
            {
                ctx.WriteBufferOffset = writeOffset;
            }

            ctx.WriteBuffer.Write(data, 0, data.Length);
            ctx.WriteBufferLen += data.Length;

            if (ctx.WriteBufferLen >= WriteChunkSize)
            {
                FlushCurrentBuffer(ctx);
            }

            long newEof = writeOffset + data.Length;
            if (newEof > ctx.FileSize) ctx.FileSize = newEof;
            ctx.Mtime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            ctx.Wrote = true;
            _cache.Invalidate(ctx.RealPath);
        }

        bytesTransferred = (uint)data.Length;
        FillFileInfo(ctx, ref fileInfo);
        return STATUS_SUCCESS;
    }

    private void FlushCurrentBuffer(FileContext ctx)
    {
        if (ctx.WriteBufferLen == 0) return;

        byte[] chunk = ctx.WriteBuffer.ToArray();
        long chunkOffset = ctx.WriteBufferOffset;

        ctx.WriteBuffer.SetLength(0);
        ctx.WriteBufferLen = 0;

        // Backpressure: block the WinFsp thread until an in-flight chunk completes,
        // surfacing any upload failure to the caller.
        lock (ctx.WriteTasks)
        {
            while (ctx.WriteTasks.Count >= MaxPendingWriteTasks)
            {
                var finished = Task.WhenAny(ctx.WriteTasks).GetAwaiter().GetResult();
                ctx.WriteTasks.Remove(finished);
                if (finished.IsFaulted)
                    throw finished.Exception ?? new Exception("Write chunk failed");
            }

            var task = Task.Run(() =>
            {
                if (!_api.Write(ctx.RealPath, chunkOffset, chunk))
                {
                    throw new Exception("API write returned false");
                }
            });

            ctx.WriteTasks.Add(task);
        }
    }

    private void WaitForAllWrites(FileContext ctx)
    {
        lock (ctx.WriteLock)
        {
            FlushCurrentBuffer(ctx);
        }

        lock (ctx.WriteTasks)
        {
            if (ctx.WriteTasks.Count > 0)
            {
                Task.WaitAll(ctx.WriteTasks.ToArray());
                ctx.WriteTasks.Clear();
            }
        }
    }

    public override int Flush(object? fileNode, object? fileDesc, out FspFileInfo fileInfo)
    {
        fileInfo = default;
        if (fileDesc is FileContext ctx)
        {
            try
            {
                WaitForAllWrites(ctx);
                FillFileInfo(ctx, ref fileInfo);
            }
            catch
            {
                return STATUS_DEVICE_NOT_READY;
            }
        }
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // File info / metadata
    // -----------------------------------------------------------------------

    public override int GetFileInfo(object? fileNode, object? fileDesc, out FspFileInfo fileInfo)
    {
        fileInfo = default;
        if (fileDesc is FileContext ctx) { FillFileInfo(ctx, ref fileInfo); return STATUS_SUCCESS; }
        return STATUS_OBJECT_NAME_NOT_FOUND;
    }

    public override int SetBasicInfo(
        object? fileNode, object? fileDesc,
        uint fileAttributes,
        ulong creationTime, ulong lastAccessTime, ulong lastWriteTime, ulong changeTime,
        out FspFileInfo fileInfo)
    {
        fileInfo = default;
        if (fileDesc is FileContext ctx) FillFileInfo(ctx, ref fileInfo);
        return STATUS_SUCCESS;
    }

    public override int SetFileSize(
        object? fileNode, object? fileDesc,
        ulong newSize, bool setAllocationSize,
        out FspFileInfo fileInfo)
    {
        fileInfo = default;
        if (fileDesc is FileContext ctx)
        {
            if (!setAllocationSize) ctx.FileSize = (long)newSize;
            FillFileInfo(ctx, ref fileInfo);
        }
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // Delete / Rename
    // -----------------------------------------------------------------------

    public override int CanDelete(object? fileNode, object? fileDesc, string? fileName)
        => STATUS_SUCCESS;

    public override int Rename(
        object? fileNode, object? fileDesc,
        string  fileName, string newFileName,
        bool    replaceIfExists)
    {
        string? src = Translate(fileName);
        string? dst = Translate(newFileName);
        if (src == null || dst == null) return STATUS_ACCESS_DENIED;

        if (!_api.Rename(src, dst)) return STATUS_DEVICE_NOT_READY;

        _cache.Invalidate(src);
        InvalidateEntry(src);
        InvalidateEntry(dst);
        InvalidateDirCache(src); // a renamed folder's own listing names the old paths
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // Directory listing
    // -----------------------------------------------------------------------

    public override int ReadDirectory(
        object? fileNode, object? fileDesc,
        string? pattern, string? marker,
        nint    buffer, uint length,
        out uint bytesTransferred)
    {
        var ctx = (FileContext)fileDesc!;
        return BufferedReadDirectory(ctx.DirBuf, fileNode, fileDesc, pattern, marker, buffer, length, out bytesTransferred);
    }

    public override bool ReadDirectoryEntry(
        object? fileNode, object? fileDesc,
        string? pattern, string? marker,
        ref object? context,
        out string  fileName,
        out FspFileInfo fileInfo)
    {
        fileName = "";
        fileInfo = default;
        var ctx  = (FileContext)fileDesc!;

        if (context == null)
        {
            var entries = BuildDirEntries(ctx);
            context = entries.GetEnumerator();
        }

        var iter = (IEnumerator<DirEntry>)context;
        while (iter.MoveNext())
        {
            var e = iter.Current;
            // Resume after the marker on continuation calls.
            if (marker != null &&
                string.Compare(e.Name, marker, StringComparison.OrdinalIgnoreCase) <= 0)
                continue;

            fileName = e.Name;
            ulong ft = ToFileTime(e.Mtime);
            fileInfo.FileAttributes  = e.IsDir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE;
            fileInfo.FileSize        = e.IsDir ? 0u : (ulong)e.Size;
            fileInfo.AllocationSize  = e.IsDir ? 0u : (ulong)((e.Size + 511) / 512 * 512);
            fileInfo.CreationTime    = ft;
            fileInfo.LastAccessTime  = ft;
            fileInfo.LastWriteTime   = ft;
            fileInfo.ChangeTime      = ft;
            return true;
        }

        return false;
    }

    // -----------------------------------------------------------------------
    // Directory entry enumeration helpers
    // -----------------------------------------------------------------------

    private List<DirEntry> BuildDirEntries(FileContext ctx)
    {
        var list = new List<DirEntry>();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        list.Add(new DirEntry(".", true, 0, ctx.Mtime > 0 ? ctx.Mtime : now));
        list.Add(new DirEntry("..", true, 0, now));

        if (ctx.IsVirtualRoot)
        {
            foreach (var r in _roots)
                list.Add(new DirEntry(r.Name, true, 0, now));
        }
        else
        {
            foreach (var e in GetDirEntries(ctx.RealPath))
                list.Add(new DirEntry(e.Name, e.IsDirectory, e.Size, e.Mtime));
        }

        // ReadDirectoryEntry resumes after the marker by name, which only works on a sorted list;
        // the device returns entries in no particular order. "." and ".." still sort first.
        list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return list;
    }

    private readonly record struct DirEntry(string Name, bool IsDir, long Size, long Mtime);

    // -----------------------------------------------------------------------
    // Path translation helpers
    // -----------------------------------------------------------------------

    private static bool IsVirtualRoot(string winPath)
        => winPath is "\\" or "";

    private bool IsVolumeRoot(string winPath, out FsRoot root)
    {
        root = null!;
        var trimmed = winPath.TrimStart('\\');
        if (trimmed.Contains('\\')) return false;
        foreach (var r in _roots)
        {
            if (string.Equals(r.Name, trimmed, StringComparison.OrdinalIgnoreCase))
            {
                root = r;
                return true;
            }
        }
        return false;
    }

    private string? Translate(string winPath)
    {
        if (IsVirtualRoot(winPath)) return null;

        var parts = winPath.TrimStart('\\').Split('\\');
        FsRoot? matched = null;
        foreach (var r in _roots)
            if (string.Equals(r.Name, parts[0], StringComparison.OrdinalIgnoreCase))
            { matched = r; break; }

        if (matched == null) return null;

        for (int i = 1; i < parts.Length; i++)
            if (parts[i] is ".." or ".") return null;

        if (parts.Length == 1) return matched.Path;
        return matched.Path + "/" + string.Join("/", parts, 1, parts.Length - 1);
    }

    private static string ParentRealPath(string realPath)
    {
        int idx = realPath.LastIndexOf('/');
        return idx <= 0 ? realPath : realPath[..idx];
    }

    // -----------------------------------------------------------------------
    // Stat / dir cache
    // -----------------------------------------------------------------------

    // Explorer opens the same path many times in a burst (attributes, security, icon, preview), and
    // probes names that do not exist (desktop.ini, thumbs.db, autorun.inf). A fresh listing of the
    // parent answers both, found and not found; otherwise a single stat is remembered briefly.
    private FsEntry? StatCached(string realPath)
    {
        string parent = ParentRealPath(realPath);
        string name = realPath[(parent.Length < realPath.Length ? parent.Length + 1 : 0)..];
        lock (_dirCacheLock)
        {
            var now = DateTime.UtcNow;
            if (_dirCache.TryGetValue(parent, out var c) && c.Expiry > now)
                return c.ByName.TryGetValue(name, out var listed) ? listed : null;
            if (_statCache.TryGetValue(realPath, out var s) && s.Expiry > now)
                return s.Entry;
        }
        var entry = _api.Stat(realPath);
        lock (_dirCacheLock)
        {
            if (_statCache.Count > 4096) _statCache.Clear();
            _statCache[realPath] = (entry, DateTime.UtcNow + StatCacheTtl);
        }
        return entry;
    }

    private FsEntry[] GetDirEntries(string realPath)
    {
        lock (_dirCacheLock)
        {
            if (_dirCache.TryGetValue(realPath, out var c) && c.Expiry > DateTime.UtcNow)
                return c.Entries;
        }
        var entries = _api.Readdir(realPath);
        var byName = new Dictionary<string, FsEntry>(entries.Length, StringComparer.OrdinalIgnoreCase);
        foreach (var e in entries) byName[e.Name] = e;
        lock (_dirCacheLock)
        {
            if (_dirCache.Count > 1024) _dirCache.Clear();
            _dirCache[realPath] = new DirListing(entries, byName, DateTime.UtcNow + DirCacheTtl);
        }
        return entries;
    }

    private void InvalidateDirCache(string realPath)
    {
        lock (_dirCacheLock) _dirCache.Remove(realPath);
    }

    /// Forgets what is known about one path: its stat and its parent's listing.
    private void InvalidateEntry(string realPath)
    {
        lock (_dirCacheLock)
        {
            _statCache.Remove(realPath);
            _dirCache.Remove(ParentRealPath(realPath));
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static ulong ToFileTime(long unixMs)
    {
        if (unixMs <= 0) return 0;
        return (ulong)new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero)
            .AddMilliseconds(unixMs).ToFileTime();
    }

    private static void FillFileInfo(FileContext ctx, ref FspFileInfo fi)
    {
        ulong ft = ToFileTime(ctx.Mtime);
        fi.FileAttributes  = ctx.IsDirectory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE;
        fi.FileSize        = (ulong)ctx.FileSize;
        fi.AllocationSize  = (ulong)((ctx.FileSize + 511) / 512 * 512);
        fi.CreationTime    = ft;
        fi.LastAccessTime  = ft;
        fi.LastWriteTime   = ft;
        fi.ChangeTime      = ft;
    }

    // -----------------------------------------------------------------------
    // Per-handle state
    // -----------------------------------------------------------------------

    private sealed class FileContext
    {
        public string  WinPath     = "";
        public string  RealPath    = "";
        public bool    IsDirectory = false;
        public bool    IsVirtualRoot = false;
        public long    FileSize    = 0;
        public long    Mtime       = 0;
        public readonly FileSystemBase.DirectoryBuffer DirBuf = new();

        // Write coalescing state (see Write).
        public readonly object WriteLock = new();
        public readonly System.IO.MemoryStream WriteBuffer = new();
        public long WriteBufferOffset = 0;
        public int WriteBufferLen = 0;
        // Set once this handle wrote, so closing it drops the stale cached size.
        public bool Wrote = false;
        public readonly List<Task> WriteTasks = new();
    }
}
