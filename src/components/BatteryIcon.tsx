import React from 'react';

interface BatteryIconProps {
  level: number;
  charging?: boolean;
}

// At or below this a battery that is not charging is drawn red.
const LOW_LEVEL = 15;

/**
 * A battery filled to its level, then the percentage. While charging, a green bolt sits before
 * the battery (a bolt drawn inside a battery this small is unreadable).
 */
export const BatteryIndicator: React.FC<BatteryIconProps> = ({ level, charging }) => {
  const pct = Math.max(0, Math.min(100, Math.round(level)));
  const low = pct <= LOW_LEVEL && !charging;
  const tone = low ? '#ef4444' : charging ? 'var(--active-dot, #10b981)' : 'var(--text-muted)';
  // The fill area is 18 units wide inside a 25x12 drawing; a sliver stays visible above 0%.
  const fillWidth = pct === 0 ? 0 : Math.max(1.5, 18 * (pct / 100));
  return (
    <span
      title={`Battery ${pct}%${charging ? ', charging' : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: low ? '#ef4444' : 'var(--text-muted)', fontSize: '11.5px', fontWeight: 500, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
    >
      {charging && (
        <svg viewBox="0 0 10 14" width="7" height="10" aria-hidden style={{ flexShrink: 0 }}>
          <path d="M6.2 0.5 1 7.8h3.3L3.5 13.5 9 6H5.6z" fill="var(--active-dot, #10b981)" />
        </svg>
      )}
      <svg viewBox="0 0 25 12" width="24" height="12" aria-hidden style={{ flexShrink: 0 }}>
        <rect x="0.6" y="0.6" width="21.3" height="10.8" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
        <path d="M23.2 4.2v3.6c0.8-0.3 1.3-1 1.3-1.8s-0.5-1.5-1.3-1.8z" fill="currentColor" fillOpacity="0.55" />
        {fillWidth > 0 && <rect x="2.3" y="2.3" width={fillWidth} height="7.4" rx="1.6" fill={tone} />}
      </svg>
      <span>{pct}%</span>
    </span>
  );
};
