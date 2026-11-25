// StocksWorks Remote: the phone app. Talks to the desktop's phone listener (TLS, paired device + passphrase).
// Every dynamic value goes through esc() before reaching innerHTML.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }));
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const fmtHr = (h) => (!Number.isFinite(h) ? '' : h >= 1e6 ? `${(h / 1e6).toFixed(2)} MH/s` : h >= 1e3 ? `${(h / 1e3).toFixed(2)} kH/s` : `${h.toFixed(1)} H/s`);
const hm = (s) => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
const view = $('#rView');
let csrf = null, status = null, tab = 'home', timer = null;

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show ${bad ? 'bad' : ''}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000);
}
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Error ${r.status}`); e.status = r.status; e.unpaired = j.unpaired === true; throw e; }
  return j;
}
/** Two taps for anything consequential: first tap arms the button for 4 s. */
function armed(btn, label = 'Tap again to confirm') {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; return true; }
  const old = btn.textContent;
  btn.dataset.armed = '1'; btn.textContent = label; btn.classList.add('warn');
  setTimeout(() => { btn.dataset.armed = ''; btn.textContent = old; btn.classList.remove('warn'); }, 4000);
  return false;
}
const deviceName = () => { const u = navigator.userAgent; return /StocksWorksEmulator/.test(u) ? 'Phone emulator (this PC)' : /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android phone' : 'Phone'; };
const live = () => status?.mode === 'live';
const totpField = (label = 'Authenticator code') => `<label>${esc(label)}<input name="totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>`;

// ---------------- pairing & login ----------------
function showPair(msg = '') {
  $('#rNav').hidden = true; $('#rLock').hidden = true; $('#rMode').innerHTML = '';
  view.innerHTML = `<div class="card"><h2>Pair this phone</h2>
    <ol class="steps"><li>On your PC open StocksWorks → <b>Integrations → Phone remote</b> and turn phone access on.</li>
      <li>Press <b>Pair a phone</b> and scan the QR code with this phone's camera, or type the code below.</li>
      <li>Your browser may warn that the connection's certificate is not trusted: that's StocksWorks' own certificate. Compare the fingerprint shown on your PC, then continue.</li>
      <li>Then use <b>Share → Add to Home Screen</b> (iPhone) or <b>⋮ → Add to Home screen</b> (Android) to install the app.</li></ol>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <form id="pairForm"><label>Pairing code<input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24" placeholder="16 letters/digits"></label>
      <button class="btn primary big" type="submit">Pair</button></form></div>`;
  $('#pairForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/phone/pair', { method: 'POST', body: { code: e.target.code.value, name: deviceName() } }); toast('Phone paired'); boot(); } catch (err) { showPair(err.message); }
  });
}

function showLogin(needTotp, msg = '') {
  $('#rNav').hidden = true; $('#rLock').hidden = true;
  view.innerHTML = `<form id="loginForm" class="card"><h2>Unlock</h2>
    <label>Passphrase<input type="password" name="password" autocomplete="current-password" required></label>
    ${needTotp ? totpField() : ''}
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <button class="btn primary big" type="submit">Unlock</button></form>`;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/login', { method: 'POST', body: { password: e.target.password.value, totp: e.target.totp?.value ?? '' } });
      csrf = r.csrf; await startApp();
    } catch (err) { if (err.unpaired) return showPair(); showLogin(needTotp, err.message); }
  });
}

// ---------------- app shell ----------------
async function startApp() {
  status = await api('/api/status');
  $('#rNav').hidden = false; $('#rLock').hidden = false;
  open(tab);
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && !view.contains(document.activeElement)) open(tab, true); }, 30_000); // phone battery + data
}
function paintMode() {
  $('#rMode').innerHTML = `<span class="badge ${status.killSwitch ? 'halt' : esc(status.mode)}">${status.killSwitch ? 'HALTED' : esc(status.mode.toUpperCase())}</span>`;
}
async function open(name, quiet = false) {
  tab = name;
  view.onclick = view.onchange = null; // each tab installs its own handlers
  $$('#rNav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  if (!quiet) view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    status = await api('/api/status');
    paintMode();
    await TABS[name]();
  } catch (e) {
    if (e.unpaired) return showPair('This phone was removed on your PC. Pair it again.');
    if (e.status === 401) return showLogin(status?.totp);
    view.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}
$('#rNav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) open(b.dataset.tab); });
$('#rLock').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } catch { /* already out */ } csrf = null; clearInterval(timer); showLogin(status?.totp); });

