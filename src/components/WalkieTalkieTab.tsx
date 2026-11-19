import React, { useEffect, useRef, useState } from 'react';
import { ScannerModal, IpScanField, PendingGuestsModal, ConnectingCard , PrimaryButton } from './ModalDialog';
import { DialogCard } from './DialogCard';
import { SessionHostQr } from './SessionHostQr';
import { HostFooterBar, HostActionButtons } from './AudioListenerRow';
import { DeviceIcon } from './DeviceIcon';
import { LinkApi } from '../vite-env';
import { PeerDevice } from '../types/peer';
import { useHostQrCode } from '../utils/qr';
import { WALKIE_TALKIE_PORT } from '../utils/ports';
import { collectSubscriptions } from '../utils/subscriptions';

const linkApi = (window as any).link as LinkApi;

interface WalkieTalkieTabProps {
  peers: Map<string, PeerDevice>;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
  isMobile: boolean;
  /** Called whenever inSession changes, for the Tools tab's "Active in background" badge. There
   *  is no native session to poll, so the state is pushed instead. */
  onSessionActiveChange?: (active: boolean) => void;
}

interface Member {
  deviceId: string;
  name: string;
}

// No STUN/TURN: the app is LAN-only, so host ICE candidates are enough.
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

// Hub and spoke: every participant connects only to the coordinator (the device that started the
// session) and uploads its mic once. The coordinator builds a per-participant Web Audio mix that
// excludes that participant's own voice and sends it back as one track, so each participant's
// cost stays constant while the coordinator does the mixing.
//
// Signaling (membership, SDP, ICE) travels as link.walkietalkie.* packets over the trusted
// connection, relayed unchanged by core/host.rs and LinkPlugin.java, or over the guest channel
// for unpaired devices. Every member, paired or guest, connects to the coordinator directly, up to
// MAX_PARTICIPANTS including the coordinator; joiners beyond that are rejected as full.
const MAX_PARTICIPANTS = 64;

// Stands in for a device id for guest connections on the coordinator (guests are unpaired and
// have none): the prefix plus their connId is used for members, peerConnectionsRef keys and
// send() targets.
const GUEST_PREFIX = 'guest:';
// On a guest, the id for "the coordinator over the guest signaling channel"; a guest has exactly
// one connection and does not need the coordinator's device id.
const GUEST_LINK_ID = '__walkie_talkie_guest_link__';

interface PendingGuest {
  connId: string;
  pin: string;
  remoteAddress: string;
  deviceName?: string;
}

