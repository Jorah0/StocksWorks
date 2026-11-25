// StocksWorks server: zero-framework Node HTTP(S). Run with `npm start` (loads .env).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Sessions, verifyPassword, rateLimiter, verifyWebhook, createAuditLog, safeEqual, totpReplayGuard, createConfirmer, parseJsonObject } from './lib/security.js';
import { validateOrder, STOCK_RE, CRYPTO_RE } from './lib/risk.js';
import { scoreSeries, backtest } from './lib/signals.js';
import { RIG_PRESETS, BLOCK_SUBSIDY_BTC } from './lib/mining.js';
import { createAlpaca, cryptoMarkets, btcPrice, bitcoinNetwork, notify, HttpError } from './lib/providers.js';
import { analyzeSymbol, tutor, factCheckClaim } from './lib/ai.js';
import { validateFleetConfig, Pairing, newRigToken, tokenHash, sanitizeStats, pairingLink, WORKER_RE } from './lib/fleet.js';
import os from 'node:os';
import { allocation, correlationMatrix, summarizeEquity, beta, stopCoverage } from './lib/analytics.js';
import { STRATEGIES, validateParams, runStrategy, sweep } from './lib/strategies.js';
import { ALERT_TYPES, validateAlert, checkAlert } from './lib/alerts.js';
import { validateEntry, journalStats, EMOTIONS, OUTCOMES } from './lib/journal.js';
import { createPlaid } from './lib/plaid.js';
import { createSealer } from './lib/security.js';
import { createSchwab, codeFromRedirect, toSchwabOrder, accountView } from './lib/schwab.js';
import { selfSignedCert } from './lib/selfcert.js';
import QRCode from 'qrcode';
import { createAiLab, RESEARCH_CORPUS } from './lib/ailab-routes.js';
import { LESSONS } from './public/content.js';
import { createResearch, toCorpus, validHlAddress } from './lib/research.js';
import { ACTIVITIES, TASK_KINDS, LEARN_SOURCES, validateFocus, validateTask, allowedNow, isDue, tradeDecision, canTrade, aiDue } from './lib/autopilot.js';
import { wantsNow } from './lib/strategies.js';
import { CHAINS, chainList, validAddress as chainValid, balanceOf as chainBalance, usdPrices } from './lib/chains.js';
import { KINDS as MINER_KINDS } from './lib/workloads.js';
import { isCrypto, usMarketOpen } from './lib/risk.js';
import { createCache } from './lib/cache.js';
import { createIntel, edgarCik, edgarFacts, edgarFilings, defiForCoin, priceAgreement, checkAnalysis, gateVerdict, dossierCorpus } from './lib/intel.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// The desktop app points this at the user's profile (a packaged app can't write inside itself).
const DATA = process.env.STOCKSWORKS_DATA ? path.resolve(process.env.STOCKSWORKS_DATA) : path.join(ROOT, 'data');
const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const ACK = 'I_ACCEPT_REAL_MONEY_RISK';

const cfg = {
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 8787),
  mode: env.TRADING_MODE === 'live' ? 'live' : 'paper',
  passwordHash: env.APP_PASSWORD_HASH,
  totpSecret: env.TOTP_SECRET || '',
  tls: env.TLS_CERT && env.TLS_KEY ? { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) } : null,
  limits: {
    maxOrderUsd: num(env.MAX_ORDER_USD, 1000),
    maxOrdersPerDay: num(env.MAX_ORDERS_PER_DAY, 20),
    maxPositionPct: num(env.MAX_POSITION_PCT, 10),
    maxLimitDeviationPct: num(env.MAX_LIMIT_DEVIATION_PCT, 10),
    maxDailyNotionalUsd: num(env.MAX_DAILY_NOTIONAL_USD, 10_000),
    maxPriceAgeSec: num(env.MAX_PRICE_AGE_SEC, 900),
    maxRiskPerTradePct: num(env.MAX_RISK_PER_TRADE_PCT, 2),
    requireStop: env.REQUIRE_STOP === 'on',
  },
  webhookSecret: env.WEBHOOK_SECRET || '',
  webhookTrading: env.WEBHOOK_TRADING === 'on',
  webhookLive: env.WEBHOOK_LIVE_ACK === ACK,
  notifyUrl: env.NOTIFY_WEBHOOK_URL || '',
  ethRpc: env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  // Autopilot may place orders on a LIVE account only with this explicit acknowledgement (paper needs nothing extra).
  autopilotLive: env.AUTOPILOT_LIVE_ACK === 'I_ACCEPT_REAL_MONEY_RISK',
};
const research = createResearch({ finvizToken: env.FINVIZ_AUTH_TOKEN || '', messariKey: env.MESSARI_API_KEY || '' });
const intel = createIntel({ secContact: (env.SEC_CONTACT || '').replace(/[^\w .@+-]/g, '').slice(0, 80), fredKey: env.FRED_API_KEY || '' });

// ---------- refuse unsafe configurations at boot ----------
const die = (msg) => {
  if (process.env.STOCKSWORKS_EMBEDDED) throw new Error(msg); // desktop app shows this in a dialog
  console.error(`\n[StocksWorks] refusing to start: ${msg}\n`); process.exit(1);
};
if (!cfg.passwordHash) die('APP_PASSWORD_HASH missing. Run: npm run hash-password -- "<a long passphrase>"');
if (cfg.mode === 'live' && env.LIVE_TRADING_ACK !== ACK) die(`TRADING_MODE=live requires LIVE_TRADING_ACK=${ACK}`);
if (cfg.mode === 'live' && !cfg.totpSecret) die('Live mode requires TOTP 2FA (npm run new-totp)');
if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host) && !cfg.tls) die('Binding to a non-loopback address requires TLS_CERT and TLS_KEY');

// ---------- mining fleet (optional): rigs connect to a separate TLS-only listener ----------
const lanIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
if (env.FLEET_ENABLED === 'on' && !(env.FLEET_TLS_CERT && env.FLEET_TLS_KEY)) die('FLEET_ENABLED=on requires FLEET_TLS_CERT and FLEET_TLS_KEY (npm run make-cert)');
cfg.fleet = env.FLEET_ENABLED === 'on' ? (() => {
  const cert = fs.readFileSync(env.FLEET_TLS_CERT), key = fs.readFileSync(env.FLEET_TLS_KEY);
  const port = num(env.FLEET_PORT, 8788);
  return { host: env.FLEET_HOST || '0.0.0.0', port, cert, key, fingerprint: new crypto.X509Certificate(cert).fingerprint256, publicUrl: env.FLEET_PUBLIC_URL || `https://${lanIp()}:${port}` };
})() : null;

// ---------- banks & outside brokerages (optional, via Plaid) ----------
let plaid, sealer = null;
try {
  plaid = createPlaid({ clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, env: env.PLAID_ENV || 'sandbox' });
  if (env.BANK_ENCRYPTION_KEY) sealer = createSealer(env.BANK_ENCRYPTION_KEY);
} catch (e) { die(e.message); }
if (plaid.configured && !sealer) die('PLAID_CLIENT_ID/PLAID_SECRET require BANK_ENCRYPTION_KEY (npm run new-secret) so bank tokens are encrypted at rest');
// Charles Schwab (optional): read accounts/positions; trading only with SCHWAB_TRADING=on (always real money).
const schwab = createSchwab({ clientId: env.SCHWAB_CLIENT_ID, secret: env.SCHWAB_CLIENT_SECRET, redirectUri: env.SCHWAB_REDIRECT_URI || undefined });
cfg.schwabTrading = schwab.configured && env.SCHWAB_TRADING === 'on';
if (schwab.configured && !sealer) die('SCHWAB_CLIENT_ID/SCHWAB_CLIENT_SECRET require BANK_ENCRYPTION_KEY (npm run new-secret) so Schwab tokens are encrypted at rest');
if (cfg.schwabTrading && !cfg.totpSecret) die('SCHWAB_TRADING=on requires TOTP 2FA (npm run new-totp): every Schwab order is real money');

const alpaca = createAlpaca({ keyId: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY, mode: cfg.mode });
const audit = createAuditLog(path.join(DATA, 'audit.jsonl'));
const sessions = new Sessions();
setInterval(() => sessions.sweep(), 10 * 60_000).unref();
const totpGuard = totpReplayGuard();
// Shared by every money action (live orders, closes, kill-switch resume/flatten, live tasks, bank numbers):
// 5 wrong codes lock it for 15 min, so a hijacked session can't brute-force the 6 digits.
const orderTotpGuard = totpReplayGuard({ maxFails: 5, lockMs: 15 * 60_000 });
const confirmer = createConfirmer();
const loginLimit = rateLimiter(5, 15 * 60_000);
const aiLimit = rateLimiter(30, 60 * 60_000);
const learnLimit = rateLimiter(60, 60 * 60_000);
const hookLimit = rateLimiter(30, 60_000);

// ---------- small persisted state (watchlist, watch-only wallets, kill switch) ----------
const STATE_FILE = path.join(DATA, 'state.json');
const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'SPY', 'QQQ', 'BTC/USD', 'ETH/USD', 'SOL/USD'];
let state = { watchlist: DEFAULT_WATCHLIST, wallets: [], killSwitch: env.KILL_SWITCH === 'on', fleet: { config: null, rigs: [] }, alerts: [], alertEvents: [], journal: [], banks: [], schwab: null, phone: { enabled: false, devices: [] },
  research: { traders: [] }, autopilot: { focus: validateFocus({}).focus, tasks: [], events: [], runs: {} } };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
if (env.KILL_SWITCH === 'on') state.killSwitch = true; // an emergency KILL_SWITCH=on in .env wins over saved state
// Re-validate saved tasks/focus on load: a hand-edited state.json can't smuggle in values the UI would refuse.
state.autopilot.focus = validateFocus(state.autopilot.focus).focus;
state.autopilot.tasks = (state.autopilot.tasks ?? []).flatMap((t) => { const v = validateTask(t); return v.ok && typeof t.id === 'string' ? [{ ...v.task, id: t.id, createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0 }] : []; });
state.autopilot.runs ??= {}; state.autopilot.events ??= [];
const rigLive = new Map(); // rigId -> {lastSeen, stats, ip}; kept in memory so heartbeats don't rewrite state.json
const pairing = new Pairing();
const pairFailLimit = rateLimiter(10, 15 * 60_000);
const heartbeatLimit = rateLimiter(20, 60_000);
function saveState() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

// ---------- caching ----------
// Shared in-flight requests, per-entry TTL, bounded size (lib/cache.js).
// failTtl: an upstream failure (429, outage) is remembered 30 s, so refreshes and polls don't hammer the service.
const cache = createCache({ max: 400, failTtl: 30_000 });
const { cached } = cache;
setInterval(cache.sweep, 10 * 60_000).unref(); // free expired entries (e.g. multi-MB research answers) promptly
const newsFor = (symbol, n = 12) => cached(`news:${symbol}:${n}`, 5 * 60_000, () => alpaca.news(symbol, n));

