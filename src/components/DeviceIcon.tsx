import React from 'react';

interface DeviceIconProps {
  deviceType?: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const DeviceIcon: React.FC<DeviceIconProps> = ({
  deviceType,
  size = 16,
  strokeWidth = 2.5,
  className,
  style
}) => {
  const type = deviceType?.toLowerCase() || 'phone';

  const renderPaths = () => {
    if (type === 'tablet') {
      return (
        <>
          <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
        </>
      );
    }
    if (type === 'laptop' || type === 'desktop' || type === 'pc' || type === 'computer') {
      return (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </>
      );
    }
    if (type === 'tv') {
      return (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="10" y1="21" x2="14" y2="21" />
        </>
      );
    }
    return (
      <>
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </>
    );
  };

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {renderPaths()}
    </svg>
  );
};
