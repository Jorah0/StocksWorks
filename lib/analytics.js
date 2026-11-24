// Portfolio and performance analytics. Pure functions, shared by server and browser.

export const pctReturns = (v) => v.slice(1).map((x, i) => x / v[i] - 1);
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
/** Annualized Sharpe ratio (risk-free rate taken as 0). null when volatility is zero. */
export function sharpe(returns, periods = 252) {
  const sd = stdev(returns);
  return sd < 1e-12 ? null : (mean(returns) / sd) * Math.sqrt(periods);
}
/** Annualized Sortino ratio: like Sharpe but only downside volatility counts. */
export function sortino(returns, periods = 252) {
  const downside = Math.sqrt(mean(returns.map((r) => Math.min(r, 0) ** 2)));
  return downside < 1e-12 ? null : (mean(returns) / downside) * Math.sqrt(periods);
}
export function maxDrawdown(eq) {
  let peak = eq[0], dd = 0;
  for (const x of eq) { peak = Math.max(peak, x); dd = Math.max(dd, 1 - x / peak); }
  return dd;
}
export const cagr = (eq, periods = 252) => (eq.length < 2 || !(eq[0] > 0) ? null : (eq.at(-1) / eq[0]) ** (periods / (eq.length - 1)) - 1);

export function summarizeEquity(eq, periods = 252) {
  const clean = eq.map(Number).filter((x) => x > 0);
  if (clean.length < 2) return { totalReturn: null, cagr: null, volAnnual: null, sharpe: null, sortino: null, maxDrawdown: null, bestDay: null, worstDay: null };
  const r = pctReturns(clean);
  return {
    totalReturn: clean.at(-1) / clean[0] - 1,
    cagr: cagr(clean, periods),
    volAnnual: stdev(r) * Math.sqrt(periods),
    sharpe: sharpe(r, periods),
    sortino: sortino(r, periods),
    maxDrawdown: maxDrawdown(clean),
    bestDay: Math.max(...r),
    worstDay: Math.min(...r),
  };
}

/** Pearson correlation over the overlapping tail of two series. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx < 1e-18 || syy < 1e-18 ? null : sxy / Math.sqrt(sxx * syy);
}

/** Correlation of daily returns over the last `days` bars, for {symbol: closes[]}. */
export function correlationMatrix(closesBySymbol, days = 60) {
  const symbols = Object.keys(closesBySymbol);
  const rets = symbols.map((s) => pctReturns(closesBySymbol[s].slice(-(days + 1))));
  return { symbols, matrix: symbols.map((_, i) => symbols.map((__, j) => (i === j ? 1 : correlation(rets[i], rets[j])))) };
}

/** Allocation from broker positions: weights, asset-class split, Herfindahl concentration (1 = one holding). */
export function allocation(positions) {
  const rows = positions.map((p) => ({
    symbol: p.symbol, value: Math.abs(Number(p.market_value) || 0), pl: Number(p.unrealized_pl) || 0,
    plPct: Number(p.unrealized_plpc) || 0, assetClass: p.asset_class === 'crypto' ? 'crypto' : 'stock',
  })).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  for (const r of rows) r.weight = total ? r.value / total : 0;
  const byClass = { stock: 0, crypto: 0 };
  for (const r of rows) byClass[r.assetClass] += r.weight;
  return {
    rows, total, byClass,
    hhi: rows.reduce((s, r) => s + r.weight ** 2, 0),
    topWeight: rows[0]?.weight ?? 0,
    unrealizedPl: rows.reduce((s, r) => s + r.pl, 0),
  };
}

/** Beta of an asset vs a benchmark from daily returns (cov/var). >1 amplifies market moves. */
export function beta(assetCloses, benchCloses, days = 120) {
  const a = pctReturns(assetCloses.slice(-(days + 1))), b = pctReturns(benchCloses.slice(-(days + 1)));
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
  let cov = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vy += (y[i] - my) ** 2; }
  return vy < 1e-18 ? null : cov / vy;
}

const PROTECTIVE = ['stop', 'stop_limit', 'trailing_stop'];
const OPEN = ['new', 'accepted', 'held', 'partially_filled', 'pending_new', 'accepted_for_bidding'];
/**
 * Which long positions are protected by an open sell stop / stop-limit / trailing stop (incl. bracket legs),
 * and how many dollars you'd lose if every stop were hit at its current level ("open risk").
 */
export function stopCoverage(positions, orders) {
  const flat = orders.flatMap((o) => [o, ...(o.legs ?? [])]);
  const norm = (s) => String(s).replace('/', '');
  const rows = positions.filter((p) => Number(p.qty) > 0).map((p) => {
    const qty = Number(p.qty), price = Number(p.current_price);
    let protQty = 0, risk = 0;
    for (const o of flat) {
      if (norm(o.symbol) !== norm(p.symbol) || o.side !== 'sell' || !PROTECTIVE.includes(o.type) || !OPEN.includes(o.status)) continue;
      const q = Math.min(Number(o.qty) || 0, qty - protQty);
      if (q <= 0) break;
      protQty += q;
      const stop = o.type === 'trailing_stop' ? price * (1 - Number(o.trail_percent) / 100) : Number(o.stop_price);
      if (stop > 0 && price > 0) risk += q * Math.max(0, price - stop);
    }
    return { symbol: p.symbol, qty, covered: qty ? protQty / qty : 0, riskUsd: protQty ? risk : null };
  });
  return {
    rows,
    unprotected: rows.filter((r) => r.covered < 0.999).map((r) => r.symbol),
    openRiskUsd: rows.reduce((s, r) => s + (r.riskUsd ?? 0), 0),
  };
}