const WalkieTalkieTab: React.FC<WalkieTalkieTabProps> = ({ peers, localIdentity, isMobile, onSessionActiveChange }) => {
  // Signal handlers are registered once and outlive renders, so they read the identity from here;
  // a copy captured at mount can still be empty.
  const localIdentityRef = useRef(localIdentity);
  localIdentityRef.current = localIdentity;
  const [inSession, setInSession] = useState(false);
  const [isCoordinator, setIsCoordinator] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [discovered, setDiscovered] = useState<Map<string, { sessionId: string; name: string }>>(new Map());
  const [muted, setMuted] = useState(false);
  // Level of the incoming voices only; the system volume and other sounds are untouched.
  const [volume, setVolume] = useState(1);
  // Separate join and host errors: the idle screen shows both panels at once, and each error
  // belongs under the panel it came from.
  const [error, setError] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  // Host side: guests that connected by IP and are waiting for Accept or Reject on the PIN.
  const [pendingGuests, setPendingGuests] = useState<PendingGuest[]>([]);
  // Guest side: joining another device's session by IP.
  const [joinIpInput, setJoinIpInput] = useState('');
  const [guestJoinPhase, setGuestJoinPhase] = useState<'idle' | 'connecting' | 'waiting-pin' | 'error'>('idle');
  const [pin, setPin] = useState<string | null>(null);

  const qrDataUrl = useHostQrCode(inSession && isCoordinator, localIdentity, WALKIE_TALKIE_PORT);

  const sessionIdRef = useRef<string | null>(null);
  const isCoordinatorRef = useRef(false);
  const membersRef = useRef<Member[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  // A participant holds one connection, to the coordinator. The coordinator holds one per member
  // (device id, or GUEST_PREFIX + connId for guests).
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Participant only: plays the mixed track from the coordinator.
  const inboundAudioElRef = useRef<HTMLAudioElement | null>(null);
  // Participant only: the coordinator's device id, or GUEST_LINK_ID for a guest join.
  const coordinatorIdRef = useRef<string | null>(null);

  // Coordinator-only mixing graph.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const coordinatorMicSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // The coordinator hears each member through `monitorEl`, a plain <audio> element. In Chromium
  // (WebView2 and Android WebView) a MediaStreamAudioSourceNode built from a remote WebRTC stream
  // renders silence unless the stream is also attached to a media element, so the element is also
  // what makes `source` carry samples for the mixes sent to other members.
  const memberAudioRef = useRef<Map<string, {
    source: MediaStreamAudioSourceNode | null;
    dest: MediaStreamAudioDestinationNode;
    monitorEl: HTMLAudioElement | null;
  }>>(new Map());

  const peerName = (deviceId: string) => peers.get(deviceId)?.name || deviceId.slice(0, 8);

  const [showScannerModal, setShowScannerModal] = useState(false);

  const pendingTrustedJoinRef = useRef<string | null>(null);

  // Joining by address (scanned QR or typed IP): an address that belongs to a paired device joins
  // its session over the trusted signal channel without a PIN; anything else joins as a guest.
  const joinByAddress = (rawAddress: string) => {
    let clean = rawAddress.trim();
    if (clean.startsWith('link:')) {
      const parts = clean.split(':');
      if (parts.length >= 2) clean = parts[1];
    }
    const rawCandidates = clean.split(',').map((s) => s.trim()).filter(Boolean);
    if (rawCandidates.length === 0) return;

    const candidates = rawCandidates.map((c) => {
      // Strips a port suffix and brackets.
      const withoutPort = c.split(':')[0].replace(/^\[|\]$/g, '');
      return withoutPort.trim();
    }).filter(Boolean);

    let matchedPeer: any = null;
    for (const peer of Array.from(peers.values())) {
      if (!peer.trusted) continue;
      const peerIps = [peer.ipAddress, ...((peer as any).ipAddresses || [])].filter(Boolean);
      if (candidates.some((c) => peerIps.includes(c))) {
        matchedPeer = peer;
        break;
      }
    }

    if (matchedPeer) {
      setJoinIpInput(candidates[0]);
      const disc = discovered.get(matchedPeer.deviceId);
      if (disc?.sessionId) {
        joinSession(matchedPeer.deviceId, disc.sessionId);
        return;
      } else {
        // Ask for the session; the 'session-info' handler completes the join, and the timer gives
        // up if the peer is not hosting.
        pendingTrustedJoinRef.current = matchedPeer.deviceId;
        setGuestJoinPhase('connecting');
        send(matchedPeer.deviceId, 'session-query', {});
        setTimeout(() => {
          if (pendingTrustedJoinRef.current === matchedPeer.deviceId) {
            pendingTrustedJoinRef.current = null;
            setGuestJoinPhase('idle');
            setError('No active session found on ' + matchedPeer.name);
          }
        }, 5000);
        return;
      }
    }

    setJoinIpInput(candidates[0]);
    joinAsGuest(clean);
  };

  const handleDecodedHost = (rawText: string) => {
    setShowScannerModal(false);
    joinByAddress(rawText);
  };

  // Picks one of three transports for the same link.walkietalkie.* messages from the shape of the
  // target id (see GUEST_PREFIX and GUEST_LINK_ID).
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
    // A context can start or fall back into 'suspended' (user-gesture gating, auto-suspend on
    // silence) and connecting nodes does not resume it, but it still drives the per-member mixes.
    audioCtxRef.current.resume().catch(() => {});
    return audioCtxRef.current;
  };

  /** Coordinator only: tears down one member's mixing nodes and connection. */
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
    // A join that was still waiting for the host's answer must not complete after being cancelled.
    pendingTrustedJoinRef.current = null;
    membersRef.current = [];
    setInSession(false);
    setIsCoordinator(false);
    setMembers([]);
    setMuted(false);
    setPin(null);
    setGuestJoinPhase('idle');
  };

  // `onError` routes the failure to the panel (join or host) the caller belongs to.
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

    const sessionId = `${localIdentityRef.current.deviceId}-${Date.now()}`;
    sessionIdRef.current = sessionId;
    isCoordinatorRef.current = true;
    membersRef.current = [];
    setIsCoordinator(true);
    setMembers([]);
    setInSession(true);
    broadcast('session-info', { sessionId, name: localIdentityRef.current.deviceName });
    // The guest listener runs for the whole session so guests can join by IP at any time.
    // Promise.resolve() is needed because `?.()` can yield undefined, which has no .catch().
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
    send(coordinatorId, 'join-request', { sessionId, name: localIdentityRef.current.deviceName });
  };

  useEffect(() => {
    onSessionActiveChange?.(inSession);
  }, [inSession, onSessionActiveChange]);






  /** Joins by IP as an unpaired guest. Both sides derive the PIN from the TLS certificates, and the
   *  host's Accept is the consent step: acceptGuestJoin then sends join-accepted itself, so there is
   *  no separate join-request round trip. */
  const joinAsGuest = async (overrideHost?: string) => {
    setError(null);
    let host = (overrideHost || joinIpInput).trim();
    if (host.startsWith('link:')) {
      const parts = host.split(':');
      if (parts.length >= 2) host = parts[1];
    }
    // A host lists every address it has (Wi-Fi, VPN, virtual adapters); the native client tries them all
    // and keeps the one that answers, so none may be dropped here.
    host = host.split(',').map((h) => h.trim()).filter(Boolean).join(',');
    if (!host) return;
    if (!(await ensureLocalStream(setError))) return;
    setGuestJoinPhase('connecting');
    isCoordinatorRef.current = false;
    coordinatorIdRef.current = GUEST_LINK_ID;
    linkApi.joinWalkieTalkieGuest?.(host);
  };

  /** Coordinator only: whether one more member would exceed MAX_PARTICIPANTS (members plus this
   *  device). */
  const isSessionFull = () => membersRef.current.length + 1 >= MAX_PARTICIPANTS;

  /** Host side: Accept on a guest's PIN dialog. Guests have no trust-store name, so the name they
   *  report in the PIN handshake is used, falling back to their IP. */
  const acceptGuestJoin = (connId: string, remoteAddress: string, deviceName?: string, alreadyAdmitted = false) => {
    setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
    if (isSessionFull()) {
      // A paired device is admitted natively without a PIN, so it has to be closed rather than
      // rejected.
      if (alreadyAdmitted) linkApi.kickWalkieTalkieGuest?.(connId);
      else linkApi.rejectWalkieTalkieGuest?.(connId);
      setHostError('The session is full');
      return;
    }
    linkApi.acceptWalkieTalkieGuest?.(connId);
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

  /** Coordinator only: removes a participant. Guest connections are closed outright; paired
   *  members share the trusted connection, which must stay open, so they receive a targeted
   *  'session-ended' instead. */
  const kickMember = (m: Member) => {
    if (m.deviceId.startsWith(GUEST_PREFIX)) {
      linkApi.kickWalkieTalkieGuest?.(m.deviceId.slice(GUEST_PREFIX.length));
    } else {
      send(m.deviceId, 'session-ended', { sessionId: sessionIdRef.current });
    }
    handleMemberGone(m.deviceId, true);
  };

  /** Kicks and also blocks rejoining: guests are blocked by IP, paired members by device id. */
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
    for (const entry of memberAudioRef.current.values()) {
      if (entry.monitorEl) entry.monitorEl.volume = volume;
    }
    if (inboundAudioElRef.current) inboundAudioElRef.current.volume = volume;
  }, [volume]);

  // Coordinator: admits a joiner and wires them into everyone's mix.
  const acceptJoiner = async (deviceId: string, name: string) => {
    const ctx = ensureAudioContext();
    const dest = ctx.createMediaStreamDestination();

    // The new member's mix gets every existing voice plus the coordinator's mic.
    for (const entry of memberAudioRef.current.values()) entry.source?.connect(dest);
    coordinatorMicSourceRef.current?.connect(dest);
    memberAudioRef.current.set(deviceId, { source: null, dest, monitorEl: null });

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnectionsRef.current.set(deviceId, pc);
    // An explicit sendrecv transceiver rather than addTrack(): some WebView builds negotiated the
    // implicit transceiver one-way, so the member's mic never arrived here.
    dest.stream.getAudioTracks().forEach((t) => pc.addTransceiver(t, { direction: 'sendrecv', streams: [dest.stream] }));

    pc.onicecandidate = (e) => {
      if (e.candidate) send(deviceId, 'rtc-ice', { sessionId: sessionIdRef.current, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      ctx.resume().catch(() => {});
      // e.streams is empty when the sender signalled no msid, so wrap the bare track.
      const stream = e.streams[0] || new MediaStream([e.track]);

      // Playback through an <audio> element; see memberAudioRef for why not Web Audio.
      const monitorEl = document.createElement('audio');
      monitorEl.autoplay = true;
      (monitorEl as any).playsInline = true;
      monitorEl.volume = volume;
      monitorEl.srcObject = stream;
      document.body.appendChild(monitorEl);
      monitorEl.play().catch(() => {});

      // Feeds the mixes sent to other members; it only carries samples while monitorEl plays.
      const source = ctx.createMediaStreamSource(stream);
      const entry = memberAudioRef.current.get(deviceId);
      if (entry) {
        entry.source = source;
        entry.monitorEl = monitorEl;
      }
      // Into every other member's mix, never the member's own.
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
      members: [{ deviceId: localIdentityRef.current.deviceId, name: localIdentityRef.current.deviceName }, ...existing],
      sdp: pc.localDescription ? pc.localDescription.toJSON() : { type: offer.type, sdp: offer.sdp },
    });
    for (const m of existing) send(m.deviceId, 'member-joined', { sessionId: sessionIdRef.current, deviceId, name });
    membersRef.current = [...existing, { deviceId, name }];
    setMembers(membersRef.current);
  };

  /** Coordinator only: a member left, disconnected or its connection failed. */
  const handleMemberGone = (deviceId: string, notifyOthers: boolean) => {
    if (!membersRef.current.some((m) => m.deviceId === deviceId)) return;
    removeMemberAudio(deviceId);
    membersRef.current = membersRef.current.filter((m) => m.deviceId !== deviceId);
    setMembers(membersRef.current);
    if (notifyOthers) {
      for (const m of membersRef.current) send(m.deviceId, 'member-left', { sessionId: sessionIdRef.current, deviceId });
    }
  };

  // Participant: answers the coordinator's offer.
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
        el.volume = volume;
        document.body.appendChild(el);
        inboundAudioElRef.current = el;
      }
      // e.streams is empty when the sender signalled no msid, so wrap the bare track.
      el.srcObject = e.streams[0] || new MediaStream([e.track]);
      el.play().catch(() => {});
    };

    // The stream argument puts an msid in the SDP; without it the coordinator's ontrack gets an
    // empty e.streams. Added before setRemoteDescription so the offer's audio m-line pairs with
    // this transceiver instead of creating a second one.
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getAudioTracks()) {
        pc.addTrack(track, localStreamRef.current);
      }
    }
    await pc.setRemoteDescription(offerSdp);
    // If the browser matched the offer to a recvonly transceiver, force any transceiver carrying
    // a local track to sendrecv so the answer advertises sending.
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

  /** Single receiver for signaling messages from all three transports. */
  const handleSignal = (deviceId: string, type: string, body: any) => {
    const kind = type.replace('link.walkietalkie.', '');

    const signalHandlers: Record<string, () => void> = {
      'session-query': () => {
        if (isCoordinatorRef.current && sessionIdRef.current) {
          send(deviceId, 'session-info', { sessionId: sessionIdRef.current, name: localIdentityRef.current.deviceName });
        }
      },
      'session-info': () => {
        setDiscovered((prev) => {
          const copy = new Map(prev);
          copy.set(deviceId, { sessionId: body.sessionId, name: body.name || peerName(deviceId) });
          return copy;
        });
        if (pendingTrustedJoinRef.current === deviceId && body.sessionId) {
          pendingTrustedJoinRef.current = null;
          setGuestJoinPhase('idle');
          joinSession(deviceId, body.sessionId);
        }
      },
      'join-request': () => {
        if (!isCoordinatorRef.current || body.sessionId !== sessionIdRef.current) {
          send(deviceId, 'join-rejected', { sessionId: body.sessionId, reason: 'not-found' });
          return;
        }
        if (isSessionFull()) {
          send(deviceId, 'join-rejected', { sessionId: body.sessionId, reason: 'full' });
          return;
        }

        // The sender's own name first: the peer list can lack an entry for a device that just connected.
        const joinerName = body.name || peerName(deviceId);
        acceptJoiner(deviceId, joinerName).catch((e) => setHostError(e?.message || 'Failed to accept ' + joinerName));
      },
      'join-accepted': () => {
        if (sessionIdRef.current && body.sessionId !== sessionIdRef.current) return;
        sessionIdRef.current = body.sessionId;
        setGuestJoinPhase('idle');
        const incoming: Member[] = (body.members || []).filter((m: Member) => m.deviceId !== localIdentityRef.current.deviceId);
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

    // No teardownSession() here: the session lives only in this component, which App.tsx keeps
    // mounted, and it ends only through an explicit leave.
    return () => { unsubscribe?.(); };
     
  }, []);

  // Host side: guests connecting by IP while this device hosts (see startSession()).
  useEffect(() => {
    if (!linkApi?.onWalkieTalkieGuestPinPending) return;
    const [events, unsubscribeAll] = collectSubscriptions(linkApi);
    events.onWalkieTalkieGuestPinPending?.((connId: string, pin: string, remoteAddress: string, deviceName?: string) => {
      setPendingGuests((prev) => [...prev.filter((g) => g.connId !== connId), { connId, pin, remoteAddress, deviceName }]);
    });
    // A trusted device skips the PIN prompt, so there is no Accept to wait for.
    events.onWalkieTalkieGuestJoined?.((connId: string, remoteAddress: string, deviceName: string) => {
      acceptGuestJoin(connId, remoteAddress, deviceName, true);
    });
    events.onWalkieTalkieGuestSignal?.((connId: string, type: string, body: any) => {
      handleSignal(GUEST_PREFIX + connId, type, body);
    });
    events.onWalkieTalkieGuestLeft?.((connId: string) => {
      handleMemberGone(GUEST_PREFIX + connId, true);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
    });
    return unsubscribeAll;
  }, []);

  // Guest side: this device joining another session by IP (see joinAsGuest()).
  useEffect(() => {
    if (!linkApi?.onWalkieTalkieGuestPinComputed) return;
    const [events, unsubscribeAll] = collectSubscriptions(linkApi);
    events.onWalkieTalkieGuestPinComputed?.((computedPin: string) => {
      setPin(computedPin);
      setGuestJoinPhase('waiting-pin');
    });
    events.onWalkieTalkieHostSignal?.((type: string, body: any) => {
      handleSignal(GUEST_LINK_ID, type, body);
    });
    events.onWalkieTalkieHostEnded?.((reason?: string) => {
      // A kick closes with the same normal code as a session end, so only the reason tells them
      // apart.
      if (reason === 'removed by host') setError('Removed by host');
      teardownSession();
    });
    events.onWalkieTalkieHostClosed?.((reason: string) => {
      setError(
        // A block is reported as a plain rejection.
        reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host'
        : reason === 'removed by host' ? 'Removed by host'
        : reason || 'Connection lost'
      );
      setGuestJoinPhase('idle');
      teardownSession();
    });
    events.onWalkieTalkieHostError?.((message: string) => {
      setError(message);
      // Some WebSocket stacks report an abrupt TLS teardown (such as a kick) as an error rather
      // than a close, so an error also ends the session.
      teardownSession();
    });
    return unsubscribeAll;
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
        // Losing the coordinator ends the session. Guest joins are handled by the host-closed and
        // host-ended listeners instead.
        teardownSession();
      }
    });
  }, []);

  const hosting = inSession && isCoordinator;
  const joined = inSession && !isCoordinator;
  // This device plus the others. A joiner always counts the host, even before the list arrives.
  const participantCount = 1 + Math.max(members.length, joined ? 1 : 0);

  const renderMembersList = () => {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
        <div
          className="member-row"
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: '12px',
            padding: '10px 14px',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            boxSizing: 'border-box',
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
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
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

        {members.map((m) => (
          <div
            key={m.deviceId}
            className="member-row"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '10px 14px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
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
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {m.name}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2.5px' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Connected</span>
                </div>
              </div>
            </div>
            {/* Only the coordinator can remove members */}
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

  // Join and host sections are both shown while idle, separated by a divider.
  const showDivider = !hosting && !joined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', padding: '4px' }}>
      {!hosting && (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {!joined && <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Join a Session</div>}

          {!joined && discovered.size > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Array.from(discovered.entries()).map(([coordinatorId, info]) => (
                <div key={coordinatorId} className="member-row" style={{ padding: '10px 14px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0, flex: 1 }}>
                    {info.name} has an active session
                  </span>
                  <button onClick={() => joinSession(coordinatorId, info.sessionId)} style={{ padding: '5px 14px', fontSize: '11.5px', flexShrink: 0 }}>
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
                onEnter={() => joinByAddress(joinIpInput)}
                placeholder="Host's IP address"
              />
              <PrimaryButton onClick={() => joinByAddress(joinIpInput)} disabled={!joinIpInput}>
                Connect
              </PrimaryButton>
            </div>
          )}

          {(guestJoinPhase === 'connecting' || guestJoinPhase === 'waiting-pin') && (
            <DialogCard onCancel={leaveSession} zIndex={2000}>
              <ConnectingCard
                targetLabel={joinIpInput}
                phase={guestJoinPhase}
                pin={pin}
                onCancel={leaveSession}
                waitingLabel="Connecting to the session host..."
              />
            </DialogCard>
          )}

          {joined && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '13px', overflowWrap: 'anywhere' }}>
                  Participants ({participantCount} / {MAX_PARTICIPANTS})
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
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  style={{ flex: '1 1 120px', minWidth: 0 }}
                />
              </div>
            </div>
          )}
          {error &&<div style={{ color: '#e05c5c', fontSize: '12.5px' }}>{error}</div>}
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
                  Participants ({participantCount} / {MAX_PARTICIPANTS})
                </div>

                {renderMembersList()}

                <div className="flex-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Volume</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    style={{ flex: '1 1 120px', minWidth: 0 }}
                  />
                </div>

                {hostError &&<div style={{ color: '#e05c5c', fontSize: '12px' }}>{hostError}</div>}
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
