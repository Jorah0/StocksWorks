import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrder } from '../lib/risk.js';

const limits = { maxOrderUsd: 1000, maxOrdersPerDay: 5, maxPositionPct: 10, maxLimitDeviationPct: 10 };
const ctx = (o = {}) => ({ mode: 'paper', killSwitch: false, price: 100, equity: 100_000, ordersToday: 0, limits, ...o });

test('accepts a sane paper market order and normalizes it', () => {
  const r = validateOrder({ symbol: 'aapl', side: 'buy', type: 'market', qty: '2' }, ctx());
  assert.equal(r.ok, true, r.errors.join());
  assert.deepEqual(r.order, { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: '2' });
  assert.equal(r.notional, 200);
});

test('crypto orders use gtc and allow fractional qty', () => {
  const r = validateOrder({ symbol: 'BTC/USD', side: 'buy', type: 'market', qty: '0.001' }, ctx({ price: 90_000 }));
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(r.order.time_in_force, 'gtc');
});

test('rejects bad input', () => {
  for (const o of [
    { symbol: 'AAPL; DROP', side: 'buy', type: 'market', qty: '1' },
    { symbol: 'AAPL', side: 'short', type: 'market', qty: '1' },
    { symbol: 'AAPL', side: 'buy', type: 'stop', qty: '1' },
    { symbol: 'AAPL', side: 'buy', type: 'market', qty: '-1' },
    { symbol: 'AAPL', side: 'buy', type: 'market', qty: '1e3' },
    { symbol: 'AAPL', side: 'buy', type: 'market' },
    { symbol: 'AAPL', side: 'buy', type: 'market', qty: '1', notional: '10' },
    { symbol: 'AAPL', side: 'buy', type: 'limit', qty: '1' },
  ]) assert.equal(validateOrder(o, ctx()).ok, false, JSON.stringify(o));
});

test('enforces guardrails', () => {
  const o = { symbol: 'AAPL', side: 'buy', type: 'market', qty: '1' };
  assert.match(validateOrder(o, ctx({ killSwitch: true })).errors.join(), /kill switch/i);
  assert.match(validateOrder({ ...o, qty: '11' }, ctx()).errors.join(), /max order/i);
  assert.match(validateOrder(o, ctx({ ordersToday: 5 })).errors.join(), /daily/i);
  assert.match(validateOrder({ ...o, qty: '9' }, ctx({ equity: 5000 })).errors.join(), /equity/i);
  assert.match(validateOrder({ ...o, type: 'limit', limit_price: '150' }, ctx()).errors.join(), /fat-finger|deviat/i);
  assert.match(validateOrder(o, ctx({ price: null })).errors.join(), /price/i);
});

test('live mode needs a server-verified confirmation (a client flag is not enough)', () => {
  const o = { symbol: 'AAPL', side: 'buy', type: 'market', qty: '1' };
  assert.equal(validateOrder(o, ctx({ mode: 'live' })).ok, false);
  assert.equal(validateOrder({ ...o, confirm: true }, ctx({ mode: 'live' })).ok, false, 'body flag ignored');
  assert.equal(validateOrder(o, ctx({ mode: 'live', confirmed: true })).ok, true);
});

test('daily notional cap counts what was already traded today', () => {
  const L2 = { ...limits, maxDailyNotionalUsd: 2000 };
  const o = { symbol: 'AAPL', side: 'buy', type: 'market', qty: '5' }; // $500
  assert.equal(validateOrder(o, ctx({ limits: L2, notionalToday: 1500 })).ok, true);
  assert.match(validateOrder(o, ctx({ limits: L2, notionalToday: 1600 })).errors.join(), /daily/i);
});

test('stale reference price blocks market orders but not limit orders', () => {
  const L2 = { ...limits, maxPriceAgeSec: 900 };
  const m = { symbol: 'AAPL', side: 'buy', type: 'market', qty: '1' };
  assert.equal(validateOrder(m, ctx({ limits: L2, priceAgeSec: 60 })).ok, true);
  assert.match(validateOrder(m, ctx({ limits: L2, priceAgeSec: 4000 })).errors.join(), /old|stale/i);
  assert.equal(validateOrder({ ...m, type: 'limit', limit_price: '100' }, ctx({ limits: L2, priceAgeSec: 4000 })).ok, true);
  assert.match(validateOrder(m, ctx({ limits: L2, priceAgeSec: null })).errors.join(), /unknown|stale|old/i, 'unknown age fails closed');
});

