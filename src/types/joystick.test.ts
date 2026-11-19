import { describe, it, expect } from 'vitest';
import { stickResponse, STICK_DEADZONE } from './joystick';

describe('stickResponse', () => {
  it('is zero inside the deadzone and full at the edge for every sensitivity', () => {
    for (const s of [0, 25, 50, 75, 100]) {
      expect(stickResponse(0, s)).toBe(0);
      expect(stickResponse(STICK_DEADZONE, s)).toBe(0);
      expect(stickResponse(1, s)).toBeCloseTo(1, 10);
    }
  });

  it('is linear at the neutral setting', () => {
    const mid = stickResponse(0.52, 50);
    expect(mid).toBeCloseTo((0.52 - STICK_DEADZONE) / (1 - STICK_DEADZONE), 10);
  });

  it('gives finer control near the centre below neutral and more output above it', () => {
    const m = 0.5;
    expect(stickResponse(m, 0)).toBeLessThan(stickResponse(m, 50));
    expect(stickResponse(m, 25)).toBeLessThan(stickResponse(m, 50));
    expect(stickResponse(m, 75)).toBeGreaterThan(stickResponse(m, 50));
    expect(stickResponse(m, 100)).toBeGreaterThan(stickResponse(m, 75));
  });

  it('saturates at half travel at the highest sensitivity', () => {
    expect(stickResponse(0.4, 100)).toBeLessThan(1);
    expect(stickResponse(0.53, 100)).toBe(1);
  });

  it('never decreases as the thumb moves out', () => {
    for (const s of [0, 30, 50, 80, 100]) {
      let previous = 0;
      for (let m = 0; m <= 1.0001; m += 0.01) {
        const value = stickResponse(m, s);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });
});
