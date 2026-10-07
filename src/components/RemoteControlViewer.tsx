import React, { useEffect, useRef, useState, useCallback } from 'react';
import { LinkApi } from '../vite-env';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';

interface RemoteControlViewerProps {
  deviceId: string;
  deviceName: string;
  // Determines whether the Android-specific soft nav bar (Back/Home/Recents/Lock) makes sense at
  // all — a PC host has no such concept. Orientation itself is no longer guessed from this; see
  // frameIsLandscape below.
  hostDeviceType?: string;
  // Live connected-state of the host peer, straight from App.tsx's own peers map — lets this
  // viewer detect a drop and resume automatically once the peer reconnects, instead of the user
  // having to close and reopen it.
  hostConnected?: boolean;
  onClose: () => void;
  onEndSession?: () => void;
}

const linkApi = (window as any).link as LinkApi;

const HIDE_CHROME_MS = 3000;

const KeyboardIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h12" />
  </svg>
);

const RemoteControlViewer: React.FC<RemoteControlViewerProps> = ({
  deviceId,
  deviceName,
  hostDeviceType,
  hostConnected,
  onClose,
  onEndSession,
}) => {
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isHostMobileLike = hostDeviceType === 'phone' || hostDeviceType === 'tv';

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasReceivedFrame = useRef(false);

  const isLocalMobile = typeof (window as any).Capacitor !== 'undefined';

  // Orientation follows the MIRRORED screen's own shape, not a guess from device type — a phone
  // held sideways or an unusual desktop resolution should still be judged by what's actually
  // arriving. null until the first frame lands; falls back to a device-type guess only for that
  // brief connecting window, then a real frame's aspect always wins.
  const [frameIsLandscape, setFrameIsLandscape] = useState<boolean | null>(null);
  const forceLandscape = isLocalMobile && (frameIsLandscape ?? (hostDeviceType === 'desktop' || hostDeviceType === 'tv'));
  const { className: landscapeClassName, orientation: landscapeOrientation } = useLandscapeOrientation();

  // Measured once via JS rather than trusted from CSS 100vh/100vw — the two don't always agree
  // exactly on mobile browsers/WebViews (a known vh/vw quirk), which showed up as a few pixels of
  // the mirrored screen being clipped top/bottom: the rotated box's CSS size (vh/vw) and the hit-
  // test math below (window.innerHeight/innerWidth) were each computing a slightly different
  // number. Using this single measured value for BOTH eliminates that gap. Kept in sync on resize
  // (keyboard show/hide, real orientation change) rather than measured fresh on every render.
  const [viewportSize, setViewportSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // True fullscreen on mobile — no status bar — plus claiming this phone's own edge-swipe
  // gestures so they reach the canvas as input for the MIRRORED device instead of triggering
  // this phone's own back/home navigation. Both are cleared on unmount, scoped to this one
  // surface only (see the native side's own comments for why).
  useEffect(() => {
    if (!isLocalMobile) return;
    linkApi?.setImmersiveMode?.(true);
    linkApi?.setSystemGestureExclusion?.(true);
    return () => {
      linkApi?.setImmersiveMode?.(false);
      linkApi?.setSystemGestureExclusion?.(false);
    };
  }, [isLocalMobile]);

  // Minimal chrome (name / end session / close, plus the soft nav bar for a mobile-like host)
  // auto-hides after inactivity and reappears on the next touch — an AnyDesk-style fullscreen
  // view, not a UI that permanently eats screen space.
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetHideTimer = useCallback(() => {
    setChromeVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setChromeVisible(false), HIDE_CHROME_MS);
  }, []);
  // Auto-hide only once actually connected — while connecting/reconnecting/disconnected there is
  // no visible canvas to tap (it's hidden, see showFrame below), so if the chrome faded out
  // during that window there was no way left to reach End Session/Close at all: a permanent
  // fullscreen dead end. Any state other than 'connected' forces the chrome back on and cancels
  // the pending hide.
  useEffect(() => {
    if (connectionState !== 'connected') {
      setChromeVisible(true);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      return;
    }
    resetHideTimer();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [connectionState, resetHideTimer]);

  const sendInput = useCallback((inputBody: any) => {
    if (linkApi?.sendRemoteControlInput) {
      linkApi.sendRemoteControlInput(deviceId, inputBody).catch(() => {});
    }
  }, [deviceId]);

  const sendSignal = useCallback((signalBody: any) => {
    if (linkApi?.sendRemoteControlSignal) {
      linkApi.sendRemoteControlSignal(deviceId, signalBody).catch(() => {});
    }
  }, [deviceId]);

  // Direct TLS frame stream listener (Android native relay)
  useEffect(() => {
    const img = new Image();
    const unsubscribeStream = linkApi?.onRemoteControlStream?.((srcId, frame) => {
      if (srcId !== deviceId || !frame) return;
      hasReceivedFrame.current = true;
      setConnectionState('connected');

      if (frame.data && canvasRef.current) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        img.onload = () => {
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
            const landscape = img.width >= img.height;
            setFrameIsLandscape((prev) => (prev === landscape ? prev : landscape));
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = 'data:image/jpeg;base64,' + frame.data;
      }
    });

    return () => {
      unsubscribeStream?.();
    };
  }, [deviceId]);

  // Send 'request' signal to peer on mount — triggers MediaProjection / Screen Capture consent
  // and starts the native frame streamer. Closing the viewer minimizes it while leaving the stream
  // active in background so it can be resumed instantly.
  const hasRequested = useRef(false);
  useEffect(() => {
    if (!hasRequested.current) {
      hasRequested.current = true;
      sendSignal({ type: 'request' });
    }

    // Handle denied (user rejected screen capture on host)
    const unsubscribeDenied = linkApi?.onRemoteControlSignal?.((srcId, signal) => {
      if (srcId !== deviceId || signal?.type !== 'denied') return;
      setConnectionState('disconnected');
      setErrorMessage('Screen capture permission was denied on the host.');
    });

    return () => {
      unsubscribeDenied?.();
    };
  }, [deviceId, sendSignal]);

  // Resume on reconnection instead of requiring the user to close and reopen the viewer.
  // hostConnected comes straight from App.tsx's own peers map (the single onDeviceConnected/
  // onDeviceDisconnected subscription already lives there — this component intentionally does
  // NOT add its own, since this app's Capacitor bridge only keeps one listener per event name
  // and a second subscribe() call would silently replace App.tsx's).
  const wasHostConnected = useRef(hostConnected);
  useEffect(() => {
    if (hostConnected === false && wasHostConnected.current !== false) {
      setConnectionState('reconnecting');
      hasReceivedFrame.current = false;
    } else if (hostConnected === true && wasHostConnected.current === false) {
      setConnectionState('connecting');
      setErrorMessage(null);
      sendSignal({ type: 'request' });
    }
    wasHostConnected.current = hostConnected;
  }, [hostConnected, sendSignal]);

  const handleEndSession = () => {
    sendSignal({ type: 'stop' });
    if (onEndSession) {
      onEndSession();
    } else {
      onClose();
    }
  };

  // Maps a raw pointer event to a normalized (0..1) position within the ACTUAL rendered video
  // frame. Two things make this non-trivial:
  // 1. Rotation (forceLandscape) — clientX/clientY are always real, physical screen coordinates,
  //    unaffected by the CSS transform that visually rotates this whole surface. A 90deg rotation
  //    swaps which physical axis corresponds to which axis of the (unrotated) content itself, so
  //    naively dividing by a post-transform getBoundingClientRect() maps motion onto the WRONG
  //    axis pair — that's the perpendicular-movement bug. The fix mirrors the exact rotation
  //    already proven correct by useLandscapeOrientation's transformDelta (verified by deriving
  //    both from the same rotation matrix and confirming they agree): physical (clientX, clientY)
  //    is converted into the box's own LOCAL, pre-transform coordinate system, where boxW/boxH
  //    match the box's own declared width:100vh/height:100vw (so boxW = screen height, boxH =
  //    screen width) — layout math, including this, is never affected by an ancestor's transform.
  // 2. Letterboxing — the canvas element fills its entire container edge-to-edge (see the
  //    'fullscreen, not a small window' layout below), but the video frame itself keeps its own
  //    aspect ratio inside that box (object-fit: contain), so a tap can land in the letterbox
  //    margin around the actual image. This replicates that same fit math by hand to find the
  //    frame's real on-screen sub-rect, and returns null for a tap outside it (ignored, not
  //    clamped to the edge — clamping would silently misplace clicks).
  const mapToFrame = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return null;

    let localX: number;
    let localY: number;
    let boxW: number;
    let boxH: number;

    if (forceLandscape) {
      boxW = viewportSize.h; // box's own declared width, matching its CSS pixel size below
      boxH = viewportSize.w; // box's own declared height, matching its CSS pixel size below
      if (landscapeOrientation === 'landscape-secondary') {
        localX = boxW - clientY;
        localY = clientX;
      } else {
        localX = clientY;
        localY = boxH - clientX;
      }
    } else {
      const rect = canvas.getBoundingClientRect();
      localX = clientX - rect.left;
      localY = clientY - rect.top;
      boxW = rect.width;
      boxH = rect.height;
    }

    const imgAspect = canvas.width / canvas.height;
    const boxAspect = boxW / boxH;
    let renderW: number;
    let renderH: number;
    let offX: number;
    let offY: number;
    if (imgAspect > boxAspect) {
      renderW = boxW;
      renderH = boxW / imgAspect;
      offX = 0;
      offY = (boxH - renderH) / 2;
    } else {
      renderH = boxH;
      renderW = boxH * imgAspect;
      offY = 0;
      offX = (boxW - renderW) / 2;
    }

    const fx = (localX - offX) / renderW;
    const fy = (localY - offY) / renderH;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return { x: fx, y: fy };
  }, [forceLandscape, landscapeOrientation, viewportSize]);

  // Touch / Pointer coordinate mapping & Drag/Swipe support
  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    resetHideTimer();
    const point = mapToFrame(e.clientX, e.clientY);
    if (!point) return;
    pointerStartRef.current = { x: point.x, y: point.y, time: Date.now() };
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!pointerStartRef.current) return;
    const point = mapToFrame(e.clientX, e.clientY);
    const startX = pointerStartRef.current.x;
    const startY = pointerStartRef.current.y;
    const duration = Math.max(50, Math.min(600, Date.now() - pointerStartRef.current.time));
    pointerStartRef.current = null;
    if (!point) return;
    const { x: endX, y: endY } = point;

    const dx = endX - startX;
    const dy = endY - startY;
    const distSq = dx * dx + dy * dy;

    // Small movement -> tap / click (threshold ~0.02 of screen dimension)
    if (distSq < 0.0004) {
      sendInput({ action: 'tap', x: endX, y: endY, button: e.button === 2 ? 'right' : 'left' });
    } else {
      // Gesture / swipe
      sendInput({ action: 'scroll', startX, startY, endX, endY, duration });
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLElement>) => {
    const point = mapToFrame(e.clientX, e.clientY);
    if (!point) return;
    const { x, y } = point;

    const delta = e.deltaY;
    const startY = y;
    const endY = Math.max(0, Math.min(1, y - (delta > 0 ? 0.15 : -0.15)));

    sendInput({ action: 'scroll', startX: x, startY, endX: x, endY, duration: 100 });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      sendInput({ action: 'key', key: 'BACKSPACE' });
      e.preventDefault();
    } else if (e.key === 'Enter') {
      sendInput({ action: 'key', key: 'ENTER' });
      e.preventDefault();
    } else if (e.key === 'Escape') {
      sendInput({ action: 'key', key: 'BACK' });
      e.preventDefault();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      sendInput({ action: 'text', text: e.key });
    }
  };

  // Soft-keyboard support: a hidden input, focused/blurred by the floating keyboard button,
  // exactly like RemoteInputOverlay's own pattern. The outer div's onKeyDown above already
  // catches a HARDWARE keyboard's key events regardless of focus, but a phone's on-screen
  // keyboard only appears for a genuinely focusable text input — without this, there was no way
  // to type on the remote device from a phone with no physical keyboard attached.
  const softKeyboardInputRef = useRef<HTMLInputElement | null>(null);
  const [isKeyboardActive, setIsKeyboardActive] = useState(false);

  const handleKeyboardToggle = () => {
    if (!softKeyboardInputRef.current) return;
    if (isKeyboardActive) {
      softKeyboardInputRef.current.blur();
    } else {
      softKeyboardInputRef.current.focus();
    }
  };

  const handleSoftKeyboardChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val) sendInput({ action: 'text', text: val });
    e.target.value = '';
  };

  const handleSoftKeyboardKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      sendInput({ action: 'key', key: 'BACKSPACE' });
      e.preventDefault();
    } else if (e.key === 'Enter') {
      sendInput({ action: 'key', key: 'ENTER' });
      e.preventDefault();
    }
  };

  const showFrame = connectionState === 'connected' || connectionState === 'reconnecting';

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={forceLandscape ? landscapeClassName : undefined}
      style={{
        // .landscape-overlay already sets position:fixed/top/left/z-index and rotates this
        // pre-rotation landscape-shaped box into place over the real portrait viewport — same
        // convention as RemoteInputOverlay/JoystickOverlay. Sized from the JS-measured
        // viewportSize (not 100vh/100vw) so this exactly matches mapToFrame's own math — see
        // viewportSize's comment for why the two units can otherwise disagree by a few pixels.
        ...(forceLandscape
          ? { width: `${viewportSize.h}px`, height: `${viewportSize.w}px` }
          : { position: 'fixed', inset: 0, zIndex: 9999 }),
        background: '#000',
        outline: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Invisible input to receive key events from the phone's own soft keyboard */}
      <input
        ref={softKeyboardInputRef}
        type="text"
        value=""
        onChange={handleSoftKeyboardChange}
        onKeyDown={handleSoftKeyboardKeyDown}
        onFocus={() => setIsKeyboardActive(true)}
        onBlur={() => setIsKeyboardActive(false)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: '1px', height: '1px' }}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      {/* Fullscreen, edge-to-edge canvas — an AnyDesk-style view, not a small letterboxed card.
          The frame's own aspect ratio is preserved via object-fit (and mirrored by hand in
          mapToFrame for hit-testing), so any letterbox bars land inside this same element rather
          than around a smaller floating window. */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          touchAction: 'none',
          objectFit: 'contain',
          background: '#000',
          cursor: 'crosshair',
          display: showFrame ? 'block' : 'none',
        }}
      />

      {!showFrame && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-color)' }}>
              {connectionState === 'connecting' ? 'Connecting Stream...' : 'Disconnected'}
            </div>
            <div style={{ fontSize: '12px' }}>
              {errorMessage || `Waiting for screen capture authorization on ${deviceName}`}
            </div>
          </div>
        </div>
      )}

      {/* Reconnecting banner over the frozen last frame — the peer dropped, but the viewer stays
          open and resumes automatically the moment hostConnected flips back to true. */}
      {connectionState === 'reconnecting' && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            padding: '12px 20px',
            borderRadius: '10px',
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            color: '#f59e0b',
            fontSize: '13px',
            fontWeight: 600,
            textAlign: 'center',
          }}
        >
          {deviceName} disconnected — waiting to reconnect...
        </div>
      )}

      {/* Floating keyboard toggle — always reachable regardless of host type, since typing is
          often needed on either a phone or a PC target. Sits with the rest of the auto-hiding
          chrome. */}
      {isLocalMobile && (
        <button
          onClick={handleKeyboardToggle}
          title="Keyboard"
          aria-label="Toggle Keyboard"
          style={{
            position: 'absolute',
            right: '16px',
            bottom: isHostMobileLike ? '76px' : '16px',
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isKeyboardActive ? 'var(--accent-color, #009bd5)' : 'rgba(0, 0, 0, 0.55)',
            border: '1px solid rgba(255,255,255,0.25)',
            color: '#fff',
            cursor: 'pointer',
            opacity: chromeVisible ? 1 : 0,
            pointerEvents: chromeVisible ? 'auto' : 'none',
            transition: 'opacity 0.25s ease',
          }}
        >
          <KeyboardIcon />
        </button>
      )}

      {/* Minimal Header Bar — name, End Session, Close. Auto-hides with the rest of the chrome. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.65), transparent)',
          opacity: chromeVisible ? 1 : 0,
          pointerEvents: chromeVisible ? 'auto' : 'none',
          transition: 'opacity 0.25s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: connectionState === 'connected' ? '#10b981' : '#f59e0b',
              boxShadow: connectionState === 'connected' ? '0 0 8px #10b981' : 'none',
            }}
          />
          <span style={{ fontWeight: 600, fontSize: '14px', color: '#fff' }}>
            {deviceName}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={handleEndSession}
            title="End Remote Session"
            aria-label="End Remote Session"
            style={{
              padding: '6px 12px',
              fontSize: '11.5px',
              background: 'rgba(239, 68, 68, 0.25)',
              border: '1px solid rgba(239, 68, 68, 0.5)',
              borderRadius: '6px',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            End Session
          </button>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '28px',
              height: '28px',
              padding: 0,
              borderRadius: '50%',
              background: 'rgba(255, 255, 255, 0.12)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Floating Soft Navigation Controls Bar — Back/Home/Recents are Android concepts,
          meaningless for a PC host, so this only ever shows when the host itself is phone/TV.
          Auto-hides together with the header (no separate manual toggle needed). */}
      {isHostMobileLike && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
            padding: '10px 16px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.65), transparent)',
            opacity: chromeVisible ? 1 : 0,
            pointerEvents: chromeVisible ? 'auto' : 'none',
            transition: 'opacity 0.25s ease',
          }}
        >
          <button
            onClick={() => sendInput({ action: 'key', key: 'BACK' })}
            title="Back"
            aria-label="Back"
            style={{
              padding: '10px 24px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.12)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M17.5 4.5a1 1 0 0 1 1.5.866v13.268a1 1 0 0 1-1.5.866L6.01 12.866a1 1 0 0 1 0-1.732L17.5 4.5z" />
            </svg>
          </button>
          <button
            onClick={() => sendInput({ action: 'key', key: 'HOME' })}
            title="Home"
            aria-label="Home"
            style={{
              padding: '10px 24px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.12)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z" />
            </svg>
          </button>
          <button
            onClick={() => sendInput({ action: 'key', key: 'RECENTS' })}
            title="Recents"
            aria-label="Recents"
            style={{
              padding: '10px 24px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.12)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2.5" />
            </svg>
          </button>
          <button
            onClick={() => sendInput({ action: 'key', key: 'LOCK' })}
            title="Lock Device"
            aria-label="Lock Device"
            style={{
              padding: '10px 24px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.12)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

export default RemoteControlViewer;
