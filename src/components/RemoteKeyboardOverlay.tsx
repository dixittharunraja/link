import React, { useState, useEffect, useRef } from 'react';
import { LinkApi } from '../vite-env';
import { pushBackHandler } from '../utils/backNav';
import { PenIcon, MouseIcon, KeyboardIcon, UndoIcon, RedoIcon, ViewModeButton, OverlayCloseButton, IconButton, LeftClickIcon, MiddleClickIcon, RightClickIcon } from './RemoteIcons';
import { useDigitizer } from './RemoteInputOverlay';
import { DialogCard } from './DialogCard';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';
import { useTouchpad } from '../hooks/useTouchpad';
import { useDeviceApps, DeviceApp } from '../hooks/useDeviceApps';
import { IS_ANDROID } from '../utils/platform';
import { VolumeSink } from '../types/peer';

interface RemoteKeyboardOverlayProps {
  deviceId: string;
  deviceName: string;
  /** What is being controlled: a TV gets a D-pad; a phone is touch-driven and gets the touchpad. */
  deviceType?: string;
  /** The target's media volume, when it shares it (systemvolume): shown as a slider on the D-pad screen. */
  mediaVolume?: VolumeSink;
  onSetVolume?: (sinkName: string, volume: number) => void;
  onClose: () => void;
}

const linkApi = (window as any).link as LinkApi;

