import React, { useEffect, useState, useRef, useMemo, useCallback, useDeferredValue } from 'react';

const linkApi = (window as any).link;

// Thumbnails travel over the same TLS control socket as every other fs op, so an unthrottled
// folder of photos would put hundreds of concurrent multi-hundred-KB reads ahead of ordinary
// navigation — the directory you just clicked into wouldn't list until the previous folder's
// previews finished. Cap how many are in flight, how much of each file is pulled, and remember
// what's already decoded so scrolling back never refetches.
const THUMB_MAX_BYTES = 256 * 1024;
const THUMB_MAX_CONCURRENT = 4;
const THUMB_CACHE_LIMIT = 400;
// Longest edge of the stored preview. Cells are 130x70 CSS px, so 320 still looks sharp on a
// hi-dpi display while being a rounding error next to the source image.
const THUMB_PX = 320;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|ico)$/i;

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + SIZE_UNITS[i];
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

// Windowing. A phone's camera folder routinely holds thousands of entries, and each row/cell
// carries several inline SVGs and buttons — rendering them all was tens of thousands of DOM
// nodes per directory. Only directories past the threshold pay for windowing, so ordinary
// folders render exactly as they did before. Row geometry is pinned (not measured) and the
// rows below are given a matching explicit height, so the spacer math cannot drift.
const VIRTUALIZE_THRESHOLD = 120;
const LIST_HEADER_H = 38;
const LIST_ROW_H = 41;
const GRID_CELL_H = 145;
const GRID_GAP = 16;
const GRID_PAD = 20;
const GRID_MIN_W = 130;
const OVERSCAN_ROWS = 6;

// Insertion-ordered, so the oldest key is always the first one Map iteration yields.
// Values are object URLs, not data URLs: a base64 data URL of a 256KB read is a ~340KB string
// pinned on the JS heap, and 400 of those is >100MB of string churn for the GC to walk.
const thumbCache = new Map<string, string>();

function evictOldestThumb() {
  const oldest = thumbCache.keys().next().value;
  if (oldest === undefined) return;
  const url = thumbCache.get(oldest);
  thumbCache.delete(oldest);
  // Object URLs keep their blob alive until explicitly revoked — dropping the Map entry alone
  // would leak the backing memory for the lifetime of the window.
  if (url) URL.revokeObjectURL(url);
}

/**
 * Decode the fetched bytes once, redraw them at thumbnail size, and keep only that.
 *
 * The <img> used to be handed the original photo and shrunk with CSS. That means the browser
 * decodes the image at full resolution — a 12MP photo is ~48MB of raw bitmap — and holds it for
 * as long as the element is alive, then resamples it down on paint. A screenful of camera photos
 * was hundreds of megabytes of decoded bitmap and a resample of every one of them per frame,
 * which is what made grid scrolling stutter no matter how little JS ran.
 *
 * Falls back to the undecoded bytes if decoding fails, which is the case for a file whose header
 * says more than the 256KB prefix we fetched actually contains — that still renders partially,
 * exactly as it did before.
 */
async function buildThumbObjectUrl(payload: string | Uint8Array, mime: string): Promise<string> {
  // Desktop hands back raw bytes (no encode/decode round trip); the Capacitor bridge still
  // returns base64, so accept both rather than forcing one build to pay for the other's shape.
  const blob =
    typeof payload === 'string'
      ? await (await fetch(`data:${mime};base64,${payload}`)).blob()
      : new Blob([new Uint8Array(payload)], { type: mime });

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return URL.createObjectURL(blob);

    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return URL.createObjectURL(blob);
    ctx.drawImage(bitmap, 0, 0, w, h);

    const small = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.82)
    );

    // Zero the canvas so its backing store is released now rather than whenever GC gets to it.
    // One of these is created per thumbnail, and they are GPU-backed — leaving hundreds of them
    // waiting to be collected is memory pressure that shows up as scroll stutter.
    canvas.width = 0;
    canvas.height = 0;

    return small ? URL.createObjectURL(small) : URL.createObjectURL(blob);
  } catch {
    return URL.createObjectURL(blob);
  } finally {
    bitmap?.close();
  }
}

/**
 * Admission control for thumbnail fetches: newest-first, and abandoned requests are dropped.
 *
 * This was a plain FIFO queue with no way out of it, which degraded badly the longer the explorer
 * was used. Scrolling through a big folder enqueues a waiter per image, and navigating away does
 * not remove them — so every cell you scrolled past or every folder you left still sat in line
 * ahead of the thumbnails now on screen. After a few minutes of browsing, a freshly opened folder
 * had to wait out a queue of hundreds of dead requests before drawing anything, which reads
 * exactly as "it was fine at first and got slower the more I used it".
 *
 * Two changes fix that. Waiters report whether they are still wanted, so dead ones are discarded
 * instead of being handed a slot; and the queue is LIFO, because the most recently requested
 * thumbnail is the one most likely to be on screen right now.
 */
