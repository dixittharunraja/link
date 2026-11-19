// Custom-layout data model and math utilities for virtual joystick overlays.

export type JoystickLayout = string;

export function isBuiltinLayout(id: string): id is 'classic' | 'driving' {
  return id === 'classic' || id === 'driving';
}

export type ControlId =
  | 'ls' | 'rs' | 'dpad' | 'face' | 'lb' | 'rb' | 'lt' | 'rt'
  | 'dpadUp' | 'dpadDown' | 'dpadLeft' | 'dpadRight'
  | 'faceA' | 'faceB' | 'faceX' | 'faceY';

export interface Placement {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

type CustomPositions = Record<ControlId, Placement>;

type TriggerMode = 'tap' | 'pull' | 'push';
type LsMode = 'stick' | 'steer';

export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 100;
export const DEFAULT_SENSITIVITY = 50;

export function wheelDegreesForSensitivity(s: number): number {
  return 220 - (s / 100) * 160;
}

export function triggerDragFactorForSensitivity(s: number): number {
  return 1 - (s / 100) * 0.65;
}

// Small anti-jitter zone only. Games apply their own deadzone to the pad, and the old 16% zone
// that was rescaled back to zero stacked on top of it, so small movements were lost.
export const STICK_DEADZONE = 0.04;

// Tap-to-click (L3/R3) limits for a stick: a quick press that barely moves clicks the stick, and
// a press held still this long keeps it down until release.
export const STICK_CLICK_TAP_MS = 250;
export const STICK_CLICK_HOLD_MS = 350;
export const STICK_CLICK_MAX_TRAVEL = 0.15;

/**
 * Stick response. `m` is how far the thumb is from the centre, 0..1 of the pad's radius; the result
 * is the output magnitude, 0..1. Sensitivity 50 is neutral (linear). Above it the stick reaches full
 * output sooner (down to half the travel at 100). Below it a curve gives fine control near the
 * centre while the edge still gives full output (exponent up to 2.2 at 0).
 */
export function stickResponse(m: number, sensitivity: number): number {
  const s = Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, sensitivity));
  const x = Math.max(0, Math.min(1, m));
  if (x <= STICK_DEADZONE) return 0;
  const n = (x - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  if (s >= 50) {
    const saturateAt = 1 - ((s - 50) / 50) * 0.5;
    return Math.min(1, n / saturateAt);
  }
  return Math.pow(n, 1 + ((50 - s) / 50) * 1.2);
}

type ClusterMode = 'combined' | 'separate';

export interface ActiveModes {
  ltMode: TriggerMode;
  rtMode: TriggerMode;
  ltSensitivity: number;
  rtSensitivity: number;
  lsMode: LsMode;
  steeringSensitivity: number;
  lsSensitivity: number;
  rsSensitivity: number;
}

export const DEFAULT_ACTIVE_MODES: ActiveModes = {
  ltMode: 'tap', rtMode: 'tap',
  ltSensitivity: DEFAULT_SENSITIVITY, rtSensitivity: DEFAULT_SENSITIVITY,
  lsMode: 'stick',
  steeringSensitivity: DEFAULT_SENSITIVITY, lsSensitivity: DEFAULT_SENSITIVITY, rsSensitivity: DEFAULT_SENSITIVITY,
};

export const SKIN_STORAGE_KEY = 'link-joystick-skin';
export const HAPTICS_STORAGE_KEY = 'link-joystick-haptics';
export const LAYOUT_STORAGE_KEY = 'link-joystick-layout';
export const CUSTOM_PRESETS_STORAGE_KEY = 'link-joystick-custom-presets';
export const BUILTIN_MODES_STORAGE_KEY = 'link-joystick-builtin-modes';

