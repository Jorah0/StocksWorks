import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usMarketOpen } from '../lib/risk.js';
import { aiDue } from '../lib/autopilot.js';
import { createAuditLog } from '../lib/security.js';

test('usMarketOpen: NYSE regular hours in New York time, weekdays only', () => {
  // 2026-11-24 is a Tuesday. EST = UTC-5 in November.
  assert.equal(usMarketOpen(new Date('2026-11-24T14:29:00Z')), false, '09:29 ET');
  assert.equal(usMarketOpen(new Date('2026-11-24T14:30:00Z')), true, '09:30 ET');
  assert.equal(usMarketOpen(new Date('2026-11-24T20:59:00Z')), true, '15:59 ET');
  assert.equal(usMarketOpen(new Date('2026-11-24T21:00:00Z')), false, '16:00 ET');
  assert.equal(usMarketOpen(new Date('2026-11-28T15:00:00Z')), false, 'Saturday');
  assert.equal(usMarketOpen(new Date('2026-07-07T13:30:00Z')), true, 'summer EDT 09:30');
});

test('aiDue: the paid AI call repeats only when the pick changes, its score moves 10+, or 6 hours pass', () => {
  const t0 = Date.UTC(2026, 10, 24, 15);
  assert.equal(aiDue(null, 'AAPL', 80, t0), true);
  const last = { symbol: 'AAPL', score: 80, at: t0 };
  assert.equal(aiDue(last, 'AAPL', 84, t0 + 30 * 60_000), false, 'same pick, small move, 30 min later');
  assert.equal(aiDue(last, 'MSFT', 80, t0 + 60_000), true, 'new top pick');
  assert.equal(aiDue(last, 'AAPL', 91, t0 + 60_000), true, 'score moved 11');
  assert.equal(aiDue(last, 'AAPL', 80, t0 + 6 * 3600_000), true, '6 hours later');
});

test('audit: today\'s order count + notional are kept in memory (no re-reading the log), and survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  try {
    const a = createAuditLog(file);
    a.write({ type: 'order.placed', notional: 100 });
    a.write({ type: 'login' });
    a.write({ type: 'order.unknown', notional: 50 });
    a.write({ type: 'order.rejected', notional: 999 });
    const day = new Date().toISOString().slice(0, 10);
    assert.deepEqual(a.dayStats(day), { count: 2, notional: 150 });
    const reopened = createAuditLog(file);
    assert.deepEqual(reopened.dayStats(day), { count: 2, notional: 150 }, 'seeded once from the log at startup');
    assert.deepEqual(reopened.dayStats('2000-01-01'), { count: 0, notional: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
