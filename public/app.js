// StocksWorks frontend. No frameworks; every dynamic value goes through esc() before reaching innerHTML.
import { sma } from '/lib/signals.js';
import { miningProfit } from '/lib/mining.js';
import { isValidEthAddress } from '/lib/keccak.js';
import { LESSONS, COMPARE, COMPARE_COLS, COMPARE_SOURCES, LINKS } from '/content.js';
import { mountWorkloads } from '/workloads.js';
import { mountAiLab } from '/ailab.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n, d) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: d ?? (Math.abs(n) < 1 && n != 0 ? 4 : 2) }));
const pct = (n) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(2)}%`);
const fmt = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let csrf = null;
let status = {};
let scanCache = null;

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = 'toast'), 4500);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf ?? '';
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') showLogin();
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}
const fail = (el) => (e) => { el.innerHTML = `<div class="card err">${esc(e.message)}</div>`; };

// ---------------- charts (inline SVG; attributes, not style, so CSP stays strict) ----------------
function sparkline(v, w = 120, h = 32) {
  if (!v?.length) return '';
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - ((x - lo) / span) * h).toFixed(1)}`).join(' ');
  const col = v.at(-1) >= v[0] ? 'var(--up)' : 'var(--down)';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5"/></svg>`;
}
function scoreBar(raw) {
  const score = raw == null ? null : Math.max(0, Math.min(100, Number(raw) || 0));
  if (score == null) return '<span class="muted">—</span>';
  const col = score >= 65 ? 'var(--up)' : score >= 45 ? 'var(--warn)' : 'var(--down)';
  return `<svg viewBox="0 0 100 8" width="90" height="8" aria-label="score ${score}"><rect width="100" height="8" rx="4" fill="var(--line)"/><rect width="${score}" height="8" rx="4" fill="${col}"/></svg> <b class="mono">${score}</b>`;
}
function priceChart(closes, dates) {
  const n = Math.min(180, closes.length), W = 800, H = 260, P = 36;
  const c = closes.slice(-n), d = dates.slice(-n);
  const series = (k) => c.map((_, i) => sma(closes.slice(0, closes.length - n + i + 1), k));
  const s20 = series(20), s50 = series(50);
  const all = [...c, ...s20, ...s50].filter((x) => x != null);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const X = (i) => P + (i / (n - 1)) * (W - P - 8), Y = (y) => 8 + (1 - (y - lo) / span) * (H - 32);
  const line = (arr, col, wd) => `<polyline fill="none" stroke="${col}" stroke-width="${wd}" points="${arr.map((y, i) => (y == null ? '' : `${X(i).toFixed(1)},${Y(y).toFixed(1)}`)).join(' ')}"/>`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const y = lo + f * span; return `<line x1="${P}" x2="${W - 8}" y1="${Y(y)}" y2="${Y(y)}" stroke="var(--line)"/><text x="2" y="${Y(y) + 4}" fill="var(--muted)" font-size="11">${esc(fmt(y))}</text>`; }).join('');
  const area = `<polygon fill="var(--accent2)" fill-opacity=".08" points="${X(0)},${H - 24} ${c.map((y, i) => `${X(i)},${Y(y)}`).join(' ')} ${X(n - 1)},${H - 24}"/>`;
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart">${grid}${area}${line(c, 'var(--accent2)', 2)}${line(s20, 'var(--warn)', 1.2)}${line(s50, 'var(--accent)', 1.2)}
    <text x="${P}" y="${H - 6}" fill="var(--muted)" font-size="11">${esc(d[0])}</text><text x="${W - 80}" y="${H - 6}" fill="var(--muted)" font-size="11">${esc(d.at(-1))}</text></svg>
    <div class="legend"><span><i class="sw" data-c="p"></i>Price</span><span><i class="sw" data-c="20"></i>SMA 20</span><span><i class="sw" data-c="50"></i>SMA 50</span></div></div>`;
}

// ---------------- auth ----------------
function showLogin() { $('#login').hidden = false; $('input[name=password]').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/login', { method: 'POST', body: { password: f.get('password'), totp: f.get('totp') } });
    csrf = r.csrf;
    e.target.reset();
    $('#login').hidden = true;
    $('#loginErr').textContent = '';
    boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: {} }).catch(() => {}); csrf = null; showLogin(); });

// ---------------- header / kill switch ----------------
function renderHeader() {
  const b = $('#modeBadge');
  b.textContent = status.killSwitch ? 'HALTED' : status.mode === 'live' ? 'LIVE • REAL MONEY' : 'PAPER';
  b.className = `badge ${status.killSwitch ? 'halt' : status.mode}`;
  const k = $('#killBtn');
  k.textContent = status.killSwitch ? 'Resume trading' : 'Kill switch';
  k.classList.toggle('on', Boolean(status.killSwitch));
}
$('#killBtn').addEventListener('click', async () => {
  const on = !status.killSwitch;
  let flatten = false;
  if (on) flatten = $('#flattenChk')?.checked ?? false;
  try {
    const r = await api('/api/kill', { method: 'POST', body: { on, flatten } });
    status.killSwitch = r.killSwitch;
    renderHeader();
    toast(on ? `Trading halted. ${r.actions.join(', ')}` : 'Trading resumed');
  } catch (e) { toast(e.message, true); }
});

// ---------------- tabs ----------------
const loaders = { overview: loadOverview, scanner: loadScanner, trade: loadTrade, portfolio: loadPortfolio, lab: loadLab, alerts: loadAlerts, crypto: loadCrypto, banks: loadBanks, mining: loadMining, ailab: () => mountAiLab($('#tab-ailab'), { api, esc, toast, stat }), academy: loadAcademy, compare: loadCompare, integrations: loadIntegrations };
function openTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  store.set('tab', name);
  loaders[name]();
}
$('.tabs').addEventListener('click', (e) => { const t = e.target.closest('button[data-tab]'); if (t) openTab(t.dataset.tab); });

const needAlpaca = () => (status.alpaca ? '' : window.desktop
  ? '<div class="notice">Broker not connected. Add your free Alpaca paper-trading keys under <b>Integrations → Desktop settings</b> to enable quotes, the scanner and trading.</div>'
  : '<div class="notice">Broker not connected. Add free Alpaca paper keys to <code>.env</code> (see Integrations) to enable quotes, the scanner and trading.</div>');

/** Desktop app only: edit connection keys in-app (validated, passphrase-gated, written by the main process). */
async function desktopSettingsCard() {
  if (!window.desktop?.getSettings) return '';
  const s = await window.desktop.getSettings();
  const field = (k, label, type = 'password', extra = '') => `<label>${esc(label)} ${s.set[k] ? '<span class="pill bullish">set</span>' : ''}
    <input name="${esc(k)}" type="${type}" autocomplete="off" spellcheck="false" placeholder="${s.set[k] ? 'leave blank to keep current' : ''}" ${extra}></label>`;
  return `<form id="dsForm" class="card"><h2>Desktop settings</h2>
    <p class="muted">Keys are stored in your Windows user profile (not inside the app) and are never displayed again. Leave a field blank to keep its current value. StocksWorks restarts to apply changes.</p>
    <h3>Broker (Alpaca, paper trading: <a href="https://app.alpaca.markets/signup" target="_blank" rel="noopener noreferrer">get free keys</a>)</h3>
    <div class="row">${field('ALPACA_KEY_ID', 'Key ID', 'text')}${field('ALPACA_SECRET_KEY', 'Secret')}</div>
    <h3>AI (<a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer">Anthropic console</a>)</h3>
    ${field('ANTHROPIC_API_KEY', 'Claude API key')}
    <h3>Banks (<a href="https://dashboard.plaid.com/signup" target="_blank" rel="noopener noreferrer">Plaid dashboard</a>)</h3>
    <div class="row">${field('PLAID_CLIENT_ID', 'Client ID', 'text')}${field('PLAID_SECRET', 'Secret')}
      <label>Environment<select name="PLAID_ENV"><option value="">keep (${esc(s.plaidEnv)})</option><option>sandbox</option><option>production</option></select></label></div>
    <h3>Charles Schwab (<a href="https://developer.schwab.com/" target="_blank" rel="noopener noreferrer">developer.schwab.com</a>, callback URL <code>https://127.0.0.1</code>)</h3>
    <div class="row">${field('SCHWAB_CLIENT_ID', 'App key', 'text')}${field('SCHWAB_CLIENT_SECRET', 'Secret')}</div>
    <h3>Notifications</h3>${field('NOTIFY_WEBHOOK_URL', 'Discord or Slack webhook URL')}
    <label>Your StocksWorks passphrase (required to save)<input name="passphrase" type="password" autocomplete="current-password" required></label>
    <div class="row"><button class="btn primary" type="submit">Save &amp; restart</button><button class="btn ghost" type="button" id="dsFolder">Open settings folder</button></div>
    <p class="muted tiny">Advanced options (risk limits, live trading, Schwab trading, fleet, TLS) live in the <code>.env</code> file in that folder.</p></form>
    ${await windowPrefsCard()}`;
}

/** Phone remote: turn the phone listener on/off, pair phones by QR, remove them. Managed from this PC only. */
async function phoneCard() {
  const p = await api('/api/phone');
  const when = (t) => (t ? new Date(t).toLocaleString() : '—');
  return `<div class="card" id="phoneCard"><div class="bar"><h2>Phone remote</h2><span class="pill ${p.running ? 'bullish' : ''}">${p.running ? 'on' : 'off'}</span><span class="spacer"></span>
      <button class="btn ${p.enabled ? '' : 'primary'}" type="button" data-ph="toggle" data-on="${p.enabled ? '0' : '1'}">${p.enabled ? 'Turn off phone access' : 'Turn on phone access'}</button></div>
    <p class="muted">Control StocksWorks from your phone over your Wi-Fi: portfolio, orders (same risk checks and live-mode 2FA), the kill switch, alerts, and switching this PC's approved miners, compute sharing and remote rigs on or off.
      A phone can't approve programs, pair other phones, reveal bank numbers or change settings, and it still needs your passphrase. Away from home: install <a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Tailscale</a> on this PC and the phone, then pair using the 100.x address.</p>
    ${p.enabled && !p.running ? '<p class="err">Phone access is on but not listening (another program may be using the port). Turn it off and on again.</p>' : ''}
    ${p.running ? `<p class="muted tiny">Your phone will warn once that the certificate isn't trusted: it's StocksWorks' own. Before you continue, open the certificate details in the phone's browser and check its SHA-256 fingerprint matches
        <span class="mono">${esc(p.fingerprint)}</span>. If it doesn't, stop: something on your network may be intercepting. Pair only on a network you trust (or over Tailscale).
        If Windows asks, allow StocksWorks on <b>private networks</b> only.</p>
      <button class="btn primary" type="button" data-ph="pair">Pair a phone</button><div id="phPair"></div>` : ''}
    ${p.devices.length ? `<h3>Paired phones</h3><div class="scroll"><table><tr><th>Name</th><th>Paired</th><th>Last used</th><th></th></tr>
      ${p.devices.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(when(d.pairedAt))}</td><td>${esc(when(d.lastSeen))}</td><td><button class="btn ghost" type="button" data-ph="remove" data-id="${esc(d.id)}">Remove</button></td></tr>`).join('')}</table></div>` : ''}</div>`;
}

/** Desktop app only: close-button behaviour and start at sign-in (applied immediately, no restart). */
async function windowPrefsCard() {
  const p = await window.desktop.getPrefs?.();
  if (!p || p.error) return '';
  return `<div class="card" id="prefsCard"><h2>Window &amp; startup</h2>
    <label class="check-row"><input type="checkbox" data-pref="closeToTaskbar" ${p.closeToTaskbar ? 'checked' : ''}> Close button minimizes to the taskbar (mining and sharing keep their schedule). Quit from the tray icon.</label>
    <label class="check-row"><input type="checkbox" data-pref="startAtLogin" ${p.startAtLogin ? 'checked' : ''}> Start StocksWorks when I sign in to Windows (starts minimized)</label></div>`;
}

