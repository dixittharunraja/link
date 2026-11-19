import React, { useEffect, useRef, useState } from 'react';
import { IS_ANDROID, IS_TV } from '../utils/platform';

/**
 * Pull-to-refresh (Android only): dragging down from the top of the page reloads the WebView. The pull distance
 * changes on every touchmove, so it is kept here rather than in App, where each change re-rendered every tab.
 */
const PullToRefresh: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const [pullDistance, setPullDistance] = useState<number>(0);
  // Read through a ref so toggling it doesn't re-bind the touch listeners.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    if (disabled) setPullDistance(0);
  }, [disabled]);

  useEffect(() => {
    if (!IS_ANDROID || IS_TV) return;

    let startX = 0;
    let startY = 0;
    let distance = 0;
    let pulling = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (disabledRef.current) {
        pulling = false;
        return;
      }
      // The remote-input surfaces (touchpad, keyboard/D-pad, presenter, joystick) fill the screen and own
      // every drag on it. A stroke that starts near the top of one of them must not reload the app.
      if ((e.target as HTMLElement | null)?.closest?.('#touchpadSurface, #remoteKeyboardSurface, #presenterSurface, #joystickSurface')) {
        pulling = false;
        return;
      }
      if (e.touches.length === 1) {
        const touch = e.touches[0];

        // Only from the top of the viewport, and only when no ancestor is scrolled down.
        if (touch.clientY < 220) {
          let parent = e.target as HTMLElement | null;
          let isScrolledDown = false;
          while (parent) {
            if (parent.scrollTop > 0) {
              isScrolledDown = true;
              break;
            }
            parent = parent.parentElement;
          }

          if (!isScrolledDown) {
            startX = touch.clientX;
            startY = touch.clientY;
            pulling = true;
          }
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!pulling) return;
      if (disabledRef.current) {
        pulling = false;
        distance = 0;
        setPullDistance(0);
        return;
      }
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const diffX = currentX - startX;
      const diffY = currentY - startY;

      // A mostly horizontal drag (e.g. system swipe back) cancels the pull.
      if (Math.abs(diffX) > Math.abs(diffY)) {
        pulling = false;
        setPullDistance(0);
        return;
      }

      if (diffY > 0) {
        if (e.cancelable) e.preventDefault();
        distance = Math.min(diffY * 0.4, 110);
        setPullDistance(distance);
      } else {
        pulling = false;
        setPullDistance(0);
      }
    };

    const handleTouchEnd = () => {
      if (!pulling) return;
      pulling = false;

      if (distance >= 85) {
        setPullDistance(95);
        setTimeout(() => {
          window.location.reload();
        }, 300);
      } else {
        setPullDistance(0);
      }
      distance = 0;
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  if (pullDistance <= 0) return null;

  return (
    <div
      className="pull-refresh-indicator"
      style={{
        position: 'fixed',
        top: 'max(14px, env(safe-area-inset-top, 14px))',
        left: '50%',
        transform: `translateX(-50%) translateY(${Math.min(pullDistance, 90)}px)`,
        opacity: Math.min(1, pullDistance / 45),
        zIndex: 99999,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="url(#accentGradient)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          transform: `rotate(${pullDistance * 4.5}deg)`,
          animation: pullDistance >= 85 ? 'spin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite' : 'none',
          filter: 'drop-shadow(0 0 4px #009bd5)'
        }}
      >
        <defs>
          <linearGradient id="accentGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#009bd5" />
            <stop offset="100%" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
      </svg>
    </div>
  );
};

export default PullToRefresh;
