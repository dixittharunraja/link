import { useEffect, useRef } from 'react';
import { LinkApi } from '../vite-env';

interface UseTouchpadOptions {
  deviceId: string;
  /** Converts a touch delta into the target's frame; identity unless the surface is rotated. */
  transformDelta?: (dx: number, dy: number) => { dx: number; dy: number };
  /** Scales touch deltas so the cursor can cross a full display comfortably. */
  sensitivity: number;
  enabled?: boolean;
}

const identity = (dx: number, dy: number) => ({ dx, dy });
const LONG_PRESS_MS = 450;

/**
 * Touchpad gestures for a remote cursor: one finger drags the cursor, a tap is a left click, a
 * two-finger tap a right click, two fingers scroll, a double tap or a press and hold click-drags.
 * Shared by the Remote Input surface for a PC and the touchpad mode for a TV; both send the same
 * relative moves and clicks (sendMouse*), never absolute positions.
 */
export function useTouchpad({ deviceId, transformDelta = identity, sensitivity, enabled = true }: UseTouchpadOptions) {
  const linkApi = (window as any).link as LinkApi;

  const touchpadLast = useRef<{ x: number; y: number } | null>(null);
  const touchpadLastScroll = useRef<{ x: number; y: number } | null>(null);
  const touchpadScrollStart = useRef<{ x: number; y: number } | null>(null);
  const touchpadStart = useRef<{ x: number; y: number } | null>(null);
  const touchStartTime = useRef<number>(0);
  const lastTapTime = useRef<number>(0);
  const isDoubleTapDrag = useRef<boolean>(false);
  const hasMoved = useRef<boolean>(false);
  const isPressed = useRef<boolean>(false);
  const isLongPressDrag = useRef<boolean>(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Peak finger count during the current gesture. Left or right click is decided once all fingers
  // are up, because a two-finger lift often arrives as two separate touchend events.
  const maxTouches = useRef<number>(0);

  // Movement is accumulated and flushed on a timer rather than sent per touch event.
  const mouseAccumulated = useRef({ dx: 0, dy: 0, scrollDx: 0, scrollDy: 0 });

  useEffect(() => {
    if (!linkApi || !enabled) return;

    const batchInterval = setInterval(() => {
      const { dx, dy, scrollDx, scrollDy } = mouseAccumulated.current;
      if (dx !== 0 || dy !== 0) {
        linkApi.sendMouseMove(deviceId, dx, dy);
        mouseAccumulated.current.dx = 0;
        mouseAccumulated.current.dy = 0;
      }
      if (scrollDx !== 0 || scrollDy !== 0) {
        linkApi.sendMouseScroll(deviceId, scrollDx, scrollDy);
        mouseAccumulated.current.scrollDx = 0;
        mouseAccumulated.current.scrollDy = 0;
      }
    }, 16);

    return () => {
      clearInterval(batchInterval);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (isDoubleTapDrag.current || isLongPressDrag.current) {
        linkApi.sendMouseDrag(deviceId, false);
      }
    };
  }, [deviceId, linkApi, enabled]);

  const startSingleTouch = (t: React.Touch, now: number) => {
    touchpadLast.current = { x: t.clientX, y: t.clientY };
    touchpadStart.current = { x: t.clientX, y: t.clientY };
    touchStartTime.current = now;

    const delta = now - lastTapTime.current;
    if (delta < 400 && lastTapTime.current > 0) {
      isDoubleTapDrag.current = true;
      linkApi?.sendMouseDrag(deviceId, true);
    } else {
      longPressTimer.current = setTimeout(() => {
        if (isPressed.current && !hasMoved.current && !isDoubleTapDrag.current) {
          isLongPressDrag.current = true;
          linkApi?.sendMouseDrag(deviceId, true);
        }
      }, LONG_PRESS_MS);
    }
  };

  const startTwoFingerTouch = (touches: React.TouchList, now: number) => {
    const t1 = touches[0];
    const t2 = touches[1];
    const mid = {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
    touchpadLastScroll.current = mid;
    touchpadScrollStart.current = mid;
    touchStartTime.current = now;
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    const now = Date.now();
    hasMoved.current = false;
    isPressed.current = true;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    maxTouches.current = e.touches.length === 1 ? 1 : Math.max(maxTouches.current, e.touches.length);

    if (e.touches.length === 1) {
      startSingleTouch(e.touches[0], now);
    } else if (e.touches.length === 2) {
      startTwoFingerTouch(e.touches, now);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    if (!linkApi) return;

    if (e.touches.length === 1 && touchpadLast.current) {
      const t = e.touches[0];
      const dx = t.clientX - touchpadLast.current.x;
      const dy = t.clientY - touchpadLast.current.y;

      const totalDist = Math.hypot(t.clientX - touchpadStart.current!.x, t.clientY - touchpadStart.current!.y);
      if (totalDist > 12) {
        hasMoved.current = true;
      }

      touchpadLast.current = { x: t.clientX, y: t.clientY };

      const { dx: visDx, dy: visDy } = transformDelta(dx, dy);

      mouseAccumulated.current.dx += visDx * sensitivity;
      mouseAccumulated.current.dy += visDy * sensitivity;
    } else if (e.touches.length === 2 && touchpadLastScroll.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const curX = (t1.clientX + t2.clientX) / 2;
      const curY = (t1.clientY + t2.clientY) / 2;

      const dx = curX - touchpadLastScroll.current.x;
      const dy = curY - touchpadLastScroll.current.y;

      // Total distance since the two-finger touch-down, not the per-frame delta, so finger jitter
      // does not turn a two-finger tap (right click) into a scroll.
      const totalDist = touchpadScrollStart.current
        ? Math.hypot(curX - touchpadScrollStart.current.x, curY - touchpadScrollStart.current.y)
        : 0;
      if (totalDist > 12) {
        hasMoved.current = true;
      }

      touchpadLastScroll.current = { x: curX, y: curY };

      const { dx: visDx, dy: visDy } = transformDelta(dx, dy);

      // Scroll amount is the swipe delta scaled down.
      mouseAccumulated.current.scrollDx += visDx / 10;
      mouseAccumulated.current.scrollDy += visDy / 10;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    if (!linkApi) return;

    isPressed.current = false;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }

    const now = Date.now();
    const duration = now - touchStartTime.current;

    if (isLongPressDrag.current) {
      isLongPressDrag.current = false;
      linkApi.sendMouseDrag(deviceId, false);
      lastTapTime.current = 0;
    } else if (isDoubleTapDrag.current) {
      isDoubleTapDrag.current = false;
      linkApi.sendMouseDrag(deviceId, false);
      lastTapTime.current = 0;
    } else if (e.touches.length === 0 && !hasMoved.current && duration < 300) {
      // Decided from the peak finger count (see maxTouches).
      if (maxTouches.current >= 2) {
        linkApi.sendMouseClick(deviceId, 'right');
        lastTapTime.current = 0;
      } else {
        linkApi.sendMouseClick(deviceId, 'left');
        lastTapTime.current = now;
      }
    }

    if (e.touches.length === 0) {
      maxTouches.current = 0;
    }

    touchpadLast.current = null;
    touchpadLastScroll.current = null;
    touchpadScrollStart.current = null;
    touchpadStart.current = null;
  };

  return { handleTouchStart, handleTouchMove, handleTouchEnd };
}
