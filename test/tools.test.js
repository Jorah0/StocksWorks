import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pctReturns, sharpe, maxDrawdown, cagr, correlation, correlationMatrix, summarizeEquity, allocation } from '../lib/analytics.js';
import { STRATEGIES, validateParams, runStrategy } from '../lib/strategies.js';
import { validateAlert, checkAlert } from '../lib/alerts.js';
import { validateEntry, journalStats } from '../lib/journal.js';
import { validateOrder } from '../lib/risk.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const up = Array.from({ length: 300 }, (_, i) => 100 * 1.003 ** i + Math.sin(i / 3) * 0.8);
const down = up.slice().reverse();

// ---------------- analytics ----------------
test('analytics: returns, drawdown, cagr, sharpe', () => {
  assert.deepEqual(pctReturns([100, 110, 99]).map((x) => +x.toFixed(4)), [0.1, -0.1]);
  assert.ok(close(maxDrawdown([100, 120, 90, 130, 65]), 0.5));
  assert.equal(maxDrawdown([1, 2, 3]), 0);
  assert.ok(close(cagr([100, 121], 1), 0.21)); // 2 points, 1 period/yr
  assert.equal(sharpe([0.01, 0.01, 0.01]), null, 'zero volatility -> undefined Sharpe');
  assert.ok(sharpe(pctReturns(up)) > 0 && sharpe(pctReturns(down)) < 0);
  const s = summarizeEquity([100, 110, 99, 120]);
  assert.ok(close(s.totalReturn, 0.2));
  assert.ok(close(s.maxDrawdown, 0.1));
});

test('analytics: correlation + matrix', () => {
  const a = [1, 2, 3, 4, 5], b = [2, 4, 6, 8, 10], c = [5, 4, 3, 2, 1];
  assert.ok(close(correlation(a, b), 1));
  assert.ok(close(correlation(a, c), -1));
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), null);
  const m = correlationMatrix({ A: up, B: up.map((x) => x * 2), C: down });
  assert.deepEqual(m.symbols, ['A', 'B', 'C']);
  assert.ok(close(m.matrix[0][1], 1, 1e-6));
  assert.equal(m.matrix[1][1], 1);
});

test('analytics: allocation weights, concentration, P/L', () => {
  const r = allocation([
    { symbol: 'AAPL', market_value: '600', unrealized_pl: '50', asset_class: 'us_equity' },
    { symbol: 'BTCUSD', market_value: '400', unrealized_pl: '-20', asset_class: 'crypto' },
  ]);
  assert.equal(r.total, 1000);
  assert.ok(close(r.rows[0].weight, 0.6));
  assert.ok(close(r.hhi, 0.52)); // 0.36 + 0.16
  assert.ok(close(r.byClass.crypto, 0.4));
  assert.equal(r.unrealizedPl, 30);
  assert.equal(allocation([]).total, 0);
});

// ---------------- strategies ----------------
test('strategy params are validated and bounded', () => {
  assert.equal(validateParams('smaCross', { fast: 20, slow: 50 }).ok, true);
  assert.equal(validateParams('smaCross', { fast: 50, slow: 20 }).ok, false, 'fast must be < slow');
  assert.equal(validateParams('smaCross', { fast: 1e9, slow: 50 }).ok, false);
  assert.equal(validateParams('__proto__', {}).ok, false);
  assert.equal(validateParams('nope', {}).ok, false);
  assert.deepEqual(validateParams('rsiReversion', {}).params, { period: 14, buyBelow: 30, sellAbove: 55 }, 'defaults');
  for (const k of Object.keys(STRATEGIES)) assert.equal(validateParams(k, {}).ok, true, k);
});

test('strategies: trend follower profits in an uptrend; equity/buy-hold aligned; no look-ahead', () => {
  const r = runStrategy(up, 'smaCross', validateParams('smaCross', {}).params);
  assert.equal(r.equity.length, r.buyHold.length);
  assert.ok(r.metrics.totalReturn > 0);
  assert.ok(r.trades.length >= 1);
  const tweaked = up.slice(); tweaked[tweaked.length - 1] *= 3; // change only the final bar
  const r2 = runStrategy(tweaked, 'smaCross', validateParams('smaCross', {}).params);
  assert.deepEqual(r2.equity.slice(0, -1), r.equity.slice(0, -1), 'past decisions unaffected by future data');
  for (const k of Object.keys(STRATEGIES)) {
    const x = runStrategy(up, k, validateParams(k, {}).params);
    assert.ok(Number.isFinite(x.metrics.totalReturn), k);
    assert.ok(x.exposure >= 0 && x.exposure <= 1, k);
  }
});