interface ThumbWaiter {
  settle: (granted: boolean) => void;
  isStale: () => boolean;
}

let thumbActive = 0;
const thumbQueue: ThumbWaiter[] = [];

/** Resolves true if a slot was granted (caller must release it), false if no longer wanted. */
function acquireThumbSlot(isStale: () => boolean): Promise<boolean> {
  if (thumbActive < THUMB_MAX_CONCURRENT) {
    thumbActive++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((settle) => thumbQueue.push({ settle, isStale }));
}

function releaseThumbSlot() {
  while (thumbQueue.length > 0) {
    const next = thumbQueue.pop()!;
    if (next.isStale()) {
      // Settle so the awaiting effect unwinds, but do not spend the slot on it.
      next.settle(false);
      continue;
    }
    // Hand the slot straight over rather than decrementing and re-incrementing.
    next.settle(true);
    return;
  }
  thumbActive--;
}

interface FileExplorerProps {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}

interface FsRoot {
  name: string;
  path: string;
}

interface FsEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedTime?: number;
}

const FileThumbnail: React.FC<{ deviceId: string; item: FsEntry }> = React.memo(({ deviceId, item }) => {
  const isImage = IMAGE_RE.test(item.name);
  const cacheKey = `${deviceId}:${item.path}:${item.size}`;
  // Seed straight from cache so a revisit paints on the first frame with no request at all.
  const [src, setSrc] = useState<string | null>(() => thumbCache.get(cacheKey) || null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isImage || src || !containerRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isImage, src]);

  useEffect(() => {
    if (!visible || !isImage || src || !linkApi) return;

    let active = true;
    let slotHeld = false;
    setLoading(true);

    (async () => {
      try {
        // Reports staleness so that scrolling this cell out of view, or leaving the folder
        // entirely, drops the request from the queue instead of making live cells wait behind it.
        const granted = await acquireThumbSlot(() => !active);
        if (!granted) return; // never held a slot — nothing to release
        slotHeld = true;
        if (!active) return;

        // Another cell may have fetched this same file while we waited for a slot.
        const cached = thumbCache.get(cacheKey);
        if (cached) {
          setSrc(cached);
          return;
        }

        const readSize = Math.min(item.size || THUMB_MAX_BYTES, THUMB_MAX_BYTES);
        const payload = await linkApi.fsRead(deviceId, item.path, 0, readSize);
        if (!active) return;

        const ext = item.name.slice(item.name.lastIndexOf('.') + 1).toLowerCase();
        const objectUrl = await buildThumbObjectUrl(payload, MIME_BY_EXT[ext] || 'image/jpeg');

        // Navigating away mid-decode must not leak the URL we just created.
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        // Another cell may have won the race while we were decoding.
        const raced = thumbCache.get(cacheKey);
        if (raced) {
          URL.revokeObjectURL(objectUrl);
          setSrc(raced);
          return;
        }

        if (thumbCache.size >= THUMB_CACHE_LIMIT) evictOldestThumb();
        thumbCache.set(cacheKey, objectUrl);
        setSrc(objectUrl);
      } catch {
        // A preview that won't load isn't worth surfacing — the generic file icon stands in.
      } finally {
        if (slotHeld) releaseThumbSlot();
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [deviceId, item.path, item.size, item.name, isImage, visible, src, cacheKey]);

  if (!isImage) {
    return (
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
    );
  }

  // One stable observer target across every state — the ref used to hop between three different
  // elements as loading progressed, so the node being observed was not the node still on screen.
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
      {src ? (
        <img src={src} alt={item.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} />
      ) : loading ? (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s infinite linear' }}>
          <line x1="12" y1="2" x2="12" y2="6" />
          <line x1="12" y1="18" x2="12" y2="22" />
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
          <line x1="2" y1="12" x2="6" y2="12" />
          <line x1="18" y1="12" x2="22" y2="12" />
          <line x1="6.34" y1="17.66" x2="8.46" y2="15.54" />
          <line x1="15.54" y1="8.46" x2="17.66" y2="6.34" />
        </svg>
      ) : null}
    </div>
  );
});
FileThumbnail.displayName = 'FileThumbnail';

// Icons as shared constant elements rather than inline JSX. Inline, every one of these was a
// fresh element object per row per render; as constants React reuses the identical object.
const ICON_FOLDER = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);
const ICON_FILE = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>
);
const ICON_FOLDER_LG = (
  <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-color, #3b82f6)' }}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);
const ICON_SPINNER = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s infinite linear' }}>
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);
const ICON_DOWNLOAD = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
const ICON_RENAME = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z"/>
  </svg>
);
const ICON_DELETE = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    <line x1="10" y1="11" x2="10" y2="17"/>
    <line x1="14" y1="11" x2="14" y2="17"/>
  </svg>
);

