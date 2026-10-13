using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Link.FsDriver;

/// <summary>
/// Simple in-memory LRU read cache. Files are split into fixed-size chunks;
/// each chunk is cached by (realPath, chunkIndex). When total cached bytes
/// exceeds <see cref="MaxBytes"/>, the least-recently-used chunk is evicted.
///
/// This avoids a round-trip to the device for every WinFSP Read IRP once a
/// file has been accessed — sequential streaming and small seeks are served
/// entirely from memory after the first pass.
/// </summary>
public sealed class ReadCache
{
    private readonly long                               _maxBytes;
    private readonly Dictionary<CacheKey, CacheEntry>  _map  = new();
    private readonly LinkedList<CacheKey>               _lru  = new();
    private          long                               _used = 0;
    private readonly object                             _lock = new();

    // Chunk size: 4 MB — high throughput across loopback API and phone TLS link.
    public const int ChunkSize = 4 * 1024 * 1024;

    public ReadCache(long maxBytes) => _maxBytes = maxBytes;

    /// <summary>
    /// Returns bytes for [offset, offset+length) from cache if present, or
    /// fetches via <paramref name="fetch"/> and stores the result.
    /// Prefetches subsequent chunks asynchronously in the background.
    /// </summary>
    public byte[]? Read(string realPath, long offset, int length,
        Func<long, int, byte[]?> fetch)
    {
        // Determine which chunks cover [offset, offset+length)
        long chunkStart = (offset / ChunkSize) * ChunkSize;
        long chunkEnd   = ((offset + length - 1) / ChunkSize + 1) * ChunkSize;

        // Collect all needed chunks, fetching any that are missing
        var assembled = new System.IO.MemoryStream(length);
        for (long cs = chunkStart; cs < chunkEnd; cs += ChunkSize)
        {
            int chunkIdx = (int)(cs / ChunkSize);
            byte[]? data = GetOrFetch(realPath, chunkIdx, cs, fetch);
            if (data == null) return null;

            // Trigger background prefetch of next 3 chunks (pipelined read-ahead)
            for (int ahead = 1; ahead <= 3; ahead++)
            {
                int aheadIdx = chunkIdx + ahead;
                long aheadOff = (long)aheadIdx * ChunkSize;
                lock (_lock)
                {
                    if (_map.ContainsKey(new CacheKey(realPath, aheadIdx))) continue;
                }
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try { GetOrFetch(realPath, aheadIdx, aheadOff, fetch); } catch {}
                });
            }

            // Copy the relevant slice of this chunk into the output
            long sliceOff = Math.Max(offset, cs) - cs;
            long sliceEnd = Math.Min(offset + length, cs + data.Length) - cs;
            if (sliceEnd > sliceOff)
                assembled.Write(data, (int)sliceOff, (int)(sliceEnd - sliceOff));
        }

        return assembled.ToArray();
    }

    /// Invalidate all cached chunks for a path (called after a write, so
    /// subsequent reads reflect the newly written data).
    public void Invalidate(string realPath)
    {
        lock (_lock)
        {
            var keys = new List<CacheKey>();
            foreach (var k in _map.Keys)
                if (k.Path == realPath) keys.Add(k);
            foreach (var k in keys) Remove(k);
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private byte[]? GetOrFetch(string realPath, int chunkIdx, long chunkOffset,
        Func<long, int, byte[]?> fetch)
    {
        var key = new CacheKey(realPath, chunkIdx);
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var entry))
            {
                // LRU touch
                _lru.Remove(entry.Node);
                _lru.AddLast(entry.Node);
                return entry.Data;
            }
        }

        // Fetch outside the lock so we don't block other threads
        byte[]? data = fetch(chunkOffset, ChunkSize);
        if (data == null || data.Length == 0) return data;

        lock (_lock)
        {
            // Another thread may have populated while we fetched — check again
            if (_map.TryGetValue(key, out var existing)) return existing.Data;

            // Evict LRU until we have room
            while (_used + data.Length > _maxBytes && _lru.First != null)
                Remove(_lru.First.Value);

            var node = _lru.AddLast(key);
            _map[key] = new CacheEntry(data, node);
            _used += data.Length;
        }

        return data;
    }

    private void Remove(CacheKey key)
    {
        if (!_map.TryGetValue(key, out var entry)) return;
        _lru.Remove(entry.Node);
        _map.Remove(key);
        _used -= entry.Data.Length;
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
