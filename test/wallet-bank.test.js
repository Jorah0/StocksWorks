import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newMnemonic, isValidMnemonic, deriveAddresses, PATHS } from '../lib/walletkit.js';
import { createSealer } from '../lib/security.js';
import { createPlaid } from '../lib/plaid.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('wallet: BIP-39/32/44/84 reference vectors (MetaMask + BIP-84 test vector)', () => {
  const a = deriveAddresses(ABANDON);
  assert.equal(a.eth, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'); // m/44'/60'/0'/0/0
  assert.equal(a.btc, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'); // BIP-84 spec vector m/84'/0'/0'/0/0
  assert.deepEqual(a.paths, PATHS);
  assert.notEqual(deriveAddresses(ABANDON, 'TREZOR').eth, a.eth, 'BIP-39 passphrase changes the wallet');
});

test('wallet: fresh 24-word phrases are valid, unique, and checksummed', () => {
  const m1 = newMnemonic(), m2 = newMnemonic();
  assert.equal(m1.split(' ').length, 24);
  assert.notEqual(m1, m2);
  assert.equal(isValidMnemonic(m1), true);
  assert.equal(isValidMnemonic(`  ${m1.toUpperCase()}  `), true, 'normalizes case/spacing');
  const words = m1.split(' ');
  words[23] = words[23] === 'abandon' ? 'ability' : 'abandon'; // break the checksum word
  assert.equal(isValidMnemonic(words.join(' ')), false);
  assert.throws(() => deriveAddresses('not a real phrase'));
});

test('sealer: AES-256-GCM round trip, tamper detection, key required', () => {
  const s = createSealer(crypto.randomBytes(32).toString('base64url'));
  const box = s.seal('access-sandbox-123');
  assert.doesNotMatch(box, /access-sandbox/);
  assert.equal(s.open(box), 'access-sandbox-123');
  assert.notEqual(s.seal('x'), s.seal('x'), 'random IV');
  const parts = box.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => s.open(parts.join('.')));
  assert.throws(() => createSealer('short'));
  assert.throws(() => createSealer(crypto.randomBytes(32).toString('base64url')).open(box), 'wrong key');
});

test('plaid client: request shape, products per link kind, errors surfaced without secrets', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/item/remove')) return new Response(JSON.stringify({ error_message: 'item not found', error_code: 'ITEM_NOT_FOUND' }), { status: 400 });
    return new Response(JSON.stringify({ link_token: 'link-sandbox-x' }), { status: 200 });
  };
  const p = createPlaid({ clientId: 'cid', secret: 'sek', env: 'sandbox', fetchImpl: fakeFetch });
  assert.equal(p.configured, true);
  await p.linkToken('bank', 'u1');
  await p.linkToken('brokerage', 'u1');
  assert.equal(calls[0].url, 'https://sandbox.plaid.com/link/token/create');
  assert.deepEqual(calls[0].body.products, ['auth']);
  assert.deepEqual(calls[1].body.products, ['investments']);
  assert.equal(calls[0].body.client_id, 'cid');
  await assert.rejects(p.remove('tok'), (e) => /item not found/.test(e.message) && !/sek/.test(e.message));
  assert.throws(() => createPlaid({ clientId: 'a', secret: 'b', env: 'nope' }));
  assert.equal(createPlaid({}).configured, false);
});
