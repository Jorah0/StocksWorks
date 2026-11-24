import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFleetConfig, buildMinerArgs, Pairing, tokenHash, newRigToken, sanitizeStats, pairingLink, parsePairingLink, DEFAULT_ARGS } from '../lib/fleet.js';

const XMR = '4' + 'A'.repeat(94);
const good = { coin: 'xmr', pool: 'stratum+ssl://pool.supportxmr.com:443', payout: XMR, pass: 'x' };

test('fleet config validation accepts a real pool and rejects injection', () => {
  const v = validateFleetConfig(good);
  assert.equal(v.ok, true, v.errors.join());
  assert.equal(v.config.coin, 'XMR');
  for (const bad of [
    { ...good, pool: 'stratum+tcp://pool.com:3333 --donate-level 0' },
    { ...good, pool: '-o evil:1' },
    { ...good, pool: 'http://pool.com:80' },
    { ...good, payout: '--config=/etc/passwd' + 'a'.repeat(20) },
    { ...good, payout: 'short' },
    { ...good, pass: 'x y' },
  ]) assert.equal(validateFleetConfig(bad).ok, false, JSON.stringify(bad));
});

test('miner args substitute values as single argv entries (no shell, no extra flags)', () => {
  const args = buildMinerArgs(DEFAULT_ARGS, { ...good, worker: 'rig-1', apiPort: 18088 });
  assert.deepEqual(args.slice(0, 6), ['-o', good.pool, '-u', XMR, '-p', 'x']);
  assert.ok(args.includes('rig-1') && args.includes('18088'));
  assert.throws(() => buildMinerArgs(DEFAULT_ARGS, { ...good, worker: 'a b', apiPort: 18088 }));
  assert.throws(() => buildMinerArgs(DEFAULT_ARGS, { ...good, pool: 'x; rm -rf /', worker: 'w', apiPort: 18088 }));
});

test('pairing codes are one-time and expire', () => {
  const p = new Pairing();
  const { code } = p.create(0, 1000);
  assert.equal(p.consume('WRONGCODE', 10), false);
  assert.equal(p.consume(code.toLowerCase().replace(/(.{4})/g, '$1-'), 10), true, 'case/dash tolerant');
  assert.equal(p.consume(code, 20), false, 'single use');
  const b = p.create(0, 1000).code;
  assert.equal(p.consume(b, 5000), false, 'expired');
});

test('rig tokens are stored hashed; stats are sanitized', () => {
  const t = newRigToken();
  assert.equal(tokenHash(t).length, 64);
  assert.notEqual(tokenHash(t), t);
  const s = sanitizeStats({ running: 'yes', hashrate: -5, uptimeSec: 1e30, miner: '<img src=x onerror=alert(1)>', error: 'x'.repeat(500) });
  assert.equal(s.running, false);
  assert.equal(s.hashrate, null);
  assert.ok(s.uptimeSec <= 1e15);
  assert.doesNotMatch(s.miner, /[<>=]/);
  assert.ok(s.error.length <= 120);
});

test('pairing link round-trips and rejects tampering', () => {
  const fp = Array.from({ length: 32 }, () => 'AB').join(':');
  const link = pairingLink({ url: 'https://192.168.1.10:8788', code: 'ABCDEFGHIJKLMNOP', fingerprint: fp });
  assert.deepEqual(parsePairingLink(link), { url: 'https://192.168.1.10:8788', code: 'ABCDEFGHIJKLMNOP', fingerprint: fp });
  assert.throws(() => parsePairingLink(pairingLink({ url: 'http://192.168.1.10:8788', code: 'ABCDEFGHIJKLMNOP', fingerprint: fp })));
  assert.throws(() => parsePairingLink(pairingLink({ url: 'https://h:1', code: 'ABCDEFGHIJKLMNOP', fingerprint: 'nope' })));
  assert.throws(() => parsePairingLink('garbage'));
});
