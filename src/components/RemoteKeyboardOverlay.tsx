import React, { useState, useEffect, useRef } from 'react';
import { LinkApi } from '../vite-env';
import { pushBackHandler } from '../utils/backNav';
import { PenIcon, KeyboardIcon, UndoIcon, RedoIcon } from './RemoteIcons';
import { useDigitizer } from './RemoteInputOverlay';
import { DialogCard } from './DialogCard';

interface RemoteKeyboardOverlayProps {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}

const linkApi = (window as any).link as LinkApi;

// TV-target only now — Remote Input has no phone target (see DeviceControlPanel.tsx's
// 'remoteinput' entry for why), so this overlay's D-Pad/pen surfaces are always shown.
const RemoteKeyboardOverlay: React.FC<RemoteKeyboardOverlayProps> = ({
  deviceId,
  deviceName: _deviceName,
  onClose,
}) => {
  const [typedText, setTypedText] = useState(' ');
  const isCapturing = true;
  const inputRef = useRef<HTMLInputElement>(null);
  // Digitizer (absolute pen input) used to be its own button/permission alongside Remote Input
  // for a TV target — now it's a mode within this same card instead of a separate screen: the
  // D-Pad section swaps for a pen surface in place, title/header/close button stay put.
  const [mode, setMode] = useState<'keyboard' | 'pen'>('keyboard');

  const {
    canvasRef,
    sendPenAction,
    handlePenPointerDown,
    handlePenPointerMove,
    handlePenPointerUp,
  } = useDigitizer({ deviceId, enabled: mode === 'pen' });

  useEffect(() => {
    inputRef.current?.focus();
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

    // Ctrl/Cmd shortcuts — handled as dedicated specialKeys (real AccessibilityNodeInfo
    // select-all/copy/paste/cut actions on the target), not sent as literal text.
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

  return (
    <DialogCard onCancel={onClose} maxWidth="460px" zIndex={10000}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700 }}>
            Remote Input
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={() => setMode(mode === 'pen' ? 'keyboard' : 'pen')}
              title={mode === 'pen' ? 'Keyboard mode' : 'Pen (digitizer mode)'}
              aria-label={mode === 'pen' ? 'Keyboard mode' : 'Pen (digitizer mode)'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: mode === 'pen' ? 'var(--accent-color, #009bd5)' : 'rgba(255,255,255,0.05)',
                border: '1px solid var(--border-color)',
                color: mode === 'pen' ? '#000' : 'var(--text-color)',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '6px',
              }}
            >
              {mode === 'pen' ? <KeyboardIcon /> : <PenIcon />}
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '18px',
                cursor: 'pointer',
                padding: '4px',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Live Keyboard Input Box */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-color)' }}>
            Keyboard Typing Input
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              ref={inputRef}
              type="text"
              value={typedText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Type here to sync keystrokes instantly..."
              style={{
                flexGrow: 1,
                padding: '10px 14px',
                fontSize: '13.5px',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-color)',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Visual D-Pad & Navigation Controls, or the pen surface in its place when toggled */}
        {mode === 'pen' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', marginTop: '6px' }}>
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
                height: '160px',
                touchAction: 'none',
                border: '1.5px dashed var(--border-color)',
                borderRadius: '12px',
                background: 'rgba(255,255,255,0.01)',
              }}
            />
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', width: '100%' }}>
              <button onClick={() => sendPenAction('undo')} style={actionButtonStyle}>
                <UndoIcon /> Undo
              </button>
              <button onClick={() => sendPenAction('redo')} style={actionButtonStyle}>
                <RedoIcon /> Redo
              </button>
              <button onClick={() => linkApi?.cycleTargetDisplay?.(deviceId)} style={actionButtonStyle}>
                Screen ⇆
              </button>
            </div>
          </div>
        )}
        {mode === 'keyboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', marginTop: '6px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>
              D-Pad Navigation Controls
            </div>

            {/* D-Pad Buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 54px)', gridGap: '8px', justifyContent: 'center' }}>
              <div></div>
              <button
                onClick={() => sendKey('DPAD_UP')}
                style={dpadButtonStyle}
                title="Up (ArrowUp)"
              >
                ▲
              </button>
              <div></div>

              <button
                onClick={() => sendKey('DPAD_LEFT')}
                style={dpadButtonStyle}
                title="Left (ArrowLeft)"
              >
                ◀
              </button>
              <button
                onClick={() => sendKey('DPAD_CENTER')}
                style={{ ...dpadButtonStyle, background: 'var(--accent-gradient)', color: 'var(--btn-primary-text)', fontWeight: 700 }}
                title="Select / OK (Enter)"
              >
                OK
              </button>
              <button
                onClick={() => sendKey('DPAD_RIGHT')}
                style={dpadButtonStyle}
                title="Right (ArrowRight)"
              >
                ▶
              </button>

              <div></div>
              <button
                onClick={() => sendKey('DPAD_DOWN')}
                style={dpadButtonStyle}
                title="Down (ArrowDown)"
              >
                ▼
              </button>
              <div></div>
            </div>

            {/* Special Action Buttons */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', width: '100%', marginTop: '6px' }}>
              <button onClick={() => sendKey('BACK')} style={actionButtonStyle}>
                <BackIcon /> Back (Esc)
              </button>
              <button onClick={() => sendKey('HOME')} style={actionButtonStyle}>
                <HomeIcon /> Home
              </button>
              <button onClick={() => sendKey('MENU')} style={actionButtonStyle}>
                <MenuIcon /> Menu
              </button>
              <button onClick={() => sendKey('VOLUME_DOWN')} style={actionButtonStyle}>
                <VolumeDownIcon /> Vol -
              </button>
              <button onClick={() => sendKey('VOLUME_UP')} style={actionButtonStyle}>
                <VolumeUpIcon /> Vol +
              </button>
              <button onClick={() => sendKey('PLAY_PAUSE')} style={actionButtonStyle}>
                <PlayPauseIcon /> Play / Pause
              </button>
            </div>
          </div>
        )}
    </DialogCard>
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
