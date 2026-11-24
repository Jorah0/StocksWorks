// Technical indicators + a transparent composite score. Every point of the score is explainable in the UI.

export const sma = (v, n) => (v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n);

export function ema(v, n) {
  const k = 2 / (n + 1);
  const out = [v[0]];
  for (let i = 1; i < v.length; i++) out.push(v[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Wilder RSI, last value. */
export function rsi(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function macd(c) {
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const line = c.map((_, i) => e12[i] - e26[i]);
  const signal = ema(line, 9);
  return line.map((v, i) => v - signal[i]); // histogram
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Composite 0-100 score from daily closes (needs >= 60 bars).
 *   trend 30 | momentum 30 | RSI zone 20 | MACD 20
 * It ranks historical setup quality. It is NOT a price forecast.
 */
export function scoreSeries(c) {
  if (!Array.isArray(c) || c.length < 60) return null;
  const price = c.at(-1);
  const s20 = sma(c, 20), s50 = sma(c, 50), s50prev = sma(c.slice(0, -10), 50);
  const trend = (price > s50 ? 15 : 0) + (s20 > s50 ? 10 : 0) + (s50 > s50prev ? 5 : 0);
  const r20 = price / c.at(-21) - 1;
  const momentum = 15 + clamp(r20 * 100, -15, 15);
  const r = rsi(c, 14);
  const rsiPts = r > 75 ? 4 : r > 65 ? 12 : r >= 45 ? 20 : r >= 30 ? 12 : 8;
  const h = macd(c);
  const macdPts = (h.at(-1) > 0 ? 10 : 0) + (h.at(-1) > h.at(-2) ? 10 : 0);
  const rets = c.slice(-61).slice(1).map((v, i) => Math.log(v / c.slice(-61)[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const dailyVol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  return {
    score: Math.round(trend + momentum + rsiPts + macdPts),
    components: { trend, momentum: Math.round(momentum), rsi: rsiPts, macd: macdPts },
    metrics: {
      price, sma20: s20, sma50: s50, rsi14: r, macdHist: h.at(-1), return20d: r20,
      volAnnual: dailyVol * Math.sqrt(252),
      // 1-sigma 20-trading-day move implied by recent volatility (a range, not a direction)
      expectedMove20d: price * dailyVol * Math.sqrt(20),
    },
  };
}

/**
 * Walk-forward test: hold for the next bar when score(at close of bar i) >= threshold.
 * Decision at i uses only closes[0..i] (no look-ahead). Fee charged on every position change.
 * ponytail: O(n^2) re-scoring; fine for ~500 daily bars, switch to incremental indicators for intraday data.
 */
export function backtest(c, { threshold = 60, warmup = 60, feeBps = 5 } = {}) {
  let eq = 1, peak = 1, maxDD = 0, inPos = false, trades = 0, held = 0;
  for (let i = warmup; i < c.length - 1; i++) {
    const want = scoreSeries(c.slice(0, i + 1)).score >= threshold;
    if (want !== inPos) { eq *= 1 - feeBps / 1e4; trades++; inPos = want; }
    if (inPos) { eq *= c[i + 1] / c[i]; held++; }
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
  }
  const bars = Math.max(1, c.length - 1 - warmup);
  return {
    strategyReturn: eq - 1,
    buyHoldReturn: c.length > warmup ? c.at(-1) / c[warmup] - 1 : 0,
    trades, exposure: held / bars, maxDrawdown: maxDD, bars,
  };
}
