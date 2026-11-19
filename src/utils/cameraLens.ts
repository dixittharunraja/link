// Turning one "zoom" value into a choice of phone camera plus a digital crop. Kept free of the browser
// and of the connection so it can be tested on its own (cameraLens.test.ts).
//
// A phone reports its cameras with labels such as "Back - Main (24 mm)", "Back - Ultra-wide (13 mm)",
// "Back - Telephoto (70 mm)" or "Front". The 35 mm-equivalent focal length tells the lenses apart; the one
// closest to a normal main camera counts as 1x.

export interface CameraInfo {
  id: string;
  label: string;
}

interface Lens {
  id: string;
  label: string;
  front: boolean;
  /** 35 mm-equivalent focal length, or 0 when unknown. */
  equiv: number;
}

/** A normal phone main camera is around this focal length. */
const MAIN_EQUIV_MM = 26;
/** A lens counts as "not overshooting" the requested zoom within this margin. */
const ZOOM_TOLERANCE = 1.05;

export function parseLenses(cameras: CameraInfo[]): Lens[] {
  return cameras.map((c) => {
    const m = /\((\d+(?:\.\d+)?)\s*mm\)/.exec(c.label);
    return { id: c.id, label: c.label, front: /^front/i.test(c.label), equiv: m ? parseFloat(m[1]) : 0 };
  });
}

/** Rear cameras with a known focal length, widest first. */
export function rearLenses(lenses: Lens[]): Lens[] {
  return lenses.filter((l) => !l.front && l.equiv > 0).sort((a, b) => a.equiv - b.equiv);
}

/** The lens that counts as 1x: the one closest to a normal main camera. */
export function mainLens(rear: Lens[]): Lens | null {
  let best: Lens | null = null;
  for (const l of rear) if (!best || Math.abs(l.equiv - MAIN_EQUIV_MM) < Math.abs(best.equiv - MAIN_EQUIV_MM)) best = l;
  return best;
}

/** The zoom the slider allows: down to the widest lens (never below 0.5x), up to 10x; 1x to 4x for the front camera. */
export function zoomRange(cameras: CameraInfo[], front: boolean): { min: number; max: number } {
  if (front) return { min: 1, max: 4 };
  const rear = rearLenses(parseLenses(cameras));
  const main = mainLens(rear);
  const widest = rear[0];
  const min = main && widest ? Math.min(1, Math.max(0.5, Math.round((widest.equiv / main.equiv) * 10) / 10)) : 1;
  return { min, max: 10 };
}

/** Which camera to use for a zoom: the strongest rear lens that does not overshoot it by more than 5%
 *  (so a slider value that rounds to just under a lens still uses it), or the widest if even that
 *  overshoots; the front camera when asked for. Null when the phone has not listed its cameras. */
export function desiredCameraId(cameras: CameraInfo[], front: boolean, zoom: number): string | null {
  const lenses = parseLenses(cameras);
  if (lenses.length === 0) return null;
  if (front) return lenses.find((l) => l.front)?.id ?? null;
  const rear = rearLenses(lenses);
  if (rear.length === 0) return lenses.find((l) => !l.front)?.id ?? null;
  const main = mainLens(rear)!;
  let best = rear[0];
  for (const l of rear) if (l.equiv / main.equiv <= zoom * ZOOM_TOLERANCE) best = l;
  return best.id;
}

/** The zoom still to be done by cropping once the lens in use has contributed its share (never below 1). */
export function residualZoom(cameras: CameraInfo[], currentId: string, zoom: number): number {
  const lenses = parseLenses(cameras);
  const current = lenses.find((l) => l.id === currentId);
  const main = mainLens(rearLenses(lenses));
  if (!current || current.front || !current.equiv || !main) return Math.max(1, zoom);
  return Math.max(1, zoom / (current.equiv / main.equiv));
}
