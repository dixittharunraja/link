// Pre-generates persistent device identities (RSA-2048 self-signed, exactly as Link does) once,
// so that benchmark trials do not pay the certificate-generation cost.
const L = require('./linkcore.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COUNT = parseInt(process.argv[2] || '17', 10);
const root = path.join(__dirname, 'certs');
for (let i = 0; i < COUNT; i++) {
  const dir = path.join(root, String(i));
  const idFile = path.join(dir, 'identity.json');
  if (fs.existsSync(idFile)) continue;
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(16).toString('hex');
  L.loadOrCreateTlsIdentity(dir, id);
  fs.writeFileSync(idFile, JSON.stringify({ deviceId: id }));
  process.stdout.write(`generated identity ${i}\n`);
}
