import React, { useEffect, useRef, useState } from 'react';
import { cameraManager, useCameraManager } from '../utils/cameraManager';

interface CameraViewerProps {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}

const PREVIEW_W = 480;
const PREVIEW_H = 270;

// Settings and live preview for the phone's camera as other programs see it (its name in other programs comes from the manager).
// The preview is a downscaled copy of the picture Rust sends to the virtual camera, so mirror, fit and
// zoom here are exactly what a meeting app gets. The connection lives in the camera manager and is
// shared with the virtual webcam: closing this panel never interrupts a program that is using it.
const CameraViewer: React.FC<CameraViewerProps> = ({ deviceId, deviceName, onClose }) => {
  const snap = useCameraManager();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The app's title bar sits above everything, so start below it.
  const [topInset, setTopInset] = useState(0);

  useEffect(() => {
    const measure = () => {
      const bar = document.querySelector('.desktop-titlebar') as HTMLElement | null;
      setTopInset(bar ? Math.round(bar.getBoundingClientRect().bottom) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    cameraManager.acquire('preview', deviceId);
    return () => cameraManager.release('preview');
  }, [deviceId]);

  // The manager may still be on another phone for a moment after this panel opens.
  const mine = snap.deviceId === deviceId;
  const phase = mine ? snap.phase : 'connecting';
  const cfg = snap.config;

  // Preview: while live, ask Rust for its newest picture (already placed with the current settings).
  // Polling is what makes Rust produce it, so nothing is encoded once the panel closes.
  const live = phase === 'live';
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    const tick = async () => {
      try {
        const data = await (window as any).link?.cameraPreviewFrame?.(seq);
        if (data && data.byteLength > 8 && !stopped) {
          seq = Number(new DataView(data).getBigUint64(0, true));
          const bitmap = await createImageBitmap(new Blob([data.slice(8)], { type: 'image/jpeg' }));
          if (!stopped) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
        }
      } catch {
        /* a missed picture is simply replaced by the next one */
      }
      if (!stopped) timer = setTimeout(tick, 50);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [live]);

  const message =
    phase === 'denied'
      ? `${deviceName} didn't allow camera access. On the phone, open this PC's permissions and turn on "Allow Camera as Webcam".`
      : phase === 'ended'
        ? `${deviceName} stopped sharing its camera.`
        : 'Waiting for the phone camera…';

  const btn: React.CSSProperties = { padding: '6px 12px', fontSize: '12.5px' };
  const segment = (active: boolean): React.CSSProperties => ({
    ...btn,
    fontWeight: 600,
    color: active ? '#10b981' : undefined,
    borderColor: active ? '#10b981' : undefined,
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        top: topInset,
        zIndex: 9999,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          background: 'var(--modal-bg, #0c0c0e)',
          color: 'var(--text-color, #fff)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: '14px', flex: 1 }}>
          {deviceName} · Camera
          <span style={{ marginLeft: '10px', fontWeight: 500, fontSize: '12px', color: live ? '#10b981' : '#f59e0b' }}>
            {live ? 'Live' : phase === 'connecting' ? 'Connecting…' : ''}
          </span>
        </div>
        {(phase === 'ended' || phase === 'denied') && (
          <button onClick={() => cameraManager.retry()} style={btn}>
            Try again
          </button>
        )}
        <button onClick={onClose} style={btn}>
          Close
        </button>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <canvas
          ref={canvasRef}
          width={PREVIEW_W}
          height={PREVIEW_H}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
        />
        {!live && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: '24px',
              color: 'var(--text-muted, #9aa)',
              fontSize: '13px',
            }}
          >
            {message}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          flexWrap: 'wrap',
          padding: '10px 14px',
          borderTop: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          background: 'var(--modal-bg, #0c0c0e)',
          color: 'var(--text-color, #fff)',
          fontSize: '12.5px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 260px', minWidth: '220px' }}>
          <span style={{ fontWeight: 600 }}>Zoom</span>
          <input
            type="range"
            min={snap.zoomMin}
            max={snap.zoomMax}
            step={0.1}
            value={cfg.zoom}
            onChange={(e) => cameraManager.setConfig({ zoom: parseFloat(e.target.value) })}
            style={{ flex: 1 }}
            aria-label="Zoom"
          />
          <span style={{ width: '42px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{cfg.zoom.toFixed(1)}×</span>
        </div>

        {snap.hasFront && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => cameraManager.setConfig({ front: false })} style={segment(!cfg.front)}>
              Back
            </button>
            <button onClick={() => cameraManager.setConfig({ front: true })} style={segment(cfg.front)}>
              Front
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => cameraManager.setConfig({ fill: false })} style={segment(!cfg.fill)} title="Show the whole picture, with bars if its shape differs">
            Fit
          </button>
          <button onClick={() => cameraManager.setConfig({ fill: true })} style={segment(cfg.fill)} title="Fill the frame, cropping the edges">
            Fill
          </button>
        </div>

        <button onClick={() => cameraManager.setConfig({ mirror: !cfg.mirror })} style={segment(cfg.mirror)}>
          Mirror
        </button>
        <button onClick={() => cameraManager.resetConfig()} style={btn}>
          Reset
        </button>
      </div>

      <div
        style={{
          padding: '6px 14px 10px',
          fontSize: '11.5px',
          background: 'var(--modal-bg, #0c0c0e)',
          color: snap.virtualError ? '#ef4444' : 'var(--text-muted, #9aa)',
        }}
      >
        {snap.virtualError ||
          (snap.supported
            ? snap.virtualEnabled
              ? `These settings apply to the camera named "${snap.cameraName}" in Zoom, Chrome, Teams and other programs. The phone camera only turns on while a program is using it.`
              : 'The virtual webcam is off. Turn on "Phone as virtual webcam" in Settings to use these settings in other programs.'
            : 'The virtual webcam is not available on this PC, so this is a preview only.')}
      </div>
    </div>
  );
};

export default CameraViewer;
