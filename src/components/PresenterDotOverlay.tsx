import React, { useRef, useEffect, useState, MutableRefObject } from 'react';

// Local copy rather than an import from electron/core/plugins/presenter, which is where the
// main-process PresenterPosition keeps its own. Two reasons: /src is the platform-neutral app
// shared by the desktop and Android builds, so reaching into the Electron tree would reintroduce exactly
// the coupling the single-root layout removes — and that module imports packet.ts, which uses
// Node's Buffer, so it only stayed out of the browser bundle by way of tree-shaking. Three lines
// of arithmetic is a better trade than a build that breaks the first time packet.ts gains a
// side effect.
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// App.tsx owns the single bridge subscription to 'presenterPositionReceived' (bridge.ts's
// subscribe() keeps only one live listener per event name, so a second direct subscription here
// would silently steal events from App's). App forwards each move/stop through this ref instead.
export type PresenterMoveHandler = (dx: number, dy: number, stop: boolean) => void;

// Matches desktop main.ts's PRESENTER_HIDE_DELAY_MS exactly (upstream's 500ms auto-hide-when-idle
// timer) — the dot disappears shortly after motion stops and reappears on the next move, rather
// than needing an explicit close action.
const PRESENTER_HIDE_DELAY_MS = 500;

interface PresenterDotOverlayProps {
  moveHandlerRef: MutableRefObject<PresenterMoveHandler | null>;
  onClose: () => void;
}

// Mirrors desktop/src/renderer/public/presenter-overlay.html exactly: a transparent, click-
// through, always-on-top dot with no chrome — no label, no backdrop, no exit button. Desktop
// achieves this via a separate OS-level BrowserWindow (setIgnoreMouseEvents(true)); mobile has no
// equivalent second window, so this renders inside the app's own WebView instead, positioned
// above the current screen with pointerEvents:'none' so it never blocks touches.
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
        dotRef.current.style.left = `${posRef.current.x * window.innerWidth}px`;
        dotRef.current.style.top = `${posRef.current.y * window.innerHeight}px`;
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
