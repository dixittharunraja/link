import React from 'react';

interface LogoProps {
  size?: number;
  className?: string;
  showText?: boolean;
  textClassName?: string;
  withBackground?: boolean;
}

const Logo: React.FC<LogoProps> = ({
  size = 28,
  className = '',
  showText = false,
  textClassName = '',
  withBackground = false,
}) => {
  const svgWidth = withBackground ? size : Math.round(size * 1.15);
  const svgHeight = size;
  const viewBox = withBackground ? "0 0 512 512" : "70 90 372 332";

  return (
    <div className={`flex items-center gap-2 ${className}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={viewBox}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <linearGradient id="linkLogoBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#000000" />
            <stop offset="100%" stopColor="#050811" />
          </linearGradient>

          <filter id="linkLogoGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="10" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>

          <radialGradient id="linkLogoEndpointGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="35%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="65%" stopColor="#38bdf8" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#0EA5E9" stopOpacity="0" />
          </radialGradient>
          
          <linearGradient id="linkLogoPulseGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0284c7" />
            <stop offset="50%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#0284c7" />
          </linearGradient>
        </defs>

        {/* Base App Rounded Rect */}
        {withBackground && (
          <rect width="512" height="512" rx="115" fill="url(#linkLogoBgGrad)" stroke="rgba(14, 165, 233, 0.3)" strokeWidth="8" />
        )}

        {/* Outer Glow */}
        <path
          d="M 100 256 L 180 256 L 220 140 L 280 380 L 330 256 L 412 256"
          fill="none"
          stroke="#0EA5E9"
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#linkLogoGlow)"
          strokeOpacity="0.5"
        />
        
        {/* Neon Gradient Core */}
        <path
          d="M 100 256 L 180 256 L 220 140 L 280 380 L 330 256 L 412 256"
          fill="none"
          stroke="url(#linkLogoPulseGrad)"
          strokeWidth="16"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        
        {/* Pure White Center Hotspot */}
        <path
          d="M 100 256 L 180 256 L 220 140 L 280 380 L 330 256 L 412 256"
          fill="none"
          stroke="#ffffff"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Glowing Endpoints */}
        <circle cx="100" cy="256" r="18" fill="url(#linkLogoEndpointGlow)" />
        <circle cx="100" cy="256" r="3.5" fill="#ffffff" />

        <circle cx="412" cy="256" r="18" fill="url(#linkLogoEndpointGlow)" />
        <circle cx="412" cy="256" r="3.5" fill="#ffffff" />
      </svg>

      {showText && (
        <span
          className={`brand-title ${textClassName}`}
        >
          Link
        </span>
      )}
    </div>
  );
};

export default Logo;
