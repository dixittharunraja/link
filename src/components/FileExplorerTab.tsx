import React, { useEffect, useState, useRef, useMemo, useCallback, useDeferredValue } from 'react';
import { LinkApi } from '../vite-env';
import { InputDialog, ConfirmDialog } from './DialogCard';
import { PeerDevice } from '../types/peer';

const linkApi = (window as any).link as LinkApi;

// Thumbnails are fetched over the dedicated streaming HTTP server (see fs-get-stream-url / the
// android LinkFsStreamServer — the same one Play uses), NOT the shared TLS control socket every
// other fs op (readdir, stat, rename...) goes through. That separation is what lets a folder full
// of photos generate previews without ever delaying the directory listing itself.
// History: this used to pull only the first 256KB of each file over the control socket, which was
// nowhere near enough for a typical multi-megabyte camera photo — the decoder had only a partial
// top slice of scanlines to work with, so most thumbnails rendered as mostly-black fragments
// instead of failing cleanly or loading fully. Fetching the whole file over the separate stream
// server fixes that outright, at the cost of a full download per uncached thumbnail — acceptable
// since it's capped by THUMB_MAX_CONCURRENT below and cached afterward, and it was already the
// exact tradeoff Play makes for files far larger than any photo.
const THUMB_MAX_CONCURRENT = 4;
const THUMB_CACHE_LIMIT = 400;
// Longest edge of the stored preview. Cells are 130x70 CSS px, so 320 still looks sharp on a
// hi-dpi display while being a rounding error next to the source image.
const THUMB_PX = 320;
// Raster formats a THUMBNAIL can be built from. Narrower than the set of images we can OPEN
// (below) on purpose — SVG needs a real vector renderer, not this decode-then-downscale path.
// AVIF is here because Chromium decodes it; HEIC/TIFF/RAW are deliberately not, since Chromium
// has no decoder for them at all and they'd just fail silently on every cell.
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|ico|avif)$/i;
// Formats a plain <img> tag can render directly — IMAGE_RE plus SVG, which is fine here even
// though it's excluded from IMAGE_RE above: that exclusion is about the canvas/createImageBitmap
// path thumbnails use, not about whether an <img src> can show it (it can). On desktop this set
// is shown in-app (see the image viewer below) instead of being handed to openExternal, which
// used to route every image through shell.openExternal — Electron already contains a full
// Chromium that can decode all of these itself, so there was never a reason to bounce out to the
// OS's separately-configured default browser just to display a picture.
const INLINE_IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|ico|avif|svg)$/i;
// Streamable media — opened in the OS's own player/viewer rather than downloaded first. Kept
// deliberately broad (mkv/avi/mov are here even though a browser can't play them) because the
// handoff target is the system player, not a <video> tag: VLC/MPV/Films & TV handle far more
// containers and codecs than Chromium does. Nothing is transcoded, so what actually plays is
// whatever the user's own player supports.
const VIDEO_RE = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpe?g|3gp|ts|m2ts|mts|ogv|vob|asf|f4v|divx)$/i;
// Documents take a completely different route from media — fetched to a temp copy and opened
// from disk, never streamed (see the fs-open-document handler for why).
const DOCUMENT_RE = /\.(pdf|epub|rtf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|csv)$/i;
// The subset a browser can actually decode. Only used to decide whether falling back to the
// browser is a fine outcome or one worth warning about — everything else downloads there instead
// of playing, which reads as a broken feature unless it's explained.
const BROWSER_VIDEO_RE = /\.(mp4|m4v|webm)$/i;

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + SIZE_UNITS[i];
}

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
 * Decode the fetched image once, redraw it at thumbnail size, and keep only that.
 *
 * The <img> used to be handed the original photo and shrunk with CSS. That means the browser
 * decodes the image at full resolution — a 12MP photo is ~48MB of raw bitmap — and holds it for
 * as long as the element is alive, then resamples it down on paint. A screenful of camera photos
 * was hundreds of megabytes of decoded bitmap and a resample of every one of them per frame,
 * which is what made grid scrolling stutter no matter how little JS ran.
 *
 * Falls back to the full-size blob if decoding fails for some other reason (an unsupported
 * variant of an otherwise-supported format) — still shows the real image, just undownscaled.
 */
