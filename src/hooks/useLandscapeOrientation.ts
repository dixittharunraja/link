import { useState, useEffect } from 'react';

type LandscapeOrientationType = 'landscape-primary' | 'landscape-secondary';

interface LandscapeOrientationState {
  orientation: LandscapeOrientationType;
  angle: number; // 90 or 270
  // '' when the overlay is shown in portrait, otherwise 'landscape-overlay' (plus
  // 'landscape-overlay-reverse' at 270)
  className: string;
  transformDelta: (dx: number, dy: number) => { dx: number; dy: number };
  transformPoint: (x: number, y: number, width: number, height: number) => { x: number; y: number };
}

/**
 * Tracks which way a phone is held in landscape (90 or 270 degrees) for the full-screen overlays
 * that rotate a portrait page with CSS, and provides the matching class and touch transforms.
 * Also turns on immersive mode while mounted.
 *
 * Portrait or landscape is chosen by the caller (`landscape`), never guessed from the sensor. Only
 * the side of landscape (90 or 270) is automatic. In portrait the class is empty and the transforms
 * return their input unchanged.
 */
export function useLandscapeOrientation(landscape: boolean = true): LandscapeOrientationState {
  const [orientation, setOrientation] = useState<LandscapeOrientationType>('landscape-primary');
  const [angle, setAngle] = useState<number>(90);

  useEffect(() => {
    const updateOrientation = () => {
      let detectedAngle = 90;

      // Screen Orientation API.
      if (window.screen?.orientation) {
        const type = window.screen.orientation.type;
        const currentAngle = window.screen.orientation.angle;
        if (type === 'landscape-secondary' || currentAngle === 270) {
          detectedAngle = 270;
        } else if (type === 'landscape-primary' || currentAngle === 90) {
          detectedAngle = 90;
        }
      }

      if (detectedAngle === 270) {
        setOrientation('landscape-secondary');
        setAngle(270);
      } else {
        setOrientation('landscape-primary');
        setAngle(90);
      }
    };

    let currentDetected = 90;
    let pendingDetected = 90;
    let pendingCount = 0;
    const REQUIRED_STABLE_FRAMES = 5; // consecutive readings needed to flip

    // The gravity vector also drives the orientation, so the overlay follows the phone even when
    // the system does not report a rotation. Upright, ax is about 0 and ay about 9.8 m/s^2; in
    // landscape-primary ax is positive (about +6 to +9.8), in landscape-secondary negative.
    const handleDeviceMotion = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      if (!acc || acc.x === null || acc.x === undefined) return;

      const ax = acc.x;
      const ay = acc.y ?? 0;

      // Switches only when the phone is mostly horizontal, with hysteresis: ax must pass -3.5 to
      // go to 270 and +3.5 to go back to 90.
      let newAngle = currentDetected;

      if (currentDetected === 90) {
        if (ax < -3.5 && Math.abs(ax) > Math.abs(ay) * 0.7) {
          newAngle = 270;
        }
      } else {
        if (ax > 3.5 && Math.abs(ax) > Math.abs(ay) * 0.7) {
          newAngle = 90;
        }
      }

      if (newAngle !== currentDetected) {
        if (newAngle === pendingDetected) {
          pendingCount++;
          if (pendingCount >= REQUIRED_STABLE_FRAMES) {
            currentDetected = newAngle;
            pendingCount = 0;
            if (newAngle === 270) {
              setOrientation('landscape-secondary');
              setAngle(270);
            } else {
              setOrientation('landscape-primary');
              setAngle(90);
            }
          }
        } else {
          pendingDetected = newAngle;
          pendingCount = 1;
        }
      } else {
        pendingCount = 0;
      }
    };

    updateOrientation();

    if (window.screen?.orientation) {
      window.screen.orientation.addEventListener('change', updateOrientation);
    }
    window.addEventListener('orientationchange', updateOrientation);
    window.addEventListener('devicemotion', handleDeviceMotion);
    const linkApi = (window as any).link;
    linkApi?.setImmersiveMode?.(true);

    return () => {
      linkApi?.setImmersiveMode?.(false);
      if (window.screen?.orientation) {
        window.screen.orientation.removeEventListener('change', updateOrientation);
      }
      window.removeEventListener('orientationchange', updateOrientation);
      window.removeEventListener('devicemotion', handleDeviceMotion);
    };
  }, []);

  const isReverse = landscape && orientation === 'landscape-secondary';

  // Converts a raw touch delta into the rotated overlay's frame (touchpad, presenter, joystick).
  const transformDelta = (dx: number, dy: number) => {
    if (!landscape) return { dx, dy };
    if (isReverse) {
      // 270: visual X is raw -Y, visual Y is raw +X.
      return { dx: -dy, dy: dx };
    }
    // 90: visual X is raw +Y, visual Y is raw -X.
    return { dx: dy, dy: -dx };
  };

  // Maps a viewport touch (clientX, clientY) to the overlay's unrotated coordinates (0..w, 0..h).
  const transformPoint = (touchClientX: number, touchClientY: number, containerWidth: number, containerHeight: number) => {
    if (!landscape) return { x: touchClientX, y: touchClientY };
    if (isReverse) {
      // At 270 the visual origin is the portrait screen's top-right corner.
      return {
        x: touchClientY,
        y: containerHeight - touchClientX,
      };
    }
    // At 90 the visual origin is the portrait screen's bottom-left corner.
    return {
      x: containerWidth - touchClientY,
      y: touchClientX,
    };
  };

  return {
    orientation,
    angle,
    className: !landscape ? '' : isReverse ? 'landscape-overlay landscape-overlay-reverse' : 'landscape-overlay',
    transformDelta,
    transformPoint,
  };
}
