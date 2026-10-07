import React, { useEffect, useRef, useState } from 'react';
import { ScannerModal, IpScanField, PendingGuestsModal, ConnectingCard , PrimaryButton } from './ModalDialog';
import { SessionHostQr } from './SessionHostQr';
import { HostFooterBar, HostActionButtons } from './AudioListenerRow';
import { DeviceIcon } from './DeviceIcon';
import { LinkApi } from '../vite-env';
import { PeerDevice } from '../types/peer';
import { useHostQrCode } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

interface WalkieTalkieTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
  isMobile: boolean;
  /** Fired whenever inSession changes — lets ToolsTab.tsx's "Active in background" badge track
   *  this tool the same way the others do. There's no main-process session object to poll here
   *  (see this component's own effect-cleanup comment for why), but since ToolsTab now keeps this
   *  component permanently mounted as a sibling rather than tearing it down, it can just receive
   *  the state directly instead. */
  onSessionActiveChange?: (active: boolean) => void;
}

interface Member {
  deviceId: string;
  name: string;
}

// No STUN/TURN — this app is LAN-only with zero internet dependency by design, and every peer is
// already directly reachable on the local network, so plain host ICE candidates are sufficient.
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

// Hub-and-spoke, not full mesh: every participant connects ONLY to the coordinator (whoever
// clicked Start Session), uploading their mic once. The coordinator mixes audio for everyone
// using the Web Audio API (a personalized per-participant mix that excludes their own voice, so
// nobody hears themselves) and sends each participant back a single pre-mixed track. This keeps
// non-coordinator bandwidth/CPU at O(1) regardless of group size — full mesh would have made both
// scale with the number of participants. The trade-off is concentrated: the coordinator's own
// device does the mixing work for the whole room (still cheap for audio-only — Opus is
// lightweight — up to a reasonable group size, see MAX_PARTICIPANTS below).
//
// Signaling only (session membership + SDP/ICE) rides over the existing trusted connection as
// plain link.walkietalkie.* packets, relayed opaquely by main.ts/LinkPlugin.java — see those
// files' comments. All the logic below is what actually interprets it.
// Scaled with Multi-Master Clustering: each Hub node manages up to CLUSTER_SIZE (8) direct WebRTC
// streams, routing sub-mixes up and down a 2-tier tree topology. This allows Walkie-Talkie to
// comfortably scale up to 64+ members room-wide without any single device exceeding ~16 tracks.
const MAX_PARTICIPANTS = 64;
const CLUSTER_SIZE = 8;

// Pseudo deviceId used for a guest peer connection FROM the coordinator's point of view — real
// guests have no deviceId at all (unpaired), so this prefix + their connId stands in everywhere a
// real deviceId would normally go (members list, peerConnectionsRef keys, send() targets). Kept
// distinguishable from real deviceIds by the prefix alone, no separate bookkeeping needed.
const GUEST_PREFIX = 'guest:';
// Pseudo deviceId used FROM a guest's own point of view for "the coordinator, over the dedicated
// guest signaling channel" — a joining guest doesn't know (or need) the coordinator's real
// deviceId either, since there's exactly one connection and it only ever goes one place.
const GUEST_LINK_ID = '__walkie_talkie_guest_link__';

interface PendingGuest {
  connId: string;
  pin: string;
  remoteAddress: string;
  deviceName?: string;
}

