import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Logo from './shared/Logo';
import LocalDeviceCard from './shared/LocalDeviceCard';
import { IS_ANDROID } from '../utils/platform';

interface DesktopTitleBarProps {
  isMobile?: boolean;
  deviceName?: string;
  ipAddress?: string;
  ipAddresses?: string[];
}

const DesktopTitleBar: React.FC<DesktopTitleBarProps> = ({
  isMobile = IS_ANDROID,
  deviceName = '',
  ipAddress,
  ipAddresses,
}) => {
  const [mounted, setMounted] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (isMobile) return undefined;
    try {
      const appWindow = getCurrentWindow();
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});
      const unlistenPromise = appWindow.onResized(async () => {
        try {
          const max = await appWindow.isMaximized();
          setIsMaximized(max);
        } catch {}
      });
      return () => {
        unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      };
    } catch {
      return undefined;
    }
  }, [isMobile]);

  if (!mounted || isMobile) return null;

  const handleBack = () => {
    if (typeof window !== 'undefined') window.history.back();
  };

  const handleForward = () => {
    if (typeof window !== 'undefined') window.history.forward();
  };

  const handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  const handleMinimize = () => {
    try {
      getCurrentWindow().minimize();
    } catch (e) {
      console.error('Failed to minimize window:', e);
    }
  };

  const handleToggleMaximize = async () => {
    try {
      const appWindow = getCurrentWindow();
      const max = await appWindow.isMaximized();
      if (max) {
        await appWindow.unmaximize();
        setIsMaximized(false);
      } else {
        await appWindow.maximize();
        setIsMaximized(true);
      }
    } catch (e) {
      console.error('Failed to toggle maximize window:', e);
    }
  };

  const handleClose = () => {
    try {
      getCurrentWindow().close();
    } catch (e) {
      console.error('Failed to close window:', e);
    }
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={handleToggleMaximize}
      className="desktop-titlebar"
      style={{
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* Left: Favicon Logo + Link Name + History Navigation Controls */}
      <div
        className="titlebar-left-group"
        data-tauri-drag-region="false"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="titlebar-brand" title="Link">
          <Logo size={15} showText={true} />
        </div>

        <div className="titlebar-nav-controls">
          <button
            type="button"
            onClick={handleBack}
            title="Back"
            aria-label="Back"
            className="titlebar-btn"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={handleForward}
            title="Forward"
            aria-label="Forward"
            className="titlebar-btn"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            onClick={handleReload}
            title="Reload"
            aria-label="Reload"
            className="titlebar-btn"
          >
            <RotateCw size={13} />
          </button>
        </div>
      </div>

      {/* Middle: Draggable Empty Title Region */}
      <div data-tauri-drag-region style={{ flex: 1, height: '100%' }} />

      {/* Right: Device Identity Status Card + Window Controls */}
      <div
        className="titlebar-right-group"
        data-tauri-drag-region="false"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="titlebar-device-card">
          <LocalDeviceCard
            deviceName={deviceName}
            ipAddress={ipAddress}
            ipAddresses={ipAddresses}
          />
        </div>

        <div className="titlebar-window-controls">
          <button
            type="button"
            onClick={handleMinimize}
            title="Minimize"
            aria-label="Minimize"
            className="titlebar-win-btn"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            onClick={handleToggleMaximize}
            title={isMaximized ? 'Restore' : 'Maximize'}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
            className="titlebar-win-btn"
          >
            {isMaximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Close"
            aria-label="Close"
            className="titlebar-win-btn titlebar-win-close"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default DesktopTitleBar;
