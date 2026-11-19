// D-pad (remote control) navigation for Android TV. The WebView's built-in focus traversal only
// knows native controls and walks them in document order, so clickable divs are unreachable and the
// order ignores the layout. This module:
//   1. makes every clickable element focusable (anything with cursor:pointer that is not already),
//   2. moves focus spatially with the arrow keys (the closest element in that direction),
//   3. activates the focused element with OK/Enter,
//   4. confines focus to the top-most dialog or dropdown while one is open and restores it afterwards.
// Only started when IS_TV is set (see platform.ts).
import { pushBackHandler } from './backNav';

type Dir = 'up' | 'down' | 'left' | 'right';

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// Elements the browser already focuses by itself.
const NATIVE_FOCUSABLE =
  'a[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable="true"],[tabindex]';
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);

function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type);
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.getAttribute('tabindex') === '-1'
  );
}

function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

function isShown(el: HTMLElement): boolean {
  const r = rectOf(el);
  if (r.width < 2 || r.height < 2) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  if (parseFloat(style.opacity) === 0) return false;
  return !el.closest('[aria-hidden="true"],[inert]');
}

// Gives clickable non-native elements (divs with an onClick and cursor:pointer) a tabindex so they
// can take focus. Document order means a parent is marked before its children, which then skip.
function markClickables(root: ParentNode): void {
  const all = root.querySelectorAll<HTMLElement>('*');
  all.forEach((el) => {
    if (el.matches(NATIVE_FOCUSABLE) || el.hasAttribute('data-tv-skip')) return;
    if (el.parentElement?.closest(NATIVE_FOCUSABLE)) return;
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) return;
    if (getComputedStyle(el).cursor !== 'pointer') return;
    el.setAttribute('tabindex', '0');
  });
}

function allTargets(scope: ParentNode): HTMLElement[] {
  const found = Array.from(scope.querySelectorAll<HTMLElement>(NATIVE_FOCUSABLE));
  return found.filter((el) => !isDisabled(el) && isShown(el));
}

// The dialog or dropdown that currently owns focus, if any: an element marked data-tv-layer, or a
// large fixed-position overlay under the middle of the screen.
function activeLayer(): HTMLElement | null {
  const marked = document.querySelectorAll<HTMLElement>('[data-tv-layer]');
  if (marked.length > 0) return marked[marked.length - 1];
  const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const viewArea = window.innerWidth * window.innerHeight;
  for (let el = hit as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).position !== 'fixed') continue;
    const r = rectOf(el);
    if (r.width * r.height >= viewArea * 0.5) return el;
  }
  return null;
}

// A target on screen must also be the thing actually painted at its centre; anything else is
// covered by something above it (a dialog's backdrop, an open dropdown).
function isReachable(el: HTMLElement): boolean {
  const r = rectOf(el);
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const onScreen = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  if (!onScreen) return true; // scrolled away inside its container; reached by scrolling
  // Scrolled out of its list but still inside the window (under the top bar, say): the hit test would find
  // whatever is painted there instead, yet focusing it scrolls it back into view.
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.overflowY === 'visible' && style.overflowX === 'visible') continue;
    const c = rectOf(p);
    if (y < c.top || y > c.bottom || x < c.left || x > c.right) return true;
  }
  const hit = document.elementFromPoint(x, y);
  return !!hit && (el.contains(hit) || hit.contains(el));
}

function candidates(): HTMLElement[] {
  const layer = activeLayer();
  const list = allTargets(layer ?? document);
  return layer ? list : list.filter(isReachable);
}

