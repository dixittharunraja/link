import React, { useEffect, useRef, useState } from 'react';
import type jsQRFn from 'jsqr';
import { useEscapeAndBack } from '../hooks/useEscapeAndBack';
import { LinkApi } from '../vite-env';
import { parseToolQr } from '../utils/qr';
import { IS_TV } from '../utils/platform';

const linkApi = (window as any).link as LinkApi;

// jsQR is the fallback decoder for webviews without BarcodeDetector, so it is loaded only when a scanner needs it.
let jsQRModule: Promise<typeof jsQRFn> | null = null;
function loadJsQR(): Promise<typeof jsQRFn> {
  jsQRModule ??= import('jsqr').then((m) => (m as { default?: typeof jsQRFn }).default ?? (m as unknown as typeof jsQRFn)).catch((err) => {
    jsQRModule = null; // let the next frame retry
    throw err;
  });
  return jsQRModule;
}

// PIN box shared by every dialog that shows a pairing or guest PIN.
const PinDisplayBox: React.FC<{ pin: string; label?: string }> = ({ pin, label = 'VERIFICATION PIN' }) => (
  <div
    style={{
      background: 'var(--input-bg)',
      border: '1px solid var(--border-color)',
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
  // Optional so a dialog can offer only Cancel (e.g. a pairing PIN, which completes on its own).
  onConfirm?: () => void;
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
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Escape and Android back close the dialog.
  useEscapeAndBack(onCancel || onConfirm);

  return (
    <div
      className="popup-overlay"
      onClick={onCancel || onConfirm}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-dialog-title"
    >
      <div
        ref={dialogRef}
        className="card modal-dialog-card"
        style={{
          width: '90%',
          maxWidth: '420px',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="modal-dialog-title" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-color)' }}>
          {title}
        </div>

        {message && (
          <div style={{ fontSize: '13.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {message}
          </div>
        )}

        {type === 'pin' && pin && (
          <PinDisplayBox pin={pin} label="CONFIRM PIN MATCHES TARGET SCREEN" />
        )}

        {/* Speed test results */}
        {type === 'speed-test' && speedTestResults && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '10px',
              padding: '14px 8px',
              borderRadius: '8px',
              background: 'var(--input-bg)',
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
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--active-dot)' }}>
                {speedTestResults.uploadSpeedMbps} <span style={{ fontSize: '11px', fontWeight: 400 }}>Mbps</span>
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.5px' }}>DOWNLOAD</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--accent-blue)' }}>
                {speedTestResults.downloadSpeedMbps} <span style={{ fontSize: '11px', fontWeight: 400 }}>Mbps</span>
              </span>
            </div>
          </div>
        )}

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
          {onConfirm && (
            <button
              onClick={onConfirm}
              style={{
                flex: 1,
                padding: '10px 16px',
                fontSize: '13px',
                background: isDestructive ? 'var(--inactive-dot)' : 'var(--accent-color)',
                border: 'none',
                color: 'var(--btn-primary-text)',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              {confirmLabel}
            </button>
          )}
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
  // A pairing code is read whole: its fingerprint and token matter as much as the address.
  if (host.startsWith('linkpair:')) return host;
  if (host.startsWith('link:')) {
    // A tool's code carries the host's key fingerprint and a one-time token. They are handed to the native
    // side, which checks the fingerprint and presents the token when it connects to the host's addresses.
    const verified = parseToolQr(host);
    if (verified) {
      void linkApi?.rememberGuestScan?.(verified.addresses, verified.fingerprint, verified.token);
      return verified.addresses;
    }
    const parts = host.split(':');
    if (parts.length >= 2) host = parts[1];
  } else if (host.startsWith('http://') || host.startsWith('https://')) {
    try {
      const url = new URL(host);
      host = url.hostname;
    } catch {
      let cleaned = host.replace(/^(https?:\/\/)?/, '');
      cleaned = cleaned.split('/')[0];
      cleaned = cleaned.split(':')[0];
      host = cleaned;
    }
  }
  return host;
}

// Cameras that are software, not a lens: this app's own "Link Virtual Camera", OBS and the usual phone-as-webcam apps.
const VIRTUAL_CAMERA = /virtual|\bobs\b|droidcam|iriun|epoccam|ivcam|manycam|xsplit|snap camera|nvidia broadcast|softcam/i;

/** The id of a real camera, or null when none can be told apart yet (names are hidden until camera access is granted). */
async function pickPhysicalCamera(): Promise<string | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === 'videoinput' && d.label);
    return cameras.find((d) => !VIRTUAL_CAMERA.test(d.label))?.deviceId ?? null;
  } catch {
    return null;
  }
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
            console.error('Failed to request camera permission:', err);
          }
        }
      }

      setCameraReady(false);
      try {
        // The default is often 640x480, too coarse for a dense pairing code. Ask for 720p and
        // continuous autofocus (ignored where unsupported).
        const openCamera = (deviceId: string | null) =>
          navigator.mediaDevices.getUserMedia({
            video: {
              ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
              width: { ideal: 1280 },
              height: { ideal: 720 },
              advanced: [{ focusMode: 'continuous' }],
            } as unknown as MediaTrackConstraints,
          });

        // On a PC the "default" camera can be a virtual one, such as this app's phone-as-webcam, which
        // shows the phone's picture and switches the phone's camera on. Choose a real camera instead.
        // Device names are only readable once the camera has been allowed, so this is checked up front
        // (no camera opened) and again after the first open for a first run.
        const desktop = !linkApi?.isMobile;
        const physicalId = desktop ? await pickPhysicalCamera() : null;
        let stream = await openCamera(physicalId);
        if (desktop && !physicalId && VIRTUAL_CAMERA.test(stream.getVideoTracks()[0]?.label ?? '')) {
          const realId = await pickPhysicalCamera();
          if (realId) {
            stream.getTracks().forEach((t) => t.stop());
            stream = await openCamera(realId);
          }
        }
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

        // The native BarcodeDetector (hardware-assisted, far more tolerant of blur and angle) where the
        // webview has it; jsQR otherwise. Frames are scanned one at a time, never overlapping.
        const Detector = (window as any).BarcodeDetector;
        let detector: any = null;
        try {
          detector = Detector ? new Detector({ formats: ['qr_code'] }) : null;
        } catch {
          detector = null;
        }
        // Start fetching the fallback decoder now so the first frames are not held up by it.
        if (!detector) void loadJsQR().catch(() => {});
        let decoded = false;
        // Some devices have BarcodeDetector but never find anything with it (its model is missing or not
        // downloaded yet), and it does not say so. After this many empty frames jsQR takes every other one.
        const DETECTOR_GRACE_FRAMES = 30;
        let emptyDetections = 0;
        const tick = async () => {
          if (cancelled || decoded) return;
          try {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
              let text: string | null = null;
              const useDetector = detector && (emptyDetections < DETECTOR_GRACE_FRAMES || emptyDetections % 2 === 0);
              if (useDetector) {
                try {
                  const found = await detector.detect(video);
                  text = found[0]?.rawValue ?? null;
                } catch {
                  detector = null; // unsupported here: use jsQR from the next frame on
                }
                emptyDetections++;
              } else {
                if (detector) emptyDetections++;
                const jsQR = await loadJsQR();
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx && !cancelled) {
                  // Shrinking to 400px made the modules of a long code about a pixel wide.
                  const maxDim = 960;
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
                  text = code ? code.data : null;
                }
              }
              if (text) {
                const host = extractHost(text);
                if (host && !cancelled && !decoded) {
                  decoded = true;
                  onDecoded(host);
                  return;
                }
              }
            }
          } catch (err) {
            console.error('QR scan frame failed:', err);
          }
          if (!cancelled && !decoded) scanIntervalRef.current = setTimeout(tick, 40);
        };
        scanIntervalRef.current = setTimeout(tick, 40);
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

  useEscapeAndBack(onClose, open);

  if (!open) return null;

  return (
    <div
      className="popup-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="scanner-modal-title"
    >
      <div
        className="card modal-dialog-card"
        style={{ maxWidth: '400px', zIndex: 30000 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <span id="scanner-modal-title" style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text-color)' }}>{title}</span>
          <button onClick={onClose} aria-label="Close scanner" style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer' }}>✕</button>
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

export const IpScanField: React.FC<IpScanFieldProps> = ({ value, onChange, onScanClick: scanHandler, onEnter, placeholder = "Friend's IP address", style }) => {
  // A TV has no camera to scan with, so the scan button is not offered there.
  const onScanClick = IS_TV ? undefined : scanHandler;
  return (
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
};

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
  acceptLabel?: string;
  iconType?: 'trust' | 'audio' | 'mic' | 'portal' | 'input' | 'presenter' | 'walkie' | 'joystick' | 'default';
}

export const PendingGuestCard: React.FC<PendingGuestCardProps> = ({
  guest,
  onAccept,
  onReject,
  onBlock,
  title = 'Connection Request',
  subtitle,
  acceptLabel = 'Accept',
  iconType = 'default',
}) => {
  const renderIcon = () => {
    switch (iconType) {
      case 'trust':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        );
      case 'joystick':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="6" width="20" height="12" rx="6" />
            <path d="M6 12h4m-2-2v4" />
            <circle cx="15" cy="11" r="1" fill="currentColor" />
            <circle cx="18" cy="13" r="1" fill="currentColor" />
          </svg>
        );
      case 'audio':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
          </svg>
        );
      case 'mic':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        );
      case 'portal':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        );
      case 'presenter':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        );
      case 'input':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="4" />
            <line x1="12" y1="6" x2="12" y2="10" />
          </svg>
        );
      case 'walkie':
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
            <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
            <circle cx="12" cy="12" r="2" />
            <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
            <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19.1" />
          </svg>
        );
      default:
        return (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
          </svg>
        );
    }
  };

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          background: 'rgba(0, 122, 204, 0.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent-color)',
          flexShrink: 0,
        }}>
          {renderIcon()}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-color)' }}>{title}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
            {subtitle
              ? `${guest.deviceName || 'Guest'} ${subtitle} (${guest.remoteAddress.replace(/^::ffff:/, '')})`
              : `From ${guest.deviceName || 'Guest'} (${guest.remoteAddress.replace(/^::ffff:/, '')})`}
          </div>
        </div>
      </div>

      {guest.pin ? (
        <PinDisplayBox pin={guest.pin} />
      ) : (
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          This device scanned the QR code on your screen. Accept only if you know it.
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={onReject}
          style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-color)', cursor: 'pointer', fontWeight: 600 }}
        >
          Reject
        </button>
        <button
          onClick={onAccept}
          style={{ flex: 1.4, padding: '10px', borderRadius: '6px', border: 'none', background: 'var(--accent-color)', color: 'var(--btn-primary-text)', cursor: 'pointer', fontWeight: 700 }}
        >
          {acceptLabel}
        </button>
        {onBlock && (
          <button
            onClick={onBlock}
            title="Reject and block this IP from future requests"
            style={{ padding: '10px 14px', borderRadius: '6px', border: 'none', background: 'var(--inactive-dot)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
          >
            Block
          </button>
        )}
      </div>
    </div>
  );
};

export interface PendingGuestsModalProps {
  guests: PendingGuestLike[];
  subtitle?: string;
  title?: string;
  acceptLabel?: string;
  iconType?: 'trust' | 'audio' | 'mic' | 'portal' | 'input' | 'presenter' | 'walkie' | 'joystick' | 'default';
  onAccept: (connId: string) => void;
  onReject: (connId: string) => void;
  onBlock?: (connId: string) => void;
}

export const PendingGuestsModal: React.FC<PendingGuestsModalProps> = ({
  guests,
  subtitle,
  title,
  acceptLabel,
  iconType,
  onAccept,
  onReject,
  onBlock,
}) => {
  if (!guests || guests.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div style={{ width: '100%', maxWidth: '380px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {guests.map((g) => (
          <div
            key={g.connId}
            style={{
              backgroundColor: 'var(--modal-bg)',
              border: '1px solid var(--border-color)',
              borderRadius: '16px',
              boxShadow: '0 20px 50px var(--modal-shadow)',
            }}
          >
            <PendingGuestCard
              guest={g}
              title={title}
              subtitle={subtitle}
              acceptLabel={acceptLabel}
              iconType={iconType}
              onAccept={() => onAccept(g.connId)}
              onReject={() => onReject(g.connId)}
              onBlock={onBlock ? () => onBlock(g.connId) : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export const PrimaryButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ onClick, disabled, children, style }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      width: '100%',
      padding: '10px',
      borderRadius: '8px',
      background: !disabled ? 'var(--accent-color, #007acc)' : 'var(--input-bg)',
      color: !disabled ? 'var(--btn-primary-text)' : 'var(--text-muted)',
      border: !disabled ? 'none' : '1px solid var(--border-color)',
      fontWeight: 600,
      cursor: !disabled ? 'pointer' : 'not-allowed',
      boxSizing: 'border-box',
      ...style,
    }}
  >
    {children}
  </button>
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
