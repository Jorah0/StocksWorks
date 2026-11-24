// StocksWorks server: zero-framework Node HTTP(S). Run with `npm start` (loads .env).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Sessions, verifyPassword, rateLimiter, verifyWebhook, createAuditLog, safeEqual, totpReplayGuard, createConfirmer } from './lib/security.js';
import { validateOrder, STOCK_RE, CRYPTO_RE } from './lib/risk.js';
import { scoreSeries, backtest } from './lib/signals.js';
import { RIG_PRESETS, BLOCK_SUBSIDY_BTC } from './lib/mining.js';
import { createAlpaca, cryptoMarkets, btcPrice, bitcoinNetwork, balanceOf, notify, validAddress, HttpError } from './lib/providers.js';
import { analyzeSymbol, tutor } from './lib/ai.js';
import { validateFleetConfig, Pairing, newRigToken, tokenHash, sanitizeStats, pairingLink, WORKER_RE } from './lib/fleet.js';
import os from 'node:os';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
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
};

// ---------- refuse unsafe configurations at boot ----------
const die = (msg) => { console.error(`\n[StocksWorks] refusing to start: ${msg}\n`); process.exit(1); };
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

const alpaca = createAlpaca({ keyId: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY, mode: cfg.mode });
const audit = createAuditLog(path.join(DATA, 'audit.jsonl'));
const sessions = new Sessions();
setInterval(() => sessions.sweep(), 10 * 60_000).unref();
const totpGuard = totpReplayGuard();
const orderTotpGuard = totpReplayGuard();
const confirmer = createConfirmer();
const loginLimit = rateLimiter(5, 15 * 60_000);
const aiLimit = rateLimiter(30, 60 * 60_000);
const hookLimit = rateLimiter(30, 60_000);

// ---------- small persisted state (watchlist, watch-only wallets, kill switch) ----------
const STATE_FILE = path.join(DATA, 'state.json');
const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'SPY', 'QQQ', 'BTC/USD', 'ETH/USD', 'SOL/USD'];
let state = { watchlist: DEFAULT_WATCHLIST, wallets: [], killSwitch: env.KILL_SWITCH === 'on', fleet: { config: null, rigs: [] } };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
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
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- domain operations ----------
const validSymbol = (s) => STOCK_RE.test(s) || CRYPTO_RE.test(s);
const today = () => new Date().toISOString().slice(0, 10);
// Counted from the audit log so a restart can't reset the daily limits.
// ponytail: parses the log once per call; keep running totals in memory if the log grows to many MB.
function todayStats() {
  const d = today();
  const placed = audit.lines().filter((l) => l.includes('"order.placed"')).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'order.placed' && String(e.ts).startsWith(d));
  return { count: placed.length, notional: placed.reduce((a, e) => a + (Number(e.notional) || 0), 0) };
}
const ordersToday = () => todayStats().count;
const pick = (o) => Object.fromEntries(['symbol', 'side', 'type', 'qty', 'notional', 'limit_price', 'stop_loss', 'take_profit'].map((k) => [k, o?.[k] == null ? undefined : String(o[k]).slice(0, 32)]));