// Hoisted style objects. Declared inline these were dozens of fresh objects per row on every
// render — and with scrolling driving a re-render each frame, that was the allocation churn the
// GC then had to collect mid-scroll.
const S_ROW: React.CSSProperties = {
  display: 'flex',
  padding: '0 16px',
  height: `${LIST_ROW_H}px`,
  boxSizing: 'border-box',
  flexShrink: 0,
  alignItems: 'center',
  borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
  fontSize: '13.5px',
};
const S_NAME_BASE: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '10px' };
const S_NAME_DIR: React.CSSProperties = { ...S_NAME_BASE, cursor: 'pointer', color: 'var(--accent-color, #3b82f6)', fontWeight: 600 };
const S_NAME_FILE: React.CSSProperties = { ...S_NAME_BASE, cursor: 'default', color: 'inherit', fontWeight: 'normal' };
const S_NAME_TEXT: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const S_ROW_SIZE: React.CSSProperties = { width: '60px', color: 'var(--text-muted)', fontSize: '12.5px', textAlign: 'right', marginRight: '16px', flexShrink: 0 };
const S_ROW_ACTIONS: React.CSSProperties = { width: '80px', flexShrink: 0, display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end' };
const S_SPACER_28: React.CSSProperties = { width: '28px' };

const S_ICON_BTN: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: '28px', height: '28px', padding: 0, borderRadius: '6px', border: 'none', cursor: 'pointer',
};
const S_BTN_DL: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(16, 185, 129, 0.12)', color: 'var(--active-dot, #10b981)' };
const S_BTN_RENAME: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(255, 255, 255, 0.06)', color: 'var(--text-muted)' };
const S_BTN_DELETE: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' };
const S_BTN_DL_G: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(16, 185, 129, 0.2)', color: 'var(--active-dot, #10b981)' };
const S_BTN_RENAME_G: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(255, 255, 255, 0.15)', color: 'var(--text-color)' };
const S_BTN_DELETE_G: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' };

const S_CELL_BASE: React.CSSProperties = {
  position: 'relative', padding: '12px', borderRadius: '10px',
  border: '1px solid var(--border-color)', background: 'var(--input-bg)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
  height: `${GRID_CELL_H}px`, overflow: 'hidden',
};
const S_CELL_DIR: React.CSSProperties = { ...S_CELL_BASE, cursor: 'pointer' };
const S_CELL_FILE: React.CSSProperties = { ...S_CELL_BASE, cursor: 'default' };
const S_CELL_THUMB: React.CSSProperties = {
  width: '100%', height: '70px', display: 'flex', alignItems: 'center', justifyContent: 'center',
  overflow: 'hidden', background: 'rgba(0,0,0,0.1)', borderRadius: '6px',
};
const S_CELL_NAME_BASE: React.CSSProperties = {
  fontSize: '12.5px', textAlign: 'center', width: '100%',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 4px',
};
const S_CELL_NAME_DIR: React.CSSProperties = { ...S_CELL_NAME_BASE, fontWeight: 600, color: 'var(--accent-color, #3b82f6)' };
const S_CELL_NAME_FILE: React.CSSProperties = { ...S_CELL_NAME_BASE, fontWeight: 'normal', color: 'inherit' };
const S_CELL_SIZE: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)', marginTop: '-4px' };
const S_CELL_ACTIONS: React.CSSProperties = {
  position: 'absolute', bottom: 0, left: 0, right: 0,
  background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center',
  justifyContent: 'center', gap: '12px', padding: '8px 0', zIndex: 2,
};

interface ItemProps {
  item: FsEntry;
  downloading: boolean;
  onOpen: (item: FsEntry) => void;
  onDownload: (item: FsEntry) => void;
  onRename: (item: FsEntry) => void;
  onDelete: (item: FsEntry) => void;
}

// Memoized so a scroll frame — which re-renders the parent to move the window — reconciles only
// the rows that actually entered or left it, instead of every visible row.
const FileRow = React.memo<ItemProps>(({ item, downloading, onOpen, onDownload, onRename, onDelete }) => (
  <div className="fx-row" style={S_ROW}>
    <div
      style={item.isDirectory ? S_NAME_DIR : S_NAME_FILE}
      onClick={item.isDirectory ? () => onOpen(item) : undefined}
    >
      {item.isDirectory ? ICON_FOLDER : ICON_FILE}
      <span style={S_NAME_TEXT}>{item.name}</span>
    </div>

    <div style={S_ROW_SIZE}>{item.isDirectory ? '--' : formatSize(item.size)}</div>

    <div style={S_ROW_ACTIONS}>
      {item.isDirectory ? (
        <div style={S_SPACER_28} />
      ) : (
        <button onClick={() => onDownload(item)} disabled={downloading} title="Download File" style={S_BTN_DL}>
          {downloading ? ICON_SPINNER : ICON_DOWNLOAD}
        </button>
      )}
      <button onClick={() => onRename(item)} title="Rename" style={S_BTN_RENAME}>{ICON_RENAME}</button>
      <button onClick={() => onDelete(item)} title="Delete" style={S_BTN_DELETE}>{ICON_DELETE}</button>
    </div>
  </div>
));
FileRow.displayName = 'FileRow';

const FileCell = React.memo<ItemProps & { deviceId: string }>(
  ({ deviceId, item, downloading, onOpen, onDownload, onRename, onDelete }) => (
    <div
      className="fx-cell"
      style={item.isDirectory ? S_CELL_DIR : S_CELL_FILE}
      onClick={item.isDirectory ? (e) => {
        if ((e.target as HTMLElement).closest('.fx-cell-actions')) return;
        onOpen(item);
      } : undefined}
    >
      <div style={S_CELL_THUMB}>
        {item.isDirectory ? ICON_FOLDER_LG : <FileThumbnail deviceId={deviceId} item={item} />}
      </div>

      <div style={item.isDirectory ? S_CELL_NAME_DIR : S_CELL_NAME_FILE}>{item.name}</div>
      <div style={S_CELL_SIZE}>{item.isDirectory ? 'Folder' : formatSize(item.size)}</div>

      <div className="fx-cell-actions" style={S_CELL_ACTIONS}>
        {!item.isDirectory && (
          <button
            onClick={(e) => { e.stopPropagation(); onDownload(item); }}
            disabled={downloading}
            title="Download File"
            style={S_BTN_DL_G}
          >
            {downloading ? ICON_SPINNER : ICON_DOWNLOAD}
          </button>
        )}
        <button onClick={(e) => { e.stopPropagation(); onRename(item); }} title="Rename" style={S_BTN_RENAME_G}>{ICON_RENAME}</button>
        <button onClick={(e) => { e.stopPropagation(); onDelete(item); }} title="Delete" style={S_BTN_DELETE_G}>{ICON_DELETE}</button>
      </div>
    </div>
  )
);
FileCell.displayName = 'FileCell';

interface DirectoryViewProps {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  viewMode: 'list' | 'grid';
  items: FsEntry[];
  deviceId: string;
  downloadingPath: string | null;
  sortBy: 'name' | 'size' | 'date';
  sortOrder: 'asc' | 'desc';
  onToggleSort: (type: 'name' | 'size' | 'date') => void;
  onOpen: (item: FsEntry) => void;
  onDownload: (item: FsEntry) => void;
  onRename: (item: FsEntry) => void;
  onDelete: (item: FsEntry) => void;
}

/**
 * Owns the scroll-derived window, and nothing else does.
 *
 * The scroll listener used to live in FileExplorerTab, so `setScrollTop` on every animation frame
 * re-rendered that entire component — toolbar, search box, breadcrumbs, dialogs and all — for the
 * whole duration of a scroll. Worse, it ran unconditionally: below VIRTUALIZE_THRESHOLD nothing is
 * windowed, so every one of those frames recomputed a window that was never used. That is why
 * scrolling was heavy in both views and regardless of how many files the folder held.
 *
 * Keeping the state here means a scroll frame re-renders only the rows, and the listener is not
 * attached at all unless windowing is actually in effect — small folders scroll natively with no
 * JavaScript on the path whatsoever.
 */
const DirectoryView: React.FC<DirectoryViewProps> = React.memo(({
  scrollRef,
  viewMode,
  items,
  deviceId,
  downloadingPath,
  sortBy,
  sortOrder,
  onToggleSort,
  onOpen,
  onDownload,
  onRename,
  onDelete,
}) => {
  const virtualize = items.length > VIRTUALIZE_THRESHOLD;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });

  useEffect(() => {
    if (!virtualize) return;
    const el = scrollRef.current;
    if (!el) return;

    let frame = 0;
    const onScroll = () => {
      // Coalesce to one state write per painted frame; scroll events fire far more often.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(el.scrollTop);
      });
    };

    const measure = () => setViewport({ height: el.clientHeight, width: el.clientWidth });
    measure();

    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtualize, scrollRef]);

  // Re-sync from the element whenever the listing changes. A new directory resets the container
  // to the top, but sorting or filtering leaves it where it was, so the offset has to be read
  // back rather than assumed.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, [items, scrollRef]);

  const listWindow = useMemo(() => {
    const total = items.length;
    if (!virtualize || viewport.height === 0) return { items, padTop: 0, padBottom: 0 };

    // The table header scrolls with the body inside the same container, so it comes off the
    // offset before a row index is derived from it.
    const offset = Math.max(0, scrollTop - LIST_HEADER_H);
    const first = Math.max(0, Math.floor(offset / LIST_ROW_H) - OVERSCAN_ROWS);
    const last = Math.min(total, first + Math.ceil(viewport.height / LIST_ROW_H) + OVERSCAN_ROWS * 2);

    return {
      items: items.slice(first, last),
      padTop: first * LIST_ROW_H,
      padBottom: (total - last) * LIST_ROW_H,
    };
  }, [items, virtualize, scrollTop, viewport.height]);

  const gridWindow = useMemo(() => {
    const total = items.length;
    const cols = Math.max(
      1,
      Math.floor((viewport.width - GRID_PAD * 2 + GRID_GAP) / (GRID_MIN_W + GRID_GAP))
    );
    if (!virtualize || viewport.width === 0 || viewport.height === 0) {
      return { items, padTop: 0, padBottom: 0, cols };
    }

    const rowH = GRID_CELL_H + GRID_GAP;
    const totalRows = Math.ceil(total / cols);
    const firstRow = Math.max(0, Math.floor((scrollTop - GRID_PAD) / rowH) - 2);
    const lastRow = Math.min(totalRows, firstRow + Math.ceil(viewport.height / rowH) + 4);

    return {
      items: items.slice(firstRow * cols, lastRow * cols),
      padTop: firstRow * rowH,
      padBottom: Math.max(0, (totalRows - lastRow) * rowH),
      cols,
    };
  }, [items, virtualize, scrollTop, viewport.height, viewport.width]);

  const emptyNotice = items.length === 0;

  if (viewMode === 'list') {
    return (
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          // Pinned so the windowing offset above can subtract an exact header height.
          height: `${LIST_HEADER_H}px`,
          boxSizing: 'border-box',
          borderBottom: '1px solid var(--border-color)',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--text-muted)',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer', display: 'flex', alignItems: 'center' }} onClick={() => onToggleSort('name')}>
            Name {sortBy === 'name' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
          </div>
          <div style={{ width: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginRight: '16px', flexShrink: 0 }} onClick={() => onToggleSort('size')}>
            Size {sortBy === 'size' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
          </div>
          <div style={{ width: '80px', flexShrink: 0, textAlign: 'right' }}>Actions</div>
        </div>

        {emptyNotice && (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            Empty directory or no search matches.
          </div>
        )}

        {listWindow.padTop > 0 && <div style={{ height: `${listWindow.padTop}px`, flexShrink: 0 }} />}
        {listWindow.items.map((item) => (
          <FileRow
            key={item.path}
            item={item}
            downloading={downloadingPath === item.path}
            onOpen={onOpen}
            onDownload={onDownload}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
        {listWindow.padBottom > 0 && <div style={{ height: `${listWindow.padBottom}px`, flexShrink: 0 }} />}
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid',
      // Pinned to the measured column count while windowing, so the row math matches what is
      // actually laid out; auto-fill is free to decide otherwise for short listings.
      gridTemplateColumns: virtualize
        ? `repeat(${gridWindow.cols}, minmax(0, 1fr))`
        : 'repeat(auto-fill, minmax(130px, 1fr))',
      gap: `${GRID_GAP}px`,
      padding: `${GRID_PAD}px`,
      alignContent: 'start',
    }}>
      {emptyNotice && (
        <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          Empty directory or no search matches.
        </div>
      )}
      {gridWindow.padTop > 0 && <div style={{ gridColumn: '1 / -1', height: `${gridWindow.padTop}px` }} />}
      {gridWindow.items.map((item) => (
        <FileCell
          key={item.path}
          deviceId={deviceId}
          item={item}
          downloading={downloadingPath === item.path}
          onOpen={onOpen}
          onDownload={onDownload}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
      {gridWindow.padBottom > 0 && <div style={{ gridColumn: '1 / -1', height: `${gridWindow.padBottom}px` }} />}
    </div>
  );
});
DirectoryView.displayName = 'DirectoryView';

const FileExplorerTab: React.FC<FileExplorerProps> = ({ deviceId, deviceName, onClose }) => {
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [items, setItems] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Typing stays at full framerate; the expensive re-filter trails the keystroke instead of
  // blocking it (React 18 concurrent — no manual debounce timer to tune or leak).
  const deferredQuery = useDeferredValue(searchQuery);
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'date'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);

  // Custom App-style dialog state
  const [activeDialog, setActiveDialog] = useState<'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogItem, setDialogItem] = useState<FsEntry | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [showUploadDropdown, setShowUploadDropdown] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // The scroll listener and the window it derives live in DirectoryView, so a scroll frame
  // re-renders only the rows rather than this whole component.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Load roots initially
  useEffect(() => {
    loadRoots();
  }, [deviceId]);

  const loadRoots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await linkApi.fsListRoots(deviceId);
      setRoots(res || []);
      setCurrentPath(null);
      setItems([]);
    } catch (err: any) {
      setError(err.message || 'Failed to load device storage roots');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await linkApi.fsReaddir(deviceId, path);
      const sep = path.endsWith('/') || path.endsWith('\\') ? '' : '/';
      const mapped = (res || []).map((item: any) => ({
        ...item,
        path: `${path}${sep}${item.name}`,
      }));
      setItems(mapped);
      setCurrentPath(path);
      // A new directory starts at the top; without this the previous folder's scroll offset
      // carries over and the window shows rows from the middle of the new listing.
      // DirectoryView re-reads the offset off the element when `items` changes.
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    } catch (err: any) {
      setError(err.message || `Failed to read folder: ${path}`);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  const handleBack = () => {
    if (!currentPath) return;

    // If current path is one of the storage roots, go back to roots view directly
    const isRoot = roots.some(r => r.path === currentPath);
    if (isRoot) {
      loadRoots();
      return;
    }
    
    // Find parent path
    const parts = currentPath.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) {
      // Go back to roots
      loadRoots();
    } else {
      // Reconstruct parent
      // If it starts with / (unix-like), preserve leading slash
      const isAbsoluteUnix = currentPath.startsWith('/');
      parts.pop();
      const parent = (isAbsoluteUnix ? '/' : '') + parts.join('/');
      loadDirectory(parent);
    }
  };

  const handleCreateDirectory = () => {
    setInputValue('');
    setActiveDialog('createFolder');
  };

  const handleCreateDirectorySubmit = async () => {
    if (!currentPath || !inputValue.trim()) {
      setActiveDialog(null);
      return;
    }
    const folderName = inputValue.trim();
    setActiveDialog(null);
    try {
      const newPath = currentPath.endsWith('/') || currentPath.endsWith('\\')
        ? `${currentPath}${folderName}`
        : `${currentPath}/${folderName}`;
      await linkApi.fsCreateDirectory(deviceId, newPath);
      loadDirectory(currentPath);
    } catch (err: any) {
      alert(`Failed to create directory: ${err.message}`);
    }
  };

  // Stable identities: FileRow/FileCell are memoized, and a handler recreated each render would
  // change their props every frame and defeat the memo entirely.
  const handleOpen = useCallback((item: FsEntry) => loadDirectory(item.path), [loadDirectory]);

  const handleDelete = useCallback((item: FsEntry) => {
    setDialogItem(item);
    setActiveDialog('delete');
  }, []);

  const handleDeleteSubmit = async () => {
    if (!dialogItem) {
      setActiveDialog(null);
      return;
    }
    const item = dialogItem;
    setActiveDialog(null);
    try {
      await linkApi.fsDelete(deviceId, item.path);
      if (currentPath) loadDirectory(currentPath);
      else loadRoots();
    } catch (err: any) {
      alert(`Failed to delete item: ${err.message}`);
    }
  };

  const handleRename = useCallback((item: FsEntry) => {
    setDialogItem(item);
    setInputValue(item.name);
    setActiveDialog('rename');
  }, []);

  const handleRenameSubmit = async () => {
    if (!dialogItem || !inputValue.trim() || inputValue.trim() === dialogItem.name) {
      setActiveDialog(null);
      return;
    }
    const item = dialogItem;
    const newName = inputValue.trim();
    setActiveDialog(null);
    try {
      const parentPath = item.path.substring(0, item.path.length - item.name.length);
      const newPath = `${parentPath}${newName}`;
      await linkApi.fsRename(deviceId, item.path, newPath);
      if (currentPath) loadDirectory(currentPath);
      else loadRoots();
    } catch (err: any) {
      alert(`Failed to rename: ${err.message}`);
    }
  };

  const handleDownload = useCallback(async (item: FsEntry) => {
    try {
      const localPath = await linkApi.fsPickSavePath(item.name);
      if (!localPath) return; // User cancelled

      setDownloadingFile(item.path);
      await linkApi.fsDownloadFile(deviceId, item.path, localPath);
      alert(`Successfully downloaded: ${item.name}`);
    } catch (err: any) {
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloadingFile(null);
    }
  }, [deviceId]);

  const handleUpload = async (mode: 'file' | 'directory') => {
    if (!currentPath || !linkApi) return;
    try {
      const paths = await linkApi.fsPickUploadItems(mode);
      if (!paths || paths.length === 0) return;
      
      setLoading(true);
      for (const localPath of paths) {
        await linkApi.fsUploadItem(deviceId, localPath, currentPath);
      }
      loadDirectory(currentPath);
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDropUpload = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!currentPath || !linkApi) return;
    const paths = Array.from(e.dataTransfer.files).map((f: any) => linkApi.getPathForFile(f)).filter(Boolean);
    if (paths.length === 0) return;
    
    setLoading(true);
    try {
      for (const localPath of paths) {
        await linkApi.fsUploadItem(deviceId, localPath, currentPath);
      }
      loadDirectory(currentPath);
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Filter and sort items. Memoized because this ran on every render — including each keystroke
  // and every unrelated state change — re-sorting the whole directory each time. The deferred
  // query lets React keep the input painting at full speed while a large list catches up.
  const filteredItems = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const base = needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items.slice();

    // localeCompare is markedly slower than a plain collator over thousands of names.
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    return base.sort((a, b) => {
      // Directories always come first
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      let comparison = 0;
      if (sortBy === 'name') {
        comparison = collator.compare(a.name, b.name);
      } else if (sortBy === 'size') {
        comparison = a.size - b.size;
      } else if (sortBy === 'date') {
        comparison = (a.modifiedTime || 0) - (b.modifiedTime || 0);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }, [items, deferredQuery, sortBy, sortOrder]);

  const toggleSort = useCallback((type: 'name' | 'size' | 'date') => {
    if (sortBy === type) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(type);
      setSortOrder('asc');
    }
  }, [sortBy, sortOrder]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      width: '100%',
      color: 'var(--text-color)',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* Header with Title and Close Button */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '16px',
      }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--text-color)' }}>
          File Explorer — {deviceName}
        </h3>
        <button
          onClick={onClose}
          title="Close File Explorer"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            padding: 0,
            borderRadius: '6px',
            border: 'none',
            background: 'rgba(255, 255, 255, 0.05)',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)')}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Top action bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: '16px',
        borderBottom: '1px solid var(--border-color)',
        marginBottom: '16px',
        gap: '12px',
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={handleBack}
            disabled={!currentPath || loading}
            onMouseEnter={(e) => {
              if (currentPath && !loading) e.currentTarget.style.background = 'var(--input-focus-bg)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--input-bg)';
            }}
            style={{
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'var(--input-bg)',
              color: currentPath ? 'var(--text-color)' : 'var(--text-muted)',
              cursor: currentPath ? 'pointer' : 'not-allowed',
              transition: 'background 0.15s ease',
            }}
          >
            &larr; Back
          </button>
          <button
            onClick={loadRoots}
            disabled={loading}
            onMouseEnter={(e) => {
              if (!loading) e.currentTarget.style.background = 'var(--input-focus-bg)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--input-bg)';
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'var(--input-bg)',
              color: 'var(--text-color)',
              cursor: 'pointer',
              transition: 'background 0.15s ease',
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
            Roots
          </button>
          {currentPath && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                onClick={handleCreateDirectory}
                disabled={loading}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'var(--accent-gradient, #3b82f6)',
                  color: 'var(--btn-primary-text)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                + New Folder
              </button>

              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowUploadDropdown(!showUploadDropdown)}
                  disabled={loading}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'var(--accent-gradient, #3b82f6)',
                    color: 'var(--btn-primary-text)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  &uarr; Upload
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>

                {showUploadDropdown && (
                  <>
                    <div
                      onClick={() => setShowUploadDropdown(false)}
                      style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 999,
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        background: 'var(--modal-bg)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
                        padding: '4px 0',
                        display: 'flex',
                        flexDirection: 'column',
                        minWidth: '130px',
                        zIndex: 1000,
                      }}
                    >
                      <button
                        onClick={() => {
                          setShowUploadDropdown(false);
                          handleUpload('file');
                        }}
                        style={{
                          padding: '8px 12px',
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--text-color)',
                          fontSize: '12.5px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          width: '100%',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        Files
                      </button>
                      <button
                        onClick={() => {
                          setShowUploadDropdown(false);
                          handleUpload('directory');
                        }}
                        style={{
                          padding: '8px 12px',
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--text-color)',
                          fontSize: '12.5px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          width: '100%',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        Folders
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <input
          type="text"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
            background: 'var(--input-bg)',
            color: 'var(--text-color)',
            // See the note in CommandsTab: a hard min-width beats max-width and would overflow a
            // narrow toolbar, so the preferred size goes on flex-basis instead.
            flexBasis: '200px',
            minWidth: 0,
            flexGrow: 1,
            maxWidth: '300px',
          }}
        />

        {currentPath !== null && (
          <div style={{ display: 'flex', gap: '4px', background: 'var(--input-bg)', padding: '2px', borderRadius: '8px', border: '1px solid var(--border-color)', height: '36px', boxSizing: 'border-box', alignItems: 'center' }}>
            <button
              onClick={() => setViewMode('list')}
              title="List View"
              style={{
                padding: '6px 10px',
                border: 'none',
                background: viewMode === 'list' ? 'rgba(255,255,255,0.08)' : 'transparent',
                color: viewMode === 'list' ? 'var(--accent-color, #3b82f6)' : 'var(--text-muted)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode('grid')}
              title="Icon View"
              style={{
                padding: '6px 10px',
                border: 'none',
                background: viewMode === 'grid' ? 'rgba(255,255,255,0.08)' : 'transparent',
                color: viewMode === 'grid' ? 'var(--accent-color, #3b82f6)' : 'var(--text-muted)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Path Breadcrumbs */}
      <div style={{
        padding: '8px 12px',
        background: 'var(--sidebar-bg)',
        border: '1px solid var(--border-color)',
        borderRadius: '6px',
        fontSize: '13px',
        color: 'var(--text-muted)',
        marginBottom: '16px',
        wordBreak: 'break-all',
      }}>
        <strong>Location:</strong> {currentPath || 'Storage Roots'}
      </div>

      {/* Main List Container */}
      <div
        ref={scrollRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDropUpload}
        style={{
          flex: 1,
          overflowY: 'auto',
          background: 'var(--sidebar-bg)',
          border: '1px solid var(--border-color)',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s infinite linear', marginRight: '8px' }}>
              <polyline points="23 4 23 10 17 10"/>
              <polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Loading files...
          </div>
        )}

        {error && (
          <div style={{ color: '#ef4444', padding: '24px', textAlign: 'center', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && currentPath === null && roots.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
            No storage roots found on device.
          </div>
        )}

        {/* Roots View */}
        {!loading && !error && currentPath === null && roots.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px', padding: '20px' }}>
            {roots.map((root) => (
              <div
                key={root.path}
                className="fx-root"
                onClick={() => loadDirectory(root.path)}
                style={{
                  padding: '16px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-color)',
                  background: 'var(--input-bg)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                  <line x1="6" y1="2" x2="6" y2="10"/>
                  <line x1="14" y1="2" x2="14" y2="10"/>
                  <path d="M8 22V14h8v8"/>
                </svg>
                <div style={{ fontWeight: 600, fontSize: '13px', textAlign: 'center', wordBreak: 'break-all' }}>
                  {root.name}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && currentPath !== null && (
          <DirectoryView
            scrollRef={scrollRef}
            viewMode={viewMode}
            items={filteredItems}
            deviceId={deviceId}
            downloadingPath={downloadingFile}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onToggleSort={toggleSort}
            onOpen={handleOpen}
            onDownload={handleDownload}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* App-style Dialog overlays */}
      {activeDialog && (
        <div
          className="popup-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            // Full-viewport overlay: a blur here forces a whole-window re-blur on every repaint
            // beneath it. See the matching note on the explorer's own overlay in App.tsx.
            background: 'rgba(0,0,0,0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 25000,
          }}
          onClick={() => setActiveDialog(null)}
        >
          <div
            className="card"
            style={{
              width: '90%',
              maxWidth: '380px',
              background: 'var(--modal-bg)',
              border: '1px solid var(--border-color)',
              boxShadow: '0 25px 60px var(--modal-shadow)',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {activeDialog === 'createFolder' && (
              <>
                <div style={{ fontSize: '16px', fontWeight: 700 }}>New Folder</div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Enter folder name:</div>
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateDirectorySubmit()}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--input-bg)',
                    color: 'var(--text-color)',
                    fontSize: '13px',
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                  <button
                    onClick={() => setActiveDialog(null)}
                    style={{
                      padding: '7px 16px',
                      fontSize: '12.5px',
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: 'var(--text-color)',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateDirectorySubmit}
                    style={{
                      padding: '7px 16px',
                      fontSize: '12.5px',
                      background: 'var(--accent-gradient, #3b82f6)',
                      border: 'none',
                      color: 'var(--btn-primary-text)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    Create
                  </button>
                </div>
              </>
            )}

            {activeDialog === 'rename' && dialogItem && (
              <>
                <div style={{ fontSize: '16px', fontWeight: 700 }}>Rename Item</div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  Rename &ldquo;{dialogItem.name}&rdquo; to:
                </div>
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--input-bg)',
                    color: 'var(--text-color)',
                    fontSize: '13px',
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                  <button
                    onClick={() => setActiveDialog(null)}
                    style={{
                      padding: '7px 16px',
                      fontSize: '12.5px',
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: 'var(--text-color)',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRenameSubmit}
                    style={{
                      padding: '7px 16px',
                      fontSize: '12.5px',
                      background: 'var(--accent-gradient, #3b82f6)',
                      border: 'none',
                      color: 'var(--btn-primary-text)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    Rename
                  </button>
                </div>
              </>
            )}

            {activeDialog === 'delete' && dialogItem && (
              <>
                <div style={{ fontSize: '16px', fontWeight: 700 }}>Delete Item</div>
                <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Are you sure you want to delete &ldquo;{dialogItem.name}&rdquo;?
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                  <button
                    onClick={() => setActiveDialog(null)}
                    style={{
                      padding: '7px 16px',
                      fontSize: '12.5px',
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      color: 'var(--text-color)',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteSubmit}
                    style={{
                      padding: '7px 16px',
                      fontSize: '12.5px',
                      background: '#ef4444',
                      border: '1px solid #ef4444',
                      color: '#fff',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default FileExplorerTab;
