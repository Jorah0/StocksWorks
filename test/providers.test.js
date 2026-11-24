import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlpaca, balanceOf } from '../lib/providers.js';

// Regression: missing keys used to throw synchronously inside Promise.all, leaving a sibling
// rejection unhandled and crashing the server process.
test('unconfigured Alpaca methods reject (never throw synchronously)', async () => {
  const a = createAlpaca({ mode: 'paper' });
  for (const call of [() => a.account(), () => a.positions(), () => a.orders(), () => a.lastPrice('AAPL'), () => a.bars('BTC/USD'), () => a.placeOrder({})]) {
    let p;
    assert.doesNotThrow(() => { p = call(); });
    await assert.rejects(p, (e) => e.status === 503);
  }
});

test('wallet lookups reject invalid addresses before any network call', async () => {
  await assert.rejects(balanceOf('eth', '0x123', 'http://unused'), (e) => e.status === 400);
  await assert.rejects(balanceOf('btc', 'bc1q<script>', 'http://unused'), (e) => e.status === 400);
  await assert.rejects(balanceOf('__proto__', 'x', 'http://unused'), (e) => e.status === 400);
});
