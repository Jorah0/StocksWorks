// Autopilot: the user decides what runs when. Pure rules (tested); server.js does the work.
// Focus = which activities may run right now (manual list, or time slots). Tasks = market tracking,
// day trading, recurring buys (DCA) and AI learning, each on its own schedule. Every order a task makes
// goes through the same risk gate and kill switch as a hand-placed order (server.js placeOrder).
import { validateSchedule, inWindow } from './workloads.js';
import { STRATEGIES, validateParams } from './strategies.js';
import { STOCK_RE, CRYPTO_RE, isCrypto } from './risk.js';

export const ACTIVITIES = {
  mine: 'Mining (CPU/GPU miners on this PC)',
  share: 'Compute sharing (BOINC etc.)',
  trade: 'Day trading tasks',
  track: 'Market tracking & scans',
  invest: 'Recurring buys (DCA)',
  learn: 'AI learning & research',
};
export const TASK_KINDS = {
  track: { label: 'Market tracking: scan symbols and alert on strong signals', activity: 'track' },
  trade: { label: 'Day trading: run a strategy and act on its signal', activity: 'trade' },
  dca: { label: 'Recurring buy (dollar-cost averaging)', activity: 'invest' },
  learn: { label: 'AI learning: pull research into the AI corpus', activity: 'learn' },
};
export const LEARN_SOURCES = ['finviz', 'messari-news', 'traders', 'dossiers', 'macro'];
const NAME_RE = /^[\w .,()'&+-]{1,40}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const validSym = (s) => STOCK_RE.test(s) || CRYPTO_RE.test(s);
const acts = (a) => [...new Set(Array.isArray(a) ? a.map(String) : [])];

export function validateFocus(f = {}) {
  const errors = [];
  const mode = f.mode === 'schedule' ? 'schedule' : 'manual';
  const manual = acts(f.manual ?? Object.keys(ACTIVITIES));
  if (manual.some((a) => !Object.hasOwn(ACTIVITIES, a))) errors.push('Unknown activity');
  const slots = [];
  for (const sl of (Array.isArray(f.slots) ? f.slots : []).slice(0, 12)) {
    const days = [...new Set(Array.isArray(sl?.days) ? sl.days.map(Number) : [])];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Each time slot needs at least one day');
    if (!HHMM_RE.test(sl?.start) || !HHMM_RE.test(sl?.end) || sl.start === sl.end) errors.push('Time slots use HH:MM and the start differs from the end');
    const allow = acts(sl?.allow);
    if (allow.some((a) => !Object.hasOwn(ACTIVITIES, a))) errors.push('Unknown activity in a time slot');
    slots.push({ days, start: String(sl?.start), end: String(sl?.end), allow });
  }
  if (mode === 'schedule' && !slots.length) errors.push('Schedule mode needs at least one time slot');
  return { ok: errors.length === 0, errors, focus: { mode, manual, slots } };
}

/** First matching slot wins; outside every slot (or in manual mode) the manual list applies. */
export function allowedNow(focus, now = new Date()) {
  if (focus?.mode === 'schedule') {
    const slot = focus.slots.find((s) => inWindow(s, now));
    if (slot) return new Set(slot.allow);
  }
  return new Set(focus?.manual ?? Object.keys(ACTIVITIES));
}

export function validateTask(t = {}) {
  const errors = [];
  const kind = String(t.kind ?? '');
  const k = Object.hasOwn(TASK_KINDS, kind) ? TASK_KINDS[kind] : null;
  if (!k) return { ok: false, errors: ['Unknown task type'], task: null };
  const name = String(t.name ?? '').trim().slice(0, 40) || k.label.split(':')[0];
  if (!NAME_RE.test(name)) errors.push('Name: letters, digits, spaces and . , ( ) \' & + - only');
  const out = { kind, activity: k.activity, name, enabled: t.enabled === true };
  if (kind !== 'dca') {
    out.everyMin = t.everyMin == null ? 30 : Number(t.everyMin);
    if (!Number.isInteger(out.everyMin) || out.everyMin < 5 || out.everyMin > 1440) errors.push('Run every: 5-1440 minutes');
    out.schedule = validateSchedule(t.schedule ?? {}, errors);
  }
  const symbols = (Array.isArray(t.symbols) ? t.symbols : String(t.symbols ?? '').split(/[\s,]+/)).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const action = () => {
    out.action = t.action;
    if (!['alert', 'trade'].includes(out.action)) errors.push('Action: alert (notify only) or trade (place orders)');
  };
  if (kind === 'track') {
    out.symbols = [...new Set(symbols)].slice(0, 20);
    if (out.symbols.some((s) => !validSym(s))) errors.push('Symbols: stocks (AAPL) or crypto (BTC/USD); empty = your watchlist');
    out.minScore = t.minScore == null ? 70 : Number(t.minScore);
    if (!Number.isInteger(out.minScore) || out.minScore < 0 || out.minScore > 100) errors.push('Alert score: 0-100');
    out.aiTop = t.aiTop === true;
  } else if (kind === 'trade') {
    out.symbols = [...new Set(symbols)];
    if (!out.symbols.length || out.symbols.length > 10 || out.symbols.some((s) => !validSym(s))) errors.push('Symbols: 1-10 stocks (AAPL) or crypto (BTC/USD)');
    out.strategy = String(t.strategy ?? '');
    const v = validateParams(out.strategy, t.params);
    if (!v.ok) errors.push(...v.errors.map((e) => (e === 'Unknown strategy' ? 'Unknown strategy' : `Strategy: ${e}`)));
    out.params = v.params;
    action();
    out.orderUsd = Number(t.orderUsd);
    if (!(out.orderUsd >= 1 && out.orderUsd <= 1_000_000)) errors.push('Order size: $1-$1,000,000 per trade');
    out.stopPct = t.stopPct == null || t.stopPct === '' ? 0 : Number(t.stopPct);
    if (!(out.stopPct >= 0 && out.stopPct <= 50)) errors.push('Stop-loss: 0-50 % (0 = none)');
  } else if (kind === 'dca') {
    out.symbol = String(t.symbol ?? '').trim().toUpperCase();
    if (!validSym(out.symbol)) errors.push('Symbol: a stock/ETF (SPY) or crypto (BTC/USD)');
    out.amountUsd = Number(t.amountUsd);
    if (!(out.amountUsd >= 1 && out.amountUsd <= 1_000_000)) errors.push('Amount: $1-$1,000,000 per buy');
    action();
    const c = t.cadence ?? {};
    out.cadence = { every: c.every, at: String(c.at ?? '') };
    if (!['day', 'week', 'month'].includes(c.every)) errors.push('Repeat: every day, week or month');
    if (!HHMM_RE.test(out.cadence.at)) errors.push('Time: HH:MM');
    if (c.every === 'week') {
      out.cadence.weekday = Number(c.weekday);
      if (!Number.isInteger(out.cadence.weekday) || out.cadence.weekday < 0 || out.cadence.weekday > 6) errors.push('Weekday: 0 (Sun) - 6 (Sat)');
      else if ([0, 6].includes(out.cadence.weekday) && STOCK_RE.test(out.symbol)) errors.push('Stocks/ETFs trade Monday-Friday: pick a weekday (crypto can use any day)');
    }
    if (c.every === 'month') { out.cadence.monthDay = Number(c.monthDay); if (!Number.isInteger(out.cadence.monthDay) || out.cadence.monthDay < 1 || out.cadence.monthDay > 28) errors.push('Day of month: 1-28 (every month has these)'); }
  } else if (kind === 'learn') {
    out.sources = acts(t.sources);
    if (!out.sources.length || out.sources.some((x) => !LEARN_SOURCES.includes(x))) errors.push(`Sources: one or more of ${LEARN_SOURCES.join(', ')}`);
    out.finvizFilters = String(t.finvizFilters ?? '').trim();
    if (!/^[a-z0-9_.,-]{0,300}$/.test(out.finvizFilters)) errors.push('Finviz filters: filter codes separated by commas');
  }
  return { ok: errors.length === 0, errors, task: out };
}

/** The most recent scheduled DCA moment at or before now (local time). */
function periodStart(c, now) {
  const [h, m] = c.at.split(':').map(Number);
  const back = (d, days) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - days, h, m);
  if (c.every === 'day') { const s = back(now, 0); return s <= now ? s : back(now, 1); }
  if (c.every === 'week') { const s = back(now, (now.getDay() - c.weekday + 7) % 7); return s <= now ? s : back(s, 7); }
  const s = new Date(now.getFullYear(), now.getMonth(), c.monthDay, h, m);
  return s <= now ? s : new Date(now.getFullYear(), now.getMonth() - 1, c.monthDay, h, m);
}
const CATCH_UP_MS = 3 * 86_400_000; // a missed/refused buy (weekend, market closed, PC off) is retried for up to 3 days

