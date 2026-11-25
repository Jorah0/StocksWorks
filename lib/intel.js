// Data aggregation + fact checking. More sources (SEC EDGAR, FRED macro, DefiLlama, Fear & Greed, GDELT news),
// one per-symbol dossier that merges every source and cross-checks them, deterministic checks of AI analyses
// against that data, and a gate that keeps an AI fact-check from claiming more than its cited sources support.
// Pure parsers/checks are exported for tests; fetchers are thin. Fetched text is data, never instructions.
import { HttpError } from './providers.js';

const s = (v, max = 200) => String(v ?? '').slice(0, max);
const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const httpUrl = (u) => (/^https?:\/\/[^\s"'<>]{1,500}$/.test(String(u ?? '')) ? String(u) : null);

async function getJson(url, headers = {}, timeout = 15_000) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (r.status === 429) throw new HttpError(429, `${new URL(url).host} rate limit: try again shortly`);
  if (r.status === 401 || r.status === 403) throw new HttpError(409, `${new URL(url).host} refused the request (${r.status}): check the key/contact setting`);
  if (!r.ok) throw new HttpError(502, `${new URL(url).host} returned ${r.status}`);
  try { return await r.json(); } catch { throw new HttpError(502, `${new URL(url).host} returned non-JSON`); }
}

// ---------------- SEC EDGAR (official filings + XBRL financials) ----------------
export function edgarCik(map, ticker) {
  const t = String(ticker ?? '').toUpperCase();
  const hit = Object.values(map ?? {}).find((x) => String(x?.ticker).toUpperCase() === t);
  return hit ? { cik: String(hit.cik_str).padStart(10, '0'), name: s(hit.title, 120) } : null;
}
const CONCEPTS = { revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'], netIncome: ['NetIncomeLoss'],
  epsDiluted: ['EarningsPerShareDiluted'], assets: ['Assets'], liabilities: ['Liabilities'], cash: ['CashAndCashEquivalentsAtCarryingValue'], sharesOut: ['EntityCommonStockSharesOutstanding'] };
const pickFact = (x) => ({ val: x.val, end: x.end, fy: x.fy, fp: x.fp, form: x.form, filed: x.filed });
/** Latest annual (10-K FY) value, the latest value of any form, and year-over-year revenue growth. */
export function edgarFacts(j) {
  const g = { ...(j?.facts?.['us-gaap'] ?? {}), ...(j?.facts?.dei ?? {}) };
  const out = {};
  for (const [key, names] of Object.entries(CONCEPTS)) {
    const rows = names.flatMap((c) => Object.values(g[c]?.units ?? {}).flat()).filter((x) => Number.isFinite(x?.val) && x.end);
    if (!rows.length) continue;
    const byEnd = (a, b) => a.end.localeCompare(b.end) || String(a.filed).localeCompare(String(b.filed));
    const annual = rows.filter((x) => x.form === '10-K' && x.fp === 'FY').sort(byEnd);
    out[key] = { annual: annual.length ? pickFact(annual.at(-1)) : null, latest: pickFact([...rows].sort(byEnd).at(-1)), prevAnnual: annual.length > 1 ? pickFact(annual.at(-2)) : null };
  }
  const r = out.revenue;
  out.revenueGrowthPct = r?.annual && r?.prevAnnual?.val ? Math.round(((r.annual.val / r.prevAnnual.val) - 1) * 1000) / 10 : null;
  for (const k of Object.keys(CONCEPTS)) if (out[k]) delete out[k].prevAnnual;
  return out;
}
export function edgarFilings(j, cik) {
  const r = j?.filings?.recent ?? {};
  return (r.form ?? []).slice(0, 15).map((form, i) => ({
    form: s(form, 12), date: s(r.filingDate?.[i], 10),
    url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${s(r.accessionNumber?.[i], 30).replace(/[^0-9]/g, '')}/${encodeURIComponent(s(r.primaryDocument?.[i], 120))}`,
  }));
}

// ---------------- FRED macro, Fear & Greed, DefiLlama, GDELT ----------------
export const MACRO_SERIES = { DGS10: '10-year Treasury', DFF: 'Fed funds rate', CPIAUCSL: 'CPI (index)', UNRATE: 'Unemployment rate', VIXCLS: 'VIX' };
export function fredLatest(j) {
  const o = (j?.observations ?? []).find((x) => n(x?.value) != null);
  return o ? { date: s(o.date, 10), value: n(o.value) } : null;
}
export function fearGreed(j) {
  const d = j?.data?.[0];
  return d && n(d.value) != null ? { value: n(d.value), label: s(d.value_classification, 30), at: new Date(Number(d.timestamp) * 1000).toISOString() } : null;
}
/** Match a coin symbol to a DeFi protocol (TVL) or a chain (TVL). */
export function defiForCoin(sym, protocols = [], chains = []) {
  const S = String(sym ?? '').toUpperCase();
  const p = protocols.find((x) => String(x?.symbol).toUpperCase() === S && n(x.tvl) != null);
  if (p) return { kind: 'protocol', name: s(p.name, 60), tvlUsd: n(p.tvl), change1dPct: n(p.change_1d), category: s(p.category, 40) };
  const c = chains.find((x) => String(x?.tokenSymbol).toUpperCase() === S && n(x.tvl) != null);
  return c ? { kind: 'chain', name: s(c.name, 60), tvlUsd: n(c.tvl) } : null;
}
export function gdeltArticles(j) {
  return (j?.articles ?? []).flatMap((a) => {
    const url = httpUrl(a?.url);
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(a?.seendate ?? ''));
    return url && a.title ? [{ title: s(a.title, 300), url, source: s(a.domain, 80), at: m ? new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6])).toISOString() : null }] : [];
  }).slice(0, 25);
}

// ---------------- fact checking ----------------
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
/** Cross-source price check: any source more than tolPct from the median is an outlier. */
export function priceAgreement(prices = {}, tolPct = 2) {
  const have = Object.entries(prices).filter(([, v]) => n(v) > 0).map(([k, v]) => [k, Number(v)]);
  if (!have.length) return { status: 'no-data', sources: [] };
  const med = median(have.map(([, v]) => v));
  if (have.length === 1) return { status: 'single-source', median: med, sources: have.map(([k]) => k) };
  const outliers = have.filter(([, v]) => (Math.abs(v / med - 1) * 100) > tolPct).map(([k]) => k);
  return { status: outliers.length ? 'disagree' : 'agree', median: med, maxDevPct: Math.round(Math.max(...have.map(([, v]) => Math.abs(v / med - 1) * 100)) * 100) / 100, outliers, sources: have.map(([k]) => k), prices: Object.fromEntries(have) };
}

/**
 * Deterministic checks of an AI analysis against the dossier. Every check is reported (verified / contradicted /
 * unverifiable) so a contradicted claim is shown next to the analysis, never silently dropped.
 */
export function checkAnalysis(a, d = {}) {
  const out = [];
  const add = (check, status, evidence) => out.push({ check, status, evidence });
  const { entry, stop, target, stance } = a ?? {};
  if ([entry, stop, target].every((x) => n(x) != null)) {
    const ok = stance === 'bearish' ? target < entry && entry < stop : stance === 'bullish' ? stop < entry && entry < target : true;
    add('levels', ok ? 'verified' : 'contradicted', `${stance}: stop ${stop}, entry ${entry}, target ${target}${ok ? '' : ' (levels are on the wrong side)'}`);
  } else add('levels', 'unverifiable', 'no complete entry/stop/target');
  if (n(entry) != null && n(d.price) > 0) {
    const dev = Math.abs(entry / d.price - 1) * 100;
    add('entry-near-price', dev <= 10 ? 'verified' : 'contradicted', `entry ${entry} vs price ${d.price} (${dev.toFixed(1)}% away)`);
  }
  const score = n(d.signal?.score);
  if (score != null && stance) {
    const bad = (stance === 'bullish' && score < 40 && a.confidence >= 60) || (stance === 'bearish' && score > 60 && a.confidence >= 60);
    add('stance-vs-signal', bad ? 'contradicted' : 'verified', `${stance} at ${a.confidence}% confidence vs technical score ${score}/100`);
  }
  const thesis = String(a?.thesis ?? '');
  const pe = /P\/?E(?: ratio)?(?: of| near| around| at)?\s*~?(\d+(?:\.\d+)?)/i.exec(thesis);
  if (pe) {
    const real = n(d.finviz?.pe);
    add('pe', real == null ? 'unverifiable' : Math.abs(Number(pe[1]) / real - 1) <= 0.15 ? 'verified' : 'contradicted', `claims P/E ${pe[1]}; data ${real ?? 'n/a'}`);
  }
  const rsi = /RSI(?:\s*\(?14\)?)?(?: of| near| around| at| is)?\s*~?(\d{1,3}(?:\.\d+)?)/i.exec(thesis);
  if (rsi) {
    const real = n(d.signal?.metrics?.rsi14);
    add('rsi', real == null ? 'unverifiable' : Math.abs(Number(rsi[1]) - real) <= 5 ? 'verified' : 'contradicted', `claims RSI ${rsi[1]}; computed ${real == null ? 'n/a' : real.toFixed(1)}`);
  }
  return out;
}

export const VERDICTS = ['supported', 'refuted', 'mixed', 'unverifiable'];
/** An AI fact-check may only say supported/refuted/mixed when it cites at least one source. */
export function gateVerdict(v, sources = []) {
  const verdict = VERDICTS.includes(v?.verdict) ? v.verdict : 'unverifiable';
  const cited = sources.filter((x) => httpUrl(x?.url));
  return {
    verdict: verdict !== 'unverifiable' && !cited.length ? 'unverifiable' : verdict,
    confidence: Math.max(0, Math.min(100, n(v?.confidence) ?? 0)),
    explanation: s(v?.explanation, 1500), sources: cited.slice(0, 10),
    ...(verdict !== 'unverifiable' && !cited.length ? { note: 'No sources were cited, so the verdict is not trusted.' } : {}),
  };
}

/** Study text for the AI corpus (one dossier). */
export function dossierCorpus(d, { at = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [`[Source: StocksWorks dossier ${d.symbol} · ${at}]`];
  if (d.agreement) lines.push(`Price ${d.agreement.median ?? d.price ?? 'n/a'} (${d.agreement.status === 'agree' ? 'sources agree' : d.agreement.status === 'disagree' ? `sources DISAGREE: ${d.agreement.outliers.join(', ')} off` : d.agreement.status}).`);
  const f = d.edgar?.facts;
  if (f?.revenue?.annual) lines.push(`${d.edgar.name}: annual revenue ${(f.revenue.annual.val / 1e9).toFixed(1)}B (FY ending ${f.revenue.annual.end})${f.revenueGrowthPct != null ? `, ${f.revenueGrowthPct}% year over year` : ''}${f.netIncome?.annual ? `, net income ${(f.netIncome.annual.val / 1e9).toFixed(1)}B` : ''}${f.epsDiluted?.annual ? `, diluted EPS ${f.epsDiluted.annual.val}` : ''}.`);
  if (d.finviz) lines.push(`Finviz: sector ${d.finviz.sector}, P/E ${d.finviz.pe ?? 'n/a'}, market cap ${d.finviz.marketCapM ?? 'n/a'}M.`);
  if (d.defi) lines.push(`DeFi: ${d.defi.name} TVL $${(d.defi.tvlUsd / 1e9).toFixed(2)}B.`);
  const m = Object.entries(d.macro ?? {}).filter(([, v]) => v).map(([k, v]) => `${MACRO_SERIES[k] ?? k} ${v.value}${['DGS10', 'DFF', 'UNRATE'].includes(k) ? '%' : ''}`);
  if (m.length) lines.push(`Macro: ${m.join(', ')}.`);
  if (d.sentiment) lines.push(`Crypto Fear & Greed: ${d.sentiment.value} (${d.sentiment.label}).`);
  for (const x of (d.news ?? []).slice(0, 8)) lines.push(`- ${x.title} (${x.source})`);
  return lines.join('\n');
}

// ---------------- fetchers ----------------
let gdeltQueue = Promise.resolve(), gdeltLastStart = 0; // module-wide: one GDELT request at a time, spaced out
export function createIntel({ secContact = '', fredKey = '' }) {
  const sec = (url) => { if (!secContact) throw new HttpError(409, 'SEC EDGAR needs SEC_CONTACT (your name or email: the SEC requires one in every request)'); return getJson(url, { 'User-Agent': `StocksWorks ${secContact}` }); };
  return {
    status: () => ({ edgar: Boolean(secContact), fred: Boolean(fredKey), defillama: true, feargreed: true, gdelt: true }),
    tickerMap: () => sec('https://www.sec.gov/files/company_tickers.json'),
    companyFacts: (cik) => sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`),
    submissions: (cik) => sec(`https://data.sec.gov/submissions/CIK${cik}.json`),
    async macro() {
      if (!fredKey) throw new HttpError(409, 'FRED macro data needs FRED_API_KEY (free at fred.stlouisfed.org)');
      const ids = Object.keys(MACRO_SERIES);
      const rows = await Promise.all(ids.map((id) => getJson(`https://api.stlouisfed.org/fred/series/observations?${new URLSearchParams({ series_id: id, api_key: fredKey, file_type: 'json', sort_order: 'desc', limit: '10' })}`).then(fredLatest).catch(() => null)));
      return Object.fromEntries(ids.map((id, i) => [id, rows[i]]));
    },
    fearGreed: async () => fearGreed(await getJson('https://api.alternative.me/fng/?limit=1')),
    // ~10 MB upstream: keep only the five fields used, so the hourly cache holds a fraction of it
    defiProtocols: async () => (await getJson('https://api.llama.fi/protocols', {}, 30_000) ?? []).map((p) => ({ name: p.name, symbol: p.symbol, tvl: p.tvl, change_1d: p.change_1d, category: p.category })),
    defiChains: () => getJson('https://api.llama.fi/v2/chains'),
    async news(query) {
      const q = String(query ?? '').replace(/[^\w .&'-]/g, ' ').trim().slice(0, 80);
      if (!q) return [];
      // GDELT allows one request per 5 s from an address: requests run one at a time, starting ≥5.5 s apart
      // (an idle queue starts immediately).
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({ query: `"${q}" sourcelang:english`, mode: 'artlist', format: 'json', maxrecords: '20', sort: 'datedesc', timespan: '7d' })}`;
      const run = async () => {
        const wait = gdeltLastStart + 5500 - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        gdeltLastStart = Date.now();
        const r = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
        const text = await r.text();
        if (r.status === 429 || /limit requests/i.test(text.slice(0, 200))) throw new HttpError(429, 'GDELT rate limit: news fills in shortly');
        if (!r.ok) throw new HttpError(502, `GDELT returned ${r.status}`);
        try { return gdeltArticles(JSON.parse(text)); } catch { return []; } // GDELT answers plain text when a query has no results
      };
      const p = gdeltQueue.then(run, run);
      gdeltQueue = p.catch(() => {});
      return p;
    },
  };
}
