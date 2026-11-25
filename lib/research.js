// Research sources the AI reads and learns from: Finviz (Elite export API), Messari (API key) and Invo traders.
// Invo is a social copy-trading app on Hyperliquid; a trader's positions and fills are public on Hyperliquid's
// info API by wallet address, so "following" an Invo trader = tracking that address. All calls are server-side
// (keys never reach the browser). Pure parsers are exported for tests; fetchers are thin.
import { HttpError } from './providers.js';

const FINVIZ = 'https://elite.finviz.com/export';
const MESSARI = 'https://api.messari.io';
const HL = 'https://api.hyperliquid.xyz/info';
const FILTERS_RE = /^[a-z0-9_.,-]{0,300}$/; // Finviz filter codes: cap_large,sec_technology,ta_rsi_os30
const ORDER_RE = /^-?[a-z0-9_]{1,40}$/;
const HL_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const validFinvizFilters = (f) => FILTERS_RE.test(String(f ?? ''));
export const validHlAddress = (a) => HL_ADDR_RE.test(String(a ?? ''));

async function fetchText(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new HttpError(409, `${new URL(url).host} rejected the API key/token (${r.status})`);
  if (r.status === 429) throw new HttpError(429, `${new URL(url).host} rate limit: try again in a minute`);
  if (!r.ok) throw new HttpError(502, `${new URL(url).host} returned ${r.status}`);
  return text;
}
const fetchJson = async (url, init) => { const t = await fetchText(url, init); try { return JSON.parse(t); } catch { throw new HttpError(502, `${new URL(url).host} returned non-JSON`); } };

/** RFC-4180-ish: quoted fields, "" escapes, CRLF. Returns objects keyed by the header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ''));
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) : [];
}

const n = (v) => { const x = Number(String(v ?? '').replace(/[%,]/g, '')); return v === '' || v == null || !Number.isFinite(x) ? null : x; };

export function finvizRows(csv) {
  if (/^\s*</.test(csv)) throw new HttpError(409, 'Finviz returned a login page: check FINVIZ_AUTH_TOKEN (Finviz Elite → Settings → API)');
  return parseCsv(csv).slice(0, 500).map((r) => ({
    ticker: String(r.Ticker ?? '').slice(0, 10), company: String(r.Company ?? '').slice(0, 80), sector: String(r.Sector ?? '').slice(0, 40),
    industry: String(r.Industry ?? '').slice(0, 60), country: String(r.Country ?? '').slice(0, 30),
    marketCapM: n(r['Market Cap']), pe: n(r['P/E']), price: n(r.Price), changePct: n(r.Change), volume: n(r.Volume),
  })).filter((r) => /^[A-Z][A-Z.-]{0,9}$/.test(r.ticker));
}

const httpUrl = (u) => (/^https?:\/\/[^\s"'<>]{1,500}$/.test(String(u ?? '')) ? String(u) : null);
const s = (v, max = 200) => String(v ?? '').slice(0, max);

export const messariAssets = (j) => (Array.isArray(j?.data) ? j.data : []).slice(0, 50).map((a) => ({
  name: s(a.name, 80), symbol: s(a.symbol, 16), slug: s(a.slug, 80), sector: s(a.sector, 60), category: s(a.category, 60),
  tags: (Array.isArray(a.tags) ? a.tags : []).map((t) => s(t, 40)).slice(0, 10),
}));

export const messariNews = (j) => (Array.isArray(j?.data) ? j.data : []).flatMap((x) => {
  const url = httpUrl(x.url ?? x.link);
  if (!url || !x.title) return [];
  const ms = Number(x.publishTimeMillis ?? Date.parse(x.publishedAt ?? x.published_at ?? ''));
  return [{
    title: s(x.title, 300), url, source: s(x.source?.sourceName ?? x.source?.name ?? x.source, 60),
    at: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
    assets: (Array.isArray(x.assets) ? x.assets : []).map((a) => s(a?.symbol ?? a, 16)).filter(Boolean).slice(0, 10),
  }];
}).slice(0, 50);

/** Hyperliquid clearinghouseState + userFills -> what the trader holds and how they trade. */
export function traderSummary(address, st, fills = []) {
  const positions = (st?.assetPositions ?? []).map(({ position: p }) => ({
    coin: s(p?.coin, 20), side: Number(p?.szi) < 0 ? 'short' : 'long', size: Math.abs(Number(p?.szi) || 0), entryPx: n(p?.entryPx),
    positionValue: n(p?.positionValue), unrealizedPnl: n(p?.unrealizedPnl), leverage: n(p?.leverage?.value),
  })).filter((p) => p.size > 0);
  const all = Array.isArray(fills) ? fills : [];
  const closes = all.filter((f) => /^Close/i.test(String(f?.dir ?? '')));
  const pnl = closes.map((f) => Number(f.closedPnl) || 0);
  const byCoin = {};
  for (const f of all) byCoin[f.coin] = (byCoin[f.coin] ?? 0) + 1;
  const longs = closes.filter((f) => /Long/i.test(f.dir)).length;
  const lev = positions.map((p) => p.leverage).filter(Number.isFinite);
  const winRate = closes.length ? pnl.filter((x) => x > 0).length / closes.length : null;
  const summary = {
    address, accountValue: n(st?.marginSummary?.accountValue), positions,
    fills: { closes: closes.length, winRate, realizedPnl: Math.round(pnl.reduce((a, b) => a + b, 0) * 100) / 100, topCoins: Object.entries(byCoin).sort((a, b) => b[1] - a[1]).map(([c]) => s(c, 20)).slice(0, 5) },
  };
  summary.style = [
    closes.length ? `${longs >= closes.length - longs ? 'Mostly long' : 'Mostly short'} (${longs}/${closes.length} closed trades long)` : 'No closed trades in the recent fills',
    winRate == null ? null : `win rate ${(winRate * 100).toFixed(0)}%`,
    lev.length ? `max leverage ${Math.max(...lev)}x` : null,
    summary.fills.topCoins.length ? `focus: ${summary.fills.topCoins.join(', ')}` : null,
  ].filter(Boolean).join('; ');
  return summary;
}

