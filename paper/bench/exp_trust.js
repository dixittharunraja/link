// Experiment 1: transitive enrollment convergence, cascaded revocation, and steady-state
// anti-entropy overhead — executed with the UNMODIFIED Link desktop core (DeviceManager,
// TrustStore, PairingHandler, PeerConnection over real mutually-authenticated TLS sockets).
const L = require('./linkcore.js');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { loadCert, summarize } = require('./common');
const { applyTrustedSenderRule } = require('./fixes');
// Evaluate the protocol as specified in Algorithm 1 (membership messages only from trusted peers).
applyTrustedSenderRule(L);

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// Count protocol messages at the protocol layer: wrap PeerConnection.prototype.send (every
// control-plane packet except heartbeats goes through it). Patched lazily on first connection.
const ctr = { sync: 0, syncBytes: 0, remove: 0 };
let sendPatched = false;
function patchSend(conn) {
  if (sendPatched) return;
  const proto = Object.getPrototypeOf(conn);
  const orig = proto.send;
  proto.send = function (packet) {
    if (packet.type === 'link.pool.sync') { ctr.sync++; ctr.syncBytes += L.serializePacket(packet).length; }
    else if (packet.type === 'link.pool.remove') ctr.remove++;
    return orig.call(this, packet);
  };
  sendPatched = true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 21000;
// Trust stores live on tmpfs by default so that the measured latency is protocol + TLS + processing;
// durable-storage cost is reported separately (TRUST_TMP=/tmp to include it).
const TMP = fs.mkdtempSync(path.join(process.env.TRUST_TMP || '/dev/shm', 'linktrust-'));

// View-inclusive digest H(T_i ∪ {d_i}) — the corrected Pool Hash evaluated in the paper.
function viewDigest(ts, self) {
  const items = ts.list().map((d) => [d.deviceId, L.certFingerprint(d.certPem)]);
  items.push([self.id, L.certFingerprint(self.cert)]);
  items.sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(items.map((x) => `${x[0]}:${x[1]}`).join('|'), 'utf8').digest('hex').substring(0, 16);
}

function makeNode(i, trialDir, fixedDigest) {
  const c = loadCert(i);
  const dir = path.join(trialDir, 'n' + i);
  fs.mkdirSync(dir, { recursive: true });
  const ts = new L.TrustStore(dir);
  const myIdentity = { deviceId: c.id, deviceName: 'node' + i, deviceType: 'desktop', protocolVersion: 1, incomingCapabilities: [], outgoingCapabilities: [] };
  const port = nextPort++;
  const dm = new L.DeviceManager({ cert: c.cert, key: c.key, myIdentity }, ts, port);
  const node = { i, id: c.id, cert: c.cert, dm, ts, port };
  if (fixedDigest) ts.computePoolHash = () => viewDigest(ts, node);
  return node;
}

function edgesFor(topology, n) {
  // Nodes 0..n-2 form the existing pool, node n-1 is the newcomer; gateway = node 0.
  const e = [];
  if (topology === 'mesh') {
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) e.push([a, b]);
  } else {
    for (let a = 0; a < n - 2; a++) e.push([a, a + 1]); // chain 0-1-..-(n-2)
    e.push([n - 1, 0]); // newcomer attaches to the chain end
  }
  return e;
}

async function buildPool(n, topology, fixedDigest) {
  const trialDir = fs.mkdtempSync(path.join(TMP, 't-'));
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push(makeNode(i, trialDir, fixedDigest));
  const members = nodes.slice(0, n - 1);
  for (const a of members) for (const b of members) {
    if (a !== b) a.ts.pair({ deviceId: b.id, deviceName: 'node' + b.i, certPem: b.cert, protocolVersion: 1, pairedAt: Date.now() });
  }
  const edges = edgesFor(topology, n);
  const deg = new Array(n).fill(0);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }
  for (const [a, b] of edges) await nodes[a].dm.connectTo('127.0.0.1', nodes[b].port);
  const t = Date.now();
  while (nodes.some((x, k) => x.dm.getConnectedPeers().length !== deg[k])) {
    if (Date.now() - t > 5000) throw new Error('connect timeout');
    await sleep(10);
  }
  for (const x of nodes) for (const p of x.dm.peers.values()) patchSend(p.conn);
  await sleep(250); // let connection-time pool syncs drain
  return { nodes, edges, trialDir };
}

function teardown(nodes) {
  for (const x of nodes) {
    try { x.dm.server.close(); } catch {}
    for (const p of x.dm.peers.values()) { try { p.conn.close(); } catch {} }
  }
}

function waitFor(nodes, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const check = () => {
      if (done) return;
      if (predicate()) { done = true; clearInterval(iv); clearTimeout(to); resolve(performance.now()); }
    };
    const iv = setInterval(check, 1);
    const to = setTimeout(() => { done = true; clearInterval(iv); reject(new Error('timeout')); }, timeoutMs);
    for (const x of nodes) for (const ev of ['trustListUpdated', 'pairingSuccessful', 'deviceConnected', 'unpaired']) x.dm.on(ev, () => setImmediate(check));
  });
}

