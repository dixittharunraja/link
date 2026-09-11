import React from 'react';
import { InputGuestTab, InputGuestTabConfig } from './InputGuestTab';

interface PresenterTabProps {
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[]; deviceType?: string };
  isMobile: boolean;
  onLaunchPresenter?: (targetId: string) => void;
}

const PresenterTab: React.FC<PresenterTabProps> = ({
  localIdentity,
  isMobile,
  onLaunchPresenter,
}) => {
  const config: InputGuestTabConfig = {
    mode: 'presenter',
    toolName: 'Presenter',
    statusText: 'Controlling Presentation',
    hostIcon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
    ),
    qrSubtitle: 'Scan with your phone to start presenter remote',
    clientHelpText: "Enter the host computer's IP address or scan its QR code to start presenter remote.",
    scannerTitle: 'Scan Presenter Host QR',
    connectingLabel: 'Connecting to presenter host...',
    onLaunchTool: onLaunchPresenter,
  };

  return (
    <InputGuestTab
      config={config}
      localIdentity={localIdentity}
      isMobile={isMobile}
    />
  );
};

export default PresenterTab;

