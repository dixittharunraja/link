import React, { useRef, useEffect, useState } from 'react';
import { LinkApi } from '../vite-env';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';
import { pushBackHandler } from '../utils/backNav';
import { PenIcon, MouseIcon, KeyboardIcon, UndoIcon, RedoIcon, LeftClickIcon, MiddleClickIcon, RightClickIcon, IconButton, OverlayCloseButton, ViewModeButton } from './RemoteIcons';
import { IS_ANDROID } from '../utils/platform';
import { useTouchpad } from '../hooks/useTouchpad';

interface UseDigitizerOptions {
  deviceId: string;
  enabled: boolean;
  mapCoordinates?: (cx: number, cy: number, width: number, height: number) => { lx: number; ly: number };
}

export function useDigitizer({ deviceId, enabled, mapCoordinates }: UseDigitizerOptions) {
  const linkApi = (window as any).link as LinkApi;
  const canvasRef = useRef<HTMLDivElement>(null);
  const penTouching = useRef<boolean>(false);
  const penLastPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    if (!linkApi || !enabled) return;
    linkApi.sendDigitizerSession(deviceId, 'start', 10000, 10000).catch((err: any) => console.error('Digitizer session start failed:', err));
    return () => {
      linkApi.sendDigitizerSession(deviceId, 'end', 10000, 10000).catch(() => {});
    };
  }, [deviceId, enabled, linkApi]);

  const sendPenAction = (action: 'undo' | 'redo') => {
    linkApi?.sendDigitizerAction?.(deviceId, action);
  };

  const defaultMapCoords = (cx: number, cy: number, rectWidth: number, rectHeight: number) => {
    const rx = Math.max(0, Math.min(1.0, cx / rectWidth));
    const ry = Math.max(0, Math.min(1.0, cy / rectHeight));
    return { lx: Math.round(rx * 10000), ly: Math.round(ry * 10000) };
  };

  const mapper = mapCoordinates || defaultMapCoords;

  const dispatchEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const { lx, ly } = mapper(cx, cy, rect.width, rect.height);
    penLastPos.current = { x: lx, y: ly };

    linkApi.sendDigitizerEvent(deviceId, {
      x: lx, y: ly, touching: true, active: true,
      pressure: e.pressure || 1.0,
      tool: e.pointerType === 'pen' ? 'Pen' : 'Mouse',
    });
  };

  const handlePenPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!linkApi) return;
    penTouching.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    dispatchEvent(e);
  };

  const handlePenPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!penTouching.current || !linkApi) return;
    dispatchEvent(e);
  };

  const handlePenPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!penTouching.current || !linkApi) return;
    penTouching.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}

    linkApi.sendDigitizerEvent(deviceId, {
      x: penLastPos.current.x, y: penLastPos.current.y, touching: false, active: true,
    });
  };

  return {
    canvasRef,
    sendPenAction,
    handlePenPointerDown,
    handlePenPointerMove,
    handlePenPointerUp,
  };
}

interface RemoteInputOverlayProps {
  deviceId: string;
  // A phone target gets a portrait surface; anything else (including unknown) is landscape.
  hostDeviceType?: string;
  onClose: () => void;
}

// Scales touch deltas so the cursor can cross a full desktop display comfortably.
const MOUSE_SENSITIVITY = 2.2;



