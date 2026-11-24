// Self-signed P-256 X.509 certificate in pure Node (no openssl needed on the user's PC).
// Used by the phone listener; phones accept it once, and the desktop shows its SHA-256 fingerprint.
import crypto from 'node:crypto';

const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, ...parts) => { const b = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(b.length), b]); };
const seq = (...p) => tlv(0x30, ...p);
const oid = (s) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a + b];
  for (let n of rest) { const st = [n & 127]; while ((n >>= 7)) st.unshift((n & 127) | 128); out.push(...st); }
  return tlv(0x06, Buffer.from(out));
};
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utcTime = (d) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`)); // valid until 2049
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export function selfSignedCert({ cn = 'StocksWorks', ips = [], days = 397 } = {}) { // <= 398 days: Apple's limit
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
  const now = Date.now();
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x40; // positive, and minimal DER (no leading 0x00)
  const ext = (id, critical, value) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
  // A server leaf (no CA bit): trusting it can never let it vouch for other sites. keyUsage digitalSignature + EKU serverAuth.
  const exts = [ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1')))];
  const v4 = ips.filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
  if (v4.length) exts.push(ext('2.5.29.17', false, seq(...v4.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))))));
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), int(serial), ECDSA_SHA256, name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + days * 86_400_000))), name,
    publicKey.export({ type: 'spki', format: 'der' }), tlv(0xa3, seq(...exts)),
  );
  const sig = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sig));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
}
