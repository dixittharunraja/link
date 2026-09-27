// Harness-side emulation of the "trusted-sender" rule required by the protocol (Algorithm 1):
// pool.sync / pool.remove are processed only when they arrive over a connection whose peer is
// already trusted. Implemented by filtering the PeerConnection 'packet' events that
// DeviceManager.attach() subscribes to, so the unmodified DeviceManager logic runs unchanged.
function applyTrustedSenderRule(L) {
  const proto = L.DeviceManager.prototype;
  if (proto.__trustedSenderRule) return;
  const origAttach = proto.attach;
  proto.attach = function (conn) {
    const dm = this;
    const origEmit = conn.emit.bind(conn);
    conn.emit = function (ev, ...args) {
      if (ev === 'packet') {
        const t = args[0] && args[0].type;
        if (t === 'link.pool.sync' || t === 'link.pool.remove') {
          const entry = [...dm.peers.entries()].find(([, p]) => p.conn === conn);
          if (!entry || !entry[1].trusted) return false;
        }
      }
      return origEmit(ev, ...args);
    };
    return origAttach.call(this, conn);
  };
  proto.__trustedSenderRule = true;
}
module.exports = { applyTrustedSenderRule };
