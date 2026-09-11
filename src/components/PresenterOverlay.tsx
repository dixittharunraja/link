import React, { useRef, useEffect } from 'react';
import { LinkApi } from '../vite-env';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';
import { pushBackHandler } from '../utils/backNav';
import { OverlayExitButton } from './RemoteIcons';

interface PresenterOverlayProps {
  deviceId: string;
  onClose: () => void;
}

// Because of the landscape rotation (see .landscape-overlay / .landscape-overlay-reverse),
// the touch delta scaling matches the visual axis.
const HORIZONTAL_TOUCH_SCALE = 3.0; // visual X scaling
const VERTICAL_TOUCH_SCALE = 2.6;   // visual Y scaling

const PresenterOverlay: React.FC<PresenterOverlayProps> = ({ deviceId, onClose }) => {
  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const linkApi = (window as any).link as LinkApi;
  const { className, transformDelta } = useLandscapeOrientation();

  useEffect(() => {
    return pushBackHandler(() => {
      if (holdTimer.current) clearInterval(holdTimer.current);
      if (linkApi) linkApi.sendPresenterStop(deviceId);
      onClose();
      return true;
    });
  }, [deviceId, linkApi, onClose]);

  useEffect(() => {
    if (!linkApi) return;
    const unsub = linkApi.onInputGuestClosed?.(() => {
      if (holdTimer.current) clearInterval(holdTimer.current);
      onClose();
    });
    return () => {
      unsub?.();
    };
  }, [linkApi, onClose]);

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    lastTouch.current = { x: t.clientX, y: t.clientY };
    if (holdTimer.current) clearInterval(holdTimer.current);
    // While finger is held down, send small keep-alive pings (0,0) every 200ms to keep pointer visible
    holdTimer.current = setInterval(() => {
      if (lastTouch.current && linkApi) {
        linkApi.sendPresenterMove(deviceId, 0, 0);
      }
    }, 200);
    // Send immediate 0,0 ping so the dot shows up at the last position right when touched
    if (linkApi) {
      linkApi.sendPresenterMove(deviceId, 0, 0);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!lastTouch.current || !linkApi) return;
    const t = e.touches[0];
    const rawDx = (t.clientX - lastTouch.current.x) / window.innerWidth;
    const rawDy = (t.clientY - lastTouch.current.y) / window.innerHeight;
    lastTouch.current = { x: t.clientX, y: t.clientY };

    // Dynamic landscape orientation coordinates swap
    const { dx: visDx, dy: visDy } = transformDelta(rawDx, rawDy);
    const finalDx = visDx * HORIZONTAL_TOUCH_SCALE;
    const finalDy = visDy * VERTICAL_TOUCH_SCALE;

    linkApi.sendPresenterMove(deviceId, finalDx, finalDy);
  };

  const handleTouchEnd = () => {
    lastTouch.current = null;
    if (holdTimer.current) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const triggerSpecialKey = (key: number) => {
    if (linkApi) {
      linkApi.sendSpecialKey(deviceId, key);
    }
  };

  return (
    <div id="presenterSurface" className={className} style={{ height: '100vw', width: '100vh' }}>
      <div style={{ width: '100%', fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 'bold', color: '#fff', paddingTop: '0px', paddingLeft: '0px' }}>
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
        <OverlayExitButton
          onClick={() => {
            if (linkApi) linkApi.sendPresenterStop(deviceId);
            onClose();
          }}
        />
      </div>
    </div>
  );
};

export default PresenterOverlay;
