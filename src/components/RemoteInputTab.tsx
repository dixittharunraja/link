import React from 'react';
import { InputGuestTab, InputGuestTabConfig } from './InputGuestTab';

interface RemoteInputTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  onLaunchTouchpad?: (targetId: string) => void;
}

const RemoteInputTab: React.FC<RemoteInputTabProps> = ({
  localIdentity,
  isMobile,
  onLaunchTouchpad,
}) => {
  const config: InputGuestTabConfig = {
    mode: 'touchpad',
    toolName: 'Remote Input',
    statusText: 'Controlling Mouse & Stylus',
    hostIcon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="4" /><line x1="12" y1="6" x2="12" y2="10" /></svg>
    ),
    qrSubtitle: 'Scan with your phone to start mouse and digitizer control',
    clientHelpText: "Enter the host computer's IP address or scan its QR code to control mouse and stylus.",
    scannerTitle: 'Scan Remote Input Host QR',
    connectingLabel: 'Connecting to remote input host...',
    onLaunchTool: onLaunchTouchpad,
  };

  return (
    <InputGuestTab
      config={config}
      localIdentity={localIdentity}
      isMobile={isMobile}
    />
  );
};

export default RemoteInputTab;

