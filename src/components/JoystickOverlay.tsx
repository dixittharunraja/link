import React, { useEffect, useRef, useState, useCallback } from 'react';
import { LinkApi } from '../vite-env';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';
import { useGlobalTouchTracking } from '../hooks/useGlobalTouchTracking';
import { pushBackHandler } from '../utils/backNav';

export * from '../types/joystick';
import {
  JoystickLayout,
  isBuiltinLayout,
  ControlId,
  Placement,
  SENSITIVITY_MIN,
  SENSITIVITY_MAX,
  DEFAULT_SENSITIVITY,
  wheelDegreesForSensitivity,
  triggerDragFactorForSensitivity,
  stickRadiusFactorForSensitivity,
  ActiveModes,
  CustomPreset,
  DEFAULT_CUSTOM_LAYOUT
} from '../types/joystick';

const SCALE_MIN = 0.6;
const SCALE_MAX = 2.2;
const FREE_RESIZE_IDS = new Set<ControlId>(['lb', 'rb', 'lt', 'rt']);

interface JoystickOverlayProps {
  // Raw IP of the PC to control — Joystick is IP-identified only, no pairing/deviceId involved
  // (see desktop/src/core/plugins/joystick.ts's header comment).
  host: string;
  skin: 'xbox' | 'ps';
  onSkinChange: (skin: 'xbox' | 'ps') => void;
  // Whether button presses buzz the phone — global (not per-layout, unlike everything in
  // ActiveModes), since it's a preference about the phone itself rather than about any one
  // control scheme.
  haptics: boolean;
  onHapticsChange: (haptics: boolean) => void;
  // The active layout id — 'classic', 'driving', or a customPresets[].id.
  layout: JoystickLayout;
  onLayoutChange: (layout: JoystickLayout) => void;
  // Apply to WHICHEVER layout is currently active — Classic and Driving remember their own choice
  // here exactly like a custom preset does (JoystickTab.tsx resolves where each actually lives:
  // a small per-built-in record for Classic/Driving, the preset object itself for a custom one).
  modes: ActiveModes;
  onModesChange: (patch: Partial<ActiveModes>) => void;
  customPresets: CustomPreset[];
  /** Creates a new preset by duplicating whichever preset is currently active (Classic/Driving
   *  seed from their own approximate default positions; an existing custom preset is deep-copied)
   *  and switches to it. */
  onCreatePreset: () => void;
  onDeletePreset: (id: string) => void;
  onRenamePreset: (id: string, name: string) => void;
  onUpdatePreset: (id: string, patch: Partial<CustomPreset>) => void;
  onClose: () => void;
  // Fired when the session ends WITHOUT the user tapping Exit — kicked/blocked, the host's
  // driver crashed, or a real network drop (heartbeat timeout). Separate from onClose so
  // JoystickTab.tsx can show a reason instead of silently returning to the connect screen the
  // way a deliberate Exit does. See joystick.ts's header comment for the full protocol.
  onDisconnected: (reason: string) => void;
}

// How long to go without hearing ANYTHING from the host before assuming the connection is dead.
// The host beats every PING_INTERVAL_MS (1s, in joystick.ts), so this tolerates ~12 consecutive
// lost heartbeats — heartbeats are unacknowledged UDP, and on a busy network (or a phone whose
// Wi-Fi radio is power-saving) losing a couple in a row is completely normal. A genuinely-dead
// host still closes the UI within ~12s, which is a much better trade than falsely tearing down a
// working session mid-game.
const PING_TIMEOUT_MS = 12000;
const PING_CHECK_INTERVAL_MS = 1000;

// Wire format range constants — must match desktop/src/core/plugins/joystick.ts's parser and
// desktop/native/joystick-helper/Program.cs's clamps exactly.
const STICK_RANGE = 1000;
// Classic/Custom LT/RT are digital (full-value-or-zero) buttons; Driving's are drag-for-range
// pedals (TriggerDragPad below). Both ride the same 0-255 wire field XInput uses for analog
// triggers (see joystick.ts) — the digital ones just only ever send 0 or fully-pressed.
const TRIGGER_RANGE = 255;

// Bitmask bit order — mirrors Program.cs's Btn* constants and JoystickHandler's wire protocol.
const BTN = {
  DPadUp: 1 << 0, DPadDown: 1 << 1, DPadLeft: 1 << 2, DPadRight: 1 << 3,
  Start: 1 << 4, Back: 1 << 5, LeftShoulder: 1 << 6, RightShoulder: 1 << 7,
  A: 1 << 8, B: 1 << 9, X: 1 << 10, Y: 1 << 11,
};

const STICK_LABEL_STYLE: React.CSSProperties = { pointerEvents: 'none', userSelect: 'none' };

// This overlay sits inside .landscape-overlay or .landscape-overlay-reverse CSS rotation.
let globalTransformDelta: (dx: number, dy: number) => { dx: number; dy: number } = (dx, dy) => ({ dx: dy, dy: -dx });

const rawDeltaToVisual = (dRawX: number, dRawY: number) => {
  const { dx, dy } = globalTransformDelta(dRawX, dRawY);
  return { x: dx, y: dy };
};

/** The visual play area's size. The container is `height:100vw; width:100vh` under the rotation,
 *  so its VISUAL width is the window's inner height and vice versa — avoids trying to reason
 *  about getBoundingClientRect() on a rotated element. */
const visualViewport = () => ({ w: window.innerHeight, h: window.innerWidth });

/** Synthetic "nudge this placement visually up/down/left/right by N px" — used to fan a combined
 *  D-pad/face block's 4 pieces out from wherever the block currently sits when a preset switches
 *  into 'separate' mode, rather than jumping them to fixed default spots. Built by reusing
 *  rawDeltaToVisual/visualViewport (the same primitives DraggableControl's drag handler uses) with
 *  a synthetic raw delta chosen so it converts to the intended pure visual direction — this keeps
 *  it consistent with however drag-to-move already behaves, rather than re-deriving the
 *  local-position/visual-direction relationship from scratch. */
const DIRECTION_RAW_DELTA: Record<'up' | 'down' | 'left' | 'right', { rawDx: number; rawDy: number }> = {
  up:    { rawDx: 1,  rawDy: 0 },
  down:  { rawDx: -1, rawDy: 0 },
  left:  { rawDx: 0,  rawDy: -1 },
  right: { rawDx: 0,  rawDy: 1 },
};

function offsetPosition(base: Placement, direction: 'up' | 'down' | 'left' | 'right', px: number): Placement {
  const d = DIRECTION_RAW_DELTA[direction];
  const vis = rawDeltaToVisual(d.rawDx * px, d.rawDy * px);
  const { w, h } = visualViewport();
  return {
    ...base,
    x: Math.max(3, Math.min(97, base.x + (vis.x / w) * 100)),
    y: Math.max(5, Math.min(95, base.y + (vis.y / h) * 100)),
  };
}

// How far (px, in the visual/on-screen frame) a split piece starts from the combined block's
// former center — big enough that the 4 pieces don't overlap at default sizes, small enough they
// still read as "the same cluster, now separated" rather than scattering across the screen.
const SPREAD_PX = 46;

