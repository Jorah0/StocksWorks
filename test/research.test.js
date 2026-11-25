import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, finvizRows, validFinvizFilters, messariAssets, messariNews, traderSummary, toCorpus, validHlAddress } from '../lib/research.js';

test('parseCsv handles quoted commas, escaped quotes and CRLF', () => {
  const rows = parseCsv('No.,Ticker,Company\r\n1,AAPL,"Apple, Inc."\r\n2,X,"Say ""hi"""\r\n');
  assert.deepEqual(rows, [{ 'No.': '1', Ticker: 'AAPL', Company: 'Apple, Inc.' }, { 'No.': '2', Ticker: 'X', Company: 'Say "hi"' }]);
});

test('finvizRows normalizes the standard screener export', () => {
  const csv = '"No.","Ticker","Company","Sector","Industry","Country","Market Cap","P/E","Price","Change","Volume"\n'
    + '"1","NVDA","NVIDIA Corp","Technology","Semiconductors","USA","3500000.00","55.20","140.50","2.35%","250000000"\n';
  const [r] = finvizRows(csv);
  assert.equal(r.ticker, 'NVDA');
  assert.equal(r.sector, 'Technology');
  assert.equal(r.marketCapM, 3500000);
  assert.equal(r.pe, 55.2);
  assert.equal(r.price, 140.5);
  assert.equal(r.changePct, 2.35);
  assert.equal(r.volume, 250000000);
});

test('finvizRows rejects the HTML login page Finviz returns for a bad token', () => {
  assert.throws(() => finvizRows('<!DOCTYPE html><html>login</html>'), /token/i);
});

test('validFinvizFilters accepts filter codes only', () => {
  assert.equal(validFinvizFilters('cap_large,sec_technology,ta_rsi_os30'), true);
  assert.equal(validFinvizFilters(''), true);
  assert.equal(validFinvizFilters('cap_large&auth=x'), false);
  assert.equal(validFinvizFilters('a'.repeat(400)), false);
});

test('messariAssets and messariNews keep only known fields', () => {
  const a = messariAssets({ data: [{ id: 'x', name: 'Bitcoin', symbol: 'BTC', slug: 'bitcoin', sector: 'Currencies', category: 'Payments', tags: ['pow'], extra: { secret: 1 } }] });
  assert.deepEqual(a, [{ name: 'Bitcoin', symbol: 'BTC', slug: 'bitcoin', sector: 'Currencies', category: 'Payments', tags: ['pow'] }]);
  const n = messariNews({ data: [{ title: 'ETH upgrade', url: 'https://x.io/a', source: { sourceName: 'Messari' }, publishTimeMillis: 1700000000000, assets: [{ symbol: 'ETH' }] }, { title: 'bad', url: 'javascript:alert(1)' }] });
  assert.equal(n.length, 1);
  assert.deepEqual(n[0], { title: 'ETH upgrade', url: 'https://x.io/a', source: 'Messari', at: new Date(1700000000000).toISOString(), assets: ['ETH'] });
});

test('traderSummary computes positions, realized PnL and win rate from Hyperliquid data', () => {
  const state = { marginSummary: { accountValue: '12500.5' }, assetPositions: [
    { position: { coin: 'BTC', szi: '0.5', entryPx: '60000', positionValue: '31000', unrealizedPnl: '1000', leverage: { value: 5 } } },
    { position: { coin: 'ETH', szi: '-2', entryPx: '3000', positionValue: '5800', unrealizedPnl: '200', leverage: { value: 3 } } },
  ] };
  const fills = [
    { coin: 'BTC', closedPnl: '500', dir: 'Close Long', time: 1 },
    { coin: 'BTC', closedPnl: '-100', dir: 'Close Long', time: 2 },
    { coin: 'SOL', closedPnl: '50', dir: 'Close Short', time: 3 },
    { coin: 'BTC', closedPnl: '0', dir: 'Open Long', time: 4 },
  ];
  const s = traderSummary('0x' + 'a'.repeat(40), state, fills);
  assert.equal(s.accountValue, 12500.5);
  assert.deepEqual(s.positions.map((p) => [p.coin, p.side, p.size]), [['BTC', 'long', 0.5], ['ETH', 'short', 2]]);
  assert.equal(s.fills.closes, 3);
  assert.equal(s.fills.winRate, 2 / 3);
  assert.equal(s.fills.realizedPnl, 450);
  assert.equal(s.fills.topCoins[0], 'BTC');
  assert.match(s.style, /long/i);
});

test('validHlAddress', () => {
  assert.equal(validHlAddress('0x' + 'aB'.repeat(20)), true);
  assert.equal(validHlAddress('0x123'), false);
});

test('toCorpus labels the source', () => {
  const t = toCorpus('finviz', [{ ticker: 'NVDA', company: 'NVIDIA', sector: 'Technology', pe: 55, changePct: 2 }], { at: '2026-11-24' });
  assert.match(t, /^\[Source: Finviz screener · 2026-11-24\]/);
  assert.match(t, /NVDA/);
  const n = toCorpus('messari-news', [{ title: 'ETH upgrade', url: 'https://a.b', source: 'X', at: '2026-01-01', assets: [] }], { at: 'd' });
  assert.match(n, /Messari news/);
  assert.throws(() => toCorpus('nope', []), /source/i);
});