// Remote Input for a TV target: keyboard, D-pad and pen (see the 'remoteinput' entry in
// DeviceControlPanel.tsx).
const RemoteKeyboardOverlay: React.FC<RemoteKeyboardOverlayProps> = ({
  deviceId,
  deviceName: _deviceName,
  deviceType,
  mediaVolume,
  onSetVolume,
  onClose,
}) => {
  const [typedText, setTypedText] = useState(' ');
  const isCapturing = true;
  const inputRef = useRef<HTMLInputElement>(null);
  const [isKeyboardActive, setIsKeyboardActive] = useState(false);

  const handleKeyboardToggle = () => {
    const input = inputRef.current;
    if (!input) return;
    if (isKeyboardActive) {
      input.blur();
      setIsKeyboardActive(false);
    } else {
      // Blur first: after Back hid the keyboard the field can still hold focus, and focusing a
      // focused field does not bring the keyboard back.
      input.blur();
      input.focus();
      setIsKeyboardActive(true);
    }
  };
  // The surface below the header: the D-pad (the default), a touchpad (relative cursor) with a Pen switch
  // for absolute digitizer input (the cursor jumps to the touched spot), or the target's apps.
  const isMobileSurface = IS_ANDROID;
  // A phone is driven by touch, so it has no D-pad: it opens on the touchpad (or on pen from a PC, which has
  // no touchpad), and the keys it still needs (Back, Home, volume, play) sit in the toolbar.
  const phoneTarget = deviceType === 'phone';
  const [mode, setMode] = useState<'keyboard' | 'touchpad' | 'pen' | 'apps'>(phoneTarget ? (IS_ANDROID ? 'touchpad' : 'pen') : 'keyboard');

  // One-tap app buttons for the target (a TV): every app it can launch, plus a few pinned favourites that
  // stay on this screen in every mode. Android only for now.
  const appsAvailable = isMobileSurface && !!linkApi?.requestDeviceApps;
  const { apps, pinned, loading: appsLoading, refresh: refreshApps, isPinned, togglePin, launch: launchApp } = useDeviceApps(deviceId, appsAvailable);
  const appIcon = (app: DeviceApp, size: number) =>
    app.icon ? (
      <img src={`data:image/png;base64,${app.icon}`} alt="" width={size} height={size} style={{ borderRadius: size * 0.22, flexShrink: 0 }} />
    ) : (
      <div style={{ width: size, height: size, borderRadius: size * 0.22, background: 'var(--accent-color, #009bd5)', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.5, flexShrink: 0 }}>
        {app.label.charAt(0).toUpperCase()}
      </div>
    );

  // On the phone this is a full-screen surface like the other remote-input screens; on the desktop it
  // stays a dialog. Portrait by default; the toggle in the header lays it out sideways.
  const isMobile = IS_ANDROID;
  const [viewMode, setViewMode] = useState<'portrait' | 'landscape'>('portrait');
  const forceLandscape = isMobile && viewMode === 'landscape';
  const { className, orientation, transformDelta } = useLandscapeOrientation(forceLandscape);

  // The surface is rotated in landscape, so a pen position has to be mapped back to the target
  // screen (the same mapping as RemoteInputOverlay's).
  const mapPenCoordinates = forceLandscape
    ? (cx: number, cy: number, rectWidth: number, rectHeight: number) => {
        const rx = Math.max(0, Math.min(1.0, cx / rectWidth));
        const ry = Math.max(0, Math.min(1.0, cy / rectHeight));
        const mappedX = ry;
        const mappedY = orientation === 'landscape-secondary' ? rx : 1.0 - rx;
        return { lx: Math.round(mappedX * 10000), ly: Math.round(mappedY * 10000) };
      }
    : undefined;

  const {
    canvasRef,
    sendPenAction,
    handlePenPointerDown,
    handlePenPointerMove,
    handlePenPointerUp,
  } = useDigitizer({ deviceId, enabled: mode === 'pen', mapCoordinates: mapPenCoordinates });

  // Relative cursor on the TV: drag to move, tap to click, with the Left/Middle/Right buttons below.
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useTouchpad({
    deviceId,
    transformDelta,
    // Higher than the PC touchpad's 2.2: a TV is read from further away and the cursor has to cross a big
    // screen. The TV also speeds up fast strokes (LinkPointer).
    sensitivity: 5,
    enabled: mode === 'touchpad',
  });

  // Immersive mode comes from useLandscapeOrientation above (nothing happens on the desktop).

  // Mobile: the full-screen surface (rotated in landscape). Desktop: the dialog.
  const wrap = (children: React.ReactNode) =>
    isMobile ? (
      <div
        id="remoteKeyboardSurface"
        className={forceLandscape ? className : undefined}
        style={
          forceLandscape
            ? { height: '100vw', width: '100vh' }
            : {
                position: 'fixed',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
                padding: 'max(16px, env(safe-area-inset-top, 16px)) max(16px, env(safe-area-inset-right, 16px)) max(16px, env(safe-area-inset-bottom, 16px)) max(16px, env(safe-area-inset-left, 16px))',
                background: 'var(--bg-color)',
                color: 'var(--text-color)',
                fontFamily: 'var(--font-sans)',
                zIndex: 10000,
                overflow: 'hidden',
                overscrollBehavior: 'none',
                userSelect: 'none',
              }
        }
      >
        {children}
      </div>
    ) : (
      <DialogCard onCancel={onClose} maxWidth="460px" zIndex={10000}>
        {children}
      </DialogCard>
    );

  const sideways = isMobile && forceLandscape;
  const dpadSize = sideways ? 56 : isMobile ? 72 : 54;

  // The soft keyboard is opened by the Keyboard button, not on its own: focusing the field here made
  // it pop up again every time this re-ran.
  useEffect(() => {
    return pushBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  const sendKey = (specialKey: string) => {
    linkApi?.sendRemoteInput?.(deviceId, undefined, specialKey);
  };

  const sendTextString = (text: string) => {
    if (!text) return;
    linkApi?.sendRemoteInput?.(deviceId, text, undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isCapturing) return;

    // Ctrl shortcuts are sent as special keys, which the target performs as accessibility
    // select-all/copy/paste/cut actions.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      sendKey('SELECT_ALL');
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      sendKey('COPY');
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      sendKey('PASTE');
      return;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      sendKey('CUT');
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      sendKey('DPAD_UP');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      sendKey('DPAD_DOWN');
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      sendKey('DPAD_LEFT');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      sendKey('DPAD_RIGHT');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      sendKey('ENTER');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      sendKey('BACK');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      sendKey('TAB');
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val.length > 1) {
      const char = val.substring(1);
      sendTextString(char);
    } else if (val.length === 0) {
      sendKey('DELETE');
    }
    setTypedText(' ');
  };

  const renderKeyboardButton = (style?: React.CSSProperties) => (
    <IconButton title="Keyboard" onClick={handleKeyboardToggle} active={isKeyboardActive} keepFocus style={style}><KeyboardIcon /></IconButton>
  );

  // Toolbars on a phone: seven buttons, sideways in one row; in portrait a twelve-column grid so that the
  // first row of four and the second of three each fill the width (spans of 3, then 4). The desktop dialog
  // wraps its six buttons in one row.
  const toolbarColumns = !isMobileSurface ? 'repeat(6, 1fr)' : forceLandscape ? 'repeat(7, 1fr)' : 'repeat(12, 1fr)';
  const cell = (n: number): React.CSSProperties | undefined => (isMobileSurface && !forceLandscape ? { gridColumn: `span ${n}` } : undefined);

  // The D-pad screen can swap its arrows for a number pad: channel numbers, PINs and codes on the TV.
  const [numpad, setNumpad] = useState(false);

  // Centred under each other; "safe" keeps a row wider than the screen scrollable from its first app.
  const favouriteApps =
    appsAvailable && pinned.length > 0 ? (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', width: '100%', minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>Favourite apps</div>
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '2px', maxWidth: '100%', justifyContent: 'safe center' }}>
          {pinned.map((app) => (
            <button
              key={app.package}
              onClick={() => launchApp(app.package)}
              title={`Open ${app.label}`}
              aria-label={`Open ${app.label}`}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, padding: '6px 10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-color)', fontSize: '12px', cursor: 'pointer' }}
            >
              {appIcon(app, 22)}
              <span style={{ maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.label}</span>
            </button>
          ))}
        </div>
      </div>
    ) : null;

  const dpadPad = (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${dpadSize}px)`, gridGap: '8px', justifyContent: 'center', flexShrink: 0 }}>
      <div></div>
      <button onClick={() => sendKey('DPAD_UP')} style={{ ...dpadButtonStyle, width: dpadSize, height: dpadSize }} title="Up (ArrowUp)">▲</button>
      <div></div>

      <button onClick={() => sendKey('DPAD_LEFT')} style={{ ...dpadButtonStyle, width: dpadSize, height: dpadSize }} title="Left (ArrowLeft)">◀</button>
      <button
        onClick={() => sendKey('DPAD_CENTER')}
        style={{ ...dpadButtonStyle, width: dpadSize, height: dpadSize, background: 'var(--accent-gradient)', color: 'var(--btn-primary-text)', fontWeight: 700 }}
        title="Select / OK (Enter)"
      >
        OK
      </button>
      <button onClick={() => sendKey('DPAD_RIGHT')} style={{ ...dpadButtonStyle, width: dpadSize, height: dpadSize }} title="Right (ArrowRight)">▶</button>

      <div></div>
      <button onClick={() => sendKey('DPAD_DOWN')} style={{ ...dpadButtonStyle, width: dpadSize, height: dpadSize }} title="Down (ArrowDown)">▼</button>
      <div></div>
    </div>
  );

  // Digits go to the focused field as typed text; ⌫ and ↵ are the same keys the keyboard sends.
  const numKeyHeight = Math.round(dpadSize * 0.75);
  const numKey = (label: React.ReactNode, onClick: () => void, title: string, accent = false) => (
    <button
      key={title}
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        ...dpadButtonStyle,
        width: dpadSize,
        height: numKeyHeight,
        fontSize: '18px',
        fontVariantNumeric: 'tabular-nums',
        ...(accent ? { background: 'var(--accent-gradient)', color: 'var(--btn-primary-text)', fontWeight: 700 } : {}),
      }}
    >
      {label}
    </button>
  );
  const numberPad = (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${dpadSize}px)`, gridGap: '8px', justifyContent: 'center', flexShrink: 0 }}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => numKey(d, () => sendTextString(d), d))}
      {numKey(<BackspaceIcon />, () => sendKey('DELETE'), 'Delete')}
      {numKey('0', () => sendTextString('0'), '0')}
      {numKey('OK', () => sendKey('ENTER'), 'Enter', true)}
    </div>
  );

  // Above the pad, as on a TV remote: Back, Home, Menu.
  const systemKeys = (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
      {/* Icons only; each button still has a title and aria-label naming it */}
      <IconButton title="Back" onClick={() => sendKey('BACK')} style={NAV_KEY_STYLE}><BackIcon /></IconButton>
      <IconButton title="Home" onClick={() => sendKey('HOME')} style={NAV_KEY_STYLE}><HomeIcon /></IconButton>
      <IconButton title="Menu" onClick={() => sendKey('MENU')} style={NAV_KEY_STYLE}><MenuIcon /></IconButton>
    </div>
  );

  // Below the pad: typing, playback, and the switch between arrows and numbers.
  const actionKeys = (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
      {renderKeyboardButton(NAV_KEY_STYLE)}
      <IconButton title="Play / Pause" onClick={() => sendKey('PLAY_PAUSE')} style={NAV_KEY_STYLE}><PlayPauseIcon /></IconButton>
      <IconButton title={numpad ? 'Arrows' : 'Number pad'} onClick={() => setNumpad((n) => !n)} active={numpad} style={NAV_KEY_STYLE}>
        <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px' }}>{numpad ? '✥' : '123'}</span>
      </IconButton>
    </div>
  );

  // A slider when the target shares its media volume; otherwise the step keys. The end icons step it.
  const volumePercent = mediaVolume ? Math.round((mediaVolume.volume / (mediaVolume.maxVolume || 100)) * 100) : 0;
  const volumeControl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', maxWidth: '360px', margin: '0 auto' }}>
      <IconButton title="Volume down" onClick={() => sendKey('VOLUME_DOWN')} style={{ ...NAV_KEY_STYLE, width: 40, flexShrink: 0 }}><VolumeDownIcon /></IconButton>
      {mediaVolume && onSetVolume ? (
        <>
          <input
            type="range"
            min="0"
            max={mediaVolume.maxVolume || 100}
            value={mediaVolume.volume}
            onChange={(e) => onSetVolume('media', parseInt(e.target.value, 10))}
            className="volume-slider"
            aria-label="Volume"
            style={{
              flex: 1,
              minWidth: 0,
              opacity: mediaVolume.muted ? 0.45 : 1,
              background: `linear-gradient(to right, var(--accent-color) ${volumePercent}%, var(--slider-track) ${volumePercent}%)`,
            }}
          />
          <span style={{ width: '34px', textAlign: 'right', fontSize: '12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {volumePercent}%
          </span>
        </>
      ) : (
        <span style={{ flex: 1, textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Volume</span>
      )}
      <IconButton title="Volume up" onClick={() => sendKey('VOLUME_UP')} style={{ ...NAV_KEY_STYLE, width: 40, flexShrink: 0 }}><VolumeUpIcon /></IconButton>
    </div>
  );

  const pad = numpad ? numberPad : dpadPad;

  return wrap(
    <>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700 }}>
          Remote Input
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isMobile && <ViewModeButton landscape={forceLandscape} onToggle={() => setViewMode(forceLandscape ? 'portrait' : 'landscape')} />}
          <OverlayCloseButton onClick={onClose} />
        </div>
      </div>

      {/* Surface: D-pad (the default), touchpad (relative cursor, with a Pen switch for absolute positioning), apps */}
      <div style={{ display: 'flex', width: '100%', marginTop: '10px', border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden' }}>
        {(isMobileSurface
          ? [...(phoneTarget ? [] : [['keyboard', 'D-pad']]), ['touchpad', 'Touchpad'], ...(appsAvailable ? [['apps', 'Apps']] : [])]
          : [...(phoneTarget ? [] : [['keyboard', 'D-pad']]), ['pen', 'Pen']]
        ).map(([id, label]) => {
          // Pen is a switch inside the touchpad on a phone, so the Touchpad tab stays lit in both.
          const active = id === 'touchpad' ? mode === 'touchpad' || mode === 'pen' : mode === id;
          return (
            <button
              key={id}
              onClick={() => setMode(id as 'keyboard' | 'touchpad' | 'pen' | 'apps')}
              aria-pressed={active}
              title={id === 'pen' ? 'Pen (absolute: the cursor jumps to the touched spot)' : label}
              style={{
                flex: 1,
                background: active ? 'var(--accent-color, #009bd5)' : 'rgba(255,255,255,0.05)',
                color: active ? '#000' : 'var(--text-color)',
                border: 'none',
                padding: '8px 10px',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

        {/* Receives the soft keyboard's text. Invisible: the Keyboard button opens it. */}
        <input
          ref={inputRef}
          type="text"
          value={typedText}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsKeyboardActive(true)}
          onBlur={() => setIsKeyboardActive(false)}
          tabIndex={-1}
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: '1px', height: '1px' }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />

        {/* Apps: everything the target can launch. Tap to open; the star adds it to the D-pad's favourites. */}
        {mode === 'apps' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px', width: '100%', flex: 1, minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span>
                {appsLoading && apps.length === 0 ? 'Loading apps…' : `${apps.length} app${apps.length === 1 ? '' : 's'} · tap to open, ☆ to add to the D-pad`}
              </span>
              <button onClick={refreshApps} style={{ ...actionButtonStyle, padding: '4px 10px' }}>Refresh</button>
            </div>
            {apps.length === 0 && !appsLoading && (
              <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', textAlign: 'center', padding: '24px 12px', lineHeight: 1.6 }}>
                No apps received. The device must be connected and must allow Remote Input for this device.
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: '8px', alignContent: 'start' }}>
              {apps.map((app) => (
                <div key={app.package} style={{ position: 'relative' }}>
                  <button
                    onClick={() => launchApp(app.package)}
                    title={`Open ${app.label}`}
                    aria-label={`Open ${app.label}`}
                    style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', padding: '12px 6px 8px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '10px', color: 'var(--text-color)', fontSize: '11.5px', cursor: 'pointer' }}
                  >
                    {appIcon(app, 40)}
                    <span style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{app.label}</span>
                  </button>
                  <button
                    onClick={() => togglePin(app)}
                    title={isPinned(app.package) ? 'Remove from the D-pad' : 'Add to the D-pad'}
                    aria-label={isPinned(app.package) ? `Remove ${app.label} from favourites` : `Add ${app.label} to favourites`}
                    aria-pressed={isPinned(app.package)}
                    style={{ position: 'absolute', top: 2, right: 2, width: 26, height: 26, background: 'transparent', border: 'none', color: isPinned(app.package) ? '#fbbf24' : 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                  >
                    {isPinned(app.package) ? '★' : '☆'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Touchpad: a relative cursor on the TV, like the PC's Remote Input */}
        {mode === 'touchpad' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginTop: '10px', width: '100%', flex: 1, minHeight: 0 }}>
            {phoneTarget && favouriteApps}
            <div
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
              style={{
                width: '100%',
                flex: 1,
                minHeight: 0,
                touchAction: 'none',
                border: '1.5px dashed var(--border-color)',
                borderRadius: '12px',
                background: 'rgba(255,255,255,0.01)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: '13px',
                lineHeight: 1.6,
                padding: '0 12px',
              }}
            >
              <span>
                Drag to move the cursor on the TV • Tap to click<br />
                Two-finger tap to right-click • Two-finger drag to scroll<br />
                Press &amp; hold to click-drag
              </span>
            </div>
            {/* Two rows in portrait (clicks and pen, then keyboard, back and home); one row sideways */}
            <div style={{ width: '100%', display: 'grid', gridTemplateColumns: toolbarColumns, gap: '8px' }}>
              {renderKeyboardButton(cell(3))}
              <IconButton title="Left Click" onClick={() => linkApi?.sendMouseClick(deviceId, 'left')} style={cell(3)}><LeftClickIcon /></IconButton>
              <IconButton title="Middle Click (press and hold on the TV)" onClick={() => linkApi?.sendMouseClick(deviceId, 'middle')} style={cell(3)}><MiddleClickIcon /></IconButton>
              <IconButton title="Right Click (Back on the TV)" onClick={() => linkApi?.sendMouseClick(deviceId, 'right')} style={cell(3)}><RightClickIcon /></IconButton>
              <IconButton title="Pen (the cursor jumps to the touched spot)" onClick={() => setMode('pen')} style={cell(4)}><PenIcon /></IconButton>
              <IconButton title="Back" onClick={() => sendKey('BACK')} style={cell(4)}><BackIcon /></IconButton>
              <IconButton title="Home" onClick={() => sendKey('HOME')} style={cell(4)}><HomeIcon /></IconButton>
            </div>
          </div>
        )}

        {/* Pen: absolute positioning on the target's screen. A switch back to the touchpad on a phone. */}
        {mode === 'pen' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginTop: '10px', width: '100%', ...(isMobile ? { flex: 1, minHeight: 0 } : {}) }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>
              Draw here to position the cursor (absolute mapping to target screen)
            </div>
            <div
              ref={canvasRef}
              onPointerDown={handlePenPointerDown}
              onPointerMove={handlePenPointerMove}
              onPointerUp={handlePenPointerUp}
              onPointerCancel={handlePenPointerUp}
              style={{
                width: '100%',
                ...(isMobile ? { flex: 1, minHeight: 0 } : { height: '160px' }),
                touchAction: 'none',
                border: '1.5px dashed var(--border-color)',
                borderRadius: '12px',
                background: 'rgba(255,255,255,0.01)',
              }}
            />
            <div style={{ width: '100%', display: 'grid', gridTemplateColumns: toolbarColumns, gap: '8px' }}>
              {renderKeyboardButton(cell(3))}
              {isMobileSurface && <IconButton title="Mouse (relative touchpad)" onClick={() => setMode('touchpad')} style={cell(3)}><MouseIcon /></IconButton>}
              <IconButton title="Undo" onClick={() => sendPenAction('undo')} style={cell(3)}><UndoIcon /></IconButton>
              <IconButton title="Redo" onClick={() => sendPenAction('redo')} style={cell(3)}><RedoIcon /></IconButton>
              <button onClick={() => linkApi?.cycleTargetDisplay?.(deviceId)} style={{ ...actionButtonStyle, ...cell(4) }}>
                Screen ⇆
              </button>
              <IconButton title="Back" onClick={() => sendKey('BACK')} style={cell(4)}><BackIcon /></IconButton>
              <IconButton title="Home" onClick={() => sendKey('HOME')} style={cell(4)}><HomeIcon /></IconButton>
            </div>
          </div>
        )}

        {mode === 'keyboard' &&
          (sideways ? (
            // Sideways there is little height: the pad on the left, favourites and the keys beside it.
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '24px', marginTop: '6px', width: '100%', flex: 1, minHeight: 0 }}>
              {pad}
              <div style={{ flex: 1, minWidth: 0, maxHeight: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', justifyContent: 'center' }}>
                {favouriteApps}
                {systemKeys}
                {actionKeys}
                {volumeControl}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', marginTop: '6px', width: '100%', ...(isMobile ? { flex: 1, minHeight: 0, justifyContent: 'center' } : {}) }}>
              {favouriteApps}
              {systemKeys}
              {pad}
              {actionKeys}
              {volumeControl}
            </div>
          ))}
    </>
  );
};





const iconProps = {
  viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

const BackIcon: React.FC = () => (
  <svg {...iconProps}><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
);

const HomeIcon: React.FC = () => (
  <svg {...iconProps}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
);

const VolumeDownIcon: React.FC = () => (
  <svg {...iconProps}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
);

const VolumeUpIcon: React.FC = () => (
  <svg {...iconProps}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
);

const MenuIcon: React.FC = () => (
  <svg {...iconProps}><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
);

const BackspaceIcon: React.FC = () => (
  <svg {...iconProps} width={18} height={18}><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" /><line x1="18" y1="9" x2="12" y2="15" /><line x1="12" y1="9" x2="18" y2="15" /></svg>
);

const PlayPauseIcon: React.FC = () => (
  <svg {...iconProps}><polygon points="5 3 19 12 5 21 5 3" /></svg>
);

const dpadButtonStyle: React.CSSProperties = {
  width: '54px',
  height: '54px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid var(--border-color)',
  borderRadius: '10px',
  fontSize: '15px',
  color: 'var(--text-color)',
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'background 0.15s ease',
};

// The D-pad screen's icon-only keys: a fixed size so the row wraps evenly.
const NAV_KEY_STYLE: React.CSSProperties = { width: 48, height: 40, padding: 0 };

const actionButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: '12px',
  background: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid var(--border-color)',
  borderRadius: '6px',
  color: 'var(--text-color)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

export default RemoteKeyboardOverlay;