test('strategies: rsi reversion never buys a market that never dips', () => {
  const mono = Array.from({ length: 200 }, (_, i) => 100 + i);
  const r = runStrategy(mono, 'rsiReversion', validateParams('rsiReversion', {}).params);
  assert.equal(r.trades.length, 0);
  assert.equal(r.metrics.totalReturn, 0);
});

// ---------------- alerts ----------------
test('alerts validate input and fire on the right condition', () => {
  assert.equal(validateAlert({ symbol: 'aapl', type: 'price_above', value: '200' }).ok, true);
  for (const bad of [{ symbol: 'AAPL;', type: 'price_above', value: 1 }, { symbol: 'AAPL', type: 'eval', value: 1 },
    { symbol: 'AAPL', type: 'price_above', value: -1 }, { symbol: 'AAPL', type: 'score_above', value: 101 },
    { symbol: 'AAPL', type: 'day_change_pct', value: 0 }, { symbol: 'AAPL', type: 'price_above', value: 1, note: 'x'.repeat(200) }])
    assert.equal(validateAlert(bad).ok, false, JSON.stringify(bad));
  const a = (type, value) => validateAlert({ symbol: 'AAPL', type, value }).alert;
  assert.equal(checkAlert(a('price_above', 100), { price: 101 }).hit, true);
  assert.equal(checkAlert(a('price_above', 100), { price: 99 }).hit, false);
  assert.equal(checkAlert(a('price_below', 100), { price: 99 }).hit, true);
  assert.equal(checkAlert(a('day_change_pct', 5), { price: 94, prevClose: 100 }).hit, true, 'abs move');
  assert.equal(checkAlert(a('day_change_pct', 5), { price: 103, prevClose: 100 }).hit, false);
  assert.equal(checkAlert(a('score_above', 70), { score: 75 }).hit, true);
  assert.equal(checkAlert(a('score_below', 40), { score: null }).hit, false, 'missing data never fires');
});

// ---------------- journal ----------------
test('journal entries validate and stats compute expectancy by setup/emotion', () => {
  assert.equal(validateEntry({ symbol: 'AAPL', side: 'buy', setup: 'breakout', emotion: 'calm', confidence: 3, outcome: 'open', thesis: 't' }).ok, true);
  assert.equal(validateEntry({ symbol: 'AAPL', side: 'buy', emotion: 'zen', confidence: 3, outcome: 'open' }).ok, false);
  assert.equal(validateEntry({ symbol: 'AAPL', side: 'buy', emotion: 'calm', confidence: 9, outcome: 'open' }).ok, false);
  assert.equal(validateEntry({ symbol: 'AAPL', side: 'buy', emotion: 'calm', confidence: 3, outcome: 'win', pnl: '1e999' }).ok, false);
  const e = (setup, emotion, outcome, pnl) => validateEntry({ symbol: 'AAPL', side: 'buy', setup, emotion, confidence: 3, outcome, pnl }).entry;
  const s = journalStats([e('breakout', 'calm', 'win', 100), e('breakout', 'fomo', 'loss', -50), e('dip', 'calm', 'win', 30), e('dip', 'calm', 'open', null)]);
  assert.equal(s.total, 4);
  assert.equal(s.closed, 3);
  assert.ok(close(s.winRate, 2 / 3));
  assert.equal(s.totalPnl, 80);
  assert.ok(close(s.expectancy, 80 / 3));
  assert.equal(s.byEmotion.find((x) => x.emotion === 'fomo').winRate, 0);
  assert.equal(s.bySetup.find((x) => x.setup === 'breakout').n, 2);
});

// ---------------- trailing stops ----------------
test('trailing stop: sell-only, stocks, bounded percent, cannot exceed holding', () => {
  const limits = { maxOrderUsd: 1e6, maxOrdersPerDay: 5, maxPositionPct: 100, maxLimitDeviationPct: 10 };
  const ctx = { mode: 'paper', killSwitch: false, price: 100, equity: 1e5, ordersToday: 0, limits, heldQty: 10 };
  const o = { symbol: 'AAPL', side: 'sell', type: 'trailing_stop', qty: '10', trail_percent: '5' };
  const r = validateOrder(o, ctx);
  assert.equal(r.ok, true, r.errors.join());
  assert.deepEqual(r.order, { symbol: 'AAPL', side: 'sell', type: 'trailing_stop', time_in_force: 'gtc', qty: '10', trail_percent: '5' });
  assert.equal(validateOrder({ ...o, side: 'buy' }, ctx).ok, false);
  assert.equal(validateOrder({ ...o, trail_percent: '50' }, ctx).ok, false);
  assert.equal(validateOrder({ ...o, trail_percent: undefined }, ctx).ok, false);
  assert.equal(validateOrder({ ...o, qty: '11' }, ctx).ok, false);
  assert.equal(validateOrder({ ...o, symbol: 'BTC/USD', qty: '1' }, ctx).ok, false);
});