// ---------------- Overview ----------------
async function loadOverview() {
  const el = $('#tab-overview');
  el.innerHTML = `${needAlpaca()}<div class="empty">Loading…</div>`;
  if (!status.alpaca) { el.innerHTML = needAlpaca() + guardrailsCard(); return; }
  try {
    const [{ account: a, positions, orders }, scan] = await Promise.all([api('/api/account'), scanCache ? scanCache : api('/api/scan')]);
    scanCache = scan;
    const dayPl = Number(a.equity) - Number(a.last_equity);
    el.innerHTML = `
      <div class="stats">
        ${stat('Equity', usd(a.equity))}${stat('Day P/L', `<span class="${cls(dayPl)}">${usd(dayPl)}</span>`)}
        ${stat('Buying power', usd(a.buying_power))}${stat('Cash', usd(a.cash))}${stat('Orders today', `${status.ordersToday} / ${status.limits.maxOrdersPerDay}`)}
      </div>
      <div class="grid two">
        <div class="card"><h3>Positions</h3>${positions.length ? `<div class="scroll"><table><tr><th>Symbol</th><th class="num">Qty</th><th class="num">Avg</th><th class="num">Price</th><th class="num">Value</th><th class="num">P/L</th></tr>
          ${positions.map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td class="num">${fmt(p.qty, 6)}</td><td class="num">${usd(p.avg_entry_price)}</td><td class="num">${usd(p.current_price)}</td><td class="num">${usd(p.market_value)}</td><td class="num ${cls(+p.unrealized_pl)}">${usd(p.unrealized_pl)} (${pct(+p.unrealized_plpc)})</td></tr>`).join('')}</table></div>` : '<p class="muted">No open positions.</p>'}</div>
        <div class="card"><h3>Top AI-scored setups</h3><table>${scan.filter((r) => r.score != null).slice(0, 6).map((r) => `<tr class="click" data-sym="${esc(r.symbol)}"><td><b>${esc(r.symbol)}</b></td><td>${sparkline(r.spark, 90, 24)}</td><td>${scoreBar(r.score)}</td></tr>`).join('')}</table>
          <p class="muted">Click a symbol to open it in the scanner.</p></div>
      </div>
      <div class="card"><div class="row"><h3>Equity, last 3 months</h3><span id="eqChange" class="mono"></span></div><div id="eqChart" class="chart"><div class="empty">Loading…</div></div></div>
      <div class="card"><h3>Recent orders</h3>${ordersTable(orders.slice(0, 15))}</div>
      ${guardrailsCard()}`;
    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { openTab('scanner'); loadDetail(tr.dataset.sym); }));
    api('/api/history').then((h) => {
      const v = h.equity.map(Number).filter((x) => x > 0);
      if (v.length < 2) { $('#eqChart').innerHTML = '<p class="muted">Not enough history yet.</p>'; return; }
      const ch = v.at(-1) / v[0] - 1;
      $('#eqChange').innerHTML = `<span class="${cls(ch)}">${pct(ch)}</span> <span class="muted tiny">${esc(h.dates[0])} → ${esc(h.dates.at(-1))}</span>`;
      $('#eqChart').innerHTML = sparkline(v, 800, 140).replace('width="800" height="140"', 'width="100%" height="140" preserveAspectRatio="none"');
    }).catch(() => { $('#eqChart').innerHTML = '<p class="muted">Equity history unavailable.</p>'; });
  } catch (e) { fail(el)(e); }
}
const stat = (k, v) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
const ordersTable = (orders) => (orders.length ? `<div class="scroll"><table><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Type</th><th class="num">Qty / $</th><th class="num">Fill</th><th>Status</th></tr>
  ${orders.map((o) => `<tr><td class="mono">${esc((o.submitted_at ?? '').replace('T', ' ').slice(0, 16))}</td><td>${esc(o.symbol)}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${esc(o.side)}</td><td>${esc(o.type)}</td><td class="num">${esc(o.qty ?? '$' + o.notional)}</td><td class="num">${usd(o.filled_avg_price)}</td><td>${esc(o.status)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No orders yet.</p>');
function guardrailsCard() {
  const L = status.limits ?? {};
  return `<div class="card"><h3>Active guardrails</h3><ul class="checks">
    <li>Max ${usd(L.maxOrderUsd, 0)} per order · max ${L.maxPositionPct}% of equity per buy · ${L.maxOrdersPerDay} orders/day</li>
    <li>Limit prices more than ${L.maxLimitDeviationPct}% from last trade are rejected (fat-finger guard)</li>
    <li class="${status.mode === 'live' ? '' : 'bad'}">${status.mode === 'live' ? 'Live mode: each order needs explicit confirmation' : 'Paper mode: no real money at risk'}</li>
    <li class="${status.totp ? '' : 'bad'}">Two-factor login ${status.totp ? 'enabled' : 'disabled (run npm run new-totp)'}</li>
    <li>AI is advisory only. It cannot place orders.</li></ul>
    <label class="row"><span><input type="checkbox" id="flattenChk"> Also close all positions when the kill switch is pressed</span></label></div>`;
}

// ---------------- Scanner ----------------
async function loadScanner() {
  const el = $('#tab-scanner');
  if (!status.alpaca) { el.innerHTML = needAlpaca(); return; }
  el.innerHTML = `<div class="grid two"><div class="card"><div class="row"><h2>AI opportunity scanner</h2><button class="btn" id="rescan" type="button">Rescan</button></div>
    <p class="muted">Ranks your watchlist by a transparent 0-100 score: trend 30, momentum 30, RSI zone 20, MACD 20. It ranks setups; it does not forecast.</p>
    <div id="scanTable" class="scroll"><div class="empty">Scanning…</div></div>
    <form id="wlForm" class="row"><label>Watchlist (comma separated, e.g. AAPL, BTC/USD)<input name="wl"></label><button class="btn" type="submit">Save</button></form></div>
    <div id="detail" class="card"><div class="empty">Select a symbol for the chart, score breakdown, backtest and AI analyst.</div></div></div>`;
  $('#rescan').addEventListener('click', () => { scanCache = null; renderScan(); });
  api('/api/watchlist').then((wl) => ($('#wlForm [name=wl]').value = wl.join(', ')));
  $('#wlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/watchlist', { method: 'POST', body: { symbols: e.target.wl.value.split(',').map((s) => s.trim()).filter(Boolean) } });
      scanCache = null; renderScan(); toast('Watchlist saved');
    } catch (err) { toast(err.message, true); }
  });
  renderScan();
}
async function renderScan() {
  const box = $('#scanTable');
  try {
    scanCache ??= await api('/api/scan');
    box.innerHTML = `<table><tr><th>#</th><th>Symbol</th><th>60d</th><th>Score</th><th class="num">20d</th><th class="num">RSI</th><th class="num">Vol (ann.)</th><th class="num">±1σ 20d</th></tr>
      ${scanCache.map((r, i) => (r.score == null
        ? `<tr><td>${i + 1}</td><td>${esc(r.symbol)}</td><td colspan="6" class="muted">${esc(r.error ?? 'no data')}</td></tr>`
        : `<tr class="click" data-sym="${esc(r.symbol)}"><td>${i + 1}</td><td><b>${esc(r.symbol)}</b></td><td>${sparkline(r.spark)}</td><td>${scoreBar(r.score)}</td>
           <td class="num ${cls(r.metrics.return20d)}">${pct(r.metrics.return20d)}</td><td class="num">${fmt(r.metrics.rsi14, 0)}</td><td class="num">${pct(r.metrics.volAnnual)}</td><td class="num">${usd(r.metrics.expectedMove20d)}</td></tr>`)).join('')}</table>`;
    $$('tr[data-sym]', box).forEach((tr) => tr.addEventListener('click', () => loadDetail(tr.dataset.sym)));
  } catch (e) { fail(box)(e); }
}
async function loadDetail(sym) {
  const el = $('#detail');
  if (!el) return;
  $$('#scanTable tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.sym === sym));
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api(`/api/symbol?s=${encodeURIComponent(sym)}`);
    const s = d.signal, b = d.backtest;
    el.innerHTML = `<div class="row"><h2>${esc(sym)} <span class="muted mono">${usd(s?.metrics.price)}</span></h2><span>${scoreBar(s?.score)}</span></div>
      ${priceChart(d.closes, d.dates)}
      ${s ? `<div class="stats">${stat('Trend', `${s.components.trend}/30`)}${stat('Momentum', `${s.components.momentum}/30`)}${stat('RSI zone', `${s.components.rsi}/20`)}${stat('MACD', `${s.components.macd}/20`)}</div>` : '<p class="muted">Not enough history to score.</p>'}
      ${b ? `<h3>Walk-forward backtest (score ≥ 60, 5 bps fees, ${b.bars} days)</h3>
        <div class="stats">${stat('Strategy', `<span class="${cls(b.strategyReturn)}">${pct(b.strategyReturn)}</span>`)}${stat('Buy & hold', `<span class="${cls(b.buyHoldReturn)}">${pct(b.buyHoldReturn)}</span>`)}${stat('Max drawdown', pct(-b.maxDrawdown))}${stat('Time invested', pct(b.exposure))}</div>
        <p class="muted">${b.strategyReturn > b.buyHoldReturn ? 'The signal beat buy-and-hold on this history. Past results do not guarantee future ones.' : 'The signal did not beat buy-and-hold here. Treat this score with skepticism for this symbol.'}</p>` : ''}
      <div class="row"><button class="btn primary" id="aiBtn" type="button" ${status.ai ? '' : 'disabled'}>AI analyst</button>
        <button class="btn" id="aiWebBtn" type="button" ${status.ai ? '' : 'disabled'}>AI + live web research</button>
        <button class="btn" id="prefill" type="button">Open in order ticket</button></div>
      ${status.ai ? '' : '<p class="muted">Add ANTHROPIC_API_KEY to .env to enable the AI analyst.</p>'}
      <div id="aiOut"></div>`;
    $('#prefill').addEventListener('click', () => { store.set('ticket', { symbol: sym }); openTab('trade'); });
    $('#aiBtn').addEventListener('click', () => runAi(sym, false));
    $('#aiWebBtn').addEventListener('click', () => runAi(sym, true));
  } catch (e) { fail(el)(e); }
}
async function runAi(sym, web) {
  const out = $('#aiOut');
  out.innerHTML = `<div class="empty">Claude is analyzing ${esc(sym)}${web ? ' and researching the web' : ''}… this can take a minute.</div>`;
  $$('#aiBtn, #aiWebBtn').forEach((b) => (b.disabled = true));
  try {
    const a = await api('/api/ai/analyze', { method: 'POST', body: { symbol: sym, web } });
    out.innerHTML = `<div class="card ai"><div class="row"><h3>AI analyst · ${esc(a.horizon)}</h3><span><span class="pill ${esc(a.stance)}">${esc(a.stance.toUpperCase())}</span> <span class="pill">${esc(a.confidence)}% confidence</span></span></div>
      <p>${esc(a.thesis)}</p>
      <div class="stats">${stat('Entry', usd(a.entry))}${stat('Stop', usd(a.stop))}${stat('Target', usd(a.target))}${stat('Reward / risk', a.entry && a.stop && a.target && a.entry !== a.stop ? fmt(Math.abs((a.target - a.entry) / (a.entry - a.stop)), 2) + '×' : '—')}</div>
      <div class="grid"><div><h3>Catalysts</h3><ul>${a.catalysts.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div><div><h3>Risks</h3><ul>${a.risks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div></div>
      <p><b>Sizing:</b> ${esc(a.positionSizing)}</p>
      <div class="lesson"><b>Lesson:</b> ${esc(a.lesson)}</div>
      ${a.sources.length ? `<h3>Web sources</h3><ul>${a.sources.map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></li>`).join('')}</ul>` : ''}
      ${a.news.length ? `<h3>Recent headlines</h3><ul>${a.news.slice(0, 6).map((n) => `<li><a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a> <span class="muted">${esc(n.source)}</span></li>`).join('')}</ul>` : ''}
      <p class="muted">Model: ${esc(a.model)}. AI output is research, not advice. Verify sources and size by your own stop.</p>
      <button class="btn" id="aiPrefill" type="button">Prefill ticket with AI levels</button></div>`;
    $('#aiPrefill').addEventListener('click', () => { store.set('ticket', { symbol: sym, side: 'buy', type: a.entry ? 'limit' : 'market', limit_price: a.entry ?? '', stop_loss: a.stop ?? '', take_profit: a.target ?? '' }); openTab('trade'); });
  } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  $$('#aiBtn, #aiWebBtn').forEach((b) => (b.disabled = !status.ai));
}
const safeUrl = (u) => { try { const x = new URL(u); return ['https:', 'http:'].includes(x.protocol) ? x.href : '#'; } catch { return '#'; } };

// ---------------- Trade ----------------
function loadTrade() {
  const el = $('#tab-trade');
  const t = { side: 'buy', type: 'market', sizing: 'qty', broker: 'alpaca', ...store.get('ticket', {}) };
  const schwabOn = status.schwab?.connected && status.schwab?.trading;
  t.broker = 'alpaca'; // the account picker always starts on Alpaca
  const isLive = () => status.mode === 'live' || t.broker === 'schwab'; // Schwab has no paper mode
  let live = isLive();
  const L = status.limits ?? {};
  el.innerHTML = `${needAlpaca()}<div class="grid two"><form id="ticket" class="card" novalidate>
    <h2>Order ticket <span class="badge ${esc(status.mode)}" id="modeBadge">${esc(status.mode?.toUpperCase())}</span></h2>
    ${schwabOn ? `<label>Account<select name="acct"><option value="alpaca">Alpaca (${esc(status.mode)})</option></select></label>` : ''}
    <label>Symbol <input name="symbol" value="${esc(t.symbol ?? '')}" placeholder="AAPL or BTC/USD" required autocomplete="off"></label>
    <div class="row"><div class="seg" id="sideSeg"><button type="button" data-v="buy" class="buy">Buy</button><button type="button" data-v="sell" class="sell">Sell</button></div>
      <div class="seg" id="typeSeg"><button type="button" data-v="market">Market</button><button type="button" data-v="limit">Limit</button></div>
      <div class="seg" id="sizeSeg"><button type="button" data-v="qty">Quantity</button><button type="button" data-v="notional">Dollars</button></div></div>
    <div class="row"><label id="amtLbl">Quantity <input name="amount" inputmode="decimal" value="${esc(t.qty ?? '')}"></label>
      <label id="lpLbl">Limit price <input name="limit_price" inputmode="decimal" value="${esc(t.limit_price ?? '')}"></label></div>
    <fieldset id="bracketBox" class="bracket"><legend>Protect it: stop-loss &amp; target (stocks, buys)</legend>
      <div class="row"><label>Stop-loss price<input name="stop_loss" inputmode="decimal" value="${esc(t.stop_loss ?? '')}"></label>
        <label>Take-profit price<input name="take_profit" inputmode="decimal" value="${esc(t.take_profit ?? '')}"></label></div>
      <div class="row"><label>Risk per trade (% of equity)<input name="riskPct" inputmode="decimal" value="1"></label>
        <button class="btn" type="button" id="sizeBtn">Size by risk</button></div>
      <p class="muted tiny">Sizing: shares = equity × risk% ÷ (entry − stop), then capped by your order and position limits. Server cap: ${esc(L.maxRiskPerTradePct)}% of equity at risk per trade.</p>
    </fieldset>
    <details class="why"><summary>Why this trade? <span class="muted tiny">(saved to your journal when the order is placed)</span></summary>
      <label>Thesis: why now, where's the stop, what proves you wrong?<textarea name="thesis" rows="2" maxlength="2000"></textarea></label>
      <div class="row"><label>Setup<input name="setup" maxlength="40" placeholder="breakout, dip-buy…"></label>
        <label>Emotion<select name="emotion">${['calm', 'confident', 'fearful', 'greedy', 'fomo', 'revenge', 'bored'].map((x) => `<option>${x}</option>`).join('')}</select></label>
        <label>Confidence (1-5)<input name="confidence" value="3" inputmode="numeric"></label></div></details>
    <div id="liveBox" ${live ? '' : 'hidden'}><div class="row"><label>Authenticator code (required for live orders)<input name="totp" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code"></label><label class="row"><span><input type="checkbox" name="confirm"> I confirm this is a REAL-MONEY order</span></label></div></div>
    <div class="row"><button class="btn" type="button" id="previewBtn">Check risk</button><button class="btn primary" type="submit" id="placeBtn">Place order</button></div>
    <p class="muted tiny" id="liveNote" ${live ? '' : 'hidden'}>Live: "Place order" unlocks only after a passing risk check, for that exact order, for 2 minutes.</p>
    <div id="ticketOut"></div></form>
    <div class="card"><h3>How the ticket protects you</h3><ul class="checks">
      <li>Strict validation: symbol format, plain decimals only, one of quantity or dollars</li>
      <li>Latest-trade price check; market orders refused on stale prices (&gt;${esc(Math.round((L.maxPriceAgeSec ?? 0) / 60))} min)</li>
      <li>Per-order ${usd(L.maxOrderUsd, 0)}, per-position ${esc(L.maxPositionPct)}% of equity, ${esc(L.maxOrdersPerDay)} orders and ${usd(L.maxDailyNotionalUsd, 0)} per day, enforced server-side</li>
      <li>No accidental shorting: sells can't exceed what you hold</li>
      <li>Brackets attach a stop and a target at the broker, so they work even if this app is closed</li>
      <li>Every placed or rejected order goes to the hash-chained audit log (CSV export in Integrations)</li></ul>
      <div class="lesson">Decide your stop before you enter, then size so hitting it costs at most 1% of equity. With $20,000 equity, entry $50 and stop $47.50, that's $200 ÷ $2.50 = 80 shares. See Academy lesson 1.</div></div></div>`;
  const f = $('#ticket');
  let confirmToken = null, confirmedFor = null;
  const order = () => {
    const o = { symbol: f.symbol.value.trim().toUpperCase(), side: t.side, type: t.type };
    o[t.sizing] = f.amount.value.trim();
    if (t.type === 'limit') o.limit_price = f.limit_price.value.trim();
    if (t.side === 'buy' && (f.stop_loss.value.trim() || f.take_profit.value.trim())) { o.stop_loss = f.stop_loss.value.trim(); o.take_profit = f.take_profit.value.trim(); }
    if (t.broker === 'schwab') Object.assign(o, { broker: 'schwab', account: t.account });
    return o;
  };
  if (schwabOn) {
    api('/api/brokers/schwab/accounts').then((accts) => {
      f.acct.insertAdjacentHTML('beforeend', accts.filter((a) => a.hash).map((a) => `<option value="${esc(a.hash)}">Schwab ${esc(a.type ?? '')} ••${esc(a.mask)} (REAL MONEY)</option>`).join(''));
    }).catch((e) => toast(`Schwab: ${e.message}`, true));
    f.acct.addEventListener('change', () => {
      [t.broker, t.account] = f.acct.value === 'alpaca' ? ['alpaca', undefined] : ['schwab', f.acct.value];
      live = isLive();
      $('#liveBox').hidden = $('#liveNote').hidden = !live;
      $('#modeBadge').textContent = t.broker === 'schwab' ? 'SCHWAB LIVE' : status.mode.toUpperCase();
      $('#modeBadge').className = `badge ${live ? 'live' : esc(status.mode)}`;
      syncPlace();
    });
  }
  const syncPlace = () => {
    const fresh = confirmToken && confirmedFor === JSON.stringify(order());
    if (live && !fresh) confirmToken = null;
    $('#placeBtn').disabled = live && (!fresh || !f.confirm?.checked || !/^\d{6}$/.test(f.totp?.value ?? ''));
  };
  const seg = (id, key) => {
    const s = $(id);
    const paint = () => {
      $$('button', s).forEach((b) => b.classList.toggle('on', b.dataset.v === t[key]));
      $('#lpLbl').hidden = t.type !== 'limit';
      $('#bracketBox').hidden = t.side !== 'buy';
      $('#amtLbl').firstChild.textContent = t.sizing === 'qty' ? 'Quantity ' : 'Dollars ($) ';
      syncPlace();
    };
    s.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { t[key] = b.dataset.v; if (key === 'type' && t.type === 'limit') t.sizing = 'qty'; paint(); } });
    paint();
  };
  seg('#sideSeg', 'side'); seg('#typeSeg', 'type'); seg('#sizeSeg', 'sizing');
  f.addEventListener('input', syncPlace);

  const showChecks = (r) => `<p>Reference price <b class="mono">${usd(r.price)}</b>${r.priceAgeSec != null ? ` <span class="muted tiny">(${esc(Math.round(r.priceAgeSec))}s old)</span>` : ''} · Est. notional <b class="mono">${usd(r.notional)}</b>
    ${r.riskUsd != null ? ` · Risk to stop <b class="mono">${usd(r.riskUsd)}</b> (${pct(r.riskUsd / r.equity)} of equity)` : ''} · Traded today <b class="mono">${usd(r.notionalToday, 0)}</b></p>
    <ul class="checks">${r.errors.length ? r.errors.map((e) => `<li class="bad">${esc(e)}</li>`).join('') : '<li>All risk checks passed</li>'}</ul>`;
  const preview = async (o = order()) => api('/api/orders/preview', { method: 'POST', body: o });

  $('#previewBtn').addEventListener('click', async () => {
    try {
      const o = order();
      const r = await preview(o);
      $('#ticketOut').innerHTML = showChecks(r);
      confirmToken = r.confirmToken; confirmedFor = JSON.stringify(o);
      syncPlace();
    } catch (e) { $('#ticketOut').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  });

  $('#sizeBtn').addEventListener('click', async () => {
    const stop = Number(f.stop_loss.value), riskPct = Number(f.riskPct.value);
    if (!(stop > 0) || !(riskPct > 0)) return toast('Enter a stop-loss price and risk % first', true);
    try {
      const r = await preview({ symbol: f.symbol.value.trim().toUpperCase(), side: 'buy', type: 'market', qty: '1', ...(t.broker === 'schwab' ? { broker: 'schwab', account: t.account } : {}) });
      const entry = t.type === 'limit' && Number(f.limit_price.value) > 0 ? Number(f.limit_price.value) : r.price;
      if (!(entry > stop)) return toast('Stop must be below the entry price', true);
      const byRisk = (r.equity * riskPct) / 100 / (entry - stop);
      const byOrder = L.maxOrderUsd / entry;
      const byPosition = (r.equity * L.maxPositionPct) / 100 / entry;
      const qty = Math.floor(Math.min(byRisk, byOrder, byPosition));
      if (qty < 1) return toast('Even 1 share breaks a limit; widen your budget or pick a cheaper symbol', true);
      t.sizing = 'qty'; f.amount.value = String(qty);
      $$('#sizeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'qty'));
      $('#amtLbl').firstChild.textContent = 'Quantity ';
      const binding = qty === Math.floor(byRisk) ? 'your risk %' : qty === Math.floor(byOrder) ? 'the max order size' : 'the position cap';
      $('#ticketOut').innerHTML = `<p>Sized to <b class="mono">${esc(qty)}</b> shares at ~${usd(entry)}: risk to stop ${usd(qty * (entry - stop))}, limited by ${esc(binding)}.</p>`;
      syncPlace();
    } catch (e) { toast(e.message, true); }
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#placeBtn'); btn.disabled = true;
    try {
      const why = f.thesis.value.trim() ? { thesis: f.thesis.value.trim(), setup: f.setup.value, emotion: f.emotion.value, confidence: Number(f.confidence.value) } : {};
      const o = await api('/api/orders', { method: 'POST', body: { ...order(), confirmToken, ...why, ...(live ? { totp: f.totp.value } : {}) } });
      if (why.thesis) { o.journalError ? toast(`Order placed, but not journaled: ${o.journalError}`, true) : (f.thesis.value = ''); }
      if (f.totp) f.totp.value = '';
      $('#ticketOut').innerHTML = `<p class="up">Order accepted: ${esc(o.side)} ${esc(o.qty ?? '$' + o.notional)} ${esc(o.symbol)}${o.order_class === 'bracket' ? ' with stop + target' : ''}. Status: ${esc(o.status)}</p>`;
      store.set('ticket', {});
      toast('Order sent');
    } catch (err) { $('#ticketOut').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    confirmToken = null;
    syncPlace();
  });
}

// ---------------- Crypto & wallet ----------------
async function loadCrypto() {
  const el = $('#tab-crypto');
  el.innerHTML = `<div class="grid two"><div class="card"><h2>Crypto market</h2><div id="cgTable" class="scroll"><div class="empty">Loading…</div></div><p class="muted">Data: CoinGecko. Trade majors (BTC/USD, ETH/USD, SOL/USD…) from the Trade tab via Alpaca.</p></div>
    <div><div class="card"><h2>Watch-only wallets</h2><p class="muted">Public addresses only. Balances read from the blockchain; no keys are stored.</p>
      <form id="wForm" class="row"><label>Chain<select name="chain"><option value="btc">Bitcoin</option><option value="eth">Ethereum</option></select></label>
        <label>Address<input name="address" required autocomplete="off" spellcheck="false"></label><label>Label<input name="label" maxlength="40"></label><button class="btn" type="submit">Watch</button></form>
      <div id="wList"></div></div>
    <div class="card"><h2>Self-custody: browser wallet</h2>
      <p class="muted">Transactions are signed inside your wallet extension (MetaMask, Rabby, Coinbase Wallet). StocksWorks never sees a private key or seed phrase.</p>
      <button class="btn primary" id="connectBtn" type="button">Connect wallet</button><div id="w3"></div></div></div></div>`;
  api('/api/crypto/markets').then((rows) => {
    $('#cgTable').innerHTML = `<table><tr><th>#</th><th>Coin</th><th class="num">Price</th><th class="num">24h</th><th class="num">7d</th><th class="num">Mkt cap</th></tr>
      ${rows.map((c) => `<tr><td>${esc(c.market_cap_rank)}</td><td><b>${esc(c.symbol?.toUpperCase())}</b> <span class="muted">${esc(c.name)}</span></td><td class="num">${usd(c.current_price)}</td>
      <td class="num ${cls(c.price_change_percentage_24h_in_currency)}">${fmt(c.price_change_percentage_24h_in_currency)}%</td><td class="num ${cls(c.price_change_percentage_7d_in_currency)}">${fmt(c.price_change_percentage_7d_in_currency)}%</td><td class="num">${usd(c.market_cap, 0)}</td></tr>`).join('')}</table>`;
  }).catch(fail($('#cgTable')));
  const renderWallets = (ws) => {
    $('#wList').innerHTML = ws.length ? `<table>${ws.map((w) => `<tr><td><b>${esc(w.label || w.chain.toUpperCase())}</b><br><span class="mono muted">${esc(w.address.slice(0, 10))}…${esc(w.address.slice(-6))}</span></td>
      <td class="num">${w.balance == null ? `<span class="err">${esc(w.error ?? '—')}</span>` : `${fmt(w.balance, 8)} ${w.chain.toUpperCase()}`}</td><td><button class="btn ghost" data-del="${esc(w.address)}" type="button" aria-label="Remove">✕</button></td></tr>`).join('')}</table>` : '<p class="muted">No addresses watched yet.</p>';
    $$('[data-del]', $('#wList')).forEach((b) => b.addEventListener('click', async () => renderWallets(await api(`/api/wallets?address=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }).then(() => api('/api/wallets')))));
  };
  refreshWallets = () => api('/api/wallets').then(renderWallets).catch(fail($('#wList')));
  refreshWallets();
  el.insertAdjacentHTML('beforeend', '<div id="walletCreate" class="card"></div>');
  renderWalletCreator();
  $('#wForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/wallets', { method: 'POST', body: { chain: e.target.chain.value, address: e.target.address.value.trim(), label: e.target.label.value } }); e.target.reset(); renderWallets(await api('/api/wallets')); } catch (err) { toast(err.message, true); }
  });
  $('#connectBtn').addEventListener('click', connectWallet);
}
async function connectWallet() {
  const box = $('#w3');
  const eth = window.ethereum;
  if (!eth && window.desktop) {
    // Wallet extensions only run in a real browser: hand this session's app URL to the system browser.
    box.innerHTML = '<p class="muted">Wallet extensions (MetaMask, Rabby…) run in your web browser, not in the desktop app.</p><button class="btn" id="openBrowser" type="button">Open StocksWorks in your browser</button>';
    $('#openBrowser').addEventListener('click', () => window.desktop.openInBrowser());
    return;
  }
  if (!eth) { box.innerHTML = '<p class="muted">No browser wallet detected. Install <a href="https://metamask.io/" target="_blank" rel="noopener noreferrer">MetaMask</a> or use a hardware wallet through one.</p>'; return; }
  try {
    const [acct] = await eth.request({ method: 'eth_requestAccounts' });
    const chainId = await eth.request({ method: 'eth_chainId' });
    const wei = BigInt(await eth.request({ method: 'eth_getBalance', params: [acct, 'latest'] }));
    box.innerHTML = `<p>Connected <span class="mono">${esc(acct)}</span><br>Chain ${esc(parseInt(chainId, 16))}${chainId === '0x1' ? ' (Ethereum mainnet)' : ''} · Balance <b class="mono">${esc(fmt(Number(wei) / 1e18, 6))} ETH</b></p>
      <form id="sendForm"><label>Send to (0x…)<input name="to" required autocomplete="off" spellcheck="false"></label><label>Amount (ETH)<input name="amt" inputmode="decimal" required></label>
      ${chainId !== '0x1' ? `<div class="notice">Your wallet is on chain ${esc(parseInt(chainId, 16))}, not Ethereum mainnet. Funds sent here stay on that network.<label class="row"><span><input type="checkbox" name="ackChain"> I intend to send on chain ${esc(parseInt(chainId, 16))}</span></label></div>` : ''}
      <button class="btn" type="submit">Review in wallet</button><p class="muted">Double-check the address: crypto transfers cannot be reversed. Your wallet shows the final confirmation.</p></form>`;
    $('#sendForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const to = e.target.to.value.trim(), amt = e.target.amt.value.trim();
      if (!isValidEthAddress(to)) return toast('Invalid address: wrong format or the EIP-55 checksum failed (likely a typo)', true);
      if (chainId !== '0x1' && !e.target.ackChain?.checked) return toast('You are not on Ethereum mainnet. Tick the network confirmation first.', true);
      if (!/^\d+(\.\d{1,18})?$/.test(amt) || Number(amt) <= 0) return toast('Invalid amount', true);
      const [i, f = ''] = amt.split('.');
      const value = '0x' + (BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString(16);
      try { const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from: acct, to, value }] }); toast(`Submitted ${hash.slice(0, 14)}…`); } catch (err) { toast(err.message, true); }
    });
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------------- Mining ----------------
async function loadMining() {
  const el = $('#tab-mining');
  el.innerHTML = '<div class="empty">Loading network data…</div>';
  try {
    const n = await api('/api/mining');
    const saved = store.get('mining', { preset: 0, kwh: 0.08, pool: 2, cost: 4000 });
    el.innerHTML = `<div id="fleet" class="card"><div class="empty">Loading fleet…</div></div><div class="grid two"><form id="mForm" class="card"><h2>Bitcoin mining profitability</h2>
      <label>Hardware preset<select name="preset">${n.presets.map((p, i) => `<option value="${i}" ${i === saved.preset ? 'selected' : ''}>${esc(p.name)} (${p.hashrateTHs} TH/s, ${p.watts} W)</option>`).join('')}<option value="-1">Custom</option></select></label>
      <div class="row"><label>Hashrate (TH/s)<input name="th" inputmode="decimal"></label><label>Power (W)<input name="w" inputmode="decimal"></label></div>
      <div class="row"><label>Electricity ($/kWh)<input name="kwh" inputmode="decimal" value="${esc(saved.kwh)}"></label><label>Pool fee (%)<input name="pool" inputmode="decimal" value="${esc(saved.pool)}"></label><label>Hardware cost ($)<input name="cost" inputmode="decimal" value="${esc(saved.cost)}"></label></div>
      <div id="mOut"></div></form>
      <div class="card"><h3>Live network</h3><div class="stats">${stat('BTC price', usd(n.btcUsd, 0))}${stat('Network hashrate', `${fmt(n.networkHashrateEHs, 0)} EH/s`)}${stat('Block subsidy', `${n.blockSubsidyBtc} BTC`)}${stat('Avg fees / block', `${fmt(n.feesPerBlockBtc, 4)} BTC`)}</div>
      <div class="lesson">Difficulty retargets every ~2 weeks and tends to rise, so treat these numbers as today's best case. Electricity price decides most outcomes: compare it with the break-even rate on the left.</div>
      <h3>Running your own rigs</h3><ul><li>Point miners at a pool with the Stratum URL and your payout address; never at an address you don't control.</li><li>Isolate miners on their own VLAN and change default firmware passwords.</li><li>Browser and CPU mining of Bitcoin is not viable; StocksWorks deliberately ships no in-browser miner.</li></ul></div></div>`;
    const f = $('#mForm');
    const setPreset = () => { const p = n.presets[f.preset.value]; if (p) { f.th.value = p.hashrateTHs; f.w.value = p.watts; } };
    const calc = () => {
      const v = { hashrateTHs: +f.th.value, watts: +f.w.value, kwhUsd: +f.kwh.value, poolFeePct: +f.pool.value };
      store.set('mining', { preset: +f.preset.value, kwh: v.kwhUsd, pool: v.poolFeePct, cost: +f.cost.value });
      if (!(v.hashrateTHs > 0 && v.watts > 0)) { $('#mOut').innerHTML = ''; return; }
      const base = { ...v, networkHashrateEHs: n.networkHashrateEHs, blockRewardBtc: n.blockSubsidyBtc, feesPerBlockBtc: n.feesPerBlockBtc };
      const r = miningProfit({ ...base, btcUsd: n.btcUsd });
      const payback = r.profitUsd > 0 ? Math.ceil(+f.cost.value / r.profitUsd) : null;
      const sens = [-0.3, -0.15, 0, 0.15, 0.3].map((d) => [d, miningProfit({ ...base, btcUsd: n.btcUsd * (1 + d) }).profitUsd]);
      $('#mOut').innerHTML = `<div class="stats">${stat('BTC / day', fmt(r.btcPerDay, 8))}${stat('Revenue / day', usd(r.revenueUsd))}${stat('Power / day', usd(r.powerUsd))}
        ${stat('Profit / day', `<span class="${cls(r.profitUsd)}">${usd(r.profitUsd)}</span>`)}${stat('Profit / month', `<span class="${cls(r.profitUsd)}">${usd(r.profitUsd * 30)}</span>`)}
        ${stat('Break-even power', `${usd(r.breakevenKwhUsd, 3)}/kWh`)}${stat('Efficiency', `${fmt(r.efficiencyJTH, 1)} J/TH`)}${stat('Payback', payback ? `${payback} days` : 'Never')}</div>
        <h3>Profit / day if BTC moves</h3><table><tr>${sens.map(([d]) => `<th class="num">${d > 0 ? '+' : ''}${d * 100}%</th>`).join('')}</tr><tr>${sens.map(([, p]) => `<td class="num ${cls(p)}">${usd(p)}</td>`).join('')}</tr></table>`;
    };
    if (saved.preset >= 0) setPreset();
    f.preset.addEventListener('change', () => { setPreset(); calc(); });
    f.addEventListener('input', calc);
    calc();
  } catch (e) { fail(el)(e); }
  if (!$('#fleet')) el.insertAdjacentHTML('afterbegin', '<div id="fleet" class="card"></div>');
  if (window.desktop?.workloads) { // desktop app: mine on this computer (CPU/GPU) by schedule and caps
    el.insertAdjacentHTML('afterbegin', `<div class="card"><div class="bar"><h2>Mine on this computer</h2><span class="spacer"></span>
      <button class="btn ghost" type="button" id="openShare">Open Compute Share</button></div><div id="wlMine"></div></div>`);
    mountWorkloads($('#wlMine'), 'mine');
    $('#openShare').addEventListener('click', () => window.desktop.openShare());
  }
  loadFleet();
  clearInterval(loadFleet.timer);
  loadFleet.timer = setInterval(() => { if (!$('#tab-mining').hidden && !$('#fleet')?.contains(document.activeElement)) loadFleet(); }, 15_000);
}

// ---------------- Mining fleet (remote rigs) ----------------
const fmtHr = (h) => (h == null || !Number.isFinite(h) ? '—' : h >= 1e6 ? `${(h / 1e6).toFixed(2)} MH/s` : h >= 1e3 ? `${(h / 1e3).toFixed(2)} kH/s` : `${h.toFixed(1)} H/s`);
const fmtUp = (s) => (!s ? '—' : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
async function loadFleet() {
  const box = $('#fleet');
  if (!box) return;
  let f;
  try { f = await api('/api/fleet'); } catch (e) { return fail(box)(e); }
  const c = f.config ?? {};
  const online = f.rigs.filter((r) => r.online);
  const total = online.reduce((a, r) => a + (r.stats?.hashrate ?? 0), 0);
  box.innerHTML = `<div class="row"><h2>Mining fleet</h2><span class="muted">${online.length} / ${f.rigs.length} rigs online · ${esc(fmtHr(total))}</span>
      <span><button class="btn" type="button" data-all="run">Run all</button> <button class="btn" type="button" data-all="stop">Stop all</button></span></div>
    ${f.enabled ? '' : '<div class="notice">Rig listener is off. Run <code>npm run make-cert</code>, add <code>FLEET_ENABLED=on</code> plus the printed <code>FLEET_TLS_CERT</code>/<code>FLEET_TLS_KEY</code> lines to .env, then restart.</div>'}
    <div class="grid">
      <form id="fleetCfg"><h3>Pool &amp; payout: rewards go here</h3>
        <div class="row"><label>Coin<input name="coin" value="${esc(c.coin ?? 'XMR')}"></label><label>Pool password<input name="pass" value="${esc(c.pass ?? 'x')}"></label></div>
        <label>Pool (stratum+ssl://host:port)<input name="pool" value="${esc(c.pool ?? '')}" placeholder="stratum+ssl://pool.supportxmr.com:443" spellcheck="false"></label>
        <label>Payout address (your wallet)<input name="payout" value="${esc(c.payout ?? '')}" spellcheck="false"></label>
        <button class="btn" type="submit">Save pool config</button></form>
      <div><h3>Add a rig</h3><p class="muted">On the remote machine run <code>npm run rig</code> (or its desktop shortcut) and paste this one-time link. It is pinned to this host's certificate and expires in 10 minutes.</p>
        <button class="btn primary" id="pairBtn" type="button" ${f.enabled ? '' : 'disabled'}>Generate pairing link</button><div id="pairOut"></div>
        ${f.enabled ? `<p class="muted tiny">Rigs connect to <code>${esc(f.rigUrl)}</code><br>Certificate SHA-256: <span class="mono">${esc(f.fingerprint)}</span></p>` : ''}</div>
    </div>
    <div class="scroll"><table><tr><th>Rig</th><th>Status</th><th class="num">Hashrate</th><th>Uptime</th><th>Owner permissions</th><th>Request</th><th></th></tr>
    ${f.rigs.map((r) => `<tr><td><b>${esc(r.name)}</b><br><span class="muted mono tiny">${esc(r.ip ?? '')}</span></td>
      <td>${r.online ? (r.stats?.running ? '<span class="up">mining</span>' : '<span class="warn">idle</span>') : '<span class="muted">offline</span>'}${r.stats?.error ? `<br><span class="err tiny">${esc(r.stats.error)}</span>` : ''}</td>
      <td class="num">${esc(fmtHr(r.stats?.hashrate))}${r.history?.length > 1 ? `<br>${sparkline(r.history, 90, 20)}` : ''}</td><td>${esc(fmtUp(r.stats?.uptimeSec))}</td>
      <td class="tiny">${r.stats ? `${r.stats.consentMining ? 'mining allowed' : '<span class="down">mining off</span>'} · ${r.stats.remoteControl ? 'host control' : 'local control only'}` : '—'}</td>
      <td><div class="seg"><button type="button" data-cmd="run" data-id="${esc(r.id)}" class="${r.desired === 'run' ? 'on buy' : ''}">Run</button><button type="button" data-cmd="stop" data-id="${esc(r.id)}" class="${r.desired === 'stop' ? 'on sell' : ''}">Stop</button></div></td>
      <td><button class="btn ghost" type="button" data-revoke="${esc(r.id)}" aria-label="Revoke rig">✕</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No rigs linked yet.</td></tr>'}
    </table></div>
    <p class="muted tiny">Rigs never hold keys or wallets. They mine to the payout address above and the pool pays it directly. A rig follows Run/Stop only if its owner enabled "Let the host start and stop mining" on that machine.</p>`;

  $('#fleetCfg').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await api('/api/fleet/config', { method: 'POST', body: fd }); toast('Pool config saved; rigs pick it up within 15 s'); loadFleet(); } catch (err) { toast(err.message, true); }
  });
  $('#pairBtn').addEventListener('click', async () => {
    try {
      const p = await api('/api/fleet/pair', { method: 'POST', body: {} });
      $('#pairOut').innerHTML = `<textarea readonly rows="3" class="mono" aria-label="Pairing link">${esc(p.link)}</textarea><button class="btn" id="copyLink" type="button">Copy</button> <span class="muted tiny">Expires ${esc(new Date(p.expiresAt).toLocaleTimeString())}</span>`;
      $('#copyLink').addEventListener('click', () => navigator.clipboard.writeText(p.link).then(() => toast('Copied')));
    } catch (err) { toast(err.message, true); }
  });
  const command = (rigId, desired) => api('/api/fleet/command', { method: 'POST', body: { rigId, desired } }).then(() => { toast(`Requested ${desired}`); loadFleet(); }).catch((e) => toast(e.message, true));
  $$('[data-cmd]', box).forEach((b) => b.addEventListener('click', () => command(b.dataset.id, b.dataset.cmd)));
  $$('[data-all]', box).forEach((b) => b.addEventListener('click', () => command('all', b.dataset.all)));
  $$('[data-revoke]', box).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Revoke?'; return; } // two-click confirm, no blocking dialogs
    try { await api(`/api/fleet/rig?id=${encodeURIComponent(b.dataset.revoke)}`, { method: 'DELETE' }); toast('Rig revoked'); loadFleet(); } catch (e) { toast(e.message, true); }
  }));
}

// ---------------- Academy ----------------
const chat = [];
function loadAcademy() {
  const el = $('#tab-academy');
  const done = store.get('lessonsDone', {});
  el.innerHTML = `<div class="grid two"><div><div class="row"><h2>Academy</h2><span class="muted">${Object.keys(done).length} / ${LESSONS.length} complete</span></div>
    ${LESSONS.map((l) => `<details><summary>${esc(l.title)} ${done[l.id] ? '<span class="done">✓ passed</span>' : ''}</summary>
      ${l.body.split('\n').map((p) => `<p>${esc(p)}</p>`).join('')}
      <form class="quiz" data-id="${esc(l.id)}"><b>${esc(l.quiz.q)}</b>${l.quiz.options.map((o, i) => `<label class="row"><span><input type="radio" name="a" value="${i}"> ${esc(o)}</span></label>`).join('')}
      <button class="btn" type="submit">Check</button> <span class="res"></span></form></details>`).join('')}</div>
    <div class="card"><h2>AI tutor</h2><p class="muted">Ask anything: "Explain covered calls with numbers", "How do I size a crypto position?", "What is impermanent loss?"</p>
      <div class="chat" id="chat">${chat.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('')}</div>
      <form id="tutorForm" class="row"><label>Your question<textarea name="q" rows="2" maxlength="2000" required></textarea></label><button class="btn primary" type="submit" ${status.ai ? '' : 'disabled'}>Ask</button></form>
      ${status.ai ? '' : '<p class="muted">Add ANTHROPIC_API_KEY to enable the tutor.</p>'}</div></div>`;
  el.insertAdjacentHTML('beforeend', '<div id="journal" class="card"><div class="empty">Loading journal…</div></div>');
  loadJournal();
  $$('.quiz', el).forEach((q) => q.addEventListener('submit', (e) => {
    e.preventDefault();
    const l = LESSONS.find((x) => x.id === q.dataset.id);
    const ok = Number(q.a.value) === l.quiz.answer;
    $('.res', q).innerHTML = ok ? '<span class="up">Correct</span>' : '<span class="down">Not quite. Reread and try again.</span>';
    if (ok) { done[l.id] = true; store.set('lessonsDone', done); }
  }));
  $('#tutorForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim(); if (!q) return;
    const history = chat.slice(-6);
    chat.push({ role: 'user', content: q });
    e.target.reset();
    const box = $('#chat');
    box.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(q)}</div><div class="msg assistant muted" id="pending">Thinking…</div>`);
    try {
      const { answer } = await api('/api/ai/tutor', { method: 'POST', body: { question: q, history } });
      chat.push({ role: 'assistant', content: answer });
      $('#pending').outerHTML = `<div class="msg assistant">${esc(answer)}</div>`;
    } catch (err) { $('#pending').outerHTML = `<div class="msg assistant err">${esc(err.message)}</div>`; chat.pop(); }
    box.scrollTop = box.scrollHeight;
  });
}

// ---------------- Compare ----------------
function loadCompare() {
  const sym = { y: '<span class="y" title="Yes">●</span>', p: '<span class="p" title="Partial">◐</span>', n: '<span class="n" title="No">○</span>' };
  $('#tab-compare').innerHTML = `<div class="card"><h2>How StocksWorks compares</h2>
    <p class="muted">● yes · ◐ partial · ○ no. Compiled November 2026 from vendor sites and independent reviews; features and prices change, so verify before relying on them.</p>
    <div class="scroll"><table class="cmp"><tr><th>Platform</th>${COMPARE_COLS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
    ${COMPARE.map((r) => `<tr class="${r.us ? 'us' : ''}"><td><b>${esc(r.name)}</b></td>${r.cells.map((c) => `<td>${sym[c]}</td>`).join('')}<td class="mono">${esc(r.price)}</td></tr>`).join('')}</table></div></div>
    <div class="grid">${COMPARE.map((r) => `<div class="card"><h3>${esc(r.name)}</h3><p>${esc(r.note)}</p></div>`).join('')}</div>
    <div class="card"><h3>What the research says</h3><p>Across 2026 reviews no tool claims guaranteed profits, and the best ones show their reasoning (entry, stop, target, confidence). In a public test of eight AI models trading real money, only 6 of 32 runs were profitable. StocksWorks is built around that reality: transparent scores, honest backtests against buy-and-hold, hard risk limits, and a human approving every trade.</p>
    <h3>Sources</h3><ul>${COMPARE_SOURCES.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a></li>`).join('')}</ul></div>`;
}

// ---------------- Integrations ----------------
async function loadIntegrations() {
  const el = $('#tab-integrations');
  const origin = location.origin;
  const tick = (ok, label) => `<li class="${ok ? '' : 'bad'}">${esc(label)}</li>`;
  const ds = await desktopSettingsCard().catch(() => '');
  const phone = await phoneCard().catch(() => '');
  el.innerHTML = `${ds}${phone}<div class="grid two"><div class="card"><h2>Connections</h2><ul class="checks">
      ${tick(status.alpaca, 'Alpaca broker (ALPACA_KEY_ID / ALPACA_SECRET_KEY)')}${tick(status.ai, 'Claude AI analyst + tutor (ANTHROPIC_API_KEY)')}
      ${tick(status.webhook?.configured, `Inbound webhooks (WEBHOOK_SECRET) · auto-trading ${status.webhook?.trading ? 'ON' : 'off'}`)}
      ${tick(status.notify, 'Outbound alerts to Discord/Slack (NOTIFY_WEBHOOK_URL)')}${tick(status.totp, 'Two-factor login (TOTP_SECRET)')}${tick(status.tls, 'TLS (TLS_CERT / TLS_KEY), required for remote access')}</ul>
    <h3>Inbound webhook: TradingView alerts</h3><p>URL: <code>${esc(origin)}/webhooks/tradingview</code> (expose it with a TLS tunnel, e.g. Cloudflare Tunnel, never plain HTTP).</p>
    <pre>{"secret":"&lt;WEBHOOK_SECRET&gt;","symbol":"{{ticker}}","side":"buy","type":"market","notional":"100"}</pre>
    <h3>Inbound webhook: signed (any service)</h3><pre>x-timestamp: &lt;unix seconds&gt;
x-signature: sha256=HMAC_SHA256(WEBHOOK_SECRET, timestamp + "." + rawBody)</pre>
    <p class="muted">Every webhook order runs the same risk checks as the UI. Live-mode webhook trading additionally needs WEBHOOK_LIVE_ACK.</p>
    <h3>Get your keys</h3><ul>${LINKS.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a></li>`).join('')}</ul></div>
    <div class="card"><div class="row"><h2>Audit log</h2><span id="auditValid"></span><a class="btn" href="/api/audit.csv" download>Export orders CSV</a></div><div id="audit" class="scroll"><div class="empty">Loading…</div></div></div></div>`;
  try {
    $('#dsFolder')?.addEventListener('click', () => window.desktop.openDataFolder());
    $('#phoneCard')?.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ph]');
      if (!b) return;
      try {
        if (b.dataset.ph === 'toggle') { await api('/api/phone/enable', { method: 'POST', body: { on: b.dataset.on === '1' } }); return loadIntegrations(); }
        if (b.dataset.ph === 'remove' && armed(b, 'Remove?')) { await api(`/api/phone/devices?id=${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' }); toast('Phone removed'); return loadIntegrations(); }
        if (b.dataset.ph === 'pair') {
          const p = await api('/api/phone/pair', { method: 'POST', body: {} });
          $('#phPair').innerHTML = `<p>Scan with your phone's camera (use the address on the same network as your phone). One-time code <b class="mono">${esc(p.code)}</b>, valid 10 minutes.</p>
            <div class="phone-qrs">${p.links.map((l, i) => `<figure><img src="${esc(p.qrs[i])}" alt="Pairing QR code for ${esc(new URL(l).host)}"><figcaption class="mono tiny">${esc(new URL(l).host)}</figcaption></figure>`).join('')}</div>`;
        }
      } catch (err) { toast(err.message, true); }
    });
    $('#prefsCard')?.addEventListener('change', async (e) => {
      const k = e.target.dataset.pref;
      if (!k) return;
      const r = await window.desktop.setPrefs({ [k]: e.target.checked });
      if (r?.error) return toast(r.error, true);
      e.target.checked = r[k];
      toast('Saved');
    });
    $('#dsForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const { passphrase, ...values } = fd;
      const r = await window.desktop.saveSettings(passphrase, values);
      e.target.passphrase.value = '';
      if (r?.error) return toast(r.error, true);
      toast(`Saved ${r.changed.join(', ')}. Restarting…`);
    });
    const { entries, valid } = await api('/api/audit');
    $('#auditValid').innerHTML = valid ? '<span class="pill bullish">hash chain intact</span>' : '<span class="pill bearish">CHAIN BROKEN: log was modified</span>';
    $('#audit').innerHTML = entries.length ? `<table><tr><th>Time (UTC)</th><th>Event</th><th>Detail</th></tr>${entries.map(({ ts, type, prev, hash, ...rest }) => `<tr><td class="mono">${esc(ts.replace('T', ' ').slice(0, 19))}</td><td>${esc(type)}</td><td class="mono muted">${esc(JSON.stringify(rest).slice(0, 160))}</td></tr>`).join('')}</table>` : '<p class="muted">No events yet.</p>';
  } catch (e) { fail($('#audit'))(e); }
}

// ---------------- shared: two-click confirm + protected order placement ----------------
/** Arms a button on first click ("Sure?"), acts on the second. No blocking browser dialogs. */
function armed(btn, label = 'Sure?') {
  if (btn.dataset.armed === '1') return true;
  btn.dataset.armed = '1'; btn.dataset.label = btn.textContent; btn.textContent = label;
  setTimeout(() => { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; }, 4000);
  return false;
}
/** Places an order through the full risk gate; in live mode fetches the bound confirmation token first. */
async function placeChecked(o, totp) {
  let confirmToken = null;
  if (status.mode === 'live') {
    const r = await api('/api/orders/preview', { method: 'POST', body: o });
    if (!r.ok) throw new Error(r.errors.join(' | '));
    confirmToken = r.confirmToken;
  }
  return api('/api/orders', { method: 'POST', body: { ...o, confirmToken, totp } });
}

// ---------------- Portfolio ----------------
const heatColor = (c) => (c == null ? 'var(--line)' : `rgba(${c >= 0 ? '62,224,161' : '255,107,107'},${(0.15 + 0.75 * Math.min(1, Math.abs(c))).toFixed(2)})`);
function heatmap(C) {
  const n = C.symbols.length;
  if (n < 2) return '<p class="muted">Need at least two symbols with price history.</p>';
  const cell = 46, pad = 74, W = pad + n * cell, H = pad + n * cell;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Correlation heatmap">`;
  C.symbols.forEach((sym, i) => {
    s += `<text x="${pad - 6}" y="${pad + i * cell + cell / 2 + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${esc(sym)}</text>`;
    s += `<text x="${pad + i * cell + cell / 2}" y="${pad - 8}" text-anchor="middle" fill="var(--muted)" font-size="10">${esc(sym.slice(0, 7))}</text>`;
  });
  C.matrix.forEach((row, i) => row.forEach((c, j) => {
    s += `<rect x="${pad + j * cell}" y="${pad + i * cell}" width="${cell - 2}" height="${cell - 2}" rx="4" fill="${heatColor(c)}"/>`;
    s += `<text x="${pad + j * cell + cell / 2 - 1}" y="${pad + i * cell + cell / 2 + 4}" text-anchor="middle" fill="var(--text)" font-size="11">${c == null ? '—' : esc(c.toFixed(2))}</text>`;
  }));
  return s + '</svg>';
}
const OPEN_STATUSES = ['new', 'accepted', 'partially_filled', 'held', 'pending_new', 'accepted_for_bidding'];

/** Risk report: market sensitivity (beta vs SPY) and whether each position has a stop protecting it. */
function riskCard(R, A) {
  if (!R || !A.rows.length) return '';
  const C = R.coverage, byCov = Object.fromEntries(C.rows.map((r) => [r.symbol, r]));
  const b = R.portfolioBeta;
  const betaNote = b == null ? '' : b > 1.2 ? 'Your portfolio swings more than the market: a 10% S&P drop implies roughly ' + pct(-0.1 * b) + '.'
    : b < 0.8 ? 'Your portfolio moves less than the market.' : 'Your portfolio moves roughly with the market.';
  return `<div class="card"><div class="row"><h3>Risk report</h3>
      ${C.unprotected.length ? `<span class="warn">${esc(C.unprotected.length)} position(s) have no stop: ${esc(C.unprotected.join(', '))}</span>` : '<span class="up">Every position is protected by a stop</span>'}</div>
    <div class="stats">${stat('Portfolio beta vs S&P 500', fmt(b, 2))}${stat('Open risk to stops', usd(C.openRiskUsd))}${stat('Open risk / invested', pct(A.total ? C.openRiskUsd / A.total : null))}</div>
    <p class="muted">${esc(betaNote)} Open risk is what you would lose if every stop were hit at today's level; unprotected positions are not included, since their loss is uncapped.</p>
    <div class="scroll"><table><tr><th>Symbol</th><th class="num">Beta</th><th>Stop protection</th><th class="num">Risk to stop</th></tr>
    ${A.rows.map((r) => { const c = byCov[r.symbol]; return `<tr><td><b>${esc(r.symbol)}</b></td><td class="num">${fmt(R.betas[r.symbol], 2)}</td>
      <td>${!c ? '—' : c.covered >= 0.999 ? '<span class="up">fully protected</span>' : c.covered > 0 ? `<span class="warn">${pct(c.covered)} of shares</span>` : '<span class="down">none: add a trailing stop below</span>'}</td>
      <td class="num">${usd(c?.riskUsd)}</td></tr>`; }).join('')}</table></div></div>`;
}

async function loadPortfolio() {
  const el = $('#tab-portfolio');
  if (!status.alpaca) { el.innerHTML = needAlpaca(); return; }
  el.innerHTML = '<div class="empty">Analyzing portfolio…</div>';
  try {
    const [p, { positions, orders }] = await Promise.all([api('/api/portfolio'), api('/api/account')]);
    const A = p.allocation, P = p.performance;
    const open = orders.filter((o) => OPEN_STATUSES.includes(o.status));
    const barW = 240;
    el.innerHTML = `
      <div class="stats">${stat('Invested', usd(A.total))}${stat('Unrealized P/L', `<span class="${cls(A.unrealizedPl)}">${usd(A.unrealizedPl)}</span>`)}${stat('3-month return', pct(P.totalReturn))}
        ${stat('Sharpe', fmt(P.sharpe, 2))}${stat('Sortino', fmt(P.sortino, 2))}${stat('Volatility (ann.)', pct(P.volAnnual))}${stat('Max drawdown', pct(P.maxDrawdown == null ? null : -P.maxDrawdown))}${stat('Largest holding', pct(A.topWeight))}</div>
      ${riskCard(p.risk, A)}
      <div class="grid two">
        <div class="card"><h3>Allocation</h3>${A.rows.length ? `<table>${A.rows.map((r) => `<tr><td><b>${esc(r.symbol)}</b> <span class="muted tiny">${esc(r.assetClass)}</span></td>
          <td><svg viewBox="0 0 ${barW} 10" width="${barW}" height="10" aria-hidden="true"><rect width="${barW}" height="10" rx="5" fill="var(--line)"/><rect width="${(r.weight * barW).toFixed(1)}" height="10" rx="5" fill="var(--accent2)"/></svg></td>
          <td class="num">${pct(r.weight)}</td><td class="num ${cls(r.pl)}">${usd(r.pl)}</td></tr>`).join('')}</table>
          <p class="muted">Stocks ${pct(A.byClass.stock)} · Crypto ${pct(A.byClass.crypto)} · Concentration (HHI) ${fmt(A.hhi, 2)}
          ${A.hhi > 0.25 ? '<br><span class="warn">Concentrated: one or two holdings drive most of your results.</span>' : ''}</p>` : '<p class="muted">No positions yet.</p>'}</div>
        <div class="card"><h3>Correlation · 60-day returns · ${esc(p.correlationBasis)}</h3>${heatmap(p.correlation)}
          <p class="muted tiny">Green = they move together (less diversification). Red = they move opposite. Above 0.8 is effectively the same bet twice.</p></div>
      </div>
      <div class="card"><h3>Positions</h3>${positions.length ? `<div class="scroll"><table><tr><th>Symbol</th><th class="num">Qty</th><th class="num">Value</th><th class="num">P/L</th><th>Close</th><th>Trailing stop</th></tr>
        ${positions.map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td class="num">${fmt(x.qty, 6)}</td><td class="num">${usd(x.market_value)}</td><td class="num ${cls(+x.unrealized_pl)}">${usd(x.unrealized_pl)} (${pct(+x.unrealized_plpc)})</td>
          <td><div class="seg">${[25, 50, 100].map((n) => `<button type="button" data-close="${esc(x.symbol)}" data-pct="${n}">${n}%</button>`).join('')}</div></td>
          <td>${x.asset_class === 'crypto' || Math.floor(Math.abs(+x.qty)) < 1 ? '<span class="muted tiny">stocks, whole shares</span>'
            : `<span class="row nowrap"><input class="tiny-in" data-trail-pct="${esc(x.symbol)}" value="5" inputmode="decimal" aria-label="Trail percent for ${esc(x.symbol)}"> % <button class="btn" type="button" data-trail="${esc(x.symbol)}" data-qty="${esc(Math.floor(Math.abs(+x.qty)))}">Protect</button></span>`}</td></tr>`).join('')}</table></div>
        <p class="muted tiny">A trailing stop sells if the price falls the given % from its highest point since you set it, locking in gains while letting winners run.</p>` : '<p class="muted">No positions.</p>'}
        ${status.mode === 'live' ? '<label>Authenticator code (live mode: needed to close or protect positions)<input id="pfTotp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>' : ''}</div>
      <div class="card"><h3>Open orders</h3>${open.length ? `<div class="scroll"><table><tr><th>Symbol</th><th>Side</th><th>Type</th><th class="num">Qty / $</th><th>Status</th><th></th></tr>
        ${open.map((o) => `<tr><td>${esc(o.symbol)}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${esc(o.side)}</td><td>${esc(o.type)}${o.order_class === 'bracket' ? ' · bracket' : ''}${o.trail_percent ? ` · ${esc(o.trail_percent)}%` : ''}</td>
          <td class="num">${esc(o.qty ?? '$' + o.notional)}</td><td>${esc(o.status)}</td><td><button class="btn ghost" type="button" data-cancel="${esc(o.id)}">Cancel</button></td></tr>`).join('')}</table></div>` : '<p class="muted">No open orders.</p>'}</div>`;
    const totp = () => $('#pfTotp')?.value ?? '';
    $$('[data-close]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!armed(b, `Close ${b.dataset.pct}%?`)) return;
      try { await api('/api/positions/close', { method: 'POST', body: { symbol: b.dataset.close, percentage: Number(b.dataset.pct), totp: totp() } }); toast(`Closing ${b.dataset.pct}% of ${b.dataset.close}`); loadPortfolio(); } catch (e) { toast(e.message, true); }
    }));
    $$('[data-trail]', el).forEach((b) => b.addEventListener('click', async () => {
      const trail = $(`[data-trail-pct="${CSS.escape(b.dataset.trail)}"]`, el).value.trim();
      if (!armed(b, `Trail ${trail}%?`)) return;
      try { await placeChecked({ symbol: b.dataset.trail, side: 'sell', type: 'trailing_stop', qty: b.dataset.qty, trail_percent: trail }, totp()); toast(`Trailing stop set on ${b.dataset.trail}`); loadPortfolio(); } catch (e) { toast(e.message, true); }
    }));
    $$('[data-cancel]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!armed(b)) return;
      try { await api(`/api/orders?id=${encodeURIComponent(b.dataset.cancel)}`, { method: 'DELETE' }); toast('Order cancelled'); loadPortfolio(); } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { fail(el)(e); }
}

// ---------------- Strategy Lab ----------------
let labStrategies = null;
function lines(series, colors, W = 800, H = 220) {
  const all = series.flat().filter(Number.isFinite);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1, n = series[0].length;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Equity curves">${series.map((s, k) =>
    `<polyline fill="none" stroke="${colors[k]}" stroke-width="2" vector-effect="non-scaling-stroke" points="${s.map((y, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H - 4 - ((y - lo) / span) * (H - 8)).toFixed(1)}`).join(' ')}"/>`).join('')}</svg>`;
}
async function loadLab() {
  const el = $('#tab-lab');
  if (!status.alpaca) { el.innerHTML = needAlpaca(); return; }
  try { labStrategies ??= await api('/api/lab/strategies'); } catch (e) { return fail(el)(e); }
  const S = labStrategies;
  const saved = store.get('lab', { symbol: 'SPY', strategy: 'smaCross', params: {} });
  el.innerHTML = `<div class="grid two"><form id="labForm" class="card"><h2>Strategy Lab</h2>
      <p class="muted">Test a rule on ~3 years of daily bars before risking money. Each day's decision uses only data up to that day; every switch costs 5 bps.</p>
      <div class="row"><label>Symbol<input name="symbol" value="${esc(saved.symbol)}" autocomplete="off"></label>
        <label>Strategy<select name="strategy">${Object.entries(S).map(([k, v]) => `<option value="${esc(k)}" ${k === saved.strategy ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label></div>
      <p id="labAbout" class="muted"></p><div id="labParams" class="row"></div>
      <button class="btn primary" type="submit">Run backtest</button>
      <h3>Robustness sweep</h3><p class="muted tiny">Re-runs the strategy across a grid of settings. A broad green area means a robust rule; one lucky green cell means overfitting.</p>
      <div class="row"><label>Vary<select name="sx"></select></label><label>And<select name="sy"></select></label><button class="btn" type="button" id="sweepBtn">Run sweep</button></div></form>
    <div class="card"><h3>Reading the results honestly</h3><ul class="checks">
      <li>Always compare with buy-and-hold. Underperforming it with more trades is worse than doing nothing.</li>
      <li>Sharpe above 1 is good. Max drawdown is the pain you'd have had to sit through.</li>
      <li>Change one parameter at a time. If results swing wildly, you're fitting noise (overfitting).</li>
      <li>Past results don't guarantee future ones. Paper trade a rule before using real money.</li></ul></div></div>
    <div id="labOut"></div>`;
  const f = $('#labForm');
  const paint = () => {
    const s = S[f.strategy.value];
    $('#labAbout').textContent = s?.about ?? '';
    $('#labParams').innerHTML = Object.entries(s?.params ?? {}).map(([k, p]) => `<label>${esc(p.label)} <span class="muted tiny">${esc(p.min)}–${esc(p.max)}</span>
      <input name="p_${esc(k)}" inputmode="numeric" value="${esc(saved.strategy === f.strategy.value ? (saved.params?.[k] ?? p.def) : p.def)}"></label>`).join('');
    const keys = Object.entries(s?.params ?? {});
    f.sx.innerHTML = keys.map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}</option>`).join('');
    f.sy.innerHTML = '<option value="">(nothing: 1-D sweep)</option>' + keys.map(([k, p], i) => `<option value="${esc(k)}" ${i === 1 ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  };
  f.strategy.addEventListener('change', paint);
  paint();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const params = Object.fromEntries([...new FormData(f)].filter(([k]) => k.startsWith('p_')).map(([k, v]) => [k.slice(2), v]));
    const body = { symbol: f.symbol.value.trim().toUpperCase(), strategy: f.strategy.value, params };
    store.set('lab', body);
    $('#labOut').innerHTML = '<div class="empty">Running backtest…</div>';
    try { renderLab(await api('/api/lab', { method: 'POST', body })); } catch (err) { $('#labOut').innerHTML = `<div class="card err">${esc(err.message)}</div>`; }
  });
  $('#sweepBtn').addEventListener('click', async () => {
    const params = Object.fromEntries([...new FormData(f)].filter(([k]) => k.startsWith('p_')).map(([k, v]) => [k.slice(2), v]));
    const body = { symbol: f.symbol.value.trim().toUpperCase(), strategy: f.strategy.value, params, x: f.sx.value, y: f.sy.value || null };
    if (body.y === body.x) return toast('Pick two different settings (or none for the second)', true);
    $('#labOut').innerHTML = '<div class="empty">Running up to 36 backtests…</div>';
    try { renderSweep(await api('/api/lab/sweep', { method: 'POST', body }), S); } catch (err) { $('#labOut').innerHTML = `<div class="card err">${esc(err.message)}</div>`; }
  });
}

function renderSweep(s, S) {
  const P = S[s.strategy].params;
  const vals = s.grid.flat().filter(Boolean).map((c) => c.totalReturn);
  const maxAbs = Math.max(0.01, ...vals.map(Math.abs));
  const cw = 92, ch = 44, padL = 110, padT = 34;
  const W = padL + s.xs.length * cw, H = padT + s.ys.length * ch + 10;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Parameter sweep heatmap">`;
  svg += `<text x="${padL}" y="14" fill="var(--muted)" font-size="12">${esc(P[s.xKey].label)} →</text>`;
  s.xs.forEach((x, i) => { svg += `<text x="${padL + i * cw + cw / 2}" y="${padT - 6}" text-anchor="middle" fill="var(--muted)" font-size="11">${esc(x)}</text>`; });
  s.ys.forEach((y, j) => {
    svg += `<text x="${padL - 8}" y="${padT + j * ch + ch / 2 + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${s.yKey ? `${esc(P[s.yKey].label)} ${esc(y)}` : 'Total return'}</text>`;
    s.grid[j].forEach((c, i) => {
      const fill = !c ? 'var(--line)' : `rgba(${c.totalReturn >= 0 ? '62,224,161' : '255,107,107'},${(0.15 + 0.75 * Math.min(1, Math.abs(c.totalReturn) / maxAbs)).toFixed(2)})`;
      svg += `<g><title>${c ? esc(`Return ${(c.totalReturn * 100).toFixed(1)}% · Sharpe ${c.sharpe == null ? '—' : c.sharpe.toFixed(2)} · ${c.trades} trades`) : 'Invalid combination'}</title>
        <rect x="${padL + i * cw}" y="${padT + j * ch}" width="${cw - 3}" height="${ch - 3}" rx="5" fill="${fill}"/>
        <text x="${padL + i * cw + cw / 2 - 1}" y="${padT + j * ch + ch / 2 + 4}" text-anchor="middle" fill="var(--text)" font-size="12">${c ? esc((c.totalReturn * 100).toFixed(1) + '%') : '—'}</text></g>`;
    });
  });
  const good = vals.filter((v) => v > 0).length;
  $('#labOut').innerHTML = `<div class="card"><h3>Robustness sweep · total return over ~3 years</h3>${svg}</svg>
    <p class="muted">${esc(good)} of ${esc(vals.length)} settings were profitable. Hover a cell for Sharpe and trade count.
    ${vals.length && good / vals.length >= 0.7 ? 'Results hold across most settings, a sign of a robust rule.' : 'Results depend heavily on the exact settings, so treat any single good result with suspicion.'}</p></div>`;
}
function renderLab(r) {
  const m = r.metrics, b = r.buyHoldMetrics;
  const neg = (x) => (x == null ? null : -x);
  const row = (k, a, bb, f = pct) => `<tr><td>${esc(k)}</td><td class="num">${f(a)}</td><td class="num">${f(bb)}</td></tr>`;
  const beat = m.totalReturn > b.totalReturn, safer = m.sharpe != null && b.sharpe != null && m.sharpe > b.sharpe;
  $('#labOut').innerHTML = `<div class="grid two"><div class="card"><h3>Equity curve · ${esc(r.dates[0])} → ${esc(r.dates.at(-1))}</h3>${lines([r.buyHold, r.equity], ['var(--muted)', 'var(--accent)'])}
      <div class="legend"><span><i class="sw" data-c="50"></i>Strategy</span><span><i class="sw sw-muted"></i>Buy &amp; hold</span></div>
      <p class="${beat ? 'up' : 'warn'}">${beat ? 'Beat buy-and-hold on this history.' : 'Did not beat buy-and-hold on this history.'} ${safer ? 'Better risk-adjusted (higher Sharpe).' : ''}</p></div>
    <div class="card"><table><tr><th></th><th class="num">Strategy</th><th class="num">Buy &amp; hold</th></tr>
      ${row('Total return', m.totalReturn, b.totalReturn)}${row('CAGR', m.cagr, b.cagr)}${row('Volatility', m.volAnnual, b.volAnnual)}${row('Max drawdown', neg(m.maxDrawdown), neg(b.maxDrawdown))}
      ${row('Sharpe', m.sharpe, b.sharpe, (x) => fmt(x, 2))}${row('Sortino', m.sortino, b.sortino, (x) => fmt(x, 2))}${row('Worst day', m.worstDay, b.worstDay)}</table>
      <div class="stats">${stat('Trades', esc(r.trades.length))}${stat('Win rate', pct(r.winRate))}${stat('Avg trade', pct(r.avgTradeReturn))}${stat('Time invested', pct(r.exposure))}</div>
      <h3>In-sample vs out-of-sample</h3>
      <table><tr><th></th><th class="num">First 70% (in-sample)</th><th class="num">Last 30% (out-of-sample)</th></tr>
        ${[['Strategy return', r.split.train.totalReturn, r.split.test.totalReturn], ['Buy & hold return', r.split.trainBuyHold.totalReturn, r.split.testBuyHold.totalReturn]]
          .map(([k, a, bb]) => `<tr><td>${esc(k)}</td><td class="num ${cls(a)}">${pct(a)}</td><td class="num ${cls(bb)}">${pct(bb)}</td></tr>`).join('')}
        <tr><td>Sharpe</td><td class="num">${fmt(r.split.train.sharpe, 2)}</td><td class="num">${fmt(r.split.test.sharpe, 2)}</td></tr></table>
      <p class="muted tiny">${r.split.test.totalReturn > r.split.testBuyHold.totalReturn ? 'The edge held on the most recent 30%.' : 'The edge did not hold on the most recent 30%.'} Tune settings while looking only at the first 70%, then check the last 30%.</p></div></div>
    <div class="card"><h3>Trades (latest 40)</h3>${r.trades.length ? `<div class="scroll"><table><tr><th>Entry</th><th>Exit</th><th class="num">Entry $</th><th class="num">Exit $</th><th class="num">Return</th></tr>
      ${r.trades.slice(-40).reverse().map((t) => `<tr><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}${t.open ? ' <span class="muted tiny">(still open)</span>' : ''}</td><td class="num">${usd(t.entry)}</td><td class="num">${usd(t.exit)}</td><td class="num ${cls(t.ret)}">${pct(t.ret)}</td></tr>`).join('')}</table></div>` : '<p class="muted">The rule never triggered on this history.</p>'}</div>`;
}

// ---------------- Alerts ----------------
async function loadAlerts() {
  const el = $('#tab-alerts');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const d = await api('/api/alerts');
    const T = d.types;
    const unit = (t) => { const u = T[t]?.unit ?? ''; return u === '$' ? '' : u.startsWith('-') ? u : ` ${u}`; };
    el.innerHTML = `${d.running ? '' : '<div class="notice">Alerts need market data: add Alpaca keys. Rules you save now start checking once keys are set.</div>'}
      <div class="grid two"><form id="alertForm" class="card"><h2>New alert</h2>
        <div class="row"><label>Symbol<input name="symbol" placeholder="AAPL or BTC/USD" required autocomplete="off"></label>
          <label>Condition<select name="type">${Object.entries(T).map(([k, t]) => `<option value="${esc(k)}">${esc(t.label)}</option>`).join('')}</select></label>
          <label>Value<input name="value" inputmode="decimal" required></label></div>
        <label>Note (optional)<input name="note" maxlength="80" placeholder="e.g. breakout above resistance"></label>
        <button class="btn primary" type="submit">Create alert</button>
        <p class="muted tiny">Checked every minute on the server. Each alert fires once, then waits to be re-armed. Delivered here${status.notify ? ' and to your Discord/Slack webhook' : ' (add NOTIFY_WEBHOOK_URL for Discord/Slack)'}.</p></form>
      <div class="card"><h3>Recently fired</h3>${d.events.length ? `<ul class="feed">${d.events.map((ev) => `<li><span class="mono muted tiny">${esc(new Date(ev.at).toLocaleString())}</span><br>${esc(ev.text)}</li>`).join('')}</ul>` : '<p class="muted">Nothing has fired yet.</p>'}</div></div>
      <div class="card"><h3>Your alerts (${esc(d.alerts.length)}/100)</h3>${d.alerts.length ? `<div class="scroll"><table><tr><th>Symbol</th><th>Condition</th><th>Status</th><th>Note</th><th></th></tr>
        ${d.alerts.map((a) => `<tr><td><b>${esc(a.symbol)}</b></td><td>${esc(T[a.type]?.label)} ${esc(a.value)}${esc(unit(a.type))}</td>
          <td>${a.armed ? '<span class="up">watching</span>' : `<span class="warn">fired ${esc(new Date(a.triggeredAt).toLocaleString())}</span>`}</td><td class="muted">${esc(a.note)}</td>
          <td class="nowrap">${a.armed ? '' : `<button class="btn" type="button" data-rearm="${esc(a.id)}">Re-arm</button> `}<button class="btn ghost" type="button" data-adel="${esc(a.id)}" aria-label="Delete alert">✕</button></td></tr>`).join('')}</table></div>` : '<p class="muted">No alerts yet.</p>'}</div>`;
    const af = $('#alertForm');
    const hint = () => { const t = T[af.type.value]; af.value.placeholder = t.choices ? t.choices.join(' or ') : `${t.min > 1e-6 ? t.min : 0}–${t.max >= 1e9 ? 'any' : t.max} ${t.unit}`; };
    af.type.addEventListener('change', hint);
    hint();
    $('#alertForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/alerts', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Alert created'); loadAlerts(); } catch (err) { toast(err.message, true); }
    });
    $$('[data-rearm]', el).forEach((b) => b.addEventListener('click', () => api('/api/alerts/rearm', { method: 'POST', body: { id: b.dataset.rearm } }).then(loadAlerts).catch((e) => toast(e.message, true))));
    $$('[data-adel]', el).forEach((b) => b.addEventListener('click', () => { if (armed(b)) api(`/api/alerts?id=${encodeURIComponent(b.dataset.adel)}`, { method: 'DELETE' }).then(loadAlerts).catch((e) => toast(e.message, true)); }));
  } catch (e) { fail(el)(e); }
}

// ---------------- Trade journal (Academy) ----------------
async function loadJournal() {
  const box = $('#journal');
  if (!box) return;
  try {
    const d = await api('/api/journal');
    const s = d.stats;
    const groupTable = (rows, key, label) => `<table><tr><th>${esc(label)}</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">P/L</th></tr>
      ${rows.map((g) => `<tr><td>${esc(g[key])}</td><td class="num">${esc(g.n)}</td><td class="num">${pct(g.winRate)}</td><td class="num ${cls(g.pnl)}">${usd(g.pnl)}</td></tr>`).join('')}</table>`;
    const tilt = s.byEmotion.filter((g) => ['fomo', 'revenge', 'greedy', 'bored'].includes(g.emotion) && g.pnl < 0);
    box.innerHTML = `<div class="row"><h2>Trade journal</h2><span class="muted">Write the plan before the trade; grade it after. This is how traders actually improve.</span><a class="btn" href="/api/journal.csv" download>Export CSV</a></div>
      <div class="stats">${stat('Entries', esc(s.total))}${stat('Win rate', pct(s.winRate))}${stat('Total P/L', `<span class="${cls(s.totalPnl)}">${usd(s.totalPnl)}</span>`)}
        ${stat('Expectancy / trade', usd(s.expectancy))}${stat('Avg win', usd(s.avgWin))}${stat('Avg loss', usd(s.avgLoss))}</div>
      <div class="grid two"><form id="jForm"><h3>New entry</h3>
        <div class="row"><label>Symbol<input name="symbol" required autocomplete="off"></label><label>Side<select name="side"><option>buy</option><option>sell</option></select></label>
          <label>Setup<input name="setup" maxlength="40" placeholder="breakout, dip-buy…"></label></div>
        <div class="row"><label>Emotion<select name="emotion">${d.emotions.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
          <label>Confidence (1-5)<input name="confidence" value="3" inputmode="numeric"></label>
          <label>Outcome<select name="outcome">${d.outcomes.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label><label>P/L ($)<input name="pnl" inputmode="decimal"></label></div>
        <label>Thesis: why this trade, where's the stop, what would prove you wrong?<textarea name="thesis" rows="3" maxlength="2000"></textarea></label>
        <label>Lesson (fill in when closed)<textarea name="lesson" rows="2" maxlength="2000"></textarea></label>
        <button class="btn primary" type="submit">Save entry</button></form>
      <div><h3>What your journal says</h3>${s.closed ? `${groupTable(s.byEmotion, 'emotion', 'Emotion')}${groupTable(s.bySetup, 'setup', 'Setup')}` : '<p class="muted">Close a few entries to see which setups and emotions make or lose you money.</p>'}
        ${tilt.length ? `<div class="lesson">Trades taken while feeling ${esc(tilt.map((g) => g.emotion).join(', '))} are losing you money. Write a rule for it, e.g. "no new entries within 30 minutes of a loss".</div>` : ''}</div></div>
      <h3>Entries</h3>${d.entries.length ? `<div class="scroll"><table><tr><th>Date</th><th>Trade</th><th>Setup</th><th>Mindset</th><th>Outcome</th><th class="num">P/L</th><th>Thesis / lesson</th><th></th></tr>
        ${d.entries.slice(0, 100).map((e) => `<tr><td class="mono tiny">${esc(new Date(e.createdAt).toLocaleDateString())}</td><td><b>${esc(e.symbol)}</b> ${esc(e.side)}</td><td>${esc(e.setup)}</td><td>${esc(e.emotion)} · ${esc(e.confidence)}/5</td>
          <td><select data-outcome="${esc(e.id)}" aria-label="Outcome">${d.outcomes.map((x) => `<option ${x === e.outcome ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
          <td class="num"><input class="tiny-in" data-pnl="${esc(e.id)}" value="${esc(e.pnl ?? '')}" inputmode="decimal" aria-label="P/L"></td>
          <td class="tiny">${esc(e.thesis.slice(0, 160))}${e.lesson ? `<br><b>Lesson:</b> ${esc(e.lesson.slice(0, 160))}` : ''}</td>
          <td><button class="btn ghost" type="button" data-jdel="${esc(e.id)}" aria-label="Delete entry">✕</button></td></tr>`).join('')}</table></div>` : '<p class="muted">No entries yet.</p>'}`;
    $('#jForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      body.confidence = Number(body.confidence);
      try { await api('/api/journal', { method: 'POST', body }); toast('Journal entry saved'); loadJournal(); } catch (err) { toast(err.message, true); }
    });
    const update = (id, patch) => api('/api/journal/update', { method: 'POST', body: { id, ...patch } }).then(loadJournal).catch((e) => toast(e.message, true));
    $$('[data-outcome]', box).forEach((s2) => s2.addEventListener('change', () => update(s2.dataset.outcome, { outcome: s2.value })));
    $$('[data-pnl]', box).forEach((i) => i.addEventListener('change', () => update(i.dataset.pnl, { pnl: i.value })));
    $$('[data-jdel]', box).forEach((b) => b.addEventListener('click', () => { if (armed(b)) api(`/api/journal?id=${encodeURIComponent(b.dataset.jdel)}`, { method: 'DELETE' }).then(loadJournal).catch((e) => toast(e.message, true)); }));
  } catch (e) { fail(box)(e); }
}

// ---------------- Wallet creation (self-custody, in-browser) ----------------
const WALLET_APPS = [
  ['Ledger', 'https://www.ledger.com/', 'Hardware. Best for savings: keys never leave the device.'],
  ['Trezor', 'https://trezor.io/', 'Hardware, open source.'],
  ['MetaMask', 'https://metamask.io/', 'Ethereum + EVM chains. Import: "Secret Recovery Phrase".'],
  ['Rabby', 'https://rabby.io/', 'EVM, shows what a transaction will do before you sign.'],
  ['Coinbase Wallet', 'https://www.coinbase.com/wallet', 'Self-custody app (separate from a Coinbase exchange account).'],
  ['Sparrow', 'https://sparrowwallet.com/', 'Bitcoin desktop. Import as BIP39, Native SegWit (m/84\'/0\'/0\').'],
  ['Electrum', 'https://electrum.org/', 'Bitcoin. Choose "BIP39 seed", native SegWit.'],
  ['Phantom', 'https://phantom.com/', 'Solana, ETH, BTC. Import the same phrase there.'],
];
let refreshWallets = () => {};

function renderWalletCreator() {
  const box = $('#walletCreate');
  if (!box) return;
  box.innerHTML = `<h2>Create a new wallet</h2>
    <div class="grid two"><div><h3>Option A: in a wallet app or device</h3>
      <p class="muted">Recommended for meaningful amounts, especially a hardware wallet. Then paste its public address into Watch-only above.</p>
      <ul class="links">${WALLET_APPS.map(([n, u, d]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(n)}</a> <span class="muted tiny">${esc(d)}</span></li>`).join('')}</ul></div>
    <div><h3>Option B: generate a recovery phrase here</h3>
      <p class="muted">A standard 24-word BIP-39 phrase, created in this window by your device's secure random generator. It's never sent to the server and never saved, and it works in every wallet on the left.</p>
      <label class="check-row"><input type="checkbox" id="wcSafe"> <span>I'm alone, not screen-sharing, and have paper ready. Anyone with these words controls the funds; nobody, StocksWorks included, can recover them.</span></label>
      <label>Optional BIP-39 passphrase ("25th word"). Leave empty unless you know you need it; losing it loses the wallet.<input id="wcPass" type="password" autocomplete="off"></label>
      <button class="btn primary" id="wcGen" type="button" disabled>Generate recovery phrase</button></div></div>
    <div id="wcStage"></div>`;
  $('#wcSafe').addEventListener('change', (e) => { $('#wcGen').disabled = !e.target.checked; });
  $('#wcGen').addEventListener('click', generateWallet);
}

async function generateWallet() {
  const stage = $('#wcStage');
  let kit;
  try { kit = await import('/vendor/walletkit.js'); } catch { return toast('Wallet module failed to load', true); }
  let words = kit.newMnemonic().split(' ');
  $('#wcGen').disabled = true;
  // Lock the passphrase now: the wallet is defined by these words + exactly this passphrase.
  let pass = $('#wcPass').value;
  $('#wcPass').disabled = true;
  stage.innerHTML = `<div class="notice">Write these 24 words on paper, in order. Don't screenshot, copy, photograph or store them digitally.</div>
    <ol class="seed" id="wcWords"></ol><button class="btn" id="wcDone" type="button">I've written all 24 down</button>`;
  const ol = $('#wcWords');
  for (const w of words) { const li = document.createElement('li'); li.textContent = w; ol.appendChild(li); }
  $('#wcDone').addEventListener('click', () => {
    const picks = [];
    while (picks.length < 3) { const i = crypto.getRandomValues(new Uint32Array(1))[0] % 24; if (!picks.includes(i)) picks.push(i); }
    picks.sort((a, b) => a - b);
    stage.innerHTML = `<p>Confirm from your paper copy (the words are now hidden):</p>
      <form id="wcCheck" class="row">${picks.map((i) => `<label>Word #${i + 1}<input name="w${i}" autocomplete="off" spellcheck="false" autocapitalize="off"></label>`).join('')}
      ${pass ? '<label>Re-type your passphrase (it is part of the wallet; without it the words restore a different, empty wallet)<input name="pp" type="password" autocomplete="off"></label>' : ''}
      <button class="btn primary" type="submit">Verify</button></form><button class="btn ghost" id="wcBack" type="button">Show the words again</button>`;
    $('#wcBack').addEventListener('click', () => {
      stage.insertAdjacentHTML('afterbegin', '<ol class="seed" id="wcWords2"></ol>');
      for (const w of words) { const li = document.createElement('li'); li.textContent = w; $('#wcWords2').appendChild(li); }
      $('#wcBack').remove();
    });
    $('#wcCheck').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!picks.every((i) => e.target[`w${i}`].value.trim().toLowerCase() === words[i])) return toast("Those words don't match. Check your paper copy; order matters.", true);
      if (pass && e.target.pp.value !== pass) return toast("The passphrase doesn't match what you set. It must be exact (case and spaces count).", true);
      let addrs;
      try { addrs = kit.deriveAddresses(words.join(' '), pass); } catch (err) { return toast(err.message, true); }
      words.fill(''); words = null; pass = null; // drop the phrase and passphrase from this page
      $('#wcPass').value = ''; $('#wcPass').disabled = false; $('#wcSafe').checked = false;
      stage.innerHTML = `<p class="up">Wallet created. The recovery phrase has been cleared from this page.</p>
        <table><tr><td>Ethereum (ETH + EVM tokens)</td><td class="mono">${esc(addrs.eth)}</td><td class="muted tiny">${esc(addrs.paths.eth)}</td></tr>
        <tr><td>Bitcoin (native SegWit)</td><td class="mono">${esc(addrs.btc)}</td><td class="muted tiny">${esc(addrs.paths.btc)}</td></tr></table>
        <p class="muted">These are receive addresses, now added to Watch-only. To spend, import your phrase into a wallet app (MetaMask: "Import using Secret Recovery Phrase"; Sparrow/Electrum: BIP39, Native SegWit). Send a small test amount first.</p>`;
      for (const [chain, address] of [['eth', addrs.eth], ['btc', addrs.btc]]) {
        await api('/api/wallets', { method: 'POST', body: { chain, address, label: 'Created in StocksWorks' } }).catch((err) => toast(err.message, true));
      }
      refreshWallets();
    });
  });
}

// ---------------- Banks & outside brokerages (Plaid) ----------------
let plaidLoader = null;
const loadPlaid = () => (plaidLoader ??= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
  s.onload = () => resolve(window.Plaid);
  s.onerror = () => { plaidLoader = null; reject(new Error('Could not load Plaid Link')); };
  document.head.appendChild(s);
}));

async function loadBanks() {
  const el = $('#tab-banks');
  el.innerHTML = '<div class="empty">Loading…</div>';
  let d;
  try { d = await api('/api/banks'); } catch (e) { return fail(el)(e); }
  const funding = `<div class="card"><h3>Funding your trading account</h3><ol class="steps">
      <li>Alpaca dashboard → Banking → Deposit: link a bank for ACH (free, 1-3 business days) or use the wire instructions it shows (usually same day; your bank may charge a fee).</li>
      <li>For a wire, start it in your bank's app or branch using Alpaca's recipient details. "Show account &amp; routing" below gives your own source-account details if a form asks for them.</li>
      <li>Wires are irreversible. Confirm recipient details from the official dashboard or by phone, never from an email or chat message.</li></ol>
      <p><a class="btn" href="https://app.alpaca.markets/" target="_blank" rel="noopener noreferrer">Open Alpaca dashboard</a></p></div>`;
  if (!d.enabled) {
    el.innerHTML = `<div class="grid two"><div class="card"><h2>Connect banks &amp; brokerages</h2>
      <p>StocksWorks links US banks (balances, account &amp; routing numbers) and outside brokerages such as Fidelity, Schwab, Vanguard and Robinhood (holdings) through Plaid. You sign in to your bank in Plaid's window, so StocksWorks never sees your bank password.</p>
      <ol class="steps"><li>Create a free account at <a href="https://dashboard.plaid.com/signup" target="_blank" rel="noopener noreferrer">dashboard.plaid.com</a> and copy your client ID and sandbox secret.</li>
        <li>Run <code>npm run new-secret</code> for an encryption key.</li>
        <li>Add to <code>.env</code>: <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code>, <code>PLAID_ENV=sandbox</code>, <code>BANK_ENCRYPTION_KEY</code>. Restart.</li>
        <li>Try it with sandbox logins (<code>user_good</code> / <code>pass_good</code>). Request production access from Plaid to link your real accounts.</li></ol></div>${funding}</div>`;
    return renderSchwab(el);
  }
  el.innerHTML = `<div class="stats" id="nwStats"></div>
    <div class="grid two"><div class="card"><h2>Link accounts</h2>
      <p class="muted">Through Plaid (12,000+ US institutions). You sign in inside Plaid's window; StocksWorks stores only an encrypted access token.${d.env === 'sandbox' ? ' <b>Sandbox mode:</b> sign in with user_good / pass_good.' : ''}</p>
      <div class="row"><button class="btn primary" type="button" data-link="bank">Link a bank account</button><button class="btn" type="button" data-link="brokerage">Link an outside brokerage</button></div>
      ${status.totp ? '<label>Authenticator code (to reveal account numbers)<input id="bankTotp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>' : '<p class="muted tiny">Revealing full account &amp; routing numbers requires two-factor login: run <code>npm run new-totp</code> and add TOTP_SECRET to .env.</p>'}</div>${funding}</div>
    <div id="bankList"><div class="empty">Loading accounts…</div></div>`;
  $$('[data-link]', el).forEach((b) => b.addEventListener('click', async () => {
    const kind = b.dataset.link;
    try {
      const [{ link_token }, Plaid] = await Promise.all([api('/api/banks/link-token', { method: 'POST', body: { kind } }), loadPlaid()]);
      Plaid.create({
        token: link_token,
        onSuccess: async (public_token, metadata) => {
          try { await api('/api/banks/exchange', { method: 'POST', body: { public_token, kind, institution: metadata?.institution?.name } }); toast('Linked'); loadBanks(); } catch (e) { toast(e.message, true); }
        },
        onExit: (err) => { if (err) toast(err.display_message || err.error_message || 'Linking was cancelled', true); },
      }).open();
    } catch (e) { toast(e.message, true); }
  }));
  renderBankList();
  renderSchwab(el);
}

// ---------------- Charles Schwab (direct broker connection) ----------------
async function renderSchwab(el) {
  el.insertAdjacentHTML('afterbegin', '<div class="card" id="schwabBox"><div class="empty">Loading Schwab…</div></div>');
  const box = $('#schwabBox');
  let s;
  try { s = await api('/api/brokers/schwab'); } catch (e) { return fail(box)(e); }
  if (!s.enabled) {
    box.innerHTML = `<h2>Charles Schwab</h2><p>Connect your Schwab brokerage directly: balances and positions here, and (if you switch it on) trading from the order ticket.</p>
      <ol class="steps"><li>Sign in at <a href="https://developer.schwab.com/" target="_blank" rel="noopener noreferrer">developer.schwab.com</a> with your Schwab login and create an app with <b>Accounts and Trading Production</b> and <b>Market Data Production</b>. Callback URL: <code>https://127.0.0.1</code>. Schwab approves apps in a few days.</li>
        <li>Enter its app key and secret ${window.desktop ? 'under <b>Integrations → Desktop settings</b>' : 'in <code>.env</code> as <code>SCHWAB_CLIENT_ID</code> / <code>SCHWAB_CLIENT_SECRET</code>'}, then come back here and press Connect.</li></ol>
      <p class="muted tiny">Fidelity, Vanguard, E*TRADE, Robinhood and most other brokerages can be linked read-only through Plaid below.</p>`;
    return;
  }
  const connect = `<p class="muted">Press Connect and sign in at Schwab (your password goes only to Schwab). Schwab then sends your browser to <code>${esc(s.redirectUri)}</code>, which shows a "can't connect" page: that's expected. Copy that page's full address and paste it here within 30 seconds.</p>
    <div class="row"><button class="btn primary" type="button" data-s="start">${s.connected ? 'Reconnect' : 'Connect'} Schwab</button>
      <label>Address you landed on<input id="sUrl" placeholder="https://127.0.0.1/?code=…" autocomplete="off" spellcheck="false"></label><button class="btn" type="button" data-s="finish">Finish</button></div>`;
  box.innerHTML = `<div class="bar"><h2>Charles Schwab</h2><span class="pill ${s.connected ? 'bullish' : ''}">${s.connected ? 'connected' : 'not connected'}</span>
      ${s.connected ? `<span class="pill">${s.trading ? 'trading on (real money)' : 'read-only'}</span><span class="spacer"></span><button class="btn ghost" type="button" data-s="unlink">Disconnect</button>` : ''}</div>
    ${s.connected ? `<p class="muted tiny">Schwab requires signing in again every 7 days: this connection expires ${esc(new Date(s.expiresAt).toLocaleString())}.${s.trading ? '' : ' To trade from the order ticket, set SCHWAB_TRADING=on in .env (two-factor login required).'}</p><div id="sAccts"><div class="empty">Loading accounts…</div></div>
      <details><summary>Reconnect</summary>${connect}</details>` : connect}`;
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    try {
      if (b.dataset.s === 'start') window.open((await api('/api/brokers/schwab/start', { method: 'POST', body: {} })).url, '_blank', 'noopener');
      if (b.dataset.s === 'finish') { await api('/api/brokers/schwab/finish', { method: 'POST', body: { url: $('#sUrl').value } }); toast('Schwab connected'); loadBanks(); }
      if (b.dataset.s === 'unlink' && armed(b, 'Disconnect?')) { await api('/api/brokers/schwab', { method: 'DELETE' }); toast('Schwab disconnected'); loadBanks(); }
    } catch (err) { toast(err.message, true); }
  });
  if (!s.connected) return;
  try {
    const accts = await api('/api/brokers/schwab/accounts');
    $('#sAccts').innerHTML = accts.map((a) => `<h3>${esc(a.type ?? 'Account')} <span class="muted mono">••${esc(a.mask)}</span></h3>
      <div class="stats">${stat('Account value', usd(a.equity))}${stat('Cash', usd(a.cash))}${stat('Buying power', usd(a.buyingPower))}</div>
      ${a.positions.length ? `<div class="scroll"><table><tr><th>Symbol</th><th>Type</th><th class="num">Qty</th><th class="num">Avg price</th><th class="num">Value</th><th class="num">Today</th></tr>
        ${a.positions.map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td>${esc(p.assetType)}</td><td class="num">${fmt(p.qty, 4)}</td><td class="num">${usd(p.avgPrice)}</td><td class="num">${usd(p.marketValue)}</td><td class="num ${cls(p.dayPl)}">${usd(p.dayPl)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No positions.</p>'}`).join('') || '<p class="muted">No accounts returned.</p>';
  } catch (e) { fail($('#sAccts'))(e); }
}

async function renderBankList() {
  const box = $('#bankList');
  let items;
  try { items = await api('/api/banks/accounts'); } catch (e) { return fail(box)(e); }
  const cash = items.flatMap((i) => (i.kind === 'bank' ? i.accounts : [])).filter((a) => a.type === 'depository').reduce((s, a) => s + (Number(a.current) || 0), 0);
  const debt = items.flatMap((i) => i.accounts).filter((a) => a.type === 'credit' || a.type === 'loan').reduce((s, a) => s + (Number(a.current) || 0), 0);
  const outside = items.flatMap((i) => i.holdings ?? []).reduce((s, h) => s + (Number(h.value) || 0), 0);
  let alpacaEq = null;
  if (status.alpaca) alpacaEq = await api('/api/account').then((r) => Number(r.account.equity)).catch(() => null);
  $('#nwStats').innerHTML = `${stat('Bank cash', usd(cash))}${stat('Outside brokerages', usd(outside))}${stat('StocksWorks (Alpaca)', usd(alpacaEq))}${stat('Credit & loans', usd(debt ? -debt : 0))}
    ${stat('Net worth (linked)', `<b>${usd(cash + outside + (alpacaEq ?? 0) - debt)}</b>`)}`;
  if (!items.length) { box.innerHTML = '<div class="card"><p class="muted">No institutions linked yet.</p></div>'; return; }
  box.innerHTML = items.map((i) => `<div class="card"><div class="row"><h3>${esc(i.institution)} <span class="pill">${esc(i.kind)}</span></h3>
      <button class="btn ghost" type="button" data-unlink="${esc(i.id)}">Unlink</button></div>
    ${i.error ? `<p class="err">${esc(i.error)} (you may need to unlink and re-link)</p>` : ''}
    ${i.accounts.length ? `<div class="scroll"><table><tr><th>Account</th><th>Type</th><th class="num">Balance</th><th class="num">Available</th><th></th></tr>
      ${i.accounts.map((a) => `<tr><td>${esc(a.name)} <span class="muted mono">••${esc(a.mask ?? '')}</span></td><td>${esc(a.subtype ?? a.type)}</td><td class="num">${usd(a.current)}</td><td class="num">${usd(a.available)}</td>
        <td>${i.kind === 'bank' && a.type === 'depository' ? `<button class="btn" type="button" data-reveal="${esc(i.id)}" data-acct="${esc(a.account_id)}">Show account &amp; routing</button>` : ''}</td></tr>
        <tr hidden data-numbers="${esc(a.account_id)}"><td colspan="5"></td></tr>`).join('')}</table></div>` : ''}
    ${i.holdings?.length ? `<h3>Holdings</h3><div class="scroll"><table><tr><th>Ticker</th><th>Security</th><th class="num">Quantity</th><th class="num">Value</th><th class="num">Cost basis</th><th class="num">Gain</th></tr>
      ${i.holdings.sort((x, y) => (y.value ?? 0) - (x.value ?? 0)).map((h) => `<tr><td><b>${esc(h.ticker ?? '—')}</b></td><td>${esc(h.name)}</td><td class="num">${fmt(h.quantity, 4)}</td><td class="num">${usd(h.value)}</td><td class="num">${usd(h.costBasis)}</td>
        <td class="num ${cls((h.value ?? 0) - (h.costBasis ?? 0))}">${h.costBasis ? pct(h.value / h.costBasis - 1) : '—'}</td></tr>`).join('')}</table></div>` : ''}</div>`).join('');
  $$('[data-unlink]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!b.dataset.force && !armed(b, 'Unlink?')) return;
    try {
      await api(`/api/banks?id=${encodeURIComponent(b.dataset.unlink)}${b.dataset.force ? '&force=1' : ''}`, { method: 'DELETE' });
      toast('Unlinked'); loadBanks();
    } catch (e) { toast(e.message, true); b.dataset.force = '1'; b.textContent = 'Force unlink'; }
  }));
  $$('[data-reveal]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/banks/numbers', { method: 'POST', body: { id: b.dataset.reveal, totp: $('#bankTotp')?.value ?? '' } });
      const n = r.ach.find((x) => x.account_id === b.dataset.acct);
      const row = $(`[data-numbers="${CSS.escape(b.dataset.acct)}"]`, box);
      row.firstElementChild.innerHTML = n ? `<span class="mono">Account ${esc(n.account)} · Routing (ACH) ${esc(n.routing)}${n.wire_routing ? ` · Wire routing ${esc(n.wire_routing)}` : ''}</span> <span class="muted tiny">hides in 60 s</span>`
        : '<span class="muted">This bank did not return numbers for this account.</span>';
      row.hidden = false;
      setTimeout(() => { row.hidden = true; row.firstElementChild.textContent = ''; }, 60_000);
      if ($('#bankTotp')) $('#bankTotp').value = '';
    } catch (e) { toast(e.message, true); }
  }));
}

// ---------------- boot ----------------
async function boot() {
  status = await api('/api/status');
  renderHeader();
  openTab(store.get('tab', 'overview'));
}
(async () => {
  try {
    const s = await api('/api/session');
    $('#totpRow').hidden = !s.totp;
    if (!s.authenticated) return showLogin();
    csrf = s.csrf;
    await boot();
  } catch (e) { toast(e.message, true); }
})();
