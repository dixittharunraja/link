import { describe, expect, it } from 'vitest';
import { desiredCameraId, mainLens, parseLenses, rearLenses, residualZoom, zoomRange } from './cameraLens';

// The cameras a typical three-lens phone reports, in the (unreliable) order the system lists them.
const phone = [
  { id: '2', label: 'Back - Ultra-wide (13 mm)' },
  { id: '0', label: 'Back - Main (24 mm)' },
  { id: '1', label: 'Front' },
  { id: '3', label: 'Back - Telephoto (72 mm)' },
];

describe('reading the lens list', () => {
  it('takes the focal length and facing from the labels', () => {
    const lenses = parseLenses(phone);
    expect(lenses.find((l) => l.id === '2')).toMatchObject({ equiv: 13, front: false });
    expect(lenses.find((l) => l.id === '1')).toMatchObject({ equiv: 0, front: true });
  });

  it('orders rear lenses widest first and leaves out the front one', () => {
    expect(rearLenses(parseLenses(phone)).map((l) => l.id)).toEqual(['2', '0', '3']);
  });

  it('treats the lens closest to a normal main camera as 1x, not the first listed', () => {
    expect(mainLens(rearLenses(parseLenses(phone)))?.id).toBe('0');
  });

  it('handles a label without a focal length', () => {
    const lenses = parseLenses([{ id: '9', label: 'Back (camera 9)' }]);
    expect(lenses[0]).toMatchObject({ equiv: 0, front: false });
    expect(rearLenses(lenses)).toEqual([]);
  });
});

describe('choosing the camera for a zoom', () => {
  it('uses the main camera at 1x', () => {
    expect(desiredCameraId(phone, false, 1)).toBe('0');
  });

  it('uses the ultra-wide when zoomed out', () => {
    expect(desiredCameraId(phone, false, 0.5)).toBe('2');
  });

  it('stays on the main camera until the telephoto is nearly reached', () => {
    expect(desiredCameraId(phone, false, 2)).toBe('0');
    expect(desiredCameraId(phone, false, 2.8)).toBe('0');
  });

  it('snaps to a lens within 5% of the requested zoom, so slider rounding cannot just miss it', () => {
    // The telephoto is 72/24 = 3x; 2.9 x 1.05 > 3.
    expect(desiredCameraId(phone, false, 2.9)).toBe('3');
  });

  it('switches to the telephoto at its own magnification', () => {
    expect(desiredCameraId(phone, false, 3)).toBe('3');
    expect(desiredCameraId(phone, false, 10)).toBe('3');
  });

  it('uses the front camera when asked, whatever the zoom', () => {
    expect(desiredCameraId(phone, true, 5)).toBe('1');
  });

  it('returns nothing before the phone has listed its cameras', () => {
    expect(desiredCameraId([], false, 1)).toBeNull();
  });

  it('falls back to any rear camera when focal lengths are unknown', () => {
    expect(desiredCameraId([{ id: '5', label: 'Front' }, { id: '6', label: 'Back (camera 6)' }], false, 2)).toBe('6');
  });
});

describe('the digital crop left after choosing a lens', () => {
  it('is 1 when the lens matches the zoom exactly', () => {
    expect(residualZoom(phone, '0', 1)).toBe(1);
    expect(residualZoom(phone, '3', 3)).toBe(1);
  });

  it('makes up the rest between lenses', () => {
    expect(residualZoom(phone, '0', 2)).toBeCloseTo(2);
    expect(residualZoom(phone, '3', 6)).toBeCloseTo(2);
  });

  it('never zooms out digitally below 1', () => {
    expect(residualZoom(phone, '2', 0.5)).toBe(1);
  });

  it('is plain digital zoom on the front camera or an unknown lens', () => {
    expect(residualZoom(phone, '1', 2.5)).toBe(2.5);
    expect(residualZoom(phone, 'missing', 1.5)).toBe(1.5);
    expect(residualZoom([], '', 0.7)).toBe(1);
  });
});

describe('the zoom slider range', () => {
  it('reaches down to the ultra-wide, rounded to one decimal', () => {
    expect(zoomRange(phone, false)).toEqual({ min: 0.5, max: 10 });
  });

  it('starts at 1x when there is no wider lens', () => {
    expect(zoomRange([{ id: '0', label: 'Back - Main (24 mm)' }], false)).toEqual({ min: 1, max: 10 });
  });

  it('never goes below 0.5x even for a very wide lens', () => {
    const fisheye = [
      { id: '0', label: 'Back - Main (26 mm)' },
      { id: '1', label: 'Back - Ultra-wide (8 mm)' },
    ];
    expect(zoomRange(fisheye, false).min).toBe(0.5);
  });

  it('is 1x to 4x on the front camera', () => {
    expect(zoomRange(phone, true)).toEqual({ min: 1, max: 4 });
  });
});
