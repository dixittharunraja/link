// Worker process for Experiments 2 and 3. Roles:
//   bulk-send / bulk-recv   : one bulk transfer with a given method (link | mux | raw)
//   inp-send  / inp-recv    : 120 Hz input telemetry (tcp | udp | mux) with concurrent bulk load
const L = require('./linkcore.js');
const tls = require('tls');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { loadCert } = require('./common');

const [role, method, ...args] = process.argv.slice(2);
const CHUNK = 65536;
const now = () => process.hrtime.bigint(); // CLOCK_MONOTONIC, shared by all processes on the host
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// A peer that exits right after its last read resets the connection; that is expected here.
process.on('uncaughtException', (e) => { if (e && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) return; throw e; });
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const A = loadCert(0);
const B = loadCert(1);
const fpOf = (pem) => L.certFingerprint(pem);

// Link Plane 2 sender: identical to speedtest.ts startPayloadUpload (ephemeral one-shot TLS
// server on an OS-assigned port, 64 KiB chunked writes, 'drain' backpressure).
function linkPlaneServer(totalBytes, onListening, continuous = false) {
  const block = crypto.randomBytes(CHUNK);
  const server = tls.createServer({ cert: A.cert, key: A.key, rejectUnauthorized: false });
  server.on('secureConnection', (socket) => {
    socket.on('error', () => {});
    let sent = 0;
    const writeNext = () => {
      while (continuous || sent < totalBytes) {
        const n = continuous ? CHUNK : Math.min(CHUNK, totalBytes - sent);
        sent += n;
        if (!socket.write(n === CHUNK ? block : block.subarray(0, n))) { socket.once('drain', writeNext); return; }
      }
      socket.end();
    };
    writeNext();
    socket.on('close', () => { out({ event: 'sender-done', cpuMs: cpuMs() }); server.close(); });
  });
  server.listen(0, '127.0.0.1', () => onListening(server.address().port));
  return server;
}

// Link Plane 2 receiver: identical to speedtest.ts downloadPayload (cert-pinned client).
function linkPlaneClient(port, onDone) {
  let bytes = 0; let t0 = 0n;
  const socket = tls.connect({ host: '127.0.0.1', port, cert: B.cert, key: B.key, rejectUnauthorized: false }, () => {
    const raw = socket.getPeerCertificate().raw;
    if (crypto.createHash('sha256').update(raw).digest('hex') !== fpOf(A.cert)) { socket.destroy(); throw new Error('pin mismatch'); }
    t0 = now();
  });
  socket.on('data', (c) => { bytes += c.length; });
  socket.on('end', () => onDone(bytes, Number(now() - t0) / 1e6));
  socket.on('error', () => {});
  return socket;
}

if (role === 'bulk-send') {
  const total = parseInt(args[0], 10);
  if (method === 'link') {
    linkPlaneServer(total, (port) => out({ event: 'port', port }));
  } else if (method === 'raw') {
    const port = parseInt(args[1], 10);
    const block = crypto.randomBytes(CHUNK);
    const s = net.connect(port, '127.0.0.1', () => {
      let sent = 0;
      const w = () => { while (sent < total) { const n = Math.min(CHUNK, total - sent); sent += n; if (!s.write(block.subarray(0, n))) { s.once('drain', w); return; } } s.end(); };
      w();
    });
    s.on('close', () => { out({ event: 'sender-done', cpuMs: cpuMs() }); });
  } else if (method === 'mux') {
    // Baseline: bulk bytes carried inside the persistent control channel as Base64 JSON packets,
    // framed with Link's own serializePacket (newline-delimited JSON).
    const port = parseInt(args[1], 10);
    const block = crypto.randomBytes(CHUNK);
    const s = tls.connect({ host: '127.0.0.1', port, cert: A.cert, key: A.key, rejectUnauthorized: false }, () => {
      let sent = 0; let seq = 0;
      const w = () => {
        while (sent < total) {
          const n = Math.min(CHUNK, total - sent); sent += n;
          const pkt = L.serializePacket(L.createPacket('link.share.chunk', { seq: seq++, data: block.subarray(0, n).toString('base64') }));
          if (!s.write(pkt)) { s.once('drain', w); return; }
        }
        s.end(L.serializePacket(L.createPacket('link.share.end', {})));
      };
      w();
    });
    s.on('close', () => { out({ event: 'sender-done', cpuMs: cpuMs() }); });
  }
}

