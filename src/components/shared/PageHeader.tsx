import React, { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  icon?: LucideIcon | React.ElementType;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  icon: Icon,
  children,
  className = '',
  style,
}) => {
  return (
    <div
      className={`page-header-container ${className}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        flexWrap: 'wrap',
        width: '100%',
        userSelect: 'none',
        marginBottom: '10px',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
        {Icon && (
          <div
            style={{
              padding: '7px',
              borderRadius: '9px',
              background: 'rgba(0, 155, 213, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon
              size={20}
              strokeWidth={2.2}
              style={{
                color: 'var(--accent-color)',
                display: 'block',
              }}
            />
          </div>
        )}
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '22px',
            fontWeight: 800,
            letterSpacing: '-0.6px',
            color: 'var(--text-color)',
            margin: 0,
            lineHeight: 1.2,
          }}
        >
          {title}
        </h1>
      </div>

      {children && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {children}
        </div>
      )}
    </div>
  );
};

export default PageHeader;
