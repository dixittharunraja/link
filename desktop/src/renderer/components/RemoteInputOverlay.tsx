import React, { useRef, useEffect, useState } from 'react';

interface RemoteInputOverlayProps {
  deviceId: string;
  onClose: () => void;
}

// Multiplies raw touch-move pixel deltas before sending — raw 1:1 felt sluggish for cursor
// movement across a full desktop display.
const MOUSE_SENSITIVITY = 2.2;

const RemoteInputOverlay: React.FC<RemoteInputOverlayProps> = ({ deviceId, onClose }) => {
  const linkApi = (window as any).link;

  const touchpadLast = useRef<{ x: number; y: number } | null>(null);
  const touchpadLastScroll = useRef<{ x: number; y: number } | null>(null);
  const touchpadScrollStart = useRef<{ x: number; y: number } | null>(null);
  const touchpadStart = useRef<{ x: number; y: number } | null>(null);
  const touchStartTime = useRef<number>(0);
  const lastTapTime = useRef<number>(0);
  const isDoubleTapDrag = useRef<boolean>(false);
  const hasMoved = useRef<boolean>(false);
  const isPressed = useRef<boolean>(false);
  const isLongPressDrag = useRef<boolean>(false);
  const longPressTimer = useRef<any | null>(null);
  const LONG_PRESS_MS = 450;
  // Peak simultaneous finger count seen during the current gesture — used to decide left vs
  // right click only once, on the FINAL touchend (all fingers up). Two fingers lifting isn't
  // always reported as a single touchend event with changedTouches.length===2; it's often two
  // separate touchend events (one per finger). Deciding per-event on that count previously fired
  // a right-click on the first finger's lift and then a spurious left-click on the second
  // finger's lift (since by then touches.length was back to 0) — this replaces that.
  const maxTouches = useRef<number>(0);

  // Mouse delta batching to avoid flooding the socket (similar to vanilla JS 60Hz loop)
  const mouseAccumulated = useRef({ dx: 0, dy: 0, scrollDx: 0, scrollDy: 0 });
  const batchInterval = useRef<any | null>(null);

  useEffect(() => {
    if (!linkApi) return;

    batchInterval.current = setInterval(() => {
      const { dx, dy, scrollDx, scrollDy } = mouseAccumulated.current;
      if (dx !== 0 || dy !== 0) {
        linkApi.sendMouseMove(deviceId, dx, dy);
        mouseAccumulated.current.dx = 0;
        mouseAccumulated.current.dy = 0;
      }
      if (scrollDx !== 0 || scrollDy !== 0) {
        linkApi.sendMouseScroll(deviceId, scrollDx, scrollDy);
        mouseAccumulated.current.scrollDx = 0;
        mouseAccumulated.current.scrollDy = 0;
      }
    }, 16);

    return () => {
      if (batchInterval.current) clearInterval(batchInterval.current);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (isDoubleTapDrag.current || isLongPressDrag.current) {
        linkApi.sendMouseDrag(deviceId, false);
      }
    };
  }, [deviceId, linkApi]);

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    const now = Date.now();
    hasMoved.current = false;
    isPressed.current = true;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (e.touches.length === 1) {
      // Fresh gesture starting (first finger down) — reset the peak-finger tracker.
      maxTouches.current = 1;
    } else {
      maxTouches.current = Math.max(maxTouches.current, e.touches.length);
    }

    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchpadLast.current = { x: t.clientX, y: t.clientY };
      touchpadStart.current = { x: t.clientX, y: t.clientY };
      touchStartTime.current = now;

      const delta = now - lastTapTime.current;
      if (delta < 400 && lastTapTime.current > 0) {
        isDoubleTapDrag.current = true;
        linkApi?.sendMouseDrag(deviceId, true);
      } else {
        // Click-and-drag for selection: press and hold a single finger still for
        // LONG_PRESS_MS to engage the left mouse button, then drag to select — an alternative
        // to double-tap-and-hold, matching how a real trackpad's click-drag works.
        longPressTimer.current = setTimeout(() => {
          if (isPressed.current && !hasMoved.current && !isDoubleTapDrag.current) {
            isLongPressDrag.current = true;
            linkApi?.sendMouseDrag(deviceId, true);
          }
        }, LONG_PRESS_MS);
      }
    } else if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const mid = {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2
      };
      touchpadLastScroll.current = mid;
      touchpadScrollStart.current = mid;
      touchStartTime.current = now;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    if (!linkApi) return;

    if (e.touches.length === 1 && touchpadLast.current) {
      const t = e.touches[0];
      let dx = t.clientX - touchpadLast.current.x;
      let dy = t.clientY - touchpadLast.current.y;

      const totalDist = Math.hypot(t.clientX - touchpadStart.current!.x, t.clientY - touchpadStart.current!.y);
      if (totalDist > 12) {
        hasMoved.current = true;
      }

      touchpadLast.current = { x: t.clientX, y: t.clientY };

      // Landscape orientation coordinates swap
      const tmp = dx;
      dx = dy;
      dy = -tmp;

      mouseAccumulated.current.dx += dx * MOUSE_SENSITIVITY;
      mouseAccumulated.current.dy += dy * MOUSE_SENSITIVITY;
    } else if (e.touches.length === 2 && touchpadLastScroll.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const curX = (t1.clientX + t2.clientX) / 2;
      const curY = (t1.clientY + t2.clientY) / 2;

      let dx = curX - touchpadLastScroll.current.x;
      let dy = curY - touchpadLastScroll.current.y;

      // Cumulative distance from the initial two-finger touch-down, not the tiny per-frame
      // delta — matches the single-finger tap tolerance so a genuine two-finger tap (right
      // click) isn't misclassified as a scroll from ordinary finger jitter.
      const totalDist = touchpadScrollStart.current
        ? Math.hypot(curX - touchpadScrollStart.current.x, curY - touchpadScrollStart.current.y)
        : 0;
      if (totalDist > 12) {
        hasMoved.current = true;
      }

      touchpadLastScroll.current = { x: curX, y: curY };

      // Landscape swap
      const tmp = dx;
      dx = dy;
      dy = -tmp;

      // Inverted from the raw swipe delta — matches natural/"content follows finger" scrolling.
      mouseAccumulated.current.scrollDx += dx / 10;
      mouseAccumulated.current.scrollDy += dy / 10;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    if (!linkApi) return;

    isPressed.current = false;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }

    const now = Date.now();
    const duration = now - touchStartTime.current;

    if (isLongPressDrag.current) {
      isLongPressDrag.current = false;
      linkApi.sendMouseDrag(deviceId, false);
      lastTapTime.current = 0;
    } else if (isDoubleTapDrag.current) {
      isDoubleTapDrag.current = false;
      linkApi.sendMouseDrag(deviceId, false);
      lastTapTime.current = 0;
    } else if (e.touches.length === 0 && !hasMoved.current && duration < 300) {
      // Only decide once all fingers are up, based on the peak simultaneous finger count seen
      // during this gesture — not per-touchend-event — since a two-finger lift is often reported
      // as two separate touchend events rather than one.
      if (maxTouches.current >= 2) {
        linkApi.sendMouseClick(deviceId, 'right');
        lastTapTime.current = 0;
      } else {
        linkApi.sendMouseClick(deviceId, 'left');
        lastTapTime.current = now;
      }
    }

    if (e.touches.length === 0) {
      maxTouches.current = 0;
    }

    touchpadLast.current = null;
    touchpadLastScroll.current = null;
    touchpadScrollStart.current = null;
    touchpadStart.current = null;
  };

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isKeyboardActive, setIsKeyboardActive] = useState<boolean>(false);

  const handleKeyboardToggle = () => {
    if (inputRef.current) {
      if (isKeyboardActive) {
        inputRef.current.blur();
        setIsKeyboardActive(false);
      } else {
        inputRef.current.focus();
        setIsKeyboardActive(true);
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val || !linkApi) return;
    
    // Send all characters present in val
    for (let i = 0; i < val.length; i++) {
      const char = val[i];
      const code = char.charCodeAt(0);
      linkApi.sendSpecialKey(deviceId, -code);
    }
    // Set value back to empty string to prepare for next batch of fast typing inputs
    e.target.value = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!linkApi) return;
    // Ctrl/Cmd shortcuts — only reachable via a hardware/Bluetooth keyboard paired to the phone
    // (Android's software keyboard has no Ctrl key), sent as dedicated specialKey codes rather
    // than literal characters. Codes 40-43 match touchpad.ts's C# helper's Ctrl+combo branch.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      // preventDefault so the browser/WebView doesn't also select-all the invisible local input —
      // without it, a subsequent Ctrl+C would copy from THIS device's clipboard instead of the
      // remote target's, and Ctrl+V would paste local clipboard text into the hidden field,
      // triggering handleInputChange and sending it as literal characters on top of the combo.
      e.preventDefault();
      linkApi.sendSpecialKey(deviceId, 40); // Select All
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      linkApi.sendSpecialKey(deviceId, 41); // Copy
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      linkApi.sendSpecialKey(deviceId, 42); // Paste
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      linkApi.sendSpecialKey(deviceId, 43); // Cut
    } else if (e.key === 'Backspace') {
      linkApi.sendSpecialKey(deviceId, 1); // 1 is Backspace in mouse-helper.cs
    } else if (e.key === 'Enter') {
      linkApi.sendSpecialKey(deviceId, 12); // 12 is Enter / Return in mouse-helper.cs
    } else if (e.key === 'Escape') {
      linkApi.sendSpecialKey(deviceId, 14); // 14 is Escape
    } else if (e.key === 'ArrowLeft') {
      linkApi.sendSpecialKey(deviceId, 4); // Left
    } else if (e.key === 'ArrowUp') {
      linkApi.sendSpecialKey(deviceId, 5); // Up
    } else if (e.key === 'ArrowRight') {
      linkApi.sendSpecialKey(deviceId, 6); // Right
    } else if (e.key === 'ArrowDown') {
      linkApi.sendSpecialKey(deviceId, 7); // Down
    }
  };

  return (
    <div id="touchpadSurface" className="landscape-overlay" style={{ height: '100vw', width: '100vh' }}>
      <div style={{ width: '100%', paddingTop: '0px', paddingBottom: '12px', fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 'bold', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Remote Input</span>
        {/* Invisible input field to receive key inputs from mobile soft keyboard */}
        <input
          ref={inputRef}
          type="text"
          value=""
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsKeyboardActive(true)}
          onBlur={() => setIsKeyboardActive(false)}
          style={{
            position: 'absolute',
            opacity: 0,
            pointerEvents: 'none',
            width: '1px',
            height: '1px',
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          flex: 1,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          touchAction: 'none',
          color: '#fff',
          textAlign: 'center',
          fontSize: '16px',
          lineHeight: '1.6',
        }}
      >
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Drag to move mouse • Tap to click • Two-finger tap to right-click<br />
          Two-finger drag to scroll • Press &amp; hold to click-drag
        </span>
      </div>

      <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', paddingTop: '16px' }}>
        <button
          onClick={handleKeyboardToggle}
          style={{
            padding: '16px',
            background: isKeyboardActive ? 'var(--accent-color, #009bd5)' : 'rgba(255,255,255,0.03)',
            color: isKeyboardActive ? '#000' : '#fff',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            fontSize: '15px',
            fontWeight: 'bold',
            boxShadow: isKeyboardActive ? '0 0 12px var(--accent-color)' : 'none',
            transition: 'all 0.15s ease'
          }}
        >
          Keyboard ⌨
        </button>
        <button
          onClick={() => linkApi?.sendMouseClick(deviceId, 'left')}
          style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '15px', fontWeight: 'bold' }}
        >
          Left Click
        </button>
        <button
          onClick={() => linkApi?.sendMouseClick(deviceId, 'middle')}
          style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '15px', fontWeight: 'bold' }}
        >
          Middle Click
        </button>
        <button
          onClick={() => linkApi?.sendMouseClick(deviceId, 'right')}
          style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '15px', fontWeight: 'bold' }}
        >
          Right Click
        </button>
        <button
          onClick={onClose}
          style={{ padding: '16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 'bold' }}
        >
          Exit
        </button>
      </div>
    </div>
  );
};

export default RemoteInputOverlay;