async function buildThumbObjectUrl(blob: Blob): Promise<string> {
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

        const streamUrl = await linkApi.fsGetStreamUrl(deviceId, item.path);
        if (!active) return;
        if (!streamUrl) throw new Error('Streaming is not available for this device');

        const resp = await fetch(streamUrl);
        if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
        const blob = await resp.blob();
        if (!active) return;

        const objectUrl = await buildThumbObjectUrl(blob);

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
const ICON_OPEN = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
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
const S_NAME_FILE: React.CSSProperties = { ...S_NAME_BASE, cursor: 'pointer', color: 'inherit', fontWeight: 'normal' };
const S_NAME_TEXT: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const S_ROW_SIZE: React.CSSProperties = { width: '60px', color: 'var(--text-muted)', fontSize: '12.5px', textAlign: 'right', marginRight: '16px', flexShrink: 0 };
const S_ROW_ACTIONS: React.CSSProperties = { width: '80px', flexShrink: 0, display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end' };

const S_ICON_BTN: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: '28px', height: '28px', padding: 0, borderRadius: '6px', border: 'none', cursor: 'pointer',
};
const S_BTN_DL: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(16, 185, 129, 0.12)', color: 'var(--active-dot, #10b981)' };
const S_BTN_RENAME: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(255, 255, 255, 0.06)', color: 'var(--text-muted)' };
const S_BTN_DELETE: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' };
const S_BTN_OPEN: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(168, 85, 247, 0.12)', color: '#a855f7' };
const S_BTN_OPEN_G: React.CSSProperties = { ...S_ICON_BTN, background: 'rgba(168, 85, 247, 0.2)', color: '#a855f7' };
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
const S_CELL_FILE: React.CSSProperties = { ...S_CELL_BASE, cursor: 'pointer' };
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
      onClick={() => onOpen(item)}
    >
      {item.isDirectory ? ICON_FOLDER : ICON_FILE}
      <span style={S_NAME_TEXT}>{item.name}</span>
    </div>

    <div style={S_ROW_SIZE}>{item.isDirectory ? '--' : formatSize(item.size)}</div>

    <div style={S_ROW_ACTIONS}>
      {!item.isDirectory && DOCUMENT_RE.test(item.name) && (
        <button onClick={() => onOpen(item)} title="Open (read-only copy)" style={S_BTN_OPEN}>{ICON_OPEN}</button>
      )}
      <button
        onClick={() => onDownload(item)}
        disabled={downloading}
        title={item.isDirectory ? 'Download Folder' : 'Download File'}
        style={S_BTN_DL}
      >
        {downloading ? ICON_SPINNER : ICON_DOWNLOAD}
      </button>
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
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.fx-cell-actions')) return;
        onOpen(item);
      }}
    >
      <div style={S_CELL_THUMB}>
        {item.isDirectory ? ICON_FOLDER_LG : <FileThumbnail deviceId={deviceId} item={item} />}
      </div>

      <div style={item.isDirectory ? S_CELL_NAME_DIR : S_CELL_NAME_FILE}>{item.name}</div>
      <div style={S_CELL_SIZE}>{item.isDirectory ? 'Folder' : formatSize(item.size)}</div>

      <div className="fx-cell-actions" style={S_CELL_ACTIONS}>
        {!item.isDirectory && DOCUMENT_RE.test(item.name) && (
          <button onClick={(e) => { e.stopPropagation(); onOpen(item); }} title="Open (read-only copy)" style={S_BTN_OPEN_G}>
            {ICON_OPEN}
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDownload(item); }}
          disabled={downloading}
          title={item.isDirectory ? 'Download Folder' : 'Download File'}
          style={S_BTN_DL_G}
        >
          {downloading ? ICON_SPINNER : ICON_DOWNLOAD}
        </button>
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