// ---------------- Home: account, positions, orders, kill switch ----------------
async function home() {
  const halt = `<div class="card"><h3>Kill switch</h3>
    ${status.killSwitch ? `<p class="err">All trading is halted.</p><button class="btn big" type="button" data-kill="off">Resume trading</button>`
      : `<p class="muted">Stops all new orders and cancels open ones.</p><label class="check-row"><input type="checkbox" id="flatten"> Also close all positions</label>
        <button class="btn danger big" type="button" data-kill="on">Halt all trading</button>`}
    ${live() ? totpField('Authenticator code (live: needed to resume or to close all positions)') : ''}</div>`;
  if (!status.alpaca) { view.innerHTML = `${halt}<div class="card"><p class="muted">No broker connected on your PC yet.</p></div>`; return wireHome(); }
  const { account: a, positions, orders } = await api('/api/account');
  const dayPl = Number(a.equity) - Number(a.last_equity);
  const open = orders.filter((o) => ['new', 'accepted', 'partially_filled', 'held', 'pending_new'].includes(o.status));
  view.innerHTML = `<div class="card"><div class="muted tiny">Equity</div><div class="r-big">${usd(a.equity)}</div>
      <div class="${cls(dayPl)}">${dayPl >= 0 ? '+' : ''}${usd(dayPl)} today</div>
      <div class="r-kv"><span>Buying power</span><b>${usd(a.buying_power)}</b><span>Cash</span><b>${usd(a.cash)}</b></div></div>
    <div class="card"><h3>Positions</h3>${positions.length ? positions.map((p) => `<div class="r-row"><div><b>${esc(p.symbol)}</b><div class="muted tiny">${esc(p.qty)} @ ${usd(p.avg_entry_price)}</div></div>
        <div class="num"><div>${usd(p.market_value)}</div><div class="tiny ${cls(+p.unrealized_pl)}">${usd(p.unrealized_pl)}</div></div>
        <button class="btn ghost" type="button" data-close="${esc(p.symbol)}">Close</button></div>`).join('') : '<p class="muted">No open positions.</p>'}
      ${positions.length && live() ? totpField('Authenticator code (needed to close in live mode)') : ''}</div>
    ${open.length ? `<div class="card"><h3>Open orders</h3>${open.map((o) => `<div class="r-row"><div><b>${esc(o.symbol)}</b> <span class="muted tiny">${esc(o.side)} ${esc(o.qty ?? '$' + o.notional)} ${esc(o.type)}</span></div>
        <button class="btn ghost" type="button" data-cancel="${esc(o.id)}">Cancel</button></div>`).join('')}</div>` : ''}
    ${halt}`;
  wireHome();
}
function wireHome() {
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.kill && armed(b)) {
        const totp = $$('[name=totp]', view).map((i) => i.value.trim()).find(Boolean) ?? ''; // live: resume / close-all need a code
        await api('/api/kill', { method: 'POST', body: { on: b.dataset.kill === 'on', flatten: $('#flatten')?.checked === true, totp } });
        toast(b.dataset.kill === 'on' ? 'Trading halted' : 'Trading resumed'); open('home');
      }
      if (b.dataset.close && armed(b, 'Close all?')) {
        await api('/api/positions/close', { method: 'POST', body: { symbol: b.dataset.close, percentage: 100, totp: $('[name=totp]', view)?.value ?? '' } });
        toast(`Closing ${b.dataset.close}`); open('home');
      }
      if (b.dataset.cancel && armed(b, 'Cancel it?')) {
        await api(`/api/orders?id=${encodeURIComponent(b.dataset.cancel)}`, { method: 'DELETE' });
        toast('Order cancelled'); open('home');
      }
    } catch (err) { toast(err.message, true); }
  };
}