export const genPresetId = () => `preset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function nextPresetName(baseName: string, existing: CustomPreset[]): string {
  const label = baseName === 'Classic' || baseName === 'Driving' ? 'Custom' : `${baseName} copy`;
  if (!existing.some((p) => p.name === label)) return label;
  let n = 2;
  while (existing.some((p) => p.name === `${label} ${n}`)) n++;
  return `${label} ${n}`;
}

export interface BuiltinModes {
  classic: ActiveModes;
  driving: ActiveModes;
}
const DEFAULT_BUILTIN_MODES: BuiltinModes = {
  classic: { ...DEFAULT_ACTIVE_MODES },
  driving: { ...DEFAULT_ACTIVE_MODES, ltMode: 'pull', rtMode: 'pull' },
};
function normalizeBuiltinModes(stored: unknown): BuiltinModes {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, any>;
  return {
    classic: raw.classic ? normalizeActiveModes(raw.classic) : DEFAULT_BUILTIN_MODES.classic,
    driving: raw.driving ? normalizeActiveModes(raw.driving) : DEFAULT_BUILTIN_MODES.driving,
  };
}

function normalizeTriggerModeLoose(v: unknown): TriggerMode | undefined {
  return v === 'tap' || v === 'pull' || v === 'push' ? v : undefined;
}

function normalizeSensitivityValue(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, v));
  if (v === 'high') return 80;
  if (v === 'medium') return 50;
  if (v === 'low') return 25;
  return DEFAULT_SENSITIVITY;
}

function normalizeActiveModes(stored: unknown): ActiveModes {
  const obj = (stored && typeof stored === 'object' ? stored : {}) as Record<string, any>;
  const src = (obj.modes && typeof obj.modes === 'object') ? (obj.modes as Record<string, any>) : obj;
  return {
    ltMode: normalizeTriggerModeLoose(src.ltMode) ?? 'tap',
    rtMode: normalizeTriggerModeLoose(src.rtMode) ?? 'tap',
    ltSensitivity: normalizeSensitivityValue(src.ltSensitivity ?? src.triggerSensitivity),
    rtSensitivity: normalizeSensitivityValue(src.rtSensitivity ?? src.triggerSensitivity),
    lsMode: src.lsMode === 'steer' ? 'steer' : 'stick',
    steeringSensitivity: normalizeSensitivityValue(src.steeringSensitivity),
    lsSensitivity: normalizeSensitivityValue(src.lsSensitivity),
    rsSensitivity: normalizeSensitivityValue(src.rsSensitivity),
  };
}

export interface CustomPreset {
  id: string;
  name: string;
  dpadMode: ClusterMode;
  faceMode: ClusterMode;
  modes: ActiveModes;
  positions: CustomPositions;
}

const DEFAULT_DPAD_SUB_POSITIONS = {
  dpadUp:    { x: 33, y: 56, sx: 1, sy: 1 },
  dpadDown:  { x: 33, y: 72, sx: 1, sy: 1 },
  dpadLeft:  { x: 25, y: 64, sx: 1, sy: 1 },
  dpadRight: { x: 41, y: 64, sx: 1, sy: 1 },
};

export const DEFAULT_CUSTOM_LAYOUT: CustomPositions = {
  lt:   { x: 9,  y: 17, sx: 1, sy: 1 },
  lb:   { x: 23, y: 17, sx: 1, sy: 1 },
  rb:   { x: 77, y: 17, sx: 1, sy: 1 },
  rt:   { x: 91, y: 17, sx: 1, sy: 1 },
  ls:   { x: 13, y: 64, sx: 1, sy: 1 },
  dpad: { x: 33, y: 64, sx: 1, sy: 1 },
  face: { x: 67, y: 64, sx: 1, sy: 1 },
  rs:   { x: 87, y: 64, sx: 1, sy: 1 },
  ...DEFAULT_DPAD_SUB_POSITIONS,
  faceY: { x: 67, y: 56, sx: 1, sy: 1 },
  faceA: { x: 67, y: 72, sx: 1, sy: 1 },
  faceX: { x: 59, y: 64, sx: 1, sy: 1 },
  faceB: { x: 75, y: 64, sx: 1, sy: 1 },
};

export const DEFAULT_DRIVING_LAYOUT: CustomPositions = {
  lb:   { x: 15, y: 17, sx: 1, sy: 1 },
  rb:   { x: 85, y: 17, sx: 1, sy: 1 },
  lt:   { x: 82, y: 76, sx: 1, sy: 1 },
  rt:   { x: 94, y: 76, sx: 1, sy: 1 },
  ls:   { x: 15, y: 64, sx: 1, sy: 1 },
  dpad: { x: 33, y: 64, sx: 1, sy: 1 },
  rs:   { x: 67, y: 50, sx: 0.8, sy: 0.8 },
  face: { x: 67, y: 76, sx: 1, sy: 1 },
  ...DEFAULT_DPAD_SUB_POSITIONS,
  faceY: { x: 67, y: 68, sx: 1, sy: 1 },
  faceA: { x: 67, y: 84, sx: 1, sy: 1 },
  faceX: { x: 59, y: 76, sx: 1, sy: 1 },
  faceB: { x: 75, y: 76, sx: 1, sy: 1 },
};

function normalizeCustomPositions(stored: unknown): CustomPositions {
  const out = {} as CustomPositions;
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, any>;
  for (const key of Object.keys(DEFAULT_CUSTOM_LAYOUT) as ControlId[]) {
    const fallback = DEFAULT_CUSTOM_LAYOUT[key];
    const s = raw[key];
    if (!s || typeof s !== 'object') { out[key] = { ...fallback }; continue; }
    const legacyScale = typeof s.scale === 'number' ? s.scale : undefined;
    out[key] = {
      x: typeof s.x === 'number' ? s.x : fallback.x,
      y: typeof s.y === 'number' ? s.y : fallback.y,
      sx: typeof s.sx === 'number' ? s.sx : (legacyScale ?? fallback.sx),
      sy: typeof s.sy === 'number' ? s.sy : (legacyScale ?? fallback.sy),
    };
  }
  return out;
}

function normalizeCustomPreset(stored: unknown, fallbackId: string): CustomPreset {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, any>;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Custom',
    dpadMode: raw.dpadMode === 'separate' ? 'separate' : 'combined',
    faceMode: raw.faceMode === 'separate' ? 'separate' : 'combined',
    modes: normalizeActiveModes(raw),
    positions: normalizeCustomPositions(raw.positions),
  };
}

export function loadCustomPresetsFromStorage(): CustomPreset[] {
  try {
    const stored = localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed.map((p, i) => normalizeCustomPreset(p, genPresetId() + i));
    }
  } catch {}
  return [];
}

export function loadJoystickSkinFromStorage(): 'xbox' | 'ps' {
  try { return (localStorage.getItem(SKIN_STORAGE_KEY) as 'xbox' | 'ps') || 'xbox'; } catch { return 'xbox'; }
}

export function loadJoystickHapticsFromStorage(): boolean {
  try { return localStorage.getItem(HAPTICS_STORAGE_KEY) !== 'off'; } catch { return true; }
}

export function loadJoystickLayoutFromStorage(): JoystickLayout {
  try {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored) return stored;
  } catch {}
  return 'classic';
}

export function loadJoystickBuiltinModesFromStorage(): BuiltinModes {
  try {
    const stored = localStorage.getItem(BUILTIN_MODES_STORAGE_KEY);
    return stored ? normalizeBuiltinModes(JSON.parse(stored)) : DEFAULT_BUILTIN_MODES;
  } catch {
    return DEFAULT_BUILTIN_MODES;
  }
}


