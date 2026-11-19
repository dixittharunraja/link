import React, { useState, useRef, useEffect } from 'react';
import { DeviceIcon } from './DeviceIcon';
import { pushBackHandler } from '../utils/backNav';

interface SelectOption {
  value: string;
  label: string;
  deviceType?: string;
  sublabel?: string;
  icon?: React.ReactNode;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  dropdownStyle?: React.CSSProperties;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  onChange,
  options,
  placeholder = 'Select option...',
  disabled = false,
  className = '',
  style,
  dropdownStyle,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    let popBack: (() => void) | undefined;
    if (isOpen) {
      // The remote's Back closes the list instead of leaving the screen.
      popBack = pushBackHandler(() => {
        setIsOpen(false);
        return true;
      });
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      popBack?.();
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div
      ref={containerRef}
      className={`custom-select-container ${className}`}
      style={{
        position: 'relative',
        display: 'inline-block',
        minWidth: '180px',
        userSelect: 'none',
        ...style,
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '8px 14px',
          borderRadius: '9px',
          background: 'var(--card-bg, rgba(16, 16, 22, 0.85))',
          backdropFilter: 'blur(12px)',
          border: isOpen
            ? '1px solid var(--accent-color, #009bd5)'
            : '1px solid var(--border-color, rgba(255, 255, 255, 0.08))',
          boxShadow: isOpen
            ? '0 0 0 3px rgba(0, 155, 213, 0.15), 0 4px 12px rgba(0,0,0,0.3)'
            : '0 2px 6px rgba(0, 0, 0, 0.2)',
          color: 'var(--text-color, #f8fafc)',
          fontSize: '13px',
          fontWeight: 500,
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
          opacity: disabled ? 0.6 : 1,
          outline: 'none',
        }}
        onMouseEnter={(e) => {
          if (!isOpen && !disabled) {
            e.currentTarget.style.borderColor = 'var(--border-hover, rgba(0, 155, 213, 0.35))';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isOpen && !disabled) {
            e.currentTarget.style.borderColor = 'var(--border-color, rgba(255, 255, 255, 0.08))';
            e.currentTarget.style.background = 'var(--card-bg, rgba(16, 16, 22, 0.85))';
          }
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedOption?.icon ? (
            selectedOption.icon
          ) : selectedOption?.deviceType ? (
            <DeviceIcon deviceType={selectedOption.deviceType} size={15} style={{ color: 'var(--accent-color, #009bd5)', flexShrink: 0 }} />
          ) : null}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </div>

        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
            color: 'var(--text-muted, #64748b)',
            flexShrink: 0,
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: '100%',
            background: 'var(--dropdown-bg, #101015)',
            backgroundColor: '#101015',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '10px',
            boxShadow: '0 16px 36px rgba(0, 0, 0, 0.75), 0 4px 12px rgba(0, 0, 0, 0.4)',
            zIndex: 9999,
            maxHeight: '260px',
            overflowY: 'auto',
            padding: '5px',
            animation: 'fadeInScale 0.15s ease-out forwards',
            ...dropdownStyle,
          }}
          className="custom-scrollbar"
          data-tv-layer
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                tabIndex={0}
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  padding: '9px 12px',
                  borderRadius: '7px',
                  fontSize: '13px',
                  fontWeight: isSelected ? 600 : 400,
                  cursor: 'pointer',
                  color: isSelected ? 'var(--accent-color, #009bd5)' : 'var(--text-color, #f8fafc)',
                  background: isSelected ? 'rgba(0, 155, 213, 0.12)' : 'transparent',
                  transition: 'all 0.12s ease',
                  margin: '1px 0',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.07)';
                    e.currentTarget.style.color = '#ffffff';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-color, #f8fafc)';
                  }
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {opt.icon ? (
                    opt.icon
                  ) : opt.deviceType ? (
                    <DeviceIcon
                      deviceType={opt.deviceType}
                      size={15}
                      style={{
                        color: isSelected ? 'var(--accent-color, #009bd5)' : 'var(--text-muted, #64748b)',
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {opt.label}
                    </span>
                    {opt.sublabel && (
                      <span style={{ fontSize: '11px', color: 'var(--text-muted, #64748b)' }}>
                        {opt.sublabel}
                      </span>
                    )}
                  </div>
                </div>

                {isSelected && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--accent-color, #009bd5)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0 }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
