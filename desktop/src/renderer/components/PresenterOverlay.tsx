import React, { useRef } from 'react';

interface PresenterOverlayProps {
  deviceId: string;
  onClose: () => void;
}

// Because of the landscape rotation (see .landscape-overlay), the raw horizontal finger delta
// (clientX) ends up driving the dot's VERTICAL movement after the axis swap below — so trimming
// vertical sensitivity means trimming the multiplier applied to clientX specifically, not clientY.
const HORIZONTAL_TOUCH_SCALE = 3.0; // clientY delta -> dot's horizontal movement
const VERTICAL_TOUCH_SCALE = 2.6;   // clientX delta -> dot's vertical movement (slightly reduced)

const PresenterOverlay: React.FC<PresenterOverlayProps> = ({ deviceId, onClose }) => {
  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  const linkApi = (window as any).link;

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    lastTouch.current = { x: t.clientX, y: t.clientY };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!lastTouch.current || !linkApi) return;
    const t = e.touches[0];
    let dx = ((t.clientX - lastTouch.current.x) / window.innerWidth) * VERTICAL_TOUCH_SCALE;
    let dy = ((t.clientY - lastTouch.current.y) / window.innerHeight) * HORIZONTAL_TOUCH_SCALE;
    lastTouch.current = { x: t.clientX, y: t.clientY };

    // Landscape orientation coordinates swap
    const tmp = dx;
    dx = dy;
    dy = -tmp;

    linkApi.sendPresenterMove(deviceId, dx, dy);
  };

  const handleTouchEnd = () => {
    lastTouch.current = null;
  };

  const triggerSpecialKey = (key: number) => {
    if (linkApi) {
      linkApi.sendSpecialKey(deviceId, key);
    }
  };

  return (
    <div id="presenterSurface" className="landscape-overlay" style={{ height: '100vw', width: '100vh' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 'bold', color: '#fff' }}>
        Presenter
      </div>

      <div
        id="presenterDragArea"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          width: '100%',
          flex: 1,
          margin: '16px 0',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: '14px',
          touchAction: 'none',
          textAlign: 'center',
          padding: '16px',
        }}
      >
        Drag here to move the pointer
        <span style={{ fontSize: '11px', color: '#444', marginTop: '6px' }}>(Moves a red dot overlay on the desktop)</span>
      </div>

      <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '8px', marginBottom: '16px' }}>
        <button onClick={() => linkApi?.cycleTargetDisplay?.(deviceId)} style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px' }}>Screen ⇆</button>
        <button onClick={() => triggerSpecialKey(25)} style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px' }}>Fullscreen</button>
        <button onClick={() => triggerSpecialKey(8)} style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}>◀ Prev</button>
        <button onClick={() => triggerSpecialKey(9)} style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}>Next ▶</button>
        <button onClick={() => triggerSpecialKey(14)} style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px' }}>Exit Present</button>
        <button
          onClick={() => {
            if (linkApi) linkApi.sendPresenterStop(deviceId);
            onClose();
          }}
          style={{ padding: '10px 4px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}
        >
          Exit
        </button>
      </div>
    </div>
  );
};

export default PresenterOverlay;
