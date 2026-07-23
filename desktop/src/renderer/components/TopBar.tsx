import brandLogo from '../icon.png';

interface TopBarProps {
  deviceName: string;
  ipAddress?: string;
}

const TopBar: React.FC<TopBarProps> = ({ deviceName, ipAddress }) => {
  return (
    <div className="top-bar">
      <div className="brand" style={{ margin: 0, padding: 0 }}>
        <img className="brand-logo" src={brandLogo} alt="Logo" style={{ width: '32px', height: '32px', borderRadius: '6px' }} />
        <div className="brand-title" style={{ fontSize: '20px' }}>Link</div>
      </div>

      <div className="local-device-card">
        <div className="status-dot"></div>
        <div className="device-details">
          <span id="header-device-name">{deviceName || 'Loading...'}</span>
          <span id="header-device-ip">{ipAddress || 'No IP Detected'}</span>
        </div>
      </div>
    </div>
  );
};

export default TopBar;
