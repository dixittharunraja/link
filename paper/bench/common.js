const fs = require('fs');
const path = require('path');

function loadCert(i) {
  const dir = path.join(__dirname, 'certs', String(i));
  return {
    id: JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8')).deviceId,
    cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
    key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
  };
}

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
  return { n: s.length, mean, sd, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), min: s[0], max: s[s.length - 1] };
}

module.exports = { loadCert, pct, summarize };
