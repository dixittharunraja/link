import { useEffect, useRef } from 'react';

/**
 * The same visibility-aware polling for code inside an existing effect: calls `callback` every `ms`
 * milliseconds while the page is visible, and once at once when it becomes visible again. Unlike the hook it
 * does not call it immediately on start (the effect usually already has). Returns a function that stops it.
 */
export function startVisibleInterval(callback: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer === null) timer = setInterval(callback, ms);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      stop();
    } else if (timer === null) {
      callback();
      start();
    }
  };
  if (document.visibilityState !== 'hidden') start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    stop();
  };
}

/**
 * Runs `callback` now and then every `ms` milliseconds, but only while the page is visible
 * (document.visibilityState). A hidden or minimised window stops polling; becoming visible again runs the
 * callback at once and restarts the interval. The latest callback is always used, so it need not be stable.
 */
export function useVisibleInterval(callback: () => void, ms: number, enabled = true): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      callbackRef.current();
      timer = setInterval(() => callbackRef.current(), ms);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [ms, enabled]);
}
