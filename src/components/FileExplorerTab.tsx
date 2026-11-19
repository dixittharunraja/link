import React, { useEffect, useState, useRef, useMemo, useCallback, useDeferredValue } from 'react';
import { LinkApi } from '../vite-env';
import { InputDialog, DeleteConfirmDialog } from './DialogCard';
import { PeerDevice } from '../types/peer';
import { IS_ANDROID } from '../utils/platform';
import { pushBackHandler } from '../utils/backNav';

const linkApi = (window as any).link as LinkApi;

// Thumbnails come from the browsed device's own `thumbnail` action (fsThumbnail): a ~256 px JPEG
// made on that device (a phone's LinkFsServer, or a PC's fs_server.rs) and cached on disk here by
// path, size and mtime, instead of the whole original. Only formats the action does not convert
// (ICO, AVIF) are fetched whole over the streaming HTTP server and shrunk here. Both use the bulk
// connection, so previews never delay a directory listing. Fetches are capped by
// THUMB_MAX_CONCURRENT and also cached in memory.
const THUMB_MAX_CONCURRENT = 4;
const THUMB_CACHE_LIMIT = 400;
// Longest edge of the stored preview; cells are 130x70 CSS px, so this stays sharp on hi-dpi.
const THUMB_PX = 320;
// Raster formats thumbnails can be decoded from. SVG is excluded (it needs a vector renderer),
// and HEIC/TIFF/RAW are excluded because Chromium cannot decode them.
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|ico|avif)$/i;
// Formats the thumbnail action converts to JPEG (IMAGE_EXTENSIONS in LinkFsServer.java; on a PC,
// photos.rs decodes HEIC/HEIF through Windows' HEIF extension). HEIC/HEIF previews work from both
// even though Chromium cannot decode the originals.
const DEVICE_THUMB_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;
// Folders are listed in pages of this many entries: the first page shows at once, the rest stream in.
const READDIR_PAGE = 500;
// What the in-app viewer steps through on desktop instead of handing the file to an external app:
// formats an <img> can show directly, plus HEIC/HEIF, which the browser cannot decode but the
// device can turn into a preview (see wantsPreview).
const VIEWER_IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|ico|avif|svg|heic|heif)$/i;
// Media streamed to the system player rather than downloaded. Broader than what a browser can
// play because desktop players handle far more containers and codecs; nothing is transcoded.
const VIDEO_RE = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpe?g|3gp|ts|m2ts|mts|ogv|vob|asf|f4v|divx)$/i;
// Documents are fetched to a read-only temp copy and opened from disk, never streamed
// (see fs_open_document in src-tauri/src/core/fs_transfer.rs).
const DOCUMENT_RE = /\.(pdf|epub|rtf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|csv)$/i;
// What a browser can play. Other formats download instead when the browser is the fallback,
// which warrants a warning.
const BROWSER_VIDEO_RE = /\.(mp4|m4v|webm)$/i;
// Audio is streamed to the system player the same way as video.
const AUDIO_RE = /\.(mp3|flac|wav|aac|m4a|ogg|oga|opus|wma|aif|aiff|ape|alac|mka|amr|mid|midi)$/i;
const BROWSER_AUDIO_RE = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i;
// Where to send someone with no player for a media file: the Play Store on a phone, the website on a PC.
const VLC_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=org.videolan.vlc';
const VLC_WEBSITE_URL = 'https://www.videolan.org/vlc/';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + SIZE_UNITS[i];
}

// Windowing for large directories (a camera folder can hold thousands of entries, each with
// several SVGs and buttons). Smaller directories render every row. Row geometry is fixed rather
// than measured, and rows are given matching explicit heights, so the spacer math cannot drift.
const VIRTUALIZE_THRESHOLD = 120;
const LIST_HEADER_H = 38;
const LIST_ROW_H = 41;
const GRID_CELL_H = 145;
const GRID_GAP = 16;
const GRID_PAD = 20;
const GRID_MIN_W = 130;
const OVERSCAN_ROWS = 6;

// Insertion-ordered, so the first key is the oldest. Values are object URLs rather than data
// URLs, which would keep large base64 strings on the JS heap.
const thumbCache = new Map<string, string>();

function evictOldestThumb() {
  const oldest = thumbCache.keys().next().value;
  if (oldest === undefined) return;
  const url = thumbCache.get(oldest);
  thumbCache.delete(oldest);
  // Object URLs keep their blob alive until revoked.
  if (url) URL.revokeObjectURL(url);
}

// ---- Viewer previews --------------------------------------------------------------------------
// The viewer shows a screen-sized JPEG made by the device, not the original: about 100 KB instead
// of several MB per photo. The original is fetched only on "Full quality". Previews are held in
// memory only (a handful, newest last) and never written to disk.
const PREVIEW_SIDE = 1280;
const PREVIEW_CACHE_LIMIT = 8;
// Files this small are about as cheap to stream as to re-encode, so they are shown as they are.
const PREVIEW_MIN_BYTES = 400 * 1024;
// Chromium cannot decode these, so the device's preview is the only way to show them in the viewer.
const DEVICE_DECODE_RE = /\.(heic|heif)$/i;
// Animated, so a still preview would lose the animation.
const ANIMATED_RE = /\.gif$/i;

