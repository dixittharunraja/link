import React from 'react';

interface DialogCardProps {
  children: React.ReactNode;
  onCancel: () => void;
  maxWidth?: string;
  zIndex?: number;
}

export const DialogCard: React.FC<DialogCardProps> = ({
  children,
  onCancel,
  maxWidth = '380px',
  zIndex = 25000,
}) => (
  <div
    className="popup-overlay"
    style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(10px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex,
    }}
    onClick={onCancel}
  >
    <div
      className="card"
      style={{
        width: '90%',
        maxWidth,
        background: 'var(--modal-bg)',
        border: '1px solid var(--border-color)',
        boxShadow: '0 25px 60px var(--modal-shadow)',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  </div>
);

interface DialogHeaderProps {
  title: string;
  subtitle?: string;
}

const DialogHeader: React.FC<DialogHeaderProps> = ({ title, subtitle }) => (
  <>
    <div style={{ fontSize: '16px', fontWeight: 700 }}>{title}</div>
    {subtitle && <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{subtitle}</div>}
  </>
);

interface DialogFooterProps {
  onCancel: () => void;
  onConfirm: () => void;
  cancelLabel?: string;
  confirmLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
}

const DialogFooter: React.FC<DialogFooterProps> = ({
  onCancel,
  onConfirm,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  danger = false,
  confirmDisabled = false,
}) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
    <button
      onClick={onCancel}
      style={{
        padding: '7px 16px',
        fontSize: '12.5px',
        background: 'transparent',
        border: '1px solid var(--border-color)',
        borderRadius: '6px',
        color: 'var(--text-color)',
        cursor: 'pointer',
      }}
    >
      {cancelLabel}
    </button>
    <button
      onClick={onConfirm}
      disabled={confirmDisabled}
      style={{
        padding: '7px 16px',
        fontSize: '12.5px',
        background: danger ? '#ef4444' : 'var(--accent-gradient, #3b82f6)',
        border: danger ? '1px solid #ef4444' : 'none',
        color: danger ? '#fff' : 'var(--btn-primary-text)',
        borderRadius: '6px',
        cursor: confirmDisabled ? 'not-allowed' : 'pointer',
        fontWeight: 600,
        opacity: confirmDisabled ? 0.6 : 1,
      }}
    >
      {confirmLabel}
    </button>
  </div>
);

interface ModalCloseButtonProps {
  onClose: () => void;
  ariaLabel?: string;
}

export const ModalCloseButton: React.FC<ModalCloseButtonProps> = ({ onClose, ariaLabel = 'Close' }) => (
  <button
    onClick={onClose}
    aria-label={ariaLabel}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '30px',
      height: '30px',
      minWidth: '30px',
      borderRadius: '50%',
      padding: 0,
      fontSize: '16px',
      background: 'rgba(255, 255, 255, 0.08)',
      border: 'none',
      color: 'var(--text-muted)',
      cursor: 'pointer',
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
);

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  return (
    <DialogCard onCancel={onCancel}>
      <DialogHeader title={title} subtitle={message} />
      <DialogFooter
        onCancel={onCancel}
        onConfirm={onConfirm}
        cancelLabel={cancelLabel}
        confirmLabel={confirmLabel}
        danger
      />
    </DialogCard>
  );
};

interface InputDialogProps {
  title: string;
  subtitle: string;
  value: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
}

export const InputDialog: React.FC<InputDialogProps> = ({
  title,
  subtitle,
  value,
  onChange,
  onSubmit,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
}) => {
  return (
    <DialogCard onCancel={onCancel}>
      <DialogHeader title={title} subtitle={subtitle} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        style={{
          padding: '8px 12px',
          borderRadius: '8px',
          border: '1px solid var(--border-color)',
          background: 'var(--input-bg)',
          color: 'var(--text-color)',
          fontSize: '13px',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
      <DialogFooter
        onCancel={onCancel}
        onConfirm={onSubmit}
        cancelLabel={cancelLabel}
        confirmLabel={confirmLabel}
      />
    </DialogCard>
  );
};


interface DeleteConfirmDialogProps {
  names: string[];
  includesFolders: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const DELETE_WORD = 'delete';
const DELETE_LIST_MAX = 5;

/** Deleting from another device is permanent (there is no recycle bin on the other end), so the
 *  items are listed and the button stays disabled until the word is typed. */
export const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({ names, includesFolders, onConfirm, onCancel }) => {
  const [typed, setTyped] = React.useState('');
  const confirmed = typed.trim().toLowerCase() === DELETE_WORD;
  const count = names.length;
  const shown = names.slice(0, DELETE_LIST_MAX);
  return (
    <DialogCard onCancel={onCancel}>
      <DialogHeader
        title={count === 1 ? 'Delete permanently?' : `Delete ${count} items permanently?`}
        subtitle={`This cannot be undone.${includesFolders ? ' Folders are deleted with everything inside them.' : ''}`}
      />
      <ul style={{ margin: 0, padding: '10px 12px 10px 28px', borderRadius: '8px', background: 'var(--input-bg)', fontSize: '12.5px', lineHeight: 1.6, maxHeight: '140px', overflowY: 'auto' }}>
        {shown.map((name) => (
          <li key={name} style={{ overflowWrap: 'anywhere' }}>{name}</li>
        ))}
        {count > shown.length && <li style={{ color: 'var(--text-muted)', listStyle: 'none', marginLeft: '-16px' }}>and {count - shown.length} more</li>}
      </ul>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12.5px', color: 'var(--text-muted)' }}>
        <span>Type <strong style={{ color: 'var(--text-color)' }}>{DELETE_WORD}</strong> to confirm</span>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && confirmed && onConfirm()}
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          style={{
            padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border-color)',
            background: 'var(--input-bg)', color: 'var(--text-color)', fontSize: '13px', width: '100%', boxSizing: 'border-box',
          }}
        />
      </label>
      <DialogFooter onCancel={onCancel} onConfirm={onConfirm} confirmLabel="Delete" confirmDisabled={!confirmed} danger />
    </DialogCard>
  );
};
