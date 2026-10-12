import React, { useEffect, useState } from 'react';
import AudioSinkTab from './AudioSinkTab';
import RemoteMicTab from './RemoteMicTab';
import FileTransferTab from './FileTransferTab';
import JoystickTab from './JoystickTab';
import PresenterTab from './PresenterTab';
import RemoteInputTab from './RemoteInputTab';
import RemoteControlGuestTab from './RemoteControlGuestTab';
import { pushBackHandler } from '../utils/backNav';
import { LinkApi } from '../vite-env';
import { PeerDevice } from '../types/peer';

import { Headphones, Send, Gamepad2, Presentation, MousePointer2, Mic, Radio, MonitorSmartphone } from 'lucide-react';

type ToolId = 'audio-sink' | 'remote-mic' | 'file-transfer' | 'walkie-talkie' | 'joystick' | 'presenter' | 'remote-input' | 'remote-control';

interface ToolsTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  walkieTalkieActive: boolean;
  onOpenWalkieTalkie: () => void;
  onShowPresenter?: (deviceId: string, hostDeviceType?: string) => void;
  onShowTouchpad?: (deviceId: string) => void;
  onShowRemoteControl?: () => void;
}

const TOOLS: { id: ToolId; title: string; description: string; icon: React.ElementType }[] = [
  {
    id: 'audio-sink',
    title: 'Audio Sink',
    description: 'Stream audio from any device to any device — listen together, each on your own earphones.',
    icon: Headphones,
  },
  {
    id: 'file-transfer',
    title: 'File Transfer',
    description: 'Quickly share files with any nearby device via QR code, direct IP, or web browser without permanent pairing.',
    icon: Send,
  },
  {
    id: 'joystick',
    title: 'Joystick',
    description: 'Use your phone as an Xbox/PlayStation-style game controller for your PC — up to 4 friends at once.',
    icon: Gamepad2,
  },
  {
    id: 'presenter',
    title: 'Presenter',
    description: 'Use your phone screen as a presentation slide remote and laser pointer overlay.',
    icon: Presentation,
  },
  {
    id: 'remote-input',
    title: 'Remote Input',
    description: 'Control mouse movements, clicks, scrolling, and stylus/digitizer input on any PC or TV from your phone.',
    icon: MousePointer2,
  },
  {
    id: 'remote-control',
    title: 'Remote Control',
    description: 'View and control a PC screen from your phone, with just its IP address — nothing to pair.',
    icon: MonitorSmartphone,
  },
  {
    id: 'remote-mic',
    title: 'Remote Mic',
    description: 'Use your mobile device as a high-quality wireless microphone for your computer.',
    icon: Mic,
  },
  {
    id: 'walkie-talkie',
    title: 'Walkie Talkie',
    description: 'Real-time two-way voice communication with multiple devices on the local network.',
    icon: Radio,
  },
];

import { ModalCloseButton } from './DialogCard';

export const ToolModalHeader: React.FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text-color)', margin: 0 }}>
      {title}
    </h2>
    <ModalCloseButton onClose={onClose} />
  </div>
);

const linkApi = (window as any).link as LinkApi;

