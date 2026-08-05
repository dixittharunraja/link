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

const CommandsTab: React.FC<CommandsTabProps> = ({
  commands,
  onAddCommand,
  onRemoveCommand,
}) => {
  const [cmdKey, setCmdKey] = useState('');
  const [cmdName, setCmdName] = useState('');
  const [cmdCommand, setCmdCommand] = useState('');

  const handleAdd = () => {
    const key = cmdKey.trim();
    const name = cmdName.trim();
    const command = cmdCommand.trim();
    if (!key || !name || !command) return;

    onAddCommand(key, name, command);
    setCmdKey('');
    setCmdName('');
    setCmdCommand('');
  };

  const keys = Object.keys(commands);

  return (
    <div id="tab-commands" className="tab-content active">
      <div className="card">
        <div className="card-title">Configured Shell Commands</div>
        <div id="commands-list">
          {keys.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>
              No commands configured
            </div>
          ) : (
            keys.map((key) => {
              const entry = commands[key];
              return (
                <div key={key} className="peer-row" style={{ padding: '12px 14px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ fontSize: '13.5px', fontWeight: 600 }}>
                      {entry.name} <span style={{ color: 'var(--text-muted)', fontSize: '11px', fontWeight: 400 }}>({key})</span>
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: '11px' }}>
                      {entry.command}
                    </span>
                  </div>
                  <button onClick={() => onRemoveCommand(key)} style={{ padding: '4px 10px', fontSize: '11.5px' }}>
                    Remove
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Add / Update Whitelisted Command</div>
        <div className="flex-row" style={{ flexWrap: 'wrap' }}>
          <input
            id="cmdKey"
            type="text"
            placeholder="Trigger Key (e.g. mute)"
            value={cmdKey}
            onChange={(e) => setCmdKey(e.target.value)}
            style={{ width: '140px' }}
          />
          <input
            id="cmdName"
            type="text"
            placeholder="Display Name (e.g. Mute Volume)"
            value={cmdName}
            onChange={(e) => setCmdName(e.target.value)}
            style={{ width: '180px' }}
          />
          <input
            id="cmdCommand"
            type="text"
            placeholder="Shell Command (e.g. nircmd.exe mutesysvolume 1)"
            value={cmdCommand}
            onChange={(e) => setCmdCommand(e.target.value)}
            // flexBasis rather than minWidth: min-width overrides max-width, so a hard 250px
            // floor here would still overflow a narrower container. This prefers 250px, grows to
            // fill the row, and is free to shrink when there isn't room.
            style={{ flexGrow: 1, flexBasis: '250px', minWidth: 0 }}
          />
          <button id="addCommandBtn" onClick={handleAdd}>
            Register Command
          </button>
        </div>
      </div>
    </div>
  );
};

export default CommandsTab;