function score(from: DOMRect, to: DOMRect, dir: Dir, strict: boolean, nested: boolean): number | null {
  const fcx = from.left + from.width / 2;
  const fcy = from.top + from.height / 2;
  const tcx = to.left + to.width / 2;
  const tcy = to.top + to.height / 2;
  // Up/Down never target something that shares this element's row (that is Left/Right's job): the
  // Phone State toggle is not "above" its own Why? link.
  if (!nested && (dir === 'up' || dir === 'down')) {
    const overlap = Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top);
    if (overlap > Math.min(from.height, to.height) / 2) return null;
  }
  let gap: number;
  let lateral: number;
  let centerOff: number;
  switch (dir) {
    case 'down':
      if (tcy <= fcy + 1 || (!nested && to.bottom <= from.bottom - 1)) return null;
      gap = Math.max(0, to.top - from.bottom);
      lateral = Math.max(0, Math.max(from.left - to.right, to.left - from.right));
      centerOff = Math.abs(tcx - fcx);
      break;
    case 'up':
      if (tcy >= fcy - 1 || (!nested && to.top >= from.top + 1)) return null;
      gap = Math.max(0, from.top - to.bottom);
      lateral = Math.max(0, Math.max(from.left - to.right, to.left - from.right));
      centerOff = Math.abs(tcx - fcx);
      break;
    case 'right':
      if (tcx <= fcx + 1 || (!nested && to.right <= from.right - 1)) return null;
      gap = Math.max(0, to.left - from.right);
      lateral = Math.max(0, Math.max(from.top - to.bottom, to.top - from.bottom));
      centerOff = Math.abs(tcy - fcy);
      break;
    case 'left':
      if (tcx >= fcx - 1 || (!nested && to.left >= from.left + 1)) return null;
      gap = Math.max(0, from.left - to.right);
      lateral = Math.max(0, Math.max(from.top - to.bottom, to.top - from.bottom));
      centerOff = Math.abs(tcy - fcy);
      break;
  }
  // Strict pass for Left/Right: only what shares a row with the current element, so a move sideways
  // never jumps to another row (Up/Down do that).
  if (strict && lateral > 0 && (dir === 'left' || dir === 'right')) return null;
  // Same weighting Android's own focus search uses: distance along the axis counts far more than
  // being off to the side.
  return 13 * gap * gap + centerOff * centerOff;
}

// The menu entry focus last left from, so Left from the page can return to it.
let lastNav: HTMLElement | null = null;

function focusEl(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function scrollableAncestor(el: Element | null, dir: Dir): HTMLElement | null {
  const vertical = dir === 'up' || dir === 'down';
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    const overflow = vertical ? style.overflowY : style.overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const room = vertical ? p.scrollHeight - p.clientHeight : p.scrollWidth - p.clientWidth;
    if (room > 1) return p;
  }
  return null;
}