// A round drag surface (analog stick). Owns its own touch lifecycle entirely — the browser keeps
// routing touchmove/touchend for a given identifier to whichever element saw its touchstart, so no
// global/container-level touch tracking is needed even though two of these exist on screen at
// once (see JoystickOverlay's header comment for why that matters here specifically).
// Radial deadzone — without this, a thumb resting anywhere but the exact geometric center reads
// as constant nonzero input ("stick feels drifty"). Below this fraction of the radius, output is
// forced to true zero; beyond it, output is rescaled so the ramp from 0 still reaches full range
// exactly at the edge (no dead "gap" right past the threshold).
const STICK_DEADZONE = 0.16;

const StickPad: React.FC<{ label: string; diameter?: number; sensitivity?: number; onChange: (x: number, y: number) => void }> = ({ label, diameter = 136, sensitivity = DEFAULT_SENSITIVITY, onChange }) => {
  const baseRef = useRef<HTMLDivElement>(null);
  const [nub, setNub] = useState({ x: 0, y: 0 });
  const touchId = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Bigger than the touchpad's own 34px visual grid buttons on purpose — a larger physical
  // travel radius means the same finger jitter maps to a smaller fraction of the range, which is
  // most of what makes a touch-stick feel "precise" rather than "twitchy". Default capped at 60
  // (rather than bigger still) because the whole layout has to fit within a rotated phone's actual
  // available height (its physical WIDTH, often only ~380-420px) — see JoystickOverlay's return
  // block comment for the full budget. `diameter` is overridable for the Driving layout's stacked
  // stick pair (needs both sticks smaller) and for Custom's per-control scaling.
  const radius = diameter / 2 - 8;
  const nubSize = Math.round(diameter * 0.38);
  // Higher sensitivity shrinks the EFFECTIVE radius used to compute the sent value (full output
  // reached well short of the true edge) without changing the visual nub's own travel — the thumb
  // can still be dragged all the way to the edge, it just saturates output earlier.
  const effectiveRadius = radius * stickRadiusFactorForSensitivity(sensitivity);

  const update = useCallback((clientX: number, clientY: number) => {
    const rect = baseRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const rawDx = clientX - cx;
    const rawDy = clientY - cy;
    const rawDist = Math.hypot(rawDx, rawDy);
    const clampedDist = Math.min(rawDist, radius);
    const ux = rawDist > 0 ? rawDx / rawDist : 0;
    const uy = rawDist > 0 ? rawDy / rawDist : 0;

    // Visual nub tracks the raw (non-deadzone) position — deadzone only affects what gets SENT,
    // not what the thumb sees, so the control still feels directly touch-coupled. Uses the same
    // raw→visual conversion as everything else here (see rawDeltaToVisual).
    const vis = rawDeltaToVisual(ux * clampedDist, uy * clampedDist);
    setNub(vis);

    const deadzoneRadius = radius * STICK_DEADZONE;
    const outputRadius = Math.max(deadzoneRadius + 1, effectiveRadius);
    let outDist = 0;
    if (clampedDist > deadzoneRadius) {
      outDist = ((Math.min(clampedDist, outputRadius) - deadzoneRadius) / (outputRadius - deadzoneRadius)) * radius;
    }
    // Same conversion again, but for the value actually SENT — and with Y re-inverted, because
    // XInput's thumbstick convention is up = POSITIVE while CSS/screen Y grows downward.
    const out = rawDeltaToVisual(ux * outDist, uy * outDist);
    onChangeRef.current(
      Math.round((out.x / radius) * STICK_RANGE),
      Math.round((-out.y / radius) * STICK_RANGE),
    );
  }, [effectiveRadius, radius]);

  const reset = useCallback(() => {
    touchId.current = null;
    setNub({ x: 0, y: 0 });
    onChangeRef.current(0, 0);
  }, []);

  // Global window listeners to guarantee release and track moves even when thumb drags outside border
  useGlobalTouchTracking(touchId, update, reset);

  return (
    <div
      ref={baseRef}
      onTouchStart={(e) => {
        e.preventDefault();
        if (touchId.current !== null) return;
        const t = e.changedTouches[0];
        touchId.current = t.identifier;
        update(t.clientX, t.clientY);
      }}
      style={{
        width: `${diameter}px`, height: `${diameter}px`, borderRadius: '50%',
        background: 'var(--input-bg)', border: '1px solid var(--border-color)',
        touchAction: 'none', position: 'relative', flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute', top: '50%', left: '50%', width: `${nubSize}px`, height: `${nubSize}px`, borderRadius: '50%',
          background: 'var(--accent-color, #009bd5)', opacity: 0.85,
          transform: `translate(calc(-50% + ${nub.x}px), calc(-50% + ${nub.y}px))`,
          ...STICK_LABEL_STYLE,
        }}
      />
      <span style={{ position: 'absolute', bottom: '-18px', left: '50%', transform: 'translateX(-50%)', fontSize: '10px', color: 'var(--text-muted)', ...STICK_LABEL_STYLE }}>
        {label}
      </span>
    </div>
  );
};

// A discrete on/off zone (D-pad direction, face button, shoulder, Start/Select) — single-owner
// touch lifecycle, same reasoning as StickPad but without drag tracking.
const TouchButton: React.FC<{
  children: React.ReactNode;
  onDown: () => void;
  onUp: () => void;
  style?: React.CSSProperties;
  round?: boolean;
}> = ({ children, onDown, onUp, style, round }) => {
  const pressedRef = useRef(false);
  // Separate from pressedRef (which just guards against a duplicate touchstart firing onDown
  // twice) — this drives the actual highlight, since without ANY visual confirmation a tap
  // registered, a hit that DID land still feels like a miss.
  const [isPressed, setIsPressed] = useState(false);

  const down = () => {
    if (pressedRef.current) return;
    pressedRef.current = true;
    setIsPressed(true);
    onDown();
  };
  const up = () => {
    pressedRef.current = false;
    setIsPressed(false);
    onUp();
  };

  return (
    <div
      onTouchStart={(e) => { e.preventDefault(); down(); }}
      onTouchEnd={(e) => { e.preventDefault(); up(); }}
      onTouchCancel={up}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: isPressed ? 'var(--accent-color, #009bd5)' : 'var(--input-bg)',
        border: `1px solid ${isPressed ? 'var(--accent-color, #009bd5)' : 'var(--border-color)'}`,
        borderRadius: round ? '50%' : '8px',
        color: isPressed ? 'var(--btn-primary-text, #fff)' : 'var(--text-color)',
        opacity: isPressed ? 1 : 0.95,
        transform: isPressed ? 'scale(0.94)' : 'scale(1)',
        transition: 'transform 0.05s ease, background 0.05s ease',
        fontSize: '13px', fontWeight: 700,
        touchAction: 'none', userSelect: 'none', ...style,
      }}
    >
      {children}
    </div>
  );
};

