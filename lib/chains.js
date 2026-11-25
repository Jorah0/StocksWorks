// Watch-only wallets across chain families: Bitcoin-style UTXO coins, every EVM chain (+ ERC-20 tokens) and Solana.
// Public addresses only, never keys. Address checks verify checksums where the format has one.
import { bech32, bech32m, base58, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ADDRESS_RE, balanceOf as btcEthBalance, HttpError } from './providers.js';
import { isValidEthAddress } from './keccak.js';

const b58c = createBase58check(sha256);
const EVM = (id, label, symbol, rpc, cg, platform) => ({ id, label, symbol, family: 'evm', rpc, cg, platform, decimals: 18 });
const UTXO = (id, label, symbol, blockchair, cg, versions, hrp) => ({ id, label, symbol, family: 'utxo', blockchair, cg, versions, hrp, decimals: 8 });

export const CHAINS = {
  btc: { ...UTXO('btc', 'Bitcoin', 'BTC', null, 'bitcoin'), legacyRe: ADDRESS_RE.btc },
  ltc: UTXO('ltc', 'Litecoin', 'LTC', 'litecoin', 'litecoin', [[0x30], [0x32], [0x05]], 'ltc'),
  doge: UTXO('doge', 'Dogecoin', 'DOGE', 'dogecoin', 'dogecoin', [[0x1e], [0x16]]),
  bch: { ...UTXO('bch', 'Bitcoin Cash', 'BCH', 'bitcoin-cash', 'bitcoin-cash', [[0x00], [0x05]]), cashaddr: /^(bitcoincash:)?[qp][02-9ac-hj-np-z]{41}$/ },
  dash: UTXO('dash', 'Dash', 'DASH', 'dash', 'dash', [[0x4c], [0x10]]),
  zec: UTXO('zec', 'Zcash (transparent)', 'ZEC', 'zcash', 'zcash', [[0x1c, 0xb8], [0x1c, 0xbd]]),
  eth: EVM('eth', 'Ethereum', 'ETH', null, 'ethereum', 'ethereum'),
  polygon: EVM('polygon', 'Polygon', 'POL', 'https://polygon-bor-rpc.publicnode.com', 'polygon-ecosystem-token', 'polygon-pos'),
  bsc: EVM('bsc', 'BNB Smart Chain', 'BNB', 'https://bsc-rpc.publicnode.com', 'binancecoin', 'binance-smart-chain'),
  arbitrum: EVM('arbitrum', 'Arbitrum One', 'ETH', 'https://arbitrum-one-rpc.publicnode.com', 'ethereum', 'arbitrum-one'),
  optimism: EVM('optimism', 'Optimism', 'ETH', 'https://optimism-rpc.publicnode.com', 'ethereum', 'optimistic-ethereum'),
  base: EVM('base', 'Base', 'ETH', 'https://base-rpc.publicnode.com', 'ethereum', 'base'),
  avax: EVM('avax', 'Avalanche C-Chain', 'AVAX', 'https://avalanche-c-chain-rpc.publicnode.com', 'avalanche-2', 'avalanche'),
  sol: { id: 'sol', label: 'Solana', symbol: 'SOL', family: 'sol', rpc: 'https://api.mainnet-beta.solana.com', cg: 'solana', decimals: 9 },
};
// ponytail: Monero can't be watched by address alone (needs a private view key), so it is deliberately absent.

export const chainList = () => Object.values(CHAINS).map(({ id, label, symbol, family }) => ({ id, label, symbol, family, tokens: family === 'evm' }));

function validUtxo(c, a) {
  if (c.legacyRe) return c.legacyRe.test(a);
  if (c.cashaddr?.test(a)) return true;
  if (c.hrp && a.toLowerCase().startsWith(`${c.hrp}1`)) {
    for (const codec of [bech32, bech32m]) { try { if (codec.decode(a.toLowerCase(), 90).prefix === c.hrp) return true; } catch { /* try next */ } }
    return false;
  }
  try {
    const raw = b58c.decode(a);
    return c.versions.some((v) => raw.length === v.length + 20 && v.every((b, i) => raw[i] === b));
  } catch { return false; }
}

