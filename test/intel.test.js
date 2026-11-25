import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgarCik, edgarFacts, edgarFilings, fredLatest, fearGreed, defiForCoin, gdeltArticles, priceAgreement, checkAnalysis, gateVerdict, dossierCorpus } from '../lib/intel.js';

test('EDGAR: ticker -> zero-padded CIK; latest annual + quarterly facts; recent filings', () => {
  const map = { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' }, 1: { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' } };
  assert.deepEqual(edgarCik(map, 'aapl'), { cik: '0000320193', name: 'Apple Inc.' });
  assert.equal(edgarCik(map, 'ZZZZ'), null);
  const facts = { facts: { 'us-gaap': {
    Revenues: { units: { USD: [
      { end: '2024-09-28', val: 391035000000, fy: 2024, fp: 'FY', form: '10-K', filed: '2024-11-01' },
      { end: '2025-09-27', val: 416161000000, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31' },
      { end: '2025-12-27', val: 124300000000, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-01-30' } ] } },
    NetIncomeLoss: { units: { USD: [{ end: '2025-09-27', val: 112010000000, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31' }] } },
    EarningsPerShareDiluted: { units: { 'USD/shares': [{ end: '2025-09-27', val: 7.46, fy: 2025, fp: 'FY', form: '10-K', filed: '2025-10-31' }] } },
  } } };
  const f = edgarFacts(facts);
  assert.equal(f.revenue.annual.val, 416161000000);
  assert.equal(f.revenue.annual.end, '2025-09-27');
  assert.equal(f.revenue.latest.form, '10-Q');
  assert.equal(f.revenueGrowthPct, Math.round(((416161000000 / 391035000000) - 1) * 1000) / 10);
  assert.equal(f.netIncome.annual.val, 112010000000);
  assert.equal(f.epsDiluted.annual.val, 7.46);
  const sub = { filings: { recent: { form: ['4', '10-Q', '8-K'], filingDate: ['2026-02-01', '2026-01-30', '2026-01-29'], accessionNumber: ['0001-26-1', '0002-26-2', '0003-26-3'], primaryDocument: ['x.xml', 'q.htm', 'k.htm'] } } };
  const fl = edgarFilings(sub, '0000320193');
  assert.equal(fl.length, 3);
  assert.deepEqual(fl[1], { form: '10-Q', date: '2026-01-30', url: 'https://www.sec.gov/Archives/edgar/data/320193/0002262/q.htm' });
});

test('FRED, Fear & Greed, DefiLlama and GDELT parsers keep only clean values', () => {
  assert.deepEqual(fredLatest({ observations: [{ date: '2026-11-20', value: '.' }, { date: '2026-11-19', value: '4.12' }] }), { date: '2026-11-19', value: 4.12 });
  assert.equal(fredLatest({ observations: [] }), null);
  assert.deepEqual(fearGreed({ data: [{ value: '23', value_classification: 'Extreme Fear', timestamp: '1764000000' }] }), { value: 23, label: 'Extreme Fear', at: new Date(1764000000 * 1000).toISOString() });
  const protocols = [{ name: 'Uniswap', symbol: 'UNI', gecko_id: 'uniswap', tvl: 5e9, change_1d: -1.2, category: 'Dexes' }, { name: 'Aave', symbol: 'AAVE', tvl: 2e10 }];
  const chains = [{ name: 'Ethereum', tokenSymbol: 'ETH', tvl: 6e10, gecko_id: 'ethereum' }];
  assert.deepEqual(defiForCoin('UNI', protocols, chains), { kind: 'protocol', name: 'Uniswap', tvlUsd: 5e9, change1dPct: -1.2, category: 'Dexes' });
  assert.deepEqual(defiForCoin('ETH', protocols, chains), { kind: 'chain', name: 'Ethereum', tvlUsd: 6e10 });
  assert.equal(defiForCoin('DOGE', protocols, chains), null);
  const g = gdeltArticles({ articles: [{ url: 'https://n.example/a', title: 'Apple beats', seendate: '20261124T101500Z', domain: 'n.example', language: 'English' }, { url: 'javascript:x', title: 'bad' }] });
  assert.deepEqual(g, [{ title: 'Apple beats', url: 'https://n.example/a', source: 'n.example', at: '2026-11-24T10:15:00.000Z' }]);
});

test('priceAgreement: median of sources, flags any source more than 2% away', () => {
  const ok = priceAgreement({ alpaca: 100, finviz: 100.5, coingecko: null });
  assert.equal(ok.status, 'agree');
  assert.equal(ok.median, 100.25);
  const bad = priceAgreement({ alpaca: 100, finviz: 100.4, coingecko: 108 });
  assert.equal(bad.status, 'disagree');
  assert.deepEqual(bad.outliers, ['coingecko']);
  assert.equal(priceAgreement({ alpaca: 100 }).status, 'single-source');
  assert.equal(priceAgreement({}).status, 'no-data');
});

test('checkAnalysis: AI numbers are tested against data; contradictions are flagged, not hidden', () => {
  const dossier = { price: 200, signal: { score: 30, metrics: { rsi14: 41 } }, finviz: { pe: 30 } };
  const a = { stance: 'bullish', confidence: 80, entry: 199, stop: 205, target: 230, thesis: 'Cheap at a P/E of 12 with RSI near 70.' };
  const c = checkAnalysis(a, dossier);
  const by = (k) => c.find((x) => x.check === k);
  assert.equal(by('levels').status, 'contradicted'); // bullish stop above entry
  assert.equal(by('entry-near-price').status, 'verified');
  assert.equal(by('stance-vs-signal').status, 'contradicted'); // bullish at score 30
  assert.equal(by('pe').status, 'contradicted');
  assert.equal(by('rsi').status, 'contradicted');
  const good = checkAnalysis({ stance: 'neutral', confidence: 40, entry: null, stop: null, target: null, thesis: 'No edge.' }, dossier);
  assert.ok(good.every((x) => x.status !== 'contradicted'));
});

test('gateVerdict: an AI fact-check verdict needs cited sources, else it is unverifiable', () => {
  assert.equal(gateVerdict({ verdict: 'supported', confidence: 90 }, []).verdict, 'unverifiable');
  assert.equal(gateVerdict({ verdict: 'refuted', confidence: 70 }, [{ url: 'https://a.b' }]).verdict, 'refuted');
  assert.equal(gateVerdict({ verdict: 'banana' }, [{ url: 'https://a.b' }]).verdict, 'unverifiable');
  assert.equal(gateVerdict({ verdict: 'mixed', confidence: 999 }, [{ url: 'https://a.b' }]).confidence, 100);
});

test('dossierCorpus: labelled study text with the fact-check outcome', () => {
  const t = dossierCorpus({ symbol: 'AAPL', price: 200, agreement: { status: 'agree', median: 200 }, edgar: { name: 'Apple Inc.', facts: { revenue: { annual: { val: 4e11, end: '2025-09-27' } }, revenueGrowthPct: 6.4 } },
    macro: { DGS10: { value: 4.1, date: '2026-11-19' } }, sentiment: { value: 23, label: 'Extreme Fear' }, news: [{ title: 'Apple beats', source: 'n.example' }] }, { at: '2026-11-25' });
  assert.match(t, /^\[Source: StocksWorks dossier AAPL · 2026-11-25\]/);
  assert.match(t, /sources agree/);
  assert.match(t, /revenue/i);
  assert.match(t, /10-year Treasury 4.1%/);
  assert.match(t, /Extreme Fear/);
});