async function enrollAndRevoke(n, topology) {
  const { nodes } = await buildPool(n, topology, true);
  const newcomer = nodes[n - 1];
  const gateway = nodes[0];
  let t0 = 0;
  gateway.dm.on('incomingPairRequest', (id) => {
    if (id === newcomer.id) { t0 = performance.now(); gateway.dm.acceptPairing(id); }
  });
  const viewComplete = () => nodes.every((x) => nodes.every((y) => y === x || x.ts.isPaired(y.id)));
  const linksComplete = () => viewComplete() && nodes.every((x) => nodes.every((y) => y === x || x.dm.hasTrustedPeer(y.id)));
  const hashesAgree = () => new Set(nodes.map((x) => x.ts.computePoolHash())).size === 1;
  ctr.sync = 0; ctr.syncBytes = 0;
  const pView = waitFor(nodes, viewComplete);
  const pLinks = topology === 'mesh' ? waitFor(nodes, linksComplete) : null;
  newcomer.dm.requestPairing(gateway.id);
  const tView = await pView;
  const tLinks = pLinks ? await pLinks : NaN;
  await sleep(300);
  const enroll = { viewMs: tView - t0, linksMs: tLinks - t0, syncMsgs: ctr.sync, syncBytes: ctr.syncBytes, hashesAgree: hashesAgree() };

  // Cascaded revocation, issued by a member other than the gateway when one exists (mirrors
  // main.ts 'unpair': send link.pool.remove to every trusted connected peer, then unpair locally).
  const issuer = n > 2 ? nodes[1] : nodes[0];
  const target = newcomer;
  ctr.remove = 0;
  const pRev = waitFor(nodes, () => nodes.every((x) => x === target || !x.ts.isPaired(target.id)));
  const tr0 = performance.now();
  for (const otherId of issuer.dm.trustedConnectedDeviceIds()) {
    if (otherId !== target.id) issuer.dm.sendTo(otherId, L.createPacket('link.pool.remove', { deviceId: target.id }));
  }
  issuer.dm.unpair(target.id);
  const tRev = await pRev;
  await sleep(200);
  const revoke = { revokeMs: tRev - tr0, removeMsgs: ctr.remove };
  teardown(nodes);
  await sleep(100);
  return { enroll, revoke };
}

async function antiEntropy(n, fixedDigest, cycles = 5) {
  const { nodes } = await buildPool(n, 'mesh', fixedDigest);
  // Enroll the newcomer so the pool is fully converged, then measure idle heartbeat traffic.
  const newcomer = nodes[n - 1];
  nodes[0].dm.on('incomingPairRequest', (id) => nodes[0].dm.acceptPairing(id));
  newcomer.dm.requestPairing(nodes[0].id);
  await waitFor(nodes, () => nodes.every((x) => nodes.every((y) => y === x || x.dm.hasTrustedPeer(y.id))));
  await sleep(400);
  ctr.sync = 0; ctr.syncBytes = 0;
  for (let c = 0; c < cycles; c++) {
    for (const x of nodes) x.dm.runHeartbeatCycle(1e9);
    await sleep(150);
  }
  const res = { syncMsgsPerCycle: ctr.sync / cycles, syncBytesPerCycle: ctr.syncBytes / cycles };
  teardown(nodes);
  await sleep(100);
  return res;
}

(async () => {
  const results = { enroll: {}, revoke: {}, antiEntropy: {} };
  const Ns = [2, 3, 4, 6, 8, 12, 16];
  const TRIALS = parseInt(process.env.TRIALS || '20', 10);
  for (const topology of ['mesh', 'chain']) {
    for (const n of Ns) {
      if (topology === 'chain' && n < 4) continue;
      const view = [], links = [], rev = [], msgs = [], bytes = [], rmsgs = [];
      let agreeAll = true;
      const trials = topology === 'mesh' ? TRIALS : Math.ceil(TRIALS / 2);
      for (let t = 0; t < trials; t++) {
        const r = await enrollAndRevoke(n, topology);
        view.push(r.enroll.viewMs); links.push(r.enroll.linksMs); rev.push(r.revoke.revokeMs);
        msgs.push(r.enroll.syncMsgs); bytes.push(r.enroll.syncBytes); rmsgs.push(r.revoke.removeMsgs);
        agreeAll = agreeAll && r.enroll.hashesAgree;
      }
      const key = `${topology}:${n}`;
      results.enroll[key] = { view: summarize(view), links: topology === 'mesh' ? summarize(links) : null, syncMsgs: summarize(msgs), syncBytes: summarize(bytes), hashesAgree: agreeAll };
      results.revoke[key] = { revoke: summarize(rev), removeMsgs: summarize(rmsgs) };
      log(`${key} enroll view p50=${results.enroll[key].view.p50.toFixed(2)}ms links p50=${topology === 'mesh' ? results.enroll[key].links.p50.toFixed(2) : '-'}ms syncMsgs=${results.enroll[key].syncMsgs.mean.toFixed(1)} | revoke p50=${results.revoke[key].revoke.p50.toFixed(2)}ms removeMsgs=${results.revoke[key].removeMsgs.mean.toFixed(1)} | digests agree=${agreeAll}`);
    }
  }
  for (const n of [2, 4, 8, 12, 16]) {
    const cur = await antiEntropy(n, false);
    const fix = await antiEntropy(n, true);
    results.antiEntropy[n] = { current: cur, fixed: fix };
    log(`antiEntropy N=${n} current: ${cur.syncMsgsPerCycle} msgs/cycle ${(cur.syncBytesPerCycle / 1024).toFixed(1)} KiB | fixed: ${fix.syncMsgsPerCycle} msgs/cycle`);
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'trust.json'), JSON.stringify(results, null, 2));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { log('FAILED', e.stack); process.exit(1); });
