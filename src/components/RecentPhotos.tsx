import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LinkApi } from '../vite-env';

const linkApi = (window as any).link as LinkApi;

// The newest photos on a paired phone, pulled on demand: the list comes first, then a small thumbnail for each photo that
// scrolls into view. Nothing is synced or stored on this PC; a photo's full file is only fetched when it is saved, opened or
// copied. (Dragging a photo out into another app is not possible from this window, so each photo has Save, Copy and Open.)

interface RecentPhoto {
  path: string;
  name: string;
  size: number;
  modified: number;
}

const PAGE_SIZE = 30;
const MAX_CONCURRENT_THUMBNAILS = 3;
const MAX_CACHED_THUMBNAILS = 300;

// Thumbnails already fetched this session, so scrolling back (or reopening the panel) costs nothing.
const thumbnailCache = new Map<string, string>();

// At most a few thumbnail requests at a time, so a long strip does not flood the phone.
let running = 0;
const waiting: Array<() => void> = [];
function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          running--;
          waiting.shift()?.();
        });
    };
    if (running < MAX_CONCURRENT_THUMBNAILS) run();
    else waiting.push(run);
  });
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function reasonOf(err: unknown): string {
  const text = typeof err === 'string' ? err : (err as any)?.message || 'Something went wrong';
  if (/permission denied|fileaccess/i.test(text)) return 'File access is switched off for this device (Permissions).';
  return text;
}

const actionButton: React.CSSProperties = {
  flex: 1,
  padding: '3px 0',
  fontSize: '11px',
  borderRadius: '5px',
  border: '1px solid var(--border-color)',
  background: 'rgba(255, 255, 255, 0.04)',
  color: 'var(--text-color)',
  cursor: 'pointer',
};

interface TileProps {
  deviceId: string;
  photo: RecentPhoto;
  onOpen: (photo: RecentPhoto) => void;
  onSave: (photo: RecentPhoto) => void;
  onCopy: (photo: RecentPhoto) => void;
}

