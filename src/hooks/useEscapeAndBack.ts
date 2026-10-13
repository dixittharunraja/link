import { useEffect } from 'react';
import { pushBackHandler } from '../utils/backNav';

export function useEscapeAndBack(onClose?: () => void, open: boolean = true) {
  useEffect(() => {
    if (!open || !onClose) return;
    
    const unregisterBack = pushBackHandler(() => {
      onClose();
      return true;
    });
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      unregisterBack();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);
}
