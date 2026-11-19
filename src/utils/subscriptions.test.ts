import { describe, expect, it, vi } from 'vitest';
import { collectSubscriptions, createEventHub } from './subscriptions';

// Stands in for the native plugin: records attached channels so tests can fire events into them.
function fakeNative() {
  const channels = new Map<string, (data: any) => void>();
  const attach = vi.fn((eventName: string, dispatch: (data: any) => void) => {
    channels.set(eventName, dispatch);
    return () => { channels.delete(eventName); };
  });
  const fire = (eventName: string, data: any) => channels.get(eventName)?.(data);
  return { attach, channels, fire };
}

describe('createEventHub', () => {
  it('delivers an event to every subscriber instead of only the latest', () => {
    const native = fakeNative();
    const subscribe = createEventHub(native.attach);
    const app = vi.fn();
    const tab = vi.fn();
    subscribe('deviceDisconnected', app);
    subscribe('deviceDisconnected', tab);

    native.fire('deviceDisconnected', { deviceId: 'a' });

    expect(app).toHaveBeenCalledWith({ deviceId: 'a' });
    expect(tab).toHaveBeenCalledWith({ deviceId: 'a' });
    expect(native.attach).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes one subscriber without touching the others', () => {
    const native = fakeNative();
    const subscribe = createEventHub(native.attach);
    const app = vi.fn();
    const tab = vi.fn();
    subscribe('deviceDisconnected', app);
    const unsubscribeTab = subscribe('deviceDisconnected', tab);

    unsubscribeTab();
    native.fire('deviceDisconnected', { deviceId: 'a' });

    expect(app).toHaveBeenCalledTimes(1);
    expect(tab).not.toHaveBeenCalled();
  });

  it('keeps two subscriptions of the same callback independent', () => {
    const native = fakeNative();
    const subscribe = createEventHub(native.attach);
    const cb = vi.fn();
    const first = subscribe('e', cb);
    subscribe('e', cb);

    first();
    first();
    native.fire('e', 1);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('removes the native listener with the last subscriber and attaches again on the next', () => {
    const native = fakeNative();
    const subscribe = createEventHub(native.attach);
    const a = subscribe('e', () => {});
    const b = subscribe('e', () => {});

    a();
    expect(native.channels.has('e')).toBe(true);
    b();
    expect(native.channels.has('e')).toBe(false);

    const cb = vi.fn();
    subscribe('e', cb);
    native.fire('e', 2);
    expect(native.attach).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(2);
  });

  it('tolerates a subscriber that unsubscribes while the event is being delivered', () => {
    const native = fakeNative();
    const subscribe = createEventHub(native.attach);
    const later = vi.fn();
    const unsubscribeSelf = subscribe('e', () => unsubscribeSelf());
    subscribe('e', later);

    native.fire('e', 3);

    expect(later).toHaveBeenCalledWith(3);
  });
});

describe('collectSubscriptions', () => {
  it('undoes every on* subscription made through the wrapper and nothing else', () => {
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const api = {
      onA: vi.fn(() => unsubscribeA),
      onB: vi.fn(() => unsubscribeB),
      openExternal: vi.fn(() => 'opened'),
      getThing: vi.fn(() => () => {}),
    };
    const [events, unsubscribeAll] = collectSubscriptions(api);

    events.onA();
    events.onB();
    expect(events.openExternal()).toBe('opened');
    events.getThing();
    unsubscribeAll();
    unsubscribeAll();

    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(unsubscribeB).toHaveBeenCalledTimes(1);
  });

  it('passes the callback through and ignores subscriptions that return nothing', () => {
    const api = { onStub: vi.fn((_cb: () => void) => undefined) };
    const [events, unsubscribeAll] = collectSubscriptions(api);
    const cb = () => {};

    events.onStub(cb);

    expect(api.onStub).toHaveBeenCalledWith(cb);
    expect(() => unsubscribeAll()).not.toThrow();
  });
});
