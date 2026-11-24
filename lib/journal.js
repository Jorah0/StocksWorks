// Trade journal: the habit that turns trades into lessons. Validation + statistics (pure).
import { STOCK_RE, CRYPTO_RE } from './risk.js';

export const EMOTIONS = ['calm', 'confident', 'fearful', 'greedy', 'fomo', 'revenge', 'bored'];
export const OUTCOMES = ['open', 'win', 'loss', 'breakeven'];

export function validateEntry(raw = {}) {
  const errors = [];
  const str = (v, max, name) => { const s = String(v ?? '').trim(); if (s.length > max) errors.push(`${name}: up to ${max} characters`); return s.slice(0, max); };
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  if (!STOCK_RE.test(symbol) && !CRYPTO_RE.test(symbol)) errors.push('Invalid symbol');
  if (!['buy', 'sell'].includes(raw.side)) errors.push('Side must be buy or sell');
  if (!EMOTIONS.includes(raw.emotion)) errors.push(`Emotion must be one of: ${EMOTIONS.join(', ')}`);
  if (!OUTCOMES.includes(raw.outcome)) errors.push(`Outcome must be one of: ${OUTCOMES.join(', ')}`);
  const confidence = Number(raw.confidence);
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) errors.push('Confidence must be 1-5');
  let pnl = null;
  if (raw.pnl != null && raw.pnl !== '') {
    pnl = Number(raw.pnl);
    if (!Number.isFinite(pnl) || Math.abs(pnl) > 1e12) errors.push('P/L must be a number');
  }
  const entry = {
    symbol, side: raw.side, confidence, emotion: raw.emotion, outcome: raw.outcome, pnl,
    setup: str(raw.setup, 40, 'Setup').toLowerCase() || 'unspecified',
    thesis: str(raw.thesis, 2000, 'Thesis'), lesson: str(raw.lesson, 2000, 'Lesson'),
  };
  return { ok: errors.length === 0, errors, entry };
}

function group(entries, key) {
  const m = new Map();
  for (const e of entries) {
    const g = m.get(e[key]) ?? { [key]: e[key], n: 0, wins: 0, pnl: 0 };
    g.n++; g.wins += e.outcome === 'win' ? 1 : 0; g.pnl += e.pnl ?? 0;
    m.set(e[key], g);
  }
  return [...m.values()].map((g) => ({ ...g, winRate: g.wins / g.n })).sort((a, b) => b.pnl - a.pnl);
}

export function journalStats(entries) {
  const closed = entries.filter((e) => e.outcome !== 'open');
  const wins = closed.filter((e) => e.outcome === 'win'), losses = closed.filter((e) => e.outcome === 'loss');
  const sum = (a) => a.reduce((s, e) => s + (e.pnl ?? 0), 0);
  const totalPnl = sum(closed);
  return {
    total: entries.length, closed: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    totalPnl,
    expectancy: closed.length ? totalPnl / closed.length : null, // average P/L per closed trade
    avgWin: wins.length ? sum(wins) / wins.length : null,
    avgLoss: losses.length ? sum(losses) / losses.length : null,
    bySetup: group(closed, 'setup'),
    byEmotion: group(closed, 'emotion'),
  };
}