if (role === 'bulk-recv') {
  if (method === 'link') {
    linkPlaneClient(parseInt(args[0], 10), (bytes, ms) => { out({ event: 'recv-done', bytes, ms, cpuMs: cpuMs() }); process.exit(0); });
  } else if (method === 'raw') {
    const srv = net.createServer((s) => {
      let bytes = 0; const t0 = now();
      s.on('data', (c) => { bytes += c.length; });
      s.on('end', () => { out({ event: 'recv-done', bytes, ms: Number(now() - t0) / 1e6, cpuMs: cpuMs() }); process.exit(0); });
    });
    srv.listen(0, '127.0.0.1', () => out({ event: 'port', port: srv.address().port }));
  } else if (method === 'mux') {
    const srv = tls.createServer({ cert: B.cert, key: B.key, requestCert: true, rejectUnauthorized: false }, (s) => {
      const reader = new L.PacketStreamReader();
      let bytes = 0; const t0 = now();
      s.on('data', (c) => {
        for (const p of reader.push(c)) {
          if (p.type === 'link.share.chunk') bytes += Buffer.from(p.body.data, 'base64').length;
          else if (p.type === 'link.share.end') { out({ event: 'recv-done', bytes, ms: Number(now() - t0) / 1e6, cpuMs: cpuMs() }); process.exit(0); }
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => out({ event: 'port', port: srv.address().port }));
  }
}

// ---------------- Input telemetry under concurrent bulk load ----------------
if (role === 'inp-recv') {
  // Listens for input on TCP (control TLS) and UDP simultaneously; reports one-way latencies.
  const lat = [];
  let bulkBytes = 0;
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m) => {
    const parts = m.toString('utf8').split(' ');
    if (parts[0] === 'move') lat.push(Number(now() - BigInt(parts[3])) / 1e6);
  });
  udp.bind(0, '127.0.0.1', () => {
    const srv = tls.createServer({ cert: B.cert, key: B.key, requestCert: true, rejectUnauthorized: false }, (s) => {
      s.setNoDelay(true);
      const reader = new L.PacketStreamReader();
      s.on('data', (c) => {
        for (const p of reader.push(c)) {
          if (p.type === 'link.mousepad.request') lat.push(Number(now() - BigInt(p.body.t)) / 1e6);
          else if (p.type === 'link.share.chunk') bulkBytes += Buffer.from(p.body.data, 'base64').length;
        }
      });
      s.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => out({ event: 'ports', tcp: srv.address().port, udp: udp.address().port }));
  });
  process.on('message', (msg) => {
    if (msg === 'report') { process.send({ lat, bulkBytes }); }
  });
}

if (role === 'inp-send') {
  // method: tcp | udp | mux ; args: tcpPort udpPort bulkPort(or 0) durationMs hz
  const [tcpPort, udpPort, bulkPort, durationMs, hz] = args.map((x) => parseInt(x, 10));
  let sentEvents = 0;
  const udp = dgram.createSocket('udp4');
  const ctl = tls.connect({ host: '127.0.0.1', port: tcpPort, cert: A.cert, key: A.key, rejectUnauthorized: false }, () => {
    ctl.setNoDelay(true);
    let muxBulk = null;
    if (method === 'mux') {
      // Naive single-channel design: Base64 bulk chunks interleaved on the SAME control stream.
      const block = crypto.randomBytes(CHUNK).toString('base64');
      let seq = 0; let stop = false;
      const w = () => { while (!stop) { if (!ctl.write(L.serializePacket(L.createPacket('link.share.chunk', { seq: seq++, data: block })))) { ctl.once('drain', w); return; } } };
      w();
      muxBulk = () => { stop = true; };
    }
    const period = 1000 / hz;
    const start = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - start > durationMs) {
        clearInterval(tick);
        if (muxBulk) muxBulk();
        setTimeout(() => { out({ event: 'inp-done', sentEvents }); process.exit(0); }, 1500);
        return;
      }
      const t = now().toString();
      sentEvents++;
      if (method === 'udp') {
        udp.send(Buffer.from(`move 3 -2 ${t}`), udpPort, '127.0.0.1');
      } else {
        ctl.write(L.serializePacket(L.createPacket('link.mousepad.request', { dx: 3, dy: -2, t })));
      }
    }, period);
  });
  ctl.on('error', () => {});
}

// Continuous Plane-2 bulk load generator (runs until killed), used as background traffic.
if (role === 'bg-send') {
  linkPlaneServer(0, (port) => out({ event: 'port', port }), true);
}
if (role === 'bg-recv') {
  let bytes = 0; const t0 = now();
  const s = tls.connect({ host: '127.0.0.1', port: parseInt(args[0], 10), cert: B.cert, key: B.key, rejectUnauthorized: false });
  s.on('data', (c) => { bytes += c.length; });
  s.on('error', () => {});
  process.on('message', (m) => { if (m === 'report') process.send({ bytes, ms: Number(now() - t0) / 1e6 }); });
}