const RemoteInputOverlay: React.FC<RemoteInputOverlayProps> = ({ deviceId, hostDeviceType, onClose }) => {
  const linkApi = (window as any).link as LinkApi;
  const isMobile = IS_ANDROID;
  // Starts in the layout that suits the target (landscape for a PC or TV, portrait for a phone); the
  // toggle in the header overrides it.
  const [viewMode, setViewMode] = useState<'portrait' | 'landscape' | null>(null);
  const forceLandscape = isMobile && (viewMode ? viewMode === 'landscape' : hostDeviceType !== 'phone');
  const { className, transformDelta, orientation } = useLandscapeOrientation(forceLandscape);

  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useTouchpad({ deviceId, transformDelta, sensitivity: MOUSE_SENSITIVITY });

  useEffect(() => {
    return pushBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  useEffect(() => {
    if (!linkApi) return;
    const unsub = linkApi.onInputGuestClosed?.(() => {
      onClose();
    });
    // The host of a paired session ends it by kicking this device (link.input.kicked); there is
    // no socket of our own to watch close.
    const unsubKicked = linkApi.onInputKicked?.((srcId: string) => {
      if (srcId === deviceId) {
        onClose();
      }
    });
    return () => {
      unsub?.();
      unsubKicked?.();
    };
  }, [deviceId, linkApi, onClose]);


  // The digitizer (absolute stylus positioning) is a mode of this surface: it changes what the
  // center area and some buttons do, while the rest of the layout stays.
  const [mode, setMode] = useState<'mouse' | 'pen'>('mouse');

  const mapPenCoordinates = (cx: number, cy: number, rectWidth: number, rectHeight: number) => {
    const rx = Math.max(0, Math.min(1.0, cx / rectWidth));
    const ry = Math.max(0, Math.min(1.0, cy / rectHeight));

    // Desktop, or a portrait surface: the surface and the target screen share an orientation.
    if (!forceLandscape) {
      return { lx: Math.round(rx * 10000), ly: Math.round(ry * 10000) };
    }

    let rx_mapped: number;
    let ry_mapped: number;
    if (orientation === 'landscape-secondary') {
      rx_mapped = ry;
      ry_mapped = rx;
    } else {
      rx_mapped = ry;
      ry_mapped = 1.0 - rx;
    }
    return { lx: Math.round(rx_mapped * 10000), ly: Math.round(ry_mapped * 10000) };
  };

  const {
    canvasRef,
    sendPenAction,
    handlePenPointerDown,
    handlePenPointerMove,
    handlePenPointerUp,
  } = useDigitizer({
    deviceId,
    enabled: mode === 'pen',
    mapCoordinates: mapPenCoordinates,
  });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isKeyboardActive, setIsKeyboardActive] = useState<boolean>(false);

  const handleKeyboardToggle = () => {
    const input = inputRef.current;
    if (!input) return;
    if (isKeyboardActive) {
      input.blur();
      setIsKeyboardActive(false);
    } else {
      // Blur first: the field can still be focused after Android's back key hid the keyboard,
      // and focusing an already focused field does not bring the keyboard back.
      input.blur();
      input.focus();
      setIsKeyboardActive(true);
    }
  };

  // A touch on the surface while the keyboard is up only closes the keyboard; that gesture is not
  // sent as mouse input.
  const dismissingKeyboard = useRef(false);
  const closeKeyboardOnTouch = (e: React.TouchEvent | React.PointerEvent): boolean => {
    if (isKeyboardActive) {
      inputRef.current?.blur();
      setIsKeyboardActive(false);
      dismissingKeyboard.current = true;
    }
    if (dismissingKeyboard.current) {
      e.preventDefault();
      const fingersLeft = 'touches' in e ? e.touches.length : 0;
      if (e.type === 'touchend' || e.type === 'touchcancel' || e.type === 'pointerup' || e.type === 'pointercancel') {
        if (fingersLeft === 0) dismissingKeyboard.current = false;
      }
      return true;
    }
    return false;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val || !linkApi) return;
    
    // A negative special-key code carries a character (see special() in core/plugins/input.rs).
    for (let i = 0; i < val.length; i++) {
      const char = val[i];
      const code = char.charCodeAt(0);
      linkApi.sendSpecialKey(deviceId, -code);
    }
    e.target.value = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!linkApi) return;
    // Key codes match special() in core/plugins/input.rs. Ctrl shortcuts only come from a hardware
    // keyboard attached to the phone and are sent as codes 40-43.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      // preventDefault keeps the shortcut from acting on the hidden local input; a local paste
      // would otherwise be sent as typed characters through handleInputChange.
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
      linkApi.sendSpecialKey(deviceId, 1); // Backspace
    } else if (e.key === 'Enter') {
      linkApi.sendSpecialKey(deviceId, 12); // Enter
    } else if (e.key === 'Escape') {
      linkApi.sendSpecialKey(deviceId, 14); // Escape
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
    <div
      id="touchpadSurface"
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
      <div style={{ width: '100%', paddingTop: '0px', paddingBottom: '12px', fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 'bold', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Remote Input</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isMobile && <ViewModeButton landscape={forceLandscape} onToggle={() => setViewMode(forceLandscape ? 'portrait' : 'landscape')} />}
          <OverlayCloseButton onClick={onClose} />
        </div>
        {/* Hidden input that receives the phone's soft keyboard */}
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
        ref={canvasRef}
        onTouchStart={mode === 'mouse' ? (e) => { if (!closeKeyboardOnTouch(e)) handleTouchStart(e); } : undefined}
        onTouchMove={mode === 'mouse' ? (e) => { if (!closeKeyboardOnTouch(e)) handleTouchMove(e); } : undefined}
        onTouchEnd={mode === 'mouse' ? (e) => { if (!closeKeyboardOnTouch(e)) handleTouchEnd(e); } : undefined}
        onTouchCancel={mode === 'mouse' ? (e) => { if (!closeKeyboardOnTouch(e)) handleTouchEnd(e); } : undefined}
        onPointerDown={mode === 'pen' ? (e) => { if (!closeKeyboardOnTouch(e)) handlePenPointerDown(e); } : undefined}
        onPointerMove={mode === 'pen' ? (e) => { if (!closeKeyboardOnTouch(e)) handlePenPointerMove(e); } : undefined}
        onPointerUp={mode === 'pen' ? (e) => { if (!closeKeyboardOnTouch(e)) handlePenPointerUp(e); } : undefined}
        onPointerCancel={mode === 'pen' ? (e) => { if (!closeKeyboardOnTouch(e)) handlePenPointerUp(e); } : undefined}
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
        {mode === 'pen' ? (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Draw here to position the cursor<br />
            (Absolute mapping to target screen)
          </span>
        ) : (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Drag to move mouse • Tap to click • Two-finger tap to right-click<br />
            Two-finger drag to scroll • Press &amp; hold to click-drag
          </span>
        )}
      </div>

      <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px', paddingTop: '12px' }}>
        {mode === 'mouse' ? (
          <IconButton title="Pen (digitizer mode)" onClick={() => setMode('pen')}><PenIcon /></IconButton>
        ) : (
          <IconButton title="Mouse mode" onClick={() => setMode('mouse')}><MouseIcon /></IconButton>
        )}
        <IconButton title="Keyboard" onClick={handleKeyboardToggle} active={isKeyboardActive} keepFocus><KeyboardIcon /></IconButton>
        {mode === 'mouse' ? (
          <>
            <IconButton title="Left Click" onClick={() => linkApi?.sendMouseClick(deviceId, 'left')}><LeftClickIcon /></IconButton>
            <IconButton title="Middle Click" onClick={() => linkApi?.sendMouseClick(deviceId, 'middle')}><MiddleClickIcon /></IconButton>
            <IconButton title="Right Click" onClick={() => linkApi?.sendMouseClick(deviceId, 'right')}><RightClickIcon /></IconButton>
          </>
        ) : (
          <>
            <IconButton title="Undo" onClick={() => sendPenAction('undo')}><UndoIcon /></IconButton>
            <IconButton title="Redo" onClick={() => sendPenAction('redo')}><RedoIcon /></IconButton>
            <button
              onClick={() => linkApi?.cycleTargetDisplay?.(deviceId)}
              style={{ padding: '10px 4px', background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}
            >
              Screen ⇆
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default RemoteInputOverlay;