const previewCache = new Map<string, string>();
const previewInflight = new Map<string, Promise<string>>();

function wantsPreview(item: { name: string; size: number }): boolean {
  if (DEVICE_DECODE_RE.test(item.name)) return true;
  return DEVICE_THUMB_RE.test(item.name) && !ANIMATED_RE.test(item.name) && item.size > PREVIEW_MIN_BYTES;
}

function previewKey(deviceId: string, item: { path: string; size: number; mtime?: number }): string {
  return `${deviceId}:${item.path}:${item.size}:${item.mtime ?? 0}`;
}

/** The preview's object URL, from memory when it is there, otherwise asked of the device once even
 *  if the viewer and the prefetch both want it. */
function fetchPreview(deviceId: string, item: { path: string; size: number; mtime?: number }): Promise<string> {
  const key = previewKey(deviceId, item);
  const cached = previewCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = previewInflight.get(key);
  if (pending) return pending;
  const request = (async () => {
    try {
      const dataUrl = await linkApi.fsThumbnail(deviceId, item.path, item.size, item.mtime ?? 0, PREVIEW_SIDE);
      const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
      if (previewCache.size >= PREVIEW_CACHE_LIMIT) {
        const oldest = previewCache.keys().next().value;
        if (oldest !== undefined) {
          const old = previewCache.get(oldest);
          previewCache.delete(oldest);
          if (old) URL.revokeObjectURL(old);
        }
      }
      previewCache.set(key, url);
      return url;
    } finally {
      previewInflight.delete(key);
    }
  })();
  previewInflight.set(key, request);
  return request;
}

/** True when the browser says the user wants less data (Data Saver) or the link is slow. */
function dataIsPrecious(): boolean {
  const conn = (navigator as any).connection;
  return !!conn && (conn.saveData === true || /(^|-)2g$/.test(conn.effectiveType || ''));
}

/**
 * Decodes the fetched image once, redraws it at thumbnail size, and keeps only that.
 *
 * Shrinking the original with CSS would make the browser hold the full-resolution bitmap (~48MB
 * for a 12MP photo) and resample it on every paint, which makes grid scrolling stutter.
 *
 * Falls back to the full-size blob if decoding fails.
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

    // Releases the GPU-backed store now rather than at GC; one canvas is created per thumbnail.
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
 * Scrolling a big folder enqueues a waiter per image, and leaving it does not remove them.
 * Waiters therefore report whether they are still wanted, so stale ones are discarded instead of
 * getting a slot, and the queue is LIFO because the most recent request is the one most likely
 * to be on screen.
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
  mtime?: number;
}

const FileThumbnail: React.FC<{ deviceId: string; item: FsEntry }> = React.memo(({ deviceId, item }) => {
  const deviceThumb = DEVICE_THUMB_RE.test(item.name);
  const isImage = deviceThumb || IMAGE_RE.test(item.name);
  const cacheKey = `${deviceId}:${item.path}:${item.size}:${item.mtime ?? 0}`;
  // Seeded from the cache so a revisit paints on the first frame without a request.
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
        // Unmounting (leaving the folder) marks this request stale so it drops out of the queue.
        const granted = await acquireThumbSlot(() => !active);
        if (!granted) return;
        slotHeld = true;
        if (!active) return;

        // Another cell may have fetched the same file while this one waited.
        const cached = thumbCache.get(cacheKey);
        if (cached) {
          setSrc(cached);
          return;
        }

        let objectUrl: string;
        if (deviceThumb) {
          // Already thumbnail-sized: no decode and redraw here.
          const dataUrl = await linkApi.fsThumbnail(deviceId, item.path, item.size, item.mtime ?? 0);
          if (!active) return;
          objectUrl = URL.createObjectURL(await (await fetch(dataUrl)).blob());
        } else {
          const streamUrl = await linkApi.fsGetStreamUrl(deviceId, item.path);
          if (!active) return;
          if (!streamUrl) throw new Error('Streaming is not available for this device');

          const resp = await fetch(streamUrl);
          if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
          const blob = await resp.blob();
          if (!active) return;
          objectUrl = await buildThumbObjectUrl(blob);
        }

        // Unmounted during decode: revoke the new URL so it does not leak.
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        // Another cell may have finished first while this one decoded.
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
        // A failed preview is not reported; the cell stays without a thumbnail.
      } finally {
        if (slotHeld) releaseThumbSlot();
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [deviceId, item.path, item.size, item.mtime, isImage, deviceThumb, visible, src, cacheKey]);

  if (!isImage) {
    return (
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
    );
  }

  // A single container in every state, so the IntersectionObserver target stays on screen.
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

// Shared constant elements, so rows do not create new icon elements on every render.
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
const ICON_MORE = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
    <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
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

// Hoisted style objects, so scroll-driven re-renders do not allocate new ones per row.
const S_ROW: React.CSSProperties = {
  display: 'flex',
  padding: '0 16px',
  height: `${LIST_ROW_H}px`,
  boxSizing: 'border-box',
  flexShrink: 0,
  alignItems: 'center',
  borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
  fontSize: '13.5px',
  // A long press selects; it must not start a text selection or the system callout.
  userSelect: 'none',
  WebkitTouchCallout: 'none',
};
const S_ROW_SELECTED: React.CSSProperties = { ...S_ROW, background: 'rgba(0, 155, 213, 0.12)' };
const S_NAME_BASE: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '10px' };
const S_NAME_DIR: React.CSSProperties = { ...S_NAME_BASE, cursor: 'pointer', color: 'var(--accent-color, #3b82f6)', fontWeight: 600 };
const S_NAME_FILE: React.CSSProperties = { ...S_NAME_BASE, cursor: 'pointer', color: 'inherit', fontWeight: 'normal' };
const S_NAME_TEXT: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const S_ROW_SIZE: React.CSSProperties = { width: '60px', color: 'var(--text-muted)', fontSize: '12.5px', textAlign: 'right', marginRight: '16px', flexShrink: 0 };
const S_ROW_ACTIONS: React.CSSProperties = { width: '80px', flexShrink: 0, display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end' };
// A phone has no room for four buttons per row: one "more" button opens ItemActionSheet instead.
const COMPACT_ACTIONS = IS_ANDROID;
const ACTIONS_W = COMPACT_ACTIONS ? 36 : 80;
const S_ROW_ACTIONS_COMPACT: React.CSSProperties = { width: `${ACTIONS_W}px`, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' };

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
const S_BTN_MORE: React.CSSProperties = { ...S_ICON_BTN, width: '34px', height: '34px', background: 'transparent', color: 'var(--text-muted)' };

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

const LONG_PRESS_MS = 500;

/**
 * Click and long-press handling shared by list rows and grid cells. A long press (touch) or a
 * Ctrl/Cmd-click selects the item and enters selection mode; in selection mode a plain click
 * toggles it; otherwise a click opens it. Clicks on the item's own buttons are left to them.
 */