export function validAddress(chain, address) {
  const c = Object.hasOwn(CHAINS, chain) ? CHAINS[chain] : null;
  const a = String(address ?? '');
  if (!c || a.length > 120) return false;
  if (c.family === 'evm') return isValidEthAddress(a) && /^0x[0-9a-fA-F]{40}$/.test(a);
  if (c.family === 'sol') { try { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && base58.decode(a).length === 32; } catch { return false; } }
  return validUtxo(c, a);
}

export function blockchairBalance(d, address) {
  const bal = d?.data?.[address]?.address?.balance;
  if (!Number.isFinite(Number(bal))) throw new HttpError(502, 'Blockchair returned no balance for this address');
  return Number(bal) / 1e8;
}

const word = (hex) => hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const erc20BalanceData = (owner) => `0x70a08231${word(owner)}`;

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const d = await r.json().catch(() => null);
  if (!r.ok || d?.error || d?.result === undefined) throw new HttpError(502, d?.error?.message ?? `${new URL(url).host} returned ${r.status}`);
  return d.result;
}
const hexNum = (h) => { if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{0,64}$/.test(h)) throw new HttpError(502, 'Malformed RPC answer'); return h === '0x' ? 0n : BigInt(h); };
/** ABI string return (offset, length, bytes) -> text; symbols only, so short and printable. */
const abiString = (h) => { try { const b = Buffer.from(h.slice(2), 'hex'); const len = Number(b.readBigUInt64BE(56)); return b.subarray(64, 64 + len).toString('utf8').replace(/[^\w.$-]/g, '').slice(0, 12); } catch { return ''; } };

/** Balance in whole coins (or tokens when token.contract is given). */
export async function balanceOf(chain, address, { ethRpc, token } = {}) {
  if (!validAddress(chain, address)) throw new HttpError(400, 'Invalid address for this chain (check for typos)');
  const c = CHAINS[chain];
  if (chain === 'btc' || (chain === 'eth' && !token)) return { amount: await btcEthBalance(chain, address, ethRpc), symbol: c.symbol };
  if (c.family === 'utxo') {
    const r = await fetch(`https://api.blockchair.com/${c.blockchair}/dashboards/address/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (r.status === 402 || r.status === 429 || r.status === 430) throw new HttpError(429, 'Blockchair free limit reached: try again later');
    return { amount: blockchairBalance(await r.json(), address), symbol: c.symbol };
  }
  if (c.family === 'sol') return { amount: Number((await rpc(c.rpc, 'getBalance', [address]))?.value ?? NaN) / 1e9, symbol: 'SOL' };
  const url = chain === 'eth' ? ethRpc : c.rpc;
  if (!token) return { amount: Number(hexNum(await rpc(url, 'eth_getBalance', [address, 'latest']))) / 1e18, symbol: c.symbol };
  const call = (data) => rpc(url, 'eth_call', [{ to: token, data }, 'latest']);
  const [bal, dec, sym] = await Promise.all([call(erc20BalanceData(address)), call('0x313ce567'), call('0x95d89b41').catch(() => '0x')]);
  const decimals = Number(hexNum(dec));
  if (!(decimals >= 0 && decimals <= 36)) throw new HttpError(502, 'Token reported invalid decimals');
  return { amount: Number(hexNum(bal)) / 10 ** decimals, symbol: abiString(sym) || 'TOKEN' };
}

/** USD prices for coins and (by contract) tokens in one CoinGecko round per kind. */
export async function usdPrices(wallets) {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'error' }); return r.ok ? r.json() : {}; };
  const ids = [...new Set(wallets.filter((w) => !w.token).map((w) => CHAINS[w.chain]?.cg).filter(Boolean))];
  const coins = ids.length ? await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`).catch(() => ({})) : {};
  const out = new Map();
  for (const w of wallets) if (!w.token) out.set(w, coins[CHAINS[w.chain]?.cg]?.usd ?? null);
  const byPlatform = {};
  for (const w of wallets) if (w.token) (byPlatform[CHAINS[w.chain].platform] ??= []).push(w);
  await Promise.all(Object.entries(byPlatform).map(async ([p, ws]) => {
    const d = await get(`https://api.coingecko.com/api/v3/simple/token_price/${p}?contract_addresses=${ws.map((w) => w.token.contract.toLowerCase()).join(',')}&vs_currencies=usd`).catch(() => ({}));
    for (const w of ws) out.set(w, d[w.token.contract.toLowerCase()]?.usd ?? null);
  }));
  return out;
}
