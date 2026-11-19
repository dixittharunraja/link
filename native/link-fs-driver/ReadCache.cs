using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace Link.FsDriver;

/// <summary>
/// In-memory LRU read cache keyed by (realPath, chunkIndex). When the total
/// cached size would exceed the configured limit, least-recently-used chunks
/// are evicted. Serving WinFsp reads from whole chunks avoids a device
/// round-trip per small read request.
///
/// Read-ahead starts only once a file is read sequentially (two reads in a row
/// that continue where the last one ended), and its window grows with the
/// streak, so Explorer sniffing a file header or a random-access reader costs
/// one chunk instead of a burst of prefetches. A read that needs a chunk
/// already being fetched waits for that fetch instead of issuing its own.
/// </summary>
public sealed class ReadCache
{
    private readonly long                               _maxBytes;
    private readonly Dictionary<CacheKey, CacheEntry>  _map  = new();
    private readonly LinkedList<CacheKey>               _lru  = new();
    private          long                               _used = 0;
    private readonly object                             _lock = new();
    // Fetches in progress, shared by every reader of the same chunk.
    private readonly Dictionary<CacheKey, Task<byte[]?>> _inflight = new();
    // Cached chunk indexes per path, so invalidating one file does not scan the whole cache.
    private readonly Dictionary<string, HashSet<int>>   _byPath = new();
    // Bumped by Invalidate; a fetch that started under an older generation is not cached.
    private readonly Dictionary<string, int>            _generation = new();
    // Per path: where the last read ended and how many reads in a row continued from there.
    private readonly Dictionary<string, (long End, int Streak)> _sequential = new();

    // 1 MB chunks: small enough that a random read stays cheap, large enough to amortise
    // per-request latency on the device link once read-ahead keeps several in flight.
    public const int ChunkSize = 1024 * 1024;
    // Read-ahead window, in chunks, at the start of a sequential streak and at most.
    private const int MinAhead = 2;
    private const int MaxAhead = 8;

    public ReadCache(long maxBytes) => _maxBytes = maxBytes;

    /// <summary>
    /// Copies [offset, offset+length) into <paramref name="buffer"/> from cache,
    /// fetching missing chunks via <paramref name="fetch"/>. Returns the number
    /// of bytes copied (short at end of file), or -1 if a fetch failed.
    /// </summary>
    public int Read(string realPath, long offset, int length, nint buffer,
        Func<long, int, byte[]?> fetch)
    {
        if (length <= 0) return 0;
        long chunkStart = (offset / ChunkSize) * ChunkSize;
        long chunkEnd   = ((offset + length - 1) / ChunkSize + 1) * ChunkSize;

        int ahead = NoteRead(realPath, offset, length);
        int copied = 0;
        for (long cs = chunkStart; cs < chunkEnd; cs += ChunkSize)
        {
            int chunkIdx = (int)(cs / ChunkSize);
            byte[]? data = GetOrFetch(realPath, chunkIdx, fetch);
            if (data == null) return -1;
            // A short chunk is the end of the file: nothing after it to read or prefetch.
            bool lastChunk = data.Length < ChunkSize;

            if (!lastChunk)
                for (int a = 1; a <= ahead; a++)
                    Prefetch(realPath, chunkIdx + a, fetch);

            long sliceOff = Math.Max(offset, cs) - cs;
            long sliceEnd = Math.Min(offset + length, cs + data.Length) - cs;
            if (sliceEnd > sliceOff)
            {
                // Straight from the cached chunk into WinFsp's buffer: no intermediate copies.
                Marshal.Copy(data, (int)sliceOff, buffer + copied, (int)(sliceEnd - sliceOff));
                copied += (int)(sliceEnd - sliceOff);
            }
            if (lastChunk) break;
        }
        return copied;
    }