function move(dir: Dir): boolean {
  const active = document.activeElement as HTMLElement | null;
  const list = candidates();
  if (list.length === 0) return false;

  if (!active || active === document.body || !list.includes(active)) {
    // Nothing usable has focus: land on the highlighted sidebar entry, else the top-left target.
    const start =
      list.find((el) => el.matches('.nav-item.active')) ??
      list.slice().sort((x, y) => rectOf(x).top - rectOf(y).top || rectOf(x).left - rectOf(y).left)[0];
    focusEl(start);
    return true;
  }

  const from = rectOf(active);
  const inPage = !active.closest('.sidebar') && !active.closest('.top-bar');
  const pick = (strict: boolean): HTMLElement | null => {
    // Up from the page reaches the top bar only once nothing in the page is above, so a control scrolled
    // out of view (further away than the top bar) still wins and scrolls back in.
    if (dir === 'up' && inPage) {
      const inside = pickFrom(strict, (el) => !el.closest('.top-bar'));
      if (inside) return inside;
    }
    return pickFrom(strict, () => true);
  };
  const pickFrom = (strict: boolean, allow: (el: HTMLElement) => boolean): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === active || el.contains(active) || !allow(el)) continue;
      // Up/Down inside the page never jumps to the menu; Left does that.
      if ((dir === 'up' || dir === 'down') && !active.closest('.sidebar') && el.closest('.sidebar')) continue;
      // Likewise Up/Down inside the menu stays in the menu (and the top bar above it).
      if ((dir === 'up' || dir === 'down') && active.closest('.sidebar') && !el.closest('.sidebar') && !el.closest('.top-bar')) continue;
      // Right from the menu goes into the page, never to the top bar's device card.
      if (dir === 'right' && active.closest('.sidebar') && el.closest('.top-bar')) continue;
      const sc = score(from, rectOf(el), dir, strict, active.contains(el));
      if (sc !== null && sc < bestScore) {
        best = el;
        bestScore = sc;
      }
    }
    return best;
  };
  // Vertical moves fall back to any element above/below so nothing becomes unreachable.
  const inSidebar = !!active.closest('.sidebar');
  const inTopBar = !!active.closest('.top-bar');
  const navItems = list.filter((el) => el.matches('.sidebar .nav-item'));
  let best: HTMLElement | null = null;

  if (inTopBar && dir === 'down' && navItems.length > 0) {
    // From the device card, Down goes to the menu, not into the page.
    best = navItems[0];
  } else if (dir === 'left' && !inSidebar && navItems.length > 0) {
    // Left from the page returns to the menu entry that led in (else the open tab's entry), unless
    // another element in the same row is further left.
    best = pick(true);
    if (!best || best.closest('.sidebar')) {
      // Nothing further left in the row: step out to the element that contains this one (a device
      // card from its Permissions button) before leaving for the menu.
      const parent = active.parentElement?.closest<HTMLElement>(NATIVE_FOCUSABLE) ?? null;
      best = parent && list.includes(parent) && !parent.closest('.sidebar') ? parent : null;
    }
    if (!best) {
      best = (lastNav && navItems.includes(lastNav) ? lastNav : null) ?? navItems.find((el) => el.matches('.nav-item.active')) ?? null;
    }
  } else {
    best = pick(true);
    if (!best) {
      if (dir === 'up' || dir === 'down') best = pick(false);
      // Right from the menu enters the page.
      else if (dir === 'right' && inSidebar) best = pick(false);
    }
    if (best && (dir === 'up' || dir === 'down')) {
      // Up from the top of the page goes to this page's menu entry, not the device card in the top bar.
      if (dir === 'up' && !inSidebar && !inTopBar && best.closest('.top-bar')) {
        // A control inside a card (Remove, Permissions) selects its card; the card itself goes to the menu.
        const card = active.parentElement?.closest<HTMLElement>(NATIVE_FOCUSABLE) ?? null;
        best = card && list.includes(card) ? card : (navItems.find((el) => el.matches('.nav-item.active')) ?? best);
      } else if (!list.some((o) => o !== best && best!.contains(o))) {
        // Entering a row of controls: start at its first element that lines up with where we were, or
        // at the row's first element when none does (a wide row or a far-right button above it).
        const from2 = rectOf(active);
        const br = rectOf(best);
        const sameRow = list.filter((el) => {
          if (el.contains(active) || el.closest('.sidebar') !== best!.closest('.sidebar')) return false;
          // A control scrolled up under the top bar is level with the identity card, but not in its row.
          if (!el.closest('.top-bar') !== !best!.closest('.top-bar')) return false;
          if (list.some((o) => o !== el && el.contains(o))) return false; // containers are not row members
          const r = rectOf(el);
          return Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top) > Math.min(r.height, br.height) / 2;
        });
        const lines = (el: HTMLElement) => {
          const r = rectOf(el);
          return Math.max(from2.left - r.right, r.left - from2.right) <= 0;
        };
        const overlapping = sameRow.filter(lines);
        const pool = overlapping.length > 1 || overlapping.length === 0 ? (overlapping.length > 1 ? overlapping : sameRow) : null;
        if (pool && pool.length > 0) {
          pool.sort((x, y) => rectOf(x).left - rectOf(y).left);
          best = pool[0];
        }
      }
    }
  }
  if (inSidebar && best && !best.closest('.sidebar')) lastNav = active;
  if (best) {
    focusEl(best);
    return true;
  }

  // Nothing further in that direction on screen: scroll the enclosing list instead.
  if (dir === 'up' || dir === 'down') {
    const scroller = scrollableAncestor(active, dir);
    if (scroller) {
      scroller.scrollBy({ top: dir === 'down' ? 160 : -160 });
      return true;
    }
  }
  return false;
}