const ToolsTab: React.FC<ToolsTabProps> = ({
  peers,
  localIdentity,
  isMobile,
  walkieTalkieActive,
  onOpenWalkieTalkie,
  onShowPresenter,
  onShowTouchpad,
  onShowRemoteControl,
}) => {
  const [selected, setSelected] = useState<ToolId | null>(null);
  const [activeTools, setActiveTools] = useState<Record<Exclude<ToolId, 'walkie-talkie'>, boolean>>({
    'audio-sink': false,
    'remote-mic': false,
    'file-transfer': false,
    'joystick': false,
    'presenter': false,
    'remote-input': false,
    'remote-control': false,
  });

  const checkActiveTools = () => {
    if (!linkApi) return;
    Promise.resolve(linkApi.getAudioSinkStatus?.()).then((status: any) => {
      setActiveTools((prev) => ({ ...prev, 'audio-sink': !!(status?.hosting || status?.listening) }));
    }).catch(() => {});

    Promise.resolve(linkApi.getRemoteMicStatus?.()).then((status: any) => {
      setActiveTools((prev) => ({ ...prev, 'remote-mic': !!(status?.hosting || status?.streaming) }));
    }).catch(() => {});

    Promise.resolve(linkApi.getPortalStatus?.()).then((status: any) => {
      setActiveTools((prev) => ({ ...prev, 'file-transfer': !!(status?.connected || status?.transferring) }));
    }).catch(() => {});

    Promise.resolve(linkApi.getJoystickStatus?.()).then((status: any) => {
      const hasControllers = status?.connectedControllers && status.connectedControllers.length > 0;
      setActiveTools((prev) => ({ ...prev, 'joystick': !!hasControllers }));
    }).catch(() => {});

    // Input Guest server (Presenter & Remote Input / Touchpad)
    Promise.resolve(linkApi.getInputGuestStatus?.()).then((status: any) => {
      // Unpaired guests and paired devices driving this PC both count as a live session.
      const sessions: { mode: string }[] = [...(status?.admittedGuests || []), ...(status?.pairedSessions || [])];
      setActiveTools((prev) => ({
        ...prev,
        'presenter': sessions.some((g) => g.mode === 'presenter'),
        'remote-input': sessions.some((g) => g.mode === 'touchpad'),
        'remote-control': sessions.some((g) => g.mode === 'remotecontrol'),
      }));
    }).catch(() => {});
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
          const Icon = tool.icon;
          const isActive = tool.id === 'walkie-talkie' ? walkieTalkieActive : activeTools[tool.id];
          return (
            <div
              key={tool.id}
              className="card"
              onClick={() => (tool.id === 'walkie-talkie' ? onOpenWalkieTalkie() : setSelected(tool.id))}
              style={{ cursor: 'pointer', margin: 0, display: 'flex', flexDirection: 'column', gap: '12px', position: 'relative' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Icon
                  size={26}
                  strokeWidth={2.2}
                  style={{
                    color: 'var(--accent-color)',
                    flexShrink: 0,
                  }}
                />
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
              maxWidth: selected === 'file-transfer' ? '640px' : '540px',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'var(--modal-bg)',
              border: '1px solid var(--border-color)',
              borderRadius: '16px',
              padding: '20px 24px',
              boxShadow: '0 20px 50px var(--modal-shadow)',
              animation: 'scaleUp 0.15s ease',
              overflow: 'hidden',
            }}
          >
            <ToolModalHeader title={selectedTool.title} onClose={() => setSelected(null)} />

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                marginRight: '-8px',
                paddingRight: '8px',
              }}
              className="custom-scrollbar"
            >

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

            {selected === 'presenter' && (
              <PresenterTab
                localIdentity={localIdentity}
                isMobile={isMobile}
                onLaunchPresenter={(targetId, hostDeviceType) => {
                  setSelected(null);
                  onShowPresenter?.(targetId, hostDeviceType);
                }}
              />
            )}

            {selected === 'remote-input' && (
              <RemoteInputTab
                localIdentity={localIdentity}
                isMobile={isMobile}
                onLaunchTouchpad={(targetId) => {
                  setSelected(null);
                  onShowTouchpad?.(targetId);
                }}
              />
            )}

            {selected === 'remote-control' && (
              <RemoteControlGuestTab
                localIdentity={localIdentity}
                isMobile={isMobile}
                onLaunchViewer={() => {
                  setSelected(null);
                  onShowRemoteControl?.();
                }}
              />
            )}

            {selected !== 'audio-sink' && selected !== 'remote-mic' && selected !== 'remote-control' && selected !== 'file-transfer' && selected !== 'joystick' && selected !== 'presenter' && selected !== 'remote-input' && (
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
        </div>
      )}
    </div>
  );
};

export default ToolsTab;
