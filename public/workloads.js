// Desktop-only UI for this computer's workloads: mining (category 'mine', Mining tab) and compute sharing
// (category 'share', Compute Share window). Talks only to window.desktop.workloads (IPC to the main process).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (s) => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
const fmtHr = (h) => (h == null ? '' : h >= 1e6 ? `${(h / 1e6).toFixed(2)} MH/s` : h >= 1e3 ? `${(h / 1e3).toFixed(2)} kH/s` : `${h.toFixed(1)} H/s`);

const INTRO = {
  mine: `<p class="muted">Mine on this computer with your CPU or graphics card, paid by the pool straight to <b>your</b> wallet address.
    Get XMRig only from its official releases (<a href="https://github.com/xmrig/xmrig/releases" target="_blank" rel="noopener noreferrer">github.com/xmrig/xmrig</a>); NVIDIA cards also need the
    <a href="https://github.com/xmrig/xmrig-cuda/releases" target="_blank" rel="noopener noreferrer">CUDA plugin</a> next to xmrig.exe. Antivirus tools often flag miners: if you add an exclusion, limit it to that one folder.
    Electricity usually costs more than CPU mining earns: check the calculator below first.</p>`,
  share: `<p class="muted">Let a compute network use this computer only when you allow it. Works with programs that run as a normal app, such as the
    <a href="https://boinc.berkeley.edu/download.php" target="_blank" rel="noopener noreferrer">BOINC</a> client (<code>boinc.exe</code>; science projects, and
    <a href="https://gridcoin.us/" target="_blank" rel="noopener noreferrer">Gridcoin</a> pays crunchers). Your account and payouts are set up inside that program; StocksWorks starts and stops it by your rules.
    Programs installed as Windows services can't be scheduled from here.</p>`,
};

