import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

const linkApi = (window as any).link;

// Shared PIN Display Box for 100% visual uniformity across all dialogs
export const PinDisplayBox: React.FC<{ pin: string; label?: string }> = ({ pin, label = 'VERIFICATION PIN' }) => (
  <div
    style={{
      background: 'var(--input-bg, rgba(0, 0, 0, 0.03))',
      border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
      borderRadius: '8px',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      boxSizing: 'border-box',
    }}
  >
    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
      {label}
    </div>
    <div style={{ fontSize: '32px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--accent-color)', letterSpacing: '4px' }}>
      {pin}
    </div>
  </div>
);

export interface ModalDialogProps {
  type?: 'info' | 'confirm' | 'pin' | 'speed-test';
  title: string;
  message?: string;
  pin?: string;
  speedTestResults?: {
    latencyMs: number;
    uploadSpeedMbps: number;
    downloadSpeedMbps: number;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

const ModalDialog: React.FC<ModalDialogProps> = ({
  type = 'info',
  title,
  message,
  pin,
  speedTestResults,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  isDestructive = false,
  onConfirm,
  onCancel,
}) => {
  return (
    <div
      className="popup-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 25000,
        animation: 'fadeIn 0.2s ease-out',
      }}
      onClick={onCancel || onConfirm}
    >
      <div
        className="card"
        style={{
          width: '90%',
          maxWidth: '380px',
          background: '#16161b',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.55)',
          borderRadius: '12px',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          textAlign: 'center',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-color)' }}>
          {title}
        </div>

        {message && (
          <div style={{ fontSize: '13.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {message}
          </div>
        )}

        {/* PIN Display using shared PinDisplayBox */}
        {type === 'pin' && pin && (
          <PinDisplayBox pin={pin} label="CONFIRM PIN MATCHES TARGET SCREEN" />
        )}

        {/* Speed Test Results Grid */}
        {type === 'speed-test' && speedTestResults && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '10px',
              padding: '14px 8px',
              borderRadius: '8px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.5px' }}>LATENCY</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-color)' }}>
                {speedTestResults.latencyMs} <span style={{ fontSize: '11px', fontWeight: 400 }}>ms</span>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.5px' }}>UPLOAD</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: '#10b981' }}>
                {speedTestResults.uploadSpeedMbps} <span style={{ fontSize: '11px', fontWeight: 400 }}>Mbps</span>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.5px' }}>DOWNLOAD</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: '#3b82f6' }}>
                {speedTestResults.downloadSpeedMbps} <span style={{ fontSize: '11px', fontWeight: 400 }}>Mbps</span>
              </span>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', marginTop: '6px' }}>
          {onCancel && (
            <button
              onClick={onCancel}
              style={{
                flex: 1,
                padding: '10px 16px',
                fontSize: '13px',
                background: 'transparent',
                border: '1px solid var(--border-color)',
                color: 'var(--text-color)',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: '10px 16px',
              fontSize: '13px',
              background: isDestructive ? '#ef4444' : 'var(--accent-color)',
              border: 'none',
              color: isDestructive ? '#ffffff' : 'var(--btn-primary-text)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModalDialog;

// ----- QR Scanner Modal -----

interface ScannerModalProps {
  open: boolean;
  onClose: () => void;
  onDecoded: (host: string) => void;
  title?: string;
}

function extractHost(raw: string): string {
  let host = raw.trim();
  if (host.startsWith('link:')) {
    const parts = host.split(':');
    if (parts.length >= 2) host = parts[1];
  } else if (host.startsWith('http://') || host.startsWith('https://')) {
    try {
      const url = new URL(host);
      host = url.hostname;
    } catch (e) {
      let cleaned = host.replace(/^(https?:\/\/)?/, '');
      cleaned = cleaned.split('/')[0];
      cleaned = cleaned.split(':')[0];
      host = cleaned;
    }
  }
  if (host.includes(',')) host = host.split(',')[0].trim();
  return host;
}

export const ScannerModal: React.FC<ScannerModalProps> = ({ open, onClose, onDecoded, title = 'Scan QR Code' }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [cameraReady, setCameraReady] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const start = async () => {
      if (linkApi?.isMobile) {
        const requestFn = linkApi.requestPermissions || linkApi.requestMobilePermission;
        if (requestFn) {
          try {
            await requestFn('camera');
          } catch (err) {
            console.error('Failed to request Capacitor camera permission:', err);
          }
        }
      }

      setCameraReady(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.play();
        }

        scanIntervalRef.current = setInterval(() => {
          if (!videoRef.current || !canvasRef.current) return;
          const video = videoRef.current;
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            const maxDim = 400;
            let w = video.videoWidth;
            let h = video.videoHeight;
            if (w > maxDim || h > maxDim) {
              if (w > h) {
                h = Math.round((h * maxDim) / w);
                w = maxDim;
              } else {
                w = Math.round((w * maxDim) / h);
                h = maxDim;
              }
            }
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert',
            });
            if (code) {
              const host = extractHost(code.data);
              if (host) onDecoded(host);
            }
          }
        }, 100);
      } catch (err: any) {
        console.error('Failed to access camera:', err);
        alert('Could not access camera: ' + err.message);
        onClose();
      }
    };

    start();

    return () => {
      cancelled = true;
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      setCameraReady(false);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="popup-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 30000,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: '90%',
          maxWidth: '400px',
          padding: '24px',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
          background: '#16161b',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 20px 48px rgba(0,0,0,0.55)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: '15px', color: '#f2f2f5' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#9a9aa3', fontSize: '16px', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#000', borderRadius: '8px', overflow: 'hidden' }}>
          <style>{`
            @keyframes qrScanLaser {
              0% { top: 0%; }
              50% { top: 100%; }
              100% { top: 0%; }
            }
          `}</style>
          {!cameraReady && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              Initializing camera...
            </div>
          )}
          <video
            ref={videoRef}
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: cameraReady ? 1 : 0, transition: 'opacity 0.2s ease' }}
            onPlay={() => setCameraReady(true)}
            muted
            playsInline
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '200px',
            height: '200px',
            border: '2px solid var(--accent-color)',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
            pointerEvents: 'none',
            overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: '2px',
              background: 'var(--accent-gradient, #3b82f6)',
              boxShadow: '0 0 8px var(--accent-color, #3b82f6)',
              animation: 'qrScanLaser 2s infinite linear',
            }} />
          </div>
        </div>

        <div style={{ fontSize: '11.5px', color: '#9a9aa3' }}>
          Align the target device's QR code within the scanning frame.
        </div>
      </div>
    </div>
  );
};