function useItemPress(item: FsEntry, selectMode: boolean, onOpen: (item: FsEntry) => void, onSelect?: (item: FsEntry) => void) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (longPressed.current) {
        longPressed.current = false;
        return;
      }
      if (onSelect && (selectMode || e.ctrlKey || e.metaKey)) onSelect(item);
      else onOpen(item);
    },
    onTouchStart: (e: React.TouchEvent) => {
      if (!onSelect || (e.target as HTMLElement).closest('button')) return;
      longPressed.current = false;
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        longPressed.current = true;
        onSelect(item);
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    // Android shows a context menu on long press; the press selects instead.
    onContextMenu: (e: React.MouseEvent) => {
      if (IS_ANDROID) e.preventDefault();
    },
  };
}

const SelectBox: React.FC<{ checked: boolean; style?: React.CSSProperties }> = ({ checked, style }) => (
  <span
    aria-hidden
    style={{
      width: '18px', height: '18px', flexShrink: 0, borderRadius: '5px', boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: checked ? 'none' : '1.5px solid var(--text-muted)',
      background: checked ? 'var(--accent-color, #009bd5)' : 'transparent',
      color: '#000',
      ...style,
    }}
  >
    {checked && (
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )}
  </span>
);

const S_CHECK_BTN: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  width: '32px', height: '32px', margin: '0 6px 0 -8px', padding: 0,
  background: 'transparent', border: 'none', cursor: 'pointer',
};

const CheckButton: React.FC<{ checked: boolean; label: string; onToggle: () => void; style?: React.CSSProperties }> = ({ checked, label, onToggle, style }) => (
  <button
    role="checkbox"
    aria-checked={checked}
    aria-label={label}
    onClick={(e) => { e.stopPropagation(); onToggle(); }}
    style={{ ...S_CHECK_BTN, ...style }}
  >
    <SelectBox checked={checked} />
  </button>
);

interface ItemProps {
  item: FsEntry;
  downloading: boolean;
  onOpen: (item: FsEntry) => void;
  onDownload: (item: FsEntry) => void;
  onRename: (item: FsEntry) => void;
  onDelete: (item: FsEntry) => void;
  onMore?: (item: FsEntry) => void;
  selectMode?: boolean;
  selected?: boolean;
  onSelect?: (item: FsEntry) => void;
}

