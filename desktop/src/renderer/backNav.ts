// Shared hardware-back-button handler stack (mobile only). Components with their own internal
// "sub-view" navigation (e.g. ToolsTab's selected tool) push a handler while that sub-view is
// open; the most recently pushed handler gets first refusal. If nothing on the stack claims the
// back press, App.tsx falls back to asking native to minimize the app instead of leaving the
// WebView with no response at all.
type BackHandler = () => boolean;

const stack: BackHandler[] = [];

export function pushBackHandler(handler: BackHandler): () => void {
  stack.push(handler);
  return () => {
    const i = stack.indexOf(handler);
    if (i !== -1) stack.splice(i, 1);
  };
}

export function handleHardwareBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]()) return true;
  }
  return false;
}