// Text boxes take focus without the keyboard: the TV keyboard grabs the D-pad, so opening it every
// time focus passes over a field would trap navigation. OK opens it, Back or moving away closes it.
const editing = new WeakSet<Element>();
let reentering = false;

function beginEditing(field: HTMLInputElement | HTMLTextAreaElement): void {
  editing.add(field);
  field.inputMode = field.dataset.tvIm ?? '';
  reentering = true;
  field.blur();
  field.focus();
  reentering = false;
}

function onFocusIn(e: FocusEvent): void {
  const el = e.target;
  if (reentering || !isTextField(el) || editing.has(el)) return;
  el.dataset.tvIm = el.inputMode;
  el.inputMode = 'none';
}

function onFocusOut(e: FocusEvent): void {
  const el = e.target;
  if (reentering || !isTextField(el)) return;
  editing.delete(el);
  if (el.dataset.tvIm !== undefined) {
    el.inputMode = el.dataset.tvIm;
    delete el.dataset.tvIm;
  }
}

let firstKey = true;

function onKeyDown(e: KeyboardEvent): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  let active = document.activeElement as HTMLElement | null;

  // The WebView grabs focus for the first element in the page when the app starts. The first key
  // press therefore starts from the highlighted sidebar entry instead, and only restores it.
  if (firstKey && e.key in KEY_DIR) {
    firstKey = false;
    const nav = document.querySelector<HTMLElement>('.nav-item.active');
    if (nav && !activeLayer() && active !== nav) {
      focusEl(nav);
      e.preventDefault();
      return;
    }
    active = document.activeElement as HTMLElement | null;
  }

  if (e.key === 'Enter' && active && active !== document.body) {
    // Native buttons and links activate themselves. Everything else needs the click made for it.
    const isInput = active instanceof HTMLInputElement;
    const needsClick =
      !isTextField(active) &&
      !(active instanceof HTMLButtonElement) &&
      !(active instanceof HTMLAnchorElement) &&
      !(active instanceof HTMLSelectElement) &&
      !(isInput && ['submit', 'button', 'reset'].includes((active as HTMLInputElement).type));
    if (needsClick) {
      e.preventDefault();
      active.click();
    } else if (isTextField(active) && !editing.has(active)) {
      // OK on a text box opens the on-screen keyboard (see the focusin handler below).
      e.preventDefault();
      beginEditing(active);
    }
    return;
  }

  const dir = KEY_DIR[e.key];
  if (!dir) return;

  // Inside a text box the horizontal keys move the caret until it reaches an edge.
  if (isTextField(active) && (dir === 'left' || dir === 'right')) {
    const field = active;
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = field.selectionStart;
      end = field.selectionEnd;
    } catch {
      // number inputs have no selection
    }
    if (start !== null && end !== null) {
      const atEdge = dir === 'left' ? start === 0 && end === 0 : start === field.value.length && end === field.value.length;
      if (!atEdge) return;
    }
  }
  if (active instanceof HTMLTextAreaElement && (dir === 'up' || dir === 'down')) {
    const atEdge = dir === 'up' ? active.selectionStart === 0 : active.selectionEnd === active.value.length;
    if (!atEdge) return;
  }
  // A slider uses left/right to change its value.
  if (active instanceof HTMLInputElement && active.type === 'range' && (dir === 'left' || dir === 'right')) return;

  // Always swallow it: when there is nowhere to go, the WebView's own focus search would otherwise
  // jump somewhere unrelated.
  move(dir);
  e.preventDefault();
}

// Keeps focus somewhere sensible as the UI changes: into a dialog when it opens, back to where it
// was when it closes, and onto the sidebar when the focused element was removed (tab switch).
// Rows and tiles of a list: after the list is replaced, focus goes to the first of these.
const LIST_ITEM_SELECTOR = '[data-tv-item], .fx-row, .fx-cell';

