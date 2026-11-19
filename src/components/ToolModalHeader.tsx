import React from 'react';
import { ModalCloseButton } from './DialogCard';

// Its own module so App.tsx can show the Walkie Talkie header without pulling the lazily loaded ToolsTab chunk.
export const ToolModalHeader: React.FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text-color)', margin: 0 }}>
      {title}
    </h2>
    <ModalCloseButton onClose={onClose} />
  </div>
);
