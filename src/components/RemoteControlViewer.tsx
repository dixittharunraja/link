import React, { useEffect, useRef, useState, useCallback } from 'react';
import { LinkApi } from '../vite-env';
import { useLandscapeOrientation } from '../hooks/useLandscapeOrientation';
import { IS_ANDROID, IS_TV } from '../utils/platform';
import { pushBackHandler } from '../utils/backNav';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface RemoteControlViewerProps {
  deviceId: string;
  deviceName: string;
  // Decides whether Android-only controls apply (a PC host has none) and seeds the orientation
  // until the first frame arrives (see frameIsLandscape).
  hostDeviceType?: string;
  // The host's connection state from App.tsx's peers map, so the viewer can resume after a drop.
  hostConnected?: boolean;
  onClose: () => void;
  onEndSession?: () => void;
  // Shows the PC's second screen (a real or virtual extra monitor) instead of its main screen, so
  // the phone works as an extended display.
  secondScreen?: boolean;
}

const linkApi = (window as any).link as LinkApi;

const KeyboardIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h12" />
  </svg>
);

const RemoteControlViewer: React.FC<RemoteControlViewerProps> = ({
  deviceId,
  deviceName,
  hostDeviceType,
  hostConnected,
  onClose,
  onEndSession,
  secondScreen,
}) => {
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isHostMobileLike = hostDeviceType === 'phone' || hostDeviceType === 'tv';

  const hasReceivedFrame = useRef(false);
  // When the stream last showed movement; `attempt` below restarts the whole connection.
  const lastProgressRef = useRef(Date.now());
  // Repeated requests stop once the host refuses (denied, removed) or the viewer gives up waiting.
  const retryAllowedRef = useRef(true);
  // Latest close handler for effects that must not restart when the parent re-renders.
  const endSessionRef = useRef(onEndSession ?? onClose);
  endSessionRef.current = onEndSession ?? onClose;
  const [attempt, setAttempt] = useState(0);

  const isLocalMobile = IS_ANDROID;

  // Orientation follows the mirrored frame's aspect ratio. Until the first frame arrives (null),
  // it is guessed from the host's device type.
  const [frameIsLandscape, setFrameIsLandscape] = useState<boolean | null>(null);
  // Which way the picture is laid out on the phone (mirroring and the second screen alike):
  // - The toolbar switch (viewMode) decides once the user has used it.
  // - Until then the mirrored frame's own shape (its resolution) decides, so a landscape PC screen
  //   or a portrait monitor fills the phone. Before the first frame, the host's device type guesses.
  // Only the side of landscape (90 or 270) follows the phone's sensor.
  const [viewMode, setViewMode] = useState<'portrait' | 'landscape' | null>(null);
  const frameWantsLandscape = frameIsLandscape ?? (hostDeviceType === 'desktop' || hostDeviceType === 'tv');
  // A TV is already landscape: rotating the page by 90 degrees (for a phone held sideways) would turn it over.
  const forceLandscape = isLocalMobile && !IS_TV && (viewMode ? viewMode === 'landscape' : frameWantsLandscape);
  const { className: landscapeClassName, orientation: landscapeOrientation, transformDelta } = useLandscapeOrientation(forceLandscape);

  // Measured in JS rather than using CSS 100vh/100vw, which can differ slightly from
  // window.innerWidth/innerHeight in mobile WebViews. Using one value for both the rotated box's
  // size and the hit-test math keeps edges from being clipped. Updated on resize.
  const [viewportSize, setViewportSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // On Android: immersive fullscreen, and edge swipes are claimed so they reach the mirrored device
  // instead of triggering this phone's back/home gestures. Both are cleared on unmount.
  useEffect(() => {
    if (!isLocalMobile) return;
    linkApi?.setImmersiveMode?.(true);
    linkApi?.setSystemGestureExclusion?.(true);
    return () => {
      linkApi?.setImmersiveMode?.(false);
      linkApi?.setSystemGestureExclusion?.(false);
    };
  }, [isLocalMobile]);

  // Android's back gesture can't be excluded along the whole edge (the system caps the excluded
  // height), so a stray edge swipe would otherwise fall through to App's root back handler and
  // switch tab or minimize the app mid-session. Back is swallowed here: the first press shows a
  // hint, a second within 1.5 s ends the session. The bubble menu's exit button still ends it at once.
  const [exitHint, setExitHint] = useState(false);
  useEffect(() => {
    if (!isLocalMobile) return;
    let lastBack = 0;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const popBack = pushBackHandler(() => {
      const now = Date.now();
      if (now - lastBack < 1500) {
        if (hintTimer) clearTimeout(hintTimer);
        endSessionRef.current();
        return true;
      }
      lastBack = now;
      setExitHint(true);
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => setExitHint(false), 1500);
      return true;
    });
    return () => {
      popBack();
      if (hintTimer) clearTimeout(hintTimer);
    };
  }, [isLocalMobile]);

  // A draggable floating bubble that expands into the session controls when tapped.
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number } | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // Full screen on the desktop: the app window itself goes full screen (covering the taskbar) and the
  // viewer covers the app's title bar. The browser's own fullscreen request is not used: inside the
  // app window it enlarged the window without resizing the page, leaving a blank strip where the
  // taskbar had been. The phone already runs this view immersive.
  const viewerRootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  // A window that was maximised before going full screen is maximised again afterwards.
  const wasMaximizedRef = useRef(false);
  const setWindowFullscreen = useCallback(async (on: boolean) => {
    try {
      const appWindow = getCurrentWindow();
      if (on) {
        // A frameless window that goes full screen while maximised keeps its webview at the
        // maximised size, leaving a strip where the taskbar was. Unmaximise first.
        wasMaximizedRef.current = await appWindow.isMaximized();
        if (wasMaximizedRef.current) await appWindow.unmaximize();
        await appWindow.setFullscreen(true);
      } else {
        await appWindow.setFullscreen(false);
        if (wasMaximizedRef.current) await appWindow.maximize();
      }
      // The app's title bar takes part in the page layout; hide it while full screen.
      document.documentElement.classList.toggle('link-fullscreen', on);
      fullscreenRef.current = on;
      setIsFullscreen(on);
    } catch {
      // Not available (the phone): nothing to change.
    }
  }, []);
  useEffect(() => () => {
    if (fullscreenRef.current) void setWindowFullscreen(false);
  }, [setWindowFullscreen]);
  // The app's desktop title bar (z-index 50000) sits above this viewer, so anything pinned to the
  // viewer's top edge (the session bubble, the video's top rows) would hide behind it. Start the
  // viewer below it, except in true fullscreen where the viewer covers the whole screen.
  const [titleBarInset, setTitleBarInset] = useState(0);
  useEffect(() => {
    const measure = () => {
      const bar = document.querySelector('.desktop-titlebar') as HTMLElement | null;
      setTitleBarInset(bar ? Math.round(bar.getBoundingClientRect().bottom) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const topInset = isFullscreen || forceLandscape ? 0 : titleBarInset;
  const toggleFullscreen = useCallback(() => {
    void setWindowFullscreen(!fullscreenRef.current);
  }, [setWindowFullscreen]);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);

  const containerW = forceLandscape ? viewportSize.h : viewportSize.w;
  const containerH = (forceLandscape ? viewportSize.w : viewportSize.h) - topInset;

  const currentBubbleX = bubblePos !== null ? Math.min(Math.max(12, bubblePos.x), containerW - 54) : containerW - 56;
  const currentBubbleY = bubblePos !== null ? Math.min(Math.max(12, bubblePos.y), containerH - 54) : 16;

  const handleBubblePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = false;
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startX: currentBubbleX,
      startY: currentBubbleY,
    };
  };

  const handleBubblePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    const rawDx = e.clientX - dragStartRef.current.clientX;
    const rawDy = e.clientY - dragStartRef.current.clientY;
    if (!isDraggingRef.current && (rawDx * rawDx + rawDy * rawDy > 36)) {
      isDraggingRef.current = true;
    }
    if (isDraggingRef.current) {
      const delta = forceLandscape ? transformDelta(rawDx, rawDy) : { dx: rawDx, dy: rawDy };
      const nextX = Math.min(Math.max(12, dragStartRef.current.startX + delta.dx), containerW - 54);
      const nextY = Math.min(Math.max(12, dragStartRef.current.startY + delta.dy), containerH - 54);
      setBubblePos({ x: nextX, y: nextY });
    }
  };

  const handleBubblePointerUp = (e: React.PointerEvent) => {
    if (dragStartRef.current) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Capture was already released.
      }
      if (!isDraggingRef.current) {
        setIsMenuOpen((prev) => !prev);
      }
      dragStartRef.current = null;
      isDraggingRef.current = false;
    }
  };

  const sendInput = useCallback((inputBody: any) => {
    if (linkApi?.sendRemoteControlInput) {
      linkApi.sendRemoteControlInput(deviceId, inputBody).catch(() => {});
    }
  }, [deviceId]);

  const sendSignal = useCallback((signalBody: any) => {
    // A second-screen viewer asks for the PC's extra monitor rather than its main screen.
    let body = secondScreen && signalBody?.type === 'request' ? { ...signalBody, display: 'extended' } : signalBody;
    // Tell the PC how many pixels this screen has, so it sends exactly that much detail: less looks
    // soft, more only costs time.
    if (body?.type === 'request') {
      const ratio = window.devicePixelRatio || 1;
      body = { ...body, viewport: { width: Math.round(window.screen.width * ratio), height: Math.round(window.screen.height * ratio) } };
    }
    if (linkApi?.sendRemoteControlSignal) {
      linkApi.sendRemoteControlSignal(deviceId, body).catch(() => {});
    }
  }, [deviceId, secondScreen]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // The host stopped sharing (or the stream froze): drop the dead connection and ask again,
  // instead of leaving the last frame on screen as if it were live.
  const restartStream = useCallback(() => {
    hasReceivedFrame.current = false;
    lastProgressRef.current = Date.now();
    retryAllowedRef.current = true;
    setErrorMessage(null);
    setConnectionState('reconnecting');
    setAttempt((n) => n + 1);
  }, []);

  // WebRTC receiver: the host sends an offer (over the control channel, or the guest socket for an
  // unpaired host; bridge.ts routes either way), this side answers, and the video arrives as a track.
  useEffect(() => {
    let pc: RTCPeerConnection | null = null;
    try {
      pc = new RTCPeerConnection({
        // Both ends are on the same network, so no STUN server, which would also leak session starts.
        iceServers: [],
      });
      pcRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: 'webrtc_candidate',
            candidate: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            },
          });
        }
      };

      pc.ontrack = (event) => {
        // A screen is only useful live: ask the browser to show frames the moment they arrive instead
        // of holding them in its playout buffer to smooth out jitter on a local network.
        try {
          const receiver = event.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
          if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
          if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
        } catch {
          // Not supported by this WebView: playback just keeps its default buffering.
        }
        if (event.streams && event.streams[0] && videoRef.current) {
          const video = videoRef.current;
          video.srcObject = event.streams[0];
          // The PC's sound arrives with the picture. The element starts muted so playback may begin on its
          // own; once there is sound to play, turn it on. A browser that still wants a tap first gets it
          // on the next touch.
          if (event.track.kind === 'audio') {
            video.muted = false;
            video.play().catch(() => {
              video.muted = true;
              void video.play().catch(() => {});
              const unmute = () => {
                video.muted = false;
                void video.play().catch(() => {});
              };
              window.addEventListener('pointerdown', unmute, { once: true });
            });
          }
          hasReceivedFrame.current = true;
          setConnectionState('connected');
        }
      };
    } catch (e) {
      console.warn('[RemoteControlViewer] WebRTC initialization failed:', e);
    }

    // Signaling from the host: offers, candidates and session state.
    const unsubscribeSignal = linkApi?.onRemoteControlSignal?.((srcId, signal) => {
      if (srcId !== deviceId || !signal) return;

      if (signal.type === 'stopped') {
        restartStream();
        return;
      }

      // The host removed this viewer on purpose: do not ask again.
      if (signal.type === 'ended') {
        retryAllowedRef.current = false;
        endSessionRef.current();
        return;
      }

      // Second screen asked for, but the PC has only one monitor.
      if (signal.type === 'no_second_screen') {
        retryAllowedRef.current = false;
        setConnectionState('disconnected');
        setErrorMessage('Could not extend onto this PC: no second screen is available. Reinstall Link on the PC to add the virtual display, or plug in a monitor, then try again.');
        return;
      }

      if (signal.type === 'denied') {
        retryAllowedRef.current = false;
        setConnectionState('disconnected');
        setErrorMessage('Screen capture permission was denied on the host.');
        return;
      }

      if (signal.type === 'stop' || signal.type === 'kicked') {
        setConnectionState('disconnected');
        setErrorMessage(signal.type === 'kicked' ? 'Removed by host' : 'Host ended the session.');
        if (onEndSession) {
          onEndSession();
        } else {
          onClose();
        }
        return;
      }

      if (signal.type === 'webrtc_offer' && pc) {
        pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }))
          .then(() => pc?.createAnswer())
          .then((answer) => {
            if (answer && pc) {
              return pc.setLocalDescription(answer).then(() => {
                sendSignal({ type: 'webrtc_answer', sdp: answer.sdp });
              });
            }
            return undefined;
          })
          .catch((err) => console.error('[RemoteControlViewer] SDP Offer handling error:', err));
      } else if (signal.type === 'webrtc_candidate' && pc && signal.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch((err) =>
          console.warn('[RemoteControlViewer] Add ICE Candidate error:', err)
        );
      }
    });

    return () => {
      unsubscribeSignal?.();
      if (pc) {
        pc.close();
        pcRef.current = null;
      }
    };
  }, [deviceId, sendSignal, attempt, restartStream]);

  // Asks the host to start sharing (which shows its capture consent prompt). The host can miss
  // the first request (app in the background, handler not ready), so it is repeated until the
  // stream arrives or the viewer gives up.
  useEffect(() => {
    sendSignal({ type: 'request' });
    const retry = setInterval(() => {
      if (retryAllowedRef.current && !hasReceivedFrame.current) sendSignal({ type: 'request' });
    }, 4000);
    const giveUp = setTimeout(() => {
      if (!hasReceivedFrame.current) {
        retryAllowedRef.current = false;
        setConnectionState('disconnected');
        setErrorMessage('The device did not respond. Open Link on it and try again.');
      }
    }, 45000);
    return () => {
      clearInterval(retry);
      clearTimeout(giveUp);
    };
  }, [deviceId, sendSignal, attempt]);

  // Detects a stream that stalls without a signal (sharing stopped from the phone's indicator, a
  // dropped link): video time not advancing for a few seconds restarts the stream.
  useEffect(() => {
    let lastVideoTime = -1;
    const watch = setInterval(() => {
      if (!hasReceivedFrame.current) return;
      const video = videoRef.current;
      if (video && video.srcObject && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        lastProgressRef.current = Date.now();
      }
      if (Date.now() - lastProgressRef.current > 6000) restartStream();
    }, 2000);
    return () => clearInterval(watch);
  }, [restartStream]);

  // Resumes when the host reconnects. Connection state comes from App.tsx, which already tracks
  // it for every peer.
  const wasHostConnected = useRef(hostConnected);
  useEffect(() => {
    if (hostConnected === false && wasHostConnected.current !== false) {
      setConnectionState('reconnecting');
      hasReceivedFrame.current = false;
    } else if (hostConnected === true && wasHostConnected.current === false) {
      setConnectionState('connecting');
      setErrorMessage(null);
      sendSignal({ type: 'request' });
    }
    wasHostConnected.current = hostConnected;
  }, [hostConnected, sendSignal]);

  const handleEndSession = () => {
    sendSignal({ type: 'stop' });
    if (onEndSession) {
      onEndSession();
    } else {
      onClose();
    }
  };

  // Maps a pointer position to a normalized (0..1) position within the rendered video frame.
  // 1. Rotation (forceLandscape): clientX/clientY are physical screen coordinates, unaffected by
  //    the CSS rotation, so they are converted into the box's local pre-transform coordinates
  //    using the same rotation as useLandscapeOrientation's transformDelta. The box is
  //    width:100vh/height:100vw, so boxW is the screen height and boxH the screen width.
  // 2. Letterboxing: the video keeps its aspect ratio inside the box (object-fit: contain), so
  //    the same fit math finds the frame's on-screen rect. Taps outside it return null rather
  //    than being clamped, which would misplace clicks.
  const mapToFrame = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const video = videoRef.current;
    if (!video) return null;
    const naturalW = video.videoWidth;
    const naturalH = video.videoHeight;
    if (!naturalW || !naturalH) return null;

    let localX: number;
    let localY: number;
    let boxW: number;
    let boxH: number;

    if (forceLandscape) {
      boxW = viewportSize.h;
      boxH = viewportSize.w;
      if (landscapeOrientation === 'landscape-secondary') {
        localX = boxW - clientY;
        localY = clientX;
      } else {
        localX = clientY;
        localY = boxH - clientX;
      }
    } else {
      const rect = video.getBoundingClientRect();
      localX = clientX - rect.left;
      localY = clientY - rect.top;
      boxW = rect.width;
      boxH = rect.height;
    }

    const imgAspect = naturalW / naturalH;
    const boxAspect = boxW / boxH;
    let renderW: number;
    let renderH: number;
    let offX: number;
    let offY: number;
    if (imgAspect > boxAspect) {
      renderW = boxW;
      renderH = boxW / imgAspect;
      offX = 0;
      offY = (boxH - renderH) / 2;
    } else {
      renderH = boxH;
      renderW = boxH * imgAspect;
      offY = 0;
      offX = (boxW - renderW) / 2;
    }

    const fx = (localX - offX) / renderW;
    const fy = (localY - offY) / renderH;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return { x: fx, y: fy };
  }, [forceLandscape, landscapeOrientation, viewportSize]);

  // A short movement is a tap; a longer one is sent as a swipe.
  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  // Viewing a PC, a drag scrolls while the finger moves, as on a touchscreen. A phone being viewed
  // gets one swipe gesture when the finger lifts, which is what its gesture injection expects.
  const liveScroll = !isHostMobileLike;
  // Where the last live-scroll step ended; null until the finger has moved far enough to be a scroll.
  const lastScrollRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (isMenuOpen) {
      setIsMenuOpen(false);
      return;
    }
    const point = mapToFrame(e.clientX, e.clientY);
    if (!point) return;
    pointerStartRef.current = { x: point.x, y: point.y, time: Date.now() };
    lastScrollRef.current = null;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current;
    if (!liveScroll || !start) return;
    const point = mapToFrame(e.clientX, e.clientY);
    if (!point) return;
    const last = lastScrollRef.current;
    if (!last) {
      // Still a tap until the finger has moved about 2% of the frame.
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      if (dx * dx + dy * dy < 0.0004) return;
    }
    const now = Date.now();
    // About 30 steps a second is smooth without flooding the connection.
    if (last && now - last.time < 33) return;
    const from = last ?? start;
    sendInput({ action: 'scroll', startX: from.x, startY: from.y, endX: point.x, endY: point.y, duration: Math.max(16, now - from.time) });
    lastScrollRef.current = { x: point.x, y: point.y, time: now };
  };

  const handlePointerCancel = () => {
    pointerStartRef.current = null;
    lastScrollRef.current = null;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!pointerStartRef.current) return;
    const point = mapToFrame(e.clientX, e.clientY);
    const startX = pointerStartRef.current.x;
    const startY = pointerStartRef.current.y;
    const duration = Math.max(50, Math.min(600, Date.now() - pointerStartRef.current.time));
    pointerStartRef.current = null;
    const last = lastScrollRef.current;
    lastScrollRef.current = null;
    // A live scroll already moved the page; send only what is left since its last step, and no tap.
    if (last) {
      if (point && point.y !== last.y) {
        sendInput({ action: 'scroll', startX: last.x, startY: last.y, endX: point.x, endY: point.y, duration: Math.max(16, Date.now() - last.time) });
      }
      return;
    }
    if (!point) return;
    const { x: endX, y: endY } = point;

    const dx = endX - startX;
    const dy = endY - startY;
    const distSq = dx * dx + dy * dy;

    // Under ~2% of the frame counts as a tap.
    if (distSq < 0.0004) {
      sendInput({ action: 'tap', x: endX, y: endY, button: e.button === 2 ? 'right' : 'left' });
    } else {
      sendInput({ action: 'scroll', startX, startY, endX, endY, duration });
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLElement>) => {
    const point = mapToFrame(e.clientX, e.clientY);
    if (!point) return;
    const { x, y } = point;

    const delta = e.deltaY;
    const startY = y;
    const endY = Math.max(0, Math.min(1, y - (delta > 0 ? 0.15 : -0.15)));

    sendInput({ action: 'scroll', startX: x, startY, endX: x, endY, duration: 100 });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      sendInput({ action: 'key', key: 'BACKSPACE' });
      e.preventDefault();
    } else if (e.key === 'Enter') {
      sendInput({ action: 'key', key: 'ENTER' });
      e.preventDefault();
    } else if (e.key === 'Escape') {
      sendInput({ action: 'key', key: 'BACK' });
      e.preventDefault();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      sendInput({ action: 'text', text: e.key });
    }
  };

  // A phone's on-screen keyboard only appears for a focused text input, so a hidden input is
  // focused by the keyboard button (as in RemoteInputOverlay). Hardware keys are handled by the
  // outer div's onKeyDown.
  const softKeyboardInputRef = useRef<HTMLInputElement | null>(null);
  const [isKeyboardActive, setIsKeyboardActive] = useState(false);

  const handleKeyboardToggle = () => {
    if (!softKeyboardInputRef.current) return;
    if (isKeyboardActive) {
      softKeyboardInputRef.current.blur();
    } else {
      softKeyboardInputRef.current.focus();
    }
  };

  const handleSoftKeyboardChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val) sendInput({ action: 'text', text: val });
    e.target.value = '';
  };

  const handleSoftKeyboardKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      sendInput({ action: 'key', key: 'BACKSPACE' });
      e.preventDefault();
    } else if (e.key === 'Enter') {
      sendInput({ action: 'key', key: 'ENTER' });
      e.preventDefault();
    }
  };

  const showFrame = connectionState === 'connected' || connectionState === 'reconnecting';

  return (
    <div
      ref={viewerRootRef}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'F11' && !isLocalMobile) {
          e.preventDefault();
          toggleFullscreen();
          return;
        }
        handleKeyDown(e);
      }}
      className={forceLandscape ? landscapeClassName : undefined}
      style={{
        ...(forceLandscape
          ? { width: `${viewportSize.h}px`, height: `${viewportSize.w}px` }
          : { position: 'fixed', inset: 0 }),
        position: 'fixed',
        inset: 0,
        top: topInset,
        padding: 0,
        zIndex: 9999,
        background: '#000',
        outline: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Hidden input that receives the phone's soft keyboard */}
      <input
        ref={softKeyboardInputRef}
        type="text"
        value=""
        onChange={handleSoftKeyboardChange}
        onKeyDown={handleSoftKeyboardKeyDown}
        onFocus={() => setIsKeyboardActive(true)}
        onBlur={() => setIsKeyboardActive(false)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: '1px', height: '1px' }}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      {exitHint && (
        <div
          style={{
            position: 'fixed',
            bottom: 'max(24px, env(safe-area-inset-bottom, 24px))',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '8px 16px',
            borderRadius: 999,
            background: 'rgba(0,0,0,0.75)',
            color: '#fff',
            fontSize: 13,
            pointerEvents: 'none',
            zIndex: 99999,
          }}
        >
          Swipe back again to end the session
        </div>
      )}

      {/* Edge-to-edge video. object-fit keeps the frame's aspect ratio, so letterbox bars fall
          inside this element; mapToFrame repeats the same fit for hit-testing. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onLoadedMetadata={() => {
          if (videoRef.current) {
            const w = videoRef.current.videoWidth;
            const h = videoRef.current.videoHeight;
            if (w && h) {
              const landscape = w >= h;
              setFrameIsLandscape((prev) => (prev === landscape ? prev : landscape));
            }
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          touchAction: 'none',
          objectFit: 'contain',
          background: '#000',
          cursor: 'crosshair',
          display: showFrame ? 'block' : 'none',
        }}
      />

      {!showFrame && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-color)' }}>
              {connectionState === 'connecting' ? 'Connecting Stream...' : 'Disconnected'}
            </div>
            <div style={{ fontSize: '12px' }}>
              {errorMessage || `Waiting for screen capture authorization on ${deviceName}`}
            </div>
          </div>
        </div>
      )}

      {/* Shown over the last frame while the host is disconnected; the viewer resumes when it
          reconnects. */}
      {connectionState === 'reconnecting' && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            padding: '12px 20px',
            borderRadius: '10px',
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            color: '#f59e0b',
            fontSize: '13px',
            fontWeight: 600,
            textAlign: 'center',
          }}
        >
          {deviceName} disconnected — waiting to reconnect...
        </div>
      )}

      {/* Clicking outside closes the menu */}
      {isMenuOpen && (
        <div
          onClick={() => setIsMenuOpen(false)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 9990,
          }}
        />
      )}

      {/* Draggable session bubble */}
      <div
        onPointerDown={handleBubblePointerDown}
        onPointerMove={handleBubblePointerMove}
        onPointerUp={handleBubblePointerUp}
        title={isMenuOpen ? "Close Menu" : "Session Controls"}
        aria-label="Session Controls"
        style={{
          position: 'absolute',
          left: `${currentBubbleX}px`,
          top: `${currentBubbleY}px`,
          width: '42px',
          height: '42px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isMenuOpen
            ? 'var(--accent-gradient, linear-gradient(135deg, #009bd5 0%, #3b82f6 100%))'
            : 'rgba(12, 12, 14, 0.85)',
          border: isMenuOpen ? '1px solid rgba(255, 255, 255, 0.4)' : '1px solid var(--border-color, rgba(255, 255, 255, 0.15))',
          boxShadow: isMenuOpen
            ? '0 6px 24px rgba(0, 155, 213, 0.45), 0 2px 10px rgba(0,0,0,0.5)'
            : '0 4px 18px rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          color: '#fff',
          cursor: isDraggingRef.current ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
          zIndex: 9995,
          transition: isDraggingRef.current ? 'none' : 'background 0.2s ease, transform 0.15s ease',
        }}
      >
        {isMenuOpen ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <div
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: connectionState === 'connected' ? '#10b981' : '#f59e0b',
                boxShadow: connectionState === 'connected' ? '0 0 6px #10b981' : 'none',
              }}
            />
          </div>
        )}
      </div>

      {/* Session menu */}
      {isMenuOpen && (
        <div
          style={{
            position: 'absolute',
            left: `${currentBubbleX > containerW - 250 ? Math.max(12, currentBubbleX - 200) : currentBubbleX}px`,
            top: `${currentBubbleY > containerH - 220 ? Math.max(12, currentBubbleY - 200) : currentBubbleY + 50}px`,
            width: '240px',
            borderRadius: '14px',
            background: 'var(--modal-bg, #0c0c0e)',
            border: '1px solid var(--border-color, rgba(255, 255, 255, 0.12))',
            boxShadow: 'var(--modal-shadow, 0 12px 36px rgba(0, 0, 0, 0.4)), 0 0 20px rgba(0, 155, 213, 0.08)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            padding: '12px',
            zIndex: 9996,
            color: 'var(--text-color, #fff)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '6px', borderBottom: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: connectionState === 'connected' ? 'var(--active-dot, #10b981)' : '#f59e0b',
                  boxShadow: connectionState === 'connected' ? '0 0 8px #10b981' : 'none',
                }}
              />
              <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-color, #f8fafc)' }}>
                {deviceName}
              </span>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted, rgba(255,255,255,0.45))' }}>
              {connectionState}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {isLocalMobile && (
              <button
                onClick={() => {
                  handleKeyboardToggle();
                  setIsMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: isKeyboardActive ? 'rgba(14, 165, 233, 0.18)' : 'var(--input-bg, rgba(255, 255, 255, 0.06))',
                  border: isKeyboardActive ? '1px solid var(--accent-color, #0EA5E9)' : '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
                  color: isKeyboardActive ? 'var(--accent-color, #0EA5E9)' : 'var(--text-color, #f1f5f9)',
                  fontSize: '12.5px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <KeyboardIcon />
                <span>{isKeyboardActive ? 'Hide Keyboard' : 'Show Keyboard'}</span>
              </button>
            )}

            {isHostMobileLike && (
              <div style={{ display: 'flex', gap: '6px', marginTop: '2px', marginBottom: '2px' }}>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'BACK' })}
                  title="Back"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M17.5 4.5a1 1 0 0 1 1.5.866v13.268a1 1 0 0 1-1.5.866L6.01 12.866a1 1 0 0 1 0-1.732L17.5 4.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'HOME' })}
                  title="Home"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'RECENTS' })}
                  title="Recents"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2.5" />
                  </svg>
                </button>
                <button
                  onClick={() => sendInput({ action: 'key', key: 'LOCK' })}
                  title="Lock"
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: '6px',
                    background: 'var(--input-bg, rgba(255,255,255,0.08))',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                    color: 'var(--text-color, #fff)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </button>
              </div>
            )}

            <button
              onClick={() => {
                setIsMenuOpen(false);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                background: 'var(--input-bg, rgba(255, 255, 255, 0.06))',
                border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
                color: 'var(--text-color, #e2e8f0)',
                fontSize: '12.5px',
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              <span>Minimize Viewer</span>
            </button>

            {isLocalMobile && !IS_TV && (
              <button
                onClick={() => {
                  setViewMode(forceLandscape ? 'portrait' : 'landscape');
                  setIsMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'var(--input-bg, rgba(255, 255, 255, 0.06))',
                  border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
                  color: 'var(--text-color, #f1f5f9)',
                  fontSize: '12.5px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {forceLandscape ? (
                    <rect x="7" y="3" width="10" height="18" rx="2" />
                  ) : (
                    <rect x="3" y="7" width="18" height="10" rx="2" />
                  )}
                </svg>
                <span>{forceLandscape ? 'Portrait View' : 'Landscape View'}</span>
              </button>
            )}

            {!isLocalMobile && (
              <button
                onClick={() => {
                  toggleFullscreen();
                  setIsMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: 'var(--input-bg, rgba(255, 255, 255, 0.06))',
                  border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
                  color: 'var(--text-color, #f1f5f9)',
                  fontSize: '12.5px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {isFullscreen ? (
                    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                  ) : (
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                  )}
                </svg>
                <span>{isFullscreen ? 'Exit Full Screen' : 'Full Screen'}</span>
              </button>
            )}

            <button
              onClick={() => {
                setIsMenuOpen(false);
                handleEndSession();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                color: '#ef4444',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span>{secondScreen ? 'End Extend Screen' : 'End Remote Session'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RemoteControlViewer;