// Memoized so a scroll frame reconciles only the rows that entered or left the window.
const FileRow = React.memo<ItemProps>(({ item, downloading, onOpen, onDownload, onRename, onDelete, onMore, selectMode, selected, onSelect }) => {
  const press = useItemPress(item, !!selectMode, onOpen, onSelect);
  return (
  <div className="fx-row" style={selected ? S_ROW_SELECTED : S_ROW} aria-selected={selectMode ? !!selected : undefined} {...press}>
    {onSelect && <CheckButton checked={!!selected} label={`Select ${item.name}`} onToggle={() => onSelect(item)} />}
    <div style={item.isDirectory ? S_NAME_DIR : S_NAME_FILE}>
      {item.isDirectory ? ICON_FOLDER : ICON_FILE}
      <span style={S_NAME_TEXT}>{item.name}</span>
    </div>

    <div style={S_ROW_SIZE}>{item.isDirectory ? '--' : formatSize(item.size)}</div>

    {selectMode ? (
      // Keeps the size column aligned with the header while the actions are hidden.
      <div style={{ width: `${ACTIONS_W}px`, flexShrink: 0 }} />
    ) : onMore ? (
      <div style={S_ROW_ACTIONS_COMPACT}>
        <button onClick={() => onMore(item)} title="More actions" aria-label={`Actions for ${item.name}`} style={S_BTN_MORE}>
          {downloading ? ICON_SPINNER : ICON_MORE}
        </button>
      </div>
    ) : (
    <div style={S_ROW_ACTIONS}>
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
    )}
  </div>
  );
});
FileRow.displayName = 'FileRow';

const FileCell = React.memo<ItemProps & { deviceId: string }>(
  ({ deviceId, item, downloading, onOpen, onDownload, onRename, onDelete, selectMode, selected, onSelect }) => {
    const press = useItemPress(item, !!selectMode, onOpen, onSelect);
    const base = item.isDirectory ? S_CELL_DIR : S_CELL_FILE;
    return (
    <div
      className="fx-cell"
      style={selected ? { ...base, borderColor: 'var(--accent-color, #009bd5)', background: 'rgba(0, 155, 213, 0.12)' } : base}
      aria-selected={selectMode ? !!selected : undefined}
      {...press}
    >
      {onSelect && (
        <CheckButton
          checked={!!selected}
          label={`Select ${item.name}`}
          onToggle={() => onSelect(item)}
          style={{ position: 'absolute', top: '2px', left: '2px', margin: 0, zIndex: 3 }}
        />
      )}
      <div style={S_CELL_THUMB}>
        {item.isDirectory ? ICON_FOLDER_LG : <FileThumbnail deviceId={deviceId} item={item} />}
      </div>

      <div style={item.isDirectory ? S_CELL_NAME_DIR : S_CELL_NAME_FILE}>{item.name}</div>
      <div style={S_CELL_SIZE}>{item.isDirectory ? 'Folder' : formatSize(item.size)}</div>

      {!selectMode && <div className="fx-cell-actions" style={S_CELL_ACTIONS}>
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
      </div>}
    </div>
    );
  }
);
FileCell.displayName = 'FileCell';

const S_SHEET_ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
  padding: '14px 18px', background: 'transparent', border: 'none', borderRadius: '10px',
  color: 'var(--text-color)', fontSize: '14.5px', textAlign: 'left', cursor: 'pointer',
};

/** The row actions as a bottom sheet, for phones (see COMPACT_ACTIONS). */
const ItemActionSheet: React.FC<{
  item: FsEntry;
  downloading: boolean;
  onClose: () => void;
  onDownload: (item: FsEntry) => void;
  onRename: (item: FsEntry) => void;
  onDelete: (item: FsEntry) => void;
}> = ({ item, downloading, onClose, onDownload, onRename, onDelete }) => {
  useEffect(() => pushBackHandler(() => { onClose(); return true; }), [onClose]);
  const run = (action: (item: FsEntry) => void) => () => { onClose(); action(item); };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', background: 'var(--card-bg, #141418)', borderTop: '1px solid var(--border-color)',
          borderRadius: '16px 16px 0 0', padding: '10px 8px calc(12px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 18px 12px', borderBottom: '1px solid var(--border-color)', marginBottom: '6px' }}>
          {item.isDirectory ? ICON_FOLDER : ICON_FILE}
          <div style={{ minWidth: 0 }}>
            <div style={{ ...S_NAME_TEXT, fontWeight: 600, fontSize: '14px' }}>{item.name}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{item.isDirectory ? 'Folder' : formatSize(item.size)}</div>
          </div>
        </div>
        <button style={S_SHEET_ROW} onClick={run(onDownload)} disabled={downloading}>
          <span style={{ color: 'var(--active-dot, #10b981)', display: 'flex' }}>{downloading ? ICON_SPINNER : ICON_DOWNLOAD}</span>
          {item.isDirectory ? 'Download folder' : 'Download'}
        </button>
        <button style={S_SHEET_ROW} onClick={run(onRename)}>
          <span style={{ color: 'var(--text-muted)', display: 'flex' }}>{ICON_RENAME}</span>Rename
        </button>
        <button style={{ ...S_SHEET_ROW, color: '#ef4444' }} onClick={run(onDelete)}>
          <span style={{ display: 'flex' }}>{ICON_DELETE}</span>Delete
        </button>
      </div>
    </div>
  );
};

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
  selectMode: boolean;
  selected: Set<string>;
  onSelect: (item: FsEntry) => void;
  onToggleAll: () => void;
}