test('REQUIRE_STOP makes a stop-loss mandatory on buys (not on sells)', () => {
  const L2 = { ...limits, requireStop: true };
  assert.match(validateOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: '1' }, ctx({ limits: L2 })).errors.join(), /stop/i);
  assert.equal(validateOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: '1', stop_loss: '95', take_profit: '110' }, ctx({ limits: L2 })).ok, true);
  assert.equal(validateOrder({ symbol: 'AAPL', side: 'sell', type: 'market', qty: '1' }, ctx({ limits: L2, heldQty: 1 })).ok, true);
});

test('bracket orders: stop below entry below target, whole shares, risk per trade capped', () => {
  const L2 = { ...limits, maxRiskPerTradePct: 1 };
  const b = { symbol: 'AAPL', side: 'buy', type: 'market', qty: '5', stop_loss: '95', take_profit: '110' };
  const r = validateOrder(b, ctx({ limits: L2 }));
  assert.equal(r.ok, true, r.errors.join());
  assert.deepEqual(r.order.stop_loss, { stop_price: '95' });
  assert.deepEqual(r.order.take_profit, { limit_price: '110' });
  assert.equal(r.order.order_class, 'bracket');
  assert.equal(r.riskUsd, 25);
  assert.match(validateOrder({ ...b, stop_loss: '101' }, ctx({ limits: L2 })).errors.join(), /stop/i);
  assert.match(validateOrder({ ...b, take_profit: '99' }, ctx({ limits: L2 })).errors.join(), /target|take/i);
  assert.match(validateOrder({ ...b, qty: '1.5' }, ctx({ limits: L2 })).errors.join(), /whole/i);
  assert.match(validateOrder({ ...b, side: 'sell' }, ctx({ limits: L2, heldQty: 10 })).errors.join(), /buy/i);
  assert.match(validateOrder({ ...b, symbol: 'BTC/USD', qty: '1' }, ctx({ limits: L2 })).errors.join(), /stock/i);
  // $1000 risk on $100k at 1% => stop 2 below entry on 5 shares is $10; widen to trip it
  assert.match(validateOrder({ ...b, qty: '9', stop_loss: '1' }, ctx({ limits: { ...L2, maxOrderUsd: 5000 }, equity: 10_000, heldValue: 0 })).errors.join(), /risk/i);
});

test('sells are not blocked by concentration limit (reducing risk)', () => {
  const r = validateOrder({ symbol: 'AAPL', side: 'sell', type: 'market', qty: '9' }, ctx({ equity: 5000, heldQty: 9 }));
  assert.equal(r.ok, true, r.errors.join());
});

test('no accidental shorting: sell size is capped at the held quantity', () => {
  const o = { symbol: 'AAPL', side: 'sell', type: 'market', qty: '5' };
  assert.match(validateOrder(o, ctx({ heldQty: 0 })).errors.join(), /hold/i);
  assert.match(validateOrder(o, ctx({ heldQty: 4 })).errors.join(), /hold/i);
  assert.match(validateOrder({ ...o, qty: undefined, notional: '600' }, ctx({ heldQty: 5 })).errors.join(), /hold/i);
  assert.equal(validateOrder(o, ctx({ heldQty: 5 })).ok, true);
});

test('position cap counts existing holdings, and fails closed without equity', () => {
  const o = { symbol: 'AAPL', side: 'buy', type: 'market', qty: '5' }; // $500
  assert.equal(validateOrder(o, ctx({ equity: 10_000, heldValue: 400 })).ok, true); // 900 <= 1000
  assert.match(validateOrder(o, ctx({ equity: 10_000, heldValue: 600 })).errors.join(), /equity/i);
  assert.match(validateOrder(o, ctx({ equity: 0 })).errors.join(), /equity/i);
  assert.match(validateOrder(o, ctx({ equity: NaN })).errors.join(), /equity/i);
});
