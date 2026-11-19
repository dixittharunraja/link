import React, { useEffect, useState } from 'react';
import { MapPin, RefreshCw, ExternalLink, Copy } from 'lucide-react';
import { useEscapeAndBack } from '../hooks/useEscapeAndBack';
import { ModalCloseButton } from './DialogCard';
import {
  DeviceFix,
  LocateStatus,
  ago,
  embedMapUrl,
  formatAccuracy,
  lastLocation,
  mapsUrl,
  onLocation,
  requestLocation,
} from '../utils/deviceLocation';

interface LocateModalProps {
  deviceId: string;
  deviceName: string;
  /** Connected now: a fresh fix can be asked for. Offline shows the last known position only. */
  online: boolean;
  onClose: () => void;
}

// The located device stops looking after 30 s (LinkLocation.FRESH_TIMEOUT_MS); a little more for the trip back.
const SEARCH_TIMEOUT_MS = 35_000;

const STATUS_TEXT: Record<Exclude<LocateStatus, 'done'>, string> = {
  notAllowed: 'That device has not allowed you to locate it. On it, open Link, then the permissions for this device, and turn on "Allow Location".',
  noPermission: 'Link on that device has no location access. On a phone, open Link and allow location. On a PC, turn on Location services and "Let desktop apps access your location" in Windows Settings.',
  off: 'Location is switched off on that device, so only its last known position can be shown.',
  unavailable: 'That device could not get a position.',
};

function providerLabel(provider?: string): string {
  switch (provider) {
    case 'gps':
      return 'GPS';
    case 'network':
      return 'Wi-Fi / mobile network';
    case 'fused':
      return 'GPS + network';
    case 'ip':
      return 'internet address (rough)';
    default:
      return provider || 'unknown source';
  }
}

// Locate: shows where a paired phone is, on a map with its accuracy, and keeps the newest fix as
// "last seen" (utils/deviceLocation.ts) for when the phone is lost and offline.
const LocateModal: React.FC<LocateModalProps> = ({ deviceId, deviceName, online, onClose }) => {
  useEscapeAndBack(onClose);
  const [fix, setFix] = useState<DeviceFix | null>(() => lastLocation(deviceId));
  const [status, setStatus] = useState<LocateStatus | null>(null);
  const [searching, setSearching] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  // Keeps "2 min ago" current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(
    () =>
      onLocation((id, next, nextStatus) => {
        if (id !== deviceId) return;
        if (next) setFix(lastLocation(deviceId) ?? next);
        if (nextStatus) {
          if (nextStatus !== 'done') setStatus(nextStatus);
          setSearching(false);
        }
      }),
    [deviceId],
  );

  useEffect(() => {
    if (!online) return;
    setStatus(null);
    setSearching(true);
    requestLocation(deviceId)?.catch?.(() => setSearching(false));
    const t = setTimeout(() => setSearching(false), SEARCH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [deviceId, online, attempt]);

  const open = (url: string) => {
    const api = (window as any).link;
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  };

  const copy = async () => {
    if (!fix) return;
    try {
      await navigator.clipboard.writeText(`${fix.latitude.toFixed(6)}, ${fix.longitude.toFixed(6)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the coordinates are on screen to copy by hand.
    }
  };

  const stale = fix && !fix.fresh;

  return (
    <div className="modal" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '92%',
          maxWidth: '520px',
          textAlign: 'left',
          background: 'var(--modal-bg)',
          border: '1px solid var(--border-color)',
          boxShadow: '0 25px 60px var(--modal-shadow)',
          padding: '22px 24px 24px',
          maxHeight: '92vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700, minWidth: 0 }}>
            <MapPin size={18} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Locate {deviceName}</span>
          </div>
          <ModalCloseButton onClose={onClose} />
        </div>

        {fix ? (
          <>
            <div style={{ borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border-color)', height: '260px', background: 'var(--slider-track)' }}>
              <iframe
                key={`${fix.latitude},${fix.longitude},${fix.accuracy}`}
                title={`Map of ${deviceName}`}
                src={embedMapUrl(fix)}
                style={{ width: '100%', height: '100%', border: 'none' }}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </div>
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              <div style={{ fontWeight: 600 }}>
                {stale ? 'Last known position' : 'Current position'} · {formatAccuracy(fix.accuracy)}
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                Taken {ago(fix.time)} by {providerLabel(fix.provider)}
                {fix.speed !== undefined && fix.speed > 1 ? ` · moving ${Math.round(fix.speed * 3.6)} km/h` : ''}
              </div>
              <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)', fontSize: '12px' }}>
                {fix.latitude.toFixed(6)}, {fix.longitude.toFixed(6)}
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: '28px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', border: '1px dashed var(--border-color)', borderRadius: '10px' }}>
            {online ? (searching ? 'Asking for its position…' : 'No position received.') : `No position is known for ${deviceName} yet.`}
          </div>
        )}

        {searching && fix && (
          <div style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--text-muted)' }} className="testing-pulse">
            Getting a more precise fix…
          </div>
        )}
        {status && status !== 'done' && (
          <div style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '12.5px', lineHeight: 1.45 }}>
            {STATUS_TEXT[status]}
          </div>
        )}
        {!online && (
          <div style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
            {deviceName} is offline. Its position updates again when it reconnects over your network or Tailscale.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px', marginTop: '16px' }}>
          <button onClick={() => setAttempt((a) => a + 1)} disabled={!online || searching} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => fix && open(mapsUrl(fix))} disabled={!fix} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <ExternalLink size={14} /> Maps
          </button>
          <button onClick={copy} disabled={!fix} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LocateModal;