// ---------------- round 2: robustness, risk report, more alerts ----------------
import { beta, stopCoverage } from '../lib/analytics.js';
import { sweep } from '../lib/strategies.js';

test('beta: 2x-levered copy has beta 2, independent series near 0', () => {
  const bench = Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i * 1.7)) * 1.001 ** i);
  const r = pctReturns(bench);
  const lev = [100]; for (const x of r) lev.push(lev.at(-1) * (1 + 2 * x));
  assert.ok(close(beta(lev, bench), 2, 1e-6));
  assert.equal(beta([1, 1, 1], [1, 2, 3]), null);
});

test('stop coverage: stops, trailing stops and bracket legs protect longs; open risk summed', () => {
  const positions = [
    { symbol: 'AAPL', qty: '10', current_price: '100' },
    { symbol: 'MSFT', qty: '5', current_price: '200' },
    { symbol: 'BTCUSD', qty: '0.5', current_price: '60000' },
  ];
  const orders = [
    { symbol: 'AAPL', side: 'sell', type: 'stop', stop_price: '90', qty: '10', status: 'new' },
    { symbol: 'MSFT', side: 'buy', type: 'limit', qty: '5', status: 'new', order_class: 'bracket',
      legs: [{ symbol: 'MSFT', side: 'sell', type: 'stop', stop_price: '190', qty: '2', status: 'held' }] },
    { symbol: 'AAPL', side: 'sell', type: 'limit', limit_price: '120', qty: '10', status: 'new' },
  ];
  const c = stopCoverage(positions, orders);
  const by = Object.fromEntries(c.rows.map((r) => [r.symbol, r]));
  assert.equal(by.AAPL.covered, 1);
  assert.equal(by.AAPL.riskUsd, 100);
  assert.ok(close(by.MSFT.covered, 0.4));
  assert.equal(by.BTCUSD.covered, 0);
  assert.deepEqual(c.unprotected.sort(), ['BTCUSD', 'MSFT']);
  assert.equal(c.openRiskUsd, 120); // 10*(100-90) + 2*(200-190)
  const t = stopCoverage([{ symbol: 'AAPL', qty: '10', current_price: '100' }], [{ symbol: 'AAPL', side: 'sell', type: 'trailing_stop', trail_percent: '5', qty: '10', status: 'new' }]);
  assert.equal(t.rows[0].covered, 1);
  assert.ok(close(t.openRiskUsd, 50));
});

test('runStrategy reports in-sample vs out-of-sample metrics on a 70/30 split', () => {
  const r = runStrategy(up, 'smaCross', validateParams('smaCross', {}).params);
  assert.ok(r.split.trainBars > 0 && r.split.testBars > 0);
  assert.ok(Math.abs(r.split.trainBars / (r.split.trainBars + r.split.testBars) - 0.7) < 0.02);
  for (const k of ['train', 'test', 'trainBuyHold', 'testBuyHold']) assert.ok(Number.isFinite(r.split[k].totalReturn), k);
});

test('parameter sweep: grid over 2 params, invalid combos null, 1-D sweep works', () => {
  const s = sweep(up, 'smaCross', 'fast', 'slow', {}, { steps: 5 });
  assert.equal(s.xs.length, 5);
  assert.equal(s.ys.length, 5);
  assert.equal(s.grid.length, 5);
  assert.ok(s.grid.flat().some((c) => c === null), 'fast >= slow cells are null');
  assert.ok(s.grid.flat().some((c) => c && Number.isFinite(c.totalReturn)));
  const one = sweep(up, 'score', 'threshold', null, {}, { steps: 4 });
  assert.equal(one.ys.length, 1);
  assert.equal(one.grid[0].length, 4);
  assert.throws(() => sweep(up, 'smaCross', 'nope', null, {}));
  assert.throws(() => sweep(up, 'smaCross', 'fast', 'fast', {}));
});

test('alerts: RSI and moving-average conditions', () => {
  const a = (type, value) => validateAlert({ symbol: 'AAPL', type, value }).alert;
  assert.equal(checkAlert(a('rsi_above', 70), { rsi: 75 }).hit, true);
  assert.equal(checkAlert(a('rsi_below', 30), { rsi: 35 }).hit, false);
  assert.equal(checkAlert(a('above_sma', 50), { price: 110, sma50: 100 }).hit, true);
  assert.equal(checkAlert(a('below_sma', 20), { price: 95, sma20: 100 }).hit, true);
  assert.equal(checkAlert(a('below_sma', 20), { price: 95 }).hit, false, 'missing SMA never fires');
  assert.equal(validateAlert({ symbol: 'AAPL', type: 'above_sma', value: 37 }).ok, false, 'only 20 or 50');
});
