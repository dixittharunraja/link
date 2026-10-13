import React, { useState } from 'react';

interface NotificationItem {
  key: string;
  deviceId: string;
  body: {
    id: string;
    appName: string;
    title?: string;
    text?: string;
    ticker?: string;
    requestReplyId?: string;
  };
  isMeshSync?: boolean;
}

interface NotificationsTabProps {
  notifications: NotificationItem[];
  peers?: Map<string, any>;
  onReply: (deviceId: string, replyId: string, message: string, notifKey: string) => Promise<void>;
}

const NotificationsTab: React.FC<NotificationsTabProps> = ({
  notifications,
  peers,
  onReply,
}) => {
  const [replies, setReplies] = useState<Record<string, string>>({});

  const handleSendReply = (item: NotificationItem) => {
    const text = replies[item.key]?.trim();
    if (!text || !item.body.requestReplyId) return;
    onReply(item.deviceId, item.body.requestReplyId, text, item.key).then(() => {
      // Clear reply state
      setReplies((prev) => {
        const copy = { ...prev };
        delete copy[item.key];
        return copy;
      });
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent, item: NotificationItem) => {
    if (e.key === 'Enter') {
      handleSendReply(item);
    }
  };

  const getDeviceDisplayName = (deviceId: string) => {
    return peers?.get(deviceId)?.name || deviceId.slice(0, 8);
  };

  return (
    <div id="tab-notifications" className="tab-content active" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="card">
        <div className="card-title">Pool Notifications</div>
        <div id="notifications-list">
          {notifications.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic' }}>
              No notifications
            </div>
          ) : (
            notifications.map((item) => {
              const body = item.body;
              const titleText = body.title ? body.title : body.appName;
              const deviceName = getDeviceDisplayName(item.deviceId);
              const hasReply = !!body.requestReplyId;

              return (
                <div key={item.key} className="notif-card" style={{ marginBottom: '12px' }}>
                  {body.title && (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                      {deviceName ? `${deviceName} • ${body.appName}` : body.appName}
                    </div>
                  )}
                  <div style={{ fontWeight: 600 }}>{titleText}</div>
                  {body.text && <div style={{ fontSize: '13px', marginTop: '2px', color: 'var(--text-color)' }}>{body.text}</div>}
                  
                  {hasReply && (
                    <div className="flex-row" style={{ marginTop: '10px' }}>
                      <input
                        type="text"
                        placeholder="Type a reply..."
                        value={replies[item.key] || ''}
                        onChange={(e) => setReplies((prev) => ({ ...prev, [item.key]: e.target.value }))}
                        onKeyDown={(e) => handleKeyPress(e, item)}
                        style={{ flexGrow: 1, fontSize: '12px', padding: '6px 10px' }}
                      />
                      <button
                        onClick={() => handleSendReply(item)}
                        style={{ fontSize: '12px', padding: '6px 12px' }}
                      >
                        Send
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default NotificationsTab;