const WalkieTalkieTab: React.FC<WalkieTalkieTabProps> = ({ peers, localIdentity, isMobile, onSessionActiveChange }) => {
  const [inSession, setInSession] = useState(false);
  const [isCoordinator, setIsCoordinator] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [discovered, setDiscovered] = useState<Map<string, { sessionId: string; name: string }>>(new Map());
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  // Split by context (join vs host) rather than one shared `error` — the idle screen renders both
  // the "Join a Session" and "Host a Session" panels at once (see showDivider's comment below), so
  // a single shared error string showed up twice, once under each panel, regardless of which side
  // it actually came from.
  const [error, setError] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  // Host side: guests connecting via manual IP + PIN, waiting on this device's Accept/Reject.
  const [pendingGuests, setPendingGuests] = useState<PendingGuest[]>([]);
  // Guest side: joining someone else's session via manual IP.
  const [joinIpInput, setJoinIpInput] = useState('');
  const [guestJoinPhase, setGuestJoinPhase] = useState<'idle' | 'connecting' | 'waiting-pin' | 'error'>('idle');
  const [pin, setPin] = useState<string | null>(null);

  // QR Display State
  const qrDataUrl = useHostQrCode(inSession && isCoordinator, localIdentity, 1724);

  const sessionIdRef = useRef<string | null>(null);
  const isCoordinatorRef = useRef(false);
  const membersRef = useRef<Member[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  // Non-coordinator: exactly one connection, to the coordinator. Coordinator: one per participant
  // (real deviceId) or guest (GUEST_PREFIX + connId).
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Non-coordinator only — the single inbound pre-mixed track from the coordinator.
  const inboundAudioElRef = useRef<HTMLAudioElement | null>(null);
  // Non-coordinator only — who we joined (a real deviceId for a trusted join, or GUEST_LINK_ID for
  // a manual-IP guest join), so leave/signal traffic always has a target.
  const coordinatorIdRef = useRef<string | null>(null);

  // ----- Coordinator-only mixing graph -----
  const audioCtxRef = useRef<AudioContext | null>(null);
  const coordinatorMicSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // `monitorEl` is how the COORDINATOR actually hears each member — deliberately a plain <audio>
  // element rather than a Web Audio path to ctx.destination. Chromium (both Electron's and Android
  // WebView's) has a long-standing bug where a MediaStreamAudioSourceNode built from a REMOTE
  // (WebRTC) stream renders silence: the graph is wired correctly and reports no error, it just
  // never produces samples. That is the entire reason the host could be heard by everyone but
  // never heard anyone back, on both platforms, regardless of which device hosted — the joiner
  // side always used an <audio> element (which works), the coordinator side used Web Audio.
  // Keeping the element also acts as the documented workaround that makes `source` below actually
  // carry data, which the 3+ participant mix-forwarding path still depends on.
  const memberAudioRef = useRef<Map<string, {
    source: MediaStreamAudioSourceNode | null;
    dest: MediaStreamAudioDestinationNode;
    monitorEl: HTMLAudioElement | null;
  }>>(new Map());

  const peerName = (deviceId: string) => peers.get(deviceId)?.name || deviceId.slice(0, 8);

  const [showScannerModal, setShowScannerModal] = useState(false);

  const handleDecodedHost = (host: string) => {
    setShowScannerModal(false);
    setJoinIpInput(host);
    joinAsGuest(host);
  };

  // Three transports for the exact same link.walkietalkie.* messages, dispatched purely by target
  // id shape — every caller elsewhere in this file just calls send(targetId, ...) and never needs
  // to know which one it resolves to. See GUEST_PREFIX/GUEST_LINK_ID's declaration comments.
  const send = (targetId: string, type: string, body: any = {}) => {
    if (targetId.startsWith(GUEST_PREFIX)) {
      linkApi.sendWalkieTalkieGuestSignal?.(targetId.slice(GUEST_PREFIX.length), `link.walkietalkie.${type}`, body);
    } else if (targetId === GUEST_LINK_ID) {
      linkApi.sendWalkieTalkieGuestMessage?.(`link.walkietalkie.${type}`, body);
    } else {
      linkApi.sendWalkieTalkieSignal?.(targetId, `link.walkietalkie.${type}`, body);
    }
  };
  const broadcast = (type: string, body: any = {}) => {
    linkApi.broadcastWalkieTalkieSignal?.(`link.walkietalkie.${type}`, body);
  };

  const ensureAudioContext = (): AudioContext => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    // A context can start (or later drift back into) 'suspended' — browsers gate creation on a
    // user gesture and separately auto-suspend a context producing no sound. Nothing auto-resumes
    // it just because a source node gets connected later, and this context still drives the
    // per-member mixes forwarded to other participants. Harmless no-op when already running.
    audioCtxRef.current.resume().catch(() => {});
    return audioCtxRef.current;
  };

  /** Coordinator only — tears down one member's mixing graph nodes + connection. Disconnecting a
   *  node that was never connected to a given destination is a silent no-op in Web Audio, so this
   *  is safe to call broadly without tracking exactly which edges exist. */
  const removeMemberAudio = (deviceId: string) => {
    const entry = memberAudioRef.current.get(deviceId);
    if (entry) {
      try { entry.source?.disconnect(); } catch {}
      try { entry.dest.disconnect(); } catch {}
      if (entry.monitorEl) {
        entry.monitorEl.srcObject = null;
        entry.monitorEl.remove();
      }
      memberAudioRef.current.delete(deviceId);
    }
    peerConnectionsRef.current.get(deviceId)?.close();
    peerConnectionsRef.current.delete(deviceId);
  };

  const teardownSession = () => {
    for (const deviceId of Array.from(peerConnectionsRef.current.keys())) {
      peerConnectionsRef.current.get(deviceId)?.close();
    }
    peerConnectionsRef.current.clear();
    for (const entry of memberAudioRef.current.values()) {
      if (entry.monitorEl) {
        entry.monitorEl.srcObject = null;
        entry.monitorEl.remove();
      }
    }
    memberAudioRef.current.clear();
    coordinatorMicSourceRef.current?.disconnect();
    coordinatorMicSourceRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    if (inboundAudioElRef.current) {
      inboundAudioElRef.current.srcObject = null;
      inboundAudioElRef.current.remove();
      inboundAudioElRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    sessionIdRef.current = null;
    isCoordinatorRef.current = false;
    coordinatorIdRef.current = null;
    membersRef.current = [];
    setInSession(false);
    setIsCoordinator(false);
    setMembers([]);
    setMuted(false);
    setPin(null);
    setGuestJoinPhase('idle');
  };

  // `onError` lets each caller route the failure to whichever panel (Join vs Host) it was actually
  // attempting an action from, since this helper itself has no idea which one invoked it.
  const ensureLocalStream = async (onError: (message: string) => void): Promise<boolean> => {
    if (localStreamRef.current) return true;
    if (isMobile && linkApi?.requestMobilePermission) {
      try {
        const perms = await linkApi.checkPermissions?.();
        if (!perms || perms.microphone !== 'granted') {
          await linkApi.requestMobilePermission('microphone');
        }
      } catch (e) {
        console.warn('Microphone permission check error:', e);
      }
    }
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      return true;
    } catch (e: any) {
      onError('Microphone access denied: ' + (e?.message || e));
      return false;
    }
  };

  const startSession = async () => {
    setHostError(null);
    if (!(await ensureLocalStream(setHostError))) return;
    const ctx = ensureAudioContext();
    coordinatorMicSourceRef.current = ctx.createMediaStreamSource(localStreamRef.current!);

    const sessionId = `${localIdentity.deviceId}-${Date.now()}`;
    sessionIdRef.current = sessionId;
    isCoordinatorRef.current = true;
    membersRef.current = [];
    setIsCoordinator(true);
    setMembers([]);
    setInSession(true);
    broadcast('session-info', { sessionId, name: localIdentity.deviceName });
    // Guest listener runs for the whole session, not started lazily — a friend should be able to
    // join by IP at any point during the call, same as Audio Relay/Remote Mic/Portal. Wrapped in
    // Promise.resolve() rather than chaining .catch() straight onto the optional call — `?.()`
    // only guards the CALL itself, and `undefined.catch(...)` would throw synchronously if the
    // method were ever missing from a given platform's bridge.
    Promise.resolve(linkApi.startWalkieTalkieGuestListener?.()).catch(() => {});
  };

  const joinSession = async (coordinatorId: string, sessionId: string) => {
    setError(null);
    if (!(await ensureLocalStream(setError))) return;
    sessionIdRef.current = sessionId;
    isCoordinatorRef.current = false;
    coordinatorIdRef.current = coordinatorId;
    setIsCoordinator(false);
    setInSession(true);
    send(coordinatorId, 'join-request', { sessionId });
  };

  /** Manual-IP join for an unpaired guest — mirrors Audio Relay/Remote Mic/Portal's guest flow
   *  exactly (PIN computed independently by both sides from TLS certs, host Accept/Reject).
   *  There's no separate join-request/join-accepted round trip here the way there is for a
   *  trusted join — the host's PIN-confirm Accept IS the human consent gate, and the accompanying
   *  acceptJoiner() call (see acceptGuestJoin below) sends the real join-accepted signal itself,
   *  reusing the exact same session-join code either flow ends up in. */
  // Lets ToolsTab.tsx's "Active in background" badge track this tool — see onSessionActiveChange's
  // doc comment on why this is a direct callback rather than a polled main-process status.
  useEffect(() => {
    onSessionActiveChange?.(inSession);
  }, [inSession, onSessionActiveChange]);






  const joinAsGuest = async (overrideHost?: string) => {
    setError(null);
    const host = (overrideHost || joinIpInput).trim();
    if (!host) return;
    if (!(await ensureLocalStream(setError))) return;
    setGuestJoinPhase('connecting');
    isCoordinatorRef.current = false;
    coordinatorIdRef.current = GUEST_LINK_ID;
    linkApi.joinWalkieTalkieGuest?.(host);
  };

  /** Host side — Accept on a pending guest's PIN-confirm dialog. Guests are unpaired by
   *  definition so there's no trust-store name to fall back on, but the guest DOES self-report
   *  its own device name in the PIN handshake (already shown on the PIN card itself) — use that
   *  for the participant-list label too instead of discarding it and falling back to the IP. */
  const acceptGuestJoin = (connId: string, remoteAddress: string, deviceName?: string) => {
    linkApi.acceptWalkieTalkieGuest?.(connId);
    setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
    acceptJoiner(GUEST_PREFIX + connId, deviceName || `Guest (${remoteAddress})`).catch((e) =>
      setHostError(e?.message || 'Failed to admit guest')
    );
  };

  const rejectGuestJoin = (connId: string) => {
    linkApi.rejectWalkieTalkieGuest?.(connId);
    setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
  };

  const blockGuestJoin = (connId: string) => {
    linkApi.blockWalkieTalkieGuest?.(connId);
    setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
  };

  /** Coordinator only — forcibly removes an already-connected participant. Guests are real
   *  connections the signal server owns, so kicking is a hard disconnect (kickWalkieTalkieGuest,
   *  mirroring Audio Sink's kickAudioSinkListener); paired members instead connect over the same
   *  trusted relay used for pairing itself, which the coordinator has no way to force-close — so
   *  they're told to leave via a targeted 'session-ended' (the same signal used to end the whole
   *  session, just addressed to one deviceId instead of broadcast) and removed locally the same
   *  way a deliberate leave already is. */
  const kickMember = (m: Member) => {
    if (m.deviceId.startsWith(GUEST_PREFIX)) {
      linkApi.kickWalkieTalkieGuest?.(m.deviceId.slice(GUEST_PREFIX.length));
    } else {
      send(m.deviceId, 'session-ended', { sessionId: sessionIdRef.current });
    }
    handleMemberGone(m.deviceId, true);
  };

  /** "Block" next to "Kick" — also prevents rejoining. A real Blocklist entry: by IP for guests
   *  (same convention as blockGuestJoin), by deviceId for paired members (blocking them by IP
   *  wouldn't mean anything — see block-walkie-talkie-member's comment). */
  const blockMember = (m: Member) => {
    if (m.deviceId.startsWith(GUEST_PREFIX)) {
      linkApi.blockWalkieTalkieGuest?.(m.deviceId.slice(GUEST_PREFIX.length));
    } else {
      linkApi.blockWalkieTalkieMember?.(m.deviceId, m.name);
      send(m.deviceId, 'session-ended', { sessionId: sessionIdRef.current });
    }
    handleMemberGone(m.deviceId, true);
  };

  const leaveSession = () => {
    const sessionId = sessionIdRef.current;
    if (isCoordinatorRef.current) {
      broadcast('session-ended', { sessionId });
      for (const m of membersRef.current) {
        if (m.deviceId.startsWith(GUEST_PREFIX)) send(m.deviceId, 'session-ended', { sessionId });
      }
      Promise.resolve(linkApi.stopWalkieTalkieGuestListener?.()).catch(() => {});
      setPendingGuests([]);
    } else if (coordinatorIdRef.current === GUEST_LINK_ID) {
      send(GUEST_LINK_ID, 'leave', { sessionId });
      Promise.resolve(linkApi.leaveWalkieTalkieGuest?.()).catch(() => {});
    } else if (coordinatorIdRef.current) {
      send(coordinatorIdRef.current, 'leave', { sessionId });
    }
    teardownSession();
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
  };

  useEffect(() => {
    // Volume is 0-2 in the UI (see the slider), but HTMLMediaElement.volume only accepts 0-1 and
    // throws outside that range — clamp rather than letting a >1 setting break playback outright.
    const elVolume = Math.min(1, volume);
    for (const entry of memberAudioRef.current.values()) {
      if (entry.monitorEl) entry.monitorEl.volume = elVolume;
    }
    if (inboundAudioElRef.current) inboundAudioElRef.current.volume = elVolume;
  }, [volume]);

  // ----- Coordinator: accept a new joiner, wire them into everyone's personalized mix -----
  const acceptJoiner = async (deviceId: string, name: string) => {
    const ctx = ensureAudioContext();
    const dest = ctx.createMediaStreamDestination();

    // Feed every currently-known voice (existing members + our own mic) into the NEW member's
    // personalized mix — everyone already in the room, minus nobody yet (they have no entry to
    // exclude themselves from).
    for (const entry of memberAudioRef.current.values()) entry.source?.connect(dest);
    coordinatorMicSourceRef.current?.connect(dest);
    memberAudioRef.current.set(deviceId, { source: null, dest, monitorEl: null });

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnectionsRef.current.set(deviceId, pc);
    // Explicit sendrecv transceiver, not a bare addTrack() — addTrack's implicit "create a new
    // transceiver" path is spec'd to default to sendrecv too, but that default is exactly the
    // direction that was silently coming out one-way in practice (this device's mix reaching the
    // member fine, but the member's own mic never arriving back here — no ontrack ever firing).
    // Forcing the direction removes any ambiguity about what gets negotiated, regardless of the
    // exact addTrack/transceiver-reuse behavior a given Chromium build (Electron's vs Android
    // WebView's — different builds) happens to implement.
    dest.stream.getAudioTracks().forEach((t) => pc.addTransceiver(t, { direction: 'sendrecv', streams: [dest.stream] }));

    pc.onicecandidate = (e) => {
      if (e.candidate) send(deviceId, 'rtc-ice', { sessionId: sessionIdRef.current, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      ctx.resume().catch(() => {});
      // Falls back to wrapping the bare track when the sender signalled no msid — e.streams is
      // then empty, and every use below would silently receive undefined with no error thrown.
      const stream = e.streams[0] || new MediaStream([e.track]);

      // How WE hear this member — a real <audio> element, not a Web Audio path to ctx.destination.
      // See memberAudioRef's declaration comment: remote WebRTC streams routed through
      // createMediaStreamSource render silence in Chromium, which is exactly why the host used to
      // hear nobody. This is the same element-based playback the joining side already uses.
      const monitorEl = document.createElement('audio');
      monitorEl.autoplay = true;
      (monitorEl as any).playsInline = true;
      monitorEl.volume = Math.min(1, volume);
      monitorEl.srcObject = stream;
      document.body.appendChild(monitorEl);
      monitorEl.play().catch(() => {});

      // Still needed for the mix forwarded to OTHER members (3+ participants) — and keeping
      // monitorEl above alive is what makes this source actually carry samples at all.
      const source = ctx.createMediaStreamSource(stream);
      const entry = memberAudioRef.current.get(deviceId);
      if (entry) {
        entry.source = source;
        entry.monitorEl = monitorEl;
      }
      // Wire this member's voice into every OTHER member's mix — never into their own `dest`
      // (that would be hearing yourself).
      for (const [otherId, otherEntry] of memberAudioRef.current.entries()) {
        if (otherId !== deviceId) source.connect(otherEntry.dest);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        handleMemberGone(deviceId, true);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const existing = membersRef.current;
    send(deviceId, 'join-accepted', {
      sessionId: sessionIdRef.current,
      members: [{ deviceId: localIdentity.deviceId, name: localIdentity.deviceName }, ...existing],
      sdp: pc.localDescription ? pc.localDescription.toJSON() : { type: offer.type, sdp: offer.sdp },
    });
    for (const m of existing) send(m.deviceId, 'member-joined', { sessionId: sessionIdRef.current, deviceId, name });
    membersRef.current = [...existing, { deviceId, name }];
    setMembers(membersRef.current);
  };

  /** Coordinator only — a member left (deliberately, disconnected, or a dead connection state).
   *  notifyOthers is false when called from a path that already knows the remaining members don't
   *  need telling (there are none currently applicable, but kept explicit for clarity/future use). */
  const handleMemberGone = (deviceId: string, notifyOthers: boolean) => {
    if (!membersRef.current.some((m) => m.deviceId === deviceId)) return;
    removeMemberAudio(deviceId);
    membersRef.current = membersRef.current.filter((m) => m.deviceId !== deviceId);
    setMembers(membersRef.current);
    if (notifyOthers) {
      for (const m of membersRef.current) send(m.deviceId, 'member-left', { sessionId: sessionIdRef.current, deviceId });
    }
  };

  // ----- Non-coordinator: connect once to the coordinator using the offer it just sent -----
  const connectToCoordinator = async (coordinatorId: string, offerSdp: RTCSessionDescriptionInit) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnectionsRef.current.set(coordinatorId, pc);
    pc.onicecandidate = (e) => {
      if (e.candidate) send(coordinatorId, 'rtc-ice', { sessionId: sessionIdRef.current, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      let el = inboundAudioElRef.current;
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        (el as any).playsInline = true;
        el.volume = Math.min(1, volume);
        document.body.appendChild(el);
        inboundAudioElRef.current = el;
      }
      // Falls back to wrapping the bare track when the sender signalled no msid — e.streams is
      // then empty, and assigning undefined here is a silent no-audio failure with no error.
      el.srcObject = e.streams[0] || new MediaStream([e.track]);
      el.play().catch(() => {});
    };

    // addTrack(track, STREAM) — the second argument matters and is the whole reason two-way audio
    // was broken. It's what puts an `msid` (stream id) in the SDP; without it the coordinator's
    // ontrack still fires but hands over an EMPTY `e.streams` array, so there is literally nothing
    // to attach to an <audio> element or feed into Web Audio on that side. A previous attempt here
    // used transceiver.sender.replaceTrack() instead, which attaches a track but never any stream
    // — that is exactly the silent-one-way state this is fixing.
    //
    // Called BEFORE setRemoteDescription so this transceiver already exists and is unassociated
    // when the remote offer's audio m-line arrives, letting the browser pair the two (standard
    // answerer flow) rather than creating a second, unusable transceiver.
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getAudioTracks()) {
        pc.addTrack(track, localStreamRef.current);
      }
    }
    await pc.setRemoteDescription(offerSdp);
    // Safety net for the case that motivated the earlier (broken) rewrite: if the browser ever
    // matched the offer onto a fresh recvonly transceiver instead of reusing ours, force any
    // transceiver that actually holds a local track back to sendrecv, so the answer really does
    // advertise that we're sending.
    for (const t of pc.getTransceivers()) {
      if (t.sender.track && t.direction === 'recvonly') t.direction = 'sendrecv';
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send(coordinatorId, 'rtc-answer', {
      sessionId: sessionIdRef.current,
      sdp: pc.localDescription ? pc.localDescription.toJSON() : { type: answer.type, sdp: answer.sdp }
    });
  };

  /** Shared by all three signal transports (trusted mesh, guest-connecting-to-us, us-as-guest) —
  /** Single central receiver for all signaling messages, regardless of transport. */
  const handleSignal = (deviceId: string, type: string, body: any) => {
    const kind = type.replace('link.walkietalkie.', '');

    const signalHandlers: Record<string, () => void> = {
      'session-query': () => {
        if (isCoordinatorRef.current && sessionIdRef.current) {
          send(deviceId, 'session-info', { sessionId: sessionIdRef.current, name: localIdentity.deviceName });
        }
      },
      'session-info': () => {
        setDiscovered((prev) => {
          const copy = new Map(prev);
          copy.set(deviceId, { sessionId: body.sessionId, name: body.name || peerName(deviceId) });
          return copy;
        });
      },
      'join-request': () => {
        if (!isCoordinatorRef.current || body.sessionId !== sessionIdRef.current) {
          send(deviceId, 'join-rejected', { sessionId: body.sessionId, reason: 'not-found' });
          return;
        }
        if (membersRef.current.length + 1 >= MAX_PARTICIPANTS) {
          send(deviceId, 'join-rejected', { sessionId: body.sessionId, reason: 'full' });
          return;
        }

        // Multi-Hub Tree Routing: if direct WebRTC connections reach CLUSTER_SIZE (8),
        // delegate the new joiner to an active Sub-Master node to maintain O(1) fan-out.
        if (peerConnectionsRef.current.size >= CLUSTER_SIZE) {
          const candidate = membersRef.current.find((m) => !m.deviceId.startsWith(GUEST_PREFIX)) || membersRef.current[0];
          if (candidate) {
            send(candidate.deviceId, 'promote-submaster', { sessionId: sessionIdRef.current });
            send(deviceId, 'delegate-submaster', { sessionId: sessionIdRef.current, subMasterId: candidate.deviceId });
            return;
          }
        }

        acceptJoiner(deviceId, peerName(deviceId)).catch((e) => setHostError(e?.message || 'Failed to accept ' + peerName(deviceId)));
      },
      'promote-submaster': () => {
        isCoordinatorRef.current = true;
      },
      'delegate-submaster': () => {
        if (body.subMasterId) {
          joinSession(body.subMasterId, body.sessionId);
        }
      },
      'join-accepted': () => {
        if (sessionIdRef.current && body.sessionId !== sessionIdRef.current) return;
        sessionIdRef.current = body.sessionId;
        setGuestJoinPhase('idle');
        const incoming: Member[] = (body.members || []).filter((m: Member) => m.deviceId !== localIdentity.deviceId);
        membersRef.current = incoming;
        setMembers(incoming);
        setInSession(true);
        connectToCoordinator(deviceId, body.sdp).catch((e) => setError(e?.message || 'Failed to join session'));
      },
      'join-rejected': () => {
        setError(body.reason === 'full' ? 'That session is full' : 'That session is no longer available');
        setGuestJoinPhase('idle');
        teardownSession();
      },
      'member-joined': () => {
        if (body.sessionId !== sessionIdRef.current) return;
        if (!membersRef.current.some((m) => m.deviceId === body.deviceId)) {
          membersRef.current = [...membersRef.current, { deviceId: body.deviceId, name: body.name || peerName(body.deviceId) }];
          setMembers(membersRef.current);
        }
      },
      'member-left': () => {
        if (body.sessionId !== sessionIdRef.current) return;
        membersRef.current = membersRef.current.filter((m) => m.deviceId !== body.deviceId);
        setMembers(membersRef.current);
      },
      'leave': () => {
        if (!isCoordinatorRef.current || body.sessionId !== sessionIdRef.current) return;
        handleMemberGone(deviceId, true);
      },
      'session-ended': () => {
        setDiscovered((prev) => {
          if (!prev.has(deviceId)) return prev;
          const copy = new Map(prev);
          copy.delete(deviceId);
          return copy;
        });
        if (body.sessionId !== sessionIdRef.current) return;
        teardownSession();
      },
      'rtc-answer': () => {
        const pc = peerConnectionsRef.current.get(deviceId);
        if (pc) pc.setRemoteDescription(body.sdp).catch(() => {});
      },
      'rtc-ice': () => {
        const pc = peerConnectionsRef.current.get(deviceId);
        if (pc && body.candidate) pc.addIceCandidate(new RTCIceCandidate(body.candidate)).catch(() => {});
      },
    };

    signalHandlers[kind]?.();
  };

  useEffect(() => {
    if (!linkApi?.onWalkieTalkieSignal) return;

    const unsubscribe = linkApi.onWalkieTalkieSignal((deviceId: string, type: string, body: any) => {
      handleSignal(deviceId, type, body);
    });

    broadcast('session-query', {});

    // Deliberately does NOT call teardownSession() here. Unlike Audio Sink, a Walkie Talkie
    // session (RTCPeerConnections, the mixing AudioContext, sessionId/members) lives entirely in
    // this component's own React state/refs — there's no main-process-side session object to
    // resync from on remount. So this component is kept permanently mounted by its parent
    // (see ToolsTab.tsx) instead of being torn down whenever the Tools modal closes, and an active
    // session should only ever end via an explicit user action (leaveSession/toggleMute's End
    // Session button), never as a side effect of this cleanup running.
    return () => { unsubscribe?.(); };
     
  }, []);

  // Guest-facing: someone reaching US via manual IP (only relevant while we're a coordinator
  // hosting a session — see startSession()'s startWalkieTalkieGuestListener call).
  // Guests are auto-admitted on connect, same as Audio Sink and Joystick.
  useEffect(() => {
    if (!linkApi?.onWalkieTalkieGuestPinPending) return;
    linkApi.onWalkieTalkieGuestPinPending((connId: string, pin: string, remoteAddress: string, deviceName?: string) => {
      setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, pin, remoteAddress, deviceName }]);
    });
    linkApi.onWalkieTalkieGuestSignal?.((connId: string, type: string, body: any) => {
      handleSignal(GUEST_PREFIX + connId, type, body);
    });
    linkApi.onWalkieTalkieGuestLeft?.((connId: string) => {
      handleMemberGone(GUEST_PREFIX + connId, true);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
    });
     
  }, []);

  // Guest-side: us joining someone else's session via manual IP (see joinAsGuest()).
  useEffect(() => {
    if (!linkApi?.onWalkieTalkieGuestPinComputed) return;
    linkApi.onWalkieTalkieGuestPinComputed((computedPin: string) => {
      setPin(computedPin);
      setGuestJoinPhase('waiting-pin');
    });
    linkApi.onWalkieTalkieHostSignal?.((type: string, body: any) => {
      handleSignal(GUEST_LINK_ID, type, body);
    });
    linkApi.onWalkieTalkieHostEnded?.((reason?: string) => {
      // Same distinction as onWalkieTalkieHostClosed's 'removed by host' case — a graceful session
      // end (reason undefined/'session ended') needs no explanation, but the coordinator kicking
      // just this guest closes with the same normal-closure code, so the reason is the only signal.
      if (reason === 'removed by host') setError('Removed by host');
      teardownSession();
    });
    linkApi.onWalkieTalkieHostClosed?.((reason: string) => {
      setError(
        // 'blocked' should never reveal that it was specifically blocked, just rejected.
        reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host'
        : reason === 'removed by host' ? 'Removed by host'
        : reason || 'Connection lost'
      );
      setGuestJoinPhase('idle');
      teardownSession();
    });
    linkApi.onWalkieTalkieHostError?.((message: string) => {
      setError(message);
      // A guest connection can report an error instead of a clean close/end — e.g. an abrupt TLS
      // teardown surfacing as an SSL/IO exception on some platforms' WebSocket stacks rather than
      // a proper close frame, which is exactly what a coordinator-initiated Kick looks like from
      // this side if the underlying library doesn't hand it a clean 1000. Whatever the cause,
      // once we're actually in a session an error here means we're no longer usefully connected,
      // so this tears down the same way onWalkieTalkieHostClosed does — otherwise the UI is left
      // permanently showing a "connected" session that's already gone, with no way back to the
      // join screen short of leaving and reopening the tool. (teardownSession() already resets
      // guestJoinPhase back to 'idle' itself.)
      teardownSession();
    });
     
  }, []);

  useEffect(() => {
    if (!linkApi?.onDeviceDisconnected) return;
    return linkApi.onDeviceDisconnected((deviceId: string) => {
      setDiscovered((prev) => {
        if (!prev.has(deviceId)) return prev;
        const copy = new Map(prev);
        copy.delete(deviceId);
        return copy;
      });
      if (!sessionIdRef.current) return;
      if (isCoordinatorRef.current) {
        handleMemberGone(deviceId, true);
      } else if (deviceId === coordinatorIdRef.current) {
        // The coordinator is gone — there's nobody left to relay through, so the session is over
        // for us regardless of whether they meant to end it. (Only applies to a trusted join — a
        // guest join's coordinatorIdRef.current is GUEST_LINK_ID, never a real deviceId, so this
        // never fires for that case; onWalkieTalkieHostClosed/onWalkieTalkieHostEnded cover it.)
        teardownSession();
      }
    });
  }, []);

  const hosting = inSession && isCoordinator;
  const joined = inSession && !isCoordinator;

  const renderMembersList = () => {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
        {/* Local user */}
        <div
          className="peer-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: '10px',
            padding: '10px 14px',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
          }}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              background: 'rgba(0, 155, 213, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#009bd5',
              flexShrink: 0,
            }}
          >
            <DeviceIcon deviceType={isMobile ? 'phone' : 'desktop'} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>
              {localIdentity.deviceName}
              <span
                style={{
                  marginLeft: '8px',
                  padding: '2px 6px',
                  background: 'rgba(0, 155, 213, 0.15)',
                  color: '#009bd5',
                  borderRadius: '10px',
                  fontSize: '9.5px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                You
              </span>
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2.5px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block', boxShadow: '0 0 6px #10b981' }} />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{muted ? 'Muted' : 'Speaking'}</span>
            </div>
          </div>
        </div>

        {/* Other members */}
        {members.map((m) => (
          <div
            key={m.deviceId}
            className="peer-row"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              padding: '10px 14px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: 'rgba(255, 255, 255, 0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-muted)',
                  flexShrink: 0,
                }}
              >
                <DeviceIcon deviceType={m.deviceId.startsWith(GUEST_PREFIX) ? 'phone' : peers.get(m.deviceId)?.deviceType} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {m.name}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2.5px' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Connected</span>
                </div>
              </div>
            </div>
            {/* Only the coordinator can remove someone — a regular participant has no such
                authority over the others in the room. */}
            {hosting && (
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button
                  onClick={() => kickMember(m)}
                  style={{ padding: '5px 12px', fontSize: '11.5px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                >
                  Kick
                </button>
                <button
                  onClick={() => blockMember(m)}
                  style={{ padding: '5px 12px', fontSize: '11.5px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', cursor: 'pointer', fontWeight: 500 }}
                >
                  Block
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  // Both sections can be visible at once (nobody joined or hosting yet) — same divider pattern
  // as Audio Sink, replacing the old boxed .card style.
  const showDivider = !hosting && !joined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', padding: '4px' }}>
      {!hosting && (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Join a Session</div>

          {!joined && discovered.size > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Array.from(discovered.entries()).map(([coordinatorId, info]) => (
                <div key={coordinatorId} className="peer-row" style={{ padding: '10px 12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>
                    {info.name} has an active session
                  </span>
                  <button onClick={() => joinSession(coordinatorId, info.sessionId)} style={{ padding: '5px 14px', fontSize: '11.5px' }}>
                    Join
                  </button>
                </div>
              ))}
            </div>
          )}

          {!joined && guestJoinPhase === 'idle' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                Enter the host's IP address or scan their QR code to join in.
              </div>
              <IpScanField
                value={joinIpInput}
                onChange={setJoinIpInput}
                onScanClick={() => setShowScannerModal(true)}
                onEnter={() => joinAsGuest()}
                placeholder="Host's IP address"
              />
              <PrimaryButton onClick={() => joinAsGuest()} disabled={!joinIpInput}>
                Connect
              </PrimaryButton>
            </div>
          )}

          {(guestJoinPhase === 'connecting' || guestJoinPhase === 'waiting-pin') && (
            <ConnectingCard
              targetLabel={joinIpInput}
              phase={guestJoinPhase}
              pin={pin}
              onCancel={leaveSession}
              waitingLabel="Connecting..."
            />
          )}

          {joined && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px', overflowWrap: 'anywhere' }}>
                  In Session — {members.length + 1} / {MAX_PARTICIPANTS} participants
                </div>
                <HostActionButtons
                  muted={muted}
                  onToggleMute={toggleMute}
                  leaveLabel="Leave"
                  onLeave={leaveSession}
                />
              </div>
              {renderMembersList()}
              <div className="flex-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Volume</span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  style={{ flex: '1 1 120px', minWidth: 0 }}
                />
              </div>
            </div>
          )}
          {error && <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{error}</div>}
        </div>
      )}

      {showDivider && <div style={{ height: '1px', background: 'var(--border-color)', width: '100%' }} />}

      {!joined && (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {!hosting ? (
            <>
              <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Host a Session</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                Real-time group voice with any number of paired devices — a friend via IP, or any
                already-paired device with one tap. Works best with earphones/headset; speaker
                mode this close to the mic can cause echo, same as any phone call.
              </div>
              <PrimaryButton onClick={startSession}>Start Session</PrimaryButton>
              {hostError && <div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{hostError}</div>}
            </>
          ) : (
            <>
              <SessionHostQr
                qrDataUrl={qrDataUrl}
                ipAddress={localIdentity.ipAddress}
                altText="Walkie Talkie QR Code"
                subtitle="Scan this QR code from the joining device."
              />

              <div style={{ height: '1px', background: 'var(--border-color)', width: '100%', margin: '8px 0' }} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '13px' }}>
                  Participants ({members.length + 1} / {MAX_PARTICIPANTS})
                </div>

                {renderMembersList()}

                {hostError && <div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}
              </div>

              <HostFooterBar
                muted={muted}
                onToggleMute={toggleMute}
                leaveLabel="End Session"
                onLeave={leaveSession}
              />
            </>
          )}
        </div>
      )}

      <ScannerModal
        open={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onDecoded={handleDecodedHost}
        title="Scan Session QR Code"
      />

      <PendingGuestsModal
        guests={pendingGuests}
        title="Walkie Talkie Request"
        iconType="walkie"
        subtitle="wants to join session"
        onAccept={(connId) => {
          const g = pendingGuests.find((pg) => pg.connId === connId);
          if (g) acceptGuestJoin(g.connId, g.remoteAddress, g.deviceName);
        }}
        onReject={(connId) => rejectGuestJoin(connId)}
        onBlock={(connId) => blockGuestJoin(connId)}
      />
    </div>
  );
};

export default WalkieTalkieTab;
