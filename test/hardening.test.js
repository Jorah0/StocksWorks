import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totpReplayGuard, totp, base32Encode, parseJsonObject } from '../lib/security.js';
import { childSafeEnv } from '../lib/supervisor.js';

const SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('order TOTP guard locks out after 5 wrong codes (no brute force of a 6-digit code)', () => {
  let now = Date.UTC(2026, 10, 25, 12);
  const guard = totpReplayGuard({ maxFails: 5, lockMs: 15 * 60_000 });
  for (let i = 0; i < 5; i++) assert.equal(guard(SECRET, '000000', now), false);
  const good = totp(SECRET, now);
  assert.equal(guard(SECRET, good, now), false, 'locked: even the right code is refused');
  now += 16 * 60_000;
  assert.equal(guard(SECRET, totp(SECRET, now), now), true, 'lock expires');
});

test('a correct code resets the failure count', () => {
  let now = Date.UTC(2026, 10, 25, 12);
  const guard = totpReplayGuard({ maxFails: 5, lockMs: 15 * 60_000 });
  for (let i = 0; i < 4; i++) guard(SECRET, '000000', now);
  assert.equal(guard(SECRET, totp(SECRET, now), now), true);
  now += 30_000;
  for (let i = 0; i < 4; i++) guard(SECRET, '000000', now);
  assert.equal(guard(SECRET, totp(SECRET, now), now), true, 'still under the limit after the reset');
});

test('miner/compute programs get an allowlisted environment: no app secrets', () => {
  const env = childSafeEnv({ PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', CUDA_VISIBLE_DEVICES: '0', GPU_MAX_HEAP_SIZE: '100',
    ALPACA_SECRET_KEY: 'x', TOTP_SECRET: 'x', BANK_ENCRYPTION_KEY: 'x', APP_PASSWORD_HASH: 'x', ANTHROPIC_API_KEY: 'x', NOTIFY_WEBHOOK_URL: 'https://hook', STOCKSWORKS_DATA: 'd', RANDOM_THING: 'y' });
  assert.deepEqual(Object.keys(env).sort(), ['CUDA_VISIBLE_DEVICES', 'GPU_MAX_HEAP_SIZE', 'PATH', 'SystemRoot', 'TEMP']);
});

test('Ollama host URLs: metadata endpoints are refused in every spelling; LAN hosts still work', async () => {
  const { validHostUrl } = await import('../lib/ollama.js');
  for (const bad of ['http://169.254.169.254:80', 'http://[::ffff:169.254.169.254]:80', 'http://[::ffff:a9fe:a9fe]', 'http://metadata.google.internal', 'http://0.0.0.0:11434'])
    assert.equal(validHostUrl(bad), null, bad);
  assert.equal(validHostUrl('http://192.168.1.30:11434'), 'http://192.168.1.30:11434');
});

test('request bodies must be JSON objects (null, arrays and numbers are a 400, not a 500)', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject(''), {});
  for (const bad of ['null', '[1,2]', '42', '"x"', '{bad']) assert.throws(() => parseJsonObject(bad), (e) => e.status === 400, bad);
});
