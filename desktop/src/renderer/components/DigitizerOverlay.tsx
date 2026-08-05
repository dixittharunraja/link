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

  const isMobile = typeof (window as any).Capacitor !== 'undefined';

  useEffect(() => {
    if (!linkApi) return;

    // Start Session with a fixed coordinate space (10000x10000)
    // This decouples coordinate resolution from layout measurements/orientation.
    linkApi.sendDigitizerSession(deviceId, 'start', 10000, 10000)
      .catch((err: any) => console.error('Digitizer session start failed:', err));

    return () => {
      linkApi.sendDigitizerSession(deviceId, 'end', 10000, 10000)
        .catch(() => {});
    };
  }, [deviceId, linkApi]);

  const sendAction = (action: 'undo' | 'redo') => {
    linkApi?.sendDigitizerAction?.(deviceId, action);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (linkApi) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      touching.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const rx = Math.max(0, Math.min(1.0, cx / rect.width));
      const ry = Math.max(0, Math.min(1.0, cy / rect.height));

      // Visual Top-Left on rotated mobile is (cx=0, cy=rect.height) -> rx=0, ry=1
      // Visual Bottom-Right is (cx=rect.width, cy=0) -> rx=1, ry=0
      const rx_mapped = isMobile ? ry : rx;
      const ry_mapped = isMobile ? (1.0 - rx) : ry;

      const lx = Math.round(rx_mapped * 10000);
      const ly = Math.round(ry_mapped * 10000);
      lastPos.current = { x: lx, y: ly };

      linkApi.sendDigitizerEvent(deviceId, {
        x: lx,
        y: ly,
        touching: true,
        active: true,
        pressure: e.pressure || 1.0,
        tool: e.pointerType === 'pen' ? 'Pen' : 'Mouse'
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (touching.current && linkApi) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const rx = Math.max(0, Math.min(1.0, cx / rect.width));
      const ry = Math.max(0, Math.min(1.0, cy / rect.height));

      const rx_mapped = isMobile ? ry : rx;
      const ry_mapped = isMobile ? (1.0 - rx) : ry;

      const lx = Math.round(rx_mapped * 10000);
      const ly = Math.round(ry_mapped * 10000);
      lastPos.current = { x: lx, y: ly };

      linkApi.sendDigitizerEvent(deviceId, {
        x: lx,
        y: ly,
        touching: true,
        active: true,
        pressure: e.pressure || 1.0,
        tool: e.pointerType === 'pen' ? 'Pen' : 'Mouse'
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (touching.current && linkApi) {
      touching.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch (err) {}
      
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
      className={isMobile ? "landscape-overlay" : ""}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ display: 'flex', touchAction: 'none', color: '#fff', boxSizing: 'border-box', flexDirection: 'column', height: isMobile ? '100vw' : '100%', width: isMobile ? '100vh' : '100%' }}
    >
      <div style={{ width: '100%', fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 'bold', color: '#fff', paddingTop: '0px', paddingLeft: '0px' }}>
        Digitizer
      </div>

      <div
        ref={canvasRef}
        id="digitizerCanvas"
        style={{
          width: '100%',
          flex: 1,
          margin: '16px 0',
          border: '1.5px dashed var(--border-color)',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.01)',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: '14px',
          textAlign: 'center',
          userSelect: 'none',
        }}
      >
        <span style={{ pointerEvents: 'none' }}>Draw here to position the cursor</span>
        <span style={{ fontSize: '11px', color: '#444', marginTop: '6px', pointerEvents: 'none' }}>(Absolute mapping to target screen)</span>
      </div>

      {/* Bottom controls — stopPropagation so tapping a button never registers as a pen stroke. */}
      <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '16px' }}>
        <button
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); sendAction('undo'); }}
          style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}
        >
          Undo
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); sendAction('redo'); }}
          style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}
        >
          Redo
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); linkApi?.cycleTargetDisplay?.(deviceId); }}
          style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px' }}
        >
          Screen ⇆
        </button>
        <button
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
          style={{ padding: '10px 4px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}
        >
          Exit
        </button>
      </div>
    </div>
  );
};

export default DigitizerOverlay;