/** Full-screen in-app preview for a format Chromium can render directly (see INLINE_IMAGE_RE) —
 *  a plain <img> against the stream URL, no external handoff. Unlike thumbnails this never
 *  creates an object URL of its own (nothing to revoke on close): the src is the stream server's
 *  http://127.0.0.1 URL itself, and the browser streams/decodes it exactly like any other image. */
const NavButton: React.FC<{ side: 'left' | 'right'; onClick: () => void }> = ({ side, onClick }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    title={side === 'left' ? 'Previous' : 'Next'}
    style={{
      position: 'absolute', top: '50%', [side]: '20px', transform: 'translateY(-50%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: '40px', height: '40px', padding: 0, borderRadius: '50%',
      border: 'none', background: 'rgba(255, 255, 255, 0.1)', color: '#fff', cursor: 'pointer',
    }}
  >
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {side === 'left' ? <polyline points="15 18 9 12 15 6"/> : <polyline points="9 18 15 12 9 6"/>}
    </svg>
  </button>
);

const ImageViewer: React.FC<{
  url: string | null;
  name: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasMultiple: boolean;
}> = ({ url, name, onClose, onPrev, onNext, hasMultiple }) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (hasMultiple && e.key === 'ArrowLeft') onPrev();
      else if (hasMultiple && e.key === 'ArrowRight') onNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onPrev, onNext, hasMultiple]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.92)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20000,
      }}
    >
      <div style={{ position: 'absolute', top: '16px', left: '20px', right: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'rgba(255,255,255,0.85)', fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' }}>{name}</span>
        <button
          onClick={onClose}
          title="Close"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '32px', height: '32px', padding: 0, borderRadius: '6px',
            border: 'none', background: 'rgba(255, 255, 255, 0.1)', color: '#fff', cursor: 'pointer',
          }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      {hasMultiple && <NavButton side="left" onClick={onPrev} />}
      {hasMultiple && <NavButton side="right" onClick={onNext} />}
      {url && (
        <img
          src={url}
          alt={name}
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: '4px', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
        />
      )}
    </div>
  );
};

