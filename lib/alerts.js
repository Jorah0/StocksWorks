// Price / move / score alerts. Validation + evaluation are pure; the server runs the polling loop.
import { STOCK_RE, CRYPTO_RE } from './risk.js';

export const ALERT_TYPES = {
  price_above: { label: 'Price rises above', unit: '$', min: 1e-9, max: 1e9 },
  price_below: { label: 'Price falls below', unit: '$', min: 1e-9, max: 1e9 },
  day_change_pct: { label: 'Moves more than (± % today)', unit: '%', min: 0.1, max: 100 },
  score_above: { label: 'AI score rises above', unit: 'pts', min: 0, max: 100 },
  score_below: { label: 'AI score falls below', unit: 'pts', min: 0, max: 100 },
  rsi_above: { label: 'RSI(14) rises above (overbought)', unit: 'RSI', min: 1, max: 99 },
  rsi_below: { label: 'RSI(14) falls below (oversold)', unit: 'RSI', min: 1, max: 99 },
  above_sma: { label: 'Price is above its moving average', unit: '-day SMA', min: 20, max: 50, choices: [20, 50] },
  below_sma: { label: 'Price is below its moving average', unit: '-day SMA', min: 20, max: 50, choices: [20, 50] },
};

export function validateAlert(raw = {}) {
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  const type = String(raw.type ?? '');
  const value = Number(raw.value);
  const note = String(raw.note ?? '').trim();
  const errors = [];
  if (!STOCK_RE.test(symbol) && !CRYPTO_RE.test(symbol)) errors.push('Invalid symbol');
  const spec = Object.hasOwn(ALERT_TYPES, type) ? ALERT_TYPES[type] : null;
  if (!spec) errors.push('Unknown alert type');
  else if (spec.choices && !spec.choices.includes(value)) errors.push(`Value must be one of: ${spec.choices.join(', ')}`);
  else if (!Number.isFinite(value) || value < spec.min || value > spec.max) errors.push(`Value must be ${spec.min}-${spec.max}`);
  if (note.length > 80) errors.push('Note: up to 80 characters');
  return { ok: errors.length === 0, errors, alert: { symbol, type, value, note, armed: true } };
}

/** m = {price, prevClose, score}; missing data never fires. */
export function checkAlert(a, m = {}) {
  const price = Number(m.price), prev = Number(m.prevClose), score = m.score == null ? NaN : Number(m.score);
  switch (a.type) {
    case 'price_above': return { hit: price > a.value, observed: price };
    case 'price_below': return { hit: price > 0 && price < a.value, observed: price };
    case 'day_change_pct': {
      const ch = price > 0 && prev > 0 ? (price / prev - 1) * 100 : NaN;
      return { hit: Math.abs(ch) >= a.value, observed: ch };
    }
    case 'score_above': return { hit: score > a.value, observed: score };
    case 'score_below': return { hit: score < a.value, observed: score };
    case 'rsi_above': case 'rsi_below': {
      const r = m.rsi == null ? NaN : Number(m.rsi);
      return { hit: a.type === 'rsi_above' ? r > a.value : r < a.value, observed: r };
    }
    case 'above_sma': case 'below_sma': {
      const sma = Number(a.value === 20 ? m.sma20 : m.sma50);
      const ok = price > 0 && sma > 0;
      return { hit: ok && (a.type === 'above_sma' ? price > sma : price < sma), observed: price };
    }
    default: return { hit: false, observed: null };
  }
}
