// Experiment 4: per-operation cost of the security primitives on the hot paths.
const L = require('./linkcore.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { loadCert, summarize } = require('./common');
console.log = () => {}; console.error = () => {};
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

function bench(fn, iters) {
  for (let i = 0; i < Math.min(200, iters); i++) fn();
  const samples = [];
  for (let r = 0; r < 15; r++) {
    const t = performance.now();
    for (let i = 0; i < iters; i++) fn();
    samples.push(((performance.now() - t) * 1000) / iters); // microseconds per op
  }
  return summarize(samples);
}

const res = { poolHash: {}, other: {} };
const certs = [...Array(17).keys()].map(loadCert);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkmicro-'));
for (const n of [2, 4, 8, 16, 32, 64]) {
  const dir = fs.mkdtempSync(path.join(tmp, 'p'));
  const ts = new L.TrustStore(dir);
  for (let i = 0; i < n; i++) {
    const c = certs[i % certs.length];
    ts.pair({ deviceId: crypto.randomBytes(16).toString('hex'), deviceName: 'd' + i, certPem: c.cert, protocolVersion: 1, pairedAt: 0 });
  }
  res.poolHash[n] = bench(() => ts.computePoolHash(), 200);
  log(`poolHash N=${n}: ${res.poolHash[n].p50.toFixed(1)} us`);
}
const kA = L.extractPublicKeyDer(certs[0].cert);
const kB = L.extractPublicKeyDer(certs[1].cert);
res.other.sas = bench(() => L.computeVerificationCode(kA, kB, '1789000000'), 5000);
res.other.fingerprint = bench(() => L.certFingerprint(certs[0].cert), 5000);

// Audio plane: AES-256-GCM seal/open of one 10 ms frame (Opus ~160 B at 128 kb/s; PCM slice 1280 B).
const key = crypto.randomBytes(32);
for (const [name, size] of [['gcmOpus160', 160], ['gcmPcm1280', 1280]]) {
  const pt = crypto.randomBytes(size);
  res.other[name] = bench(() => {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    const tag = c.getAuthTag();
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    Buffer.concat([d.update(ct), d.final()]);
  }, 5000);
}
try {
  const { Encoder, Decoder } = require(path.join(__dirname, '..', '..', 'desktop', 'node_modules', '@evan', 'opus'));
  const enc = new Encoder({ channels: 2, sample_rate: 48000, application: 'restricted_lowdelay' });
  const dec = new Decoder({ channels: 2, sample_rate: 48000 });
  const pcm = Buffer.alloc(480 * 2 * 2);
  for (let i = 0; i < 480 * 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 7)), i * 2);
  let size = 0;
  res.other.opusEncDec10ms = bench(() => { const e = enc.encode(pcm); size = e.length; dec.decode(e); }, 1000);
  res.other.opusFrameBytes = size;
} catch (e) { res.other.opusError = String(e.message); }
for (const k of Object.keys(res.other)) if (typeof res.other[k] === 'object') log(`${k}: p50 ${res.other[k].p50.toFixed(2)} us`); else log(`${k}: ${res.other[k]}`);
res.env = { node: process.version, cpu: os.cpus()[0].model, cores: os.cpus().length, memGiB: (os.totalmem() / 2 ** 30).toFixed(1), kernel: os.release() };
log(JSON.stringify(res.env));
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'micro.json'), JSON.stringify(res, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
