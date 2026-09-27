// Experiments 2 & 3 orchestrator. MUST run inside `unshare -rn` so that `tc netem` shapes only
// this private loopback. Each endpoint runs in its own Node.js process.
const { spawn, execSync, fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { summarize } = require('./common');

const W = path.join(__dirname, 'dp_worker.js');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function netem(spec) {
  try { execSync('tc qdisc del dev lo root 2>/dev/null'); } catch {}
  if (spec) execSync(`tc qdisc add dev lo root netem ${spec}`);
}

function start(args, ipc = false) {
  const p = ipc ? fork(W, args, { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] }) : spawn(process.execPath, [W, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const events = [];
  const waiters = [];
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    try { const o = JSON.parse(l); events.push(o); waiters.forEach((w) => w()); } catch {}
  });
  p.waitEvent = (name, timeout = 120000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + name)), timeout);
    const chk = () => { const e = events.find((x) => x.event === name); if (e) { clearTimeout(t); res(e); } };
    waiters.push(chk); chk();
  });
  p.ask = () => new Promise((res) => { p.once('message', res); p.send('report'); });
  return p;
}

async function bulkOnce(method, bytes) {
  if (method === 'link') {
    const s = start(['bulk-send', 'link', String(bytes)]);
    const { port } = await s.waitEvent('port');
    const r = start(['bulk-recv', 'link', String(port)]);
    const rd = await r.waitEvent('recv-done');
    const sd = await s.waitEvent('sender-done');
    return { mbps: (rd.bytes * 8) / (rd.ms * 1000), cpuMs: rd.cpuMs + sd.cpuMs, bytes: rd.bytes };
  }
  const r = start(['bulk-recv', method]);
  const { port } = await r.waitEvent('port');
  const s = start(['bulk-send', method, String(bytes), String(port)]);
  const rd = await r.waitEvent('recv-done');
  const sd = await s.waitEvent('sender-done');
  return { mbps: (rd.bytes * 8) / (rd.ms * 1000), cpuMs: rd.cpuMs + sd.cpuMs, bytes: rd.bytes };
}

async function inputRun(method, lossPct, durationMs = 15000) {
  const recv = start(['inp-recv', 'x'], true);
  const ports = await recv.waitEvent('ports');
  let bgS = null, bgR = null;
  if (method !== 'mux') {
    bgS = start(['bg-send', 'x']);
    const { port } = await bgS.waitEvent('port');
    bgR = start(['bg-recv', 'x', String(port)], true);
    await sleep(1000); // let the bulk flow reach steady state
  }
  const snd = start(['inp-send', method, String(ports.tcp), String(ports.udp), '0', String(durationMs), '120']);
  const done = await snd.waitEvent('inp-done', durationMs + 30000);
  const rep = await recv.ask();
  let bulkMbps = NaN;
  if (bgR) { const b = await bgR.ask(); bulkMbps = (b.bytes * 8) / (b.ms * 1000); }
  else bulkMbps = (rep.bulkBytes * 8) / ((durationMs + 1500) * 1000);
  for (const p of [recv, bgS, bgR, snd]) { try { p && p.kill('SIGKILL'); } catch {} }
  await sleep(500);
  return { method, lossPct, sent: done.sentEvents, received: rep.lat.length, delivery: rep.lat.length / done.sentEvents, stats: summarize(rep.lat), lat: rep.lat, bulkMbps };
}

(async () => {
  execSync('ip link set lo up');
  // Ethernet/Wi-Fi-sized framing: without this, loopback's 64 KiB MTU and GSO make every netem
  // "packet" up to 64 KiB, which inflates queue depth and distorts both latency and loss.
  execSync('ip link set dev lo mtu 1500');
  execSync('ip link set dev lo gso_max_size 1500');
  const results = { bulk: {}, input: [] };
  const which = process.argv[2] || 'all';

  if (which === 'all' || which === 'bulk') {
    const conds = [
      { name: 'unshaped', spec: '', bytes: 256 * 1024 * 1024 },
      { name: 'wifi-300', spec: 'delay 2ms 0.5ms rate 300mbit limit 1000', bytes: 64 * 1024 * 1024 },
      { name: 'wifi-100-lossy', spec: 'delay 4ms 1ms loss 0.5% rate 100mbit limit 1000', bytes: 32 * 1024 * 1024 },
    ];
    for (const c of conds) {
      netem(c.spec);
      results.bulk[c.name] = {};
      for (const m of ['raw', 'link', 'mux']) {
        const runs = [];
        for (let k = 0; k < 3; k++) runs.push(await bulkOnce(m, c.bytes));
        const mb = runs.map((r) => r.mbps);
        const cpuPerGiB = runs.map((r) => (r.cpuMs / (r.bytes / 2 ** 30)) / 1000);
        results.bulk[c.name][m] = { mbps: summarize(mb), cpuSecPerGiB: summarize(cpuPerGiB) };
        log(`bulk ${c.name} ${m}: ${summarize(mb).mean.toFixed(1)} Mbps, cpu ${summarize(cpuPerGiB).mean.toFixed(2)} s/GiB`);
      }
    }
  }

  if (which === 'all' || which === 'input') {
    for (const loss of [0, 1, 3]) {
      netem(`delay 2ms 1ms loss ${loss}% rate 200mbit limit 400`);
      for (const m of ['udp', 'tcp', 'mux']) {
        const r = await inputRun(m, loss);
        results.input.push(r);
        log(`input loss=${loss}% ${m}: p50=${r.stats.p50.toFixed(2)} p95=${r.stats.p95.toFixed(2)} p99=${r.stats.p99.toFixed(2)} max=${r.stats.max.toFixed(1)} ms, delivered=${(100 * r.delivery).toFixed(2)}%, bulk=${r.bulkMbps.toFixed(1)} Mbps`);
      }
    }
  }
  netem('');
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const file = path.join(__dirname, 'results', `net-${which}.json`);
  fs.writeFileSync(file, JSON.stringify(results));
  process.exit(0);
})().catch((e) => { log('FAILED', e.stack); process.exit(1); });
