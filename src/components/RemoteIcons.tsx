import React from 'react';

const iconProps = {
  viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

export const PenIcon: React.FC = () => (
  <svg {...iconProps}>
    <rect x="2" y="4" width="20" height="16" rx="3" />
    <rect x="5" y="7" width="10" height="10" rx="1" strokeDasharray="1.5 1.5" opacity="0.6" />
    <path d="M19 7l-4 4 1.5 1.5 4-4L19 7z" fill="var(--accent-color, #009bd5)" stroke="var(--accent-color, #009bd5)" strokeWidth="1" />
    <path d="M15 11l-2 3.5 3.5-2" fill="var(--accent-color, #009bd5)" stroke="var(--accent-color, #009bd5)" strokeWidth="1" />
  </svg>
);

export const MouseIcon: React.FC = () => (
  <svg {...iconProps}><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" /></svg>
);

export const KeyboardIcon: React.FC = () => (
  <svg {...iconProps}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h12" /></svg>
);

export const UndoIcon: React.FC = () => (
  <svg {...iconProps}><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>
);

export const RedoIcon: React.FC = () => (
  <svg {...iconProps}><polyline points="15 14 20 9 15 4" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" /></svg>
);

const MouseBase: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <svg {...iconProps}>
    <rect x="5" y="2" width="14" height="20" rx="7" />
    <line x1="12" y1="2" x2="12" y2="10" />
    <line x1="5" y1="10" x2="19" y2="10" />
    {children}
  </svg>
);

export const LeftClickIcon: React.FC = () => (
  <MouseBase>
    <path d="M5 9V9a7 7 0 0 1 7-7v8H5z" fill="var(--accent-color, #009bd5)" stroke="var(--accent-color, #009bd5)" strokeWidth={1.5} />
  </MouseBase>
);

export const MiddleClickIcon: React.FC = () => (
  <MouseBase>
    <rect x="10.5" y="4" width="3" height="6" rx="1.5" fill="var(--accent-color, #009bd5)" stroke="var(--accent-color, #009bd5)" strokeWidth={1} />
  </MouseBase>
);

export const RightClickIcon: React.FC = () => (
  <MouseBase>
    <path d="M12 2a7 7 0 0 1 7 7v1h-7V2z" fill="var(--accent-color, #009bd5)" stroke="var(--accent-color, #009bd5)" strokeWidth={1.5} />
  </MouseBase>
);

// keepFocus stops the press from taking focus, so a focused text field (and its soft keyboard)
// is still focused when onClick runs.
export const IconButton: React.FC<{ title: string; onClick: () => void; active?: boolean; keepFocus?: boolean; style?: React.CSSProperties; children: React.ReactNode }> = ({ title, onClick, active, keepFocus, style, children }) => (
  <button
    onClick={onClick}
    onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
    onPointerDown={keepFocus ? (e) => e.preventDefault() : undefined}
    title={title}
    aria-label={title}
    style={{
      padding: '10px 4px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: active ? 'var(--accent-color, #009bd5)' : 'rgba(255,255,255,0.03)',
      color: active ? '#000' : '#fff',
      border: '1px solid var(--border-color)',
      borderRadius: '8px',
      boxShadow: active ? '0 0 12px var(--accent-color)' : 'none',
      transition: 'all 0.15s ease',
      ...style,
    }}
  >
    {children}
  </button>
);

// Switches a full-screen remote surface between portrait and landscape by hand. Shows the layout
// it will switch to.
export const ViewModeButton: React.FC<{ landscape: boolean; onToggle: () => void }> = ({ landscape, onToggle }) => (
  <button
    onClick={onToggle}
    title={landscape ? 'Switch to portrait' : 'Switch to landscape'}
    aria-label={landscape ? 'Switch to portrait' : 'Switch to landscape'}
    style={{
      display: 'flex', alignItems: 'center', gap: '6px',
      background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)',
      color: 'var(--text-color)', cursor: 'pointer', padding: '6px', borderRadius: '6px',
    }}
  >
    {/* Icon only: the labelled version pushed the header row off narrow screens. The title and
        aria-label above still name it. */}
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {landscape ? <rect x="7" y="3" width="10" height="18" rx="2" /> : <rect x="3" y="7" width="18" height="10" rx="2" />}
    </svg>
  </button>
);

// Exit as an icon for an overlay's top-right corner.
export const OverlayCloseButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    title="Exit"
    aria-label="Exit"
    style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.5)',
      color: '#ef4444', cursor: 'pointer', padding: '6px', borderRadius: '6px',
    }}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>
);