// ---------------- Trade: same risk gate as the desktop ticket ----------------
async function trade() {
  const schwab = status.schwab?.connected && status.schwab?.trading ? await api('/api/brokers/schwab/accounts').catch(() => []) : [];
  view.innerHTML = `<form id="rTicket" class="card" novalidate><h2>Order</h2>
    ${schwab.length ? `<label>Account<select name="acct"><option value="">Alpaca (${esc(status.mode)})</option>${schwab.filter((a) => a.hash).map((a) => `<option value="${esc(a.hash)}">Schwab ••${esc(a.mask)} (REAL MONEY)</option>`).join('')}</select></label>` : ''}
    <label>Symbol<input name="symbol" autocapitalize="characters" autocomplete="off" placeholder="AAPL or BTC/USD"></label>
    <div class="seg r-seg" data-k="side"><button type="button" data-v="buy" class="on">Buy</button><button type="button" data-v="sell">Sell</button></div>
    <div class="seg r-seg" data-k="type"><button type="button" data-v="market" class="on">Market</button><button type="button" data-v="limit">Limit</button></div>
    <label>Quantity<input name="qty" inputmode="decimal"></label>
    <label data-lp hidden>Limit price<input name="limit_price" inputmode="decimal"></label>
    <div data-live hidden>${totpField('Authenticator code (live order)')}<label class="check-row"><input type="checkbox" name="confirm"> I confirm this is a REAL-MONEY order</label></div>
    <button class="btn big" type="button" id="rCheck">Check risk</button><button class="btn primary big" type="submit" id="rPlace" disabled>Place order</button>
    <div id="rOut"></div></form>`;
  const f = $('#rTicket'), t = { side: 'buy', type: 'market' };
  let token = null, checkedFor = null;
  const order = () => ({ symbol: f.symbol.value.trim().toUpperCase(), side: t.side, type: t.type, qty: f.qty.value.trim(),
    ...(t.type === 'limit' ? { limit_price: f.limit_price.value.trim() } : {}), ...(f.acct?.value ? { broker: 'schwab', account: f.acct.value } : {}) });
  const isLive = () => live() || Boolean(f.acct?.value);
  const sync = () => {
    $('[data-lp]', f).hidden = t.type !== 'limit';
    $('[data-live]', f).hidden = !isLive();
    const fresh = checkedFor === JSON.stringify(order());
    $('#rPlace').disabled = !fresh || (isLive() && (!token || !f.confirm.checked || !/^\d{6}$/.test(f.totp.value)));
  };
  $$('.r-seg', f).forEach((s) => s.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    t[s.dataset.k] = b.dataset.v; $$('button', s).forEach((x) => x.classList.toggle('on', x === b)); sync();
  }));
  f.addEventListener('input', sync); f.addEventListener('change', sync);
  $('#rCheck').addEventListener('click', async () => {
    try {
      const o = order(), r = await api('/api/orders/preview', { method: 'POST', body: o });
      token = r.confirmToken; checkedFor = r.ok ? JSON.stringify(o) : null;
      $('#rOut').innerHTML = `<p>Price ${usd(r.price)} · Est. ${usd(r.notional)}</p><ul class="checks">${r.errors.length ? r.errors.map((x) => `<li class="bad">${esc(x)}</li>`).join('') : '<li>All risk checks passed</li>'}</ul>`;
    } catch (e) { $('#rOut').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    sync();
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#rPlace').disabled = true;
    try {
      const o = await api('/api/orders', { method: 'POST', body: { ...order(), confirmToken: token, ...(isLive() ? { totp: f.totp.value } : {}) } });
      $('#rOut').innerHTML = `<p class="up">Order sent: ${esc(o.side)} ${esc(o.qty)} ${esc(o.symbol)} (${esc(o.status)})</p>`;
      toast('Order sent'); f.qty.value = '';
    } catch (err) { $('#rOut').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    token = null; checkedFor = null; if (f.totp) f.totp.value = ''; sync();
  });
}

// ---------------- Mining: this PC's programs + remote rigs ----------------
async function mining() {
  const [wl, fleet] = await Promise.all([api('/api/desktop/workloads').catch((e) => ({ error: e.message })), api('/api/fleet').catch(() => null)]);
  const pcCard = wl.error ? `<div class="card"><h3>This PC</h3><p class="muted">${esc(wl.error)}</p></div>`
    : `<div class="card"><div class="bar"><h3>This PC</h3><span class="spacer"></span>${wl.some((w) => w.enabled) ? '<button class="btn ghost" type="button" data-pause>Pause all</button>' : ''}</div>
      ${wl.length ? wl.map((w) => `<div class="r-row"><div><b>${esc(w.name)}</b><div class="muted tiny">${esc(w.category === 'share' ? 'Compute share' : 'Miner')} · ${esc(w.running ? `Running ${fmtHr(w.hashrate)}` : w.reason || 'Off')} · today ${hm(w.ranTodaySec)}</div>
          ${w.error ? `<div class="err tiny">${esc(w.error)}</div>` : ''}</div>
          <label class="r-switch"><input type="checkbox" data-wl="${esc(w.id)}" ${w.enabled ? 'checked' : ''}><span></span></label></div>`).join('')
        : '<p class="muted">Nothing set up. Add miners or sharing programs on your PC (Mining tab / Compute Share); you can switch them on and off here.</p>'}</div>`;
  const rigs = fleet?.rigs ?? [];
  const rigCard = fleet?.enabled ? `<div class="card"><div class="bar"><h3>Remote rigs</h3><span class="spacer"></span>
      <button class="btn ghost" type="button" data-fleet="run">Run all</button><button class="btn ghost" type="button" data-fleet="stop">Stop all</button></div>
      ${rigs.length ? rigs.map((r) => `<div class="r-row"><div><b>${esc(r.name)}</b><div class="muted tiny">${r.online ? `online · ${esc(r.stats?.running ? fmtHr(r.stats.hashrate) || 'mining' : 'idle')}` : 'offline'}</div></div>
        <label class="r-switch"><input type="checkbox" data-rig="${esc(r.id)}" ${r.desired === 'run' ? 'checked' : ''}><span></span></label></div>`).join('') : '<p class="muted">No rigs linked.</p>'}</div>` : '';
  view.innerHTML = pcCard + rigCard;
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    try {
      if (b?.dataset.pause !== undefined && b && armed(b)) { await api('/api/desktop/workloads/pause-all', { method: 'POST' }); toast('All paused'); open('mining', true); }
      if (b?.dataset.fleet) { await api('/api/fleet/command', { method: 'POST', body: { rigId: 'all', desired: b.dataset.fleet } }); toast(`Rigs: ${b.dataset.fleet}`); open('mining', true); }
    } catch (err) { toast(err.message, true); }
  };
  view.onchange = async (e) => {
    const i = e.target;
    try {
      if (i.dataset.wl) { await api('/api/desktop/workloads/toggle', { method: 'POST', body: { id: i.dataset.wl, on: i.checked } }); toast(i.checked ? 'Switched on' : 'Switched off'); }
      if (i.dataset.rig) { await api('/api/fleet/command', { method: 'POST', body: { rigId: i.dataset.rig, desired: i.checked ? 'run' : 'stop' } }); toast(i.checked ? 'Rig running' : 'Rig stopped'); }
      i.blur(); setTimeout(() => open('mining', true), 1500);
    } catch (err) { i.checked = !i.checked; toast(err.message, true); }
  };
}

