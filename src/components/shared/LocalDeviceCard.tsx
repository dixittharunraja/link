import React, { useState, useRef, useEffect } from 'react';

interface LocalDeviceCardProps {
  deviceName: string;
  ipAddress?: string;
  ipAddresses?: string[];
  className?: string;
  style?: React.CSSProperties;
}

const LocalDeviceCard: React.FC<LocalDeviceCardProps> = ({
  deviceName,
  ipAddress,
  ipAddresses,
  className = '',
  style,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isOnline = Boolean(ipAddress && ipAddress !== '127.0.0.1' && ipAddress !== 'No IP Detected');
  const validIps = (ipAddresses && ipAddresses.length > 0)
    ? ipAddresses.filter((ip) => ip !== '127.0.0.1')
    : (isOnline ? [ipAddress!] : []);
  
  const displayIp = validIps.length > 0 ? validIps[0] : (ipAddress || 'No IP Detected');
  const extraIpsCount = Math.max(0, validIps.length - 1);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div
      ref={containerRef}
      className={`local-device-card-wrapper ${className}`}
      style={{ position: 'relative', display: 'inline-flex', ...style }}
    >
      <div
        className={`local-device-card ${isOpen ? 'active-open' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        style={{
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div className={`status-dot ${isOnline ? '' : 'status-offline'}`} />
        <div className="device-details">
          <span id="header-device-name" title={deviceName}>{deviceName || 'Loading...'}</span>
          <span id="header-device-ip">
            {displayIp}
            {extraIpsCount > 0 && (
              <span style={{ marginLeft: '4px', fontSize: '10px', opacity: 0.65, fontWeight: 500 }}>
                (+{extraIpsCount})
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Popover Menu with List of All IPs */}
      {isOpen && (
        <div className="device-ip-popover" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="device-ip-popover-list">
            {validIps.length > 0 ? (
              validIps.map((ip) => (
                <div key={ip} className="device-ip-popover-item">
                  <span className="popover-ip-text">{ip}</span>
                </div>
              ))
            ) : (
              <div className="device-ip-popover-empty">No active network IP found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LocalDeviceCard;
