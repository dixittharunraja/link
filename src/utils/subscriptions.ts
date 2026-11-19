type Listener = (data: any) => void;

/**
 * Fans one native listener per event name out to any number of independent subscribers. `attach`
 * registers the native listener the first time an event is subscribed and returns its removal;
 * that runs once the last subscriber is gone. Each subscribe() call returns its own unsubscribe,
 * so two subscribers to the same event (App.tsx and a tab, say) never replace each other.
 */
export function createEventHub(attach: (eventName: string, dispatch: Listener) => () => void) {
  const events = new Map<string, { listeners: Set<Listener>; detach: () => void }>();

  return function subscribe(eventName: string, cb: Listener): () => void {
    let entry = events.get(eventName);
    if (!entry) {
      const listeners = new Set<Listener>();
      // A snapshot, so a callback that unsubscribes (or subscribes) mid-dispatch is safe.
      const detach = attach(eventName, (data) => [...listeners].forEach((listener) => listener(data)));
      entry = { listeners, detach };
      events.set(eventName, entry);
    }
    // A fresh wrapper per call keeps subscriptions independent even when the same callback is
    // passed twice.
    const listener: Listener = (data) => cb(data);
    entry.listeners.add(listener);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = events.get(eventName);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        events.delete(eventName);
        current.detach();
      }
    };
  };
}

/**
 * Wraps the link API so every `on*` subscription made through it is recorded, and returns the
 * wrapper with a function that unsubscribes all of them. Lets an effect with many subscriptions
 * clean up with one call instead of keeping each unsubscribe by hand.
 */
export function collectSubscriptions<T extends object>(api: T): [T, () => void] {
  const unsubscribers: (() => void)[] = [];
  const wrapped = new Proxy(api, {
    get(target, prop) {
      const member = (target as any)[prop];
      if (typeof prop === 'string' && /^on[A-Z]/.test(prop) && typeof member === 'function') {
        return (...args: unknown[]) => {
          const unsubscribe = member.apply(target, args);
          if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
          return unsubscribe;
        };
      }
      return member;
    },
  });
  const unsubscribeAll = () => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  };
  return [wrapped, unsubscribeAll];
}
