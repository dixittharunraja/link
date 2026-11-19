// Typing from a paired device into Link's own screens (the pairing IP field, renaming, ...).
//
// On Android the remote keyboard's text normally reaches the screen through the accessibility
// service, which finds the focused text box and edits it. A WebView exposes none of its page to that
// service, so Link's own text boxes could not be typed into. MainActivity therefore offers the text,
// Enter and Delete to the page first (window.__linkRemoteText); this applies them to the focused text
// box and answers whether it did, so anything else still falls back to the accessibility path.

type TextBox = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);

function focusedTextBox(): TextBox | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) return el;
  return null;
}

// Sets the value the way typing does, so React (which tracks the value itself) sees the change.
function setValue(el: TextBox, value: string, caret: number): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // number inputs have no selection
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function handle(text: string, key: string): boolean {
  const el = focusedTextBox();
  if (!el) return false;

  if (key === 'ENTER') {
    // The box's own Enter handling (connect, submit, ...) runs from the key events.
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    }
    return true;
  }

  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;

  if (key === 'DELETE' || key === 'BACKSPACE') {
    if (start !== end) {
      setValue(el, el.value.slice(0, start) + el.value.slice(end), start);
    } else if (start > 0) {
      setValue(el, el.value.slice(0, start - 1) + el.value.slice(start), start - 1);
    }
    return true;
  }

  if (text) {
    setValue(el, el.value.slice(0, start) + text + el.value.slice(end), start + text.length);
    return true;
  }
  return false;
}

export function initRemoteText(): void {
  (window as unknown as { __linkRemoteText?: (text: string, key: string) => boolean }).__linkRemoteText = handle;
}