/** Turns fetched data into labelled study text for the AI corpus. Data, never instructions. */
export function toCorpus(source, data, { at = new Date().toISOString().slice(0, 10) } = {}) {
  const head = (label) => `[Source: ${label} · ${at}]`;
  const pct = (x) => (x == null ? 'n/a' : `${x > 0 ? '+' : ''}${x}%`);
  switch (source) {
    case 'finviz': return [head('Finviz screener'), ...data.slice(0, 100).map((r) => `${r.ticker} (${r.company}, ${r.sector}${r.industry ? ` / ${r.industry}` : ''}): price ${r.price ?? 'n/a'}, day ${pct(r.changePct)}, P/E ${r.pe ?? 'n/a'}, market cap ${r.marketCapM ?? 'n/a'}M.`)].join('\n');
    case 'messari-news': return [head('Messari news'), ...data.slice(0, 50).map((x) => `- ${x.title}${x.assets?.length ? ` [${x.assets.join(', ')}]` : ''} (${x.source || 'Messari'}, ${x.at ?? ''})`)].join('\n');
    case 'messari-assets': return [head('Messari assets'), ...data.slice(0, 50).map((a) => `${a.name} (${a.symbol}): sector ${a.sector || 'n/a'}, category ${a.category || 'n/a'}${a.tags?.length ? `, tags ${a.tags.join(', ')}` : ''}.`)].join('\n');
    case 'trader': return [head(`Invo/Hyperliquid trader ${data.address}`), `Style: ${data.style}.`, `Account value ${data.accountValue ?? 'n/a'}; realized PnL in recent fills ${data.fills.realizedPnl}.`,
      ...data.positions.map((p) => `Holds ${p.side} ${p.size} ${p.coin} from ${p.entryPx} at ${p.leverage ?? '?'}x (unrealized ${p.unrealizedPnl}).`)].join('\n');
    case 'note': return [head('Your note'), String(data).slice(0, 20_000)].join('\n');
    default: throw new HttpError(400, 'Unknown research source');
  }
}

export function createResearch({ finvizToken, messariKey }) {
  const needFinviz = () => { if (!finvizToken) throw new HttpError(409, 'Finviz is not configured: add FINVIZ_AUTH_TOKEN (Finviz Elite → Settings → API) and restart'); };
  const needMessari = () => { if (!messariKey) throw new HttpError(409, 'Messari is not configured: add MESSARI_API_KEY (messari.io → API) and restart'); };
  const messari = (p) => { needMessari(); return fetchJson(MESSARI + p, { headers: { 'X-Messari-API-Key': messariKey, Accept: 'application/json' } }); };
  const hl = (body) => fetchJson(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    status: () => ({ finviz: { configured: Boolean(finvizToken) }, messari: { configured: Boolean(messariKey) }, hyperliquid: { configured: true } }),
    async finviz(filters = '', order = '') {
      needFinviz();
      if (!validFinvizFilters(filters)) throw new HttpError(400, 'Filters: Finviz filter codes separated by commas, e.g. cap_large,sec_technology');
      if (order && !ORDER_RE.test(order)) throw new HttpError(400, 'Order: a Finviz order code, e.g. -change');
      const q = new URLSearchParams({ v: '111', ...(filters ? { f: filters } : {}), ...(order ? { o: order } : {}), auth: finvizToken });
      return finvizRows(await fetchText(`${FINVIZ}?${q}`, { headers: { 'User-Agent': 'StocksWorks' } }));
    },
    /** One ticker's Finviz row (for AI analysis context); null when Finviz isn't configured. */
    async finvizTicker(symbol) {
      if (!finvizToken || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) return null;
      const q = new URLSearchParams({ v: '111', t: symbol, auth: finvizToken });
      return finvizRows(await fetchText(`${FINVIZ}?${q}`, { headers: { 'User-Agent': 'StocksWorks' } }))[0] ?? null;
    },
    async messariAssets(search = '') {
      const q = new URLSearchParams({ limit: '25', ...(search ? { search: String(search).slice(0, 60) } : {}) });
      return messariAssets(await messari(`/metrics/v2/assets?${q}`));
    },
    async messariNews(asset = '') {
      if (asset && !/^[a-z0-9-]{1,80}$/.test(asset)) throw new HttpError(400, 'Asset: a Messari slug such as bitcoin');
      return messariNews(await messari(`/news/v1/news/feed?${new URLSearchParams({ limit: '30', ...(asset ? { assetSlugs: asset } : {}) })}`));
    },
    async trader(address) {
      if (!validHlAddress(address)) throw new HttpError(400, 'Trader address: the 0x… Hyperliquid wallet shown on their Invo profile');
      const [st, fills] = await Promise.all([hl({ type: 'clearinghouseState', user: address }), hl({ type: 'userFills', user: address })]);
      return traderSummary(address, st, (Array.isArray(fills) ? fills : []).slice(0, 500));
    },
  };
}