/**
 * Owns the scroll-derived window, so a scroll frame re-renders only the rows and not the whole
 * explorer. The scroll listener is attached only when windowing is in effect; smaller folders
 * scroll with no JavaScript involved.
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
  selectMode,
  selected,
  onSelect,
  onToggleAll,
}) => {
  const virtualize = items.length > VIRTUALIZE_THRESHOLD;
  const [scrollTop, setScrollTop] = useState(0);
  const [sheetItem, setSheetItem] = useState<FsEntry | null>(null);
  const onMore = COMPACT_ACTIONS ? setSheetItem : undefined;
  const [viewport, setViewport] = useState({ height: 0, width: 0 });

  useEffect(() => {
    if (!virtualize) return;
    const el = scrollRef.current;
    if (!el) return;

    let frame = 0;
    const onScroll = () => {
      // At most one state write per frame; scroll events fire far more often.
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

  // Re-read the offset when the listing changes: a new directory scrolls to the top, but sorting
  // or filtering keeps the current position.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, [items, scrollRef]);

  const listWindow = useMemo(() => {
    const total = items.length;
    if (!virtualize || viewport.height === 0) return { items, padTop: 0, padBottom: 0 };

    // The header scrolls with the rows, so its height is subtracted first.
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
          // Fixed so the windowing math can subtract an exact header height.
          height: `${LIST_HEADER_H}px`,
          boxSizing: 'border-box',
          borderBottom: '1px solid var(--border-color)',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--text-muted)',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <CheckButton
            checked={items.length > 0 && items.every((i) => selected.has(i.path))}
            label="Select all"
            onToggle={onToggleAll}
          />
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer', display: 'flex', alignItems: 'center' }} onClick={() => onToggleSort('name')}>
            Name {sortBy === 'name' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
          </div>
          <div style={{ width: '60px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginRight: '16px', flexShrink: 0 }} onClick={() => onToggleSort('size')}>
            Size {sortBy === 'size' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
          </div>
          <div style={{ width: `${ACTIONS_W}px`, flexShrink: 0, textAlign: 'right' }}>{COMPACT_ACTIONS ? '' : 'Actions'}</div>
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
            onMore={onMore}
            selectMode={selectMode}
            selected={selected.has(item.path)}
            onSelect={onSelect}
          />
        ))}
        {listWindow.padBottom > 0 && <div style={{ height: `${listWindow.padBottom}px`, flexShrink: 0 }} />}
        {sheetItem && (
          <ItemActionSheet
            item={sheetItem}
            downloading={downloadingPath === sheetItem.path}
            onClose={() => setSheetItem(null)}
            onDownload={onDownload}
            onRename={onRename}
            onDelete={onDelete}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid',
      // While windowing, the column count is fixed to the computed one so the row math matches
      // the layout.
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
          selectMode={selectMode}
          selected={selected.has(item.path)}
          onSelect={onSelect}
        />
      ))}
      {gridWindow.padBottom > 0 && <div style={{ gridColumn: '1 / -1', height: `${gridWindow.padBottom}px` }} />}
    </div>
  );
});
DirectoryView.displayName = 'DirectoryView';

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

/** Full-screen in-app preview (see VIEWER_IMAGE_RE). `url` is a small device-made preview held in
 *  previewCache, or the original's stream URL; either way the cache owns it, so nothing is revoked here. */
