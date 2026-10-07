import React from 'react';

interface LogoProps {
  size?: number;
  className?: string;
  showText?: boolean;
  textClassName?: string;
}

export const Logo: React.FC<LogoProps> = ({
  size = 28,
  className = '',
  showText = false,
  textClassName = '',
}) => {
  return (
    <div className={`flex items-center gap-2.5 ${className}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 512 512"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <linearGradient id="linkLogoBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#000000" />
            <stop offset="100%" stopColor="#02040a" />
          </linearGradient>

          <filter id="linkLogoGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="12" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>

          <radialGradient id="linkLogoEndpointGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="35%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="70%" stopColor="#00f0ff" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#00f0ff" stopOpacity="0" />
          </radialGradient>
          
          <linearGradient id="linkLogoPulseGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0044ff" />
            <stop offset="50%" stopColor="#00f0ff" />
            <stop offset="100%" stopColor="#0044ff" />
          </linearGradient>
        </defs>

        {/* Base App Rounded Rect */}
        <rect width="512" height="512" rx="115" fill="url(#linkLogoBgGrad)" stroke="rgba(0, 155, 213, 0.25)" strokeWidth="8" />

        {/* Outer Glow */}
        <path
          d="M 100 256 L 180 256 L 220 140 L 280 380 L 330 256 L 412 256"
          fill="none"
          stroke="#00f0ff"
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#linkLogoGlow)"
          strokeOpacity="0.6"
        />
        
        {/* Neon Gradient Core */}
        <path
          d="M 100 256 L 180 256 L 220 140 L 280 380 L 330 256 L 412 256"
          fill="none"
          stroke="url(#linkLogoPulseGrad)"
          strokeWidth="18"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        
        {/* Pure White Center Hotspot */}
        <path
          d="M 100 256 L 180 256 L 220 140 L 280 380 L 330 256 L 412 256"
          fill="none"
          stroke="#ffffff"
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Glowing Endpoints */}
        <circle cx="100" cy="256" r="20" fill="url(#linkLogoEndpointGlow)" />
        <circle cx="100" cy="256" r="4" fill="#ffffff" />

        <circle cx="412" cy="256" r="20" fill="url(#linkLogoEndpointGlow)" />
        <circle cx="412" cy="256" r="4" fill="#ffffff" />
      </svg>

      {showText && (
        <span
          className={`brand-title ${textClassName}`}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '18px',
            fontWeight: 700,
            letterSpacing: '-0.4px',
          }}
        >
          Link
        </span>
      )}
    </div>
  );
};

export default Logo;
