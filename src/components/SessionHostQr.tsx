import React from 'react';

interface SessionHostQrProps {
  qrDataUrl: string | null;
  ipAddress: string | null | undefined;
  altText: string;
  subtitle: string;
}

export const SessionHostQr: React.FC<SessionHostQrProps> = ({
  qrDataUrl,
  ipAddress,
  altText,
  subtitle,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
      {qrDataUrl ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: '#fff', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
            <img src={qrDataUrl} alt={altText} style={{ display: 'block', width: '140px', height: '140px', imageRendering: 'pixelated' }} />
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)' }}>
            {ipAddress || 'unknown'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
            {subtitle}
          </div>
        </div>
      ) : (
        <div style={{ width: '140px', height: '140px', background: 'rgba(0,0,0,0.05)', borderRadius: '8px' }} />
      )}
    </div>
  );
};
