import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, scoreSeries, backtest } from '../lib/signals.js';
import { miningProfit } from '../lib/mining.js';

test('sma / ema basics', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1], 2), null);
  const e = ema([1, 1, 1, 1], 3);
  assert.equal(e.at(-1), 1);
});

test('rsi: all gains -> 100, all losses -> 0', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = up.slice().reverse();
  assert.equal(rsi(up, 14), 100);
  assert.equal(rsi(down, 14), 0);
});

test('score ranks a steady uptrend above a downtrend, stays in 0..100', () => {
  const up = Array.from({ length: 120 }, (_, i) => 100 * 1.004 ** i + Math.sin(i) * 0.5);
  const down = Array.from({ length: 120 }, (_, i) => 100 * 0.996 ** i + Math.sin(i) * 0.5);
  const a = scoreSeries(up), b = scoreSeries(down);
  assert.ok(a.score > b.score, `${a.score} vs ${b.score}`);
  for (const s of [a, b]) assert.ok(s.score >= 0 && s.score <= 100);
  assert.equal(scoreSeries([1, 2, 3]), null, 'not enough history');
});

test('backtest has no look-ahead and reports buy&hold', () => {
  const closes = Array.from({ length: 150 }, (_, i) => 100 + i);
  const r = backtest(closes, { threshold: 101 }); // never invested
  assert.equal(r.strategyReturn, 0);
  assert.equal(r.trades, 0);
  assert.ok(r.buyHoldReturn > 0);
});

test('mining profit math', () => {
  // 100 TH/s on a 1000 EH/s network = 1e-7 share; 144 blocks * 3.125 BTC
  const r = miningProfit({ hashrateTHs: 100, watts: 3000, kwhUsd: 0.1, poolFeePct: 0, networkHashrateEHs: 1000, blockRewardBtc: 3.125, feesPerBlockBtc: 0, btcUsd: 100_000 });
  assert.ok(Math.abs(r.btcPerDay - 4.5e-5) < 1e-12);
  assert.ok(Math.abs(r.revenueUsd - 4.5) < 1e-9);
  assert.ok(Math.abs(r.powerUsd - 7.2) < 1e-9);
  assert.ok(r.profitUsd < 0);
  assert.ok(Math.abs(r.breakevenKwhUsd - 0.0625) < 1e-9);
});
