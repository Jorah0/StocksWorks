// Strategy Lab: rule-based strategies on daily closes, walk-forward (decision at bar i uses only closes[0..i]).
import { sma, rsi, scoreSeries } from './signals.js';
import { summarizeEquity } from './analytics.js';

export const STRATEGIES = {
  score: {
    label: 'StocksWorks composite score', about: 'Hold while the 0-100 score (trend, momentum, RSI, MACD) is at or above the threshold.',
    params: { threshold: { label: 'Score threshold', min: 30, max: 90, def: 60 } },
  },
  smaCross: {
    label: 'Moving-average crossover', about: 'Hold while the fast SMA is above the slow SMA (classic trend following).',
    params: { fast: { label: 'Fast SMA', min: 2, max: 100, def: 20 }, slow: { label: 'Slow SMA', min: 5, max: 250, def: 50 } },
  },
  rsiReversion: {
    label: 'RSI mean reversion', about: 'Buy when RSI drops below the buy level; sell once it recovers above the exit level.',
    params: { period: { label: 'RSI period', min: 2, max: 50, def: 14 }, buyBelow: { label: 'Buy below', min: 5, max: 50, def: 30 }, sellAbove: { label: 'Sell above', min: 40, max: 95, def: 55 } },
  },
  breakout: {
    label: 'Donchian breakout', about: 'Buy a close above the N-day high; exit on a close below the M-day low (turtle-style).',
    params: { entry: { label: 'Entry lookback', min: 5, max: 200, def: 55 }, exit: { label: 'Exit lookback', min: 3, max: 100, def: 20 } },
  },
};

export function validateParams(name, raw = {}) {
  if (!Object.hasOwn(STRATEGIES, name)) return { ok: false, errors: ['Unknown strategy'], params: null };
  const errors = [], params = {};
  for (const [k, spec] of Object.entries(STRATEGIES[name].params)) {
    const v = raw?.[k] == null || raw[k] === '' ? spec.def : Number(raw[k]);
    if (!Number.isInteger(v) || v < spec.min || v > spec.max) errors.push(`${spec.label} must be a whole number ${spec.min}-${spec.max}`);
    params[k] = v;
  }
  if (name === 'smaCross' && !(params.fast < params.slow)) errors.push('Fast SMA must be shorter than slow SMA');
  if (name === 'rsiReversion' && !(params.buyBelow < params.sellAbove)) errors.push('Buy level must be below the exit level');
  return { ok: errors.length === 0, errors, params };
}

const warmupFor = (name, p) => ({ score: 60, smaCross: p.slow, rsiReversion: p.period + 1, breakout: Math.max(p.entry, p.exit) })[name];

function wants(name, c, i, p, inPos) {
  const hist = c.slice(0, i + 1);
  switch (name) {
    case 'score': return (scoreSeries(hist)?.score ?? 0) >= p.threshold;
    case 'smaCross': return sma(hist, p.fast) > sma(hist, p.slow);
    case 'rsiReversion': { const r = rsi(hist, p.period); return inPos ? r < p.sellAbove : r < p.buyBelow; }
    case 'breakout': return inPos ? c[i] >= Math.min(...c.slice(i - p.exit, i)) : c[i] > Math.max(...c.slice(i - p.entry, i));
    default: return false;
  }
}

/**
 * ponytail: re-slices history each bar (O(n^2)); fine for ~2 years of daily bars, use incremental indicators for intraday.
 * @returns {equity[], buyHold[], trades[], metrics, buyHoldMetrics, exposure, winRate, avgTradeReturn, warmup}
 */
export function runStrategy(c, name, p, { feeBps = 5 } = {}) {
  const warmup = warmupFor(name, p);
  if (c.length < warmup + 10) throw new Error(`Need at least ${warmup + 10} bars of history for this strategy`);
  const equity = [1], trades = [];
  let inPos = false, held = 0, open = null;
  for (let i = warmup; i < c.length - 1; i++) {
    const want = wants(name, c, i, p, inPos);
    let eq = equity.at(-1);
    if (want !== inPos) {
      eq *= 1 - feeBps / 1e4;
      if (want) open = { entryIdx: i, entry: c[i] };
      else { trades.push({ ...open, exitIdx: i, exit: c[i], ret: c[i] / open.entry - 1 }); open = null; }
      inPos = want;
    }
    if (inPos) { eq *= c[i + 1] / c[i]; held++; }
    equity.push(eq);
  }
  if (open) trades.push({ ...open, exitIdx: c.length - 1, exit: c.at(-1), ret: c.at(-1) / open.entry - 1, open: true });
  const buyHold = c.slice(warmup).map((x) => x / c[warmup]);
  const closed = trades.filter((t) => !t.open);
  // In-sample (first 70%) vs out-of-sample (last 30%): did the edge persist on data you did not tune on?
  const k = Math.round((equity.length - 1) * 0.7);
  const split = { trainBars: k, testBars: equity.length - 1 - k, train: summarizeEquity(equity.slice(0, k + 1)), test: summarizeEquity(equity.slice(k)),
    trainBuyHold: summarizeEquity(buyHold.slice(0, k + 1)), testBuyHold: summarizeEquity(buyHold.slice(k)) };
  return {
    equity, buyHold, trades, warmup, split,
    metrics: summarizeEquity(equity), buyHoldMetrics: summarizeEquity(buyHold),
    exposure: held / Math.max(1, c.length - 1 - warmup),
    winRate: closed.length ? closed.filter((t) => t.ret > 0).length / closed.length : null,
    avgTradeReturn: trades.length ? trades.reduce((s, t) => s + t.ret, 0) / trades.length : null,
  };
}

/**
 * Parameter sweep: rerun a strategy over a grid of one or two parameters to see whether a result is robust
 * (a broad region of good settings) or fragile (one lucky cell). Invalid combinations come back null.
 */
export function sweep(c, name, xKey, yKey, base = {}, { steps = 6 } = {}) {
  if (!Object.hasOwn(STRATEGIES, name)) throw new Error('Unknown strategy');
  const spec = STRATEGIES[name].params;
  if (!Object.hasOwn(spec, xKey) || (yKey != null && (!Object.hasOwn(spec, yKey) || yKey === xKey))) throw new Error('Pick one or two different parameters of this strategy');
  const n = Math.max(2, Math.min(8, Math.floor(steps)));
  const values = (k) => [...new Set(Array.from({ length: n }, (_, i) => Math.round(spec[k].min + ((spec[k].max - spec[k].min) * i) / (n - 1))))];
  const xs = values(xKey), ys = yKey ? values(yKey) : [null];
  const grid = ys.map((y) => xs.map((x) => {
    const v = validateParams(name, { ...base, [xKey]: x, ...(yKey ? { [yKey]: y } : {}) });
    if (!v.ok) return null;
    try {
      const r = runStrategy(c, name, v.params);
      return { totalReturn: r.metrics.totalReturn, sharpe: r.metrics.sharpe, maxDrawdown: r.metrics.maxDrawdown, trades: r.trades.length };
    } catch { return null; }
  }));
  return { strategy: name, xKey, yKey, xs, ys, grid };
}
