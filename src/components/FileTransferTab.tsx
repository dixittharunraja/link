import React, { useEffect, useState, useRef } from 'react';
import { ScannerModal, IpScanField, ConnectingCard, PendingGuestsModal, PrimaryButton } from './ModalDialog';
import { LinkApi } from '../vite-env';
import { createLinkQrDataUrl } from '../utils/qr';

const linkApi = (window as any).link as LinkApi;

interface FileTransferTabProps {
  isMobile: boolean;
  localIdentity: { deviceId: string; deviceName: string; ipAddress?: string; ipAddresses?: string[] };
}

interface PeerFile {
  id: string;
  name: string;
  size: number;
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

  // Staged files & Peer files
  const [pickedFiles, setPickedFiles] = useState<{ localPath: string; relPath: string }[]>([]);
  const [peerFiles, setPeerFiles] = useState<PeerFile[]>([]);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);

  // Sender state
  const [joinIpInput, setJoinIpInput] = useState('');
  const [senderPhase, setSenderPhase] = useState<'idle' | 'connecting' | 'waiting-pin' | 'connected' | 'sending' | 'error'>('idle');
  const [pin, setPin] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<{ index: number; count: number; name: string } | null>(null);
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
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

  useEffect(() => {
    if (receiving) {
      const allIps = (localIdentity?.ipAddresses && localIdentity.ipAddresses.length > 0)
        ? localIdentity.ipAddresses
        : [localIdentity?.ipAddress || '127.0.0.1'];
      const primaryIp = allIps[0];
      const qrTarget = webMode ? `http://${primaryIp}:${port}` : `${allIps.join(',')}:${port}`;
      createLinkQrDataUrl(qrTarget)
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
    await linkApi.endPortalReceive?.();
    setReceiving(false);
    await startReceiving(nextMode);
  };

  const copyUrl = () => {
    if (!localIdentity?.ipAddress) return;
    navigator.clipboard.writeText(`http://${localIdentity.ipAddress}:${port}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const senderPhaseRef = useRef(senderPhase);
  useEffect(() => {
    senderPhaseRef.current = senderPhase;
  }, [senderPhase]);

  // Synchronize staged files to native backend so they are broadcast to peers
  useEffect(() => {
    if (linkApi?.setPortalDownloads) {
      linkApi.setPortalDownloads(pickedFiles.map(f => ({ name: f.relPath, localPath: f.localPath })));
    }
  }, [pickedFiles]);

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
      setPeerFiles([]);
    });
    linkApi.onPortalPeerFilesChanged?.((files: PeerFile[]) => {
      setPeerFiles(files);
    });
    linkApi.onPortalTransferStarted?.((connId: string, name: string, size: number) => {
      setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
      setIncoming({ connId, name, size, received: 0 });
      incomingStartRef.current = { time: Date.now(), bytes: 0 };
    });
    linkApi.onPortalTransferProgress?.((connId: string, received: number, _size: number) => {
      setIncoming((prev) => (prev && prev.connId === connId ? { ...prev, received } : prev));
    });
    linkApi.onPortalTransferComplete?.((connId: string, destPath: string) => {
      setIncoming((prev) => (prev && prev.connId === connId ? null : prev));
      setDownloadingFileId(null);
      setReceivedPaths((prev) => [...prev, destPath]);
    });
    linkApi.onPortalError?.((message: string) => {
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
      setSenderPhase('connected');
      setSendProgress(null);
      setCurrentFile(null);
    });
    linkApi.onPortalEnded?.(() => {
      setSenderPhase('idle');
      setSenderPeerName(null);
      setPeerFiles([]);
    });
    linkApi.onPortalClosed?.((reason: string) => {
      const isClean = !reason || reason === '1000' || reason.includes('1000') || reason.includes('1001') || reason.includes('normal') || reason.includes('clean') || reason === 'closed';
      if (isClean) {
        setSenderPhase('idle');
        setSendError(null);
      } else {
        setSendError(reason === 'rejected by host' || reason === 'blocked' ? 'Rejected by host' : reason);
        setSenderPhase('error');
      }
      setSenderPeerName(null);
      setPeerFiles([]);
    });

    Promise.resolve(linkApi.getPortalStatus?.()).then((status: any) => {
      if (status?.receiving) {
        setReceiving(true);
      }
      if (status?.webMode !== undefined) {
        setWebMode(!!status.webMode);
      }
      if (status?.connected) {
        if (status.isHost && status.connId) {
          setConnectedDevice({ connId: status.connId, deviceName: status.peerName || 'Peer' });
        } else if (status.sending || !status.isHost) {
          setSenderPhase('connected');
          if (status.peerName) setSenderPeerName(status.peerName);
        }
      }
    }).catch(() => {});
  }, []);

  const mergePickedFiles = (
    existing: { localPath: string; relPath: string }[],
    incomingList: { localPath: string; relPath: string }[]
  ) => {
    const existingPaths = new Set(existing.map((f) => f.localPath));
    const toAdd = incomingList.filter((f) => !existingPaths.has(f.localPath));
    return [...existing, ...toAdd];
  };

  const removeStagedFile = (localPath: string) => {
    setPickedFiles((prev) => prev.filter((f) => f.localPath !== localPath));
  };

  const requestDownload = async (fileId: string) => {
    let saveDir: string | undefined = undefined;
    if (!isMobile) {
      const picked = await linkApi.pickPortalSaveDir?.();
      if (!picked) return;
      saveDir = picked;
    }
    setDownloadingFileId(fileId);
    linkApi.requestPortalDownload?.(fileId, saveDir);
  };

  const downloadAll = async () => {
    if (peerFiles.length === 0) return;
    let saveDir: string | undefined = undefined;
    if (!isMobile) {
      const picked = await linkApi.pickPortalSaveDir?.();
      if (!picked) return;
      saveDir = picked;
    }
    peerFiles.forEach((file) => {
      linkApi.requestPortalDownload?.(file.id, saveDir);
    });
  };

  const pickFiles = async (mode: 'file' | 'directory') => {
    if (isMobile) {
      const uris = await linkApi.pickPortalFiles?.();
      if (uris && uris.length > 0) {
        const mapped = uris.map((u: string) => ({
          localPath: u,
          relPath: decodeURIComponent(u.split('/').pop() || 'file'),
        }));
        setPickedFiles((prev) => mergePickedFiles(prev, mapped));
      }
      return;
    }

    const files = await linkApi.pickPortalFiles?.(mode);
    if (files && files.length > 0) {
      setPickedFiles((prev) => mergePickedFiles(prev, files));
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (isMobile) return;
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    const mapped = droppedFiles.map((f: any) => ({
      localPath: f.path || f.name,
      relPath: f.name,
    }));
    setPickedFiles((prev) => mergePickedFiles(prev, mapped));
  };

  const connectPortal = () => {
    if (!joinIpInput) return;
    setSendError(null);
    setSenderPhase('connecting');
    linkApi.joinPortalGuest?.(joinIpInput, pickedFiles);
  };

  const cancelSend = () => {
    linkApi?.leavePortalSend?.();
    setSenderPhase('idle');
    setPin(null);
    setSendProgress(null);
    setCurrentFile(null);
  };

  const acceptGuest = (connId: string) => {
    linkApi.acceptPortalGuest?.(connId);
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
            <div style={{ fontWeight: 600, marginBottom: '12px', color: 'var(--text-color)', fontSize: '14px' }}>
              {webMode ? 'Web Portal' : 'Your QR Code'}
            </div>
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
                      Open this URL in any browser to send & receive files without the app
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-color)' }}>
                      {localIdentity?.ipAddress || '127.0.0.1'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
                      Show this QR code or IP to let the other device connect and exchange files
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
              <span style={{ fontSize: '12px', color: 'var(--text-color)', fontWeight: 500 }}>Web Share Mode</span>
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

          {webMode ? (
            <div
              className="fx-split-col"
              style={{ display: 'flex', flexDirection: 'column', padding: '16px', gap: '12px', minHeight: '260px', boxSizing: 'border-box' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Share Files with Browser</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                Add files below to make them instantly downloadable on the browser page.
              </div>

              <div
                style={{
                  border: '2px dashed var(--border-color)',
                  borderRadius: '8px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  background: 'var(--input-bg, rgba(0,0,0,0.01))',
                  flex: 1,
                  minHeight: '100px',
                }}
              >
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

              {pickedFiles.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#2ecc71', fontWeight: 500 }}>
                    ✓ {pickedFiles.length} file(s) available on browser page:
                  </div>
                  <div style={{ maxHeight: '80px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px', background: 'var(--input-bg)' }}>
                    {pickedFiles.map((f) => (
                      <div key={f.localPath} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', padding: '2px 0' }}>
                        <span style={{ overflowWrap: 'anywhere' }}>{f.relPath}</span>
                        <button
                          onClick={() => removeStagedFile(f.localPath)}
                          style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '11px', padding: '0 4px' }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div
              className="fx-split-col"
              style={{ display: 'flex', flexDirection: 'column', padding: '16px', gap: '12px', minHeight: '260px', boxSizing: 'border-box' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <div style={{ fontWeight: 600, color: 'var(--text-color)', fontSize: '14px' }}>Connect to Peer</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.4' }}>
                Enter the peer's IP address or scan their QR code to establish a file transfer connection.
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
              <PrimaryButton onClick={connectPortal} disabled={!joinIpInput} style={{ marginTop: 'auto' }}>
                Connect
              </PrimaryButton>
            </div>
          )}
        </div>
        </div>
      )}

      <PendingGuestsModal
        guests={pendingGuests}
        title="File Portal Request"
        iconType="portal"
        subtitle="wants to connect for file transfer"
        onAccept={(connId) => acceptGuest(connId)}
        onReject={(connId) => {
          linkApi.rejectPortalGuest?.(connId);
          setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
        }}
        onBlock={(connId) => {
          linkApi.blockPortalGuest?.(connId);
          setPendingGuests((prev) => prev.filter((g) => g.connId !== connId));
        }}
      />

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
            {/* Left Column: Your Staged Files */}
            <div
              className="fx-split-col"
              style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-color)' }}>
                Your Shared Files ({pickedFiles.length})
              </div>

              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                style={{
                  border: '2px dashed var(--border-color)',
                  borderRadius: '8px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  background: 'var(--input-bg, rgba(0,0,0,0.01))',
                  minHeight: '80px',
                }}
              >
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Drag files here or</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => pickFiles('file')}
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                  >
                    Add Files
                  </button>
                  <button
                    onClick={() => pickFiles('directory')}
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                  >
                    Add Folder
                  </button>
                </div>
              </div>

              {pickedFiles.length > 0 && (
                <div style={{ maxHeight: '140px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px', background: 'var(--input-bg)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {pickedFiles.map((f) => (
                    <div key={f.localPath} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11.5px', padding: '2px 4px' }}>
                      <span style={{ overflowWrap: 'anywhere', marginRight: '6px' }}>{f.relPath}</span>
                      <button
                        onClick={() => removeStagedFile(f.localPath)}
                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '11px', padding: '0 4px' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {senderPhase === 'sending' && currentFile && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--input-bg)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                    Uploading: {currentFile.name}
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
            </div>

            <div className="fx-split-divider" />

            {/* Right Column: Available From Peer */}
            <div className="fx-split-col" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-color)' }}>
                  Available from Peer ({peerFiles.length})
                </div>
                {peerFiles.length > 1 && (
                  <button
                    onClick={downloadAll}
                    style={{ background: 'none', border: 'none', color: 'var(--accent-color)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Download All
                  </button>
                )}
              </div>

              {incoming && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--input-bg)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, overflowWrap: 'anywhere' }}>Downloading: {incoming.name}</div>
                  <div style={{ width: '100%', height: '6px', background: 'rgba(0,0,0,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: `${incoming.size > 0 ? (incoming.received / incoming.size) * 100 : 0}%`, height: '100%', background: 'var(--accent-color, #007acc)' }} />
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {formatBytes(incoming.received)} / {formatBytes(incoming.size)}{getReceiveSpeed()}
                  </div>
                </div>
              )}

              {peerFiles.length === 0 ? (
                <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', background: 'var(--input-bg)' }}>
                  Peer has not added any files yet.
                </div>
              ) : (
                <div style={{ maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {peerFiles.map((file) => {
                    const isDownloadingThis = downloadingFileId === file.id || (incoming && incoming.name === file.name);
                    return (
                      <div
                        key={file.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: 'var(--input-bg)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '8px',
                          padding: '8px 12px',
                          gap: '8px',
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: '12px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {file.name}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            {formatBytes(file.size)}
                          </div>
                        </div>
                        <button
                          onClick={() => requestDownload(file.id)}
                          disabled={!!isDownloadingThis}
                          style={{
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '11.5px',
                            fontWeight: 600,
                            background: 'var(--accent-color, #007acc)',
                            color: '#fff',
                            border: 'none',
                            cursor: isDownloadingThis ? 'default' : 'pointer',
                            opacity: isDownloadingThis ? 0.6 : 1,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {isDownloadingThis ? 'Downloading...' : 'Download'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {receivedPaths.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#2ecc71' }}>Downloaded Files:</div>
                  <div style={{ maxHeight: '80px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '3px', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px', background: 'var(--input-bg)' }}>
                    {receivedPaths.map((p, idx) => (
                      <div key={`${p}-${idx}`} style={{ fontSize: '11px', color: 'var(--text-color)', overflowWrap: 'anywhere' }}>
                        ✓ {p.split(/[\\/]/).pop()}
                      </div>
                    ))}
                  </div>
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
