import React from 'react';

interface LocalDeviceCardProps {
  deviceName: string;
  ipAddress?: string;
  ipAddresses?: string[];
  className?: string;
  style?: React.CSSProperties;
}

export const LocalDeviceCard: React.FC<LocalDeviceCardProps> = ({
  deviceName,
  ipAddress,
  ipAddresses,
  className = '',
  style,
}) => {
  const isOnline = Boolean(ipAddress && ipAddress !== '127.0.0.1' && ipAddress !== 'No IP Detected');
  const validIps = (ipAddresses && ipAddresses.length > 0)
    ? ipAddresses.filter((ip) => ip !== '127.0.0.1')
    : (isOnline ? [ipAddress!] : []);
  
  const displayIp = validIps.length > 0 ? validIps[0] : (ipAddress || 'No IP Detected');
  const extraIpsCount = Math.max(0, validIps.length - 1);
  const tooltipText = validIps.length > 1 ? `Active interfaces:\n${validIps.join('\n')}` : undefined;

  return (
    <div
      className={`local-device-card ${className}`}
      title={tooltipText}
      style={{
        cursor: tooltipText ? 'help' : 'default',
        ...style,
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
  );
};

export default LocalDeviceCard;
