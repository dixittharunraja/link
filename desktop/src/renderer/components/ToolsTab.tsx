import React, { useEffect, useState } from 'react';
import AudioSinkTab from './AudioSinkTab';
import RemoteMicTab from './RemoteMicTab';
import FileTransferTab from './FileTransferTab';
import JoystickTab from './JoystickTab';
import { pushBackHandler } from '../backNav';

type ToolId = 'audio-sink' | 'remote-mic' | 'file-transfer' | 'walkie-talkie' | 'joystick';

interface PeerDevice {
  deviceId: string;
  name: string;
  deviceType?: string;
  connected?: boolean;
  trusted: boolean;
}

interface ToolsTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  /** Walkie Talkie's own session (RTCPeerConnections, the mixing AudioContext, sessionId/members)
   *  lives entirely in WalkieTalkieTab's own React state/refs, with no main-process-side session
   *  object to resync from on remount — so unlike the other four tools, it can't be conditionally
   *  mounted here at all (that would tear an active session down every time this whole tab is
   *  navigated away from, same as it used to on Tools-modal close). App.tsx keeps it permanently
   *  mounted instead and hands down just what this component needs to render its card/badge and
   *  open its modal. */
  walkieTalkieActive: boolean;
  onOpenWalkieTalkie: () => void;
}

const TOOLS: { id: ToolId; title: string; description: string; icon: React.ReactNode }[] = [
  {
    id: 'audio-sink',
    title: 'Audio Sink',
    description: 'Stream audio from any device to any device — listen together, each on your own earphones.',
    icon: (
      <svg viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>
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
    description: 'Use your phone as an Xbox/PlayStation-style game controller for your PC — up to 4 friends at once.',
    icon: (
      <svg viewBox="0 0 24 24">
        <line x1="6" y1="12" x2="10" y2="12" /><line x1="8" y1="10" x2="8" y2="14" />
        <circle cx="15" cy="13" r="1" /><circle cx="18" cy="11" r="1" />
        <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.152A4 4 0 0 0 17.32 5z" />
      </svg>
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
    id: 'walkie-talkie',
    title: 'Walkie Talkie',
    description: 'Real-time two-way voice communication with multiple devices on the local network.',
    icon: (
      <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
    ),
  },
];

export const ToolModalHeader: React.FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text-color)', margin: 0 }}>
      {title}
    </h2>
    <button
      onClick={onClose}
      aria-label="Close"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '30px', height: '30px', minWidth: '30px', borderRadius: '50%',
        padding: 0, fontSize: '16px', background: 'rgba(255, 255, 255, 0.08)',
        border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.16)';
        e.currentTarget.style.color = 'var(--text-color)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
        e.currentTarget.style.color = 'var(--text-muted)';
      }}
    >
      &times;
    </button>
  </div>
);

const linkApi = (window as any).link;

