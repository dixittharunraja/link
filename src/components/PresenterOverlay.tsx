import React, { useRef, useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';
import { pushBackHandler } from '../utils/backNav';
import { OverlayCloseButton, ViewModeButton } from './RemoteIcons';
import { IS_ANDROID } from '../utils/platform';

interface PresenterOverlayProps {
  deviceId: string;
  // A phone target gets a portrait surface; anything else (including unknown) is landscape.
  hostDeviceType?: string;
  onClose: () => void;
}

// Scales applied to the visual (post-rotation) axes of a touch delta.
const HORIZONTAL_TOUCH_SCALE = 3.0; // visual X
const VERTICAL_TOUCH_SCALE = 2.6;   // visual Y
const PHONE_VERTICAL_TOUCH_SCALE = 5.5; // visual Y when the target is a phone

const PresenterOverlay: React.FC<PresenterOverlayProps> = ({ deviceId, hostDeviceType, onClose }) => {
  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const linkApi = (window as any).link as LinkApi;
  const isLocalMobile = IS_ANDROID;
  // Starts in the layout that suits the target (landscape for a PC or TV, portrait for a phone); the
  // toggle in the header overrides it.
  const [viewMode, setViewMode] = useState<'portrait' | 'landscape' | null>(null);
  const forceLandscape = isLocalMobile && (viewMode ? viewMode === 'landscape' : hostDeviceType !== 'phone');
  const { className, transformDelta } = useLandscapeOrientation(forceLandscape);

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
    // The host of a paired session ends it by kicking this device (link.input.kicked); there is
    // no socket of our own to watch close.
    const unsubKicked = linkApi.onInputKicked?.((srcId: string) => {
      if (srcId === deviceId) {
        if (holdTimer.current) clearInterval(holdTimer.current);
        onClose();
      }
    });
    return () => {
      unsub?.();
      unsubKicked?.();
    };
  }, [deviceId, linkApi, onClose]);

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    const t = e.touches[0];
    lastTouch.current = { x: t.clientX, y: t.clientY };
    if (holdTimer.current) clearInterval(holdTimer.current);
    // While a finger is down, empty moves every 200ms keep the dot from auto-hiding.
    holdTimer.current = setInterval(() => {
      if (lastTouch.current && linkApi) {
        linkApi.sendPresenterMove(deviceId, 0, 0);
      }
    }, 200);
    // Shows the dot at its last position as soon as the screen is touched.
    if (linkApi) {
      linkApi.sendPresenterMove(deviceId, 0, 0);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    if (!lastTouch.current || !linkApi) return;
    const t = e.touches[0];
    const rawDx = (t.clientX - lastTouch.current.x) / window.innerWidth;
    const rawDy = (t.clientY - lastTouch.current.y) / window.innerHeight;
    lastTouch.current = { x: t.clientX, y: t.clientY };

    // Only a rotated surface needs its touch axes converted.
    const { dx: visDx, dy: visDy } = forceLandscape ? transformDelta(rawDx, rawDy) : { dx: rawDx, dy: rawDy };
    const finalDx = visDx * HORIZONTAL_TOUCH_SCALE;
    // A tall phone host shrinks vertical deltas by its aspect ratio, so it needs a stronger vertical gain.
    const finalDy = visDy * (hostDeviceType === 'phone' ? PHONE_VERTICAL_TOUCH_SCALE : VERTICAL_TOUCH_SCALE);

    linkApi.sendPresenterMove(deviceId, finalDx, finalDy);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    lastTouch.current = null;
    if (holdTimer.current) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
  };

  // Portrait: three buttons on the first row and two on the second, each row filled edge to edge (a
  // six-column grid, spans of 2 then 3). Sideways they sit in a single row.
  const span = (n: number) => (forceLandscape ? undefined : `span ${n}`);

  const triggerSpecialKey = (key: number) => {
    if (linkApi) {
      linkApi.sendSpecialKey(deviceId, key);
    }
  };

  return (
    <div
      id="presenterSurface"
      className={forceLandscape ? className : undefined}
      style={
        forceLandscape
          ? { height: '100vw', width: '100vh' }
          : {
              position: 'fixed',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              padding: 'max(16px, env(safe-area-inset-top, 16px)) max(16px, env(safe-area-inset-right, 16px)) max(16px, env(safe-area-inset-bottom, 16px)) max(16px, env(safe-area-inset-left, 16px))',
              background: 'var(--bg-color)',
              color: 'var(--text-color)',
              fontFamily: 'var(--font-sans)',
              zIndex: 10000,
              overflow: 'hidden',
              overscrollBehavior: 'none',
              touchAction: 'none',
              userSelect: 'none',
            }
      }
    >
      <div style={{ width: '100%', fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 'bold', color: '#fff', paddingTop: '0px', paddingLeft: '0px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Presenter</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isLocalMobile && <ViewModeButton landscape={forceLandscape} onToggle={() => setViewMode(forceLandscape ? 'portrait' : 'landscape')} />}
          <OverlayCloseButton
            onClick={() => {
              if (linkApi) linkApi.sendPresenterStop(deviceId);
              onClose();
            }}
          />
        </div>
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

      <div
        style={{
          width: '100%',
          display: 'grid',
          gridTemplateColumns: forceLandscape ? 'repeat(5, 1fr)' : 'repeat(6, 1fr)',
          gap: '8px',
          marginBottom: '16px',
        }}
      >
        <button onClick={() => linkApi?.cycleTargetDisplay?.(deviceId)} style={{ gridColumn: span(2), padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px' }}>Screen ⇆</button>
        <button onClick={() => triggerSpecialKey(25)} style={{ gridColumn: span(2), padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px' }}>Fullscreen</button>
        <button onClick={() => triggerSpecialKey(14)} style={{ gridColumn: span(2), padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px' }}>Exit Present</button>
        <button onClick={() => triggerSpecialKey(8)} style={{ gridColumn: span(3), padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}>◀ Prev</button>
        <button onClick={() => triggerSpecialKey(9)} style={{ gridColumn: span(3), padding: '10px 4px', background: 'rgba(255,255,255,0.02)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}>Next ▶</button>
      </div>
    </div>
  );
};

export default PresenterOverlay;