function startFocusKeeper(): void {
  let returnTo: HTMLElement | null = null;
  let wasLayer = false;
  let queued = false;
  // Where focus last was: the menu or the page. When the focused element disappears (a folder opens and
  // the list is replaced) focus stays in that area instead of jumping back to the menu.
  let lastZone: 'nav' | 'content' | 'other' = 'other';
  // Whether that was a row or tile of a list (a file or folder). Opening a folder replaces the list with a
  // loading state first, so focus must wait for the new rows rather than settle on the device selector.
  let lastWasItem = false;
  let contentRetries = 0;

  const settle = () => {
    queued = false;
    markClickables(document.body);
    const layer = activeLayer();
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || !active.isConnected || !isShown(active);

    if (layer) {
      if (!wasLayer && active && active !== document.body) returnTo = active;
      wasLayer = true;
      if (!active || !layer.contains(active)) {
        const inside = allTargets(layer);
        const preferred = inside.find((el) => el.hasAttribute('data-tv-initial') || el.getAttribute('aria-selected') === 'true') ?? inside[0];
        if (preferred) focusEl(preferred);
      }
      return;
    }
    if (wasLayer) {
      wasLayer = false;
      if (returnTo?.isConnected && isShown(returnTo)) {
        focusEl(returnTo);
        returnTo = null;
        return;
      }
      returnTo = null;
    }
    if (lost) {
      if (lastZone === 'content') {
        // The page re-rendered under focus: land on its first control. The new list may still be loading, so
        // look again for a moment before giving up and falling back to the menu.
        const content = document.querySelector<HTMLElement>('.main-container');
        const topLeft = (x: HTMLElement, y: HTMLElement) => rectOf(x).top - rectOf(y).top || rectOf(x).left - rectOf(y).left;
        const targets = content ? allTargets(content) : [];
        // A list (the files of a folder) takes focus on its first item rather than on whatever sits above it,
        // such as the device selector.
        const items = targets.filter((el) => el.matches(LIST_ITEM_SELECTOR)).sort(topLeft);
        // From a row, only another row will do while the next list loads (up to about 6 s); after that the
        // folder is empty or failed, and the page's first control takes focus.
        const waitForItems = lastWasItem && items.length === 0 && contentRetries < 40;
        const first = items[0] ?? (waitForItems ? undefined : targets.sort(topLeft)[0]);
        if (first) {
          contentRetries = 0;
          focusEl(first);
          return;
        }
        if (contentRetries < (lastWasItem ? 40 : 12)) {
          contentRetries++;
          window.setTimeout(schedule, 150);
          return;
        }
        contentRetries = 0;
      }
      const nav = document.querySelector<HTMLElement>('.nav-item.active');
      if (nav && isShown(nav)) focusEl(nav);
    } else {
      contentRetries = 0;
    }
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    window.setTimeout(settle, 60);
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    // OK on a switch clicks its label, which focuses the invisible checkbox inside. Focus there is lost to the
    // D-pad (Up jumped to the menu, the keeper to the top of the page), so hand it back to the visible switch.
    if (el instanceof HTMLElement && el.matches?.('input, select, textarea') && !isShown(el)) {
      const holder = el.parentElement?.closest<HTMLElement>(NATIVE_FOCUSABLE);
      if (holder && isShown(holder)) {
        holder.focus({ preventScroll: true });
        return;
      }
    }
    lastZone = el.closest?.('.sidebar') ? 'nav' : el.closest?.('.main-container') ? 'content' : 'other';
    lastWasItem = !!el.closest?.(LIST_ITEM_SELECTOR);
  }, true);
  document.addEventListener('focusout', schedule, true);
  schedule();
}

export function initTvNav(): void {
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  startFocusKeeper();

  // Back from the content area returns to the sidebar before it leaves the screen.
  pushBackHandler(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest('.main-container')) {
      const nav = document.querySelector<HTMLElement>('.nav-item.active');
      if (nav) {
        focusEl(nav);
        return true;
      }
    }
    return false;
  });
}
