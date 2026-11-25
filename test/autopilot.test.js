import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTask, validateFocus, allowedNow, isDue, tradeDecision, canTrade, ACTIVITIES } from '../lib/autopilot.js';
import { decide, validateWorkload } from '../lib/workloads.js';

// Monday 2026-11-23 10:00 local
const at = (h, m = 0, day = 23) => new Date(2026, 10, day, h, m);
const WEEKDAYS = [1, 2, 3, 4, 5];

test('validateTask: a day-trading task needs symbols, a known strategy and a bounded order size', () => {
  const bad = validateTask({ kind: 'trade', name: 'x', symbols: [], strategy: 'nope', orderUsd: -5, action: 'yolo' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /symbol/i.test(e)));
  assert.ok(bad.errors.some((e) => /strategy/i.test(e)));
  assert.ok(bad.errors.some((e) => /order size/i.test(e)));
  assert.ok(bad.errors.some((e) => /action/i.test(e)));
  const ok = validateTask({ kind: 'trade', name: 'Morning momentum', enabled: true, symbols: ['aapl', 'BTC/USD'], strategy: 'smaCross', params: { fast: 10, slow: 30 }, action: 'trade', orderUsd: 250, everyMin: 15,
    schedule: { hours: true, windows: [{ days: WEEKDAYS, start: '09:30', end: '16:00' }] } });
  assert.equal(ok.ok, true, ok.errors.join());
  assert.deepEqual(ok.task.symbols, ['AAPL', 'BTC/USD']);
  assert.equal(ok.task.activity, 'trade');
  assert.deepEqual(ok.task.params, { fast: 10, slow: 30 });
});

test('validateTask: DCA, tracking and learning tasks', () => {
  const dca = validateTask({ kind: 'dca', name: 'Weekly SPY', symbol: 'spy', amountUsd: 50, action: 'trade', cadence: { every: 'week', weekday: 1, at: '10:00' } });
  assert.equal(dca.ok, true, dca.errors.join());
  assert.equal(dca.task.activity, 'invest');
  assert.equal(validateTask({ kind: 'dca', name: 'x', symbol: 'SPY', amountUsd: 50, action: 'trade', cadence: { every: 'month', monthDay: 31, at: '10:00' } }).ok, false);
  assert.equal(validateTask({ kind: 'track', name: 'Scan', everyMin: 30, minScore: 70 }).ok, true);
  assert.equal(validateTask({ kind: 'track', name: 'Scan', everyMin: 1 }).ok, false); // too often
  const learn = validateTask({ kind: 'learn', name: 'Nightly reading', sources: ['finviz', 'messari-news', 'bogus'], everyMin: 1440 });
  assert.equal(learn.ok, false);
  assert.equal(validateTask({ kind: 'learn', name: 'Nightly', sources: ['finviz', 'traders'], finvizFilters: 'cap_large', everyMin: 1440 }).ok, true);
  assert.equal(validateTask({ kind: 'mystery', name: 'x' }).ok, false);
});

test('focus: manual list, or time slots that pick what may run', () => {
  assert.deepEqual([...allowedNow(validateFocus({ mode: 'manual', manual: ['mine', 'learn'] }).focus, at(10))].sort(), ['learn', 'mine']);
  const f = validateFocus({ mode: 'schedule', manual: ['mine'], slots: [
    { days: WEEKDAYS, start: '09:30', end: '16:00', allow: ['trade', 'track'] },
    { days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '07:00', allow: ['mine', 'learn'] },
  ] });
  assert.equal(f.ok, true, f.errors.join());
  assert.deepEqual([...allowedNow(f.focus, at(10))].sort(), ['track', 'trade']); // market hours
  assert.deepEqual([...allowedNow(f.focus, at(23))].sort(), ['learn', 'mine']); // overnight
  assert.deepEqual([...allowedNow(f.focus, at(18))], ['mine']); // no slot: falls back to the manual list
  assert.equal(validateFocus({ mode: 'manual', manual: ['nope'] }).ok, false);
  assert.ok(Object.keys(ACTIVITIES).includes('invest'));
});

test('isDue: interval tasks respect active hours and the interval; DCA runs once per due day after its time', () => {
  const t = validateTask({ kind: 'track', name: 'Scan', enabled: true, everyMin: 30, schedule: { hours: true, windows: [{ days: WEEKDAYS, start: '09:30', end: '16:00' }] } }).task;
  assert.equal(isDue(t, { now: at(10), lastRunAt: 0 }), true);
  assert.equal(isDue(t, { now: at(10), lastRunAt: at(9, 45).getTime() }), false);
  assert.equal(isDue(t, { now: at(10, 16), lastRunAt: at(9, 45).getTime() }), true);
  assert.equal(isDue(t, { now: at(8), lastRunAt: 0 }), false);
  assert.equal(isDue({ ...t, enabled: false }, { now: at(10), lastRunAt: 0 }), false);
  const d = validateTask({ kind: 'dca', name: 'W', enabled: true, symbol: 'SPY', amountUsd: 25, action: 'trade', cadence: { every: 'week', weekday: 1, at: '10:00' } }).task;
  assert.equal(isDue(d, { now: at(9, 59), lastRunAt: 0 }), false);
  assert.equal(isDue(d, { now: at(10, 5), lastRunAt: 0 }), true);
  assert.equal(isDue(d, { now: at(15), lastRunAt: at(10, 5).getTime() }), false); // already ran this week
  assert.equal(isDue(d, { now: at(10, 5, 24), lastRunAt: at(10, 5).getTime() }), false); // Tuesday after Monday's buy
  assert.equal(isDue(d, { now: at(10, 5, 24), lastRunAt: 0 }), true, 'a missed/refused weekly buy catches up later that week');
  const m = validateTask({ kind: 'dca', name: 'M', enabled: true, symbol: 'BTC/USD', amountUsd: 25, action: 'trade', cadence: { every: 'month', monthDay: 23, at: '08:00' } }).task;
  assert.equal(isDue(m, { now: at(9), lastRunAt: 0 }), true);
  assert.equal(isDue(m, { now: at(9, 0, 28), lastRunAt: at(9).getTime() }), false, 'once per month');
});

