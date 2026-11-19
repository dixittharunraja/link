// Android hardware back handlers. A component with its own sub-view (a dialog, ToolsTab's
// selected tool) pushes a handler while it is open, and the most recent handler is asked first.
// If none claims the press, App.tsx minimizes the app.
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