const PhotoTile: React.FC<TileProps> = ({ deviceId, photo, onOpen, onSave, onCopy }) => {
  const key = `${deviceId}|${photo.path}|${photo.modified}`;
  const [src, setSrc] = useState<string | null>(thumbnailCache.get(key) ?? null);
  const [failed, setFailed] = useState(false);
  const tileRef = useRef<HTMLDivElement | null>(null);

  // Fetch the thumbnail only once the tile is (nearly) on screen.
  useEffect(() => {
    if (src || failed) return;
    const node = tileRef.current;
    if (!node) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        limited(() => linkApi.getPhotoThumbnail!(deviceId, photo.path, photo.size, photo.modified))
          .then((url) => {
            if (thumbnailCache.size >= MAX_CACHED_THUMBNAILS) {
              const oldest = thumbnailCache.keys().next().value;
              if (oldest !== undefined) thumbnailCache.delete(oldest);
            }
            thumbnailCache.set(key, url);
            if (!cancelled) setSrc(url);
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
      },
      { rootMargin: '0px 240px 0px 240px' },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [src, failed, key, deviceId, photo.path]);

  return (
    <div ref={tileRef} style={{ width: '104px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div
        onClick={() => onOpen(photo)}
        title={`Open ${photo.name}`}
        style={{
          width: '104px',
          height: '104px',
          borderRadius: '8px',
          overflow: 'hidden',
          border: '1px solid var(--border-color)',
          background: 'rgba(255, 255, 255, 0.04)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: '11px',
        }}
      >
        {src ? (
          <img src={src} alt={photo.name} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : failed ? (
          'No preview'
        ) : (
          '…'
        )}
      </div>
      <div style={{ fontSize: '11px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={photo.name}>
        {photo.name}
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{formatSize(photo.size)}</div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <button style={actionButton} onClick={() => onSave(photo)} title="Save to a folder on this PC">
          Save
        </button>
        <button style={actionButton} onClick={() => onCopy(photo)} title="Copy the image to the clipboard">
          Copy
        </button>
      </div>
    </div>
  );
};

interface RecentPhotosProps {
  deviceId: string;
}

const RecentPhotos: React.FC<RecentPhotosProps> = ({ deviceId }) => {
  const [photos, setPhotos] = useState<RecentPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Collapsed until opened, so the panel stays short and nothing is fetched from the phone unless wanted.
  const [expanded, setExpanded] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((message: string) => {
    setStatus(message);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  const load = useCallback(
    async (more: boolean) => {
      if (!linkApi?.getRecentPhotos) return;
      setLoading(true);
      setError(null);
      try {
        const before = more && photos.length > 0 ? photos[photos.length - 1].modified : undefined;
        const page: RecentPhoto[] = await linkApi.getRecentPhotos(deviceId, PAGE_SIZE, before);
        setPhotos((prev) => (more ? [...prev, ...page.filter((p) => !prev.some((q) => q.path === p.path))] : page));
        setHasMore(page.length >= PAGE_SIZE);
      } catch (err) {
        setError(reasonOf(err));
        if (!more) setPhotos([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [deviceId, photos],
  );

  // First load when the strip is opened (or the device changes while it is open).
  useEffect(() => {
    if (!expanded) return;
    setPhotos([]);
    void load(false);
  }, [deviceId, expanded]);

  const open = async (photo: RecentPhoto) => {
    try {
      await linkApi.fsOpenDocument?.(deviceId, photo.path);
    } catch (err) {
      say(`Could not open ${photo.name}: ${reasonOf(err)}`);
    }
  };

  const save = async (photo: RecentPhoto) => {
    try {
      const target = await linkApi.fsPickSavePath?.(photo.name);
      if (!target) return;
      say(`Saving ${photo.name}…`);
      await linkApi.fsDownloadFile?.(deviceId, photo.path, target);
      say(`Saved ${photo.name}`);
    } catch (err) {
      say(`Could not save ${photo.name}: ${reasonOf(err)}`);
    }
  };

  const copy = async (photo: RecentPhoto) => {
    try {
      say(`Copying ${photo.name}…`);
      await linkApi.copyPhotoToClipboard?.(deviceId, photo.path);
      say(`Copied ${photo.name} to the clipboard`);
    } catch (err) {
      say(`Could not copy ${photo.name}: ${reasonOf(err)}`);
    }
  };

  if (!linkApi?.getRecentPhotos) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flex: 1,
            minWidth: 0,
            padding: '2px 0',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-color)',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span>
            <span style={{ display: 'block', fontSize: '13px', fontWeight: 600 }}>Recent photos</span>
            <span style={{ display: 'block', marginTop: '2px', fontSize: '11.5px', lineHeight: 1.4, color: 'var(--text-muted)' }}>Newest on this phone. Nothing is copied until you save one.</span>
          </span>
        </button>
        {expanded && (
        <button
          onClick={() => void load(false)}
          disabled={loading}
          style={{
            padding: '5px 10px',
            fontSize: '12px',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            background: 'transparent',
            color: 'var(--text-color)',
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        )}
      </div>

      {!expanded ? null : error ? (
        <div style={{ color: '#e05c5c', fontSize: '12px', overflowWrap: 'anywhere' }}>{error}</div>
      ) : photos.length === 0 && !loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No photos found on this phone.</div>
      ) : (
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px' }}>
          {photos.map((photo) => (
            <PhotoTile key={photo.path} deviceId={deviceId} photo={photo} onOpen={open} onSave={save} onCopy={copy} />
          ))}
          {hasMore && (
            <button
              onClick={() => void load(true)}
              disabled={loading}
              style={{
                width: '104px',
                height: '104px',
                flexShrink: 0,
                borderRadius: '8px',
                border: '1px dashed var(--border-color)',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: '12px',
                cursor: loading ? 'default' : 'pointer',
              }}
            >
              {loading ? '…' : 'More'}
            </button>
          )}
        </div>
      )}

      {status && <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{status}</div>}
    </div>
  );
};

export default RecentPhotos;
