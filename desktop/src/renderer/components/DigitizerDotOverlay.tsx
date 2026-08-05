import React, { useRef, useEffect, useState, MutableRefObject } from 'react';

export type DigitizerMoveHandler = (x: number, y: number, touching: boolean, active: boolean) => void;

interface DigitizerDotOverlayProps {
  moveHandlerRef: MutableRefObject<DigitizerMoveHandler | null>;
  onClose: () => void;
  sessionWidth: number;
  sessionHeight: number;
}

const DigitizerDotOverlay: React.FC<DigitizerDotOverlayProps> = ({ moveHandlerRef, onClose, sessionWidth, sessionHeight }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const [visible] = useState(true);

  const isMobile = typeof (window as any).Capacitor !== 'undefined';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const width = isMobile ? window.innerHeight : window.innerWidth;
    const height = isMobile ? window.innerWidth : window.innerHeight;
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    moveHandlerRef.current = (x: number, y: number, touching: boolean, active: boolean) => {
      if (!active) {
        onClose();
        return;
      }

      const rx = sessionWidth > 0 ? Math.max(0, Math.min(1.0, x / sessionWidth)) : 0.5;
      const ry = sessionHeight > 0 ? Math.max(0, Math.min(1.0, y / sessionHeight)) : 0.5;
      const px = rx * width;
      const py = ry * height;

      if (dotRef.current) {
        dotRef.current.style.left = `${px}px`;
        dotRef.current.style.top = `${py}px`;
        dotRef.current.style.background = touching ? 'rgba(0, 155, 213, 0.85)' : 'rgba(0, 155, 213, 0.3)';
        dotRef.current.style.boxShadow = touching ? '0 0 12px 4px rgba(0, 155, 213, 0.6)' : '0 0 8px 2px rgba(0, 155, 213, 0.2)';
      }

      if (touching) {
        if (lastPos.current) {
          ctx.beginPath();
          ctx.strokeStyle = '#009bd5'; // matches --accent-color; canvas can't read CSS vars
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.moveTo(lastPos.current.x, lastPos.current.y);
          ctx.lineTo(px, py);
          ctx.stroke();
        }
        lastPos.current = { x: px, y: py };
      } else {
        lastPos.current = null;
      }
    };

    return () => {
      moveHandlerRef.current = null;
    };
  }, [onClose, moveHandlerRef, sessionWidth, sessionHeight, isMobile]);

  if (!visible) return null;

  return (
    <div
      className={isMobile ? "landscape-overlay" : ""}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.1)', // slightly dark overlay to show canvas drawing
        pointerEvents: 'none',
        zIndex: 9999,
        height: isMobile ? '100vw' : '100%',
        width: isMobile ? '100vh' : '100%',
      }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <div
        ref={dotRef}
        style={{
          position: 'absolute',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          left: '50%',
          top: '50%',
          transition: 'background 0.1s, box-shadow 0.1s',
        }}
      />
    </div>
  );
};

export default DigitizerDotOverlay;
