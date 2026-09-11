import React from 'react';

interface AudioListenerRowProps {
  label: string;
  icon?: React.ReactNode;
  iconBg?: string;
  iconColor?: string;
  statusText?: string;
  statusColor?: string;
  onKick?: () => void;
  onBlock?: () => void;
}

export const AudioListenerRow: React.FC<AudioListenerRowProps> = ({
  label,
  icon,
  iconBg = 'rgba(16, 185, 129, 0.1)',
  iconColor = '#10b981',
  statusText = 'Streaming',
  statusColor = '#10b981',
  onKick,
  onBlock,
}) => {
  return (
    <div
      className="peer-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '10px 14px',
        background: 'var(--input-bg)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        <div
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: iconBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: iconColor,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>{label}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{statusText}</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
        {onKick && (
          <button
            onClick={onKick}
            style={{ padding: '5px 12px', fontSize: '11.5px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
          >
            Kick
          </button>
        )}
        {onBlock && (
          <button
            onClick={onBlock}
            style={{ padding: '5px 12px', fontSize: '11.5px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
          >
            Block
          </button>
        )}
      </div>
    </div>
  );
};

export interface HostActionButtonsProps {
  muted: boolean;
  onToggleMute: () => void;
  leaveLabel?: string;
  onLeave?: () => void;
}

export const HostActionButtons: React.FC<HostActionButtonsProps> = ({
  muted,
  onToggleMute,
  leaveLabel = 'End Session',
  onLeave,
}) => (
  <div style={{ display: 'flex', gap: '8px' }}>
    <button
      onClick={onToggleMute}
      style={{
        padding: '6px 12px',
        borderRadius: '6px',
        border: muted ? '1px solid var(--accent-color, #009bd5)' : '1px solid var(--border-color)',
        background: muted ? 'rgba(0, 155, 213, 0.1)' : 'transparent',
        color: muted ? 'var(--accent-color, #009bd5)' : 'var(--text-color)',
        fontSize: '12px',
        cursor: 'pointer',
        fontWeight: 500,
      }}
    >
      {muted ? 'Unmute' : 'Mute'}
    </button>
    {onLeave && (
      <button
        onClick={onLeave}
        style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: '12px', cursor: 'pointer', fontWeight: 500, flexShrink: 0 }}
      >
        {leaveLabel}
      </button>
    )}
  </div>
);

export const HostFooterBar: React.FC<HostActionButtonsProps> = (props) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
    <HostActionButtons {...props} />
  </div>
);

