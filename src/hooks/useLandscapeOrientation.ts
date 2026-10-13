import { useState, useEffect } from 'react';

type LandscapeOrientationType = 'landscape-primary' | 'landscape-secondary';

export interface LandscapeOrientationState {
  orientation: LandscapeOrientationType;
  angle: number; // 90 or 270 (-90)
  className: string; // 'landscape-overlay' or 'landscape-overlay-reverse'
  transformDelta: (dx: number, dy: number) => { dx: number; dy: number };
  transformPoint: (x: number, y: number, width: number, height: number) => { x: number; y: number };
}

/**
 * Hook to automatically determine device landscape orientation (primary 90deg vs secondary 270deg/-90deg)
 * and provide the corresponding CSS class and touch coordinate transform helpers.
 */
export function useLandscapeOrientation(): LandscapeOrientationState {
  const [orientation, setOrientation] = useState<LandscapeOrientationType>('landscape-primary');
  const [angle, setAngle] = useState<number>(90);

  useEffect(() => {
    const updateOrientation = () => {
      let detectedAngle = 90;

      // 1. Modern Screen Orientation API
      if (window.screen?.orientation) {
        const type = window.screen.orientation.type;
        const currentAngle = window.screen.orientation.angle;
        if (type === 'landscape-secondary' || currentAngle === 270) {
          detectedAngle = 270;
        } else if (type === 'landscape-primary' || currentAngle === 90) {
          detectedAngle = 90;
        }
      } 
      // 2. Legacy window.orientation fallback
      else if (typeof window.orientation === 'number') {
        if (window.orientation === -90 || window.orientation === 270) {
          detectedAngle = 270;
        } else if (window.orientation === 90) {
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
    const REQUIRED_STABLE_FRAMES = 5; // Require 5 consecutive consistent readings to flip

    // devicemotion (accelerationIncludingGravity) provides physical gravity vector (m/s^2)
    // When phone is upright: ax ~= 0, ay ~= 9.8, az ~= 0
    // When phone is in landscape-primary (top to left, rotated 90deg CW):
    //   Left edge points down, so Gravity pulls toward top of phone -> ax is POSITIVE (+6 to +9.8 m/s^2)
    // When phone is in landscape-secondary (top to right, rotated 90deg CCW / 270deg):
    //   Right edge points down, so Gravity pulls toward bottom of phone -> ax is NEGATIVE (-6 to -9.8 m/s^2)
    const handleDeviceMotion = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      if (!acc || acc.x === null || acc.x === undefined) return;

      const ax = acc.x; // Gravity along device X-axis
      const ay = acc.y ?? 0;

      // Only switch when the device is predominantly held in landscape (horizontal gravity exceeds vertical)
      // and has sufficient tilt along the X axis.
      // We apply hysteresis: to switch from 90 to 270, ax must be < -3.5. To switch from 270 to 90, ax must be > +3.5.
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

  const isReverse = orientation === 'landscape-secondary';

  // Coordinate delta transformation for relative movements (touchpad, presenter swipes, joysticks)
  const transformDelta = (dx: number, dy: number) => {
    if (isReverse) {
      // Rotated -90deg / 270deg:
      // Screen X goes in raw -Y direction; Screen Y goes in raw +X direction
      return { dx: -dy, dy: dx };
    }
    // Rotated 90deg:
    // Screen X goes in raw +Y direction; Screen Y goes in raw -X direction
    return { dx: dy, dy: -dx };
  };

  // Absolute coordinate mapping from viewport touch (clientX, clientY) to unrotated overlay coordinates (0..w, 0..h)
  const transformPoint = (touchClientX: number, touchClientY: number, containerWidth: number, containerHeight: number) => {
    if (isReverse) {
      // In reverse landscape (-90deg), visual (0,0) is at top-right of portrait screen (X=viewportWidth, Y=0)
      return {
        x: touchClientY,
        y: containerHeight - touchClientX,
      };
    }
    // In primary landscape (90deg), visual (0,0) is at bottom-left of portrait screen (X=0, Y=viewportHeight)
    return {
      x: containerWidth - touchClientY,
      y: touchClientX,
    };
  };

  return {
    orientation,
    angle,
    className: isReverse ? 'landscape-overlay landscape-overlay-reverse' : 'landscape-overlay',
    transformDelta,
    transformPoint,
  };
}
