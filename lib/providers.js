// External data + execution. All third-party calls happen server-side so API keys never reach the browser.
import { isCrypto } from './risk.js';
import { isValidEthAddress } from './keccak.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) throw new HttpError(r.status >= 500 ? 502 : r.status === 429 ? 429 : 400, data?.message || data?.error || `${new URL(url).host} returned ${r.status}`);
  return data;
}

// ---------------- Alpaca (stocks + crypto, paper or live) ----------------
const TRADING = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets' };
const DATA = 'https://data.alpaca.markets';

export function createAlpaca({ keyId, secret, mode }) {
  const configured = Boolean(keyId && secret);
  const headers = () => {
    if (!configured) throw new HttpError(503, 'Alpaca keys not configured (ALPACA_KEY_ID / ALPACA_SECRET_KEY)');
    return { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
  };
  // async so a missing-key throw becomes a rejection, never a sync throw inside Promise.all
  const trade = async (p, init = {}) => getJson(TRADING[mode] + p, { ...init, headers: headers() });
  const data = async (p) => getJson(DATA + p, { headers: headers() });
  const enc = encodeURIComponent;
  const since = (days) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  return {
    configured,
    account: () => trade('/v2/account'),
    positions: () => trade('/v2/positions'),
    orders: () => trade('/v2/orders?status=all&limit=50&direction=desc'),
    placeOrder: (order) => trade('/v2/orders', { method: 'POST', body: JSON.stringify(order) }),
    cancelAll: () => trade('/v2/orders', { method: 'DELETE' }),
    closeAll: () => trade('/v2/positions?cancel_orders=true', { method: 'DELETE' }),

    /** Daily bars, oldest first: [{t,o,h,l,c,v}] */
    async bars(symbol, days = 400) {
      if (isCrypto(symbol)) {
        const d = await data(`/v1beta3/crypto/us/bars?symbols=${enc(symbol)}&timeframe=1Day&start=${since(days)}&limit=1000`);
        return d?.bars?.[symbol] ?? [];
      }
      const d = await data(`/v2/stocks/${enc(symbol)}/bars?timeframe=1Day&start=${since(days)}&limit=1000&adjustment=all&feed=iex`);
      return d?.bars ?? [];
    },
    /** Latest trade: {price, at} so callers can reject stale prices. */
    async lastPrice(symbol) {
      const t = isCrypto(symbol)
        ? (await data(`/v1beta3/crypto/us/latest/trades?symbols=${enc(symbol)}`))?.trades?.[symbol]
        : (await data(`/v2/stocks/${enc(symbol)}/trades/latest?feed=iex`))?.trade;
      return { price: t?.p ?? null, at: t?.t ? Date.parse(t.t) : null };
    },
    portfolioHistory: () => trade('/v2/account/portfolio/history?period=3M&timeframe=1D'),
    async news(symbol, limit = 12) {
      const d = await data(`/v1beta1/news?symbols=${enc(symbol.replace('/', ''))}&limit=${limit}`);
      return (d?.news ?? []).map((n) => ({ headline: n.headline, summary: n.summary?.slice(0, 400), source: n.source, url: n.url, at: n.created_at }));
    },
  };
}

// ---------------- Public market data (no keys) ----------------
export const cryptoMarkets = () =>
  getJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=25&page=1&price_change_percentage=24h,7d');

export const btcPrice = async () =>
  (await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd'));

export async function bitcoinNetwork() {
  const [hr, rewards] = await Promise.all([
    getJson('https://mempool.space/api/v1/mining/hashrate/3d'),
    getJson('https://mempool.space/api/v1/mining/reward-stats/144'),
  ]);
  return {
    networkHashrateEHs: hr.currentHashrate / 1e18,
    difficulty: hr.currentDifficulty,
    feesPerBlockBtc: Number(rewards.totalFee) / 144 / 1e8,
  };
}

// ---------------- Watch-only wallet balances (public addresses only; never keys) ----------------
export const ADDRESS_RE = {
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  eth: /^0x[0-9a-fA-F]{40}$/,
};

export const validAddress = (chain, address) =>
  Object.hasOwn(ADDRESS_RE, chain) && ADDRESS_RE[chain].test(address) && (chain !== 'eth' || isValidEthAddress(address));

export async function balanceOf(chain, address, ethRpc) {
  if (!validAddress(chain, address)) throw new HttpError(400, 'Invalid address (check for typos: the EIP-55 checksum failed or the format is wrong)');
  if (chain === 'btc') {
    const d = await getJson(`https://mempool.space/api/address/${address}`);
    const sats = (s) => s.funded_txo_sum - s.spent_txo_sum;
    return (sats(d.chain_stats) + sats(d.mempool_stats)) / 1e8;
  }
  const d = await getJson(ethRpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  });
  if (d?.error) throw new HttpError(502, d.error.message);
  if (typeof d?.result !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(d.result)) throw new HttpError(502, 'Malformed balance from RPC');
  return Number(BigInt(d.result)) / 1e18;
}

// ---------------- Outbound notifications (Discord / Slack / any JSON webhook) ----------------
export async function notify(url, text) {
  if (!url) return;
  text = String(text).replace(/@/g, '@​').replace(/https?:\/\/\S+/g, '[link]').slice(0, 500); // no pings, no injected links
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(5000) });
  } catch (e) { console.warn('notify failed:', e.message); }
}
