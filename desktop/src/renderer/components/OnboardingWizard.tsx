import React, { useState } from 'react';

interface OnboardingWizardProps {
  isMobile: boolean;
  mobilePermissions: Record<string, string>;
  onRequestPermission: (key: string) => Promise<void>;
  onComplete: () => void;
}

const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  isMobile,
  mobilePermissions,
  onRequestPermission,
  onComplete,
}) => {
  const [step, setStep] = useState(1);

  // Desktop Steps (isMobile === false)
  const desktopSteps = [
    { text: "Link binds your devices into a secure, serverless local mesh. Let's authorize the core desktop integrations.", btn: "Get Started", permissionKey: null },
    { text: "<strong>1. Notifications access:</strong> Authorize notification mirroring to let calls, text, and chat alerts propagate instantly between your systems.", btn: "Authorize Notifications", permissionKey: null },
    { text: "<strong>2. Security:</strong> Every connection uses pinned certificates. Trust propagates cryptographically throughout the room.", btn: "Understand Security", permissionKey: null },
    { text: "Setup Complete! Your room is now active. Start pairing nearby devices by toggling broadcast or connecting manually.", btn: "Launch App", permissionKey: null }
  ];

  // Mobile Steps (isMobile === true)
  const mobileSteps = [
    { text: "Link binds your systems into a secure, serverless local mesh. Let's set up your permissions to enable background synchronization.", btn: "Start Setup", permissionKey: null },
    { text: "<strong>1. Persistent Notification:</strong> Android requires a persistent notification to allow Link to maintain network sockets in the background. Please authorize notification posting.", btn: "Authorize Notifications Send", permissionKey: "notificationsSend" },
    { text: "<strong>2. Notification Mirroring & Media Detection:</strong> Mirror incoming alerts (texts, calls, chats) to your PC, and detect what music/audio is currently playing (Spotify, YouTube, etc.) so you can control playback from your PC.", btn: "Authorize Notification Access", permissionKey: "notifications" },
    { text: "<strong>3. Phone State & Caller ID:</strong> Automatically pause PC music or video playback when you receive an incoming call, and let Link see the caller's number (required by Android for caller ID on non-dialer apps).", btn: "Authorize Phone State", permissionKey: "phoneState" },
    { text: "<strong>4. Contacts Sync:</strong> Match incoming numbers with contact names so desktop alerts show who is calling/texting.", btn: "Authorize Contacts Sync", permissionKey: "contacts" },
    { text: "<strong>5. File Sync:</strong> Share and transfer files bidirectionally between your phone and your PC.", btn: "Authorize File Sync", permissionKey: "allFiles" },
    { text: "<strong>6. Microphone Access:</strong> Use your phone as a wireless microphone for your PC during Remote Mic sessions.", btn: "Authorize Microphone Access", permissionKey: "microphone" },
    { text: "<strong>7. Remote Screen Lock (optional):</strong> Lets a paired PC lock this phone's screen — Android only allows this through the <strong>Device Administrator</strong> permission.<br/><br/><span style='color:#e0a05c'>Important: while this is on, Android will not let you uninstall Link directly.</span> To uninstall later, first turn <strong>Device Admin</strong> off under Link → Settings → Permissions (or Android Settings → Security → Device admin apps), then uninstall as normal. You can also skip this now and enable it anytime.", btn: "Authorize Device Admin", permissionKey: "deviceAdmin" },
    { text: "<strong>8. Background Keep-Alive:</strong> Prevent Android from killing Link when your phone screen is off to maintain background sync.", btn: "Disable Battery Optimization", permissionKey: "batteryOpt" },
    { text: "<strong>9. Display Over Other Apps (optional):</strong> Lets the Presenter pointer-dot appear on top of whatever app you're presenting from (slides, a PDF viewer, etc.) when a peer controls it, instead of only while Link is in the foreground. You can skip this and enable it later.", btn: "Authorize Display Over Apps", permissionKey: "overlay" },
    { text: "<strong>10. Accessibility Service (optional):</strong> Allows Link to receive remote input (keystrokes) from paired devices and type them directly into focused text fields on your system. You can skip this and enable it later.", btn: "Authorize Accessibility", permissionKey: "accessibility" },
    { text: "Setup Complete! Your room is now active. Start pairing nearby devices by toggling broadcast or connecting manually.", btn: "Launch App", permissionKey: null }

  ];

  const steps = isMobile ? mobileSteps : desktopSteps;
  const currentStepInfo = steps[step - 1];

  const handleNext = async () => {
    if (currentStepInfo.permissionKey) {
      // Trigger mobile permission request
      await onRequestPermission(currentStepInfo.permissionKey);
    }
    advanceStep();
  };

  const advanceStep = () => {
    if (step < steps.length) {
      setStep(step + 1);
    } else {
      onComplete();
    }
  };

  return (
    <div id="onboardingWizard" className="modal">
      <div className="modal-content" style={{ width: '480px', padding: '36px' }}>
        <h2 style={{ marginBottom: '16px', fontWeight: 700, fontSize: '19px', fontFamily: 'var(--font-display)' }}>Welcome to Link</h2>
        
        <div className="onboarding-step-indicator" style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '24px' }}>
          {steps.map((_, idx) => (
            <div
              key={idx}
              className={`step-dot ${idx < step ? 'active' : ''}`}
            ></div>
          ))}
        </div>
        
        <div
          id="onboarding-text"
          style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: '1.6', minHeight: '90px', marginBottom: '28px' }}
          dangerouslySetInnerHTML={{ __html: currentStepInfo.text }}
        />
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button className="onboarding-btn" id="onboarding-next-btn" onClick={handleNext}>
            {currentStepInfo.btn}
          </button>
          
          {currentStepInfo.permissionKey && (
            <button 
              className="onboarding-btn-skip" 
              onClick={advanceStep}
            >
              Skip for now
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingWizard;
