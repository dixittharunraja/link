import React from 'react';
import Logo from './shared/Logo';
import LocalDeviceCard from './shared/LocalDeviceCard';
import { IS_ANDROID } from '../utils/platform';

interface TopBarProps {
  deviceName?: string;
  ipAddress?: string;
  ipAddresses?: string[];
  isMobile?: boolean;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

const TopBar: React.FC<TopBarProps> = ({
  deviceName = '',
  ipAddress,
  ipAddresses,
  isMobile = IS_ANDROID,
  isSidebarCollapsed = false,
  onToggleSidebar,
}) => {
  return (
    <header
      className="top-bar"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        flexShrink: 0,
        boxSizing: 'border-box',
      }}
    >
      {/* Left: Sidebar Toggle + Brand Logo */}
      <div
        className="brand-group"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        {onToggleSidebar && !isMobile && (
          <div className="sidebar-toggle-wrapper">
            <button
              type="button"
              onClick={onToggleSidebar}
              title={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label="Toggle sidebar"
              className="sidebar-toggle-btn"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {isSidebarCollapsed ? (
                  <>
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M9 3v18" />
                    <path d="m14 9 3 3-3 3" />
                  </>
                ) : (
                  <>
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M9 3v18" />
                    <path d="m16 15-3-3 3-3" />
                  </>
                )}
              </svg>
            </button>
          </div>
        )}

        <div
          className="brand"
          style={{
            margin: 0,
            padding: 0,
            paddingLeft: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Logo size={17} showText={true} />
        </div>
      </div>

      {/* Center Spacer */}
      <div style={{ flex: 1, minWidth: '8px' }} />

      {/* Local device identity on Right */}
      <div className="topbar-device-card" style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginLeft: 'auto' }}>
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
