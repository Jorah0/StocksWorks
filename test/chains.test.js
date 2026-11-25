import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS, validAddress, blockchairBalance, erc20BalanceData, chainList } from '../lib/chains.js';
import { deriveAddresses, slip10Ed25519 } from '../lib/walletkit.js';
import { validateWorkload, buildArgs, parseHashrate, KINDS } from '../lib/workloads.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hex = (b) => Buffer.from(b).toString('hex');

test('chains: every family is covered and listed for the UI', () => {
  for (const id of ['btc', 'eth', 'ltc', 'doge', 'bch', 'dash', 'zec', 'sol', 'polygon', 'bsc', 'arbitrum', 'optimism', 'base', 'avax']) assert.ok(CHAINS[id], id);
  const l = chainList();
  assert.ok(l.every((c) => c.id && c.label && c.symbol && c.family));
  assert.equal(l.find((c) => c.id === 'base').tokens, true); // EVM chains accept ERC-20 tokens
  assert.equal(l.find((c) => c.id === 'btc').tokens, false);
});

test('chains: address formats per chain', () => {
  assert.equal(validAddress('btc', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'), true);
  assert.equal(validAddress('ltc', 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'), true);
  assert.equal(validAddress('doge', 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'), true);
  assert.equal(validAddress('doge', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'), false);
  assert.equal(validAddress('bch', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), true);
  assert.equal(validAddress('sol', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'), true);
  assert.equal(validAddress('sol', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'), false);
  // every EVM chain shares the checksummed 0x address
  for (const c of ['eth', 'polygon', 'bsc', 'arbitrum', 'optimism', 'base', 'avax']) assert.equal(validAddress(c, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'), true, c);
  assert.equal(validAddress('base', '0x9858efFD232B4033E47d90003D41EC34EcaEda94'), false); // bad checksum
  assert.equal(validAddress('nope', 'x'), false);
});

test('chains: blockchair balance in coins, ERC-20 balanceOf call data', () => {
  const a = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC';
  assert.equal(blockchairBalance({ data: { [a]: { address: { balance: 250000000 } } } }, a), 2.5);
  assert.throws(() => blockchairBalance({ data: {} }, a), /balance/i);
  assert.equal(erc20BalanceData('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'),
    '0x70a08231' + '0'.repeat(24) + '9858effd232b4033e47d90003d41ec34ecaeda94');
});

test('walletkit: SLIP-10 ed25519 spec vector 1', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(hex(slip10Ed25519(seed, [])), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(hex(slip10Ed25519(seed, [0])), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
});

test('walletkit: one phrase -> LTC, DOGE and Solana addresses (reference wallets)', () => {
  const a = deriveAddresses(ABANDON);
  assert.equal(a.ltc, 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh'); // m/84'/2'/0'/0/0
  assert.equal(a.doge, 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'); // m/44'/3'/0'/0/0
  assert.equal(a.sol, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // m/44'/501'/0'/0' (Phantom/Solflare)
  assert.equal(a.eth, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'); // unchanged
});

const POOL = { pool: 'stratum+ssl://pool.example.com:4444', payout: 'Payout' + 'x'.repeat(30), worker: 'desk' };

test('miners: XMRig algorithm, lolMiner and SRBMiner arguments', () => {
  const x = buildArgs(validateWorkload({ kind: 'xmrig-cpu', ...POOL, algo: 'gr' }).workload, 18000);
  assert.deepEqual(x.slice(-2), ['--algo', 'gr']);
  const def = buildArgs(validateWorkload({ kind: 'xmrig-cpu', ...POOL }).workload, 18000);
  assert.equal(def.includes('--algo'), false, 'default rx/0 adds nothing (existing setups unchanged)');
  assert.equal(validateWorkload({ kind: 'xmrig-cpu', ...POOL, algo: 'evil;rm' }).ok, false);

  const lol = validateWorkload({ kind: 'lolminer', ...POOL, algo: 'ETCHASH' });
  assert.equal(lol.ok, true, lol.errors.join());
  assert.deepEqual(buildArgs(lol.workload, 18001), ['--algo', 'ETCHASH', '--pool', 'pool.example.com:4444', '--user', `${POOL.payout}.desk`, '--pass', 'x', '--tls', 'on', '--apihost', '127.0.0.1', '--apiport', '18001']);
  assert.equal(KINDS.lolminer.category, 'mine');

  const srb = validateWorkload({ kind: 'srbminer', ...POOL, pool: 'stratum+tcp://pool.example.com:3333', algo: 'randomx', device: 'cpu' });
  assert.equal(srb.ok, true, srb.errors.join());
  assert.deepEqual(buildArgs(srb.workload, 18002), ['--algorithm', 'randomx', '--pool', 'pool.example.com:3333', '--wallet', POOL.payout, '--password', 'x', '--worker', 'desk', '--tls', 'false', '--api-enable', '--api-port', '18002', '--disable-gpu']);
  assert.equal(validateWorkload({ kind: 'srbminer', ...POOL, algo: 'randomx', device: 'tpu' }).ok, false);
});

test('miners: hashrate from each miner API', () => {
  assert.equal(parseHashrate('xmrig-cpu', { hashrate: { total: [1234.5] } }), 1234.5);
  assert.equal(parseHashrate('lolminer', { Algorithms: [{ Total_Performance: 31.5, Performance_Unit: 'Mh/s' }] }), 31.5e6);
  assert.equal(parseHashrate('srbminer', { algorithms: [{ hashrate: { now: 900 } }] }), 900);
  assert.equal(parseHashrate('lolminer', {}), null);
  assert.equal(parseHashrate('srbminer', { algorithms: [{ hashrate: {} }] }), null, 'unknown shape is unknown, not 0 H/s');
  assert.equal(parseHashrate('srbminer', { algorithms: [{ hashrate: { cpu: { total: 5 }, gpu: { total: 7 } } }] }), 12);
});