async function riskContext(raw) {
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

async function placeOrderNow(raw, source) {
  const ctx = await riskContext(raw);
  // Live confirmation is decided here, never by a request flag: UI orders must redeem the token issued at preview
  // for this exact normalized order; webhook orders only with the operator's WEBHOOK_LIVE_ACK.
  if (cfg.mode === 'live') {
    const normalized = validateOrder(raw, { ...ctx, confirmed: true }).order;
    // UI live orders need two things: the preview token for this exact order AND a fresh authenticator code
    // (a second factor a hijacked session or injected script doesn't have). Separate guard from login's.
    ctx.confirmed = source === 'webhook' ? cfg.webhookLive
      : confirmer.redeem(raw.confirmToken, normalized) && orderTotpGuard(cfg.totpSecret, String(raw.totp ?? ''));
  }
  const v = validateOrder(raw, ctx);
  if (!v.ok) {
    audit.write({ type: 'order.rejected', source, order: pick(raw), errors: v.errors });
    throw new HttpError(422, v.errors.join(' | '));
  }
  const placed = await alpaca.placeOrder({ ...v.order, client_order_id: `sw-${crypto.randomUUID()}` });
  audit.write({ type: 'order.placed', source, mode: cfg.mode, order: v.order, notional: v.notional, riskUsd: v.riskUsd, brokerId: placed.id });
  notify(cfg.notifyUrl, `StocksWorks ${cfg.mode.toUpperCase()} ${v.order.side} ${v.order.qty ?? '$' + v.order.notional} ${v.order.symbol} (${source})`);
  return placed;
}

async function analyzeOne(symbol) {
  return cached(`sym:${symbol}`, 5 * 60_000, async () => {
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

// ---------- HTTP plumbing ----------
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
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
const parseJson = (raw) => { try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); } };
const cookieName = cfg.tls ? '__Host-sw' : 'sw';
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
const ipOf = (req) => req.socket.remoteAddress ?? '?';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
// Pure, dependency-free modules shared with the browser so the math has one source of truth.
const SHARED = Object.fromEntries(['signals', 'mining', 'keccak'].map((m) => [`/lib/${m}.js`, path.join(ROOT, `lib/${m}.js`)]));

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
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${cfg.tls ? '; Secure' : ''}`);
    return { csrf };
  },

  'POST /api/logout': ({ req, res }) => {
    sessions.destroy(cookies(req)[cookieName]);
    res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cfg.tls ? '; Secure' : ''}`);
    return { ok: true };
  },

  'GET /api/status': () => ({
    mode: cfg.mode, killSwitch: state.killSwitch, limits: cfg.limits,
    alpaca: alpaca.configured, ai: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    webhook: { configured: cfg.webhookSecret.length >= 16, trading: cfg.webhookTrading },
    notify: Boolean(cfg.notifyUrl), totp: Boolean(cfg.totpSecret), tls: Boolean(cfg.tls), ordersToday: ordersToday(),
  }),

  'GET /api/account': async () => {
    const [account, positions, orders] = await Promise.all([alpaca.account(), alpaca.positions(), alpaca.orders()]);
    return { account, positions, orders };
  },

  'POST /api/orders/preview': async ({ body }) => {
    const ctx = await riskContext(body);
    const v = validateOrder(body, { ...ctx, confirmed: true });
    // In live mode a passing preview issues a 2-minute, single-use token bound to this exact order.
    const confirmToken = cfg.mode === 'live' && v.ok ? confirmer.issue(v.order) : null;
    return { ...v, confirmToken, price: ctx.price, priceAgeSec: ctx.priceAgeSec, equity: ctx.equity, notionalToday: ctx.notionalToday, mode: cfg.mode };
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
    state.killSwitch = body.on === true;
    saveState();
    const actions = [];
    if (state.killSwitch && alpaca.configured) {
      await alpaca.cancelAll(); actions.push('cancelled open orders');
      if (body.flatten === true) { await alpaca.closeAll(); actions.push('closed all positions'); }
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
    if (!aiLimit(ipOf(req))) throw new HttpError(429, 'AI hourly limit reached');
    const d = await analyzeOne(s);
    const news = await alpaca.news(s).catch(() => []);
    const result = await analyzeSymbol({ symbol: s, signal: d.signal, backtest: d.backtest, news, web: body.web === true });
    audit.write({ type: 'ai.analyze', symbol: s, stance: result.stance, confidence: result.confidence, web: body.web === true });
    return { ...result, news };
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

  'GET /api/wallets': async () => {
    const out = await Promise.allSettled(state.wallets.map((w) => cached(`bal:${w.address}`, 60_000, () => balanceOf(w.chain, w.address, cfg.ethRpc))));
    return state.wallets.map((w, i) => ({ ...w, balance: out[i].value ?? null, error: out[i].reason?.message }));
  },
  'POST /api/wallets': ({ body }) => {
    if (typeof body.chain !== 'string') throw new HttpError(400, 'Invalid chain');
    const chain = body.chain, address = String(body.address ?? '').trim(), label = String(body.label ?? '').slice(0, 40);
    if (!validAddress(chain, address)) throw new HttpError(400, 'Invalid address for chain (check for typos)');
    if (state.wallets.length >= 50) throw new HttpError(400, 'Too many wallets');
    if (!state.wallets.some((w) => w.address === address)) state.wallets.push({ chain, address, label });
    saveState();
    audit.write({ type: 'wallet.watch', chain, address });
    return state.wallets;
  },
  'DELETE /api/wallets': ({ url }) => {
    state.wallets = state.wallets.filter((w) => w.address !== url.searchParams.get('address'));
    saveState();
    return state.wallets;
  },

  'GET /api/mining': async () => {
    const [network, prices] = await Promise.all([cached('btcnet', 10 * 60_000, bitcoinNetwork), cached('px', 60_000, btcPrice)]);
    return { ...network, blockSubsidyBtc: BLOCK_SUBSIDY_BTC, btcUsd: prices.bitcoin.usd, presets: RIG_PRESETS };
  },

  'GET /api/audit': () => audit.read(200),

  // ----- mining fleet (operator side) -----
  'GET /api/fleet': () => ({
    enabled: Boolean(cfg.fleet), rigUrl: cfg.fleet?.publicUrl ?? null, fingerprint: cfg.fleet?.fingerprint ?? null,
    config: state.fleet.config,
    rigs: state.fleet.rigs.map(({ tokenHash: _t, ...r }) => {
      const live = rigLive.get(r.id);
      return { ...r, lastSeen: live?.lastSeen ?? null, stats: live?.stats ?? null, ip: live?.ip ?? null, online: Boolean(live && Date.now() - live.lastSeen < 60_000) };
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
};

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

async function handler(req, res) {
  secureHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/webhooks/tradingview') return await handleWebhook(req, res);
    if (!hostOk(req)) return send(res, 421, { error: 'Unexpected Host header' });
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
      rigLive.set(rig.id, { lastSeen: Date.now(), stats: sanitizeStats(body.stats), ip });
      return send(res, 200, { name: rig.name, desired: rig.desired, config: state.fleet.config });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
  }
}
if (cfg.fleet) {
  const rigServer = https.createServer({ cert: cfg.fleet.cert, key: cfg.fleet.key, minVersion: 'TLSv1.2' }, rigHandler);
  rigServer.requestTimeout = 15_000;
  rigServer.headersTimeout = 10_000;
  rigServer.listen(cfg.fleet.port, cfg.fleet.host, () => console.log(`Rig listener on https://${cfg.fleet.host}:${cfg.fleet.port}  (rigs use ${cfg.fleet.publicUrl})`));
}

// Defense in depth: a stray rejection must not let one request take the whole desk down.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.message ?? e));

const server = cfg.tls ? https.createServer(cfg.tls, handler) : http.createServer(handler);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(cfg.port, cfg.host, () => {
  console.log(`StocksWorks on ${cfg.tls ? 'https' : 'http'}://${cfg.host}:${cfg.port}  mode=${cfg.mode.toUpperCase()}  alpaca=${alpaca.configured}  2FA=${Boolean(cfg.totpSecret)}`);
});