    /// Drops all cached chunks for a path; called after writes and deletes.
    public void Invalidate(string realPath)
    {
        lock (_lock)
        {
            _generation[realPath] = _generation.TryGetValue(realPath, out var g) ? g + 1 : 1;
            _sequential.Remove(realPath);
            if (!_byPath.TryGetValue(realPath, out var indexes)) return;
            foreach (var idx in new List<int>(indexes)) Remove(new CacheKey(realPath, idx));
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// Records a read and returns how many chunks to read ahead (0 when not sequential).
    private int NoteRead(string realPath, long offset, int length)
    {
        lock (_lock)
        {
            int streak = 0;
            if (_sequential.TryGetValue(realPath, out var s) && s.End == offset) streak = s.Streak + 1;
            if (_sequential.Count > 1024 && !_sequential.ContainsKey(realPath)) _sequential.Clear();
            _sequential[realPath] = (offset + length, streak);
            if (streak < 2) return 0;
            // The window doubles as the streak goes on: 2, 4, then 8 chunks.
            return Math.Min(MaxAhead, MinAhead << Math.Min(streak - 2, 2));
        }
    }

    private void Prefetch(string realPath, int chunkIdx, Func<long, int, byte[]?> fetch)
    {
        var key = new CacheKey(realPath, chunkIdx);
        lock (_lock)
        {
            // Skip chunks already cached or already being fetched, so repeated reads of the
            // same region do not queue duplicate device requests.
            if (_map.ContainsKey(key) || _inflight.ContainsKey(key)) return;
        }
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try { GetOrFetch(realPath, chunkIdx, fetch); }
            catch {}
        });
    }

    private byte[]? GetOrFetch(string realPath, int chunkIdx, Func<long, int, byte[]?> fetch)
    {
        var key = new CacheKey(realPath, chunkIdx);
        Task<byte[]?>? pending;
        TaskCompletionSource<byte[]?>? mine = null;
        int generation;
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var entry))
            {
                _lru.Remove(entry.Node);
                _lru.AddLast(entry.Node);
                return entry.Data;
            }
            if (!_inflight.TryGetValue(key, out pending))
            {
                mine = new TaskCompletionSource<byte[]?>(TaskCreationOptions.RunContinuationsAsynchronously);
                pending = mine.Task;
                _inflight[key] = pending;
            }
            generation = _generation.TryGetValue(realPath, out var g) ? g : 0;
        }

        // Someone else is fetching this chunk: wait for theirs.
        if (mine == null) return pending.GetAwaiter().GetResult();

        byte[]? data = null;
        try
        {
            data = fetch((long)chunkIdx * ChunkSize, ChunkSize);
        }
        finally
        {
            lock (_lock)
            {
                _inflight.Remove(key);
                bool current = (_generation.TryGetValue(realPath, out var g) ? g : 0) == generation;
                if (data != null && data.Length > 0 && current && !_map.ContainsKey(key))
                    Insert(key, data);
            }
            mine.TrySetResult(data);
        }
        return data;
    }

    private void Insert(CacheKey key, byte[] data)
    {
        while (_used + data.Length > _maxBytes && _lru.First != null)
            Remove(_lru.First.Value);

        var node = _lru.AddLast(key);
        _map[key] = new CacheEntry(data, node);
        _used += data.Length;
        if (!_byPath.TryGetValue(key.Path, out var indexes))
            _byPath[key.Path] = indexes = new HashSet<int>();
        indexes.Add(key.ChunkIndex);
    }

    private void Remove(CacheKey key)
    {
        if (!_map.TryGetValue(key, out var entry)) return;
        _lru.Remove(entry.Node);
        _map.Remove(key);
        _used -= entry.Data.Length;
        if (_byPath.TryGetValue(key.Path, out var indexes))
        {
            indexes.Remove(key.ChunkIndex);
            if (indexes.Count == 0) _byPath.Remove(key.Path);
        }
    }

    // ------------------------------------------------------------------
    // Value types
    // ------------------------------------------------------------------

    private readonly record struct CacheKey(string Path, int ChunkIndex);

    private sealed class CacheEntry
    {
        public readonly byte[]                     Data;
        public readonly LinkedListNode<CacheKey>   Node;
        public CacheEntry(byte[] data, LinkedListNode<CacheKey> node) { Data = data; Node = node; }
    }
}
