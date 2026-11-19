import { useEffect, MutableRefObject } from 'react';

export function useGlobalTouchTracking(
  touchIdRef: MutableRefObject<number | null>,
  update: (x: number, y: number) => void,
  reset: () => void
) {
  useEffect(() => {
    const onWindowTouchMove = (e: TouchEvent) => {
      if (touchIdRef.current === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === touchIdRef.current) {
          update(t.clientX, t.clientY);
        }
      }
    };

    const handleTouchTerminate = (e: TouchEvent) => {
      if (touchIdRef.current === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchIdRef.current) {
          reset();
          return;
        }
      }
    };

    window.addEventListener('touchmove', onWindowTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchTerminate, { passive: true });
    window.addEventListener('touchcancel', handleTouchTerminate, { passive: true });

    return () => {
      window.removeEventListener('touchmove', onWindowTouchMove);
      window.removeEventListener('touchend', handleTouchTerminate);
      window.removeEventListener('touchcancel', handleTouchTerminate);
    };
  }, [touchIdRef, update, reset]);
}