const FileExplorerTab: React.FC<FileExplorerProps> = ({ deviceId }) => {
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
  // Live byte-progress for whichever single transfer (download or upload) is currently active in
  // this modal — see handleDownload/handleUpload/handleDropUpload, which only ever run one at a
  // time, so a single slot (not a map keyed by path) is enough.
  const [transferProgress, setTransferProgress] = useState<{ transferId: string; direction: 'download' | 'upload'; name: string; transferred: number; total: number } | null>(null);
  const transferStartRef = useRef<{ time: number; bytes: number } | null>(null);
  // Mirrors filteredItems (declared further down) so handleOpen — declared above it, textually,
  // to stay next to the other row-action callbacks — can look up the clicked file's position
  // among the currently-viewable images without depending on a value that doesn't exist yet at
  // its own declaration site. Kept in sync by an effect right next to filteredItems itself.
  const filteredItemsRef = useRef<FsEntry[]>([]);
  // Index into viewableImages (below) of the file currently shown in the in-app image viewer —
  // an index rather than the item itself so Previous/Next just moves it, with the actual URL
  // re-resolved by the effect near viewableImages whenever it changes.
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  const [viewingUrl, setViewingUrl] = useState<string | null>(null);

  // Custom App-style dialog state
  const [activeDialog, setActiveDialog] = useState<'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogItem, setDialogItem] = useState<FsEntry | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [showUploadDropdown, setShowUploadDropdown] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try { return localStorage.getItem('link-fs-show-hidden') === 'true'; } catch { return false; }
  });

  const toggleShowHidden = () => {
    setShowHidden((prev) => {
      const next = !prev;
      try { localStorage.setItem('link-fs-show-hidden', String(next)); } catch {}
      return next;
    });
  };

  // The scroll listener and the window it derives live in DirectoryView, so a scroll frame
  // re-renders only the rows rather than this whole component.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Load roots initially
  useEffect(() => {
    loadRoots();
  }, [deviceId]);

  // Live download/upload progress — main process emits one throttled event per active transfer
  // (see fs-download-file/fs-upload-item in main.ts). Filtered to this modal's own deviceId so a
  // stray event from a transfer against a different device (unlikely, since only one File
  // Explorer modal is ever open, but cheap to guard) can't paint the wrong progress bar.
  useEffect(() => {
    if (!linkApi.onFsTransferProgress) return;
    return linkApi.onFsTransferProgress((info) => {
      if (info.deviceId !== deviceId) return;
      if (!transferStartRef.current) transferStartRef.current = { time: Date.now(), bytes: info.transferred };
      setTransferProgress({
        transferId: info.transferId,
        direction: info.direction,
        name: info.path.split(/[\\/]/).pop() || info.path,
        transferred: info.transferred,
        total: info.total,
      });
    });
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
  // "Open" means navigate for a folder and play/view for a media file — the Play button routes
  // here rather than taking its own prop, so the memoized row/cell components keep the exact
  // prop set they already had.
  const handleOpen = useCallback(async (item: FsEntry) => {
    if (item.isDirectory) {
      loadDirectory(item.path);
      return;
    }
    // Documents are fetched whole to a read-only temp copy and opened from disk; only media goes
    // down the streaming path. See the fs-open-document handler for why the two differ.
    if (DOCUMENT_RE.test(item.name)) {
      try {
        setDownloadingFile(item.path);
        transferStartRef.current = null;
        await linkApi.fsOpenDocument(deviceId, item.path);
      } catch (err: any) {
        alert(`Could not open: ${err.message}`);
      } finally {
        setDownloadingFile(null);
        setTransferProgress(null);
        transferStartRef.current = null;
      }
      return;
    }

    try {
      const url = await linkApi.fsGetStreamUrl(deviceId, item.path);
      if (!url) throw new Error('Streaming is not available for this device');

      // Images stay in-app on desktop instead of going through openExternal. Video/audio still
      // hand off externally below — a real player earns its keep there (codec support, seeking,
      // proper controls), but a picture is just an <img> tag, which Electron's own Chromium
      // already renders without any handoff at all. Mobile is untouched: ACTION_VIEW there opens
      // the device's own gallery/photos app, not a browser, so the problem this works around
      // doesn't exist on that platform.
      if (!linkApi.isMobile && INLINE_IMAGE_RE.test(item.name)) {
        const viewables = filteredItemsRef.current.filter((i) => !i.isDirectory && INLINE_IMAGE_RE.test(i.name));
        const idx = viewables.findIndex((i) => i.path === item.path);
        setViewingUrl(url);
        setViewingIndex(idx >= 0 ? idx : 0);
        return;
      }

      const result = await linkApi.openExternal(url);
      // Falling back to the browser is fine for what a browser can decode, but for anything else
      // it silently turns into a download — which looks like the feature is broken. Say why.
      if (result?.method === 'browser' && VIDEO_RE.test(item.name) && !BROWSER_VIDEO_RE.test(item.name)) {
        alert(
          `No media player was found that can stream this file, so it opened in your browser — ` +
          `which can't play ${item.name.split('.').pop()?.toUpperCase()} and will download it instead.\n\n` +
          `Install VLC (or mpv / MPC-HC) to play it directly without downloading.`
        );
      }
    } catch (err: any) {
      alert(`Could not open: ${err.message}`);
    }
  }, [loadDirectory, deviceId]);

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
      // A folder needs a destination to be created INSIDE, so it asks for a parent directory and
      // appends the folder's own name; a file asks for its full save path directly.
      let localPath: string | null;
      if (item.isDirectory) {
        const parentDir = await linkApi.fsPickSaveDirectory();
        localPath = parentDir ? `${parentDir}/${item.name}` : null;
      } else {
        localPath = await linkApi.fsPickSavePath(item.name);
      }
      if (!localPath) return; // User cancelled

      setDownloadingFile(item.path);
      transferStartRef.current = null;
      await linkApi.fsDownloadFile(deviceId, item.path, localPath);
      setTransferProgress(null);
      alert(`Successfully downloaded: ${item.name}`);
    } catch (err: any) {
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloadingFile(null);
      setTransferProgress(null);
      transferStartRef.current = null;
    }
  }, [deviceId]);

  const executeUpload = async (paths: string[]) => {
    if (!currentPath || !linkApi || paths.length === 0) return;
    setLoading(true);
    try {
      for (const localPath of paths) {
        transferStartRef.current = null;
        await linkApi.fsUploadItem(deviceId, localPath, currentPath);
      }
      loadDirectory(currentPath);
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setLoading(false);
      setTransferProgress(null);
      transferStartRef.current = null;
    }
  };

  const handleUpload = async (mode: 'file' | 'directory') => {
    if (!currentPath || !linkApi) return;
    try {
      const paths = await linkApi.fsPickUploadItems(mode);
      if (paths && paths.length > 0) {
        await executeUpload(paths);
      }
    } catch (err: any) {
      alert(`Upload picker failed: ${err.message}`);
    }
  };

  const handleDropUpload = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!currentPath || !linkApi) return;
    const paths = Array.from(e.dataTransfer.files).map((f: any) => linkApi.getPathForFile(f)).filter(Boolean);
    if (paths.length > 0) {
      await executeUpload(paths);
    }
  };

  // Filter and sort items. Memoized because this ran on every render — including each keystroke
  // and every unrelated state change — re-sorting the whole directory each time. The deferred
  // query lets React keep the input painting at full speed while a large list catches up.
  const filteredItems = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    let base = showHidden ? items : items.filter((item) => !item.name.startsWith('.'));
    if (needle) {
      base = base.filter((item) => item.name.toLowerCase().includes(needle));
    }

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
  }, [items, deferredQuery, sortBy, sortOrder, showHidden]);

  useEffect(() => {
    filteredItemsRef.current = filteredItems;
  }, [filteredItems]);

  // The set of images the Previous/Next controls can step through — the same list currently
  // shown in the file view, in the same sorted/filtered order, so navigating the viewer matches
  // what the user would see scrolling the list itself.
  const viewableImages = useMemo(
    () => filteredItems.filter((i) => !i.isDirectory && INLINE_IMAGE_RE.test(i.name)),
    [filteredItems]
  );

  // Each image needs its own token-authenticated stream URL, so Previous/Next can't just swap an
  // index and reuse the old URL — this re-mints it whenever the index (or the underlying device/
  // list) changes. `active` guards against a stale response landing after the user has already
  // moved on again or closed the viewer.
  useEffect(() => {
    if (viewingIndex === null) return;
    const item = viewableImages[viewingIndex];
    if (!item) return;
    let active = true;
    linkApi.fsGetStreamUrl(deviceId, item.path).then((url) => {
      if (active) setViewingUrl(url || null);
    }).catch(() => {
      if (active) setViewingUrl(null);
    });
    return () => { active = false; };
  }, [viewingIndex, viewableImages, deviceId]);

  const showPrevImage = useCallback(() => {
    setViewingIndex((i) => (i === null || viewableImages.length === 0) ? i : (i - 1 + viewableImages.length) % viewableImages.length);
  }, [viewableImages.length]);

  const showNextImage = useCallback(() => {
    setViewingIndex((i) => (i === null || viewableImages.length === 0) ? i : (i + 1) % viewableImages.length);
  }, [viewableImages.length]);

  const toggleSort = useCallback((type: 'name' | 'size' | 'date') => {
    if (sortBy === type) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(type);
      setSortOrder('asc');
    }
  }, [sortBy, sortOrder]);

  const getTransferSpeed = () => {
    if (!transferStartRef.current || !transferProgress || transferProgress.transferred <= transferStartRef.current.bytes) return '';
    const elapsed = (Date.now() - transferStartRef.current.time) / 1000;
    if (elapsed <= 0.2) return '';
    const bytes = transferProgress.transferred - transferStartRef.current.bytes;
    return ` @ ${formatSize(bytes / elapsed)}/s`;
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      width: '100%',
      color: 'var(--text-color)',
      fontFamily: 'var(--font-sans)',
    }}>
      {viewingIndex !== null && viewableImages[viewingIndex] && (
        <ImageViewer
          url={viewingUrl}
          name={viewableImages[viewingIndex].name}
          onClose={() => { setViewingIndex(null); setViewingUrl(null); }}
          onPrev={showPrevImage}
          onNext={showNextImage}
          hasMultiple={viewableImages.length > 1}
        />
      )}

      {transferProgress && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--input-bg)', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, overflowWrap: 'anywhere', flex: 1 }}>
              {transferProgress.direction === 'download' ? 'Downloading' : 'Uploading'}: {transferProgress.name}
            </div>
            <button
              onClick={() => {
                if (transferProgress.transferId) {
                  linkApi?.fsCancelTransfer(transferProgress.transferId);
                }
                setTransferProgress(null);
                setDownloadingFile(null);
                transferStartRef.current = null;
              }}
              style={{ padding: '3px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              Cancel
            </button>
          </div>
          <div style={{ width: '100%', height: '6px', background: 'rgba(0,0,0,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${transferProgress.total > 0 ? (transferProgress.transferred / transferProgress.total) * 100 : 0}%`, height: '100%', background: 'var(--accent-color, #007acc)' }} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {formatSize(transferProgress.transferred)} / {formatSize(transferProgress.total)}{getTransferSpeed()}
          </div>
        </div>
      )}

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={handleBack}
            disabled={!currentPath || loading}
            title="Go Back / Parent Directory"
            onMouseEnter={(e) => {
              if (currentPath && !loading) e.currentTarget.style.background = 'var(--input-focus-bg)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--input-bg)';
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'var(--input-bg)',
              color: 'var(--text-color)',
              cursor: !currentPath || loading ? 'not-allowed' : 'pointer',
              opacity: !currentPath || loading ? 0.45 : 1,
              fontWeight: 500,
              transition: 'background 0.15s ease, opacity 0.15s ease',
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back
          </button>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              onClick={handleCreateDirectory}
              disabled={!currentPath || loading}
              title="Create New Folder"
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: 'none',
                background: 'var(--accent-gradient, #3b82f6)',
                color: 'var(--btn-primary-text)',
                fontWeight: 600,
                cursor: !currentPath || loading ? 'not-allowed' : 'pointer',
                opacity: !currentPath || loading ? 0.45 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'opacity 0.15s ease',
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Folder
            </button>

            <div style={{ position: 'relative' }}>
              <button
                onClick={() => {
                  if (currentPath && !loading) {
                    setShowUploadDropdown(!showUploadDropdown);
                  }
                }}
                disabled={!currentPath || loading}
                title="Upload Files or Folders"
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'var(--accent-gradient, #3b82f6)',
                  color: 'var(--btn-primary-text)',
                  fontWeight: 600,
                  cursor: !currentPath || loading ? 'not-allowed' : 'pointer',
                  opacity: !currentPath || loading ? 0.45 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'opacity 0.15s ease',
                }}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                </svg>
                Upload
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: '2px' }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showUploadDropdown && currentPath && (
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
                    {[
                      { type: 'file' as const, label: 'Files', icon: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></> },
                      { type: 'directory' as const, label: 'Folders', icon: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/> },
                    ].map((item) => (
                      <button
                        key={item.type}
                        onClick={() => {
                          setShowUploadDropdown(false);
                          handleUpload(item.type);
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
                          {item.icon}
                        </svg>
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 260px', minWidth: 0, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
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
              flex: '1 1 140px',
              minWidth: 0,
              maxWidth: '300px',
            }}
          />

          <div style={{ display: 'flex', gap: '4px', background: 'var(--input-bg)', padding: '2px', borderRadius: '8px', border: '1px solid var(--border-color)', height: '36px', boxSizing: 'border-box', alignItems: 'center', flexShrink: 0 }}>
            <button
              onClick={toggleShowHidden}
              title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
              style={{
                padding: '6px 10px',
                border: 'none',
                background: showHidden ? 'rgba(255,255,255,0.08)' : 'transparent',
                color: showHidden ? 'var(--accent-color, #3b82f6)' : 'var(--text-muted)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {showHidden ? (
                  <>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                ) : (
                  <>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                )}
              </svg>
            </button>
            {(['list', 'grid'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                title={mode === 'list' ? 'List View' : 'Icon View'}
                style={{
                  padding: '6px 10px',
                  border: 'none',
                  background: viewMode === mode ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: viewMode === mode ? 'var(--accent-color, #3b82f6)' : 'var(--text-muted)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                }}
              >
                {mode === 'list' ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Path Breadcrumbs */}
      <div style={{
        padding: '10px 14px',
        background: 'var(--card-bg)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        fontSize: '13px',
        color: 'var(--text-muted)',
        marginBottom: '16px',
        wordBreak: 'break-all',
        boxShadow: 'var(--card-shadow)',
      }}>
        <strong style={{ color: 'var(--text-color)' }}>Location:</strong> {currentPath || 'Storage Roots'}
      </div>

      {/* Main List Container */}
      <div
        ref={scrollRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDropUpload}
        style={{
          flex: 1,
          minHeight: '420px',
          overflowY: 'auto',
          background: 'var(--card-bg)',
          border: '1px solid var(--border-color)',
          borderRadius: '16px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--card-shadow)',
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
          viewMode === 'list' ? (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 16px',
                height: `${LIST_HEADER_H}px`,
                boxSizing: 'border-box',
                borderBottom: '1px solid var(--border-color)',
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                background: 'rgba(255, 255, 255, 0.02)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>Storage Root</div>
                <div style={{ width: '80px', flexShrink: 0, textAlign: 'right' }}>Action</div>
              </div>
              {roots.map((root) => (
                <div
                  key={root.path}
                  className="fx-row"
                  style={S_ROW}
                  onClick={() => loadDirectory(root.path)}
                >
                  <div style={S_NAME_DIR}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                      <line x1="6" y1="2" x2="6" y2="10"/>
                      <line x1="14" y1="2" x2="14" y2="10"/>
                      <path d="M8 22V14h8v8"/>
                    </svg>
                    <span style={S_NAME_TEXT}>{root.name}</span>
                  </div>
                  <div style={{ ...S_ROW_ACTIONS, color: 'var(--text-muted)', fontSize: '12px' }}>
                    Open
                  </div>
                </div>
              ))}
            </div>
          ) : (
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
          )
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
      {activeDialog === 'createFolder' && (
        <InputDialog
          title="New Folder"
          subtitle="Enter folder name:"
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleCreateDirectorySubmit}
          onCancel={() => setActiveDialog(null)}
          confirmLabel="Create"
        />
      )}

      {activeDialog === 'rename' && dialogItem && (
        <InputDialog
          title="Rename Item"
          subtitle={`Rename "${dialogItem.name}" to:`}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleRenameSubmit}
          onCancel={() => setActiveDialog(null)}
          confirmLabel="Rename"
        />
      )}

      {activeDialog === 'delete' && dialogItem && (
        <ConfirmDialog
          title="Delete Item"
          message={`Are you sure you want to delete "${dialogItem.name}"?`}
          confirmLabel="Delete"
          onConfirm={handleDeleteSubmit}
          onCancel={() => setActiveDialog(null)}
        />
      )}
    </div>
  );
};

export function hasFileAccess(peer: PeerDevice): boolean {
  if (!peer.trusted || !peer.connected) return false;
  return peer.allowedCapabilities === undefined || peer.allowedCapabilities.includes('fileaccess');
}

export interface FilesTabProps {
  peers: Map<string, PeerDevice>;
  selectedDeviceId: string | null;
}

export const FilesTab: React.FC<FilesTabProps> = ({ peers, selectedDeviceId }) => {
  const hasAnyEligible = Array.from(peers.values()).some(hasFileAccess);

  if (!selectedDeviceId) {
    return (
      <div id="tab-files" className="tab-content active">
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.6 }}>
          {hasAnyEligible
            ? 'Choose a device from the switcher above to browse its files.'
            : "Pair a device and grant it File Access (in that device's permissions) to browse its files here."}
        </div>
      </div>
    );
  }

  return (
    <div id="tab-files" className="tab-content active" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <FileExplorerTab deviceId={selectedDeviceId} />
    </div>
  );
};

