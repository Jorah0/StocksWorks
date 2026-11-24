// StocksWorks frontend. No frameworks; every dynamic value goes through esc() before reaching innerHTML.
import { sma } from '/lib/signals.js';
import { miningProfit } from '/lib/mining.js';
import { isValidEthAddress } from '/lib/keccak.js';
import { LESSONS, COMPARE, COMPARE_COLS, COMPARE_SOURCES, LINKS } from '/content.js';

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
const loaders = { overview: loadOverview, scanner: loadScanner, trade: loadTrade, crypto: loadCrypto, mining: loadMining, academy: loadAcademy, compare: loadCompare, integrations: loadIntegrations };
function openTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  store.set('tab', name);
  loaders[name]();
}
$('.tabs').addEventListener('click', (e) => { const t = e.target.closest('button[data-tab]'); if (t) openTab(t.dataset.tab); });

const needAlpaca = () => (status.alpaca ? '' : `<div class="notice">Broker not connected. Add free Alpaca paper keys to <code>.env</code> (see Integrations) to enable quotes, the scanner and trading.</div>`);

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
  const t = { side: 'buy', type: 'market', sizing: 'qty', ...store.get('ticket', {}) };
  const live = status.mode === 'live';
  const L = status.limits ?? {};
  el.innerHTML = `${needAlpaca()}<div class="grid two"><form id="ticket" class="card" novalidate>
    <h2>Order ticket <span class="badge ${esc(status.mode)}">${esc(status.mode?.toUpperCase())}</span></h2>
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
    ${live ? '<div class="row"><label>Authenticator code (required for live orders)<input name="totp" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code"></label><label class="row"><span><input type="checkbox" name="confirm"> I confirm this is a REAL-MONEY order</span></label></div>' : ''}
    <div class="row"><button class="btn" type="button" id="previewBtn">Check risk</button><button class="btn primary" type="submit" id="placeBtn">Place order</button></div>
    ${live ? '<p class="muted tiny">Live mode: "Place order" unlocks only after a passing risk check, for that exact order, for 2 minutes.</p>' : ''}
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
    return o;
  };
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
      const r = await preview({ symbol: f.symbol.value.trim().toUpperCase(), side: 'buy', type: 'market', qty: '1' });
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
      const o = await api('/api/orders', { method: 'POST', body: { ...order(), confirmToken, ...(live ? { totp: f.totp.value } : {}) } });
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
  api('/api/wallets').then(renderWallets).catch(fail($('#wList')));
  $('#wForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/wallets', { method: 'POST', body: { chain: e.target.chain.value, address: e.target.address.value.trim(), label: e.target.label.value } }); e.target.reset(); renderWallets(await api('/api/wallets')); } catch (err) { toast(err.message, true); }
  });
  $('#connectBtn').addEventListener('click', connectWallet);
}
async function connectWallet() {
  const box = $('#w3');
  const eth = window.ethereum;
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
      <td class="num">${esc(fmtHr(r.stats?.hashrate))}</td><td>${esc(fmtUp(r.stats?.uptimeSec))}</td>
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
  el.innerHTML = `<div class="grid two"><div class="card"><h2>Connections</h2><ul class="checks">
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
    const { entries, valid } = await api('/api/audit');
    $('#auditValid').innerHTML = valid ? '<span class="pill bullish">hash chain intact</span>' : '<span class="pill bearish">CHAIN BROKEN: log was modified</span>';
    $('#audit').innerHTML = entries.length ? `<table><tr><th>Time (UTC)</th><th>Event</th><th>Detail</th></tr>${entries.map(({ ts, type, prev, hash, ...rest }) => `<tr><td class="mono">${esc(ts.replace('T', ' ').slice(0, 19))}</td><td>${esc(type)}</td><td class="mono muted">${esc(JSON.stringify(rest).slice(0, 160))}</td></tr>`).join('')}</table>` : '<p class="muted">No events yet.</p>';
  } catch (e) { fail($('#audit'))(e); }
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