export function mountWorkloads(box, category) {
  const api = window.desktop?.workloads;
  if (!api) { box.innerHTML = '<p class="muted">Available in the StocksWorks desktop app.</p>'; return; }
  box.innerHTML = `${INTRO[category]}<div class="wl-list"><p class="muted">Loading…</p></div>
    <div class="bar"><button class="btn primary" type="button" data-add>+ Add ${category === 'mine' ? 'a miner' : 'a compute-sharing program'}</button></div>
    <form class="wl-form card" hidden novalidate></form>`;
  const list = box.querySelector('.wl-list'), form = box.querySelector('.wl-form');
  let kinds = {}, rows = [], pickedNew = false;
  const fail = (r) => { if (r?.error) throw new Error(r.error); return r; };
  const say = (msg, bad) => { const p = form.querySelector('.wl-msg') ?? list; p.insertAdjacentHTML('afterbegin', `<p class="${bad ? 'err' : 'up'} wl-flash">${esc(msg)}</p>`); setTimeout(() => box.querySelector('.wl-flash')?.remove(), 6000); };

  async function refresh() {
    let r;
    try { r = fail(await api.list()); } catch (e) { list.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    kinds = r.kinds;
    rows = r.workloads.filter((w) => w.category === category);
    if (list.contains(document.activeElement)) return; // don't redraw under the user's focus
    list.innerHTML = rows.length ? rows.map((w) => {
      const s = w.schedule, cap = s.maxHoursPerDay ? ` of ${s.maxHoursPerDay} h` : '';
      const when = s.hours ? s.windows.map((x) => `${x.days.map((d) => DAYS[d]).join(' ')} ${x.start}–${x.end}`).join('; ') : 'any time';
      return `<div class="wl-item"><div class="bar"><b>${esc(w.name)}</b><span class="pill">${esc(kinds[w.kind]?.label ?? w.kind)}</span>
          <span class="pill ${w.running ? 'bullish' : ''}">${esc(w.running ? `Running ${w.hashrate != null ? fmtHr(w.hashrate) : ''}` : w.reason || (w.enabled ? 'Starting…' : 'Off'))}</span><span class="spacer"></span>
          <button class="btn ${w.enabled ? '' : 'primary'}" type="button" data-toggle="${esc(w.id)}" data-on="${w.enabled ? '0' : '1'}">${w.enabled ? 'Turn off' : 'Turn on'}</button>
          <button class="btn ghost" type="button" data-edit="${esc(w.id)}">Edit</button><button class="btn ghost" type="button" data-remove="${esc(w.id)}">Remove</button></div>
        <p class="muted tiny">${esc(w.exeName)} <span class="mono">sha256 ${esc(w.sha256)}…</span> · ${esc(when)}${s.idleOnly ? ` · only when idle ${esc(s.idleMinutes)} min` : ''}${s.pauseOnBattery ? ' · not on battery' : ''}
          ${w.kind === 'xmrig-cpu' ? ` · CPU cap ${esc(w.cpuPct)}%` : ''} · today ${hm(w.ranTodaySec)}${esc(cap)}</p>
        ${w.error ? `<p class="err">${esc(w.error)}</p>` : ''}
        ${w.log.length ? `<details><summary class="muted tiny">Program output</summary><pre class="wl-log">${esc(w.log.join('\n'))}</pre></details>` : ''}</div>`;
    }).join('') : '<p class="muted">Nothing set up yet.</p>';
  }

  function openForm(w) {
    pickedNew = false;
    const k = w?.kind ?? Object.keys(kinds).find((x) => kinds[x].category === category);
    const s = w?.schedule ?? { hours: false, windows: [], idleOnly: false, idleMinutes: 5, pauseOnBattery: true, maxHoursPerDay: 0 };
    const win = s.windows[0] ?? { days: [1, 2, 3, 4, 5], start: '22:00', end: '07:00' };
    form.innerHTML = `<h3>${w ? 'Edit' : 'Add'} ${category === 'mine' ? 'miner' : 'compute-sharing program'}</h3><div class="wl-msg"></div>
      <div class="row"><label>Type<select name="kind">${Object.entries(kinds).filter(([, v]) => v.category === category).map(([id, v]) => `<option value="${esc(id)}" ${id === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <label>Name<input name="wname" maxlength="40" value="${esc(w?.name ?? '')}"></label></div>
      <div class="bar"><button class="btn" type="button" data-pick>Choose program (.exe)…</button><span class="muted tiny" data-picked>${w ? `Current: ${esc(w.exeName)} (sha256 ${esc(w.sha256)}…)` : 'No program chosen'}</span></div>
      <div data-pool><div class="row"><label>Pool<input name="pool" placeholder="stratum+ssl://pool.example.com:443" value="${esc(w?.pool ?? '')}"></label>
          <label>Your payout address<input name="payout" value="${esc(w?.payout ?? '')}" spellcheck="false"></label></div>
        <div class="row"><label>Worker name<input name="worker" maxlength="32" value="${esc(w?.worker ?? 'desktop')}"></label><label>Pool password<input name="pass" maxlength="32" value="${esc(w?.pass ?? 'x')}"></label></div>
        <label data-cpu>CPU cap: use at most <output name="cpuOut">${esc(w?.cpuPct ?? 50)}</output>% of CPU threads<input name="cpuPct" type="range" min="10" max="100" step="5" value="${esc(w?.cpuPct ?? 50)}"></label>
        <label data-gpu>Graphics card<select name="gpu"><option value="opencl" ${w?.gpu === 'cuda' ? '' : 'selected'}>AMD (OpenCL)</option><option value="cuda" ${w?.gpu === 'cuda' ? 'selected' : ''}>NVIDIA (CUDA plugin required)</option></select></label></div>
      <label data-args>Program arguments, one per line (optional)<textarea name="args" rows="3" spellcheck="false" placeholder="${category === 'share' ? '--dir\nC:\\ProgramData\\BOINC' : ''}">${esc((w?.args ?? []).join('\n'))}</textarea></label>
      <fieldset><legend>When it may run</legend>
        <div class="row"><label class="check-row"><input type="radio" name="hours" value="0" ${s.hours ? '' : 'checked'}> Any time</label><label class="check-row"><input type="radio" name="hours" value="1" ${s.hours ? 'checked' : ''}> Only during active hours</label></div>
        <div data-hours><div class="row wl-days">${DAYS.map((d, i) => `<label class="check-row"><input type="checkbox" name="day" value="${i}" ${win.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
          <div class="row"><label>From<input name="start" type="time" value="${esc(win.start)}"></label><label>Until<input name="end" type="time" value="${esc(win.end)}"></label></div>
          <p class="muted tiny">An end time earlier than the start runs overnight (e.g. 22:00 until 07:00).</p></div>
        <div class="row"><label class="check-row"><input type="checkbox" name="idleOnly" ${s.idleOnly ? 'checked' : ''}> Only while I'm away from the computer for</label><label><input name="idleMinutes" type="number" min="1" max="240" value="${esc(s.idleMinutes)}" class="tiny-in"> min</label></div>
        <label class="check-row"><input type="checkbox" name="pauseOnBattery" ${s.pauseOnBattery ? 'checked' : ''}> Pause on battery power</label>
        <label>Daily limit (hours, 0 = none)<input name="maxHoursPerDay" type="number" min="0" max="24" step="0.5" value="${esc(s.maxHoursPerDay)}" class="tiny-in"></label></fieldset>
      <label class="check-row"><input type="checkbox" name="enabled" ${w?.enabled ? 'checked' : ''}> Turn on after saving</label>
      <label>Your StocksWorks passphrase (required to approve a program or change its settings)<input name="passphrase" type="password" autocomplete="current-password"></label>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-cancel>Cancel</button></div>`;
    form.dataset.id = w?.id ?? '';
    const sync = () => {
      const kk = form.kind.value, pool = Boolean(kinds[kk]?.pool);
      form.querySelector('[data-pool]').hidden = !pool;
      form.querySelector('[data-cpu]').hidden = kk !== 'xmrig-cpu';
      form.querySelector('[data-gpu]').hidden = kk !== 'xmrig-gpu';
      form.querySelector('[data-args]').hidden = pool;
      form.querySelector('[data-hours]').hidden = form.querySelector('[name=hours]:checked').value !== '1';
      form.cpuOut.value = form.cpuPct.value;
    };
    form.oninput = sync;
    sync();
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  form.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cancel]')) { form.hidden = true; form.innerHTML = ''; return; }
    if (!e.target.closest('[data-pick]')) return;
    try {
      const r = fail(await api.pick());
      if (r.canceled) return;
      pickedNew = true;
      form.querySelector('[data-picked]').textContent = `${r.exe} (sha256 ${r.sha256}…)`;
    } catch (err) { say(err.message, true); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form, hours = f.querySelector('[name=hours]:checked').value === '1';
    const workload = {
      id: f.dataset.id || undefined, kind: f.kind.value, name: f.wname.value, enabled: f.enabled.checked,
      pool: f.pool.value, payout: f.payout.value, worker: f.worker.value, pass: f.pass.value, cpuPct: Number(f.cpuPct.value), gpu: f.gpu.value, args: f.args.value,
      schedule: {
        hours, windows: hours ? [{ days: [...f.querySelectorAll('[name=day]:checked')].map((x) => Number(x.value)), start: f.start.value, end: f.end.value }] : [],
        idleOnly: f.idleOnly.checked, idleMinutes: Number(f.idleMinutes.value), pauseOnBattery: f.pauseOnBattery.checked, maxHoursPerDay: Number(f.maxHoursPerDay.value),
      },
    };
    try {
      fail(await api.save(f.passphrase.value, workload, pickedNew));
      form.hidden = true; form.innerHTML = '';
      await refresh();
      say('Saved');
    } catch (err) { f.passphrase.value = ''; say(err.message, true); }
  });

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add],[data-toggle],[data-edit],[data-remove]');
    if (!b || form.contains(b)) return;
    try {
      if (b.dataset.add !== undefined) return openForm(null);
      if (b.dataset.edit) return openForm(rows.find((w) => w.id === b.dataset.edit));
      if (b.dataset.toggle) fail(await api.toggle(b.dataset.toggle, b.dataset.on === '1'));
      if (b.dataset.remove) {
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Remove?'; return; }
        fail(await api.remove(b.dataset.remove));
      }
      b.blur();
      await refresh();
    } catch (err) { say(err.message, true); }
  });

  refresh();
  clearInterval(box._wlTimer);
  box._wlTimer = setInterval(() => (document.body.contains(box) ? refresh() : clearInterval(box._wlTimer)), 5000);
}