// Analog pedal for LT/RT's 'pull'/'push' modes — drag-for-range, unlike 'tap' (a plain digital
// button, see TRIGGER_RANGE's comment). Dragging the thumb DOWNWARD (perceived/visual, as seen on
// the rotated screen) increases the value for 'pull' (like pressing down on a real pedal); 'push'
// mirrors that so dragging UPWARD increases it instead, for whoever's thumb naturally wants to
// push away. Releasing snaps back to 0. Uses rawDeltaToVisual for the same reason every other
// touch control here does.
const TriggerDragPad: React.FC<{
  label: string;
  width?: number;
  height?: number;
  /** false = pull (drag down for more), true = push (drag up for more). */
  invert?: boolean;
  sensitivity?: number;
  onChange: (v: number) => void;
}> = ({ label, width = 66, height = 130, invert = false, sensitivity = DEFAULT_SENSITIVITY, onChange }) => {
  const [value, setValue] = useState(0);
  const touchId = useRef<number | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Full travel is proportional to the pad's own length (a pedal stretched taller in the Custom
  // layout gives correspondingly finer control rather than saturating just as fast), scaled down
  // by the sensitivity factor — higher sensitivity reaches full range with much less drag distance.
  const DRAG_PX = Math.max(24, height * 0.55 * triggerDragFactorForSensitivity(sensitivity));

  const reset = useCallback(() => {
    touchId.current = null;
    setValue(0);
    onChangeRef.current(0);
  }, []);

  const update = useCallback((clientX: number, clientY: number) => {
    const vis = rawDeltaToVisual(clientX - start.current.x, clientY - start.current.y);
    const rawTravel = invert ? -vis.y : vis.y;
    const travel = Math.max(0, Math.min(1, rawTravel / DRAG_PX));
    const v = Math.round(travel * TRIGGER_RANGE);
    setValue(v);
    onChangeRef.current(v);
  }, [DRAG_PX, invert]);

  useGlobalTouchTracking(touchId, update, reset);

  return (
    <div
      onTouchStart={(e) => {
        e.preventDefault();
        if (touchId.current !== null) return;
        const t = e.changedTouches[0];
        touchId.current = t.identifier;
        start.current = { x: t.clientX, y: t.clientY };
      }}
      style={{
        width: `${width}px`, height: `${height}px`, borderRadius: '8px', touchAction: 'none',
        background: 'var(--input-bg)', border: '1px solid var(--border-color)',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden', position: 'relative',
      }}
    >
      <div style={{ position: 'absolute', top: '4px', left: 0, right: 0, textAlign: 'center', fontSize: '10px', color: 'var(--text-muted)', ...STICK_LABEL_STYLE }}>
        {label}
      </div>
      <div style={{ height: `${(value / TRIGGER_RANGE) * 100}%`, background: 'var(--accent-color, #009bd5)', opacity: 0.6, ...STICK_LABEL_STYLE }} />
    </div>
  );
};

// Rotate-to-steer control — drag around the wheel's rim (not just left/right) to turn it, like a
// touch racing-wheel control; releasing springs it back to center.
const SteeringWheel: React.FC<{ diameter?: number; sensitivity?: number; onChange: (x: number) => void }> = ({ diameter = 160, sensitivity = DEFAULT_SENSITIVITY, onChange }) => {
  const wheelRef = useRef<HTMLDivElement>(null);
  const touchId = useRef<number | null>(null);
  const lastAngle = useRef(0);
  const rotationRef = useRef(0);
  const [rotation, setRotation] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const maxDegrees = wheelDegreesForSensitivity(sensitivity);

  const angleAt = useCallback((clientX: number, clientY: number) => {
    const rect = wheelRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const vis = rawDeltaToVisual(clientX - cx, clientY - cy);
    return Math.atan2(vis.y, vis.x) * (180 / Math.PI);
  }, []);

  const applyRotation = useCallback((deg: number) => {
    const clamped = Math.max(-maxDegrees, Math.min(maxDegrees, deg));
    rotationRef.current = clamped;
    setRotation(clamped);
    onChangeRef.current(Math.round((clamped / maxDegrees) * STICK_RANGE));
  }, [maxDegrees]);

  const reset = useCallback(() => {
    touchId.current = null;
    applyRotation(0);
  }, [applyRotation]);

  const update = useCallback((clientX: number, clientY: number) => {
    const a = angleAt(clientX, clientY);
    let delta = a - lastAngle.current;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    lastAngle.current = a;
    applyRotation(rotationRef.current + delta);
  }, [angleAt, applyRotation]);

  useGlobalTouchTracking(touchId, update, reset);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
      <div
        ref={wheelRef}
        onTouchStart={(e) => {
          e.preventDefault();
          if (touchId.current !== null) return;
          const t = e.changedTouches[0];
          touchId.current = t.identifier;
          lastAngle.current = angleAt(t.clientX, t.clientY);
        }}
        style={{
          width: `${diameter}px`, height: `${diameter}px`, borderRadius: '50%',
          background: 'var(--input-bg)', border: '6px solid var(--border-color)',
          touchAction: 'none', position: 'relative',
          transition: touchId.current === null ? 'transform 0.15s ease-out' : 'none',
          transform: `rotate(${rotation}deg)`,
        }}
      >
        <div style={{ position: 'absolute', top: '6px', left: '50%', width: '6px', height: '30%', background: 'var(--accent-color, #009bd5)', borderRadius: '3px', transform: 'translateX(-50%)', ...STICK_LABEL_STYLE }} />
        <div style={{ position: 'absolute', top: '50%', left: '10px', width: '26%', height: '6px', background: 'var(--text-muted)', borderRadius: '3px', transform: 'translateY(-50%)', ...STICK_LABEL_STYLE }} />
        <div style={{ position: 'absolute', top: '50%', right: '10px', width: '26%', height: '6px', background: 'var(--text-muted)', borderRadius: '3px', transform: 'translateY(-50%)', ...STICK_LABEL_STYLE }} />
      </div>
      <span style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)', ...STICK_LABEL_STYLE }}>STEER</span>
    </div>
  );
};