// ----- IP address field with an embedded scan button -----

interface IpScanFieldProps {
  value: string;
  onChange: (v: string) => void;
  onScanClick?: () => void;
  onEnter?: () => void;
  placeholder?: string;
  style?: React.CSSProperties;
}

export const IpScanField: React.FC<IpScanFieldProps> = ({ value, onChange, onScanClick, onEnter, placeholder = "Friend's IP address", style }) => (
  <div style={{ position: 'relative', width: '100%', boxSizing: 'border-box', ...style }}>
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEnter ? (e) => { if (e.key === 'Enter') onEnter(); } : undefined}
      style={{
        width: '100%',
        padding: onScanClick ? '10px 44px 10px 14px' : '10px 14px',
        borderRadius: '8px',
        border: '1px solid var(--border-color)',
        background: 'var(--input-bg)',
        color: 'var(--text-color)',
        fontSize: '13px',
        outline: 'none',
        boxSizing: 'border-box',
      }}
    />
    {onScanClick && (
      <button
        onClick={onScanClick}
        title="Scan QR Code"
        aria-label="Scan QR code"
        style={{
          position: 'absolute',
          top: '50%',
          right: '6px',
          transform: 'translateY(-50%)',
          width: '30px',
          height: '30px',
          padding: 0,
          borderRadius: '6px',
          border: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>
    )}
  </div>
);

// ----- Pending guest connection request card -----

interface PendingGuestLike {
  connId: string;
  pin: string;
  remoteAddress: string;
  deviceName?: string;
}

interface PendingGuestCardProps {
  guest: PendingGuestLike;
  onAccept: () => void;
  onReject: () => void;
  onBlock?: () => void;
  title?: string;
  subtitle?: string;
}

export const PendingGuestCard: React.FC<PendingGuestCardProps> = ({ guest, onAccept, onReject, onBlock, title = 'Connection Request', subtitle }) => (
  <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <div style={{
        width: '40px',
        height: '40px',
        borderRadius: '50%',
        background: 'rgba(0, 122, 204, 0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--accent-color)',
      }}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '16px', fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {subtitle
            ? `${guest.deviceName || 'Guest'} ${subtitle} (${guest.remoteAddress.replace(/^::ffff:/, '')})`
            : `From ${guest.deviceName || 'Guest'} (${guest.remoteAddress.replace(/^::ffff:/, '')})`}
        </div>
      </div>
    </div>

    {/* Shared Uniform PIN Box */}
    <PinDisplayBox pin={guest.pin} />

    <div style={{ display: 'flex', gap: '8px' }}>
      <button
        onClick={onReject}
        style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-color)', cursor: 'pointer', fontWeight: 600 }}
      >
        Reject
      </button>
      <button
        onClick={onAccept}
        style={{ flex: 1, padding: '10px', borderRadius: '6px', border: 'none', background: 'var(--accent-color)', color: 'var(--btn-primary-text)', cursor: 'pointer', fontWeight: 700 }}
      >
        Accept
      </button>
      {onBlock && (
        <button
          onClick={onBlock}
          title="Reject and block this IP from future requests"
          style={{ padding: '10px 14px', borderRadius: '6px', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
        >
          Block
        </button>
      )}
    </div>
  </div>
);

// ----- Outbound connecting / waiting-for-PIN card -----

interface ConnectingCardProps {
  targetLabel: string;
  phase: 'connecting' | 'waiting-pin' | string;
  pin?: string | null;
  onCancel: () => void;
  waitingLabel?: string;
}

export const ConnectingCard: React.FC<ConnectingCardProps> = ({ targetLabel, phase, pin, onCancel, waitingLabel = 'Waiting for connection request to be accepted...' }) => (
  <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center' }}>
    <div style={{ fontSize: '15px', fontWeight: 600, overflowWrap: 'anywhere' }}>Connecting to {targetLabel}...</div>

    {phase === 'waiting-pin' && pin ? (
      <>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Verify that this PIN matches the one displayed on the receiving device:
        </div>
        <PinDisplayBox pin={pin} />
      </>
    ) : (
      <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{waitingLabel}</div>
    )}

    <button
      onClick={onCancel}
      style={{
        padding: '8px 16px',
        borderRadius: '6px',
        border: '1px solid var(--border-color)',
        background: 'transparent',
        color: 'var(--text-color)',
        cursor: 'pointer',
        fontWeight: 600,
      }}
    >
      Cancel
    </button>
  </div>
);