// ---------- domain operations ----------
const validSymbol = (s) => STOCK_RE.test(s) || CRYPTO_RE.test(s);
const needPlaid = () => { if (!plaid.configured) throw new HttpError(409, 'Bank linking is off. Add PLAID_CLIENT_ID, PLAID_SECRET and BANK_ENCRYPTION_KEY to .env and restart.'); };
const numbersLimit = rateLimiter(10, 60 * 60_000);
// CSV cell: quoted, quotes doubled, and formula-leading characters neutralized (spreadsheet injection).
const csvCell = (v) => { const s = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
const labLimit = rateLimiter(10, 60_000); // a sweep is up to 36 backtests; keep the event loop free
const acctView = (a) => ({ account_id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, current: a.balances?.current ?? null, available: a.balances?.available ?? null, currency: a.balances?.iso_currency_code ?? 'USD' });
const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toSlash = (s) => (s.includes('/') ? s : s.replace(/(USD[CT]?)$/, '/$1')); // BTCUSD -> BTC/USD
const today = () => new Date().toISOString().slice(0, 10);
// Counted from the audit log (seeded at startup, kept in memory by lib/security.js) so a restart can't reset the
// daily limits. order.unknown = sent but no answer (timeout): it may have filled, so it counts.
const todayStats = () => audit.dayStats(today());
const ordersToday = () => todayStats().count;
const pick = (o) => Object.fromEntries(['symbol', 'side', 'type', 'qty', 'notional', 'limit_price', 'stop_loss', 'take_profit'].map((k) => [k, o?.[k] == null ? undefined : String(o[k]).slice(0, 32)]));

// ---------- Schwab ----------
const needSchwab = () => { if (!schwab.configured) throw new HttpError(409, 'Schwab is off. Add your Schwab app key and secret (Integrations → Desktop settings, or SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET in .env) and restart.'); };
let schwabRefresh = null; // one refresh at a time
async function schwabAccess() {
  needSchwab();
  if (!state.schwab) throw new HttpError(409, 'Connect your Schwab account first (Banks tab).');
  return (schwabRefresh ??= (async () => {
    const tok = JSON.parse(sealer.open(state.schwab.token));
    const next = await schwab.fresh(tok);
    if (next !== tok && state.schwab) { state.schwab.token = sealer.seal(JSON.stringify(next)); saveState(); } // may be disconnected meanwhile
    return next.access;
  })().finally(() => { schwabRefresh = null; }));
}
async function schwabAccounts() {
  const access = await schwabAccess();
  return cached('schwab:accounts', 30_000, async () => {
    const [accts, nums] = await Promise.all([schwab.accounts(access), schwab.accountNumbers(access)]);
    const hashes = Object.fromEntries((nums ?? []).map((n) => [n.accountNumber, n.hashValue]));
    return (accts ?? []).map((a) => accountView(a, hashes));
  });
}
async function schwabRiskContext(raw) {
  if (!cfg.schwabTrading) throw new HttpError(409, 'Schwab trading is off (read-only). To trade, set SCHWAB_TRADING=on in .env (2FA required) and restart.');
  const symbol = String(raw?.symbol ?? '').toUpperCase();
  const [access, accounts] = await Promise.all([schwabAccess(), schwabAccounts()]);
  const acct = accounts.find((a) => a.hash && a.hash === raw?.account);
  if (!acct) throw new HttpError(400, 'Pick one of your Schwab accounts');
  const last = STOCK_RE.test(symbol) ? await schwab.quote(access, symbol) : null;
  const pos = acct.positions.find((p) => p.symbol === symbol);
  const day = todayStats();
  return {
    mode: 'live', broker: 'schwab', access, account: acct.hash, killSwitch: state.killSwitch, price: last?.price ?? null, priceAgeSec: last?.at ? (Date.now() - last.at) / 1000 : null,
    equity: Number(acct.equity), ordersToday: day.count, notionalToday: day.notional, limits: cfg.limits,
    heldQty: Number(pos?.qty ?? 0), heldValue: Number(pos?.marketValue ?? 0),
  };
}

async function riskContext(raw) {
  if (raw?.broker === 'schwab') return schwabRiskContext(raw);
  const symbol = String(raw?.symbol ?? '').toUpperCase();
  const [last, account, positions] = await Promise.all([validSymbol(symbol) ? alpaca.lastPrice(symbol) : null, alpaca.account(), alpaca.positions()]);
  const pos = positions.find((p) => p.symbol === symbol.replace('/', '')); // Alpaca lists crypto as BTCUSD
  const day = todayStats();
  return {
    mode: cfg.mode, killSwitch: state.killSwitch, price: last?.price ?? null, priceAgeSec: last?.at ? (Date.now() - last.at) / 1000 : null,
    equity: Number(account.equity), ordersToday: day.count, notionalToday: day.notional, limits: cfg.limits,
    heldQty: Number(pos?.qty ?? 0), heldValue: Number(pos?.market_value ?? 0),
  };
}

// Orders run one at a time so concurrent requests can't all pass the daily-cap check before any is counted.
let orderQueue = Promise.resolve();
function placeOrder(raw, source) {
  const run = orderQueue.then(() => placeOrderNow(raw, source));
  orderQueue = run.catch(() => {});
  return run;
}

// Broker-specific limits on top of the shared risk gate (Schwab: whole-share equity market/limit only).
const brokerCheck = (v, ctx) => {
  if (!v.ok || ctx.broker !== 'schwab') return v;
  try { toSchwabOrder(v.order); return v; } catch (e) { return { ...v, ok: false, errors: [e.message] }; }
};
// What a confirmation token is bound to: the exact order AND where it goes.
const bound = (order, ctx) => ({ ...order, broker: ctx.broker ?? 'alpaca', account: ctx.account ?? null });

async function placeOrderNow(raw, source) {
  if (raw?.broker === 'schwab' && source !== 'ui') throw new HttpError(403, 'Schwab orders can only be placed from the order ticket');
  const ctx = await riskContext(raw);
  const broker = ctx.broker ?? 'alpaca';
  // Live confirmation is decided here, never by a request flag: UI orders must redeem the token issued at preview
  // for this exact normalized order; webhook orders only with the operator's WEBHOOK_LIVE_ACK.
  if (ctx.mode === 'live') {
    const normalized = validateOrder(raw, { ...ctx, confirmed: true }).order;
    // UI live orders need two things: the preview token for this exact order AND a fresh authenticator code
    // (a second factor a hijacked session or injected script doesn't have). Separate guard from login's.
    ctx.confirmed = source === 'webhook' ? cfg.webhookLive
      : source === 'autopilot' ? cfg.autopilotLive // the owner's standing AUTOPILOT_LIVE_ACK, checked per order
        : confirmer.redeem(raw.confirmToken, bound(normalized, ctx)) && orderTotpGuard(cfg.totpSecret, String(raw.totp ?? ''));
  }
  const v = brokerCheck(validateOrder(raw, ctx), ctx);
  if (!v.ok) {
    audit.write({ type: 'order.rejected', source, broker, order: pick(raw), errors: v.errors });
    throw new HttpError(422, v.errors.join(' | '));
  }
  let placed;
  if (broker === 'schwab') {
    try { placed = { ...v.order, ...(await schwab.placeOrder(ctx.access, ctx.account, toSchwabOrder(v.order))) }; } catch (e) {
      if (e instanceof HttpError) throw e; // Schwab answered with a rejection: nothing was placed
      // No answer (timeout/network): Schwab has no idempotency key, so the order may be live. Count it, never auto-retry.
      cache.delete('schwab:accounts');
      audit.write({ type: 'order.unknown', source, broker, account: ctx.account, mode: ctx.mode, order: v.order, notional: v.notional, error: String(e.message).slice(0, 120) });
      throw new HttpError(504, 'No answer from Schwab: the order MAY have been placed. Check your Schwab orders before trying again.');
    }
  } else {
    // Autopilot passes a deterministic key (task + period), so a retried order is refused by Alpaca as a duplicate.
    const key = source === 'autopilot' && /^[\w-]{1,96}$/.test(String(raw.idempotencyKey ?? '')) ? `sw-ap-${raw.idempotencyKey}` : `sw-${crypto.randomUUID()}`;
    try { placed = await alpaca.placeOrder({ ...v.order, client_order_id: key }); } catch (e) {
      if (e instanceof HttpError) throw e; // Alpaca answered with a rejection: nothing was placed
      // No answer (timeout/network): the order may be live. Count it toward the daily limits; never auto-retry blind.
      cache.delete('account');
      audit.write({ type: 'order.unknown', source, broker, mode: ctx.mode, order: v.order, notional: v.notional, clientOrderId: key, error: String(e.message).slice(0, 120) });
      throw new HttpError(504, 'No answer from Alpaca: the order MAY have been placed. Check your orders before trying again.');
    }
  }
  if (broker === 'schwab') cache.delete('schwab:accounts');
  cache.delete('account'); // the next portfolio view shows the new order at once
  audit.write({ type: 'order.placed', source, broker, account: ctx.account, mode: ctx.mode, order: v.order, notional: v.notional, riskUsd: v.riskUsd, brokerId: placed.id });
  notify(cfg.notifyUrl, `StocksWorks ${ctx.mode.toUpperCase()}${broker === 'schwab' ? ' (Schwab)' : ''} ${v.order.side} ${v.order.qty ?? '$' + v.order.notional} ${v.order.symbol} (${source})`);
  // Optional "why this trade?" from the ticket becomes an open journal entry (the order is already placed either way).
  if (source === 'ui' && typeof raw.thesis === 'string' && raw.thesis.trim()) {
    const j = validateEntry({ symbol: v.order.symbol, side: v.order.side, setup: raw.setup, emotion: raw.emotion ?? 'calm', confidence: Number(raw.confidence ?? 3), outcome: 'open', thesis: raw.thesis });
    if (j.ok && state.journal.length < 2000) { state.journal.unshift({ ...j.entry, id: crypto.randomUUID(), createdAt: Date.now(), brokerId: placed.id }); saveState(); }
    else placed.journalError = j.errors.join(' | ') || 'Journal is full';
  }
  return placed;
}

async function analyzeOne(symbol) {
  // Daily bars: stocks only change during the session (30 min is plenty; scans/alerts/tasks share it), crypto 24/7.
  return cached(`sym:${symbol}`, isCrypto(symbol) ? 5 * 60_000 : 30 * 60_000, async () => {
    const bars = await alpaca.bars(symbol);
    const closes = bars.map((b) => b.c);
    return {
      symbol,
      signal: scoreSeries(closes),
      backtest: closes.length > 80 ? backtest(closes) : null,
      closes: closes.slice(-250),
      dates: bars.slice(-250).map((b) => b.t.slice(0, 10)),
    };
  });
}

// ---------- data aggregation: one dossier per symbol from every source, cross-checked ----------
const H = 3600_000;
const macroData = () => cached('macro', 6 * H, () => intel.macro());
const sentimentData = () => cached('fng', H, () => intel.fearGreed());
async function edgarFor(symbol) {
  if (!intel.status().edgar) throw new HttpError(409, 'not configured (SEC_CONTACT)');
  const hit = edgarCik(await cached('sec:tickers', 24 * H, () => intel.tickerMap()), symbol);
  if (!hit) return null; // not an SEC registrant (ETF, foreign listing)
  // Cache the reduced shapes, not the raw multi-MB SEC JSON.
  const [facts, filings] = await Promise.all([
    cached(`sec:f:${hit.cik}`, 6 * H, async () => edgarFacts(await intel.companyFacts(hit.cik))),
    cached(`sec:s:${hit.cik}`, H, async () => edgarFilings(await intel.submissions(hit.cik), hit.cik)),
  ]);
  return { name: hit.name, cik: hit.cik, facts, filings };
}
async function defiFor(base) {
  const [p, c] = await Promise.all([cached('llama:p', H, () => intel.defiProtocols()), cached('llama:c', H, () => intel.defiChains())]);
  return defiForCoin(base, p, c);
}
/**
 * Everything known about one symbol: market data, fundamentals, filings, on-chain/DeFi, macro, sentiment and news,
 * plus a cross-source price check. Sources run in parallel and fail independently; `sources` says which answered.
 */
function dossier(symbol) {
  return cached(`dossier:${symbol}`, 5 * 60_000, async () => {
    const crypto = isCrypto(symbol), base = symbol.split('/')[0];
    const jobs = {
      market: alpaca.configured ? analyzeOne(symbol) : Promise.reject(new HttpError(409, 'not configured (Alpaca)')),
      last: alpaca.configured ? alpaca.lastPrice(symbol) : Promise.reject(new HttpError(409, 'not configured (Alpaca)')),
      macro: macroData(), sentiment: crypto ? sentimentData() : Promise.resolve(null),
      ...(crypto ? {
        coingecko: cached('cg', 60_000, cryptoMarkets).then((l) => l.find((c) => String(c.symbol).toUpperCase() === base) ?? null),
        messari: research.status().messari.configured ? cached(`ma:${base}`, 10 * 60_000, () => research.messariAssets(base)).then((a) => a.find((x) => x.symbol.toUpperCase() === base) ?? null) : Promise.reject(new HttpError(409, 'not configured (MESSARI_API_KEY)')),
        defi: defiFor(base),
      } : {
        finviz: research.status().finviz.configured ? cached(`fvt:${symbol}`, 10 * 60_000, () => research.finvizTicker(symbol)) : Promise.reject(new HttpError(409, 'not configured (FINVIZ_AUTH_TOKEN)')),
        edgar: edgarFor(symbol),
      }),
      alpacaNews: alpaca.configured ? newsFor(symbol) : Promise.resolve([]),
    };
    const keys = Object.keys(jobs), got = await Promise.allSettled(Object.values(jobs));
    const v = {}, sources = {};
    keys.forEach((k, i) => { v[k] = got[i].status === 'fulfilled' ? got[i].value : null; sources[k] = got[i].status === 'fulfilled' ? (got[i].value == null ? 'no data' : 'ok') : String(got[i].reason?.message ?? 'error').slice(0, 120); });
    // GDELT news by company/coin name, after we know the name (rate-limited service: cached 30 min)
    const name = v.edgar?.name ?? v.coingecko?.name ?? v.messari?.name ?? base;
    // GDELT is slow and rate-limited: wait at most 4 s; a slower answer still lands in its 30-min cache for next time.
    const g = cached(`gdelt:${name}`, 30 * 60_000, () => intel.news(name));
    g.catch(() => {}); // a late failure must not become an unhandled rejection
    const gdelt = await Promise.race([g, new Promise((r) => setTimeout(() => r(null), 4000))]).then(
      (x) => { sources.gdelt = x == null ? 'still loading (refresh in a minute)' : x.length ? 'ok' : 'no data'; return x ?? []; },
      (e) => { sources.gdelt = e.message.slice(0, 120); return []; });
    const price = v.last?.price ?? v.coingecko?.current_price ?? v.finviz?.price ?? null;
    return {
      symbol, kind: crypto ? 'crypto' : 'stock', asOf: new Date().toISOString(), price, sources,
      agreement: priceAgreement({ alpaca: v.last?.price, finviz: v.finviz?.price, coingecko: v.coingecko?.current_price }),
      signal: v.market?.signal ?? null, finviz: v.finviz ?? null, edgar: v.edgar ?? null, messari: v.messari ?? null, defi: v.defi ?? null,
      coin: v.coingecko ? { name: v.coingecko.name, marketCap: v.coingecko.market_cap, change24hPct: v.coingecko.price_change_percentage_24h, rank: v.coingecko.market_cap_rank } : null,
      macro: v.macro ?? null, sentiment: v.sentiment ?? null,
      news: [...(v.alpacaNews ?? []).map((x) => ({ title: x.headline, url: x.url, source: x.source, at: x.at })), ...gdelt].slice(0, 20),
    };
  });
}
/** Compact dossier for the AI analyst (untrusted data, like news): what the model needs, not the raw dump. */
async function researchContext(symbol) {
  try {
    const d = await dossier(symbol);
    return { priceCheck: d.agreement, finviz: d.finviz, fundamentals: d.edgar?.facts ?? null, recentFilings: d.edgar?.filings?.slice(0, 5) ?? null,
      messari: d.messari, defi: d.defi, coin: d.coin, macro: d.macro, cryptoSentiment: d.sentiment, headlines: d.news.slice(0, 10).map((n) => n.title) };
  } catch { return null; } // research is a bonus: analysis still runs without it
}
const RESEARCH_FILE = path.join(DATA, 'ai', RESEARCH_CORPUS);
const corpusSize = () => { try { return fs.statSync(RESEARCH_FILE).size; } catch { return 0; } };
const taughtRecently = new Set(); // hashes of recent chunks: a repeat run teaching identical text adds nothing
/** Append study text to the AI corpus (skips exact repeats); keeps the newest ~15 MB once it passes 20 MB. */
function teach(text) {
  const h = crypto.createHash('sha256').update(text).digest('hex');
  if (taughtRecently.has(h)) return 0;
  taughtRecently.add(h);
  if (taughtRecently.size > 2000) taughtRecently.delete(taughtRecently.values().next().value);
  fs.mkdirSync(path.dirname(RESEARCH_FILE), { recursive: true });
  fs.appendFileSync(RESEARCH_FILE, `\n${text}\n`, { mode: 0o600 });
  if (corpusSize() > 20 * 2 ** 20) { // trim by bytes, then start at the next whole entry so no document is cut in half
    const buf = fs.readFileSync(RESEARCH_FILE);
    let tail = buf.subarray(buf.length - 15 * 2 ** 20).toString('utf8');
    const cut = tail.indexOf('\n[Source:');
    if (cut > 0) tail = tail.slice(cut + 1);
    fs.writeFileSync(RESEARCH_FILE, tail, { mode: 0o600 });
  }
  return Buffer.byteLength(text) + 2;
}
async function learnText(body = {}) {
  switch (body.source) {
    case 'finviz': return toCorpus('finviz', await research.finviz(String(body.f ?? ''), ''));
    case 'messari-news': return toCorpus('messari-news', await research.messariNews(String(body.asset ?? '')));
    case 'messari-assets': return toCorpus('messari-assets', await research.messariAssets(String(body.q ?? '').slice(0, 60)));
    case 'trader': return toCorpus('trader', await research.trader(String(body.address ?? '')));
    case 'dossier': {
      const sym = String(body.symbol ?? '').toUpperCase();
      if (!validSymbol(sym)) throw new HttpError(400, 'Invalid symbol');
      return dossierCorpus(await dossier(sym));
    }
    case 'macro': return macroCorpus();
    case 'note': {
      const t = String(body.text ?? '').trim();
      if (!t || t.length > 20_000) throw new HttpError(400, 'Note: 1-20,000 characters');
      return toCorpus('note', t);
    }
    default: throw new HttpError(400, 'Source: finviz, messari-news, messari-assets, trader, dossier, macro or note');
  }
}
async function macroCorpus() {
  const [m, f] = await Promise.allSettled([macroData(), sentimentData()]);
  if (m.status === 'rejected' && f.status === 'rejected') throw m.reason;
  return dossierCorpus({ symbol: 'MACRO', macro: m.value ?? null, sentiment: f.value ?? null });
}

// ---------- autopilot ----------
const ap = () => state.autopilot;
function autopilotView() {
  return {
    focus: ap().focus, activities: ACTIVITIES, allowedNow: [...allowedNow(ap().focus)],
    tasks: ap().tasks.map((t) => ({ ...t, lastRunAt: ap().runs[t.id]?.at ?? null, lastResult: ap().runs[t.id]?.result ?? null })),
    events: ap().events.slice(0, 50), kinds: TASK_KINDS, strategies: STRATEGIES, sources: LEARN_SOURCES,
    trading: { mode: cfg.mode, liveAllowed: cfg.autopilotLive }, killSwitch: state.killSwitch,
  };
}
/** Tells this PC's miner supervisor what Focus allows right now (desktop app only). */
function applyFocus() { desktopHooks.supervisor?.setAllowed?.(allowedNow(ap().focus)); }

async function runTaskWork(t) {
  if (t.kind === 'learn') {
    const parts = [];
    for (const src of t.sources) {
      try {
        if (src === 'finviz') parts.push(`Finviz ${teach(toCorpus('finviz', await research.finviz(t.finvizFilters, '')))} chars`);
        if (src === 'messari-news') parts.push(`Messari ${teach(toCorpus('messari-news', await research.messariNews('')))} chars`);
        if (src === 'traders') {
          let c = 0;
          for (const tr of state.research.traders.slice(0, 10)) c += teach(toCorpus('trader', await research.trader(tr.address)));
          parts.push(`traders ${c} chars`);
        }
        if (src === 'macro') parts.push(`macro ${teach(await macroCorpus())} chars`);
        if (src === 'dossiers') {
          let c = 0;
          for (const sym of state.watchlist.slice(0, 5)) c += teach(dossierCorpus(await dossier(sym))); // sequential + capped: gentle on free APIs
          parts.push(`dossiers ${c} chars`);
        }
      } catch (e) { parts.push(`${src}: ${e.message}`); }
    }
    return `Taught the AI: ${parts.join('; ')}`;
  }
  if (!alpaca.configured) return 'Skipped: connect Alpaca (market data and orders come from it)';
  if (t.kind === 'track') {
    const syms = t.symbols.length ? t.symbols : state.watchlist;
    const rows = (await Promise.allSettled(syms.map(analyzeOne))).flatMap((r) => (r.status === 'fulfilled' && r.value.signal ? [r.value] : []));
    const hits = rows.filter((r) => r.signal.score >= t.minScore).sort((a, b) => b.signal.score - a.signal.score);
    if (!hits.length) return `No symbol scored ${t.minScore}+ (${rows.length} checked)`;
    let text = `Strong signals: ${hits.slice(0, 8).map((h) => `${h.symbol} ${h.signal.score}`).join(', ')}`;
    const top = hits[0], lastAi = ap().runs[t.id]?.ai ?? null;
    // Paid AI only when the pick changed, its score moved 10+, or 6 h passed; lighter settings than a manual analysis.
    if (t.aiTop && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && aiDue(lastAi, top.symbol, top.signal.score) && aiLimit('autopilot')) {
      const a = await analyzeSymbol({ symbol: top.symbol, signal: top.signal, backtest: top.backtest, news: await newsFor(top.symbol).catch(() => []), research: await researchContext(top.symbol), light: true }).catch((e) => ({ error: e.message }));
      text += a.error ? ` · AI: ${a.error}` : ` · AI on ${top.symbol}: ${a.stance} (${a.confidence}%) ${a.thesis.slice(0, 160)}`;
      if (!a.error) aiNote.set(t.id, { symbol: top.symbol, score: top.signal.score, at: Date.now(), text: text.slice(text.indexOf(' · AI')) });
    } else if (t.aiTop && lastAi?.symbol === top.symbol) text += `${lastAi.text ?? ''} (AI from ${new Date(lastAi.at).toLocaleTimeString()})`;
    notify(cfg.notifyUrl, `StocksWorks ${t.name}: ${text}`);
    return text;
  }
  const gate = canTrade(t, { mode: cfg.mode, liveAck: cfg.autopilotLive });
  if (!gate.ok) return `Not trading: ${gate.reason}`;
  const act = async (order, label) => {
    if (t.action === 'alert') { notify(cfg.notifyUrl, `StocksWorks ${t.name}: signal ${label}`); return `signal ${label} (alert only)`; }
    // One order per task, symbol, side and day: a retry (timeout, restart) is refused by Alpaca as a duplicate.
    order = { ...order, idempotencyKey: `${t.id}-${today()}-${order.side}-${order.symbol.replace('/', '')}` };
    try {
      if (order.side === 'sell') { // a bracket's stop/target legs hold the shares: cancel this symbol's open orders first
        // ...but only once the sell would pass the risk gate, so a refused sell never strips the protective stops.
        const ctx = await riskContext(order);
        const pre = validateOrder(order, { ...ctx, confirmed: ctx.mode !== 'live' || cfg.autopilotLive });
        if (!pre.ok) return `order refused (${label}): ${pre.errors.join(' | ')} (protective orders left in place)`;
        const sym = order.symbol.replace('/', '');
        const open = (await alpaca.openOrders()).filter((o) => o.symbol === sym);
        await Promise.allSettled(open.map((o) => alpaca.cancelOrder(o.id)));
        if (open.length) await new Promise((r) => setTimeout(r, 1500)); // let Alpaca release the held shares
      }
      await placeOrder(order, 'autopilot');
      return `${cfg.mode} order placed: ${label}`;
    } catch (e) { return `order refused (${label}): ${e.message}`; }
  };
  if (t.kind === 'dca') return act({ symbol: t.symbol, side: 'buy', type: 'market', notional: t.amountUsd.toFixed(2) }, `buy $${t.amountUsd} ${t.symbol}`);
  // trade: the strategy's wish on the latest daily bar vs what is held.
  // ponytail: daily-bar signals checked at your chosen times; intraday bars are the upgrade for true scalping.
  const positions = await alpaca.positions();
  const lines = [];
  for (const s of t.symbols) {
    try {
      const d = await analyzeOne(s);
      const held = Number(positions.find((p) => p.symbol === s.replace('/', ''))?.qty ?? 0);
      const want = wantsNow(d.closes, t.strategy, t.params, held > 0);
      const { price } = await alpaca.lastPrice(s);
      const dec = tradeDecision({ symbol: s, want, heldQty: held, price, orderUsd: t.orderUsd, stopPct: t.stopPct });
      lines.push(dec.action === 'hold' ? `${s}: hold (${dec.reason})` : `${s}: ${await act(dec.order, `${dec.action} ${dec.order.qty ?? '$' + dec.order.notional} ${s}`)}`);
    } catch (e) { lines.push(`${s}: ${e.message}`); }
  }
  return lines.join(' · ');
}
/**
 * A phone switching on / running a task that places LIVE orders needs a fresh authenticator code, like a live order
 * from the phone's ticket does. Paper tasks, alert-only tasks and the PC itself are unaffected.
 */
function liveTaskGuard(req, t, body) {
  // Any device: creating, editing, switching on or running a task that places LIVE orders needs a fresh code
  // (a standing AUTOPILOT_LIVE_ACK must not let a hijacked session set up real-money trading).
  if (t.action !== 'trade' || cfg.mode !== 'live') return;
  if (!orderTotpGuard(cfg.totpSecret, String(body.totp ?? ''))) throw new HttpError(403, 'This task places REAL-MONEY orders: enter a fresh authenticator code');
}
const taskRunning = new Set(); // one run per task at a time: a double tap can't place the same order twice
const aiNote = new Map(); // taskId -> last paid AI call made in this run (saved into runs[] by runTask)
async function runTask(t, why) {
  if (taskRunning.has(t.id)) throw new HttpError(409, `${t.name} is already running`);
  taskRunning.add(t.id);
  let result;
  try { result = await runTaskWork(t); } catch (e) { result = `Failed: ${e.message}`; } finally { taskRunning.delete(t.id); }
  result = String(result).slice(0, 400);
  // A DCA buy that didn't happen (refused, skipped, failed) isn't spent: keep the last real run, retry in 30 min.
  const missed = t.kind === 'dca' && t.action === 'trade' && /^(order refused|Skipped|Not trading|Failed)/.test(result);
  const prev = ap().runs[t.id];
  const ai = aiNote.get(t.id) ?? prev?.ai; aiNote.delete(t.id); // remembers the last paid AI call for aiDue()
  ap().runs[t.id] = missed ? { at: prev?.at ?? null, result, retryAt: Date.now() + 30 * 60_000, ...(ai ? { ai } : {}) } : { at: Date.now(), result, ...(ai ? { ai } : {}) };
  ap().events.unshift({ at: Date.now(), taskId: t.id, text: `${t.name}${why === 'manual' ? ' (run now)' : ''}: ${result}` });
  ap().events = ap().events.slice(0, 100);
  saveState();
  audit.write({ type: 'autopilot.run', task: t.name, kind: t.kind, why, result: result.slice(0, 200) });
  return result;
}
let autopilotBusy = false;
async function runAutopilot() {
  applyFocus();
  if (autopilotBusy) return;
  autopilotBusy = true;
  try {
    const now = new Date(), allowed = allowedNow(ap().focus, now);
    for (const t of ap().tasks) {
      const r = ap().runs[t.id];
      if (allowed.has(t.activity) && !taskRunning.has(t.id) && !(r?.retryAt > now.getTime()) && isDue(t, { now, lastRunAt: r?.at ?? 0 })) await runTask(t, 'schedule').catch(() => {});
    }
  } finally { autopilotBusy = false; }
}

// ---------- HTTP plumbing ----------
// Plaid Link (bank sign-in happens in Plaid's own iframe) is the only third-party script, and only when Plaid is configured.
const CSP = plaid.configured
  ? "default-src 'self'; script-src 'self' https://cdn.plaid.com; frame-src https://cdn.plaid.com; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.plaid.com; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function secureHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (cfg.tls) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const parseJson = parseJsonObject; // bodies must be JSON objects: null/array/number -> 400, not a 500
const cookieName = cfg.tls ? '__Host-sw' : 'sw';
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
const ipOf = (req) => req.socket.remoteAddress ?? '?';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// Pure, dependency-free modules shared with the browser so the math has one source of truth.
const SHARED = Object.fromEntries(['signals', 'mining', 'keccak', 'modelfit'].map((m) => [`/lib/${m}.js`, path.join(ROOT, `lib/${m}.js`)]));
SHARED['/icon.png'] = path.join(ROOT, 'build', 'icon.png'); // phone home-screen icon

function serveStatic(pathname, res) {
  let file = SHARED[pathname];
  if (!file) {
    let rel;
    try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return send(res, 400, { error: 'Bad path' }); }
    file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- routes ----------
const routes = {
  'GET /api/session': ({ session }) => ({ authenticated: Boolean(session), csrf: session?.csrf ?? null, totp: Boolean(cfg.totpSecret) }),

  'POST /api/login': ({ req, res, body }) => {
    if (loginLimit.blocked(ipOf(req))) throw new HttpError(429, 'Too many attempts. Wait 15 minutes.');
    const ok = verifyPassword(body.password ?? '', cfg.passwordHash) && (!cfg.totpSecret || totpGuard(cfg.totpSecret, String(body.totp ?? '')));
    audit.write({ type: ok ? 'login.ok' : 'login.fail', ip: ipOf(req) });
    if (!ok) { loginLimit(ipOf(req)); throw new HttpError(401, 'Invalid credentials'); } // only failures count
    const { token, csrf } = sessions.create();
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${cfg.tls || req.socket.encrypted ? '; Secure' : ''}`);
    return { csrf };
  },

  'POST /api/logout': ({ req, res }) => {
    sessions.destroy(cookies(req)[cookieName]);
    res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cfg.tls || req.socket.encrypted ? '; Secure' : ''}`);
    return { ok: true };
  },

  'GET /api/status': () => ({
    mode: cfg.mode, killSwitch: state.killSwitch, limits: cfg.limits,
    alpaca: alpaca.configured, ai: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    schwab: { enabled: schwab.configured, connected: Boolean(state.schwab), trading: cfg.schwabTrading },
    webhook: { configured: cfg.webhookSecret.length >= 16, trading: cfg.webhookTrading },
    notify: Boolean(cfg.notifyUrl), totp: Boolean(cfg.totpSecret), tls: Boolean(cfg.tls), ordersToday: ordersToday(),
  }),

  // 3 broker calls: shared for 5 s so a phone + desktop + refresh don't each pay them
  'GET /api/account': () => cached('account', 5_000, async () => {
    const [account, positions, orders] = await Promise.all([alpaca.account(), alpaca.positions(), alpaca.orders()]);
    return { account, positions, orders };
  }),

  'POST /api/orders/preview': async ({ body }) => {
    const ctx = await riskContext(body);
    const v = brokerCheck(validateOrder(body, { ...ctx, confirmed: true }), ctx);
    // In live mode (and always for Schwab) a passing preview issues a 2-minute, single-use token bound to this exact order.
    const confirmToken = ctx.mode === 'live' && v.ok ? confirmer.issue(bound(v.order, ctx)) : null;
    return { ...v, confirmToken, price: ctx.price, priceAgeSec: ctx.priceAgeSec, equity: ctx.equity, notionalToday: ctx.notionalToday, mode: ctx.mode, broker: ctx.broker ?? 'alpaca' };
  },
  'GET /api/history': async () => {
    const h = await alpaca.portfolioHistory();
    return { dates: (h.timestamp ?? []).map((t) => new Date(t * 1000).toISOString().slice(0, 10)), equity: h.equity ?? [] };
  },
  'GET /api/audit.csv': () => {
    const rows = audit.lines().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type?.startsWith('order.'));
    // Prefix cells that spreadsheets would treat as formulas (CSV injection).
    const cell = (v) => { const s = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
    const head = ['time_utc', 'event', 'source', 'mode', 'symbol', 'side', 'type', 'qty', 'notional_usd', 'limit_price', 'stop', 'target', 'broker_id', 'errors'];
    const body = rows.map((e) => [e.ts, e.type, e.source, e.mode, e.order?.symbol, e.order?.side, e.order?.type, e.order?.qty, e.notional ?? e.order?.notional,
      e.order?.limit_price, e.order?.stop_loss?.stop_price ?? e.order?.stop_loss, e.order?.take_profit?.limit_price ?? e.order?.take_profit, e.brokerId, (e.errors ?? []).join('; ')].map(cell).join(','));
    return { __csv: [head.join(','), ...body].join('\r\n'), filename: `stocksworks-orders-${today()}.csv` };
  },
  'POST /api/orders': ({ body }) => placeOrder(body, 'ui'),

  'POST /api/kill': async ({ body }) => {
    const on = body.on === true, flatten = on && body.flatten === true;
    // Halting never needs a code (it's the emergency stop). In LIVE mode, resuming trading or closing every
    // position needs a fresh authenticator code, like closing one position does.
    if (cfg.mode === 'live' && (!on || flatten) && !orderTotpGuard(cfg.totpSecret, String(body.totp ?? '')))
      throw new HttpError(403, 'Live mode: enter a fresh authenticator code to resume trading or close all positions');
    state.killSwitch = on;
    saveState();
    const actions = [];
    if (state.killSwitch && alpaca.configured) {
      await alpaca.cancelAll(); actions.push('cancelled open orders');
      if (flatten) { await alpaca.closeAll(); actions.push('closed all positions'); }
    }
    audit.write({ type: 'killswitch', on: state.killSwitch, actions });
    notify(cfg.notifyUrl, `StocksWorks kill switch ${state.killSwitch ? 'ON' : 'off'} ${actions.join(', ')}`);
    return { killSwitch: state.killSwitch, actions };
  },

  'GET /api/scan': async () => {
    const results = await Promise.allSettled(state.watchlist.map(analyzeOne));
    const rows = results.map((r, i) => r.status === 'fulfilled'
      ? { symbol: r.value.symbol, ...(r.value.signal ?? { score: null, error: 'Not enough history' }), spark: r.value.closes.slice(-60), backtest: r.value.backtest }
      : { symbol: state.watchlist[i], score: null, error: r.reason.message });
    return rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  },

  'GET /api/symbol': ({ url }) => {
    const s = (url.searchParams.get('s') ?? '').toUpperCase();
    if (!validSymbol(s)) throw new HttpError(400, 'Invalid symbol');
    return analyzeOne(s);
  },

  'POST /api/ai/analyze': async ({ req, body }) => {
    const s = String(body.symbol ?? '').toUpperCase();
    if (!validSymbol(s)) throw new HttpError(400, 'Invalid symbol');
    const web = body.web === true;
    // Paid call: the same symbol's analysis is reused for 30 min unless "fresh" is asked for (a reuse costs no quota).
    if (body.fresh === true) cache.delete(`ai:${s}:${web}`);
    const result = await cached(`ai:${s}:${web}`, 30 * 60_000, async () => {
      if (!aiLimit(ipOf(req))) throw new HttpError(429, 'AI hourly limit reached');
      const d = await analyzeOne(s);
      const [news, ctx] = await Promise.all([newsFor(s).catch(() => []), researchContext(s)]);
      const r = await analyzeSymbol({ symbol: s, signal: d.signal, backtest: d.backtest, news, web, research: ctx });
      // Fact check the AI against the data: contradictions are shown with the analysis, never hidden.
      const dos = await dossier(s).catch(() => null);
      return { ...r, news, checks: checkAnalysis(r, { price: dos?.price ?? d.closes.at(-1), signal: d.signal, finviz: dos?.finviz }), at: Date.now() };
    });
    audit.write({ type: 'ai.analyze', symbol: s, stance: result.stance, confidence: result.confidence, web, cachedAt: result.at });
    return result;
  },

  'POST /api/ai/tutor': async ({ req, body }) => {
    const q = String(body.question ?? '').trim();
    if (!q || q.length > 2000) throw new HttpError(400, 'Question must be 1-2000 characters');
    if (!aiLimit(ipOf(req))) throw new HttpError(429, 'AI hourly limit reached');
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    return { answer: await tutor(q, history) };
  },

  'GET /api/watchlist': () => state.watchlist,
  'POST /api/watchlist': ({ body }) => {
    const list = [...new Set((Array.isArray(body.symbols) ? body.symbols : []).map((s) => String(s).trim().toUpperCase()))];
    if (!list.length || list.length > 40 || !list.every(validSymbol)) throw new HttpError(400, '1-40 valid symbols required (AAPL, BTC/USD)');
    state.watchlist = list; saveState();
    return list;
  },

  'GET /api/crypto/markets': () => cached('cg', 60_000, cryptoMarkets),

  'GET /api/chains': () => chainList(),
  'GET /api/wallets': async () => {
    const key = (w) => `bal:${w.chain}:${w.address}:${w.token?.contract ?? ''}`;
    const [out, prices] = await Promise.all([
      Promise.allSettled(state.wallets.map((w) => cached(key(w), 60_000, () => chainBalance(w.chain, w.address, { ethRpc: cfg.ethRpc, token: w.token?.contract })))),
      cached(`usd:${state.wallets.map(key).join('|')}`, 120_000, () => usdPrices(state.wallets).then((m) => state.wallets.map((w) => m.get(w) ?? null))).catch(() => []),
    ]);
    return state.wallets.map((w, i) => {
      const b = out[i].value;
      return { ...w, token: w.token ? { ...w.token, symbol: b?.symbol ?? null } : null, balance: b?.amount ?? null, symbol: b?.symbol ?? w.token?.symbol ?? CHAINS[w.chain]?.symbol ?? '', usd: b && prices[i] != null ? b.amount * prices[i] : null, error: out[i].reason?.message };
    });
  },
  'POST /api/wallets': ({ body }) => {
    const chain = String(body.chain ?? ''), address = String(body.address ?? '').trim(), label = String(body.label ?? '').slice(0, 40);
    if (!chainValid(chain, address)) throw new HttpError(400, 'Invalid address for this chain (check for typos)');
    const contract = String(body.token ?? '').trim();
    if (contract && (CHAINS[chain].family !== 'evm' || !chainValid('eth', contract))) throw new HttpError(400, 'Token contract: a checksummed 0x… ERC-20 address on an EVM chain');
    if (state.wallets.length >= 100) throw new HttpError(400, 'Too many wallets (100 max)');
    const token = contract ? { contract } : null;
    if (!state.wallets.some((w) => w.chain === chain && w.address === address && (w.token?.contract ?? '') === contract)) state.wallets.push({ chain, address, label, ...(token ? { token } : {}) });
    saveState();
    audit.write({ type: 'wallet.watch', chain, address, token: contract || undefined });
    return state.wallets;
  },
  'DELETE /api/wallets': ({ url }) => {
    const a = url.searchParams.get('address'), c = url.searchParams.get('chain'), t = url.searchParams.get('token') ?? '';
    // chain/token narrow the match when given; old clients send the address only (removes every entry for it)
    state.wallets = state.wallets.filter((w) => !(w.address === a && (!c || w.chain === c) && (!url.searchParams.has('token') || (w.token?.contract ?? '') === t)));
    saveState();
    return state.wallets;
  },

  // ----- mining: miners this app can drive, and what's mineable -----
  'GET /api/miners': () => ({ kinds: MINER_KINDS }),
  'GET /api/mining/coins': () => cached('wtm', 30 * 60_000, async () => {
    const r = await fetch('https://whattomine.com/coins.json', { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new HttpError(502, `WhatToMine returned ${r.status}`);
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const coins = Object.entries((await r.json())?.coins ?? {}).map(([name, c]) => ({
      tag: String(c.tag ?? '').slice(0, 12), name: name.slice(0, 40), algorithm: String(c.algorithm ?? '').slice(0, 30), nethash: n(c.nethash), difficulty: n(c.difficulty),
      blockReward: n(c.block_reward), exchangeRate: n(c.exchange_rate), btcRevenue24h: n(c.btc_revenue24 ?? c.btc_revenue), profitability: n(c.profitability24 ?? c.profitability),
    })).sort((a, b) => (b.profitability ?? 0) - (a.profitability ?? 0));
    return { coins, source: 'WhatToMine', note: 'Estimates for WhatToMine reference hardware at its default electricity cost; your rig and power price change the result.' };
  }),

  // ----- research: Finviz, Messari, Invo traders (Hyperliquid) -> views + AI corpus -----
  'GET /api/research/sources': () => ({ ...research.status(), corpusChars: corpusSize() }),
  'GET /api/research/finviz': async ({ url }) => {
    const f = url.searchParams.get('f') ?? '', o = url.searchParams.get('o') ?? '';
    return { rows: await cached(`fv:${f}:${o}`, 5 * 60_000, () => research.finviz(f, o)), filters: f };
  },
  'GET /api/research/messari/assets': async ({ url }) => {
    const q = (url.searchParams.get('q') ?? '').slice(0, 60);
    return { assets: await cached(`ma:${q}`, 10 * 60_000, () => research.messariAssets(q)) };
  },
  'GET /api/research/messari/news': async ({ url }) => {
    const a = url.searchParams.get('asset') ?? '';
    return { items: await cached(`mn:${a}`, 5 * 60_000, () => research.messariNews(a)) };
  },
  'GET /api/research/traders': () => ({ traders: state.research.traders }),
  'POST /api/research/traders': ({ body }) => {
    const address = String(body.address ?? '').trim();
    if (!validHlAddress(address)) throw new HttpError(400, 'Trader address: the 0x… Hyperliquid wallet shown on their Invo profile');
    if (state.research.traders.length >= 30) throw new HttpError(400, 'At most 30 followed traders');
    if (!state.research.traders.some((t) => t.address.toLowerCase() === address.toLowerCase()))
      state.research.traders.push({ address, label: String(body.label ?? '').replace(/[^\w .'()@-]/g, '').slice(0, 40), addedAt: Date.now() });
    saveState();
    return { traders: state.research.traders };
  },
  'DELETE /api/research/traders': ({ url }) => {
    const a = String(url.searchParams.get('address') ?? '').toLowerCase();
    state.research.traders = state.research.traders.filter((t) => t.address.toLowerCase() !== a);
    saveState();
    return { traders: state.research.traders };
  },
  'GET /api/research/trader': ({ url }) => {
    const a = String(url.searchParams.get('address') ?? '');
    return cached(`hl:${a.toLowerCase()}`, 60_000, () => research.trader(a));
  },
  'POST /api/research/learn': async ({ req, body }) => {
    if (!learnLimit(ipOf(req))) throw new HttpError(429, 'Teaching limit reached (60 per hour)');
    const text = await learnText(body);
    const added = teach(text);
    audit.write({ type: 'ai.learn', source: String(body.source).slice(0, 20), chars: added });
    return { ok: true, added, totalChars: corpusSize() };
  },

  // ----- data aggregation + fact checking -----
  'GET /api/intel/sources': () => ({ ...intel.status(), finviz: research.status().finviz.configured, messari: research.status().messari.configured, alpaca: alpaca.configured, claude: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) }),
  'GET /api/intel': ({ url }) => {
    const s = (url.searchParams.get('s') ?? '').toUpperCase();
    if (!validSymbol(s)) throw new HttpError(400, 'Invalid symbol (AAPL or BTC/USD)');
    return dossier(s);
  },
  'GET /api/intel/macro': async () => {
    const [m, f] = await Promise.allSettled([macroData(), sentimentData()]);
    return { macro: m.value ?? null, macroError: m.reason?.message ?? null, sentiment: f.value ?? null, sentimentError: f.reason?.message ?? null };
  },
  'POST /api/factcheck': async ({ req, body }) => {
    const claim = String(body.claim ?? '').trim();
    if (claim.length < 8 || claim.length > 1000) throw new HttpError(400, 'Claim: 8-1000 characters');
    if (!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) throw new HttpError(503, 'Fact checking uses Claude: add ANTHROPIC_API_KEY');
    if (!aiLimit(ipOf(req))) throw new HttpError(429, 'AI hourly limit reached');
    const sym = String(body.symbol ?? '').toUpperCase();
    const data = sym && validSymbol(sym) ? await researchContext(sym) : null; // our own data, to compare with the web
    const r = await factCheckClaim(claim, data);
    const out = { claim, ...gateVerdict(r.raw, r.sources), model: r.model, usedData: Boolean(data) };
    audit.write({ type: 'ai.factcheck', verdict: out.verdict, symbol: sym || undefined });
    return out;
  },

  // ----- autopilot: what runs when (focus) + scheduled tasks -----
  'GET /api/autopilot': () => autopilotView(),
  'POST /api/autopilot/focus': ({ body }) => {
    const v = validateFocus(body);
    if (!v.ok) throw new HttpError(400, v.errors.join(' | '));
    state.autopilot.focus = v.focus; saveState();
    applyFocus();
    audit.write({ type: 'autopilot.focus', mode: v.focus.mode });
    return autopilotView();
  },
  'POST /api/autopilot/tasks': ({ req, body }) => {
    const v = validateTask(body);
    if (!v.ok) throw new HttpError(400, v.errors.join(' | '));
    if (v.task.enabled) liveTaskGuard(req, v.task, body); // live trade task: fresh authenticator code
    const old = body.id ? state.autopilot.tasks.find((t) => t.id === body.id) : null;
    if (body.id && !old) throw new HttpError(404, 'Unknown task');
    if (!old && state.autopilot.tasks.length >= 30) throw new HttpError(400, 'At most 30 tasks');
    // createdAt: a new DCA task never back-fills a period from before it existed
    if (old) Object.assign(old, v.task); else state.autopilot.tasks.push({ ...v.task, id: crypto.randomUUID(), createdAt: Date.now() });
    saveState();
    audit.write({ type: 'autopilot.task', kind: v.task.kind, name: v.task.name, action: v.task.action, enabled: v.task.enabled });
    return autopilotView();
  },
  'POST /api/autopilot/tasks/toggle': ({ req, body }) => {
    const t = state.autopilot.tasks.find((x) => x.id === body.id);
    if (!t) throw new HttpError(404, 'Unknown task');
    if (body.on === true) liveTaskGuard(req, t, body);
    t.enabled = body.on === true; saveState();
    audit.write({ type: 'autopilot.toggle', task: t.name, on: t.enabled, via: viaOf(req) });
    return autopilotView();
  },
  'POST /api/autopilot/tasks/run': async ({ req, body }) => {
    const t = state.autopilot.tasks.find((x) => x.id === body.id);
    if (!t) throw new HttpError(404, 'Unknown task');
    if (t.action === 'trade' && !t.enabled) throw new HttpError(409, 'This task places orders: switch it on first');
    liveTaskGuard(req, t, body);
    return { result: await runTask(t, viaOf(req) === 'phone' ? 'phone' : 'manual') };
  },
  'DELETE /api/autopilot/tasks': ({ url }) => {
    state.autopilot.tasks = state.autopilot.tasks.filter((t) => t.id !== url.searchParams.get('id'));
    saveState();
    return autopilotView();
  },

  'GET /api/mining': async () => {
    const [network, prices] = await Promise.all([cached('btcnet', 10 * 60_000, bitcoinNetwork), cached('px', 60_000, btcPrice)]);
    return { ...network, blockSubsidyBtc: BLOCK_SUBSIDY_BTC, btcUsd: prices.bitcoin.usd, presets: RIG_PRESETS };
  },

  'GET /api/audit': () => audit.read(200),

  // ----- order & position management -----
  'DELETE /api/orders': async ({ url }) => {
    const id = url.searchParams.get('id') ?? '';
    if (!UUID_RE.test(id)) throw new HttpError(400, 'Invalid order id');
    await alpaca.cancelOrder(id);
    audit.write({ type: 'order.cancel', brokerId: id });
    return { ok: true };
  },
  'POST /api/positions/close': async ({ body }) => {
    const symbol = String(body.symbol ?? '').toUpperCase();
    const pctClose = Number(body.percentage);
    if (!validSymbol(symbol)) throw new HttpError(400, 'Invalid symbol');
    if (!(pctClose >= 1 && pctClose <= 100)) throw new HttpError(400, 'percentage must be 1-100');
    // Closing reduces risk, so it works even with the kill switch on; in live mode it still needs a fresh 2FA code.
    if (cfg.mode === 'live' && !orderTotpGuard(cfg.totpSecret, String(body.totp ?? ''))) throw new HttpError(403, 'Live mode: enter a fresh authenticator code to close positions');
    const r = await alpaca.closePosition(symbol, Math.round(pctClose * 100) / 100);
    audit.write({ type: 'position.close', symbol, percentage: pctClose, mode: cfg.mode, brokerId: r?.id });
    notify(cfg.notifyUrl, `StocksWorks ${cfg.mode.toUpperCase()}: closed ${pctClose}% of ${symbol}`);
    return { ok: true, order: r };
  },

  // ----- portfolio analytics -----
  'GET /api/portfolio': async () => {
    const [positions, history, openOrders, spy] = await Promise.all([
      alpaca.positions(), alpaca.portfolioHistory().catch(() => ({})), alpaca.openOrders().catch(() => []), analyzeOne('SPY').catch(() => null),
    ]);
    const alloc = allocation(positions);
    // Beta vs the S&P 500 (SPY) per holding, and the value-weighted portfolio beta.
    const betas = {};
    if (spy?.closes.length > 30) {
      await Promise.all(alloc.rows.map(async (r) => {
        try { betas[r.symbol] = beta((await analyzeOne(r.assetClass === 'crypto' ? toSlash(r.symbol) : r.symbol)).closes, spy.closes); } catch { betas[r.symbol] = null; }
      }));
    }
    const known = alloc.rows.filter((r) => betas[r.symbol] != null);
    const wKnown = known.reduce((s, r) => s + r.weight, 0);
    const risk = {
      betas,
      portfolioBeta: wKnown > 0 ? known.reduce((s, r) => s + r.weight * betas[r.symbol], 0) / wKnown : null,
      coverage: stopCoverage(positions, openOrders),
    };
    const syms = (alloc.rows.length >= 2 ? alloc.rows.map((r) => (r.assetClass === 'crypto' ? toSlash(r.symbol) : r.symbol)) : state.watchlist).slice(0, 10);
    const series = {};
    await Promise.all(syms.map(async (s) => { try { const d = await analyzeOne(s); if (d.closes.length > 30) series[s] = d.closes; } catch { /* skip */ } }));
    return {
      allocation: alloc,
      performance: summarizeEquity(history.equity ?? []),
      correlation: correlationMatrix(series),
      correlationBasis: alloc.rows.length >= 2 ? 'holdings' : 'watchlist',
      risk,
    };
  },

  // ----- strategy lab -----
  'GET /api/lab/strategies': () => STRATEGIES,
  'POST /api/lab': async ({ body }) => {
    const s = String(body.symbol ?? '').toUpperCase();
    if (!validSymbol(s)) throw new HttpError(400, 'Invalid symbol');
    const v = validateParams(String(body.strategy ?? ''), body.params);
    if (!v.ok) throw new HttpError(400, v.errors.join(' | '));
    const bars = await cached(`lab:${s}`, 30 * 60_000, () => alpaca.bars(s, 750));
    const closes = bars.map((b) => b.c);
    let r;
    try { r = runStrategy(closes, body.strategy, v.params, { feeBps: 5 }); } catch (e) { throw new HttpError(400, e.message); }
    const dates = bars.slice(r.warmup).map((b) => b.t.slice(0, 10));
    return { ...r, dates, trades: r.trades.map((t) => ({ ...t, entryDate: bars[t.entryIdx]?.t.slice(0, 10), exitDate: bars[t.exitIdx]?.t.slice(0, 10) })), params: v.params };
  },

  'POST /api/lab/sweep': async ({ req, body }) => {
    const s = String(body.symbol ?? '').toUpperCase();
    if (!validSymbol(s)) throw new HttpError(400, 'Invalid symbol');
    if (!labLimit(ipOf(req))) throw new HttpError(429, 'Sweep limit reached; wait a minute');
    const base = validateParams(String(body.strategy ?? ''), body.params);
    if (!base.ok) throw new HttpError(400, base.errors.join(' | '));
    const bars = await cached(`lab:${s}`, 30 * 60_000, () => alpaca.bars(s, 750));
    try {
      return sweep(bars.map((b) => b.c), body.strategy, String(body.x ?? ''), body.y ? String(body.y) : null, base.params, { steps: 6 });
    } catch (e) { throw new HttpError(400, e.message); }
  },

  // ----- alerts -----
  'GET /api/alerts': () => ({ types: ALERT_TYPES, alerts: state.alerts, events: state.alertEvents.slice(0, 50), running: alpaca.configured }),
  'POST /api/alerts': ({ body }) => {
    const v = validateAlert(body);
    if (!v.ok) throw new HttpError(400, v.errors.join(' | '));
    if (state.alerts.length >= 100) throw new HttpError(400, 'Maximum 100 alerts');
    state.alerts.push({ ...v.alert, id: crypto.randomUUID(), createdAt: Date.now() });
    saveState();
    return state.alerts;
  },
  'POST /api/alerts/rearm': ({ body }) => {
    const a = state.alerts.find((x) => x.id === body.id);
    if (!a) throw new HttpError(404, 'Alert not found');
    Object.assign(a, { armed: true, triggeredAt: null, observed: null });
    saveState();
    return state.alerts;
  },
  'DELETE /api/alerts': ({ url }) => {
    state.alerts = state.alerts.filter((x) => x.id !== url.searchParams.get('id'));
    saveState();
    return state.alerts;
  },

  // ----- Charles Schwab -----
  'GET /api/brokers/schwab': () => ({
    enabled: schwab.configured, connected: Boolean(state.schwab), trading: cfg.schwabTrading,
    linkedAt: state.schwab?.linkedAt ?? null, expiresAt: state.schwab?.refreshExp ?? null, redirectUri: schwab.redirectUri ?? null,
  }),
  'POST /api/brokers/schwab/start': () => { needSchwab(); return { url: schwab.authorizeUrl() }; },
  'POST /api/brokers/schwab/finish': async ({ body }) => {
    needSchwab();
    const tok = await schwab.exchange(codeFromRedirect(body.url, schwab.redirectUri));
    state.schwab = { token: sealer.seal(JSON.stringify(tok)), linkedAt: Date.now(), refreshExp: tok.refreshExp };
    saveState(); cache.delete('schwab:accounts');
    audit.write({ type: 'broker.link', broker: 'schwab' });
    return { ok: true, expiresAt: tok.refreshExp };
  },
  'GET /api/brokers/schwab/accounts': () => schwabAccounts(),
  'DELETE /api/brokers/schwab': () => {
    state.schwab = null; saveState(); cache.delete('schwab:accounts');
    audit.write({ type: 'broker.unlink', broker: 'schwab' });
    return { ok: true };
  },

  // ----- banks & outside brokerages (Plaid) -----
  'GET /api/banks': () => ({ enabled: plaid.configured, env: plaid.env ?? null, items: state.banks.map(({ token: _t, ...b }) => b) }),
  'POST /api/banks/link-token': async ({ body }) => {
    needPlaid();
    const kind = body.kind === 'brokerage' ? 'brokerage' : 'bank';
    const r = await plaid.linkToken(kind, 'stocksworks-owner');
    return { link_token: r.link_token, kind };
  },
  'POST /api/banks/exchange': async ({ body }) => {
    needPlaid();
    if (typeof body.public_token !== 'string' || !/^public-[a-z]+-[0-9a-f-]{36}$/i.test(body.public_token)) throw new HttpError(400, 'Invalid public token');
    if (state.banks.length >= 25) throw new HttpError(400, 'Maximum 25 linked institutions');
    const r = await plaid.exchange(body.public_token);
    const kind = body.kind === 'brokerage' ? 'brokerage' : 'bank';
    const institution = String(body.institution ?? 'Linked institution').replace(/[^\w &.,'()-]/g, '').slice(0, 60) || 'Linked institution';
    state.banks.push({ id: crypto.randomUUID(), kind, institution, itemId: r.item_id, token: sealer.seal(r.access_token), linkedAt: Date.now() });
    saveState();
    audit.write({ type: 'bank.linked', kind, institution });
    return { ok: true };
  },
  'GET /api/banks/accounts': async () => {
    needPlaid();
    const out = await Promise.allSettled(state.banks.map(async (b) => {
      const tok = sealer.open(b.token);
      if (b.kind === 'brokerage') {
        const h = await cached(`hold:${b.id}`, 5 * 60_000, () => plaid.holdings(tok));
        const sec = new Map((h.securities ?? []).map((s) => [s.security_id, s]));
        return {
          id: b.id, kind: b.kind, institution: b.institution, accounts: (h.accounts ?? []).map(acctView),
          holdings: (h.holdings ?? []).map((x) => ({ account_id: x.account_id, ticker: sec.get(x.security_id)?.ticker_symbol ?? null, name: sec.get(x.security_id)?.name ?? 'Unknown security', quantity: x.quantity, value: x.institution_value, costBasis: x.cost_basis })),
        };
      }
      const r = await cached(`bal:${b.id}`, 5 * 60_000, () => plaid.balances(tok));
      return { id: b.id, kind: b.kind, institution: b.institution, accounts: (r.accounts ?? []).map(acctView) };
    }));
    return out.map((r, i) => (r.status === 'fulfilled' ? r.value : { id: state.banks[i].id, kind: state.banks[i].kind, institution: state.banks[i].institution, accounts: [], error: r.reason.message }));
  },
  'POST /api/banks/numbers': async ({ req, body }) => {
    needPlaid();
    const b = state.banks.find((x) => x.id === body.id && x.kind === 'bank');
    if (!b) throw new HttpError(404, 'Bank link not found');
    if (!numbersLimit(ipOf(req))) throw new HttpError(429, 'Too many reveals; try again later');
    // Account + routing numbers are enough to originate ACH debits: always require a second factor.
    if (!cfg.totpSecret) throw new HttpError(403, 'Revealing account numbers requires two-factor login. Run npm run new-totp, add TOTP_SECRET to .env and restart.');
    if (!orderTotpGuard(cfg.totpSecret, String(body.totp ?? ''))) throw new HttpError(403, 'Enter a fresh authenticator code to reveal account numbers');
    const r = await plaid.auth(sealer.open(b.token));
    audit.write({ type: 'bank.numbers.viewed', institution: b.institution });
    return {
      accounts: (r.accounts ?? []).map(acctView),
      ach: (r.numbers?.ach ?? []).map((n) => ({ account_id: n.account_id, account: n.account, routing: n.routing, wire_routing: n.wire_routing })),
    };
  },
  'DELETE /api/banks': async ({ url }) => {
    const b = state.banks.find((x) => x.id === url.searchParams.get('id'));
    if (!b) throw new HttpError(404, 'Bank link not found');
    // Revoke at Plaid first; if that fails keep the entry (so it can still be revoked) unless the owner forces it.
    if (plaid.configured) {
      try { await plaid.remove(sealer.open(b.token)); } catch (e) {
        if (url.searchParams.get('force') !== '1') throw new HttpError(502, `Plaid couldn't revoke this link (${e.message}). Try again, or use "Force unlink" and remove it in the Plaid/bank portal.`);
        audit.write({ type: 'bank.unlink.forced', institution: b.institution, reason: e.message });
      }
    }
    state.banks = state.banks.filter((x) => x !== b);
    saveState();
    audit.write({ type: 'bank.unlinked', institution: b.institution });
    return { ok: true };
  },

  // ----- trade journal -----
  'GET /api/journal': () => ({ entries: state.journal, stats: journalStats(state.journal), emotions: EMOTIONS, outcomes: OUTCOMES }),
  'POST /api/journal': ({ body }) => {
    const v = validateEntry(body);
    if (!v.ok) throw new HttpError(400, v.errors.join(' | '));
    if (state.journal.length >= 2000) throw new HttpError(400, 'Journal is full (2000 entries); export and prune it');
    state.journal.unshift({ ...v.entry, id: crypto.randomUUID(), createdAt: Date.now() });
    saveState();
    return { ok: true };
  },
  'GET /api/journal.csv': () => {
    const head = ['created_utc', 'symbol', 'side', 'setup', 'emotion', 'confidence', 'outcome', 'pnl_usd', 'thesis', 'lesson', 'broker_id'];
    const rows = state.journal.map((e) => [new Date(e.createdAt).toISOString(), e.symbol, e.side, e.setup, e.emotion, e.confidence, e.outcome, e.pnl, e.thesis, e.lesson, e.brokerId].map(csvCell).join(','));
    return { __csv: [head.join(','), ...rows].join('\r\n'), filename: `stocksworks-journal-${today()}.csv` };
  },
  'POST /api/journal/update': ({ body }) => {
    const e = state.journal.find((x) => x.id === body.id);
    if (!e) throw new HttpError(404, 'Entry not found');
    const v = validateEntry({ ...e, ...Object.fromEntries(['outcome', 'pnl', 'lesson'].filter((k) => k in body).map((k) => [k, body[k]])) });
    if (!v.ok) throw new HttpError(400, v.errors.join(' | '));
    Object.assign(e, v.entry, { updatedAt: Date.now() });
    saveState();
    return { ok: true };
  },
  'DELETE /api/journal': ({ url }) => {
    state.journal = state.journal.filter((x) => x.id !== url.searchParams.get('id'));
    saveState();
    return { ok: true };
  },

  // ----- mining fleet (operator side) -----
  'GET /api/fleet': () => ({
    enabled: Boolean(cfg.fleet), rigUrl: cfg.fleet?.publicUrl ?? null, fingerprint: cfg.fleet?.fingerprint ?? null,
    config: state.fleet.config,
    rigs: state.fleet.rigs.map(({ tokenHash: _t, ...r }) => {
      const live = rigLive.get(r.id);
      return { ...r, lastSeen: live?.lastSeen ?? null, stats: live?.stats ?? null, ip: live?.ip ?? null, history: (live?.history ?? []).map((p) => p.h ?? 0), online: Boolean(live && Date.now() - live.lastSeen < 60_000) };
    }),
  }),
  'POST /api/fleet/config': ({ body }) => {
    const v = validateFleetConfig(body);
    if (!v.ok) throw new HttpError(400, v.errors.join(' | '));
    state.fleet.config = v.config; saveState();
    audit.write({ type: 'fleet.config', coin: v.config.coin, pool: v.config.pool, payout: v.config.payout });
    return v.config;
  },
  'POST /api/fleet/pair': () => {
    if (!cfg.fleet) throw new HttpError(409, 'Fleet listener is off. Set FLEET_ENABLED=on and FLEET_TLS_CERT/KEY (npm run make-cert), then restart.');
    const p = pairing.create();
    audit.write({ type: 'fleet.pair.code' });
    return { ...p, link: pairingLink({ url: cfg.fleet.publicUrl, code: p.code, fingerprint: cfg.fleet.fingerprint }) };
  },
  'POST /api/fleet/command': ({ body }) => {
    if (!['run', 'stop'].includes(body.desired)) throw new HttpError(400, 'desired must be run or stop');
    const rigs = body.rigId === 'all' ? state.fleet.rigs : state.fleet.rigs.filter((r) => r.id === body.rigId);
    if (!rigs.length) throw new HttpError(404, 'Rig not found');
    if (body.desired === 'run' && !state.fleet.config) throw new HttpError(409, 'Save the pool + payout config first');
    for (const r of rigs) r.desired = body.desired;
    saveState();
    audit.write({ type: 'fleet.command', desired: body.desired, rigs: rigs.map((r) => r.name) });
    return { updated: rigs.length };
  },
  'DELETE /api/fleet/rig': ({ url }) => {
    const id = url.searchParams.get('id');
    const rig = state.fleet.rigs.find((r) => r.id === id);
    if (!rig) throw new HttpError(404, 'Rig not found');
    state.fleet.rigs = state.fleet.rigs.filter((r) => r.id !== id); // its token is now dead
    rigLive.delete(id); saveState();
    audit.write({ type: 'fleet.revoke', rig: rig.name });
    return { ok: true };
  },

  // ----- this computer's mining & sharing (desktop app only; switching approved programs on/off, never approving) -----
  'GET /api/desktop/workloads': () => sup().list().map(({ exe: _e, sha256: _s, args: _a, pass: _p, payout: _w, log: _l, apiPort: _ap, ...w }) => w),
  'POST /api/desktop/workloads/toggle': async ({ req, body }) => {
    try { await sup().toggle(String(body.id ?? ''), body.on === true); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(404, e.message); }
    sup().tick().catch(() => {});
    audit.write({ type: 'workload.toggle', id: String(body.id).slice(0, 40), on: body.on === true, via: viaOf(req) });
    return { ok: true };
  },
  'POST /api/desktop/workloads/pause-all': ({ req }) => {
    sup().pauseAll();
    audit.write({ type: 'workload.pause-all', via: viaOf(req) });
    return { ok: true };
  },

  // ----- phone remote: managed from this PC only (none of these are in PHONE_ROUTES) -----
  'GET /api/phone': () => ({
    enabled: state.phone.enabled, running: Boolean(phoneServer) && phoneHost === '0.0.0.0', emulatorOnly: phoneHost === '127.0.0.1', port: PHONE_PORT, fingerprint: phoneFingerprint,
    urls: lanIps().map((ip) => `https://${ip}:${PHONE_PORT}/`), devices: state.phone.devices.map(({ tokenHash: _t, ...d }) => d),
  }),
  'POST /api/phone/enable': async ({ body }) => {
    if (body.on === true) await startPhone(); else stopPhone(); // a failed start throws before "enabled" is saved
    state.phone.enabled = body.on === true;
    saveState();
    audit.write({ type: 'phone.listener', on: state.phone.enabled });
    return routes['GET /api/phone']();
  },
  'POST /api/phone/pair': async () => {
    if (!phoneServer || phoneHost !== '0.0.0.0') throw new HttpError(409, 'Turn phone access on first');
    const links = lanIps().map((ip) => `https://${ip}:${PHONE_PORT}/remote.html#pair=`);
    if (!links.length) throw new HttpError(409, 'This PC has no network connection');
    const p = phonePairing.create();
    audit.write({ type: 'phone.pair.code' });
    const full = links.map((l) => l + p.code);
    return { ...p, links: full, qrs: await Promise.all(full.map((l) => QRCode.toDataURL(l, { margin: 1, width: 260 }))) };
  },
  'DELETE /api/phone/devices': ({ url }) => {
    const dev = state.phone.devices.find((d) => d.id === url.searchParams.get('id'));
    if (!dev) throw new HttpError(404, 'Device not found');
    state.phone.devices = state.phone.devices.filter((d) => d !== dev); // its token is dead on the next request
    saveState();
    audit.write({ type: 'phone.revoke', device: dev.name });
    return { ok: true };
  },
};

// AI Lab: model catalog + fit, local analyst, Claude as teacher, review -> dataset, from-scratch model designer.
Object.assign(routes, createAiLab({
  state, saveState, dataDir: DATA, rootDir: ROOT, analyzeOne, alpacaConfigured: () => alpaca.configured, audit, lessons: LESSONS,
  aiAllowed: (req) => Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && (!req || aiLimit(ipOf(req))),
}));

const PUBLIC_ROUTES = new Set(['GET /api/session', 'POST /api/login']);

const seenHooks = new Map();
// ponytail: 'false' from a limiter means "over budget"; here it just means "stop logging this IP's junk for now".
const deniedLogLimit = (() => { const l = rateLimiter(10, 60_000); return (ip) => !l(ip); })();

// DNS-rebinding guard: only answer to hostnames we expect (add a tunnel hostname via ALLOWED_HOSTS).
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', cfg.host, ...(env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)]);
const hostOk = (req) => ALLOWED_HOSTS.has(String(req.headers.host ?? '').replace(/:\d+$/, ''));

async function handleWebhook(req, res) {
  if (!hookLimit(ipOf(req))) return send(res, 429, { error: 'rate limited' });
  const raw = await readBody(req);
  const json = parseJson(raw);
  const v = verifyWebhook({ raw, json, headers: req.headers, secret: cfg.webhookSecret });
  if (!v.ok) {
    if (!deniedLogLimit(ipOf(req))) audit.write({ type: 'webhook.denied', ip: ipOf(req), reason: v.reason }); // bounded log growth
    return send(res, 401, { error: 'unauthorized' });
  }
  // Replay guard: an identical authenticated payload is accepted once per 10 minutes.
  // TradingView: include {{timenow}} in the alert JSON so every genuine alert is unique.
  const fp = crypto.createHash('sha256').update(`${req.headers['x-timestamp'] ?? ''}.${raw}`).digest('hex');
  const now = Date.now();
  for (const [k, t] of seenHooks) if (now - t > 10 * 60_000) seenHooks.delete(k);
  if (seenHooks.has(fp)) { audit.write({ type: 'webhook.replay' }); return send(res, 409, { error: 'duplicate' }); }
  seenHooks.set(fp, now);
  audit.write({ type: 'webhook.received', order: pick(json) });
  if (!cfg.webhookTrading) {
    notify(cfg.notifyUrl, `TradingView alert: ${json.side ?? ''} ${json.symbol ?? ''} ${json.message ?? ''}`.slice(0, 300));
    return send(res, 202, { accepted: true, trading: false });
  }
  const { secret: _drop, ...order } = json;
  const placed = await placeOrder(order, 'webhook'); // live confirmation for webhooks = WEBHOOK_LIVE_ACK, decided in placeOrderNow
  return send(res, 200, { id: placed.id, status: placed.status });
}

/** via.phone: the request arrived through the paired-phone listener (phoneHandler already checked device + allowlist). */
async function handler(req, res, via = {}) {
  secureHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/webhooks/tradingview') return await handleWebhook(req, res);
    if (!via.phone && !hostOk(req)) return send(res, 421, { error: 'Unexpected Host header' }); // phones use the PC's IP; TLS + device token guard them
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(url.pathname, res);
    }
    const key = `${req.method} ${url.pathname}`;
    const route = Object.hasOwn(routes, key) ? routes[key] : null;
    if (!route) return send(res, 404, { error: 'Not found' });

    const session = sessions.get(cookies(req)[cookieName]);
    if (!PUBLIC_ROUTES.has(key) && !session) return send(res, 401, { error: 'Login required' });
    let body = {};
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && (!URL.canParse(origin) || new URL(origin).host !== req.headers.host)) return send(res, 403, { error: 'Cross-origin request blocked' });
      if (key !== 'POST /api/login' && !safeEqual(req.headers['x-csrf-token'] ?? '', session?.csrf ?? crypto.randomUUID()))
        return send(res, 403, { error: 'CSRF check failed' });
      if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
      body = parseJson(await readBody(req));
    }
    const out = await route({ req, res, url, body, session });
    if (out?.__csv !== undefined) {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${out.filename}"` });
      return res.end(out.__csv);
    }
    return send(res, 200, out ?? {});
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
  }
}

// ---------- rig listener: exposes ONLY /rig/pair and /rig/heartbeat, TLS only ----------
async function rigHandler(req, res) {
  secureHeaders(res);
  const ip = ipOf(req);
  try {
    const { pathname } = new URL(req.url, 'https://rig');
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const body = parseJson(await readBody(req));

    if (pathname === '/rig/pair') {
      if (pairFailLimit.blocked(ip)) return send(res, 429, { error: 'Too many attempts' });
      if (!pairing.consume(body.code)) {
        pairFailLimit(ip);
        audit.write({ type: 'fleet.pair.fail', ip });
        return send(res, 401, { error: 'Invalid or expired pairing code' });
      }
      if (state.fleet.rigs.length >= 200) return send(res, 400, { error: 'Fleet is full' });
      let name = WORKER_RE.test(String(body.name)) ? String(body.name) : `rig${state.fleet.rigs.length + 1}`;
      while (state.fleet.rigs.some((r) => r.name === name)) name = `${name.slice(0, 26)}-${crypto.randomBytes(2).toString('hex')}`;
      const token = newRigToken();
      const rig = { id: crypto.randomUUID(), name, tokenHash: tokenHash(token), pairedAt: Date.now(), desired: 'stop' };
      state.fleet.rigs.push(rig); saveState();
      audit.write({ type: 'fleet.paired', rig: name, ip });
      notify(cfg.notifyUrl, `StocksWorks: new mining rig paired (${name})`);
      return send(res, 200, { rigId: rig.id, token, name });
    }

    if (pathname === '/rig/heartbeat') {
      const h = tokenHash(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      const rig = state.fleet.rigs.find((r) => safeEqual(r.tokenHash, h));
      if (!rig) return send(res, 401, { error: 'Unknown or revoked rig' });
      if (!heartbeatLimit(rig.id)) return send(res, 429, { error: 'Slow down' });
      const prev = rigLive.get(rig.id);
      const stats = sanitizeStats(body.stats);
      if (prev?.offline) { audit.write({ type: 'fleet.online', rig: rig.name }); notify(cfg.notifyUrl, `StocksWorks rig ${rig.name} is back online`); }
      const history = [...(prev?.history ?? []), { t: Date.now(), h: stats.running ? stats.hashrate : 0 }].slice(-240); // ~1h at 15s
      rigLive.set(rig.id, { lastSeen: Date.now(), stats, ip, history, offline: false });
      return send(res, 200, { name: rig.name, desired: rig.desired, config: state.fleet.config });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
  }
}
// ---------- phone remote (optional, off by default): paired phones over Wi-Fi or a VPN, TLS only ----------
/** Set by the desktop app (electron/main.mjs) so the API can switch this PC's approved workloads: { supervisor }. */
export const desktopHooks = {};
const sup = () => { if (!desktopHooks.supervisor) throw new HttpError(409, 'Mining and sharing on this computer exist only in the desktop app'); return desktopHooks.supervisor; };
const PHONE_PORT = num(env.PHONE_PORT, 8789);
const PHONE_DEV = 'swdev';
const PHONE_STATIC = new Set(['/remote.html', '/remote.js', '/app.css', '/manifest.webmanifest', '/icon.png', '/favicon.svg']);
// Least privilege: watch, trade through the same risk gate (live gates included), halt, and switch approved programs.
// Not here: approving programs, pairing devices, settings, bank numbers, wallets, fleet config, audit export.
const PHONE_ROUTES = new Set(['GET /api/session', 'POST /api/login', 'POST /api/logout', 'GET /api/status', 'GET /api/account', 'GET /api/history',
  'POST /api/orders/preview', 'POST /api/orders', 'DELETE /api/orders', 'POST /api/positions/close', 'POST /api/kill', 'GET /api/alerts',
  'GET /api/fleet', 'POST /api/fleet/command', 'GET /api/brokers/schwab/accounts',
  'GET /api/desktop/workloads', 'POST /api/desktop/workloads/toggle', 'POST /api/desktop/workloads/pause-all',
  // Full mobile app: switch what runs when, run/toggle existing tasks, read markets, wallets and research, teach the AI.
  // Creating/editing tasks and adding wallets stay on the PC (they decide where money goes).
  'GET /api/autopilot', 'POST /api/autopilot/focus', 'POST /api/autopilot/tasks/toggle', 'POST /api/autopilot/tasks/run',
  'GET /api/scan', 'GET /api/symbol', 'POST /api/ai/analyze', 'GET /api/crypto/markets', 'GET /api/wallets', 'GET /api/chains',
  'GET /api/mining', 'GET /api/mining/coins', 'GET /api/research/sources', 'GET /api/research/finviz', 'GET /api/research/messari/news',
  'GET /api/research/traders', 'GET /api/research/trader', 'POST /api/research/learn',
  'GET /api/intel', 'GET /api/intel/macro', 'GET /api/intel/sources', 'POST /api/factcheck']);
let phonePairing = new Pairing();
const phonePairLimit = rateLimiter(10, 15 * 60_000);
let phoneServer = null, phoneFingerprint = null;
const viaOf = (req) => (phoneServer && req.socket.server === phoneServer ? 'phone' : 'desktop');
// Home Wi-Fi first, then other private ranges, Tailscale (100.x), and virtual adapters (172.x: WSL/Hyper-V) last.
// Virtual adapters (VirtualBox, VMware, WSL/Hyper-V, Docker) go last: a phone can't reach them.
const VIRTUAL_NIC = /virtualbox|vmware|vethernet|hyper-v|wsl|docker|vbox|loopback|bluetooth/i;
const ipRank = (name, ip) => (VIRTUAL_NIC.test(name) || ip.startsWith('192.168.56.') ? 9 : /wi-?fi|wlan|wireless/i.test(name) ? -1 :/tailscale/i.test(name) || ip.startsWith('100.') ? 2 : ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 3);
const lanIps = () => Object.entries(os.networkInterfaces())
  .flatMap(([name, list]) => (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ ip: i.address, rank: ipRank(name, i.address) })))
  .sort((a, b) => a.rank - b.rank).map((x) => x.ip);
function phoneTls() {
  const dir = path.join(DATA, 'tls'), certF = path.join(dir, 'phone-cert.pem'), keyF = path.join(dir, 'phone-key.pem');
  const current = () => {
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(certF));
      return fs.existsSync(keyF) && new Date(x.validTo) - Date.now() > 30 * 86_400_000 && lanIps().every((ip) => x.subjectAltName?.includes(`IP Address:${ip}`));
    } catch { return false; }
  };
  if (!current()) { // missing, expiring within 30 days, or this PC has a new address: re-issue (phones accept it once again)
    const c = selfSignedCert({ cn: 'StocksWorks Phone', ips: ['127.0.0.1', ...lanIps()] });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyF, c.key, { mode: 0o600 });
    fs.writeFileSync(certF, c.cert);
  }
  const cert = fs.readFileSync(certF);
  return { cert, key: fs.readFileSync(keyF), fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
}
const phoneDevice = (req) => {
  const t = cookies(req)[PHONE_DEV];
  if (!t) return null;
  const h = tokenHash(t);
  return state.phone.devices.find((d) => safeEqual(d.tokenHash, h)) ?? null;
};
async function phoneHandler(req, res) {
  secureHeaders(res);
  try {
    const url = new URL(req.url, 'https://phone');
    if (req.method === 'POST' && url.pathname === '/phone/pair') {
      const ip = ipOf(req);
      if (phonePairLimit.blocked(ip)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON required' });
      const body = parseJson(await readBody(req));
      if (!phonePairing.consume(body.code)) {
        phonePairLimit(ip); audit.write({ type: 'phone.pair.fail', ip });
        return send(res, 403, { error: 'That pairing code is wrong or expired. Make a new one on your PC.' });
      }
      if (state.phone.devices.length >= 10) return send(res, 409, { error: 'At most 10 paired phones: remove one on your PC first' });
      const token = newRigToken();
      const name = String(body.name ?? '').replace(/[^\w .'()-]/g, '').trim().slice(0, 40) || 'Phone';
      state.phone.devices.push({ id: crypto.randomUUID(), name, tokenHash: tokenHash(token), pairedAt: Date.now() });
      saveState();
      audit.write({ type: 'phone.paired', device: name, ip });
      res.setHeader('Set-Cookie', `${PHONE_DEV}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${90 * 86_400}`);
      return send(res, 200, { ok: true, name });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      if (url.pathname === '/') { res.writeHead(302, { Location: '/remote.html' }); return res.end(); }
      return PHONE_STATIC.has(url.pathname) ? serveStatic(url.pathname, res) : send(res, 404, { error: 'Not found' });
    }
    const dev = phoneDevice(req);
    if (!dev) return send(res, 401, { error: 'This phone is not paired', unpaired: true });
    if (!PHONE_ROUTES.has(`${req.method} ${url.pathname}`)) return send(res, 403, { error: 'Not available from the phone' });
    dev.lastSeen = Date.now(); // in memory; written with the next state save
    return handler(req, res, { phone: dev });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
  }
}
let phoneHost = null; // '0.0.0.0' = phone access for real phones; '127.0.0.1' = emulator-only (this PC)
async function startPhone(host = '0.0.0.0') {
  if (phoneServer && (phoneHost === host || phoneHost === '0.0.0.0')) return;
  if (phoneServer) await stopPhone(); // emulator-only listener -> real phone access: rebind on the network
  const t = phoneTls();
  const s = https.createServer({ cert: t.cert, key: t.key, minVersion: 'TLSv1.2' }, phoneHandler);
  s.requestTimeout = 30_000;
  s.headersTimeout = 10_000;
  phoneServer = s; // claimed before listen: a stop or second start during startup sees it
  phoneFingerprint = t.fingerprint;
  try {
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(PHONE_PORT, host, resolve); });
  } catch (e) {
    if (phoneServer === s) phoneServer = null;
    throw new HttpError(409, `Phone listener could not start on port ${PHONE_PORT}: ${e.code ?? e.message}`);
  }
  phoneHost = host;
  s.on('error', (e) => console.error('phone listener:', e.message)); // later errors must not crash the desk
  console.log(`Phone listener on https://${host}:${PHONE_PORT}`);
}
/** Resolves once the port is released. */
function stopPhone() {
  const s = phoneServer;
  phoneServer = null; phoneHost = null;
  phonePairing = new Pairing(); // outstanding pairing codes die with the listener
  const closed = s ? new Promise((r) => s.close(r)) : Promise.resolve();
  s?.closeAllConnections();
  return closed;
}
if (state.phone.enabled) startPhone().catch((e) => console.error(e.message));

/**
 * Phone emulator (desktop app only): turns phone access on if needed and returns the loopback URL the emulator
 * window opens, with a one-time pairing code when the emulator isn't paired yet, plus the certificate fingerprint
 * the window pins. Same listener, same pairing, same routes as a real phone: what passes here passes there.
 */
desktopHooks.phoneEmulator = async ({ paired }) => {
  if (!phoneServer) { // emulator-only: loopback, not remembered, stopped when the emulator closes (no LAN exposure)
    await startPhone('127.0.0.1');
    audit.write({ type: 'phone.listener', on: true, via: 'emulator', host: '127.0.0.1' });
  }
  // The emulator's cookie may outlive its device record (removed on the PC, state reset): then pair again.
  const known = state.phone.devices.some((d) => d.name.startsWith('Phone emulator'));
  const code = paired && known ? null : phonePairing.create().code;
  if (code) audit.write({ type: 'phone.pair.code', via: 'emulator' });
  return { url: `https://127.0.0.1:${PHONE_PORT}/remote.html${code ? `#pair=${code}` : ''}`, origin: `https://127.0.0.1:${PHONE_PORT}`, fingerprint: phoneFingerprint };
};
/** Emulator window closed: drop the emulator-only listener (real phone access, if on, is left alone). */
desktopHooks.phoneEmulatorClosed = () => { if (phoneHost === '127.0.0.1' && !state.phone.enabled) stopPhone(); };

if (cfg.fleet) {
  const rigServer = https.createServer({ cert: cfg.fleet.cert, key: cfg.fleet.key, minVersion: 'TLSv1.2' }, rigHandler);
  rigServer.requestTimeout = 15_000;
  rigServer.headersTimeout = 10_000;
  rigServer.listen(cfg.fleet.port, cfg.fleet.host, () => console.log(`Rig listener on https://${cfg.fleet.host}:${cfg.fleet.port}  (rigs use ${cfg.fleet.publicUrl})`));
}

// ---------- background monitors ----------
/** Alerts: every minute, evaluate armed alerts (one-shot) and notify. */
async function runAlerts() {
  const armed = state.alerts.filter((a) => a.armed);
  if (!armed.length || !alpaca.configured) return;
  // Stocks only move in the session: no polling while the US market is closed (crypto trades 24/7).
  const symbols = [...new Set(armed.map((a) => a.symbol))].filter((s) => isCrypto(s) || usMarketOpen());
  const market = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      // Price-only alerts need just the last trade; history (bars) only for move/score/RSI/SMA alerts.
      const needsBars = armed.some((a) => a.symbol === s && !['price_above', 'price_below'].includes(a.type));
      const [last, d] = await Promise.all([cached(`last:${s}`, 20_000, () => alpaca.lastPrice(s)), needsBars ? analyzeOne(s) : null]);
      const lastBarIsToday = d?.dates.at(-1) === today();
      const m = d?.signal?.metrics;
      market[s] = { price: last.price, prevClose: d ? (lastBarIsToday ? d.closes.at(-2) : d.closes.at(-1)) : null, score: d?.signal?.score ?? null, rsi: m?.rsi14 ?? null, sma20: m?.sma20 ?? null, sma50: m?.sma50 ?? null };
    } catch { /* data unavailable: alerts on this symbol simply wait */ }
  }));
  let changed = false;
  for (const a of armed) {
    if (!market[a.symbol]) continue;
    const r = checkAlert(a, market[a.symbol]);
    if (!r.hit) continue;
    Object.assign(a, { armed: false, triggeredAt: Date.now(), observed: r.observed });
    const text = `${a.symbol}: ${ALERT_TYPES[a.type].label} ${a.value}${ALERT_TYPES[a.type].unit === '$' ? '' : ALERT_TYPES[a.type].unit} (now ${Number(r.observed).toFixed(2)})${a.note ? ` - ${a.note}` : ''}`;
    state.alertEvents.unshift({ at: Date.now(), alertId: a.id, text });
    state.alertEvents = state.alertEvents.slice(0, 100);
    audit.write({ type: 'alert.fired', symbol: a.symbol, alertType: a.type, value: a.value, observed: r.observed });
    notify(cfg.notifyUrl, `StocksWorks alert: ${text}`);
    changed = true;
  }
  if (changed) saveState();
}
/** Fleet: tell the operator once when a rig stops reporting. */
function runFleetWatch() {
  for (const rig of state.fleet.rigs) {
    const live = rigLive.get(rig.id);
    if (live && !live.offline && Date.now() - live.lastSeen > 90_000) {
      live.offline = true;
      audit.write({ type: 'fleet.offline', rig: rig.name });
      notify(cfg.notifyUrl, `StocksWorks rig ${rig.name} went offline${rig.desired === 'run' ? ' while it should be mining' : ''}`);
    }
  }
}
setInterval(() => runAlerts().catch((e) => console.warn('alerts:', e.message)), 60_000).unref();
setInterval(runFleetWatch, 30_000).unref();
setInterval(() => runAutopilot().catch((e) => console.warn('autopilot:', e.message)), 60_000).unref();
setTimeout(applyFocus, 5_000).unref(); // the desktop app attaches its supervisor right after import

// Defense in depth: a stray rejection must not let one request take the whole desk down.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.message ?? e));

const server = cfg.tls ? https.createServer(cfg.tls, handler) : http.createServer(handler);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
/** Resolves once listening; rejects on e.g. port-in-use. Used by the desktop app. */
export const ready = new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
server.listen(cfg.port, cfg.host, () => {
  console.log(`StocksWorks on ${cfg.tls ? 'https' : 'http'}://${cfg.host}:${cfg.port}  mode=${cfg.mode.toUpperCase()}  alpaca=${alpaca.configured}  2FA=${Boolean(cfg.totpSecret)}`);
});