// ---------------- Alerts ----------------
async function alerts() {
  const a = await api('/api/alerts');
  view.innerHTML = `<div class="card"><h3>Recent alerts</h3>${a.events.length ? a.events.slice(0, 40).map((x) => `<div class="r-row"><div>${esc(x.text)}<div class="muted tiny">${esc(new Date(x.at).toLocaleString())}</div></div></div>`).join('') : '<p class="muted">No alerts have fired yet.</p>'}
    <p class="muted tiny">${a.alerts.filter((x) => x.armed).length} armed. Create alerts on your PC (Alerts tab).</p></div>`;
}
// ---------------- Auto: what runs when (Focus) + scheduled tasks ----------------
const ago = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
async function auto() {
  const a = await api('/api/autopilot');
  const acts = Object.entries(a.activities);
  const tradeWord = a.trading.mode === 'live' ? 'REAL MONEY' : 'paper';
  const needsCode = (id) => a.trading.mode === 'live' && a.tasks.find((t) => t.id === id)?.action === 'trade';
  const code = () => $('[name=totp]', view)?.value ?? '';
  view.innerHTML = `<div class="card"><h3>What runs now</h3>
      <p class="muted tiny">${a.focus.mode === 'schedule' ? 'Following your time slots (set on the PC). Outside a slot, the ticks below apply.' : 'Manual: tick what may run.'}</p>
      ${acts.map(([id, label]) => `<label class="r-row r-check"><span>${esc(label)}${a.allowedNow.includes(id) ? ' <span class="up tiny">● now</span>' : ''}</span>
        <span class="r-switch"><input type="checkbox" data-act="${esc(id)}" ${a.focus.manual.includes(id) ? 'checked' : ''}><span></span></span></label>`).join('')}
      ${a.focus.mode === 'schedule' ? '<button class="btn ghost" type="button" data-manual>Use the manual list now</button>' : a.focus.slots.length ? '<button class="btn ghost" type="button" data-sched>Back to my time slots</button>' : ''}</div>
    <div class="card"><h3>Tasks</h3><p class="muted tiny">Orders go to your ${esc(tradeWord)} account through every risk limit and the kill switch${a.trading.mode === 'live' && !a.trading.liveAllowed ? ' (live auto-trading is off on the PC)' : ''}. Create and edit tasks on the PC.</p>
      ${a.tasks.length ? a.tasks.map((t) => `<div class="r-row"><div><b>${esc(t.name)}</b><div class="muted tiny">${esc(a.kinds[t.kind]?.label.split(':')[0] ?? t.kind)}${t.action ? ` · ${t.action === 'trade' ? `places ${esc(tradeWord)} orders` : 'alerts only'}` : ''} · last ${esc(ago(t.lastRunAt))}</div>
          ${t.lastResult ? `<div class="tiny">${esc(t.lastResult)}</div>` : ''}</div>
          <div class="r-col"><label class="r-switch"><input type="checkbox" data-task="${esc(t.id)}" ${t.enabled ? 'checked' : ''}><span></span></label>
          <button class="btn ghost" type="button" data-run="${esc(t.id)}">Run</button></div></div>`).join('') : '<p class="muted">No tasks yet. Add them on your PC (Autopilot tab).</p>'}
      ${a.tasks.some((t) => needsCode(t.id)) ? totpField('Authenticator code (to switch on or run a real-money task)') : ''}</div>
    <div class="card"><h3>Recent activity</h3>${a.events.length ? a.events.slice(0, 15).map((e) => `<div class="r-row"><div class="tiny">${esc(e.text)}<div class="muted">${esc(ago(e.at))}</div></div></div>`).join('') : '<p class="muted">Nothing has run yet.</p>'}</div>`;
  const setFocus = async (focus) => { await api('/api/autopilot/focus', { method: 'POST', body: focus }); toast('Updated'); open('auto', true); };
  view.onchange = async (e) => {
    const i = e.target;
    try {
      if (i.dataset.act) await setFocus({ ...a.focus, manual: $$('[data-act]', view).filter((x) => x.checked).map((x) => x.dataset.act) });
      if (i.dataset.task) { await api('/api/autopilot/tasks/toggle', { method: 'POST', body: { id: i.dataset.task, on: i.checked, ...(needsCode(i.dataset.task) ? { totp: code() } : {}) } }); toast(i.checked ? 'Task on' : 'Task off'); }
    } catch (err) { i.checked = !i.checked; toast(err.message, true); }
  };
  view.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.manual !== undefined) await setFocus({ ...a.focus, mode: 'manual' });
      if (b.dataset.sched !== undefined) await setFocus({ ...a.focus, mode: 'schedule' });
      if (b.dataset.run && armed(b, 'Run now?')) { b.disabled = true; toast('Running…'); const r = await api('/api/autopilot/tasks/run', { method: 'POST', body: { id: b.dataset.run, ...(needsCode(b.dataset.run) ? { totp: code() } : {}) } }); toast(r.result.slice(0, 140)); open('auto', true); }
    } catch (err) { toast(err.message, true); }
  };
}

