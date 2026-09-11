import React, { useState } from 'react';

interface CommandEntry {
  name: string;
  command: string;
}

interface CommandsTabProps {
  commands: Record<string, CommandEntry>;
  onAddCommand: (key: string, name: string, command: string) => void;
  onRemoveCommand: (key: string) => void;
}

const generateSlugKey = (name: string, existingKeys: string[]): string => {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = base || 'cmd';
  if (!existingKeys.includes(prefix)) {
    return prefix;
  }
  let counter = 2;
  while (existingKeys.includes(`${prefix}_${counter}`)) {
    counter++;
  }
  return `${prefix}_${counter}`;
};

const CommandsTab: React.FC<CommandsTabProps> = ({
  commands,
  onAddCommand,
  onRemoveCommand,
}) => {
  const [cmdName, setCmdName] = useState('');
  const [cmdCommand, setCmdCommand] = useState('');

  const keys = Object.keys(commands);

  const handleBrowse = async () => {
    try {
      const selectedPath = await window.link?.pickCommandFile?.();
      if (!selectedPath) return;

      setCmdCommand(selectedPath);

      // Auto-suggest friendly name from file basename if name is empty
      if (!cmdName.trim()) {
        const rawName = selectedPath.split(/[\\/]/).pop() || '';
        const cleanName = rawName.replace(/\.[^/.]+$/, ''); // remove extension
        if (cleanName) {
          // Format e.g. "photoshop" -> "Photoshop" or "open_browser" -> "Open Browser"
          const formatted = cleanName
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
          setCmdName(formatted);
        }
      }
    } catch (err) {
      console.error('Failed to pick file:', err);
    }
  };

  const handleAdd = () => {
    const name = cmdName.trim();
    const command = cmdCommand.trim();
    if (!name || !command) return;

    // Auto-generate key from name (e.g. "open_photoshop")
    const key = generateSlugKey(name, keys);

    onAddCommand(key, name, command);
    setCmdName('');
    setCmdCommand('');
  };

  const isDesktop = typeof (window as any).Capacitor === 'undefined';

  return (
    <div id="tab-commands" className="tab-content active">
      <div className="card">
        <div className="card-title">Configured Shell Commands & Apps</div>
        <div id="commands-list">
          {keys.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>
              No commands or applications configured
            </div>
          ) : (
            keys.map((key) => {
              const entry = commands[key];
              return (
                <div key={key} className="peer-row" style={{ padding: '12px 14px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1, marginRight: '12px' }}>
                    <span style={{ fontSize: '13.5px', fontWeight: 600 }}>
                      {entry.name}
                    </span>
                    <span
                      style={{
                        color: 'var(--text-muted)',
                        fontFamily: 'monospace',
                        fontSize: '11px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={entry.command}
                    >
                      {entry.command}
                    </span>
                  </div>
                  <button onClick={() => onRemoveCommand(key)} style={{ padding: '4px 10px', fontSize: '11.5px', flexShrink: 0 }}>
                    Remove
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Add Command or Application</div>
        <div className="flex-row" style={{ flexWrap: 'wrap', gap: '10px', alignItems: 'stretch' }}>
          <input
            id="cmdName"
            type="text"
            placeholder="Name (e.g. Open Photoshop / Mute Volume)"
            value={cmdName}
            onChange={(e) => setCmdName(e.target.value)}
            style={{ flexGrow: 1, flexBasis: '200px', minWidth: '160px' }}
          />
          <div style={{ display: 'flex', flexGrow: 2, flexBasis: '280px', minWidth: '220px', gap: '8px' }}>
            <input
              id="cmdCommand"
              type="text"
              placeholder="Command or File Path (e.g. C:\App.exe or nircmd.exe)"
              value={cmdCommand}
              onChange={(e) => setCmdCommand(e.target.value)}
              style={{ flexGrow: 1, minWidth: 0 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
            />
            {isDesktop && (
              <button
                type="button"
                onClick={handleBrowse}
                title="Browse for application or file"
                style={{
                  padding: '10px 16px',
                  fontSize: '13px',
                  whiteSpace: 'nowrap',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-color)',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                Browse...
              </button>
            )}
          </div>
          <button
            id="addCommandBtn"
            onClick={handleAdd}
            disabled={!cmdName.trim() || !cmdCommand.trim()}
            style={{
              padding: '10px 20px',
              fontSize: '13px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: (!cmdName.trim() || !cmdCommand.trim()) ? 0.45 : 1,
              cursor: (!cmdName.trim() || !cmdCommand.trim()) ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
          >
            Add Command
          </button>
        </div>
      </div>
    </div>
  );
};

export default CommandsTab;
