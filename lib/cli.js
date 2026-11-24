// Setup helpers: npm run hash-password -- "<pw>" | npm run new-totp | npm run new-secret
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashPassword, base32Encode } from './security.js';

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'hash-password') {
  if (!arg || arg.length < 12) { console.error('Usage: npm run hash-password -- "<password, 12+ chars>"'); process.exit(1); }
  console.log(`APP_PASSWORD_HASH=${hashPassword(arg)}`);
} else if (cmd === 'new-totp') {
  const secret = base32Encode(crypto.randomBytes(20));
  console.log(`TOTP_SECRET=${secret}`);
  console.log(`Add to your authenticator: otpauth://totp/StocksWorks?secret=${secret}&issuer=StocksWorks`);
} else if (cmd === 'new-secret') {
  console.log(crypto.randomBytes(32).toString('base64url'));
} else if (cmd === 'make-cert') {
  // Self-signed P-256 cert for the rig listener. Rigs pin its SHA-256 fingerprint, so no CA is needed.
  const dir = path.resolve('data/tls');
  fs.mkdirSync(dir, { recursive: true });
  const candidates = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'];
  const bin = candidates.find((b) => spawnSync(b, ['version']).status === 0);
  if (!bin) { console.error('openssl not found. Install Git for Windows (ships openssl) or OpenSSL, then retry.'); process.exit(1); }
  const key = path.join(dir, 'fleet-key.pem'), cert = path.join(dir, 'fleet-cert.pem');
  const r = spawnSync(bin, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '825',
    '-keyout', key, '-out', cert, '-subj', '/CN=StocksWorks Fleet', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
  fs.chmodSync(key, 0o600);
  console.log(`\nFLEET_TLS_CERT=${cert}\nFLEET_TLS_KEY=${key}\nfingerprint: ${new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256}`);
} else {
  console.error('Commands: hash-password <pw> | new-totp | new-secret | make-cert');
  process.exit(1);
}