test('DCA: stock buys never fire on weekends (no market); a weekend-scheduled stock DCA is refused; crypto runs any day', () => {
  // Saturday 2026-11-28 and Sunday 2026-11-29
  const daily = validateTask({ kind: 'dca', name: 'D', enabled: true, symbol: 'SPY', amountUsd: 10, action: 'trade', cadence: { every: 'day', at: '10:00' } }).task;
  assert.equal(isDue(daily, { now: at(11, 0, 28), lastRunAt: 0 }), false);
  assert.equal(isDue(daily, { now: at(11, 0, 30), lastRunAt: 0 }), true); // Monday
  const monthly = validateTask({ kind: 'dca', name: 'M', enabled: true, symbol: 'SPY', amountUsd: 10, action: 'trade', cadence: { every: 'month', monthDay: 28, at: '10:00' } }).task;
  assert.equal(isDue(monthly, { now: at(11, 0, 30), lastRunAt: at(10, 0, 2).getTime() }), true, 'month day on a weekend -> next weekday');
  assert.equal(validateTask({ kind: 'dca', name: 'W', symbol: 'SPY', amountUsd: 10, action: 'trade', cadence: { every: 'week', weekday: 6, at: '10:00' } }).ok, false);
  const crypto = validateTask({ kind: 'dca', name: 'C', enabled: true, symbol: 'BTC/USD', amountUsd: 10, action: 'trade', cadence: { every: 'week', weekday: 6, at: '10:00' } });
  assert.equal(crypto.ok, true);
  assert.equal(isDue(crypto.task, { now: at(11, 0, 28), lastRunAt: 0 }), true);
});

test('tradeDecision: buy when the strategy wants in and nothing is held, sell the whole position when it wants out', () => {
  assert.deepEqual(tradeDecision({ symbol: 'AAPL', want: true, heldQty: 0, price: 200, orderUsd: 500 }),
    { action: 'buy', order: { symbol: 'AAPL', side: 'buy', type: 'market', notional: '500.00' } });
  assert.deepEqual(tradeDecision({ symbol: 'AAPL', want: false, heldQty: 3, price: 200, orderUsd: 500 }),
    { action: 'sell', order: { symbol: 'AAPL', side: 'sell', type: 'market', qty: '3' } });
  assert.equal(tradeDecision({ symbol: 'AAPL', want: true, heldQty: 2, price: 200, orderUsd: 500 }).action, 'hold');
  assert.equal(tradeDecision({ symbol: 'AAPL', want: false, heldQty: 0, price: 200, orderUsd: 500 }).action, 'hold');
  // stop-protected stock buy = whole-share bracket with a 2R target
  assert.deepEqual(tradeDecision({ symbol: 'AAPL', want: true, heldQty: 0, price: 200, orderUsd: 500, stopPct: 5 }).order,
    { symbol: 'AAPL', side: 'buy', type: 'market', qty: '2', stop_loss: '190.00', take_profit: '220.00' });
  assert.equal(tradeDecision({ symbol: 'AAPL', want: true, heldQty: 0, price: 900, orderUsd: 500, stopPct: 5 }).action, 'hold'); // < 1 share
  // crypto: no brackets on Alpaca, so stopPct is ignored and a notional buy is used
  assert.equal(tradeDecision({ symbol: 'BTC/USD', want: true, heldQty: 0, price: 60000, orderUsd: 100, stopPct: 5 }).order.notional, '100.00');
});

test('canTrade: paper needs a paper account; live needs a live account AND the autopilot acknowledgement', () => {
  assert.equal(canTrade({ action: 'alert' }, { mode: 'live', liveAck: false }).ok, true);
  assert.equal(canTrade({ action: 'trade' }, { mode: 'paper', liveAck: false }).ok, true);
  assert.equal(canTrade({ action: 'trade' }, { mode: 'live', liveAck: false }).ok, false);
  assert.equal(canTrade({ action: 'trade' }, { mode: 'live', liveAck: true }).ok, true);
});

test('workloads obey Focus: a miner stops when mining is not allowed right now', () => {
  const w = validateWorkload({ kind: 'xmrig-cpu', name: 'CPU', enabled: true, pool: 'stratum+tcp://pool.example.com:3333', payout: '4' + 'A'.repeat(94) }).workload;
  assert.equal(decide(w, { allowed: new Set(['mine']) }).run, true);
  const d = decide(w, { allowed: new Set(['trade']) });
  assert.equal(d.run, false);
  assert.match(d.reason, /Focus/);
  assert.equal(decide(w, {}).run, true); // no focus given = unrestricted (back-compatible)
});
