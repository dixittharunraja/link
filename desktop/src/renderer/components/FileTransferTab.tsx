import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { ScannerModal, IpScanField, PendingGuestCard, ConnectingCard } from './ModalDialog';

const linkApi = (window as any).link;

interface FileTransferTabProps {
  isMobile: boolean;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const FileTransferTab: React.FC<FileTransferTabProps> = ({ isMobile, localIdentity }) => {
  // Receiver state
  const [receiving, setReceiving] = useState(false);
  const [pendingGuests, setPendingGuests] = useState<{ connId: string; pin: string; remoteAddress: string; deviceName?: string }[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<{ connId: string; deviceName: string } | null>(null);
  const [incoming, setIncoming] = useState<{ connId: string; name: string; size: number; received: number } | null>(null);
  const [receivedPaths, setReceivedPaths] = useState<string[]>([]);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [webMode, setWebMode] = useState(false);
  const [port, setPort] = useState(1746);
  const [copied, setCopied] = useState(false);

  // Sender state
  const [joinIpInput, setJoinIpInput] = useState('');
  const [pickedFiles, setPickedFiles] = useState<{ localPath: string; relPath: string }[]>([]);
  const [senderPhase, setSenderPhase] = useState<'idle' | 'connecting' | 'waiting-pin' | 'connected' | 'sending' | 'error'>('idle');
  const [pin, setPin] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<{ index: number; count: number; name: string } | null>(null);
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  // Written from several places (drop failure, portal error/closed) but never previously
  // rendered anywhere — unlike its receive-side counterpart (receiveError), which is shown in
  // the QR panel. That looked like dead code, but reading the write sites it's clearly an
  // unfinished feature rather than leftover cruft, so it's wired into the UI below instead of
  // deleted (see the Connect to Peer panel and the connected-state header).
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastSentCount, setLastSentCount] = useState<number>(0);
  // The receiver's own device name, learned from the 'admitted' handshake — kept separate from
  // connectedDevice (receiver-side only, and its connId drives the Disconnect button's branching
  // below) rather than reused for this, so a connected sender doesn't end up with a fake/empty
  // connId that button would try to disconnect by.
  const [senderPeerName, setSenderPeerName] = useState<string | null>(null);

  // Speed Tracking Refs
  const transferStartRef = useRef<{ time: number; bytes: number } | null>(null);
  const incomingStartRef = useRef<{ time: number; bytes: number } | null>(null);

  const getSendSpeed = () => {
    if (!transferStartRef.current || !sendProgress || sendProgress.sent <= transferStartRef.current.bytes) return '';
    const elapsed = (Date.now() - transferStartRef.current.time) / 1000;
    if (elapsed <= 0.2) return '';
    const bytes = sendProgress.sent - transferStartRef.current.bytes;
    return ` @ ${formatBytes(bytes / elapsed)}/s`;
  };

  const getReceiveSpeed = () => {
    if (!incomingStartRef.current || !incoming || incoming.received <= incomingStartRef.current.bytes) return '';
    const elapsed = (Date.now() - incomingStartRef.current.time) / 1000;
    if (elapsed <= 0.2) return '';
    const bytes = incoming.received - incomingStartRef.current.bytes;
    return ` @ ${formatBytes(bytes / elapsed)}/s`;
  };

  // QR Display State
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Generate QR for local IP when receiving is active
  useEffect(() => {
    if (receiving) {
      // A single address, not the full ipAddresses list — joining all of them into one string
      // ("192.168.1.5,10.0.0.2") previously got encoded verbatim, then decoded back out as one
      // literal (invalid) hostname on the scanning side, which is exactly what broke connecting.
      // ipAddress is already the single best-ranked candidate (see main.ts's getLocalIpAddress).
      const ip = localIdentity?.ipAddress || '127.0.0.1';
      const qrText = webMode
        ? `http://${ip}:${port}`
        : `link:${ip}:${port}`;
      QRCode.toDataURL(qrText, {
        margin: 1,
        width: 160,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      })
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error('Failed to generate portal QR:', err));
    } else {
      setQrDataUrl(null);
    }
  }, [receiving, localIdentity, webMode, port]);