const ImageViewer: React.FC<{
  url: string | null;
  name: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasMultiple: boolean;
  /** The grid's cached thumbnail, shown blurred until the real image arrives, so nothing is blank. */
  placeholder?: string | null;
  /** Set while a preview is showing and the original can be shown; loads the original. */
  onFullQuality?: () => void;
}> = ({ url, name, onClose, onPrev, onNext, hasMultiple, placeholder, onFullQuality }) => {
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
        {onFullQuality && (
          <button
            onClick={(e) => { e.stopPropagation(); onFullQuality(); }}
            title="Load the original file (uses more data)"
            style={{
              marginLeft: 'auto', marginRight: '12px', padding: '6px 10px', borderRadius: '6px',
              border: 'none', background: 'rgba(255, 255, 255, 0.1)', color: '#fff', cursor: 'pointer', fontSize: '12px',
            }}
          >
            Full quality
          </button>
        )}
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
      {url ? (
        <img
          key={url}
          src={url}
          alt={name}
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: '90vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: '4px', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
        />
      ) : placeholder ? (
        <img
          src={placeholder}
          alt=""
          style={{ maxWidth: '90vw', maxHeight: '85vh', minWidth: '40vmin', objectFit: 'contain', borderRadius: '4px', filter: 'blur(10px)', opacity: 0.8 }}
        />
      ) : null}
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
  // Deferred so typing stays responsive while the re-filter of a large list catches up.
  const deferredQuery = useDeferredValue(searchQuery);
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'date'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  // Progress of the active transfer; downloads and uploads here run one at a time.
  const [transferProgress, setTransferProgress] = useState<{ transferId: string; direction: 'download' | 'upload'; name: string; transferred: number; total: number } | null>(null);
  const transferStartRef = useRef<{ time: number; bytes: number } | null>(null);
  // Mirrors filteredItems (declared below) so handleOpen can find the clicked image's position.
  const filteredItemsRef = useRef<FsEntry[]>([]);
  // Index into viewableImages of the image in the viewer; Previous/Next move it and an effect
  // resolves its URL.
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  const [viewingUrl, setViewingUrl] = useState<string | null>(null);
  // True while the viewer shows a device-made preview rather than the original file.
  const [viewingIsPreview, setViewingIsPreview] = useState(false);

  const [activeDialog, setActiveDialog] = useState<'createFolder' | 'rename' | 'delete' | 'deleteMany' | null>(null);
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

  // The scroll container; DirectoryView owns the scroll listener and window.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Multi-select: paths of the ticked items in the current folder. Selection mode is on while
  // anything is ticked; in it a click on an item ticks it instead of opening it.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectMode = selected.size > 0;
  const exitSelect = useCallback(() => setSelected(new Set()), []);
  const handleSelect = useCallback((item: FsEntry) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      return next;
    });
  }, []);
  // A selection belongs to one folder.
  useEffect(() => { exitSelect(); }, [currentPath, deviceId, exitSelect]);
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitSelect(); };
    window.addEventListener('keydown', onKey);
    const popBack = pushBackHandler(() => { exitSelect(); return true; });
    return () => {
      window.removeEventListener('keydown', onKey);
      popBack();
    };
  }, [selectMode, exitSelect]);

  useEffect(() => {
    loadRoots();
  }, [deviceId]);

  // Throttled progress events from src-tauri/src/core/fs_transfer.rs, filtered to this device.
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

  // Bumped by every navigation, so the remaining pages of a folder that was left stop loading.
  const loadSeqRef = useRef(0);

  const loadRoots = useCallback(async () => {
    loadSeqRef.current++;
    setLoading(true);
    setError(null);
    try {
      // The phone's file server may still be starting right after launch, so retry once quietly.
      let res;
      try {
        res = await linkApi.fsListRoots(deviceId);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        res = await linkApi.fsListRoots(deviceId);
      }
      setRoots(res || []);
      setCurrentPath(null);
      setItems([]);
    } catch (err: any) {
      // Tauri rejects with a plain string, so err.message is usually undefined.
      const reason = typeof err === 'string' ? err : err?.message;
      setError(reason ? `Failed to load device storage roots: ${reason}` : 'Failed to load device storage roots');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  // A folder arrives in pages: the first one is shown as soon as it lands (only its entries were
  // stat'ed on the device), and later pages are appended and re-sorted with the rest.
  const loadDirectory = useCallback(async (path: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    const sep = path.endsWith('/') || path.endsWith('\\') ? '' : '/';
    const withPaths = (entries: any[]): FsEntry[] => entries.map((item: any) => ({ ...item, path: `${path}${sep}${item.name}` }));
    try {
      let page = await linkApi.fsReaddir(deviceId, path, 0, READDIR_PAGE);
      if (seq !== loadSeqRef.current) return;
      setItems(withPaths(page.entries));
      setCurrentPath(path);
      // A new directory starts at the top; DirectoryView re-reads the offset when `items` changes.
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setLoading(false);
      let offset = page.entries.length;
      while (page.hasMore && page.entries.length > 0) {
        page = await linkApi.fsReaddir(deviceId, path, offset, READDIR_PAGE);
        if (seq !== loadSeqRef.current) return;
        offset += page.entries.length;
        const more = withPaths(page.entries);
        setItems((prev) => prev.concat(more));
      }
    } catch (err: any) {
      if (seq === loadSeqRef.current) setError(err?.message || (typeof err === 'string' ? err : `Failed to read folder: ${path}`));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [deviceId]);

  const handleBack = () => {
    if (!currentPath) return;

    // From a storage root, go back to the roots view.
    const isRoot = roots.some(r => r.path === currentPath);
    if (isRoot) {
      loadRoots();
      return;
    }

    const parts = currentPath.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) {
      loadRoots();
    } else {
      // Keep the leading slash of an absolute Unix path.
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

  // Suggests VLC, which plays nearly every format, and opens its install page if the user agrees:
  // the Play Store on a phone, videolan.org on a PC.
  const offerVlc = useCallback((reason: string) => {
    if (window.confirm(`${reason}\n\nVLC plays almost any video or audio file. Open its download page?`)) {
      linkApi.openExternal(linkApi.isMobile ? VLC_PLAY_STORE_URL : VLC_WEBSITE_URL)?.catch?.(() => {});
    }
  }, []);

  // Row handlers keep stable identities because FileRow and FileCell are memoized.
  // Opening navigates into a folder, opens a document, or views/streams a media file.
  const handleOpen = useCallback(async (item: FsEntry) => {
    if (item.isDirectory) {
      loadDirectory(item.path);
      return;
    }
    // Documents go through a read-only temp copy (see DOCUMENT_RE); everything else streams.
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
      // On desktop, images open in the in-app viewer; other media goes to the system player,
      // which handles codecs and seeking. On Android, openExternal already opens the gallery.
      // The viewer resolves its own image (a small preview where it can), so no stream URL is
      // asked for here: fetching the original just to open the viewer would defeat the preview.
      if (!linkApi.isMobile && VIEWER_IMAGE_RE.test(item.name)) {
        const viewables = filteredItemsRef.current.filter((i) => !i.isDirectory && VIEWER_IMAGE_RE.test(i.name));
        const idx = viewables.findIndex((i) => i.path === item.path);
        setViewingUrl(null);
        setViewingIndex(idx >= 0 ? idx : 0);
        return;
      }

      const url = await linkApi.fsGetStreamUrl(deviceId, item.path);
      if (!url) throw new Error('Streaming is not available for this device');

      const isVideo = VIDEO_RE.test(item.name);
      const isAudio = AUDIO_RE.test(item.name);
      let result;
      try {
        result = await linkApi.openExternal(url);
      } catch (err: any) {
        // On a phone the open fails outright when no installed app plays this type.
        if (isVideo || isAudio) {
          offerVlc(`No app on this device can play ${item.name}.`);
          return;
        }
        throw err;
      }
      // A browser downloads formats it cannot play, which looks broken, so explain it.
      if (result?.method === 'browser'
        && ((isVideo && !BROWSER_VIDEO_RE.test(item.name)) || (isAudio && !BROWSER_AUDIO_RE.test(item.name)))) {
        offerVlc(
          `No media player was found that can stream this file, so it opened in your browser — ` +
          `which can't play ${item.name.split('.').pop()?.toUpperCase()} and will download it instead.`
        );
      }
    } catch (err: any) {
      alert(`Could not open: ${err.message}`);
    }
  }, [loadDirectory, deviceId, offerVlc]);

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
      // A folder asks for a parent directory and appends its own name; a file asks for a full path.
      let localPath: string | null;
      if (item.isDirectory) {
        const parentDir = await linkApi.fsPickSaveDirectory();
        localPath = parentDir ? `${parentDir}/${item.name}` : null;
      } else {
        localPath = await linkApi.fsPickSavePath(item.name);
      }
      if (!localPath) return;

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

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const shown = filteredItemsRef.current;
      const all = shown.length > 0 && shown.every((i) => prev.has(i.path));
      return all ? new Set() : new Set(shown.map((i) => i.path));
    });
  }, []);

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.path)), [items, selected]);
  const errorText = (err: any) => (typeof err === 'string' ? err : err?.message || 'unknown error');

  // Asks for one folder and downloads every selected item into it, one at a time.
  const handleDownloadSelected = async () => {
    const targets = selectedItems;
    if (targets.length === 0) return;
    const dir = await linkApi.fsPickSaveDirectory();
    if (!dir) return;
    const failed: string[] = [];
    for (const item of targets) {
      setDownloadingFile(item.path);
      transferStartRef.current = null;
      try {
        await linkApi.fsDownloadFile(deviceId, item.path, `${dir}/${item.name}`);
      } catch (err: any) {
        failed.push(`${item.name}: ${errorText(err)}`);
      }
    }
    setDownloadingFile(null);
    setTransferProgress(null);
    transferStartRef.current = null;
    exitSelect();
    const done = targets.length - failed.length;
    alert(failed.length ? `Downloaded ${done} of ${targets.length}.\n${failed.join('\n')}` : `Downloaded ${done} item${done === 1 ? '' : 's'}.`);
  };

  const handleDeleteSelectedSubmit = async () => {
    const targets = selectedItems;
    setActiveDialog(null);
    const failed: string[] = [];
    for (const item of targets) {
      try {
        await linkApi.fsDelete(deviceId, item.path);
      } catch (err: any) {
        failed.push(`${item.name}: ${errorText(err)}`);
      }
    }
    exitSelect();
    if (currentPath) loadDirectory(currentPath);
    if (failed.length) alert(`Could not delete ${failed.length} of ${targets.length}.\n${failed.join('\n')}`);
  };

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

  // Memoized so unrelated renders do not re-sort the whole directory.
  const filteredItems = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    let base = showHidden ? items : items.filter((item) => !item.name.startsWith('.'));
    if (needle) {
      base = base.filter((item) => item.name.toLowerCase().includes(needle));
    }

    // localeCompare is markedly slower than a plain collator over thousands of names.
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    return base.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      let comparison = 0;
      if (sortBy === 'name') {
        comparison = collator.compare(a.name, b.name);
      } else if (sortBy === 'size') {
        comparison = a.size - b.size;
      } else if (sortBy === 'date') {
        comparison = (a.mtime || 0) - (b.mtime || 0);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }, [items, deferredQuery, sortBy, sortOrder, showHidden]);

  useEffect(() => {
    filteredItemsRef.current = filteredItems;
  }, [filteredItems]);

  // Images Previous/Next step through, in the same order as the visible list.
  const viewableImages = useMemo(
    () => filteredItems.filter((i) => !i.isDirectory && VIEWER_IMAGE_RE.test(i.name)),
    [filteredItems]
  );

  // What the viewer shows for the current image: a small device-made preview where one helps
  // (see wantsPreview), otherwise the original through its own token-authenticated stream URL.
  // `active` discards a response that arrives after the user has moved on or closed the viewer.
  useEffect(() => {
    if (viewingIndex === null) return;
    const item = viewableImages[viewingIndex];
    if (!item) return;
    let active = true;

    const showOriginal = async () => {
      const url = await linkApi.fsGetStreamUrl(deviceId, item.path);
      if (!active) return;
      setViewingIsPreview(false);
      setViewingUrl(url || null);
    };

    setViewingUrl(null);
    (async () => {
      if (!wantsPreview(item)) {
        await showOriginal();
        return;
      }
      try {
        const url = await fetchPreview(deviceId, item);
        if (!active) return;
        setViewingIsPreview(true);
        setViewingUrl(url);
        // Warm the next photo once this one is on screen, so stepping forward feels instant. Not when
        // data is precious, and never more than one ahead.
        const next = viewableImages[(viewingIndex + 1) % viewableImages.length];
        if (next && next.path !== item.path && wantsPreview(next) && !dataIsPrecious()) {
          fetchPreview(deviceId, next).catch(() => {});
        }
      } catch {
        // The device could not make a preview (an unsupported file, or it is offline).
        if (active) await showOriginal();
      }
    })().catch(() => {
      if (active) setViewingUrl(null);
    });
    return () => { active = false; };
  }, [viewingIndex, viewableImages, deviceId]);

  const showFullQuality = useCallback(() => {
    if (viewingIndex === null) return;
    const item = viewableImages[viewingIndex];
    if (!item) return;
    linkApi.fsGetStreamUrl(deviceId, item.path).then((url) => {
      if (!url) return;
      setViewingIsPreview(false);
      setViewingUrl(url);
    }).catch(() => {});
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
          placeholder={thumbCache.get(previewKey(deviceId, viewableImages[viewingIndex]))}
          onFullQuality={viewingIsPreview && !DEVICE_DECODE_RE.test(viewableImages[viewingIndex].name) ? showFullQuality : undefined}
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

      {/* Toolbar */}
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

      {/* Current path */}
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

      {selectMode && currentPath !== null && (() => {
        // Select all lives on the list header's check box. On a phone the actions are icons, so the
        // bar stays on one line.
        const barButton: React.CSSProperties = {
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexShrink: 0,
          height: '34px', padding: COMPACT_ACTIONS ? '0' : '0 12px', width: COMPACT_ACTIONS ? '38px' : undefined,
          fontSize: '12.5px', borderRadius: '8px',
        };
        return (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 10px', marginBottom: '12px', borderRadius: '12px',
            border: '1px solid var(--accent-color, #009bd5)', background: 'rgba(0, 155, 213, 0.08)',
          }}>
            <button onClick={exitSelect} title="Cancel selection" aria-label="Cancel selection" style={{ ...barButton, width: '34px', padding: 0 }}>✕</button>
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: '13.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {selected.size} selected
            </span>
            <button
              onClick={handleDownloadSelected}
              disabled={!!downloadingFile}
              title="Download selected"
              aria-label="Download selected"
              style={{ ...barButton, color: 'var(--active-dot, #10b981)' }}
            >
              {downloadingFile ? ICON_SPINNER : ICON_DOWNLOAD}{!COMPACT_ACTIONS && 'Download'}
            </button>
            <button
              onClick={() => setActiveDialog('deleteMany')}
              title="Delete selected"
              aria-label="Delete selected"
              style={{ ...barButton, color: '#ef4444' }}
            >
              {ICON_DELETE}{!COMPACT_ACTIONS && 'Delete'}
            </button>
          </div>
        );
      })()}

      {/* Scroll container */}
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

        {/* Storage roots */}
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
            selectMode={selectMode}
            selected={selected}
            onSelect={handleSelect}
            onToggleAll={toggleSelectAll}
          />
        )}
      </div>

      {/* Dialogs */}
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

      {activeDialog === 'deleteMany' && selectedItems.length > 0 && (
        <DeleteConfirmDialog
          names={selectedItems.map((i) => i.name)}
          includesFolders={selectedItems.some((i) => i.isDirectory)}
          onConfirm={handleDeleteSelectedSubmit}
          onCancel={() => setActiveDialog(null)}
        />
      )}

      {activeDialog === 'delete' && dialogItem && (
        <DeleteConfirmDialog
          names={[dialogItem.name]}
          includesFolders={dialogItem.isDirectory}
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

