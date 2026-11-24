import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashPassword, verifyPassword, totp, verifyTotp, rateLimiter,
  verifyWebhook, createAuditLog, verifyAuditChain, Sessions, totpReplayGuard, createConfirmer,
} from '../lib/security.js';

test('password hash round-trips and rejects wrong password', () => {
  const h = hashPassword('correct horse battery staple');
  assert.match(h, /^scrypt\$/);
  assert.equal(verifyPassword('correct horse battery staple', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('TOTP matches RFC 6238 SHA1 vector', () => {
  // secret "12345678901234567890" in base32
  const s = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(s, 59_000, 30, 8), '94287082');
  assert.equal(totp(s, 1111111109_000, 30, 8), '07081804');
  assert.equal(verifyTotp(s, totp(s, 1_000_000_000), 1_000_000_000), true);
  assert.equal(verifyTotp(s, '000000', 59_000), false);
});

test('TOTP codes cannot be replayed', () => {
  const s = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const guard = totpReplayGuard();
  const t = 1_000_000_000;
  const code = totp(s, t);
  assert.equal(guard(s, code, t), true);
  assert.equal(guard(s, code, t + 5_000), false, 'same code again');
  assert.equal(guard(s, totp(s, t - 30_000), t + 5_000), false, 'older step after a newer one');
  assert.equal(guard(s, totp(s, t + 30_000), t + 30_000), true, 'next step works');
});

test('sessions sweep removes expired entries', () => {
  const s = new Sessions(1000);
  s.create(0); s.create(0);
  const live = s.create(5000);
  assert.equal(s.sweep(3000), 2);
  assert.ok(s.get(live.token, 3000));
});

test('order confirmation tokens bind to the exact order, expire, and are single-use', () => {
  const c = createConfirmer(crypto.randomBytes(32));
  const order = { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: '1' };
  const tok = c.issue(order, 0);
  assert.equal(c.redeem(tok, { ...order, qty: '2' }, 10), false, 'different order');
  assert.equal(c.redeem(tok, order, 10 * 60_000), false, 'expired');
  const tok2 = c.issue(order, 0);
  assert.equal(c.redeem(tok2, order, 10), true);
  assert.equal(c.redeem(tok2, order, 20), false, 'single use');
  assert.equal(c.redeem('garbage', order, 10), false);
});

test('rate limiter blocks after max hits in window', () => {
  const hit = rateLimiter(3, 60_000);
  assert.deepEqual([hit('a'), hit('a'), hit('a'), hit('a'), hit('b')], [true, true, true, false, true]);
});

test('rate limiter can check without counting, and never flushes live keys', () => {
  const hit = rateLimiter(2, 1000);
  assert.equal(hit.blocked('k', 0), false);
  hit('k', 0); hit('k', 0); hit('k', 0);
  assert.equal(hit.blocked('k', 10), true);
  for (let i = 0; i < 10_050; i++) hit(`flood${i}`, 500);
  assert.equal(hit.blocked('k', 600), true, 'flood must not clear an active lockout');
  assert.equal(hit.blocked('k', 2000), false, 'window expiry still works');
});

test('sessions expire and csrf token is bound to the session', () => {
  const s = new Sessions(1000);
  const { token, csrf } = s.create(0);
  assert.equal(s.get(token, 500).csrf, csrf);
  assert.equal(s.get(token, 5000), null);
  assert.equal(s.get('nope', 0), null);
});

test('webhook: body secret, HMAC signature, replay window', () => {
  const secret = 'whsec_test_1234567890';
  const body = JSON.stringify({ secret, symbol: 'AAPL' });
  assert.equal(verifyWebhook({ raw: body, json: JSON.parse(body), headers: {}, secret }).ok, true);
  assert.equal(verifyWebhook({ raw: '{}', json: { secret: 'bad' }, headers: {}, secret }).ok, false);
  assert.equal(verifyWebhook({ raw: '{}', json: {}, headers: {}, secret: '' }).ok, false, 'no secret configured = deny');

  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const raw = '{"symbol":"AAPL"}';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  assert.equal(verifyWebhook({ raw, json: {}, headers: { 'x-signature': sig, 'x-timestamp': ts }, secret, now }).ok, true);
  assert.equal(verifyWebhook({ raw: raw + ' ', json: {}, headers: { 'x-signature': sig, 'x-timestamp': ts }, secret, now }).ok, false, 'tampered');
  assert.equal(verifyWebhook({ raw, json: {}, headers: { 'x-signature': sig, 'x-timestamp': ts }, secret, now: now + 10 * 60_000 }).ok, false, 'replay');
});

test('audit log is a tamper-evident hash chain', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'audit.jsonl');
  const log = createAuditLog(file);
  log.write({ type: 'a' });
  log.write({ type: 'b' });
  createAuditLog(file).write({ type: 'c' }); // reopen continues the chain
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(verifyAuditChain(lines), true);
  const forged = lines.slice();
  forged[1] = forged[1].replace('"b"', '"x"');
  assert.equal(verifyAuditChain(forged), false);
  assert.equal(verifyAuditChain([lines[0], lines[2]]), false, 'deleted line detected');
});
