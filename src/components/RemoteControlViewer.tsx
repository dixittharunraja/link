import React, { useEffect, useRef, useState, useCallback } from 'react';
import { LinkApi } from '../vite-env';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';
import { IS_ANDROID } from '../utils/platform';

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

const KeyboardIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

  const isLocalMobile = IS_ANDROID;

  // Orientation follows the MIRRORED screen's own shape, not a guess from device type — a phone
  // held sideways or an unusual desktop resolution should still be judged by what's actually
  // arriving. null until the first frame lands; falls back to a device-type guess only for that
  // brief connecting window, then a real frame's aspect always wins.
  const [frameIsLandscape, setFrameIsLandscape] = useState<boolean | null>(null);
  const forceLandscape = isLocalMobile && (frameIsLandscape ?? (hostDeviceType === 'desktop' || hostDeviceType === 'tv'));
  const { className: landscapeClassName, orientation: landscapeOrientation, transformDelta } = useLandscapeOrientation();

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

  // Draggable Floating Bubble State (AnyDesk / Moonlight style)
  // Replaces the obstructive full-width top banner with a compact, draggable floating pill
  // that can be moved anywhere out of the way and only expands its controls when tapped.
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number } | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);

  const containerW = forceLandscape ? viewportSize.h : viewportSize.w;
  const containerH = forceLandscape ? viewportSize.w : viewportSize.h;

  const currentBubbleX = bubblePos !== null ? Math.min(Math.max(12, bubblePos.x), containerW - 54) : containerW - 56;
  const currentBubbleY = bubblePos !== null ? Math.min(Math.max(12, bubblePos.y), containerH - 54) : 16;

  const handleBubblePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = false;
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startX: currentBubbleX,
      startY: currentBubbleY,
    };
  };

  const handleBubblePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    const rawDx = e.clientX - dragStartRef.current.clientX;
    const rawDy = e.clientY - dragStartRef.current.clientY;
    if (!isDraggingRef.current && (rawDx * rawDx + rawDy * rawDy > 36)) {
      isDraggingRef.current = true;
    }
    if (isDraggingRef.current) {
      const delta = forceLandscape ? transformDelta(rawDx, rawDy) : { dx: rawDx, dy: rawDy };
      const nextX = Math.min(Math.max(12, dragStartRef.current.startX + delta.dx), containerW - 54);
      const nextY = Math.min(Math.max(12, dragStartRef.current.startY + delta.dy), containerH - 54);
      setBubblePos({ x: nextX, y: nextY });
    }
  };

  const handleBubblePointerUp = (e: React.PointerEvent) => {
    if (dragStartRef.current) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Ignored if capture already released
      }
      if (!isDraggingRef.current) {
        setIsMenuOpen((prev) => !prev);
      }
      dragStartRef.current = null;
      isDraggingRef.current = false;
    }
  };

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // WebRTC & TLS stream receiver: attempts direct 60 FPS WebRTC peer connection,
  // falling back seamlessly to direct TLS frame stream if WebRTC is unavailable.
  useEffect(() => {
    let pc: RTCPeerConnection | null = null;
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pcRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: 'webrtc_candidate',
            candidate: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            },
          });
        }
      };

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0] && videoRef.current) {
          videoRef.current.srcObject = event.streams[0];
          hasReceivedFrame.current = true;
          setConnectionState('connected');
        }
      };
    } catch (e) {
      console.warn('[RemoteControlViewer] WebRTC initialization failed:', e);
    }

    // Signaling listener (SDP offers, answers, candidates from peer)
    const unsubscribeSignal = linkApi?.onRemoteControlSignal?.((srcId, signal) => {
      if (srcId !== deviceId || !signal) return;

      if (signal.type === 'denied') {
        setConnectionState('disconnected');
        setErrorMessage('Screen capture permission was denied on the host.');
        return;
      }

      if (signal.type === 'stop' || signal.type === 'kicked') {
        setConnectionState('disconnected');
        setErrorMessage(signal.type === 'kicked' ? 'Removed by host' : 'Host ended the session.');
        if (onEndSession) {
          onEndSession();
        } else {
          onClose();
        }
        return;
      }

      if (signal.type === 'webrtc_offer' && pc) {
        pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }))
          .then(() => pc?.createAnswer())
          .then((answer) => {
            if (answer && pc) {
              return pc.setLocalDescription(answer).then(() => {
                sendSignal({ type: 'webrtc_answer', sdp: answer.sdp });
              });
            }
            return undefined;
          })
          .catch((err) => console.error('[RemoteControlViewer] SDP Offer handling error:', err));
      } else if (signal.type === 'webrtc_candidate' && pc && signal.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch((err) =>
          console.warn('[RemoteControlViewer] Add ICE Candidate error:', err)
        );
      }
    });

    // Direct TLS frame fallback listener (for peers streaming JPEG packets)
    const unsubscribeStream = linkApi?.onRemoteControlStream?.((srcId, frame) => {
      if (srcId !== deviceId || !frame || !frame.data) return;
      hasReceivedFrame.current = true;
      setConnectionState('connected');

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const img = new Image();
      img.onload = () => {
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
          const landscape = img.width >= img.height;
          setFrameIsLandscape((prev) => (prev === landscape ? prev : landscape));
        }
        ctx.drawImage(img, 0, 0);
      };
      img.src = frame.data.startsWith('data:') ? frame.data : 'data:image/jpeg;base64,' + frame.data;
    });

    return () => {
      unsubscribeSignal?.();
      unsubscribeStream?.();
      if (pc) {
        pc.close();
        pcRef.current = null;
      }
    };
  }, [deviceId, sendSignal]);

  // Send 'request' signal to peer on mount — triggers MediaProjection / Screen Capture consent
  const hasRequested = useRef(false);
  useEffect(() => {
    if (!hasRequested.current) {
      hasRequested.current = true;
      sendSignal({ type: 'request' });
    }
  }, [deviceId, sendSignal]);

  // Resume on reconnection instead of requiring the user to close and reopen the viewer.
  // hostConnected comes straight from App.tsx's own peers map (the single onDeviceConnected/
  // onDeviceDisconnected subscription already lives there — this component intentionally does
  // NOT add its own, since this app's native bridge only keeps one listener per event name
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
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const activeEl = (video && video.videoWidth > 0) ? video : canvas;
    if (!activeEl) return null;

    const naturalW = (activeEl as HTMLVideoElement).videoWidth || (activeEl as HTMLCanvasElement).width;
    const naturalH = (activeEl as HTMLVideoElement).videoHeight || (activeEl as HTMLCanvasElement).height;
    if (!naturalW || !naturalH) return null;

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
      const rect = activeEl.getBoundingClientRect();
      localX = clientX - rect.left;
      localY = clientY - rect.top;
      boxW = rect.width;
      boxH = rect.height;
    }

    const imgAspect = naturalW / naturalH;
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
    if (isMenuOpen) {
      setIsMenuOpen(false);
      return;
    }
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
        ...(forceLandscape
          ? { width: `${viewportSize.h}px`, height: `${viewportSize.w}px` }
          : { position: 'fixed', inset: 0 }),
        position: 'fixed',
        inset: 0,
        padding: 0,
        zIndex: 9999,
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
      {/* WebRTC hardware accelerated video element */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onLoadedMetadata={() => {
          if (videoRef.current) {
            const w = videoRef.current.videoWidth;
            const h = videoRef.current.videoHeight;
            if (w && h) {
              const landscape = w >= h;
              setFrameIsLandscape((prev) => (prev === landscape ? prev : landscape));
            }
          }
        }}
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

      {/* Fullscreen fallback canvas for direct JPEG stream */}
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
          background: 'transparent',
          pointerEvents: videoRef.current?.srcObject ? 'none' : 'auto',
          cursor: 'crosshair',
          display: showFrame && !videoRef.current?.srcObject ? 'block' : 'none',
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

      {/* Dismiss backdrop when floating menu is open */}
      {isMenuOpen && (
        <div
          onClick={() => setIsMenuOpen(false)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 9990,
          }}
        />
      )}

      {/* Draggable Floating Action Bubble (AnyDesk / Moonlight style) */}
      <div
        onPointerDown={handleBubblePointerDown}
        onPointerMove={handleBubblePointerMove}
        onPointerUp={handleBubblePointerUp}
        title={isMenuOpen ? "Close Menu" : "Session Controls"}
        aria-label="Session Controls"
        style={{
          position: 'absolute',
          left: `${currentBubbleX}px`,
          top: `${currentBubbleY}px`,
          width: '42px',
          height: '42px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isMenuOpen
            ? 'var(--accent-gradient, linear-gradient(135deg, #009bd5 0%, #3b82f6 100%))'
            : 'rgba(12, 12, 14, 0.85)',
          border: isMenuOpen ? '1px solid rgba(255, 255, 255, 0.4)' : '1px solid var(--border-color, rgba(255, 255, 255, 0.15))',
          boxShadow: isMenuOpen
            ? '0 6px 24px rgba(0, 155, 213, 0.45), 0 2px 10px rgba(0,0,0,0.5)'
            : '0 4px 18px rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          color: '#fff',
          cursor: isDraggingRef.current ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
          zIndex: 9995,
          transition: isDraggingRef.current ? 'none' : 'background 0.2s ease, transform 0.15s ease',
        }}
      >
        {isMenuOpen ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <div
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: connectionState === 'connected' ? '#10b981' : '#f59e0b',
                boxShadow: connectionState === 'connected' ? '0 0 6px #10b981' : 'none',
              }}
            />
          </div>
        )}
      </div>

      {/* Expanded Floating Menu */}
      {isMenuOpen && (
        <div
          style={{
            position: 'absolute',
            left: `${currentBubbleX > containerW - 250 ? Math.max(12, currentBubbleX - 200) : currentBubbleX}px`,
            top: `${currentBubbleY > containerH - 220 ? Math.max(12, currentBubbleY - 200) : currentBubbleY + 50}px`,
            width: '240px',
            borderRadius: '14px',
            background: 'var(--modal-bg, #0c0c0e)',
            border: '1px solid var(--border-color, rgba(255, 255, 255, 0.12))',
            boxShadow: 'var(--modal-shadow, 0 12px 36px rgba(0, 0, 0, 0.4)), 0 0 20px rgba(0, 155, 213, 0.08)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            padding: '12px',
            zIndex: 9996,
            color: 'var(--text-color, #fff)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {/* Header row: Device name + status */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '6px', borderBottom: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: connectionState === 'connected' ? 'var(--active-dot, #10b981)' : '#f59e0b',
                  boxShadow: connectionState === 'connected' ? '0 0 8px #10b981' : 'none',
                }}
              />
              <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-color, #f8fafc)' }}>
                {deviceName}
              </span>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted, rgba(255,255,255,0.45))' }}>
              {connectionState}
            </span>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {isLocalMobile && (
              <button
                onClick={() => {
                  handleKeyboardToggle();
                  setIsMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: isKeyboardActive ? 'rgba(14, 165, 233, 0.18)' : 'var(--input-bg, rgba(255, 255, 255, 0.06))',
                  border: isKeyboardActive ? '1px solid var(--accent-color, #0EA5E9)' : '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
                  color: isKeyboardActive ? 'var(--accent-color, #0EA5E9)' : 'var(--text-color, #f1f5f9)',
                  fontSize: '12.5px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <KeyboardIcon />
                <span>{isKeyboardActive ? 'Hide Keyboard' : 'Show Keyboard'}</span>
              </button>
            )}

            {isHostMobileLike && (
              <div style={{ display: 'flex', gap: '6px', marginTop: '2px', marginBottom: '2px' }}>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'BACK' })}
                  title="Back"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M17.5 4.5a1 1 0 0 1 1.5.866v13.268a1 1 0 0 1-1.5.866L6.01 12.866a1 1 0 0 1 0-1.732L17.5 4.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'HOME' })}
                  title="Home"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'RECENTS' })}
                  title="Recents"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2.5" />
                  </svg>
                </button>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'LOCK' })}
                  title="Lock"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </button>
              </div>
            )}

            <button
              onClick={() => {
                setIsMenuOpen(false);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                background: 'var(--input-bg, rgba(255, 255, 255, 0.06))',
                border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
                color: 'var(--text-color, #e2e8f0)',
                fontSize: '12.5px',
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              <span>Minimize Viewer</span>
            </button>

            <button
              onClick={() => {
                setIsMenuOpen(false);
                handleEndSession();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                color: '#ef4444',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span>End Remote Session</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RemoteControlViewer;
