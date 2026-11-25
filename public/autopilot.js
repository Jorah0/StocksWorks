// Autopilot tab: "what runs when" (focus), scheduled tasks (track / trade / DCA / learn), recent events.
// Orders placed by tasks go through the server's risk limits and kill switch. Every dynamic value goes through esc().

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** Client copy of the focus rule so the "Allowed right now" line follows the form before it's saved. */
export function allowedAt(focus, now = new Date()) {
  if (focus.mode !== 'schedule') return [...new Set(focus.manual)];
  const t = now.getHours() * 60 + now.getMinutes(), d = now.getDay(), yd = (d + 6) % 7;
  const hit = focus.slots.filter((s) => {
    const a = mins(s.start), b = mins(s.end);
    if (a === b) return s.days.includes(d);
    return a < b ? s.days.includes(d) && t >= a && t < b : (s.days.includes(d) && t >= a) || (s.days.includes(yd) && t < b);
  });
  return hit.length ? [...new Set(hit.flatMap((s) => s.allow))] : [...new Set(focus.manual)]; // no slot: manual list
}

export function mountAutopilot(tab, { api, esc, toast }) {
  const el = document.createElement('div'); // fresh root per mount, so re-opening the tab doesn't stack listeners
  tab.replaceChildren(el);
  const $ = (s) => el.querySelector(s);
  let D = null;
  const checks = (name, ids, on, labels) => ids.map((id) => `<label class="check-row"><input type="checkbox" name="${esc(name)}" value="${esc(id)}" ${on.includes(id) ? 'checked' : ''}> ${esc(labels[id] ?? id)}</label>`).join('');
  const dayChecks = (name, on) => DAYS.map((d, i) => `<label class="check-row"><input type="checkbox" name="${esc(name)}" value="${i}" ${on.includes(i) ? 'checked' : ''}> ${d}</label>`).join('');
  const picked = (root, name) => [...root.querySelectorAll(`[name="${name}"]:checked`)].map((x) => x.value);
  const live = () => D.trading.mode === 'live';
  const tradeLabel = () => (live() ? 'Place orders (REAL MONEY)' : 'Place orders (paper account)');
  const liveBlocked = () => live() && !D.trading.liveAllowed;
  const ackWarn = '<p class="notice">Live auto-trading is off: it needs <code>AUTOPILOT_LIVE_ACK=I_ACCEPT_REAL_MONEY_RISK</code> in <code>.env</code>. Until then this task only alerts.</p>';

  el.innerHTML = '<div class="empty">Loading…</div>';
  const load = () => api('/api/autopilot').then(render).catch((e) => { el.innerHTML = `<div class="card err">${esc(e.message)}</div>`; });
  const after = async (p) => { const r = await p; render(r?.tasks ? r : await api('/api/autopilot')); };

  function render(d) {
    D = d;
    el.innerHTML = `<div class="card"><div class="bar"><h2>Autopilot</h2>
        <span class="badge ${D.killSwitch ? 'halt' : D.trading.mode}">${D.killSwitch ? 'HALTED' : live() ? 'LIVE • REAL MONEY' : 'PAPER'}</span>
        <span class="spacer"></span><button class="btn ghost" type="button" data-refresh>Refresh</button></div>
      <p class="muted">Runs your tasks on a schedule. Every order a task places goes through the app's risk limits and the kill switch, exactly like a manual order.
        ${live() ? (D.trading.liveAllowed ? '<b class="down">Trading is LIVE: tasks set to place orders use real money.</b>' : '<b class="warn">Trading is LIVE but auto-trading real money is not acknowledged, so trade tasks only alert.</b>') : 'Trading is in paper mode: no real money is at risk.'}
        ${D.killSwitch ? ' <b class="down">The kill switch is on: no task can place orders.</b>' : ''}</p>
      ${live() && D.trading.liveAllowed ? '<label>Authenticator code (needed to save, switch on or run a task that places REAL-MONEY orders)<input id="apTotp" class="totp-mini" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>' : ''}</div>
      <div class="grid two"><form id="apFocus" class="card"></form><div class="card"><div class="bar"><h2>Tasks</h2><span class="spacer"></span><button class="btn primary" type="button" data-add>+ Add task</button></div>
        <div id="apTasks"></div></div></div>
      <form id="apForm" class="card" hidden novalidate></form>
      <div class="card"><h2>Recent events</h2><div id="apEvents"></div></div>`;
    paintFocus(D.focus);
    paintTasks();
    const names = Object.fromEntries(D.tasks.map((t) => [t.id, t.name]));
    $('#apEvents').innerHTML = D.events.length ? `<ul class="feed">${D.events.map((e) => `<li><span class="mono tiny muted">${esc(new Date(e.at).toLocaleString())}</span>
      <b>${esc(names[e.taskId] ?? e.taskId ?? '')}</b> ${esc(e.text)}</li>`).join('')}</ul>` : '<p class="muted">Nothing has run yet.</p>';
  }

  // ---------------- focus ----------------
  const acts = () => Object.keys(D.activities);
  const slotRow = (s) => `<fieldset class="ap-slot"><div class="row wl-days">${dayChecks('sday', s.days)}</div>
      <div class="row"><label>From<input type="time" name="sstart" value="${esc(s.start)}"></label><label>Until<input type="time" name="send" value="${esc(s.end)}"></label>
        <button class="btn ghost" type="button" data-delslot>Remove</button></div>
      <div class="row wl-days">${checks('sallow', acts(), s.allow, D.activities)}</div></fieldset>`;
  function paintFocus(f) {
    const box = $('#apFocus');
    box.innerHTML = `<h2>What runs when</h2>
      <div class="row"><label class="check-row"><input type="radio" name="mode" value="manual" ${f.mode === 'schedule' ? '' : 'checked'}> Pick by hand</label>
        <label class="check-row"><input type="radio" name="mode" value="schedule" ${f.mode === 'schedule' ? 'checked' : ''}> By time of day</label></div>
      <div data-manual><p class="muted tiny">${f.mode === 'schedule' ? 'Used when no time slot matches.' : 'These activities may run now.'}</p><div class="row wl-days">${checks('manual', acts(), f.manual, D.activities)}</div></div>
      <div data-slots>${f.slots.map(slotRow).join('')}<button class="btn ghost" type="button" data-addslot>+ Add time slot</button>
        <p class="muted tiny">An end earlier than the start runs overnight (22:00 until 07:00). Outside every slot, the hand-picked list above applies.</p></div>
      <p>Allowed right now: <b id="apNow"></b></p>
      <button class="btn primary" type="submit">Save</button>`;
    syncFocus();
  }
  const readFocus = () => {
    const box = $('#apFocus');
    return {
      mode: box.querySelector('[name=mode]:checked').value, manual: picked(box, 'manual'),
      slots: [...box.querySelectorAll('.ap-slot')].map((s) => ({ days: picked(s, 'sday').map(Number), start: s.querySelector('[name=sstart]').value, end: s.querySelector('[name=send]').value, allow: picked(s, 'sallow') })),
    };
  };
  function syncFocus() {
    const f = readFocus();
    $('#apFocus [data-slots]').hidden = f.mode !== 'schedule';
    const now = allowedAt(f);
    $('#apNow').textContent = now.length ? now.map((a) => D.activities[a] ?? a).join(', ') : 'nothing';
  }

  // ---------------- tasks ----------------
  const when = (t) => (t.kind === 'dca'
    ? `every ${t.cadence.every}${t.cadence.every === 'week' ? ` on ${DAYS[t.cadence.weekday]}` : t.cadence.every === 'month' ? ` on day ${t.cadence.monthDay}` : ''} at ${t.cadence.at}`
    : `every ${t.everyMin} min${t.schedule?.hours ? ` · ${t.schedule.windows.map((w) => `${w.days.map((x) => DAYS[x]).join(' ')} ${w.start}–${w.end}`).join('; ')}` : ''}`);
  const what = (t) => ({
    track: () => `${t.symbols?.length ? t.symbols.join(', ') : 'watchlist'} · score ≥ ${t.minScore}${t.aiTop ? ' · AI on the best' : ''}`,
    trade: () => `${(t.symbols ?? []).join(', ')} · ${D.strategies[t.strategy]?.label ?? t.strategy} · ${t.action === 'trade' ? `${tradeLabel()} $${t.orderUsd}${t.stopPct ? `, stop ${t.stopPct}%` : ''}` : 'alert only'}`,
    dca: () => `${t.symbol} · $${t.amountUsd} · ${t.action === 'trade' ? tradeLabel() : 'alert only'}`,
    learn: () => `${(t.sources ?? []).join(', ')}${t.finvizFilters ? ` · ${t.finvizFilters}` : ''}`,
  })[t.kind]?.() ?? '';
  function paintTasks() {
    const now = D.allowedNow;
    $('#apTasks').innerHTML = D.tasks.length ? D.tasks.map((t) => {
      const kind = D.kinds[t.kind], act = t.activity ?? kind?.activity;
      return `<div class="wl-item"><div class="bar"><b>${esc(t.name)}</b><span class="pill">${esc(kind?.label ?? t.kind)}</span>
          <span class="pill ${t.enabled ? (now.includes(act) ? 'bullish' : 'neutral') : ''}">${t.enabled ? (now.includes(act) ? 'On' : `Waiting (${esc(D.activities[act] ?? act)} not allowed now)`) : 'Off'}</span><span class="spacer"></span>
          <button class="btn ${t.enabled ? '' : 'primary'}" type="button" data-toggle="${esc(t.id)}" data-on="${t.enabled ? '0' : '1'}">${t.enabled ? 'Turn off' : 'Turn on'}</button>
          <button class="btn" type="button" data-run="${esc(t.id)}">Run now</button><button class="btn ghost" type="button" data-edit="${esc(t.id)}">Edit</button>
          <button class="btn ghost" type="button" data-del="${esc(t.id)}">Delete</button></div>
        <p class="muted tiny">${esc(what(t))} · ${esc(when(t))}</p>
        ${t.action === 'trade' && liveBlocked() ? ackWarn : ''}
        <p class="tiny">${t.lastRunAt ? `<span class="muted">Last run ${esc(new Date(t.lastRunAt).toLocaleString())}:</span> ${esc(t.lastResult ?? '')}` : '<span class="muted">Not run yet.</span>'}</p></div>`;
    }).join('') : '<p class="muted">No tasks yet.</p>';
  }

  // ---------------- task form ----------------
  const DEF = { enabled: false, everyMin: 30, schedule: { hours: false, windows: [] }, symbols: [], minScore: 70, aiTop: false, strategy: '', params: {}, action: 'alert', orderUsd: 100, stopPct: 0,
    symbol: '', amountUsd: 50, cadence: { every: 'week', weekday: 1, monthDay: 1, at: '10:00' }, sources: [], finvizFilters: '' };
  function openForm(task) {
    const t = { ...DEF, ...task, kind: task?.kind ?? Object.keys(D.kinds)[0] };
    const s = t.schedule ?? DEF.schedule, win = s.windows?.[0] ?? { days: [1, 2, 3, 4, 5], start: '09:30', end: '16:00' }, c = { ...DEF.cadence, ...t.cadence };
    const strat = t.strategy || Object.keys(D.strategies)[0];
    const form = $('#apForm');
    form.innerHTML = `<h2>${task ? 'Edit' : 'Add'} task</h2>
      <div class="row"><label>Kind<select name="kind" ${task ? 'disabled' : ''}>${Object.entries(D.kinds).map(([k, v]) => `<option value="${esc(k)}" ${k === t.kind ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <label>Name<input name="tname" maxlength="60" value="${esc(t.name ?? '')}" required></label></div>
      <div data-k="track"><div class="row"><label>Symbols (comma separated, empty = your watchlist)<input name="tsymbols" value="${esc(t.kind === 'track' ? (t.symbols ?? []).join(', ') : '')}" autocomplete="off"></label>
          <label>Alert at score ≥ (0-100)<input name="minScore" type="number" min="0" max="100" value="${esc(t.minScore)}"></label></div>
        <label class="check-row"><input type="checkbox" name="aiTop" ${t.aiTop ? 'checked' : ''}> Run the AI analyst on the best one</label></div>
      <div data-k="trade"><div class="row"><label>Symbols (1-10, comma separated)<input name="symbols" value="${esc(t.kind === 'trade' ? (t.symbols ?? []).join(', ') : '')}" autocomplete="off"></label>
          <label>Strategy<select name="strategy">${Object.entries(D.strategies).map(([k, v]) => `<option value="${esc(k)}" ${k === strat ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label></div>
        <p class="muted tiny" data-about></p><div class="row" data-params></div></div>
      <div data-k="dca"><div class="row"><label>Symbol<input name="symbol" value="${esc(t.symbol)}" autocomplete="off"></label><label>Amount ($)<input name="amountUsd" inputmode="decimal" value="${esc(t.amountUsd)}"></label></div>
        <div class="row"><label>Every<select name="every">${['day', 'week', 'month'].map((x) => `<option ${x === c.every ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label data-c="week">On<select name="weekday">${DAYS.map((x, i) => `<option value="${i}" ${i === Number(c.weekday) ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label data-c="month">Day of month (1-28)<input name="monthDay" type="number" min="1" max="28" value="${esc(c.monthDay)}"></label>
          <label>At<input name="at" type="time" value="${esc(c.at)}"></label></div></div>
      <div data-k="trade dca"><div class="row"><label>When it fires<select name="act"><option value="alert" ${t.action === 'trade' ? '' : 'selected'}>Alert only</option>
            <option value="trade" ${t.action === 'trade' ? 'selected' : ''}>${esc(tradeLabel())}</option></select></label>
          <label data-k="trade">Order size ($)<input name="orderUsd" inputmode="decimal" value="${esc(t.orderUsd)}"></label>
          <label data-k="trade">Stop loss % (0 = none)<input name="stopPct" inputmode="decimal" value="${esc(t.stopPct)}"></label></div>
        <p class="muted tiny" data-k="trade">A stop above 0 places whole-share bracket orders for stocks.</p>
        <div data-tradewarn></div></div>
      <div data-k="learn"><div class="row wl-days">${checks('sources', D.sources, t.sources ?? [], { finviz: 'Finviz screen', 'messari-news': 'Messari news', traders: 'Followed traders' })}</div>
        <label>Finviz filters (when Finviz is ticked)<input name="finvizFilters" value="${esc(t.finvizFilters)}" placeholder="cap_large,sec_technology" autocomplete="off" spellcheck="false"></label></div>
      <fieldset data-k="track trade learn"><legend>How often</legend>
        <label>Every (minutes, 5-1440)<input name="everyMin" type="number" min="5" max="1440" value="${esc(t.everyMin)}" class="tiny-in"></label>
        <div class="row"><label class="check-row"><input type="radio" name="hours" value="0" ${s.hours ? '' : 'checked'}> Any time</label><label class="check-row"><input type="radio" name="hours" value="1" ${s.hours ? 'checked' : ''}> Only during these hours</label></div>
        <div data-hours><div class="row wl-days">${dayChecks('day', win.days)}</div>
          <div class="row"><label>From<input name="start" type="time" value="${esc(win.start)}"></label><label>Until<input name="end" type="time" value="${esc(win.end)}"></label></div></div></fieldset>
      <label class="check-row"><input type="checkbox" name="enabled" ${t.enabled ? 'checked' : ''}> Turn on after saving</label>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-cancel>Cancel</button></div>`;
    form.dataset.id = task?.id ?? '';
    let lastStrat = null;
    const sync = () => {
      const k = form.kind.value;
      form.querySelectorAll('[data-k]').forEach((x) => (x.hidden = !x.dataset.k.split(' ').includes(k)));
      form.querySelectorAll('[data-c]').forEach((x) => (x.hidden = x.dataset.c !== form.every.value));
      form.querySelector('[data-hours]').hidden = form.querySelector('[name=hours]:checked').value !== '1';
      if (form.strategy.value !== lastStrat) {
        const S = D.strategies[form.strategy.value], keep = form.strategy.value === t.strategy ? t.params : {};
        form.querySelector('[data-about]').textContent = S?.about ?? '';
        form.querySelector('[data-params]').innerHTML = Object.entries(S?.params ?? {}).map(([pk, p]) => `<label>${esc(p.label)} <span class="muted tiny">${esc(p.min)}–${esc(p.max)}</span>
          <input name="p_${esc(pk)}" type="number" min="${esc(p.min)}" max="${esc(p.max)}" value="${esc(keep?.[pk] ?? p.def)}"></label>`).join('');
        lastStrat = form.strategy.value;
      }
      form.querySelector('[data-tradewarn]').innerHTML = form.act.value === 'trade' && liveBlocked() ? ackWarn
        : form.act.value === 'trade' && live() ? '<p class="notice">This task will place REAL-MONEY orders (within your risk limits).</p>' : '';
    };
    form.oninput = sync;
    sync();
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  function readTask(f) {
    const kind = f.kind.value, hours = f.querySelector('[name=hours]:checked').value === '1';
    const base = { id: f.dataset.id || undefined, kind, name: f.tname.value.trim(), enabled: f.enabled.checked };
    const timed = { everyMin: Number(f.everyMin.value), schedule: { hours, windows: hours ? [{ days: picked(f, 'day').map(Number), start: f.start.value, end: f.end.value }] : [] } };
    if (kind === 'track') return { ...base, ...timed, symbols: list(f.tsymbols.value), minScore: Number(f.minScore.value), aiTop: f.aiTop.checked };
    if (kind === 'trade') {
      const params = Object.fromEntries([...f.querySelectorAll('[name^=p_]')].map((x) => [x.name.slice(2), Number(x.value)]));
      return { ...base, ...timed, symbols: list(f.symbols.value), strategy: f.strategy.value, params, action: f.act.value, orderUsd: Number(f.orderUsd.value), stopPct: Number(f.stopPct.value) };
    }
    if (kind === 'dca') return { ...base, symbol: f.symbol.value.trim(), amountUsd: Number(f.amountUsd.value), action: f.act.value,
      cadence: { every: f.every.value, weekday: Number(f.weekday.value), monthDay: Number(f.monthDay.value), at: f.at.value } };
    return { ...base, ...timed, sources: picked(f, 'sources'), finvizFilters: f.finvizFilters.value.trim() };
  }

  const code = () => el.querySelector('#apTotp')?.value.trim() ?? ''; // live real-money tasks: fresh authenticator code

  // ---------------- events ----------------
  el.addEventListener('input', (e) => { if (e.target.closest('#apFocus')) syncFocus(); });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (e.target.id === 'apFocus') { await after(api('/api/autopilot/focus', { method: 'POST', body: readFocus() })); toast('Saved'); }
      if (e.target.id === 'apForm') { await after(api('/api/autopilot/tasks', { method: 'POST', body: { ...readTask(e.target), totp: code() } })); toast('Task saved'); }
    } catch (err) { toast(err.message, true); }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.type === 'submit') return;
    const d = b.dataset;
    try {
      if (d.refresh !== undefined) return load();
      if (d.addslot !== undefined) { b.insertAdjacentHTML('beforebegin', slotRow({ days: [1, 2, 3, 4, 5], start: '09:30', end: '16:00', allow: [] })); return syncFocus(); }
      if (d.delslot !== undefined) { b.closest('.ap-slot').remove(); return syncFocus(); }
      if (d.add !== undefined) return openForm(null);
      if (d.cancel !== undefined) { $('#apForm').hidden = true; $('#apForm').innerHTML = ''; return; }
      if (d.edit) return openForm(D.tasks.find((t) => t.id === d.edit));
      if (d.toggle) return await after(api('/api/autopilot/tasks/toggle', { method: 'POST', body: { id: d.toggle, on: d.on === '1', totp: code() } }));
      if (d.run) {
        b.disabled = true; b.textContent = 'Running…';
        const r = await api('/api/autopilot/tasks/run', { method: 'POST', body: { id: d.run, totp: code() } }).finally(() => { b.disabled = false; b.textContent = 'Run now'; });
        toast(r.result ?? 'Done');
        return await load();
      }
      if (d.del) {
        if (d.armed !== '1') { d.armed = '1'; b.textContent = 'Delete?'; return; }
        return await after(api(`/api/autopilot/tasks?id=${encodeURIComponent(d.del)}`, { method: 'DELETE' }));
      }
    } catch (err) { toast(err.message, true); }
  });

  load();
}
