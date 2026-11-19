// Diagnostic log kept outside React state so appending a line (some callers log per packet) never
// re-renders the App tree. Nothing currently displays it; only the tail is useful.
const MAX_LOG_LINES = 300;

const lines: string[] = [];

// Capped, and appended in place, so a per-packet caller never allocates a new array.
export function appendLog(msg: string): void {
  lines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
}