// ---------------- Markets: scanner, AI analysis, crypto, wallets ----------------
async function markets() {
  const [scan, cg, wallets] = await Promise.all([
    status.alpaca ? api('/api/scan').catch((e) => ({ error: e.message })) : { error: 'No broker connected on your PC (market data comes from Alpaca).' },
    api('/api/crypto/markets').catch(() => []), api('/api/wallets').catch(() => [])]);
  const total = wallets.reduce((s, w) => s + (w.usd ?? 0), 0);
  view.innerHTML = `<div class="card"><h3>AI scanner</h3>${scan.error ? `<p class="muted">${esc(scan.error)}</p>` : scan.slice(0, 15).map((r) => `<div class="r-row"><div><b>${esc(r.symbol)}</b><div class="muted tiny">${r.score == null ? esc(r.error ?? '') : `score ${esc(r.score)}${r.label ? ` · ${esc(r.label)}` : ''}`}</div></div>
        ${r.score == null ? '' : `<button class="btn ghost" type="button" data-ai="${esc(r.symbol)}">AI</button>`}</div>`).join('')}<div id="rAi"></div></div>
    <div class="card"><h3>Crypto</h3>${(Array.isArray(cg) ? cg : []).slice(0, 12).map((c) => `<div class="r-row"><div><b>${esc(String(c.symbol).toUpperCase())}</b> <span class="muted tiny">${esc(c.name)}</span></div>
        <div class="num"><div>${usd(c.current_price)}</div><div class="tiny ${cls(c.price_change_percentage_24h)}">${Number(c.price_change_percentage_24h ?? 0).toFixed(2)}%</div></div></div>`).join('') || '<p class="muted">Unavailable.</p>'}</div>
    <div class="card"><h3>Wallets${total ? ` · ${usd(total)}` : ''}</h3>${wallets.length ? wallets.map((w) => `<div class="r-row"><div><b>${esc(w.label || w.chain.toUpperCase())}</b><div class="muted tiny">${esc(w.chain)} · ${esc(w.address.slice(0, 8))}…${esc(w.address.slice(-6))}</div></div>
        <div class="num"><div>${w.balance == null ? `<span class="err tiny">${esc(w.error ?? '—')}</span>` : `${esc(Number(w.balance).toLocaleString(undefined, { maximumFractionDigits: 6 }))} ${esc(w.symbol)}`}</div><div class="tiny muted">${w.usd == null ? '' : usd(w.usd)}</div></div></div>`).join('') : '<p class="muted">Watch wallets on your PC (Crypto &amp; Wallet tab).</p>'}</div>`;
  view.onclick = async (e) => {
    const b = e.target.closest('button[data-ai]'); if (!b) return;
    b.disabled = true; $('#rAi').innerHTML = `<p class="muted">Analyzing ${esc(b.dataset.ai)}…</p>`;
    try {
      const r = await api('/api/ai/analyze', { method: 'POST', body: { symbol: b.dataset.ai } });
      $('#rAi').innerHTML = `<div class="r-ai"><b>${esc(b.dataset.ai)}: ${esc(r.stance)} (${esc(r.confidence)}%)</b><p>${esc(r.thesis)}</p>
        <p class="tiny muted">Entry ${esc(r.entry ?? '—')} · stop ${esc(r.stop ?? '—')} · target ${esc(r.target ?? '—')}</p><p class="tiny">${esc(r.lesson)}</p>
        ${(r.checks ?? []).map((c) => `<div class="tiny ${c.status === 'contradicted' ? 'err' : 'muted'}">${c.status === 'verified' ? '✓' : c.status === 'contradicted' ? '✗' : '?'} ${esc(c.check)}: ${esc(c.evidence)}</div>`).join('')}</div>`;
    } catch (err) { $('#rAi').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    b.disabled = false;
  };
}

// ---------------- More: research (Finviz, Messari, Invo traders), teach the AI, alerts ----------------
async function more() {
  const [src, tr] = await Promise.all([api('/api/research/sources'), api('/api/research/traders')]);
  view.innerHTML = `<div class="card"><h3>Research</h3>
      <div class="seg r-seg" id="rSrc"><button type="button" data-src="finviz" class="on">Finviz</button><button type="button" data-src="news">Messari news</button><button type="button" data-src="traders">Invo traders</button></div>
      <div id="rRes"></div></div>
    <div class="card"><h3>Dossier &amp; fact check</h3>
      <form id="rDos" class="r-chips"><input name="s" placeholder="AAPL or BTC/USD" autocapitalize="characters" autocomplete="off"><button class="btn" type="submit">Dossier</button></form><div id="rDosOut"></div>
      <textarea id="rClaim" rows="2" maxlength="1000" placeholder="A claim to fact-check, e.g. Bitcoin's supply is capped at 21 million"></textarea><button class="btn" type="button" data-fc>Fact-check</button><div id="rFcOut"></div></div>
    <div class="card"><h3>Teach the AI</h3><p class="muted tiny">Goes into the AI Lab training corpus (${esc(Math.round(src.corpusChars / 1000))}k chars taught so far).</p>
      <textarea id="rNote" rows="3" maxlength="20000" placeholder="A lesson, a trade idea, a rule you follow…"></textarea><button class="btn" type="button" data-note>Add note</button></div>
    <div id="rAlerts"></div>`;
  const res = $('#rRes');
  const show = async (which) => {
    $$('#rSrc button').forEach((x) => x.classList.toggle('on', x.dataset.src === which));
    res.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (which === 'finviz') {
        if (!src.finviz.configured) { res.innerHTML = '<p class="muted">Add your Finviz Elite token on the PC (FINVIZ_AUTH_TOKEN).</p>'; return; }
        const presets = { 'Large-cap tech': 'cap_large,sec_technology', Oversold: 'ta_rsi_os30,sh_avgvol_o500', 'Unusual volume': 'sh_relvol_o2', 'New highs': 'ta_highlow52w_nh' };
        res.innerHTML = `<div class="r-chips">${Object.entries(presets).map(([k, f]) => `<button class="btn ghost" type="button" data-fv="${esc(f)}">${esc(k)}</button>`).join('')}</div><div id="rFv"></div>`;
      } else if (which === 'news') {
        if (!src.messari.configured) { res.innerHTML = '<p class="muted">Add your Messari API key on the PC (MESSARI_API_KEY).</p>'; return; }
        const { items } = await api('/api/research/messari/news');
        res.innerHTML = `${items.slice(0, 20).map((n) => `<div class="r-row"><div><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><div class="muted tiny">${esc(n.source)} · ${esc(n.assets.join(', '))}</div></div></div>`).join('') || '<p class="muted">No news.</p>'}
          <button class="btn" type="button" data-learn="messari-news">Teach the AI this news</button>`;
      } else {
        res.innerHTML = tr.traders.length ? tr.traders.map((t) => `<div class="r-row"><div><b>${esc(t.label || t.address.slice(0, 10))}</b><div class="muted tiny">${esc(t.address.slice(0, 10))}…</div></div>
            <button class="btn ghost" type="button" data-trader="${esc(t.address)}">View</button></div>`).join('') + '<div id="rTr"></div>'
          : '<p class="muted">Follow Invo traders on your PC (Research tab): paste the 0x address from their Invo profile.</p>';
      }
    } catch (e) { res.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  view.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.src) show(b.dataset.src);
      if (b.dataset.fv) {
        const { rows } = await api(`/api/research/finviz?f=${encodeURIComponent(b.dataset.fv)}`);
        $('#rFv').innerHTML = rows.slice(0, 25).map((r) => `<div class="r-row"><div><b>${esc(r.ticker)}</b><div class="muted tiny">${esc(r.company)} · ${esc(r.sector)}</div></div>
          <div class="num"><div>${usd(r.price)}</div><div class="tiny ${cls(r.changePct)}">${esc(r.changePct ?? '—')}%</div></div></div>`).join('') + `<button class="btn" type="button" data-learn="finviz" data-f="${esc(b.dataset.fv)}">Teach the AI this screen</button>`;
      }
      if (b.dataset.trader) {
        const t = await api(`/api/research/trader?address=${encodeURIComponent(b.dataset.trader)}`);
        $('#rTr').innerHTML = `<div class="r-ai"><p><b>${esc(t.style)}</b></p><p class="tiny">Account ${usd(t.accountValue)} · realized ${usd(t.fills.realizedPnl)}</p>
          ${t.positions.map((p) => `<div class="tiny">${esc(p.side)} ${esc(p.size)} ${esc(p.coin)} @ ${esc(p.entryPx)} · ${esc(p.leverage ?? '?')}x · <span class="${cls(p.unrealizedPnl)}">${usd(p.unrealizedPnl)}</span></div>`).join('')}
          <button class="btn" type="button" data-learn="trader" data-addr="${esc(t.address)}">Teach the AI this trader's style</button></div>`;
      }
      if (b.dataset.learn) {
        const body = { source: b.dataset.learn, ...(b.dataset.f ? { f: b.dataset.f } : {}), ...(b.dataset.addr ? { address: b.dataset.addr } : {}), ...(b.dataset.sym ? { symbol: b.dataset.sym } : {}) };
        const r = await api('/api/research/learn', { method: 'POST', body }); toast(`Taught the AI ${r.added} chars`);
      }
      if (b.dataset.fc !== undefined) {
        const claim = $('#rClaim').value.trim(); if (!claim) return;
        b.disabled = true; $('#rFcOut').innerHTML = '<p class="muted">Checking sources…</p>';
        try {
          const r = await api('/api/factcheck', { method: 'POST', body: { claim } });
          $('#rFcOut').innerHTML = `<div class="r-ai"><b class="${r.verdict === 'refuted' ? 'err' : r.verdict === 'supported' ? 'up' : ''}">${esc(r.verdict.toUpperCase())}</b> <span class="tiny muted">${esc(r.confidence)}%</span><p class="tiny">${esc(r.explanation)}</p>
            ${r.note ? `<p class="tiny muted">${esc(r.note)}</p>` : ''}${r.sources.map((x) => /^https?:\/\//.test(x.url) ? `<div class="tiny"><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || x.url)}</a></div>` : '').join('')}</div>`;
        } finally { b.disabled = false; }
      }
      if (b.dataset.note !== undefined) {
        const text = $('#rNote').value.trim(); if (!text) return;
        const r = await api('/api/research/learn', { method: 'POST', body: { source: 'note', text } }); $('#rNote').value = ''; toast(`Taught the AI ${r.added} chars`);
      }
    } catch (err) { toast(err.message, true); }
  };
  $('#rDos').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = e.target.s.value.trim().toUpperCase(); if (!s) return;
    const out = $('#rDosOut'); out.innerHTML = '<p class="muted">Gathering…</p>';
    try {
      const d = await api(`/api/intel?s=${encodeURIComponent(s)}`);
      const f = d.edgar?.facts, ag = d.agreement;
      out.innerHTML = `<div class="r-ai"><b>${esc(d.symbol)} ${d.price != null ? usd(d.price) : ''}</b>
        <div class="tiny ${ag.status === 'disagree' ? 'err' : 'muted'}">${ag.status === 'agree' ? `prices agree (${esc(ag.sources.join(', '))})` : ag.status === 'disagree' ? `prices DISAGREE: ${esc(ag.outliers.join(', '))}` : esc(ag.status)}</div>
        ${d.signal ? `<div class="tiny">Score ${esc(d.signal.score)}/100</div>` : ''}
        ${f?.revenue?.annual ? `<div class="tiny">${esc(d.edgar.name)}: revenue ${usd(f.revenue.annual.val)}${f.revenueGrowthPct != null ? ` (${esc(f.revenueGrowthPct)}% y/y)` : ''}</div>` : ''}
        ${d.coin ? `<div class="tiny">${esc(d.coin.name)} #${esc(d.coin.rank)} · 24h ${esc(Number(d.coin.change24hPct ?? 0).toFixed(2))}%</div>` : ''}
        ${d.defi ? `<div class="tiny">DeFi TVL ${usd(d.defi.tvlUsd)}</div>` : ''}
        ${d.sentiment ? `<div class="tiny">Fear &amp; Greed ${esc(d.sentiment.value)} (${esc(d.sentiment.label)})</div>` : ''}
        ${d.news.slice(0, 5).map((n) => `<div class="tiny">• ${esc(n.title)}</div>`).join('')}
        <button class="btn" type="button" data-learn="dossier" data-sym="${esc(d.symbol)}">Teach the AI this dossier</button></div>`;
    } catch (err) { out.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
  show('finviz');
  const a = await api('/api/alerts').catch(() => null);
  if (a && tab === 'more') $('#rAlerts').innerHTML = `<div class="card"><h3>Recent alerts</h3>${a.events.length ? a.events.slice(0, 20).map((x) => `<div class="r-row"><div>${esc(x.text)}<div class="muted tiny">${esc(new Date(x.at).toLocaleString())}</div></div></div>`).join('') : '<p class="muted">No alerts have fired yet.</p>'}</div>`;
}

const TABS = { home, trade, auto, markets, mining, more, alerts };

// ---------------- boot ----------------
async function boot() {
  const code = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (code) {
    history.replaceState(null, '', location.pathname); // the code is one-time; don't leave it in history
    try { await api('/phone/pair', { method: 'POST', body: { code, name: deviceName() } }); toast('Phone paired'); } catch (e) { return showPair(e.message); }
  }
  let s;
  try { s = await api('/api/session'); } catch (e) { return e.unpaired ? showPair() : (view.innerHTML = `<div class="card err">${esc(e.message)}</div>`); }
  status = { totp: s.totp };
  if (!s.authenticated) return showLogin(s.totp);
  csrf = s.csrf;
  try { await startApp(); } catch (e) { toast(e.message, true); }
}
boot();