/**
 * DCA: one buy per period, due from its scheduled moment for up to 3 days until done, never for a period before
 * the task existed. Stocks/ETFs never fire on weekends (no market). Interval tasks: active hours + interval.
 */
export function isDue(task, { now = new Date(), lastRunAt = 0 } = {}) {
  if (!task.enabled) return false;
  if (task.kind === 'dca') {
    if (!isCrypto(task.symbol) && (now.getDay() === 0 || now.getDay() === 6)) return false;
    const start = periodStart(task.cadence, now).getTime();
    return start >= (task.createdAt ?? 0) && now.getTime() - start <= CATCH_UP_MS && (lastRunAt || 0) < start;
  }
  if (task.schedule?.hours && !task.schedule.windows.some((w) => inWindow(w, now))) return false;
  return now.getTime() - (lastRunAt || 0) >= task.everyMin * 60_000;
}

/** What a trading task should do for one symbol given the strategy's current wish and what is held. */
export function tradeDecision({ symbol, want, heldQty = 0, price, orderUsd, stopPct = 0 }) {
  if (want && heldQty > 0) return { action: 'hold', reason: 'already in position' };
  if (!want && !(heldQty > 0)) return { action: 'hold', reason: 'flat, no entry signal' };
  if (!want) return { action: 'sell', order: { symbol, side: 'sell', type: 'market', qty: String(heldQty) } };
  if (stopPct > 0 && !isCrypto(symbol)) {
    const qty = Math.floor(orderUsd / price);
    if (qty < 1) return { action: 'hold', reason: `order size $${orderUsd} is below one share at ${price}` };
    return { action: 'buy', order: { symbol, side: 'buy', type: 'market', qty: String(qty), stop_loss: (price * (1 - stopPct / 100)).toFixed(2), take_profit: (price * (1 + (2 * stopPct) / 100)).toFixed(2) } };
  }
  return { action: 'buy', order: { symbol, side: 'buy', type: 'market', notional: orderUsd.toFixed(2) } };
}

/** Paid AI call on a tracking task's top pick: only when the pick changes, its score moves 10+, or 6 hours pass. */
export function aiDue(last, symbol, score, now = Date.now()) {
  return !last || last.symbol !== symbol || Math.abs((last.score ?? 0) - score) >= 10 || now - last.at >= 6 * 3600_000;
}

/** Whether a task may place orders on this account. Alerts always may. */
export function canTrade(task, { mode, liveAck }) {
  if (task.action !== 'trade') return { ok: true };
  if (mode === 'live' && !liveAck) return { ok: false, reason: 'Live auto-trading is off: set AUTOPILOT_LIVE_ACK=I_ACCEPT_REAL_MONEY_RISK in .env to allow it' };
  return { ok: true };
}

export { STRATEGIES };