  const [showScannerModal, setShowScannerModal] = useState(false);

  const handleDecodedHost = (host: string) => {
    setShowScannerModal(false);
    setJoinIpInput(host);
    setSendError(null);
    setSenderPhase('connecting');
    linkApi.joinPortalGuest?.(host, pickedFiles);
  };

  const startReceiving = async (useWebMode?: boolean) => {
    if (!linkApi) return;
    setReceiveError(null);
    const targetWebMode = useWebMode !== undefined ? useWebMode : webMode;

    await linkApi.endPortalReceive?.();
    setReceiving(false);

    const result = await linkApi.startPortalReceive?.(targetWebMode);
    if (result?.started) {
      setReceiving(true);
      if (result.port) setPort(result.port);
    } else {
      setReceiveError(result?.error || 'Failed to start receiving');
    }
  };

  const toggleWebMode = async () => {
    const nextMode = !webMode;
    setWebMode(nextMode);
    await startReceiving(nextMode);
  };

  const copyUrl = () => {
    if (!localIdentity?.ipAddress) return;
    navigator.clipboard.writeText(`http://${localIdentity.ipAddress}:${port}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const pickedFilesRef = useRef(pickedFiles);
  useEffect(() => {
    pickedFilesRef.current = pickedFiles;
  }, [pickedFiles]);

  // Read inside the onPortalError handler below, which is registered once (effect deps: []) and
  // would otherwise only ever see senderPhase's value from the moment it mounted.
  const senderPhaseRef = useRef(senderPhase);
  useEffect(() => {
    senderPhaseRef.current = senderPhase;
  }, [senderPhase]);

  useEffect(() => {
    if (receiving && webMode && linkApi?.setPortalDownloads) {
      linkApi.setPortalDownloads(pickedFiles.map(f => ({ name: f.relPath, localPath: f.localPath })));
    }
  }, [pickedFiles, receiving, webMode]);

  useEffect(() => {
    if (!linkApi) return;

    startReceiving();

    linkApi.onPortalGuestPinPending?.((connId: string, guestPin: string, remoteAddress: string, deviceName?: string) => {
      setPendingGuests((prev) => [...prev, { connId, pin: guestPin, remoteAddress, deviceName }]);
    });
    linkApi.onPortalConnectionAdmitted?.((connId: string, deviceName: string) => {
      setConnectedDevice({ connId, deviceName });
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
    });
    linkApi.onPortalConnectionClosed?.((connId: string) => {
      setConnectedDevice((prev) => (prev && prev.connId === connId ? null : prev));
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
    });
    linkApi.onPortalTransferStarted?.((connId: string, name: string, size: number) => {
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
      setIncoming({ connId, name, size, received: 0 });
      incomingStartRef.current = { time: Date.now(), bytes: 0 };
    });
    linkApi.onPortalTransferProgress?.((connId: string, received: number, size: number) => {
      setIncoming((prev) => (prev && prev.connId === connId ? { ...prev, received } : prev));
    });
    linkApi.onPortalTransferComplete?.((connId: string, destPath: string) => {
      setIncoming((prev) => (prev && prev.connId === connId ? null : prev));
      setReceivedPaths((prev) => [...prev, destPath]);
    });
    linkApi.onPortalError?.((message: string) => {
      // This single event is emitted for BOTH the receive-server path and the send-client path
      // with no source tag distinguishing them — previously that meant a send-side connect
      // failure (e.g. a malformed multi-address host) also lit up the receive panel's error
      // banner ("Failed to start receiving") even though receiving was working fine. Routing by
      // whether a send attempt is actually in flight is the only signal available without adding
      // one natively, and is accurate for every real case: senderPhase can only be 'connecting'/
      // 'waiting-pin'/'sending' while this device itself initiated a send.
      const isSendContext = ['connecting', 'waiting-pin', 'sending'].includes(senderPhaseRef.current);
      if (isSendContext) {
        setSendError(message);
        setSenderPhase('error');
      } else {
        setReceiveError(message);
      }
    });
    linkApi.onPortalPinComputed?.((computedPin: string) => {
      setPin(computedPin);
      setSenderPhase('waiting-pin');
    });
    linkApi.onPortalAdmitted?.((receiverDeviceName?: string) => {
      setSenderPhase('connected');
      setSenderPeerName(receiverDeviceName || null);
    });
    linkApi.onPortalFileStarted?.((fileIndex: number, fileCount: number, name: string) => {
      setSenderPhase('sending');
      setCurrentFile({ index: fileIndex, count: fileCount, name });
      setSendProgress(null);
      transferStartRef.current = { time: Date.now(), bytes: 0 };
    });
    linkApi.onPortalSendProgress?.((sent: number, total: number) => {
      setSendProgress({ sent, total });
    });
    linkApi.onPortalSendComplete?.(() => {
      setLastSentCount(pickedFilesRef.current.length);
      setSenderPhase('connected');
      setSendProgress(null);
      setCurrentFile(null);
      setPickedFiles([]);
      setTimeout(() => {
        setLastSentCount(0);
      }, 5000);
    });
    linkApi.onPortalEnded?.(() => {
      setSenderPhase('idle');
      setSenderPeerName(null);
    });
    linkApi.onPortalClosed?.((reason: string) => {
      // The server sends the raw wire reason string ('rejected by host', 'blocked', etc.) — map to
      // the same display text Audio Sink/Joystick use rather than showing it verbatim. 'blocked'
      // should never reveal that it was specifically blocked, just rejected.
      setSendError(reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host' : reason);
      setSenderPhase('error');
      setSenderPeerName(null);
    });

    return () => {
      linkApi?.endPortalReceive?.();
    };
  }, []);

  // Re-picking (or re-dropping) a file already in the list appended a second, duplicate entry —
  // sent twice and, since the list is keyed by localPath, also a React duplicate-key warning.
  // Merge by localPath instead of blindly concatenating.
  const mergePickedFiles = (
    prev: { localPath: string; relPath: string }[],
    added: { localPath: string; relPath: string }[],
  ) => {
    const existing = new Set(prev.map((f) => f.localPath));
    const deduped = added.filter((f) => !existing.has(f.localPath));
    return [...prev, ...deduped];
  };

  const pickFiles = async (mode: 'file' | 'directory') => {
    const paths = await linkApi?.pickPortalFiles?.(mode);
    if (paths && paths.length > 0) {
      setPickedFiles((prev) => mergePickedFiles(prev, paths));
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!linkApi) return;
    const paths = Array.from(e.dataTransfer.files).map((f: any) => linkApi.getPathForFile(f)).filter(Boolean);
    if (paths.length === 0) return;
    try {
      const expanded = await linkApi.expandDroppedPaths(paths);
      if (expanded && expanded.length > 0) {
        setPickedFiles((prev) => mergePickedFiles(prev, expanded));
      }
    } catch (err: any) {
      setSendError(`Failed to process dropped files: ${err.message}`);
    }
  };

  const connectPortal = () => {
    if (!linkApi || !joinIpInput) return;
    setSendError(null);
    setSenderPhase('connecting');
    linkApi.joinPortalGuest?.(joinIpInput, []);
  };

  const sendFiles = () => {
    if (!linkApi || pickedFiles.length === 0 || !joinIpInput) return;
    setSendError(null);
    setSenderPhase('sending');
    linkApi.joinPortalGuest?.(joinIpInput, pickedFiles);
  };

  const cancelSend = () => {
    linkApi?.leavePortalSend?.();
    setSenderPhase('idle');
    setPin(null);
    setSendProgress(null);
    setCurrentFile(null);
  };

  const acceptGuest = async (connId: string) => {
    if (isMobile) {
      linkApi.acceptPortalGuest?.(connId);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
      return;
    }
    linkApi.holdPortalGuest?.(connId);
    const dir = await linkApi.pickPortalSaveDir?.();
    if (!dir) {
      linkApi.rejectPortalGuest?.(connId);
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
      return;
    }
    linkApi.acceptPortalGuest?.(connId, dir);
    setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
  };

  const isPendingGuest = pendingGuests.length > 0;
  const isWaitingForPin = senderPhase === 'waiting-pin';
  const isConnecting = senderPhase === 'connecting';
  const isConnected = connectedDevice !== null || senderPhase === 'connected' || senderPhase === 'sending';
  const isIdle = !isConnected && !isPendingGuest && !isWaitingForPin && !isConnecting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', padding: '4px' }}>
      {isIdle && (
        <div className="fx-split-container">
        <div className="fx-split">
          <div className="fx-split-col" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', padding: '16px', minHeight: '260px', boxSizing: 'border-box' }}>
            <div style={{ fontWeight: 600, marginBottom: '12px', color: 'var(--text-color)', fontSize: '14px' }}>Your QR Code</div>
            {receiveError ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center', margin: 'auto 0' }}>
                <div style={{ color: '#e05c5c', fontSize: '12.5px', textAlign: 'center' }}>
                  Failed to start receiving: {receiveError}
                </div>
                <button onClick={() => startReceiving()} style={{ padding: '6px 12px', borderRadius: '4px' }}>Retry</button>
              </div>
            ) : !receiving ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '12.5px', margin: 'auto 0' }}>Starting receiver...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', boxSizing: 'border-box', margin: 'auto 0', width: '100%' }}>
                {qrDataUrl ? (
                  <div style={{ background: '#fff', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                    <img src={qrDataUrl} alt="Portal QR Code" style={{ display: 'block', width: '120px', height: '120px' }} />
                  </div>
                ) : (
                  <div style={{ width: '120px', height: '120px', background: 'rgba(0,0,0,0.05)', borderRadius: '8px' }} />
                )}
                {webMode ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '100%', boxSizing: 'border-box' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--input-bg, rgba(0,0,0,0.05))', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color, rgba(255,255,255,0.08))', maxWidth: '100%', boxSizing: 'border-box' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, fontFamily: 'monospace', color: 'var(--text-color)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        http://{localIdentity?.ipAddress || '127.0.0.1'}:{port}
                      </span>
                      <button
                        onClick={copyUrl}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: copied ? '#10b981' : 'var(--accent-color, #007acc)',
                          cursor: 'pointer',
                          padding: '2px',
                          fontSize: '11px',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', lineHeight: '1.4' }}>
                      Open this URL in any browser to share files without the app
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)' }}>
                      {localIdentity?.ipAddress || '127.0.0.1'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
                      Show this QR code or IP to let the other device connect and send files
                    </div>
                  </>
                )}
              </div>
            )}
            
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              marginTop: '16px',
              padding: '8px 12px',
              borderRadius: '8px',
              background: 'var(--input-bg, rgba(0,0,0,0.02))',
              border: '1px solid var(--border-color, rgba(255,255,255,0.05))',
              boxSizing: 'border-box'
            }}>
              <span style={{ fontSize: '12px', color: 'var(--text-color)', fontWeight: 500 }}>Web Portal Mode</span>
              <div
                onClick={toggleWebMode}
                style={{
                  width: '36px',
                  height: '20px',
                  borderRadius: '10px',
                  background: webMode ? 'var(--accent-color, #007acc)' : 'rgba(255,255,255,0.15)',
                  position: 'relative',
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '2px',
                  boxSizing: 'border-box'
                }}
              >
                <div style={{
                  width: '14px',
                  height: '14px',
                  borderRadius: '50%',
                  background: '#fff',
                  position: 'absolute',
                  left: webMode ? '20px' : '2px',
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
            </div>
          </div>

          <div className="fx-split-divider" />

          <div
            className="fx-split-col"
            style={{ display: 'flex', flexDirection: 'column', padding: '16px', gap: '12px', minHeight: '260px', boxSizing: 'border-box' }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Connect to Peer</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
              Enter the receiver's IP address or scan their QR code to establish a file transfer connection.
            </div>

            {sendError && (
              <div style={{ color: '#e05c5c', fontSize: '12.5px', overflowWrap: 'anywhere' }}>{sendError}</div>
            )}

            <IpScanField
              value={joinIpInput}
              onChange={setJoinIpInput}
              onScanClick={() => setShowScannerModal(true)}
              style={{ marginTop: 'auto' }}
            />
            <button
              onClick={connectPortal}
              disabled={!joinIpInput}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: '8px',
                // See AudioSinkTab's matching Connect button for why this isn't opacity-dimmed:
                // it faded the white label to the point of being hard to read, not just "disabled."
                background: joinIpInput ? 'var(--accent-color, #007acc)' : 'var(--input-bg)',
                color: joinIpInput ? 'var(--btn-primary-text)' : 'var(--text-muted)',
                border: joinIpInput ? 'none' : '1px solid var(--border-color)',
                fontWeight: 600,
                cursor: joinIpInput ? 'pointer' : 'not-allowed',
                marginTop: 'auto',
              }}
            >
              Connect
            </button>
          </div>
        </div>
        </div>
      )}

      {isPendingGuest && (
        // Separate popup, not a row stacked in with the rest of the tab — see AudioSinkTab's
        // identical fix for the full reasoning. Styled to match the Tools modal wrapper this sits
        // on top of (ToolsTab.tsx's own popup: var(--modal-bg)/var(--border-color)/
        // var(--modal-shadow), same backdrop blur), just at a higher zIndex (that wrapper is 1000).
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
        >
          <div
            style={{
              width: '100%', maxWidth: '380px',
              backgroundColor: 'var(--modal-bg)', border: '1px solid var(--border-color)',
              borderRadius: '16px', boxShadow: '0 20px 50px var(--modal-shadow)',
            }}
          >
            <PendingGuestCard
              guest={pendingGuests[0]}
              onReject={() => {
                linkApi.rejectPortalGuest?.(pendingGuests[0].connId);
                setPendingGuests((prev) => prev.filter((g) => g.connId !== pendingGuests[0].connId));
              }}
              onAccept={() => acceptGuest(pendingGuests[0].connId)}
              onBlock={() => {
                linkApi.blockPortalGuest?.(pendingGuests[0].connId);
                setPendingGuests((prev) => prev.filter((g) => g.connId !== pendingGuests[0].connId));
              }}
            />
          </div>
        </div>
      )}

      {(isWaitingForPin || isConnecting) && (
        <ConnectingCard
          targetLabel={joinIpInput}
          phase={senderPhase}
          pin={pin}
          onCancel={cancelSend}
        />
      )}

      {isConnected && (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>
                Connected with {connectedDevice?.deviceName || senderPeerName || 'Peer'}
              </div>
              {sendError && (
                <div style={{ color: '#e05c5c', fontSize: '11.5px', marginTop: '4px', overflowWrap: 'anywhere' }}>{sendError}</div>
              )}
              {lastSentCount > 0 && (
                <div style={{ color: '#2ecc71', fontSize: '11.5px', marginTop: '4px' }}>
                  Sent {lastSentCount} item{lastSentCount === 1 ? '' : 's'} successfully
                </div>
              )}
            </div>
            <button
              onClick={() => {
                if (connectedDevice) {
                  linkApi.disconnectPortalConnection?.(connectedDevice.connId);
                  setConnectedDevice(null);
                } else {
                  linkApi.leavePortalSend?.();
                  setSenderPhase('idle');
                  setSenderPeerName(null);
                }
              }}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid #ef4444',
                background: 'transparent',
                color: '#ef4444',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              Disconnect
            </button>
          </div>

          <div className="fx-split-container">
          <div className="fx-split">
            <div
              className="fx-split-col"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              style={{
                border: '2px dashed var(--border-color)',
                borderRadius: '8px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                background: 'var(--input-bg, rgba(0,0,0,0.01))',
              }}
            >
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)' }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <div style={{ fontSize: '13px', color: 'var(--text-color)', fontWeight: 500, textAlign: 'center' }}>
                Drag and drop files/folders here to share
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => pickFiles('file')}
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  Add Files
                </button>
                <button
                  onClick={() => pickFiles('directory')}
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  Add Folder
                </button>
              </div>
            </div>

            <div className="fx-split-divider" />

            <div className="fx-split-col" style={{ display: 'flex', flexDirection: 'column', gap: '12px', justifyContent: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>Transfer Activity</div>

              {incoming ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--input-bg)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, overflowWrap: 'anywhere' }}>Receiving: {incoming.name}</div>
                  <div style={{ width: '100%', height: '6px', background: 'rgba(0,0,0,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: `${incoming.size > 0 ? (incoming.received / incoming.size) * 100 : 0}%`, height: '100%', background: 'var(--accent-color, #007acc)' }} />
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {formatBytes(incoming.received)} / {formatBytes(incoming.size)}{getReceiveSpeed()}
                  </div>
                </div>
              ) : null}

              {senderPhase === 'sending' && currentFile && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--input-bg)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                    Sending ({currentFile.index}/{currentFile.count}): {currentFile.name}
                  </div>
                  <div style={{ width: '100%', height: '6px', background: 'rgba(0,0,0,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: `${sendProgress ? (sendProgress.sent / sendProgress.total) * 100 : 0}%`, height: '100%', background: 'var(--accent-color, #007acc)' }} />
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {sendProgress ? `${formatBytes(sendProgress.sent)} / ${formatBytes(sendProgress.total)}` : 'Preparing...'}
                    {getSendSpeed()}
                  </div>
                </div>
              )}

              {pickedFiles.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{pickedFiles.length} item(s) selected:</div>
                  <div style={{ maxHeight: '100px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px', background: 'var(--input-bg)' }}>
                    {pickedFiles.map((f) => (
                      <div key={f.localPath} style={{ fontSize: '11.5px', overflowWrap: 'anywhere', padding: '2px 0' }}>{f.relPath}</div>
                    ))}
                  </div>
                  {webMode ? (
                    <div style={{ fontSize: '12px', color: '#2ecc71', fontWeight: 500, textAlign: 'center', padding: '4px' }}>
                      ✓ Available for download on the browser page
                    </div>
                  ) : senderPhase === 'connected' ? (
                    <button
                      onClick={sendFiles}
                      style={{ padding: '8px 16px', background: 'var(--accent-color)', color: 'var(--btn-primary-text)', border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}
                    >
                      Send Selected
                    </button>
                  ) : null}
                </div>
              )}

              {receivedPaths.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600 }}>Received Files:</div>
                  <div style={{ maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {receivedPaths.map((p) => (
                      <div key={p} style={{ fontSize: '11.5px', color: '#2ecc71', overflowWrap: 'anywhere' }}>
                        ✓ {p.split(/[\\/]/).pop()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!incoming && senderPhase !== 'sending' && pickedFiles.length === 0 && receivedPaths.length === 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>
                  No active transfers. Drag & drop files on the left to send.
                </div>
              )}
            </div>
          </div>
          </div>
        </div>
      )}

      <ScannerModal
        open={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onDecoded={handleDecodedHost}
        title="Scan Session QR Code"
      />
    </div>
  );
};

export default FileTransferTab;
