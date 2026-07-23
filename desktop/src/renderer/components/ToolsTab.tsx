import React, { useEffect, useState } from 'react';
import AudioRelayTab from './AudioRelayTab';
import RemoteMicTab from './RemoteMicTab';
import { pushBackHandler } from '../backNav';

type ToolId = 'audio-relay' | 'remote-mic' | 'file-transfer' | 'joystick';

interface PeerDevice {
  deviceId: string;
  name: string;
  connected?: boolean;
  trusted: boolean;
}

interface ToolsTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string };
  isMobile: boolean;
}

const TOOLS: { id: ToolId; title: string; description: string; icon: React.ReactNode }[] = [
  {
    id: 'audio-relay',
    title: 'Audio Relay',
    description: 'Stream audio from any device to any device — listen together, each on your own earphones.',
    icon: (
      <svg viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>
    ),
  },
  {
    id: 'remote-mic',
    title: 'Remote Mic',
    description: 'Use your mobile device as a high-quality wireless microphone for your computer.',
    icon: (
      <svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>
    ),
  },
  {
    id: 'file-transfer',
    title: 'File Transfer',
    description: 'Send a file to an untrusted device.',
    icon: (
      <svg viewBox="0 0 24 24"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></svg>
    ),
  },
  {
    id: 'joystick',
    title: 'Joystick',
    description: 'Use your phone’s touch controls and motion sensors as a game controller for your PC.',
    icon: (
      <svg viewBox="0 0 24 24">
        <line x1="6" y1="12" x2="10" y2="12" /><line x1="8" y1="10" x2="8" y2="14" />
        <circle cx="15" cy="13" r="1" /><circle cx="18" cy="11" r="1" />
        <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.152A4 4 0 0 0 17.32 5z" />
      </svg>
    ),
  },
];

const ToolHeader: React.FC<{ title: string; onBack: () => void }> = ({ title, onBack }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '22px' }}>
    <button
      onClick={onBack}
      aria-label="Back"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '36px', height: '36px', minWidth: '36px', borderRadius: '50%',
        padding: 0, fontSize: '16px',
      }}
    >
      &larr;
    </button>
    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text-color)', margin: 0 }}>
      {title}
    </h2>
  </div>
);

const ToolsTab: React.FC<ToolsTabProps> = ({ peers, localIdentity, isMobile }) => {
  const [selected, setSelected] = useState<ToolId | null>(null);

  // Claim the hardware back button while a tool sub-view is open, so it closes the sub-view
  // instead of falling through to App.tsx's tab-level handling (or minimizing the app).
  useEffect(() => {
    if (!selected) return;
    return pushBackHandler(() => {
      setSelected(null);
      return true;
    });
  }, [selected]);

  if (selected === 'audio-relay') {
    return (
      <div id="tab-tools" className="tab-content active">
        <ToolHeader title="Audio Relay" onBack={() => setSelected(null)} />
        <AudioRelayTab peers={peers} localIdentity={localIdentity} isMobile={isMobile} />
      </div>
    );
  }

  if (selected === 'remote-mic') {
    return (
      <div id="tab-tools" className="tab-content active">
        <ToolHeader title="Remote Mic" onBack={() => setSelected(null)} />
        <RemoteMicTab peers={peers} localIdentity={localIdentity} isMobile={isMobile} />
      </div>
    );
  }

  if (selected) {
    const tool = TOOLS.find((t) => t.id === selected)!;
    return (
      <div id="tab-tools" className="tab-content active">
        <ToolHeader title={tool.title} onBack={() => setSelected(null)} />
        <div className="card">
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.6 }}>
            {tool.description}
            <br />
            <br />
            This is being designed right now &mdash; not wired up yet. Placeholder so we can iterate on the flow.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="tab-tools" className="tab-content active">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '18px' }}>
        {TOOLS.map((tool) => (
          <div
            key={tool.id}
            className="card"
            onClick={() => setSelected(tool.id)}
            style={{ cursor: 'pointer', margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <div className="tool-icon">
              {tool.icon}
            </div>
            <div className="card-title" style={{ marginBottom: 0 }}>{tool.title}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.5 }}>
              {tool.description}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ToolsTab;