// Wrapper that absolutely-positions one control in the Custom layout, and — while editing — makes
// it draggable (move) and pinch-free resizable (a corner handle). Outside edit mode this is a
// plain positioned div with zero touch handling of its own, so the control underneath behaves
// exactly as it does in Classic/Driving.
const DraggableControl: React.FC<{
  placement: Placement;
  editing: boolean;
  /** When true this control resizes on width and height independently (the rectangular
   *  shoulder/trigger buttons); when false it scales uniformly and stays square/round. */
  freeResize: boolean;
  onChange: (p: Placement) => void;
  children: React.ReactNode;
}> = ({ placement, editing, freeResize, onChange, children }) => {
  const dragTouch = useRef<number | null>(null);
  const dragStart = useRef({ rawX: 0, rawY: 0, x: 0, y: 0 });
  const resizeTouch = useRef<number | null>(null);
  const resizeStart = useRef({ dist: 0, rawX: 0, rawY: 0, halfW: 1, halfH: 1, sx: 1, sy: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);

  const positionStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${placement.x}%`,
    top: `${placement.y}%`,
    transform: 'translate(-50%, -50%)',
  };

  if (!editing) return <div style={positionStyle}>{children}</div>;

  return (
    <div
      ref={wrapRef}
      style={{
        ...positionStyle,
        touchAction: 'none',
        outline: '2px dashed var(--accent-color, #009bd5)',
        outlineOffset: '4px',
        borderRadius: '10px',
      }}
      onTouchStart={(e) => {
        e.preventDefault();
        if (dragTouch.current !== null) return;
        const t = e.changedTouches[0];
        dragTouch.current = t.identifier;
        dragStart.current = { rawX: t.clientX, rawY: t.clientY, x: placement.x, y: placement.y };
      }}
      onTouchMove={(e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.identifier !== dragTouch.current) continue;
          const vis = rawDeltaToVisual(t.clientX - dragStart.current.rawX, t.clientY - dragStart.current.rawY);
          const { w, h } = visualViewport();
          // Clamped so a control can never be dragged fully off-screen and become unrecoverable.
          const x = Math.max(3, Math.min(97, dragStart.current.x + (vis.x / w) * 100));
          const y = Math.max(5, Math.min(95, dragStart.current.y + (vis.y / h) * 100));
          onChange({ ...placement, x, y });
        }
      }}
      onTouchEnd={(e) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === dragTouch.current) dragTouch.current = null;
        }
      }}
      onTouchCancel={() => { dragTouch.current = null; }}
    >
      {/* pointerEvents:none so dragging a control in edit mode never also fires its game input */}
      <div style={{ pointerEvents: 'none' }}>{children}</div>

      {/* Resize handle. Uniform controls scale by the finger's DISTANCE from the control's center
          — a scalar, so it needs no rotation correction at all. Free-resize (rectangular) ones
          instead decompose the drag into visual X/Y so width and height move independently, which
          does need the usual raw→visual conversion. */}
      <div
        onTouchStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const t = e.changedTouches[0];
          const rect = wrapRef.current?.getBoundingClientRect();
          if (!rect) return;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          resizeTouch.current = t.identifier;
          resizeStart.current = {
            dist: Math.max(1, Math.hypot(t.clientX - cx, t.clientY - cy)),
            rawX: t.clientX,
            rawY: t.clientY,
            // The element is rotated, so its on-screen bounding box has width/height swapped
            // relative to the visual box the user sees — hence height for the visual half-width.
            halfW: Math.max(1, rect.height / 2),
            halfH: Math.max(1, rect.width / 2),
            sx: placement.sx,
            sy: placement.sy,
          };
        }}
        onTouchMove={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const rect = wrapRef.current?.getBoundingClientRect();
          if (!rect) return;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            if (t.identifier !== resizeTouch.current) continue;
            const st = resizeStart.current;
            const clamp = (v: number) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, v));

            if (!freeResize) {
              const dist = Math.hypot(t.clientX - cx, t.clientY - cy);
              const next = clamp(st.sx * (dist / st.dist));
              onChange({ ...placement, sx: next, sy: next });
              continue;
            }

            // Corner-drag: moving the handle outward along the visual X axis widens, along the
            // visual Y axis lengthens. Each delta is converted from the control's own half-extent
            // into a multiplier so the edge tracks the finger rather than drifting from it.
            const vis = rawDeltaToVisual(t.clientX - st.rawX, t.clientY - st.rawY);
            onChange({
              ...placement,
              sx: clamp(st.sx * (1 + vis.x / st.halfW)),
              sy: clamp(st.sy * (1 + vis.y / st.halfH)),
            });
          }
        }}
        onTouchEnd={(e) => { e.stopPropagation(); resizeTouch.current = null; }}
        onTouchCancel={(e) => { e.stopPropagation(); resizeTouch.current = null; }}
        style={{
          position: 'absolute', right: '-14px', bottom: '-14px',
          width: '30px', height: '30px', borderRadius: '50%',
          background: 'var(--accent-color, #009bd5)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '13px', fontWeight: 700, touchAction: 'none', userSelect: 'none',
          boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
        }}
      >
        ⤢
      </div>
    </div>
  );
};

const JoystickOverlay: React.FC<JoystickOverlayProps> = ({
  host, skin, onSkinChange, haptics, onHapticsChange, layout, onLayoutChange, modes, onModesChange,
  customPresets, onCreatePreset, onDeletePreset, onRenamePreset, onUpdatePreset, onClose, onDisconnected,
}) => {
  const linkApi = (window as any).link as LinkApi;
  const { className, transformDelta } = useLandscapeOrientation();
  const [editing, setEditing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Keep module-level rawDeltaToVisual in sync with active landscape orientation
  useEffect(() => {
    linkApi?.setImmersiveMode?.(true);
    return () => {
      linkApi?.setImmersiveMode?.(false);
    };
  }, [linkApi]);

  useEffect(() => {
    globalTransformDelta = transformDelta;
  }, [transformDelta]);

  useEffect(() => {
    return pushBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  // Which custom preset (if any) is active. Null when on a built-in layout.
  const activePreset: CustomPreset | null = isBuiltinLayout(layout)
    ? null
    : customPresets.find((p) => p.id === layout) || null;

  // Full controller state, mutated by every control's onChange and flushed unconditionally every
  // tick (not on-change) — see joystick.ts's wire-protocol comment for why: a dropped "released,
  // back to center" packet on lossy UDP must never leave a stick/button pinned in-game.
  const state = useRef({ lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: 0 });

  const setButton = (bit: number, down: boolean) => {
    state.current.buttons = down ? (state.current.buttons | bit) : (state.current.buttons & ~bit);
    if (haptics) linkApi?.vibrate?.(60, 15);
  };

  useEffect(() => {
    if (!linkApi) return;
    const interval = setInterval(() => {
      const s = state.current;
      linkApi.sendJoystickState(host, s.lx, s.ly, s.rx, s.ry, s.lt, s.rt, s.buttons);
    }, 16);
    return () => {
      clearInterval(interval);
    };
  }, [host, linkApi]);

  // Entering edit mode releases everything that was held down — otherwise a button still pressed
  // at the moment you tap "Edit Layout" would stay stuck on for the whole editing session, since
  // its touchend never reaches the (now pointerEvents:none) control.
  useEffect(() => {
    if (!editing) return;
    state.current = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: 0 };
  }, [editing]);

  // Switching the active layout away from a custom preset (e.g. via the settings modal) while
  // still editing would otherwise leave a dangling "Done Editing" button with nothing to edit.
  const isCustomForEditReset = customPresets.some((p) => p.id === layout);
  useEffect(() => {
    if (!isCustomForEditReset) setEditing(false);
  }, [isCustomForEditReset]);

  // Disconnect detection — see joystick.ts's header comment for the two-mechanism design (forced
  // "bye <reason>" for deliberate drops, heartbeat for silent ones). `disconnectedRef` guards
  // against firing onDisconnected twice (e.g. a forced-disconnect arriving right as the watchdog
  // was also about to trip).
  const lastPingAtRef = useRef(Date.now());
  const disconnectedRef = useRef(false);

  // onDisconnected is a fresh closure on every parent render, and the parent (via ToolsTab's 2s
  // status poll) re-renders constantly. Holding it in a ref keeps the effect below depending on
  // linkApi ALONE — critical, because bridge.ts's subscribe() tears down and re-registers the
  // underlying native listener on every call, so an effect that re-ran every 2s left recurring
  // windows where an arriving heartbeat had nothing listening for it. Enough consecutive misses
  // and the watchdog declared a perfectly healthy connection dead.
  const onDisconnectedRef = useRef(onDisconnected);
  useEffect(() => { onDisconnectedRef.current = onDisconnected; }, [onDisconnected]);

  useEffect(() => {
    if (!linkApi) return;

    const fireOnce = (reason: string) => {
      if (disconnectedRef.current) return;
      disconnectedRef.current = true;
      onDisconnectedRef.current(reason);
    };

    linkApi.onJoystickPing?.(() => { lastPingAtRef.current = Date.now(); });
    linkApi.onJoystickForcedDisconnect?.((reason: string) => fireOnce(reason));

    const watchdog = setInterval(() => {
      if (Date.now() - lastPingAtRef.current > PING_TIMEOUT_MS) fireOnce('connection_lost');
    }, PING_CHECK_INTERVAL_MS);
    return () => clearInterval(watchdog);
  }, [linkApi]);

  const isXbox = skin === 'xbox';
  const faceLabels = isXbox ? { a: 'A', b: 'B', x: 'X', y: 'Y' } : { a: '✕', b: '○', x: '□', y: '△' };
  const faceColors = isXbox
    ? { a: '#16a34a', b: '#dc2626', x: '#2563eb', y: '#ca8a04' }
    : { a: '#2563eb', b: '#dc2626', x: '#db2777', y: '#16a34a' };
  const isDriving = layout === 'driving';
  const isCustom = activePreset !== null;

  // ----- Control builders. `s` is the Custom layout's per-control scale (always 1 in the fixed
  // Classic/Driving layouts, which size things by hand instead). -----

  const buildDpad = (s = 1) => {
    const cell = 44 * s;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${cell}px)`, gridTemplateRows: `repeat(3, ${cell}px)`, gap: '3px' }}>
        <div />
        <TouchButton onDown={() => setButton(BTN.DPadUp, true)} onUp={() => setButton(BTN.DPadUp, false)} style={{ gridColumn: 2, gridRow: 1, fontSize: `${15 * s}px` }}>▲</TouchButton>
        <div />
        <TouchButton onDown={() => setButton(BTN.DPadLeft, true)} onUp={() => setButton(BTN.DPadLeft, false)} style={{ gridColumn: 1, gridRow: 2, fontSize: `${15 * s}px` }}>◀</TouchButton>
        <div />
        <TouchButton onDown={() => setButton(BTN.DPadRight, true)} onUp={() => setButton(BTN.DPadRight, false)} style={{ gridColumn: 3, gridRow: 2, fontSize: `${15 * s}px` }}>▶</TouchButton>
        <div />
        <TouchButton onDown={() => setButton(BTN.DPadDown, true)} onUp={() => setButton(BTN.DPadDown, false)} style={{ gridColumn: 2, gridRow: 3, fontSize: `${15 * s}px` }}>▼</TouchButton>
        <div />
      </div>
    );
  };

  const buildFaceButtons = (s = 1) => {
    const cell = 48 * s;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${cell}px)`, gridTemplateRows: `repeat(3, ${cell}px)`, gap: '3px' }}>
        <div />
        <TouchButton round onDown={() => setButton(BTN.Y, true)} onUp={() => setButton(BTN.Y, false)} style={{ gridColumn: 2, gridRow: 1, color: faceColors.y, fontSize: `${16 * s}px` }}>{faceLabels.y}</TouchButton>
        <div />
        <TouchButton round onDown={() => setButton(BTN.X, true)} onUp={() => setButton(BTN.X, false)} style={{ gridColumn: 1, gridRow: 2, color: faceColors.x, fontSize: `${16 * s}px` }}>{faceLabels.x}</TouchButton>
        <div />
        <TouchButton round onDown={() => setButton(BTN.B, true)} onUp={() => setButton(BTN.B, false)} style={{ gridColumn: 3, gridRow: 2, color: faceColors.b, fontSize: `${16 * s}px` }}>{faceLabels.b}</TouchButton>
        <div />
        <TouchButton round onDown={() => setButton(BTN.A, true)} onUp={() => setButton(BTN.A, false)} style={{ gridColumn: 2, gridRow: 3, color: faceColors.a, fontSize: `${16 * s}px` }}>{faceLabels.a}</TouchButton>
        <div />
      </div>
    );
  };

  // Individual D-pad/face-button pieces — same TouchButton, same bit/color mapping as the combined
  // builders above, just one piece at a time. Only ever rendered when a custom preset's
  // dpadMode/faceMode is 'separate' (see customPieces below).
  const buildDpadPiece = (dir: 'up' | 'down' | 'left' | 'right', s = 1) => {
    const size = 44 * s;
    const bit = dir === 'up' ? BTN.DPadUp : dir === 'down' ? BTN.DPadDown : dir === 'left' ? BTN.DPadLeft : BTN.DPadRight;
    const glyph = dir === 'up' ? '▲' : dir === 'down' ? '▼' : dir === 'left' ? '◀' : '▶';
    return (
      <TouchButton onDown={() => setButton(bit, true)} onUp={() => setButton(bit, false)} style={{ width: `${size}px`, height: `${size}px`, fontSize: `${15 * s}px` }}>
        {glyph}
      </TouchButton>
    );
  };

  const buildFacePiece = (which: 'a' | 'b' | 'x' | 'y', s = 1) => {
    const size = 48 * s;
    const bit = which === 'a' ? BTN.A : which === 'b' ? BTN.B : which === 'x' ? BTN.X : BTN.Y;
    return (
      <TouchButton round onDown={() => setButton(bit, true)} onUp={() => setButton(bit, false)} style={{ width: `${size}px`, height: `${size}px`, color: faceColors[which], fontSize: `${16 * s}px` }}>
        {faceLabels[which]}
      </TouchButton>
    );
  };

  const buildShoulder = (which: 'lb' | 'rb', w: number, h: number) => (
    <TouchButton
      onDown={() => setButton(which === 'lb' ? BTN.LeftShoulder : BTN.RightShoulder, true)}
      onUp={() => setButton(which === 'lb' ? BTN.LeftShoulder : BTN.RightShoulder, false)}
      style={{ width: `${w}px`, height: `${h}px` }}
    >
      {which.toUpperCase()}
    </TouchButton>
  );

  const buildTriggerButton = (which: 'lt' | 'rt', w: number, h: number) => (
    <TouchButton
      onDown={() => { state.current[which] = TRIGGER_RANGE; }}
      onUp={() => { state.current[which] = 0; }}
      style={{ width: `${w}px`, height: `${h}px`, fontSize: '13px' }}
    >
      {which.toUpperCase()}
    </TouchButton>
  );

  const buildSelect = (s = 1) => (
    <TouchButton onDown={() => setButton(BTN.Back, true)} onUp={() => setButton(BTN.Back, false)} style={{ width: `${48 * s}px`, height: `${30 * s}px`, fontSize: `${10 * s}px` }}>
      SELECT
    </TouchButton>
  );
  const buildStart = (s = 1) => (
    <TouchButton onDown={() => setButton(BTN.Start, true)} onUp={() => setButton(BTN.Start, false)} style={{ width: `${48 * s}px`, height: `${30 * s}px`, fontSize: `${10 * s}px` }}>
      START
    </TouchButton>
  );

  const lb = buildShoulder('lb', isDriving ? 56 : 80, isDriving ? 64 : 104);
  const rb = buildShoulder('rb', isDriving ? 56 : 80, isDriving ? 64 : 104);

  const modeButtonStyle: React.CSSProperties = {
    padding: '4px 10px', fontSize: '10px', fontWeight: 600, borderRadius: '6px',
    border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-color)',
  };

  /** Select, Start, and Exit, plus one gear button that opens Joystick Settings (preset switching,
   *  skin, and — while a custom preset is active — its edit/split/trigger-mode/delete controls;
   *  see JoystickSettingsModal). NOT part of the draggable Custom set on purpose — Exit obviously
   *  can't be allowed to get buried somewhere hard to find, and Select/Start stay pinned right
   *  alongside it rather than being individually movable. */
  const systemControls = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        {buildSelect()}
        <button onClick={onClose} style={{ padding: '7px 14px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '6px', fontSize: '11px', fontWeight: 700 }}>
          Exit
        </button>
        {buildStart()}
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        {editing ? (
          // While editing, the gear is replaced by a Done button right here — no need to reopen
          // the modal just to stop editing (which itself opened by closing the modal, since the
          // play surface must be visible/interactive to drag things).
          <button
            onClick={() => setEditing(false)}
            style={{ ...modeButtonStyle, background: 'var(--accent-color, #009bd5)', color: '#fff' }}
          >
            Done Editing
          </button>
        ) : (
          <button onClick={() => setSettingsOpen(true)} style={{ ...modeButtonStyle, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </button>
        )}
      </div>
    </div>
  );

  // ----- Custom layout -----

  const setPlacement = (id: ControlId, p: Placement) => {
    if (!activePreset) return;
    onUpdatePreset(activePreset.id, { positions: { ...activePreset.positions, [id]: p } });
  };

  const splitCluster = (which: 'dpad' | 'face') => {
    if (!activePreset) return;
    if (which === 'dpad') {
      const base = activePreset.positions.dpad;
      onUpdatePreset(activePreset.id, {
        dpadMode: 'separate',
        positions: {
          ...activePreset.positions,
          dpadUp: offsetPosition(base, 'up', SPREAD_PX),
          dpadDown: offsetPosition(base, 'down', SPREAD_PX),
          dpadLeft: offsetPosition(base, 'left', SPREAD_PX),
          dpadRight: offsetPosition(base, 'right', SPREAD_PX),
        },
      });
    } else {
      const base = activePreset.positions.face;
      onUpdatePreset(activePreset.id, {
        faceMode: 'separate',
        positions: {
          ...activePreset.positions,
          // Matches buildFaceButtons' diamond: Y top, X left, B right, A bottom.
          faceY: offsetPosition(base, 'up', SPREAD_PX),
          faceA: offsetPosition(base, 'down', SPREAD_PX),
          faceX: offsetPosition(base, 'left', SPREAD_PX),
          faceB: offsetPosition(base, 'right', SPREAD_PX),
        },
      });
    }
  };

  // Combining back never touches the stored combined-block position (it was never overwritten
  // while separate), so this genuinely "gets back the classic one" — wherever it was left.
  const combineCluster = (which: 'dpad' | 'face') => {
    if (!activePreset) return;
    onUpdatePreset(activePreset.id, which === 'dpad' ? { dpadMode: 'combined' } : { faceMode: 'combined' });
  };

  // Tap/pull/push, and its sensitivity, now applies per-trigger and to whichever layout is active
  // (see ActiveModes' doc comment) — used for Classic and Driving's LT/RT too, not just Custom's
  // (sy is only consulted by the FREE_RESIZE_IDS entries; the rest are square/round and use sx for
  // both axes, see Placement's doc comment).
  const buildTrigger = (which: 'lt' | 'rt', w: number, h: number) => {
    const mode = which === 'lt' ? modes.ltMode : modes.rtMode;
    const sensitivity = which === 'lt' ? modes.ltSensitivity : modes.rtSensitivity;
    return mode === 'tap'
      ? buildTriggerButton(which, w, h)
      : <TriggerDragPad label={which.toUpperCase()} width={w} height={h} invert={mode === 'push'} sensitivity={sensitivity} onChange={(v) => { state.current[which] = v; }} />;
  };

  const buildLeftStickCluster = (wheelDiameter = 136) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
      {modes.lsMode === 'steer'
        ? <SteeringWheel diameter={wheelDiameter} sensitivity={modes.steeringSensitivity} onChange={(x) => { state.current.lx = x; state.current.ly = 0; }} />
        : <StickPad label="LS" sensitivity={modes.lsSensitivity} onChange={(x, y) => { state.current.lx = x; state.current.ly = y; }} />}
      {buildDpad()}
    </div>
  );

  const customPieces: { id: ControlId; node: (sx: number, sy: number) => React.ReactNode }[] = activePreset ? [
    { id: 'ls', node: (sx) => modes.lsMode === 'steer'
      ? <SteeringWheel diameter={136 * sx} sensitivity={modes.steeringSensitivity} onChange={(x) => { state.current.lx = x; state.current.ly = 0; }} />
      : <StickPad label="LS" diameter={136 * sx} sensitivity={modes.lsSensitivity} onChange={(x, y) => { state.current.lx = x; state.current.ly = y; }} /> },
    { id: 'rs', node: (sx) => <StickPad label="RS" diameter={136 * sx} sensitivity={modes.rsSensitivity} onChange={(x, y) => { state.current.rx = x; state.current.ry = y; }} /> },
    ...(activePreset.dpadMode === 'separate'
      ? ([
          { id: 'dpadUp', node: (sx: number) => buildDpadPiece('up', sx) },
          { id: 'dpadDown', node: (sx: number) => buildDpadPiece('down', sx) },
          { id: 'dpadLeft', node: (sx: number) => buildDpadPiece('left', sx) },
          { id: 'dpadRight', node: (sx: number) => buildDpadPiece('right', sx) },
        ] as const)
      : ([{ id: 'dpad', node: (sx: number) => buildDpad(sx) }] as const)),
    ...(activePreset.faceMode === 'separate'
      ? ([
          { id: 'faceY', node: (sx: number) => buildFacePiece('y', sx) },
          { id: 'faceX', node: (sx: number) => buildFacePiece('x', sx) },
          { id: 'faceB', node: (sx: number) => buildFacePiece('b', sx) },
          { id: 'faceA', node: (sx: number) => buildFacePiece('a', sx) },
        ] as const)
      : ([{ id: 'face', node: (sx: number) => buildFaceButtons(sx) }] as const)),
    { id: 'lb', node: (sx, sy) => buildShoulder('lb', 80 * sx, 104 * sy) },
    { id: 'rb', node: (sx, sy) => buildShoulder('rb', 80 * sx, 104 * sy) },
    { id: 'lt', node: (sx, sy) => buildTrigger('lt', 80 * sx, 104 * sy) },
    { id: 'rt', node: (sx, sy) => buildTrigger('rt', 80 * sx, 104 * sy) },
  ] : [];

  return (
    // The "landscape" height here is really the phone's own physical WIDTH (often only
    // ~380-420px, before padding) — nothing in the FIXED layouts may stack vertically beyond one
    // band of controls, or it gets clipped by .landscape-overlay's overflow:hidden. Classic and
    // Driving are therefore laid out in horizontal bands; Custom sidesteps the whole problem by
    // absolutely positioning everything in percentage space instead.
    <div id="joystickSurface" className={className} style={{ height: '100vw', width: '100vh', padding: '10px 20px', background: 'var(--bg-color)', color: 'var(--text-color)' }}>
      {/* Select/Start/Exit + the skin/layout/edit switches — pinned top-center in EXACTLY the
          same spot in all three presets (this used to be laid out inline in Classic/Driving's top
          bar instead, which meant it visibly jumped position when switching presets mid-session;
          rendering it once, here, unconditionally, is what guarantees it can't drift between
          them). Sits above everything else via zIndex. */}
      <div style={{ position: 'absolute', top: '6px', left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
        {systemControls}
      </div>

      {isCustom && activePreset ? (
        <div style={{ position: 'absolute', inset: 0 }}>
          {customPieces.map(({ id, node }) => (
            <DraggableControl
              key={id}
              placement={activePreset.positions[id]}
              editing={editing}
              freeResize={FREE_RESIZE_IDS.has(id)}
              onChange={(p) => setPlacement(id, p)}
            >
              {node(activePreset.positions[id].sx, activePreset.positions[id].sy)}
            </DraggableControl>
          ))}

          {editing && (
            <div style={{ position: 'absolute', bottom: '8px', left: '50%', transform: 'translateX(-50%)', fontSize: '11px', color: 'var(--text-muted)', pointerEvents: 'none' }}>
              Drag to move · drag ⤢ to resize (LB/RB/LT/RT stretch freely)
            </div>
          )}
        </div>
      ) : (
        <>
          {isDriving ? (
            // Driving top bar: LB+RB grouped together on the left (LT/RT moved down into the main
            // row as pedal-shaped controls, so there's nothing left on the top-right).
            // Select/Exit/Start is NOT rendered here — see the pinned block above. width:100% is
            // load-bearing: this is a direct child of .landscape-overlay, which centers its
            // children by default — without it this would drift to the horizontal center instead
            // of staying left.
            <div style={{ display: 'flex', gap: '6px', width: '100%' }}>{lb}{rb}</div>
          ) : (
            // Classic top bar: LT+LB and RT+RB as horizontal pairs (not stacked) — same vertical
            // band the pinned Select/Exit/Start sits in, so this row's total height is just one
            // control's height, not two. There's plenty of spare vertical budget in this row
            // specifically (the main row below is the tall one), so these are free to be large.
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                {buildTrigger('lt', 80, 104)}
                {lb}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {rb}
                {buildTrigger('rt', 80, 104)}
              </div>
            </div>
          )}

          {isDriving ? (
            // Driving main row: LS-slot + D-pad on the left (full size — no longer stacked with
            // anything, unlike RS below). RS stacked ABOVE face buttons + LT/RT on the right —
            // shrunk (see StickPad's diameter prop) to fit two rows in that one column. The LS
            // slot itself swaps between a plain stick and the rotate-to-turn SteeringWheel per
            // modes.lsMode (see ActiveModes' doc comment — this is a toggle, not a preset).
            <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'min(70px, 8vh)' }}>
              {buildLeftStickCluster(150)}

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                <StickPad label="RS" diameter={106} sensitivity={modes.rsSensitivity} onChange={(x, y) => { state.current.rx = x; state.current.ry = y; }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {buildFaceButtons()}
                  {buildTrigger('lt', 66, 130)}
                  {buildTrigger('rt', 66, 130)}
                </div>
              </div>
            </div>
          ) : (
            // Classic main row: D-pad beside (not above) its stick, stick beside (not below) face
            // buttons — side-by-side keeps this whole row's height down to a single control's
            // worth (~150px), not a two-control stack. Centered with a fixed, generous gap between
            // the two clusters so it stays comfortably wide regardless of phone size.
            <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'min(90px, 10vh)' }}>
              {buildLeftStickCluster(136)}
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                {buildFaceButtons()}
                <StickPad label="RS" sensitivity={modes.rsSensitivity} onChange={(x, y) => { state.current.rx = x; state.current.ry = y; }} />
              </div>
            </div>
          )}
        </>
      )}

      {settingsOpen && (
        <JoystickSettingsModal
          skin={skin}
          onSkinChange={onSkinChange}
          haptics={haptics}
          onHapticsChange={onHapticsChange}
          layout={layout}
          onLayoutChange={onLayoutChange}
          modes={modes}
          onModesChange={onModesChange}
          customPresets={customPresets}
          activePreset={activePreset}
          onCreatePreset={onCreatePreset}
          onDeletePreset={onDeletePreset}
          onRenamePreset={onRenamePreset}
          onUpdatePreset={onUpdatePreset}
          onEditPreset={(id) => { onLayoutChange(id); setSettingsOpen(false); setEditing(true); }}
          onSplitCluster={splitCluster}
          onCombineCluster={combineCluster}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Joystick Settings — the single gear-button modal that consolidates preset switching/creation/
// deletion, skin switching, LT/RT/LS mode toggles + their sensitivity sliders (which apply to
// whichever layout is currently active — Classic and Driving included, not just custom presets),
// and (only while a custom preset is active) that preset's split-cluster/reset controls. Classic
// and Driving are listed but not renameable/deletable — they're fixed built-ins (see
// isBuiltinLayout).
// ---------------------------------------------------------------------------------------------

const SensitivityRow: React.FC<{ label: string; value: number; onChange: (v: number) => void }> = ({ label, value, onChange }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
    <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '64px', flexShrink: 0 }}>{label}</span>
    <input
      type="range"
      min={SENSITIVITY_MIN}
      max={SENSITIVITY_MAX}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ flex: 1, accentColor: 'var(--accent-color, #009bd5)' }}
    />
    <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', width: '26px', textAlign: 'right', flexShrink: 0 }}>{value}</span>
  </div>
);

const JoystickSettingsModal: React.FC<{
  skin: 'xbox' | 'ps';
  onSkinChange: (skin: 'xbox' | 'ps') => void;
  haptics: boolean;
  onHapticsChange: (haptics: boolean) => void;
  layout: string;
  onLayoutChange: (layout: string) => void;
  modes: ActiveModes;
  onModesChange: (patch: Partial<ActiveModes>) => void;
  customPresets: CustomPreset[];
  activePreset: CustomPreset | null;
  onCreatePreset: () => void;
  onDeletePreset: (id: string) => void;
  onRenamePreset: (id: string, name: string) => void;
  onUpdatePreset: (id: string, patch: Partial<CustomPreset>) => void;
  /** Selects the given preset as active AND enters edit mode immediately (one tap does both). */
  onEditPreset: (id: string) => void;
  onSplitCluster: (which: 'dpad' | 'face') => void;
  onCombineCluster: (which: 'dpad' | 'face') => void;
  onClose: () => void;
}> = ({
  skin, onSkinChange, haptics, onHapticsChange, layout, onLayoutChange, modes, onModesChange,
  customPresets, activePreset, onCreatePreset, onDeletePreset, onRenamePreset, onUpdatePreset, onEditPreset,
  onSplitCluster, onCombineCluster, onClose,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Armed by a first tap on Delete; a second tap on the row actually deletes. Tracking just one id
  // (not a set) is enough since only one row's confirm state needs to be visible at a time —
  // switching to confirm on a different row implicitly cancels any other in-flight confirmation.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    padding: '9px 12px', borderRadius: '8px',
    background: active ? 'rgba(0, 155, 213, 0.15)' : 'var(--input-bg)',
    border: `1px solid ${active ? 'var(--accent-color, #009bd5)' : 'var(--border-color)'}`,
  });
  const smallButtonStyle: React.CSSProperties = {
    padding: '4px 9px', fontSize: '10px', fontWeight: 600, borderRadius: '5px',
    border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-color)',
  };
  const toggleButtonStyle = (on: boolean): React.CSSProperties => ({
    ...smallButtonStyle,
    background: on ? 'var(--accent-color, #009bd5)' : 'var(--input-bg)',
    color: on ? 'var(--btn-primary-text, #fff)' : 'var(--text-muted)',
    border: `1px solid ${on ? 'var(--accent-color, #009bd5)' : 'var(--border-color)'}`,
  });

  const commitRename = () => {
    if (renamingId && renameValue.trim()) onRenamePreset(renamingId, renameValue.trim());
    setRenamingId(null);
  };

  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 20,
        background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
      onClick={onClose}
      onTouchStart={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '440px', maxHeight: '100%', overflowY: 'auto',
          background: 'var(--modal-bg, #1a1a1a)', border: '1px solid var(--border-color)',
          borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-color)' }}>Joystick Settings</div>
          <button onClick={onClose} style={{ ...smallButtonStyle, padding: '5px 10px' }}>Close</button>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>Skin</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => onSkinChange('xbox')} style={toggleButtonStyle(skin === 'xbox')}>Xbox</button>
            <button onClick={() => onSkinChange('ps')} style={toggleButtonStyle(skin === 'ps')}>PlayStation</button>
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>Haptics</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={() => onHapticsChange(true)} style={toggleButtonStyle(haptics)}>On</button>
            <button onClick={() => onHapticsChange(false)} style={toggleButtonStyle(!haptics)}>Off</button>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>Presets</div>
            <button onClick={onCreatePreset} style={smallButtonStyle}>+ New Preset</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {(['classic', 'driving'] as const).map((id) => (
              <div key={id} style={rowStyle(layout === id)}>
                <button onClick={() => onLayoutChange(id)} style={{ background: 'none', border: 'none', color: 'var(--text-color)', fontSize: '12.5px', fontWeight: 600, flex: 1, textAlign: 'left', padding: 0 }}>
                  {id === 'classic' ? 'Classic' : 'Driving'}
                </button>
              </div>
            ))}
            {customPresets.map((p) => (
              <div key={p.id} style={rowStyle(layout === p.id)}>
                {confirmDeleteId === p.id ? (
                  <>
                    <span style={{ flex: 1, fontSize: '12px', color: '#ef4444', fontWeight: 600 }}>Delete "{p.name}"?</span>
                    <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                      <button onClick={() => setConfirmDeleteId(null)} style={smallButtonStyle}>Cancel</button>
                      <button
                        onClick={() => { onDeletePreset(p.id); setConfirmDeleteId(null); }}
                        style={{ ...smallButtonStyle, background: '#ef4444', color: '#fff', borderColor: '#ef4444' }}
                      >
                        Confirm Delete
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {renamingId === p.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); }}
                        style={{ flex: 1, background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: '5px', color: 'var(--text-color)', fontSize: '12.5px', padding: '3px 6px' }}
                      />
                    ) : (
                      <button onClick={() => onLayoutChange(p.id)} style={{ background: 'none', border: 'none', color: 'var(--text-color)', fontSize: '12.5px', fontWeight: 600, flex: 1, textAlign: 'left', padding: 0 }}>
                        {p.name}
                      </button>
                    )}
                    <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                      <button onClick={() => onEditPreset(p.id)} style={smallButtonStyle}>Edit</button>
                      <button onClick={() => { setRenamingId(p.id); setRenameValue(p.name); }} style={smallButtonStyle}>Rename</button>
                      <button
                        onClick={() => setConfirmDeleteId(p.id)}
                        style={{ ...smallButtonStyle, color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
            Controls (applies to "{isBuiltinLayout(layout) ? (layout === 'classic' ? 'Classic' : 'Driving') : activePreset?.name || ''}")
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '64px' }}>LT</span>
              <button onClick={() => onModesChange({ ltMode: 'tap' })} style={toggleButtonStyle(modes.ltMode === 'tap')}>Tap</button>
              <button onClick={() => onModesChange({ ltMode: 'pull' })} style={toggleButtonStyle(modes.ltMode === 'pull')}>Pull</button>
              <button onClick={() => onModesChange({ ltMode: 'push' })} style={toggleButtonStyle(modes.ltMode === 'push')}>Push</button>
            </div>
            {modes.ltMode !== 'tap' && (
              <SensitivityRow label="LT feel" value={modes.ltSensitivity} onChange={(v) => onModesChange({ ltSensitivity: v })} />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '64px' }}>RT</span>
              <button onClick={() => onModesChange({ rtMode: 'tap' })} style={toggleButtonStyle(modes.rtMode === 'tap')}>Tap</button>
              <button onClick={() => onModesChange({ rtMode: 'pull' })} style={toggleButtonStyle(modes.rtMode === 'pull')}>Pull</button>
              <button onClick={() => onModesChange({ rtMode: 'push' })} style={toggleButtonStyle(modes.rtMode === 'push')}>Push</button>
            </div>
            {modes.rtMode !== 'tap' && (
              <SensitivityRow label="RT feel" value={modes.rtSensitivity} onChange={(v) => onModesChange({ rtSensitivity: v })} />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '64px' }}>LS</span>
              <button onClick={() => onModesChange({ lsMode: 'stick' })} style={toggleButtonStyle(modes.lsMode === 'stick')}>Stick</button>
              <button onClick={() => onModesChange({ lsMode: 'steer' })} style={toggleButtonStyle(modes.lsMode === 'steer')}>Steer</button>
            </div>
            {modes.lsMode === 'steer' ? (
              <SensitivityRow label="LS feel" value={modes.steeringSensitivity} onChange={(v) => onModesChange({ steeringSensitivity: v })} />
            ) : (
              <SensitivityRow label="LS feel" value={modes.lsSensitivity} onChange={(v) => onModesChange({ lsSensitivity: v })} />
            )}
            {/* RS is always a stick — no mode toggle, just its own feel. */}
            <SensitivityRow label="RS feel" value={modes.rsSensitivity} onChange={(v) => onModesChange({ rsSensitivity: v })} />
          </div>
        </div>

        {activePreset && (
          <div>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>Layout</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '64px' }}>D-pad</span>
                <button onClick={() => onCombineCluster('dpad')} style={toggleButtonStyle(activePreset.dpadMode === 'combined')}>Combined</button>
                <button onClick={() => onSplitCluster('dpad')} style={toggleButtonStyle(activePreset.dpadMode === 'separate')}>Separate</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '64px' }}>Face btns</span>
                <button onClick={() => onCombineCluster('face')} style={toggleButtonStyle(activePreset.faceMode === 'combined')}>Combined</button>
                <button onClick={() => onSplitCluster('face')} style={toggleButtonStyle(activePreset.faceMode === 'separate')}>Separate</button>
              </div>
              <button
                onClick={() => onUpdatePreset(activePreset.id, { positions: DEFAULT_CUSTOM_LAYOUT, dpadMode: 'combined', faceMode: 'combined' })}
                style={{ ...smallButtonStyle, alignSelf: 'flex-start' }}
              >
                Reset Positions
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default JoystickOverlay;
