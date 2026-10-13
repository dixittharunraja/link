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
/// WinFSP user-mode filesystem driver for Link.
///
/// Every <see cref="Write"/> call sends data SYNCHRONOUSLY to the Android device
/// and blocks until the device confirms receipt. WinFSP propagates this block up
/// through the Windows I/O stack: the WriteFile() call in Explorer's copy engine
/// does not return until the device has the data, so Explorer's progress bar and
/// transfer-rate display reflect real Wi-Fi throughput rather than local-cache fill.
///
/// Reads are served through an in-memory LRU chunk cache (default 512 MB).
///
/// Path mapping:
///   \Internal Storage\Movies\foo.mp4  →  /storage/emulated/0/Movies/foo.mp4
/// </summary>
public sealed class LinkFileSystem : FileSystemBase
{
    // Windows file attribute flags (NT status codes are inherited from FileSystemBase)
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10u;
    private const uint FILE_ATTRIBUTE_ARCHIVE   = 0x20u;

    private readonly ApiClient _api;
    private readonly FsRoot[]  _roots;
    private readonly ReadCache _cache;

    // Directory listing cache: realPath → (entries, expiry)
    private readonly Dictionary<string, (FsEntry[] Entries, DateTime Expiry)> _dirCache = new();
    private readonly object _dirCacheLock = new();
    private static readonly TimeSpan DirCacheTtl = TimeSpan.FromSeconds(30);

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

        InvalidateDirCache(ParentRealPath(realPath));

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
                InvalidateDirCache(ParentRealPath(ctx.RealPath));
            }
            else
            {
                try { WaitForAllWrites(ctx); } catch {}
            }
        }
    }

    public override void Close(object? fileNode, object? fileDesc)
    {
        if (fileDesc is FileContext ctx)
        {
            try { WaitForAllWrites(ctx); } catch {}
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

        byte[]? data = _cache.Read(ctx.RealPath, (long)offset, toRead,
            (chunkOff, chunkLen) => _api.Read(ctx.RealPath, chunkOff, chunkLen));

        if (data == null) return STATUS_DEVICE_NOT_READY;

        int actual = Math.Min(data.Length, toRead);
        Marshal.Copy(data, 0, buffer, actual);
        bytesTransferred = (uint)actual;
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // Write — Pipelined 4MB write buffer with async flush to phone
    // -----------------------------------------------------------------------

    private const int WriteChunkSize = 4 * 1024 * 1024; // 4 MB per HTTP / WSS chunk
    private const int MaxPendingWriteTasks = 4;        // Max 4 parallel in-flight writes

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
            // If the incoming write is sequential and continues our current buffer:
            if (ctx.WriteBufferLen > 0 && ctx.WriteBufferOffset + ctx.WriteBufferLen == writeOffset)
            {
                // If appending would exceed 4 MB, flush the current buffer first
                if (ctx.WriteBufferLen + data.Length > WriteChunkSize)
                {
                    FlushCurrentBuffer(ctx);
                }
            }
            else if (ctx.WriteBufferLen > 0)
            {
                // Non-sequential write: flush pending buffer
                FlushCurrentBuffer(ctx);
            }

            // If empty buffer, set the start offset
            if (ctx.WriteBufferLen == 0)
            {
                ctx.WriteBufferOffset = writeOffset;
            }

            // Append into write buffer stream
            ctx.WriteBuffer.Write(data, 0, data.Length);
            ctx.WriteBufferLen += data.Length;

            // If buffer reaches or exceeds 4 MB, flush it
            if (ctx.WriteBufferLen >= WriteChunkSize)
            {
                FlushCurrentBuffer(ctx);
            }

            long newEof = writeOffset + data.Length;
            if (newEof > ctx.FileSize) ctx.FileSize = newEof;
            ctx.Mtime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
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

        // Throttle backpressure: if more than 4 chunks are currently writing, wait for one
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
        InvalidateDirCache(ParentRealPath(src));
        InvalidateDirCache(ParentRealPath(dst));
        return STATUS_SUCCESS;
    }

    // -----------------------------------------------------------------------
    // Directory listing — uses ReadDirectoryEntry iterator + BufferedReadDirectory
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

        // First call: build the entry list and create an enumerator
        if (context == null)
        {
            var entries = BuildDirEntries(ctx);
            context = entries.GetEnumerator();
        }

        var iter = (IEnumerator<DirEntry>)context;
        while (iter.MoveNext())
        {
            var e = iter.Current;
            // Apply the marker (skip entries up to and including marker)
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

        return false; // No more entries
    }

    // -----------------------------------------------------------------------
    // Directory entry enumeration helpers
    // -----------------------------------------------------------------------

    private List<DirEntry> BuildDirEntries(FileContext ctx)
    {
        var list = new List<DirEntry>();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // . and .. always come first
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

    private FsEntry? StatCached(string realPath)
    {
        lock (_dirCacheLock)
        {
            string parent = ParentRealPath(realPath);
            if (_dirCache.TryGetValue(parent, out var c) && c.Expiry > DateTime.UtcNow)
            {
                string name = realPath[(parent.Length < realPath.Length ? parent.Length + 1 : 0)..];
                foreach (var e in c.Entries)
                    if (string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase)) return e;
            }
        }
        return _api.Stat(realPath);
    }

    private FsEntry[] GetDirEntries(string realPath)
    {
        lock (_dirCacheLock)
        {
            if (_dirCache.TryGetValue(realPath, out var c) && c.Expiry > DateTime.UtcNow)
                return c.Entries;
        }
        var entries = _api.Readdir(realPath);
        lock (_dirCacheLock)
            _dirCache[realPath] = (entries, DateTime.UtcNow + DirCacheTtl);
        return entries;
    }

    private void InvalidateDirCache(string realPath)
    {
        lock (_dirCacheLock) _dirCache.Remove(realPath);
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

        // 4MB pipelined write buffer state
        public readonly object WriteLock = new();
        public readonly System.IO.MemoryStream WriteBuffer = new();
        public long WriteBufferOffset = 0;
        public int WriteBufferLen = 0;
        public readonly List<Task> WriteTasks = new();
    }
}