const ToolsTab: React.FC<ToolsTabProps> = ({ peers, localIdentity, isMobile, walkieTalkieActive, onOpenWalkieTalkie }) => {
  const [selected, setSelected] = useState<ToolId | null>(null);
  const [activeTools, setActiveTools] = useState<Record<Exclude<ToolId, 'walkie-talkie'>, boolean>>({
    'audio-sink': false,
    'remote-mic': false,
    'file-transfer': false,
    'joystick': false,
  });

  const checkActiveTools = () => {
    if (!linkApi) return;
    // Promise.resolve(...) rather than chaining .then() straight onto the optional call — see
    // AudioSinkTab.tsx/RemoteMicTab.tsx's own identical comment for why an unguarded chain here
    // is a real (if lower-severity, since this runs on a timer rather than during an effect body)
    // crash risk if either method were ever missing from a given platform's bridge.
    Promise.resolve(linkApi.getAudioSinkStatus?.()).then((status: any) => {
      setActiveTools((prev) => ({ ...prev, 'audio-sink': !!(status?.hosting || status?.listening) }));
    }).catch(() => {});

    // Desktop's getRemoteMicStatus reports `streaming` (it's only ever the listener), while
    // Android's reports `hosting` (it's only ever the host) — neither platform emits both fields,
    // so the badge needs to check for either, the same way the Audio Sink check above already
    // unions hosting/listening (whose field names DO happen to match across both platforms).
    // Checking `streaming` alone here is exactly why this badge never lit up on Android.
    Promise.resolve(linkApi.getRemoteMicStatus?.()).then((status: any) => {
      setActiveTools((prev) => ({ ...prev, 'remote-mic': !!(status?.hosting || status?.streaming) }));
    }).catch(() => {});

    Promise.resolve(linkApi.getPortalStatus?.()).then((status: any) => {
      // `receiving` alone would keep this badge lit for the entire "Receive Files" session
      // (it stays armed between transfers so a second sender can connect without a restart) —
      // `transferring` is specifically "bytes are flowing right now", which is what "ACTIVE" here
      // should actually mean. `sending` already turns off correctly once a send completes (the
      // client disconnects itself), so it doesn't need the same distinction.
      setActiveTools((prev) => ({ ...prev, 'file-transfer': !!(status?.transferring || status?.sending) }));
    }).catch(() => {});

    Promise.resolve(linkApi.getJoystickStatus?.()).then((status: any) => {
      const hasControllers = status?.connectedControllers && status.connectedControllers.length > 0;
      setActiveTools((prev) => ({ ...prev, 'joystick': !!hasControllers }));
    }).catch(() => {});

    // Walkie Talkie has no main-process session to poll — App.tsx keeps WalkieTalkieTab.tsx
    // permanently mounted and passes its inSession state down as walkieTalkieActive instead.
  };

  useEffect(() => {
    checkActiveTools();
    const interval = setInterval(checkActiveTools, 2000);
    return () => clearInterval(interval);
  }, []);

  // Claim the hardware back button while a tool modal is open, so it closes the modal
  // instead of falling through to App.tsx's tab-level handling (or minimizing the app).
  useEffect(() => {
    if (!selected) return;
    return pushBackHandler(() => {
      setSelected(null);
      return true;
    });
  }, [selected]);

  const selectedTool = selected ? TOOLS.find((t) => t.id === selected) : null;

  return (
    <div id="tab-tools" className="tab-content active">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '18px' }}>
        {TOOLS.map((tool) => {
          const isActive = tool.id === 'walkie-talkie' ? walkieTalkieActive : activeTools[tool.id];
          return (
            <div
              key={tool.id}
              className="card"
              onClick={() => (tool.id === 'walkie-talkie' ? onOpenWalkieTalkie() : setSelected(tool.id))}
              style={{ cursor: 'pointer', margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', position: 'relative' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="tool-icon">
                  {tool.icon}
                </div>
                {isActive && (
                  <div
                    title="Active in background"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--active-dot, #10b981)',
                      background: 'rgba(16, 185, 129, 0.12)',
                      padding: '4px 8px',
                      borderRadius: '12px',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                    }}
                  >
                    <span
                      style={{
                        width: '7px',
                        height: '7px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--active-dot, #10b981)',
                        boxShadow: '0 0 8px #10b981',
                      }}
                    />
                    ACTIVE
                  </div>
                )}
              </div>
              <div className="card-title" style={{ marginBottom: 0 }}>{tool.title}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.5 }}>
                {tool.description}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tool Modal Popup Overlay — Walkie Talkie is never 'selected' here at all (its card opens
          App.tsx's own permanently-mounted instance instead, see onOpenWalkieTalkie above). */}
      {selectedTool && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            animation: 'fadeIn 0.15s ease',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '540px',
              backgroundColor: 'var(--modal-bg)',
              border: '1px solid var(--border-color)',
              borderRadius: '16px',
              padding: '20px 24px',
              boxShadow: '0 20px 50px var(--modal-shadow)',
              animation: 'scaleUp 0.15s ease',
            }}
          >
            <ToolModalHeader title={selectedTool.title} onClose={() => setSelected(null)} />

            {selected === 'audio-sink' && (
              <AudioSinkTab peers={peers} localIdentity={localIdentity} isMobile={isMobile} />
            )}

            {selected === 'remote-mic' && (
              <RemoteMicTab peers={peers} localIdentity={localIdentity} isMobile={isMobile} />
            )}

            {selected === 'file-transfer' && (
              <FileTransferTab isMobile={isMobile} localIdentity={localIdentity} />
            )}

            {selected === 'joystick' && (
              <JoystickTab localIdentity={localIdentity} isMobile={isMobile} />
            )}

            {selected !== 'audio-sink' && selected !== 'remote-mic' && selected !== 'file-transfer' && selected !== 'joystick' && (
              <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center', textAlign: 'center' }}>
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    background: 'rgba(0, 155, 213, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#009bd5',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div style={{ color: 'var(--text-color)', fontSize: '13.5px', fontWeight: 600 }}>
                  Coming Soon
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', lineHeight: 1.6, maxWidth: '360px' }}>
                  {selectedTool.description}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ToolsTab;
