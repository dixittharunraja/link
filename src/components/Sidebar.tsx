import React from 'react';
import { Smartphone, FolderTree, Wrench, Bell, Terminal, Settings2 } from 'lucide-react';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isMobile?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  isMobile,
}) => {
  const navItems = [
    {
      id: 'devices',
      label: 'Connections',
      icon: Smartphone,
    },
    {
      id: 'files',
      label: 'File Explorer',
      icon: FolderTree,
    },
    {
      id: 'tools',
      label: 'Tools',
      icon: Wrench,
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
    },
    {
      id: 'commands',
      label: 'Shell Commands',
      icon: Terminal,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings2,
    }
  ].filter(item => {
    if (isMobile && item.id === 'commands') return false;
    return true;
  });

  return (
    <aside className="sidebar">
      <ul className="nav-list">
        {navItems.map(item => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <li
              key={item.id}
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={() => setActiveTab(item.id)}
              // Focusable so a TV remote's D-pad can reach it; Enter/OK activates it.
              tabIndex={0}
              role="button"
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveTab(item.id);
                }
              }}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <div className="nav-icon-wrapper">
                <Icon className="nav-icon" size={19} />
              </div>
              <span className="nav-label">{item.label}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};

export default Sidebar;
