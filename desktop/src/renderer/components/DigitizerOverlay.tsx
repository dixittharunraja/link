import React, { useRef, useEffect } from 'react';

interface DigitizerOverlayProps {
  deviceId: string;
  onClose: () => void;
}

const DigitizerOverlay: React.FC<DigitizerOverlayProps> = ({ deviceId, onClose }) => {
  const linkApi = (window as any).link;
  const canvasRef = useRef<HTMLDivElement>(null);
  const touching = useRef<boolean>(false);
  const lastPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    if (!linkApi) return;

    // Start Session with dimensions (swapped for landscape hold)
    const logWidth = window.innerHeight;
    const logHeight = window.innerWidth;

    linkApi.sendDigitizerSession(deviceId, 'start', logWidth, logHeight)
      .catch((err: any) => console.error('Digitizer session start failed:', err));

    return () => {
      linkApi.sendDigitizerSession(deviceId, 'end', logWidth, logHeight)
        .catch(() => {});
    };
  }, [deviceId, linkApi]);

  const sendAction = (action: 'undo' | 'redo') => {
    linkApi?.sendDigitizerAction?.(deviceId, action);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1 && linkApi) {
      touching.current = true;
      const t = e.touches[0];
      // Swapped axes landscape
      const lx = Math.round(t.clientY);
      const ly = Math.round(window.innerWidth - t.clientX);
      lastPos.current = { x: lx, y: ly };

      linkApi.sendDigitizerEvent(deviceId, {
        x: lx,
        y: ly,
        touching: true,
        active: true,
        pressure: 1.0,
        tool: 'Pen'
      });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1 && touching.current && linkApi) {
      const t = e.touches[0];
      const lx = Math.round(t.clientY);
      const ly = Math.round(window.innerWidth - t.clientX);
      lastPos.current = { x: lx, y: ly };

      linkApi.sendDigitizerEvent(deviceId, {
        x: lx,
        y: ly,
        touching: true,
        active: true,
        pressure: 1.0,
        tool: 'Pen'
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    if (touching.current && linkApi) {
      touching.current = false;
      // Resend last known position so cursor stays put
      linkApi.sendDigitizerEvent(deviceId, {
        x: lastPos.current.x,
        y: lastPos.current.y,
        touching: false,
        active: true
      });
    }
  };

  return (
    <div
      id="digitizerSurface"
      className="landscape-overlay"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{ display: 'flex', touchAction: 'none', color: '#fff', boxSizing: 'border-box', padding: '16px', flexDirection: 'column', height: '100vw', width: '100vh' }}
    >
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 'bold', marginBottom: '10px' }}>
        Digitizer
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
        Draw on the screen below to position the cursor.
      </div>
      <div
        ref={canvasRef}
        id="digitizerCanvas"
        style={{ flex: 1, border: '1.5px dashed var(--border-color)', borderRadius: '12px', background: 'rgba(255,255,255,0.01)', position: 'relative' }}
      ></div>

      {/* Bottom controls — stopPropagation so tapping a button never registers as a pen stroke. */}
      <div style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px', paddingTop: '16px' }}>
        <button
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); sendAction('undo'); }}
          style={{ padding: '14px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' }}
        >
          Undo
        </button>
        <button
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); sendAction('redo'); }}
          style={{ padding: '14px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' }}
        >
          Redo
        </button>
        <button
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); linkApi?.cycleTargetDisplay?.(deviceId); }}
          style={{ padding: '14px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' }}
        >
          Screen ⇆
        </button>
        <button
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
          style={{ padding: '14px 4px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold' }}
        >
          Exit
        </button>
      </div>
    </div>
  );
};

export default DigitizerOverlay;
