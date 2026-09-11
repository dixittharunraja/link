import React from 'react';

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

// Shared row for the ~15 near-identical permission toggles in the Device Permissions dialog
// (title + description on the left, a switch on the right) — previously each was copy-pasted
// inline JSX in DevicesTab.tsx.
const ToggleRow: React.FC<ToggleRowProps> = ({ title, description, checked, onChange }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
    <div>
      <div style={{ fontSize: '13.5px', fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{description}</div>
    </div>
    <label className="switch-container" style={{ margin: 0 }}>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="slider"></span>
      </span>
    </label>
  </div>
);

export default ToggleRow;
