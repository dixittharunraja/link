import React from 'react';
import Logo from './shared/Logo';
import LocalDeviceCard from './shared/LocalDeviceCard';

interface TopBarProps {
  deviceName?: string;
  ipAddress?: string;
  ipAddresses?: string[];
  isMobile?: boolean;
}

const TopBar: React.FC<TopBarProps> = ({
  deviceName = '',
  ipAddress,
  ipAddresses,
  isMobile = typeof window !== 'undefined' && typeof (window as any).Capacitor !== 'undefined',
}) => {
  const isDesktop = !isMobile;

  return (
    <header
      className="top-bar"
      style={{
        paddingRight: isDesktop ? '148px' : '16px',
        WebkitAppRegion: isDesktop ? 'drag' : 'no-drag',
      } as React.CSSProperties}
    >
      {/* Brand & Logo on Left */}
      <div
        className="brand"
        style={{
          margin: 0,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <Logo size={24} showText={true} />
      </div>

      {/* Center draggable filler area */}
      <div style={{ flex: 1, height: '100%' }} />

      {/* Local device card in top right (visible in narrow screens & mobile via responsive CSS) */}
      <div
        className="topbar-device-card"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <LocalDeviceCard
          deviceName={deviceName}
          ipAddress={ipAddress}
          ipAddresses={ipAddresses}
        />
      </div>
    </header>
  );
};

export default TopBar;
