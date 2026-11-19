import React, { useRef, useEffect, useState, MutableRefObject } from 'react';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// App.tsx subscribes to presenter positions (it also decides when this overlay opens) and forwards
// each move or stop through this ref.
export type PresenterMoveHandler = (dx: number, dy: number, stop: boolean) => void;

// Matches HIDE_AFTER in src-tauri/src/core/presenter.rs: the dot hides shortly after motion stops
// and reappears on the next move.
const PRESENTER_HIDE_DELAY_MS = 500;

interface PresenterDotOverlayProps {
  moveHandlerRef: MutableRefObject<PresenterMoveHandler | null>;
  onClose: () => void;
}

// Android's in-app fallback dot (when Link may not draw over other apps): a bare dot with no chrome.
// The desktop draws its own in a native click-through window (core/presenter.rs); here the dot
// renders in the app's WebView with pointerEvents:'none' so it never blocks touches.
const PresenterDotOverlay: React.FC<PresenterDotOverlayProps> = ({ moveHandlerRef, onClose }) => {
  const posRef = useRef({ x: 0.5, y: 0.5 });
  const dotRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [aspectRatio] = useState(() => window.innerWidth / window.innerHeight);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    moveHandlerRef.current = (dx: number, dy: number, stop: boolean) => {
      if (stop) {
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
        onClose();
        return;
      }
      posRef.current = {
        x: clamp01(posRef.current.x + dx),
        y: clamp01(posRef.current.y + dy * aspectRatio),
      };
      if (dotRef.current) {
        // Percentages of the full-screen layer, so the TV layout's zoom (index.css) cannot offset the dot.
        dotRef.current.style.left = `${posRef.current.x * 100}%`;
        dotRef.current.style.top = `${posRef.current.y * 100}%`;
      }
      setVisible(true);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = setTimeout(onClose, PRESENTER_HIDE_DELAY_MS);
    };
    return () => {
      moveHandlerRef.current = null;
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [aspectRatio, onClose, moveHandlerRef]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'transparent',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    >
      <div
        ref={dotRef}
        style={{
          position: 'absolute',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: 'rgba(255, 0, 0, 0.85)',
          boxShadow: '0 0 8px 2px rgba(255, 0, 0, 0.5)',
          transform: 'translate(-50%, -50%)',
          left: '50%',
          top: '50%',
        }}
      />
    </div>
  );
};

export default PresenterDotOverlay;
