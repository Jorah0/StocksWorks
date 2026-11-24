import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import { selfSignedCert } from '../lib/selfcert.js';

test('selfcert: valid self-signed P-256 cert with IP SANs, usable for a real TLS handshake', async () => {
  const { cert, key, fingerprint } = selfSignedCert({ cn: 'StocksWorks Phone', ips: ['127.0.0.1', '192.168.1.20'], days: 825 });
  const x = new crypto.X509Certificate(cert);
  assert.equal(x.subject, 'CN=StocksWorks Phone');
  assert.equal(x.verify(x.publicKey), true, 'signature checks out against its own key');
  assert.match(x.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.match(x.subjectAltName, /IP Address:192\.168\.1\.20/);
  assert.equal(fingerprint, x.fingerprint256);
  assert.ok(new Date(x.validTo) > new Date(Date.now() + 800 * 86_400_000));
  assert.notEqual(selfSignedCert({ cn: 'a', ips: [] }).fingerprint, selfSignedCert({ cn: 'a', ips: [] }).fingerprint, 'fresh key every time');

  assert.equal(x.ca, false, 'a leaf, not a CA: installing it as trusted can never let it vouch for other sites');
  assert.match(x.keyUsage?.join(',') ?? '', /1\.3\.6\.1\.5\.5\.7\.3\.1/, 'EKU serverAuth (iOS requires it)');
  for (let i = 0; i < 600; i++) new crypto.X509Certificate(selfSignedCert({ cn: 'x', ips: [] }).cert); // DER serial always minimal (was ~1/256 invalid)

  const srv = https.createServer({ cert, key }, (_q, r) => r.end('ok')).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const body = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: srv.address().port, ca: cert }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(d)); }).on('error', reject);
  });
  srv.close();
  assert.equal(body, 'ok', 'client trusting only this cert completes the handshake (hostname checked via SAN)');
});
