// AI Lab tab: hardware + network hosts, hardware-aware model catalog, learning loop (local model vs Claude teacher,
// your review -> dataset), benchmark with a transparent appropriateness score, and a from-scratch model designer.
// Every dynamic value goes through esc() before reaching innerHTML.
import { scratchParams, validateArch, trainingMemory, trainPlan, assessFit, benchmarkStats, appropriateness, GiB } from '/lib/modelfit.js';

const PRESETS = {
  tiny: { label: 'Tiny demo (~0.6M, trains in seconds on CPU)', cfg: { vocab: 2048, layers: 2, width: 128, mlp: 344, heads: 4, kvHeads: 2, headDim: 32, ctx: 256, tied: true, seed: 42 } },
  proof: { label: 'Pipeline proof (26M, handbook preset)', cfg: { vocab: 8192, layers: 8, width: 512, mlp: 1376, heads: 8, kvHeads: 2, headDim: 64, ctx: 1024, tied: true, seed: 42 } },
  small: { label: 'Small (~110M, needs a GPU and lots of text)', cfg: { vocab: 16384, layers: 12, width: 768, mlp: 2048, heads: 12, kvHeads: 4, headDim: 64, ctx: 1024, tied: true, seed: 42 } },
};
const FIELDS = [['vocab', 'Vocabulary'], ['layers', 'Layers'], ['width', 'Width (hidden)'], ['mlp', 'MLP width'], ['heads', 'Attention heads'], ['kvHeads', 'KV heads'], ['headDim', 'Head dimension'], ['ctx', 'Context (tokens)'], ['seed', 'Seed']];
const FIT_LABEL = { fit: 'Fits', borderline: 'Borderline', incompatible: 'Too big', unknown: 'Unknown' };
const FIT_PILL = { fit: 'bullish', borderline: 'neutral', incompatible: 'bearish', unknown: '' };
const fmtN = (n) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const gib = (x) => (x == null ? '—' : `${x} GiB`);

export function mountAiLab(el, { api, esc, toast, stat }) {
  const S = { filter: 'all', q: '', ctx: 8192, parallel: 1, cfg: { ...PRESETS.tiny.cfg }, last: {}, opts: { device: 'auto', precision: 'auto', accum: 1, gradCheckpointing: false } };
  el.innerHTML = `<div id="alHw" class="card"><div class="empty">Reading your hardware…</div></div>
    <div id="alSetup" class="card"></div>
    <div id="alCat" class="card"><div class="empty">Loading models…</div></div>
    <div class="grid two"><div id="alLoop" class="card"></div><div id="alBench" class="card"></div></div>
    <div id="alFt" class="card"></div>
    <div id="alDesign" class="card"></div>`;
  const $ = (s) => el.querySelector(s);
  let status = null, catalog = null;
  const fail = (box) => (e) => { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; };
  const pill = (f) => `<span class="pill ${FIT_PILL[f.status] ?? ''}" title="${esc(f.reason ?? f.note ?? '')}">${esc(FIT_LABEL[f.status] ?? f.status)}</span>`;

  // ---------------- hardware, profiles, hosts ----------------
  async function loadStatus() {
    status = await api('/api/ai-lab/status');
    const h = status.hardware, b = status.budget, py = status.python;
    $('#alHw').innerHTML = `<div class="bar"><h2>Your hardware</h2><span class="muted tiny">read ${esc(new Date(h.at).toLocaleTimeString())} via ${esc(h.telemetry)}</span><span class="spacer"></span><button class="btn ghost" type="button" data-hw="refresh">Refresh</button></div>
      <div class="stats">${h.gpus.length ? h.gpus.map((g) => stat(esc(g.name), `${g.freeGiB} / ${g.totalGiB} GiB free`)).join('') : stat('GPU', 'none detected (CPU only)')}
        ${stat('Budget for models', `<b>${gib(b.budgetGiB)}</b> <span class="muted tiny">free − ${esc(status.profiles.find((p) => p.id === status.profile)?.reserveGiB)} GiB reserve</span>`)}
        ${stat('RAM', `${h.ramFreeGiB} / ${h.ramTotalGiB} GiB free`)}${stat('Disk free', gib(h.diskFreeGiB))}${stat('CPU', `${esc(h.cores)} threads`)}
        ${stat('Training tools', py.ready ? `Python ${esc(py.version)} ${py.cuda ? '· CUDA' : '· CPU only'}` : `<span class="down">missing ${esc(py.missing.join(', '))}</span>`)}</div>
      ${py.ready && !py.cuda && h.gpus.length ? '<p class="muted tiny">Your PyTorch is the CPU build, so model training runs on the CPU. For GPU training install the CUDA build of PyTorch from pytorch.org (inference through Ollama already uses the GPU).</p>' : ''}
      <div class="grid two"><div><h3>Workload profile</h3><p class="muted tiny">The reserve is memory kept free for what else you run (OBS, games). Fit verdicts use: free GPU memory − reserve.</p>
        <div class="bar">${status.profiles.map((p) => `<button type="button" class="btn ${p.id === status.profile ? 'primary' : 'ghost'}" data-profile="${esc(p.id)}">${esc(p.name)} · ${esc(p.reserveGiB)} GiB</button>`).join('')}</div>
        <form id="alProf" class="row"><label>New profile<input name="pname" maxlength="30" placeholder="e.g. Streaming 1080p"></label><label>Reserve (GiB)<input name="reserveGiB" inputmode="decimal" value="3"></label><button class="btn" type="submit">Add</button></form></div>
      <div><h3>Ollama hosts on your network</h3><p class="muted tiny">Run models on other machines too: install Ollama there, set <code>OLLAMA_HOST=0.0.0.0</code> on it, and add its address.</p>
        ${status.hosts.map((x) => `<div class="bar"><b>${esc(x.name)}</b><span class="mono tiny">${esc(x.url)}</span>${x.id === 'local' ? '' : `<button class="btn ghost" type="button" data-host-del="${esc(x.id)}">Remove</button>`}</div>`).join('')}
        <form id="alHost" class="row"><label>Address<input name="url" placeholder="http://192.168.1.30:11434" spellcheck="false"></label><label>Name<input name="hname" maxlength="30" placeholder="Living-room PC"></label><button class="btn" type="submit">Add host</button></form></div></div>`;
  }
  $('#alHw').addEventListener('click', async (e) => {
    const b = e.target.closest('button[type=button]');
    if (!b) return;
    try {
      if (b.dataset.profile) await api('/api/ai-lab/profile', { method: 'POST', body: { id: b.dataset.profile } });
      if (b.dataset.hostDel) await api(`/api/ai-lab/hosts?id=${encodeURIComponent(b.dataset.hostDel)}`, { method: 'DELETE' });
      await loadStatus(); loadCatalog(); renderDesign();
    } catch (err) { toast(err.message, true); }
  });
  $('#alHw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === 'alProf') await api('/api/ai-lab/profile', { method: 'POST', body: { name: f.pname.value, reserveGiB: Number(f.reserveGiB.value) } });
      if (f.id === 'alHost') { await api('/api/ai-lab/hosts', { method: 'POST', body: { url: f.url.value, name: f.hname.value } }); toast('Host added'); }
      await loadStatus(); loadCatalog(); renderDesign();
    } catch (err) { toast(err.message, true); }
  });

  // ---------------- catalog ----------------
  async function loadCatalog() {
    const box = $('#alCat');
    try { catalog = await api(`/api/ai-lab/catalog?ctx=${S.ctx}&parallel=${S.parallel}`); } catch (e) { return fail(box)(e); }
    renderCatalog();
    renderBench();
  }
  function renderCatalog() {
    const box = $('#alCat');
    const q = S.q.toLowerCase();
    const rows = catalog.models.filter((m) => (!q || `${m.name} ${m.family} ${m.hostName} ${m.capabilities.join(' ')}`.toLowerCase().includes(q)) && (S.filter === 'all' || m.fit.status === 'fit'))
      .sort((a, b) => (b.selected - a.selected) || (a.est?.highGiB ?? 1e9) - (b.est?.highGiB ?? 1e9));
    const sel = status?.selection;
    box.innerHTML = `<div class="bar"><h2>Choose a model</h2><span class="muted tiny">${catalog.models.length} installed across ${status?.hosts.length ?? 1} host(s) · estimates for ${esc(catalog.ctx)} tokens × ${esc(catalog.parallel)} request(s) against ${gib(catalog.budget.budgetGiB)} (${esc(catalog.profile.name)})</span></div>
      ${sel ? `<p>In use for the local analyst: <b class="mono">${esc(sel.model)}</b> <span class="muted tiny">rev ${esc(sel.rev)} · digest ${esc(sel.digest.slice(0, 12))}…</span></p>` : '<p class="muted">No model chosen yet: pick one below with <b>Use</b>.</p>'}
      ${catalog.errors.map((x) => `<p class="err">${esc(x.host)}: ${esc(x.error)}</p>`).join('')}
      ${catalog.errors.some((x) => x.host === 'This PC') ? '<p><button class="btn primary" type="button" data-install-ollama>Install Ollama on this PC</button> <span class="muted tiny">Runs local AI models. Installs per-user through winget (Windows\' package manager), then starts it.</span></p>' : ''}
      <form id="alCatF" class="row"><label>Search<input name="q" value="${esc(S.q)}" placeholder="name, family, capability…"></label>
        <label>Show<select name="filter"><option value="all" ${S.filter === 'all' ? 'selected' : ''}>All models</option><option value="fit" ${S.filter === 'fit' ? 'selected' : ''}>Fits my hardware</option></select></label>
        <label>Context (tokens)<input name="ctx" inputmode="numeric" value="${esc(S.ctx)}"></label><label>Simultaneous requests<input name="parallel" inputmode="numeric" value="${esc(S.parallel)}"></label></form>
      <div class="scroll"><table><tr><th>Model</th><th>Host</th><th>Size</th><th>Quant</th><th class="num">Est. VRAM</th><th class="num">% of GPU</th><th>Fit</th><th></th></tr>
      ${rows.map((m) => `<tr><td><b>${esc(m.name)}</b> ${m.resident ? '<span class="pill">loaded</span>' : ''}<div class="muted tiny">${esc(m.family ?? '')} ${m.capabilities.length ? '· ' + esc(m.capabilities.join(', ')) : ''} ${m.license ? '· ' + esc(m.license) : ''}</div></td>
        <td>${esc(m.hostName)}</td><td>${esc(m.params ?? '—')}</td><td>${esc(m.quant ?? '—')}</td>
        <td class="num">${m.est ? `${esc(m.est.lowGiB)}–${esc(m.est.highGiB)} GiB` : 'Unknown'}${m.est && !m.est.kvKnown ? ' <span class="muted tiny">(no KV metadata)</span>' : ''}</td>
        <td class="num">${m.fit.pctLow != null ? `${esc(m.fit.pctLow)}–${esc(m.fit.pctHigh)}%` : '—'}</td>
        <td>${pill(m.fit)} <span class="muted tiny">${m.fit.status === 'fit' ? `${esc(m.fit.headroomLow)}–${esc(m.fit.headroomHigh)} GiB left` : m.fit.status === 'incompatible' ? `short ${esc(m.fit.shortLow)}–${esc(m.fit.shortHigh)} GiB` : m.fit.status === 'borderline' ? 'may not fit: try shorter context' : esc(m.fit.reason ?? '')}</span></td>
        <td>${m.selected ? '<span class="pill bullish">in use</span>' : `<button class="btn ghost" type="button" data-use="${esc(m.name)}" data-host="${esc(m.hostId)}">Use</button>`}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No models match. Clear the filter or search Hugging Face below.</td></tr>'}</table></div>
      <details><summary>Find more models on Hugging Face</summary>
        <form id="alHf" class="row"><label>Search Hugging Face<input name="q" placeholder="e.g. qwen2.5 7b instruct"></label><label class="check-row"><input type="checkbox" name="gguf" checked> Only GGUF (runs in Ollama)</label><button class="btn" type="submit">Search</button></form>
        <div id="alHfOut"></div><p class="muted tiny">Metadata only: nothing downloads until you press Install. Check each model's license before use. Installing pulls the GGUF straight into this PC's Ollama.</p></details>`;
    box.querySelector('#alCatF').addEventListener('change', (e) => {
      const f = e.currentTarget;
      Object.assign(S, { q: f.q.value, filter: f.filter.value, ctx: Number(f.ctx.value) || 8192, parallel: Number(f.parallel.value) || 1 });
      if (['ctx', 'parallel'].includes(e.target.name)) loadCatalog(); else renderCatalog();
    });
    box.querySelector('#alCatF').addEventListener('submit', (e) => e.preventDefault());
    box.querySelector('#alHf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = box.querySelector('#alHfOut');
      out.innerHTML = '<div class="empty">Searching…</div>';
      try {
        const list = await api(`/api/ai-lab/hf?q=${encodeURIComponent(e.target.q.value)}&gguf=${e.target.gguf.checked ? 1 : 0}`);
        out.innerHTML = list.length ? `<div class="scroll"><table><tr><th>Repository</th><th>Task</th><th class="num">Downloads</th><th>License</th><th></th></tr>${list.map((m) => `<tr>
          <td><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.id)}</a> ${m.gguf ? '<span class="pill bullish">GGUF</span>' : ''}<div class="muted tiny">${esc(m.tags.join(', '))}</div></td>
          <td>${esc(m.task ?? '—')}</td><td class="num">${esc(fmtN(m.downloads))}</td><td>${esc(m.license ?? '?')}</td>
          <td>${m.gguf ? `<button class="btn ghost" type="button" data-pull="hf.co/${esc(m.id)}">Install…</button>` : '<span class="muted tiny">needs conversion</span>'}</td></tr>`).join('')}</table></div>` : '<p class="muted">No results.</p>';
      } catch (err) { fail(out)(err); }
    });
  }
  $('#alCat').addEventListener('click', async (e) => {
    const b = e.target.closest('button[type=button]');
    if (!b) return;
    if (b.dataset.installOllama !== undefined) { // not bundled with the exe: installed on request
      b.disabled = true; b.textContent = 'Installing Ollama…';
      try {
        const r = await api('/api/ai-lab/install-ollama', { method: 'POST', body: {} });
        if (r.already) { toast(`Ollama is already running (${r.version ?? 'ok'})`); return loadCatalog(); }
        toast('Installing Ollama: progress under Jobs'); status.jobs = await api('/api/ai-lab/jobs'); watchJobs();
      } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Install Ollama on this PC'; }
      return;
    }
    try {
      if (b.dataset.use) { await api('/api/ai-lab/select', { method: 'POST', body: { hostId: b.dataset.host, model: b.dataset.use } }); toast(`Now using ${b.dataset.use}`); await loadStatus(); return loadCatalog(); }
      if (b.dataset.pull) {
        const quant = prompt('Quantization tag to install (blank = the repository default, e.g. Q4_K_M):', 'Q4_K_M');
        if (quant === null) return;
        const model = quant.trim() ? `${b.dataset.pull}:${quant.trim()}` : b.dataset.pull;
        await api('/api/ai-lab/pull', { method: 'POST', body: { model, hostId: 'local' } });
        toast(`Installing ${model}… (see Jobs; can take a long time)`);
        status.jobs = await api('/api/ai-lab/jobs'); renderDesign(); watchJobs();
      }
    } catch (err) { toast(err.message, true); }
  });

  // ---------------- training setup + options ----------------
  const VARIANTS = [['auto', 'Recommended for this PC'], ['cu130', 'NVIDIA GPU · CUDA 13.0 (driver 580+)'], ['cu126', 'NVIDIA GPU · CUDA 12.6 (driver 525+)'], ['cpu', 'CPU only (no GPU)']];
  function renderSetup() {
    const py = status.python, st = status.setup, running = (status.jobs ?? []).some((j) => j.kind === 'setup' && j.status === 'running');
    $('#alSetup').innerHTML = `<div class="bar"><h2>Training setup</h2>
        <span class="pill ${py.finetuneReady ? 'bullish' : py.ready ? 'neutral' : 'bearish'}">${py.finetuneReady ? 'ready' : py.ready ? 'partly installed' : 'not installed'}</span></div>
      <div class="stats">${stat('Python used', py.appEnv ? 'StocksWorks environment' : esc(py.exe))}${stat('PyTorch', esc(py.torch ?? 'not installed'))}
        ${stat('Trains on', py.cuda ? `GPU · ${esc(py.device)}` : 'CPU only')}${stat('Fine-tuning (peft)', py.finetuneReady ? 'installed' : 'missing')}</div>
      <form id="alSetupF" class="row"><label>Install PyTorch for<select name="variant">${VARIANTS.map(([v, l]) => `<option value="${v}">${esc(v === 'auto' ? `${l}: ${st.recommended.label}` : l)}</option>`).join('')}</select></label>
        <button class="btn ${py.finetuneReady ? '' : 'primary'}" type="submit" ${running ? 'disabled' : ''}>${st.appEnv ? 'Update / switch' : 'Install'}</button></form>
      <p class="muted tiny">Installs into a private environment (<span class="mono">${esc(st.dir)}</span>), not your system Python: PyTorch, transformers, tokenizers, peft and helpers. The GPU build is about 3 GB.</p>
      ${!py.found && !st.appEnv ? '<p class="muted tiny"><b>Python isn\'t installed.</b> Install sets it up first: Python 3.12 per-user through winget (Windows\' package manager, no admin prompt), then the packages above.</p>' : ''}
      <h3>How training runs</h3>
      <form id="alOptsF" class="row"><label>Device<select name="device">${[['auto', 'Auto (GPU when available)'], ['cuda', 'GPU (CUDA)'], ['cpu', 'CPU']].map(([v, l]) => `<option value="${v}" ${S.opts.device === v ? 'selected' : ''} ${v === 'cuda' && !py.cuda ? 'disabled' : ''}>${l}</option>`).join('')}</select></label>
        <label>Precision<select name="precision">${[['auto', 'Auto'], ['bf16', 'bf16 (fast, GPU)'], ['fp16', 'fp16 (GPU)'], ['fp32', 'fp32 (exact, slow)']].map(([v, l]) => `<option value="${v}" ${S.opts.precision === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Gradient accumulation<input name="accum" inputmode="numeric" value="${esc(S.opts.accum)}"></label>
        <label class="check-row"><input type="checkbox" name="gradCheckpointing" ${S.opts.gradCheckpointing ? 'checked' : ''}> Gradient checkpointing (less memory, slower)</label></form>
      <p class="muted tiny">Used by both "Train pilot" and "Fine-tune". Accumulation multiplies the effective batch without more memory.</p>`;
  }
  $('#alSetup').addEventListener('change', (e) => {
    const f = e.target.closest('#alOptsF');
    if (!f) return;
    S.opts = { device: f.device.value, precision: f.precision.value, accum: Number(f.accum.value) || 1, gradCheckpointing: f.gradCheckpointing.checked };
  });
  $('#alSetup').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id !== 'alSetupF') return;
    try { await api('/api/ai-lab/setup', { method: 'POST', body: { variant: e.target.variant.value } }); toast('Installing… progress below under Jobs'); status.jobs = await api('/api/ai-lab/jobs'); renderSetup(); renderDesign(); watchJobs(); }
    catch (err) { toast(err.message, true); }
  });

  // ---------------- fine-tune an existing model ----------------
  function renderFinetune() {
    const py = status.python, d = status.dataset, running = (status.jobs ?? []).some((j) => j.status === 'running' && ['finetune', 'pilot', 'setup'].includes(j.kind));
    $('#alFt').innerHTML = `<div class="bar"><h2>Fine-tune an existing model</h2><span class="muted tiny">LoRA: trains a small add-on on your reviewed examples, merges it, then Export puts it in Ollama.</span></div>
      <div class="stats">${stat('Training examples', `<b>${esc(d.train)}</b>`)}${stat('Dev (checks progress)', esc(d.dev))}${stat('Test (kept untouched)', esc(d.test))}${stat('Waiting for review', esc(status.pending))}</div>
      ${d.train < 3 ? '<p class="notice">Fine-tuning needs at least 3 training examples: accept or correct answers above, or let an AI teacher label a batch below.</p>' : ''}
      ${py.finetuneReady ? '' : '<p class="notice">Install the training tools first (Training setup above).</p>'}
      <form id="alFtF" class="row"><label>Base model<select name="base">${status.finetuneBases.map((b) => `<option value="${esc(b.id)}">${esc(b.id.split('/')[1])} · ${esc(b.note)}</option>`).join('')}<option value="custom">Other (Hugging Face id)…</option></select></label>
        <label>Custom id<input name="custom" placeholder="owner/model-Instruct" spellcheck="false"></label>
        <label>Epochs<input name="epochs" inputmode="numeric" value="3"></label><label>Learning rate<input name="lr" inputmode="decimal" value="0.0002"></label>
        <label>LoRA rank<select name="r">${[4, 8, 16, 32, 64].map((r) => `<option ${r === 16 ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
        <label>Micro-batch<input name="micro" inputmode="numeric" value="1"></label><label>Max tokens / example<input name="maxLen" inputmode="numeric" value="2048"></label>
        <button class="btn primary" type="submit" ${!py.finetuneReady || d.train < 3 || running ? 'disabled' : ''}>Fine-tune</button></form>
      <p class="muted tiny">Uses the training options above (${esc(S.opts.device)} · ${esc(S.opts.precision)}). The first run downloads the base model from Hugging Face. Export to Ollama works for Llama-architecture models with byte-level tokenizers (the SmolLM2 family); other bases still train and save, but can't be exported yet. Check each base model's license.</p>`;
  }
  $('#alFt').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const base = f.base.value === 'custom' ? f.custom.value.trim() : f.base.value;
    try {
      await api('/api/ai-lab/finetune', { method: 'POST', body: { base, epochs: Number(f.epochs.value), lr: Number(f.lr.value), r: Number(f.r.value), micro: Number(f.micro.value), maxLen: Number(f.maxLen.value), opts: S.opts } });
      toast('Fine-tuning started'); status.jobs = await api('/api/ai-lab/jobs'); renderFinetune(); renderDesign(); watchJobs();
    } catch (err) { toast(err.message, true); }
  });

  // ---------------- teaching via AIs + review queue ----------------
  async function loadTeach() {
    const box = $('#alTeach');
    if (!box) return;
    let pending = [];
    try { pending = (await api('/api/ai-lab/reviews')).filter((r) => r.verdict === 'pending'); } catch { /* none */ }
    const teachers = (catalog?.models ?? []).filter((m) => m.capabilities.includes('completion'));
    const running = (status.jobs ?? []).some((j) => j.kind === 'teach' && j.status === 'running');
    box.innerHTML = `<h3>Teach via AIs</h3>
      <p class="muted tiny">A teacher model labels many symbols at once. Queue the answers for your review (recommended) or auto-accept them. A bigger local model makes a good teacher for a smaller one.</p>
      <form id="alTeachF"><div class="row"><label>Teacher<select name="teacher">${status.premium ? '<option value="claude">Claude (premium)</option>' : ''}${teachers.map((m) => `<option value="${esc(m.hostId)}|${esc(m.name)}">${esc(m.name)} (${esc(m.params ?? '?')}${m.fit.status === 'incompatible' ? ', slow: partly on CPU' : ''})</option>`).join('')}</select></label>
        <label>Answers<select name="mode"><option value="review">Queue for my review</option><option value="auto">Auto-accept as training data</option></select></label></div>
        <label>Symbols<input name="symbols" value="AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, AMD, SPY, QQQ"></label>
        <button class="btn" type="submit" ${running ? 'disabled' : ''}>Start teaching</button></form>
      ${status.premium ? `<label class="check-row"><input type="checkbox" id="alClaudeTrain" ${status.claudeTraining ? 'checked' : ''}> Allow Claude's answers in training data. <span class="muted tiny">Off by default: Anthropic's terms restrict using Claude outputs to train AI models. Turn on only if your agreement permits it. Claude answers are always usable for review and benchmarking.</span></label>` : ''}
      <p class="muted tiny">Local teachers: check the teacher model's license allows using its outputs for training.</p>
      ${pending.length ? `<h3>Waiting for your review (${pending.length})</h3><div class="scroll"><table><tr><th>Symbol</th><th>Teacher</th><th>Stance</th><th>Thesis</th><th></th></tr>
        ${pending.slice(0, 50).map((r) => `<tr><td><b>${esc(r.symbol)}</b></td><td class="tiny">${esc(r.source)}</td><td>${esc(r.output?.stance)}</td><td class="tiny">${esc(String(r.output?.thesis ?? '').slice(0, 160))}</td>
          <td class="nowrap"><button class="btn ghost" type="button" data-pend="${esc(r.id)}" data-v="accept">Accept</button><button class="btn ghost" type="button" data-pend="${esc(r.id)}" data-v="reject">Reject</button></td></tr>`).join('')}</table></div>` : ''}`;
  }
  $('#alLoop').addEventListener('change', async (e) => {
    if (e.target.id !== 'alClaudeTrain') return;
    try { await api('/api/ai-lab/settings', { method: 'POST', body: { claudeTraining: e.target.checked } }); toast(e.target.checked ? 'Claude answers may now be used for training' : 'Claude answers excluded from training'); } catch (err) { toast(err.message, true); }
  });

  // ---------------- learning loop ----------------
  function renderLoop() {
    $('#alLoop').innerHTML = `<h2>Teach the analyst</h2>
      <p class="muted">Ask your chosen local model and Claude (premium) to analyse the same evidence. Accept, correct or reject each answer: accepted and corrected answers become training data for your own model.
        ${status?.premium ? '' : ' <b>Claude is not configured</b>: add a key in Integrations to use it as the teacher.'}</p>
      <form id="alAsk" class="row"><label>Symbol<input name="symbol" value="AAPL" autocapitalize="characters"></label>
        <button class="btn primary" type="submit">Ask local model</button><button class="btn" type="button" data-who="teach" ${status?.premium ? '' : 'disabled'}>Ask Claude (teacher)</button></form>
      <div id="alAnswers" class="grid two"></div>
      <p class="muted tiny"><span id="alRevCount">${esc(status?.reviews ?? 0)}</span> reviewed examples · download dataset:
        <a href="/api/ai-lab/dataset.jsonl" download>all</a> · <a href="/api/ai-lab/dataset.jsonl?split=train" download>train</a> · <a href="/api/ai-lab/dataset.jsonl?split=dev" download>dev</a> · <a href="/api/ai-lab/dataset.jsonl?split=test" download>test</a>
        (split by symbol, so a symbol never appears in two splits)</p>
      <div id="alTeach"></div>`;
  }
  const answerCard = (slot, who, r) => {
    const a = r.analysis;
    if (!a) return `<div class="card" data-slot="${slot}"><h3>${esc(who)}</h3><p class="err">Not valid JSON for the analyst schema.</p><pre class="wl-log">${esc(r.raw ?? '')}</pre>
      <button class="btn ghost" type="button" data-review="reject">Record as rejected</button></div>`;
    return `<div class="card" data-slot="${slot}"><h3>${esc(who)} <span class="muted tiny">${esc((r.ms / 1000).toFixed(1))} s</span></h3>
      ${r.evidence?.practiceData ? '<p class="muted tiny">Practice data (connect Alpaca for real market data).</p>' : ''}
      <label>Stance<select name="stance">${['bullish', 'neutral', 'bearish'].map((s) => `<option ${s === a.stance ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Confidence<input name="confidence" inputmode="numeric" value="${esc(a.confidence)}"></label>
      <label>Thesis<textarea name="thesis" rows="3">${esc(a.thesis)}</textarea></label>
      <label>Risks (one per line)<textarea name="risks" rows="2">${esc(a.risks.join('\n'))}</textarea></label>
      <label>Lesson<textarea name="lesson" rows="2">${esc(a.lesson)}</textarea></label>
      <div class="bar"><button class="btn primary" type="button" data-review="accept">Accept</button><button class="btn" type="button" data-review="correct">Save my correction</button><button class="btn ghost" type="button" data-review="reject">Reject</button></div></div>`;
  };
  $('#alLoop').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id !== 'alTeachF') return ask('local');
    const f = e.target, [hostId, model] = f.teacher.value === 'claude' ? [null, null] : f.teacher.value.split('|');
    try {
      await api('/api/ai-lab/teach-batch', { method: 'POST', body: { teacher: f.teacher.value === 'claude' ? 'claude' : 'local', hostId, model, mode: f.mode.value, symbols: f.symbols.value.split(/[\s,]+/).filter(Boolean) } });
      toast('Teaching started: answers appear below as they arrive'); status.jobs = await api('/api/ai-lab/jobs'); watchJobs();
    } catch (err) { toast(err.message, true); }
  });
  $('#alLoop').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pend]');
    if (!b) return;
    e.stopImmediatePropagation();
    try { await api('/api/ai-lab/review-pending', { method: 'POST', body: { id: b.dataset.pend, verdict: b.dataset.v } }); b.closest('tr').remove(); await loadStatus(); renderFinetune(); } catch (err) { toast(err.message, true); }
  });
  $('#alLoop').addEventListener('click', async (e) => {
    const b = e.target.closest('button[type=button]');
    if (!b) return;
    if (b.dataset.who === 'teach') return ask('teach');
    if (!b.dataset.review) return;
    const card = b.closest('[data-slot]'), slot = card.dataset.slot;
    const r = S.last[slot];
    const f = (n) => card.querySelector(`[name=${n}]`)?.value ?? '';
    const corrected = r.analysis ? { ...r.analysis, stance: f('stance'), confidence: Number(f('confidence')), thesis: f('thesis'), risks: f('risks').split('\n').filter(Boolean), lesson: f('lesson') } : null;
    try {
      const out = await api('/api/ai-lab/review', { method: 'POST', body: { evidence: r.evidence, output: r.analysis, corrected, verdict: b.dataset.review, source: slot === 'local' ? `local:${r.model}` : `claude:${r.model}` } });
      $('#alRevCount').textContent = out.total;
      toast(b.dataset.review === 'reject' ? 'Rejected (kept out of training)' : out.trainable ? 'Saved as training data' : 'Saved (not trainable: contains third-party news)');
      card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    } catch (err) { toast(err.message, true); }
  });
  async function ask(who) {
    const symbol = $('#alAsk').symbol.value.trim().toUpperCase();
    const out = $('#alAnswers');
    if (out.children.length !== 2) out.innerHTML = '<div data-slot="local"></div><div data-slot="teach"></div>';
    const slotEl = () => out.querySelector(`[data-slot="${who}"]`);
    slotEl().outerHTML = `<div class="card" data-slot="${who}"><div class="empty">${who === 'local' ? 'Local model thinking…' : 'Claude thinking…'}</div></div>`;
    try {
      const r = who === 'local' ? await api('/api/ai-lab/analyze', { method: 'POST', body: { symbol } })
        : await api('/api/ai-lab/teach', { method: 'POST', body: { symbol, evidence: S.last.local?.evidence?.symbol === symbol ? S.last.local.evidence : undefined } });
      S.last[who] = r;
      slotEl().outerHTML = answerCard(who, who === 'local' ? `Local · ${r.model}` : `Claude · ${r.model}`, r);
    } catch (err) { slotEl().outerHTML = `<div class="card" data-slot="${who}"><p class="err">${esc(err.message)}</p></div>`; }
  }

  // ---------------- benchmark + appropriateness ----------------
  function renderBench() {
    const fits = (catalog?.models ?? []).filter((m) => m.fit.status !== 'incompatible' && m.capabilities.includes('completion'));
    $('#alBench').innerHTML = `<h2>Benchmark &amp; pick the best</h2>
      <p class="muted">Runs each model on the same evidence. Agreement is measured against your reviewed answers for the same symbol. The score is a transparent weighted sum, so read the raw numbers too.</p>
      <form id="alBenchF"><div class="bar">${fits.slice(0, 12).map((m, i) => `<label class="check-row"><input type="checkbox" name="m" value="${esc(m.hostId)}|${esc(m.name)}" ${i < 2 ? 'checked' : ''}> ${esc(m.name)}</label>`).join('') || '<span class="muted">No suitable installed models.</span>'}</div>
        <label>Symbols<input name="symbols" value="AAPL, MSFT, NVDA, TSLA, SPY"></label>
        <div class="row"><label>Weight: agreement<input name="wa" value="0.5" inputmode="decimal"></label><label>Weight: valid JSON<input name="wv" value="0.3" inputmode="decimal"></label><label>Weight: speed (p95)<input name="wl" value="0.2" inputmode="decimal"></label></div>
        <button class="btn primary" type="submit">Run benchmark</button></form><div id="alBenchOut"></div>`;
  }
  $('#alBench').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, out = $('#alBenchOut');
    const models = [...f.querySelectorAll('[name=m]:checked')].map((x) => x.value.split('|'));
    const symbols = f.symbols.value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
    if (!models.length || !symbols.length) return toast('Pick at least one model and one symbol', true);
    let reviews = [];
    try { reviews = await api('/api/ai-lab/reviews'); } catch { /* none */ }
    const teacherOf = (sym) => { const r = reviews.find((x) => x.symbol === sym && x.verdict !== 'reject'); return r ? (r.verdict === 'correct' ? r.corrected : r.output)?.stance : null; };
    const results = {};
    for (const [hostId, model] of models) {
      results[model] = [];
      for (const s of symbols) {
        out.innerHTML = `<div class="empty">Running ${esc(model)} on ${esc(s)}…</div>`;
        try { const r = await api('/api/ai-lab/analyze', { method: 'POST', body: { symbol: s, hostId, model } }); results[model].push({ valid: r.valid, stance: r.analysis?.stance ?? null, teacher: teacherOf(s), ms: r.ms }); }
        catch (err) { results[model].push({ valid: false, stance: null, teacher: teacherOf(s), ms: null, error: err.message }); }
      }
    }
    const stats = Object.entries(results).map(([id, rs]) => ({ id, ...benchmarkStats(rs) }));
    let ranked;
    try {
      ranked = appropriateness(stats.map((s) => ({ ...s, agreement: s.agreement ?? undefined })), [
        { key: 'agreement', weight: Number(f.wa.value), dir: 'benefit', floor: 0.34, target: 0.9 },
        { key: 'validity', weight: Number(f.wv.value), dir: 'benefit', floor: 0.8, target: 1 },
        { key: 'p95', weight: Number(f.wl.value), dir: 'cost', ceiling: 30, target: 3 },
      ].filter((m) => m.weight > 0));
    } catch (err) { return fail(out)(err); }
    const noTeacher = stats.every((s) => !s.teacherN);
    out.innerHTML = `${noTeacher && Number(f.wa.value) > 0 ? '<p class="notice">No reviewed answers for these symbols yet, so agreement can\'t be measured and nothing can be ranked. Review a few answers in "Teach the analyst" first, or set the agreement weight to 0 and the others to sum to 1.</p>' : ''}
      <div class="scroll"><table><tr><th>#</th><th>Model</th><th class="num">Score</th><th class="num">Agreement</th><th class="num">Valid JSON</th><th class="num">p50 / p95</th><th class="num">n</th><th></th></tr>
      ${ranked.map((r, i) => `<tr><td>${r.score == null ? '—' : i + 1}</td><td><b>${esc(r.id)}</b></td><td class="num"><b>${r.score ?? 'no rank'}</b>${r.parts ? `<div class="muted tiny">${Object.entries(r.parts).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')}</div>` : `<div class="muted tiny">missing ${esc(r.missing.join(', '))}</div>`}</td>
        <td class="num">${r.agreement == null ? '—' : `${Math.round(r.agreement * 100)}% <span class="muted tiny">of ${esc(r.teacherN)}</span>`}</td><td class="num">${Math.round((r.validity ?? 0) * 100)}%</td><td class="num">${esc(r.p50 ?? '—')} / ${esc(r.p95 ?? '—')} s</td><td class="num">${esc(r.n)}</td>
        <td><button class="btn ghost" type="button" data-use-bench="${esc(r.id)}">Use</button></td></tr>`).join('')}</table></div>
      <p class="muted tiny">Small samples are weak evidence: a handful of symbols can't separate close models. Score = 100 × Σ weight × normalized metric (agreement 34%→90%, valid 80%→100%, p95 30 s→3 s).</p>`;
  });
  $('#alBench').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-use-bench]');
    if (!b) return;
    const m = catalog.models.find((x) => x.name === b.dataset.useBench);
    try { await api('/api/ai-lab/select', { method: 'POST', body: { hostId: m?.hostId ?? 'local', model: b.dataset.useBench } }); toast(`Now using ${b.dataset.useBench}`); await loadStatus(); loadCatalog(); } catch (err) { toast(err.message, true); }
  });

  // ---------------- design your own model ----------------
  function designNumbers() {
    const c = S.cfg, errors = validateArch(c);
    if (errors.length) return { errors };
    const params = scratchParams(c);
    const mem = trainingMemory({ params, layers: c.layers, width: c.width, seq: c.ctx, micro: S.micro ?? 2, vocab: c.vocab });
    const b = status?.budget ?? {};
    const serveGiB = (params * 4) / GiB; // exported as F32 GGUF
    const serveFit = assessFit({ lowGiB: Math.round((serveGiB + 0.3) * 10) / 10, highGiB: Math.round((serveGiB * 1.1 + 0.8) * 10) / 10 }, b);
    const cpuTrain = !status?.python?.cuda;
    const trainFit = cpuTrain ? assessFit(mem, { totalGiB: status?.hardware?.ramTotalGiB, budgetGiB: status?.hardware?.ramFreeGiB }) : assessFit(mem, b);
    const measured = status?.runs?.find((r) => r.cfg?.width === c.width && r.cfg?.layers === c.layers && r.cfg?.ctx === c.ctx && r.tokensPerSec);
    const plan = trainPlan({ tokens: (S.tokensM ?? 5) * 1e6, uniqueTokens: null, seq: c.ctx, micro: S.micro ?? 2, accum: 8, tokensPerSec: measured?.tokensPerSec });
    return { errors, params, mem, trainFit, cpuTrain, serveGiB, serveFit, plan, measured };
  }
  function renderDesign() {
    const n = designNumbers();
    const runs = status?.runs ?? [];
    const running = (status?.jobs ?? []).some((j) => j.status === 'running' && j.kind === 'pilot');
    $('#alDesign').innerHTML = `<div class="bar"><h2>Design your own model</h2><span class="muted tiny">A brand-new model with random weights, sized to your machine, trained on your own text, served by Ollama.</span></div>
      <div class="grid two"><form id="alDesF"><div class="bar">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="btn ghost" data-preset="${esc(k)}" title="${esc(p.label)}">${esc(p.label.split(' (')[0])}</button>`).join('')}</div>
        <div class="row">${FIELDS.map(([k, label]) => `<label>${esc(label)}<input name="${esc(k)}" inputmode="numeric" value="${esc(S.cfg[k])}"></label>`).join('')}</div>
        <label class="check-row"><input type="checkbox" name="tied" ${S.cfg.tied ? 'checked' : ''}> Tie input and output embeddings (fewer parameters)</label>
        <div class="row"><label>Micro-batch<input name="micro" inputmode="numeric" value="${esc(S.micro ?? 2)}"></label><label>Planned training tokens (millions)<input name="tokensM" inputmode="decimal" value="${esc(S.tokensM ?? 5)}"></label></div></form>
      <div>${n.errors.length ? `<ul class="checks">${n.errors.map((x) => `<li class="bad">${esc(x)}</li>`).join('')}</ul>` : `
        <div class="stats">${stat('Parameters', `<b>${esc(n.params.toLocaleString())}</b>`)}${stat(n.cpuTrain ? 'Training memory (RAM)' : 'Training memory (GPU)', `${esc(n.mem.lowGiB)}–${esc(n.mem.highGiB)} GiB ${pill(n.trainFit)}`)}
          ${stat('Served size (F32)', `${n.serveGiB < 1 ? `${esc((n.serveGiB * 1024).toFixed(1))} MiB` : `${esc(n.serveGiB.toFixed(2))} GiB`} ${pill(n.serveFit)}`)}${stat('Updates for plan', esc(n.plan.updates.toLocaleString()))}
          ${stat('Training time', n.plan.hours != null ? `${esc(n.plan.hours)} h <span class="muted tiny">at measured ${esc(Math.round(n.measured.tokensPerSec))} tok/s</span>` : '<span class="muted">run a pilot to measure</span>')}</div>
        <p class="muted tiny">Memory: weights + gradients + AdamW state (16 bytes/parameter) + activations, estimated. A pilot measures real speed${n.cpuTrain ? '; your PyTorch trains on the CPU, so training is checked against free RAM' : ''}.</p>`}
        <div class="bar"><button class="btn" type="button" data-des="build" ${n.errors.length || !status?.python?.ready ? 'disabled' : ''}>Build &amp; verify</button>
          <label>Steps<input id="alSteps" class="tiny-in" inputmode="numeric" value="200"></label>
          <button class="btn primary" type="button" data-des="pilot" ${n.errors.length || !status?.python?.ready || running ? 'disabled' : ''}>Train pilot</button></div>
        <div id="alDesOut"></div></div></div>
      <details><summary>Training text</summary>
        <p class="muted tiny">Each pilot trains on: the Academy lessons, your journal theses, your accepted/corrected analyst answers, plus any text you add here (your own writing or text you have the right to use).</p>
        <form id="alCorpus"><textarea name="text" rows="4" maxlength="60000" placeholder="Paste text to add to the training corpus…"></textarea><div class="bar"><button class="btn" type="submit">Add text</button><label class="check-row"><input type="checkbox" name="replace"> Replace previously added text</label></div></form></details>
      <h3>Jobs &amp; runs</h3><div id="alJobs">${renderJobs()}</div>
      ${runs.length ? `<div class="scroll"><table><tr><th>Run</th><th class="num">Parameters</th><th class="num">Loss start → end</th><th class="num">Speed</th><th>Device</th><th></th></tr>
        ${runs.map((r) => `<tr><td class="mono tiny">${esc(r.id)}${r.kind === 'finetune' ? `<div class="muted tiny">fine-tune of ${esc(r.base)} · ${esc(r.examples)} examples${r.devLossBefore != null ? ` · dev loss ${esc(r.devLossBefore)} → ${esc(r.devLossAfter)}` : ''}</div>` : ''}</td><td class="num">${esc(fmtN(r.params))}${r.cfg && r.vocab < r.cfg.vocab ? `<div class="muted tiny">vocab ${esc(r.vocab)} of ${esc(r.cfg.vocab)}: small corpus</div>` : ''}</td><td class="num">${esc(r.lossStart)} → <b>${esc(r.lossEnd)}</b>${r.lossEnd < 0.5 ? '<div class="muted tiny">very low: likely memorizing, add more text</div>' : ''}</td><td class="num">${esc(Math.round(r.tokensPerSec))} tok/s</td><td>${esc(r.trainDevice ?? r.device)}${r.precision ? ` · ${esc(r.precision)}` : ''}</td>
          <td>${r.exported ? `<span class="pill bullish">in Ollama as ${esc(r.exported.name)}</span>` : `<button class="btn ghost" type="button" data-export="${esc(r.id)}">Export to Ollama</button>`}</td></tr>`).join('')}</table></div>` : ''}
      <p class="muted tiny">Honest scale note: a model this small learns the patterns and wording of its training text; it won't reason like a 7B+ model. For analyst quality, start from an existing model in the catalog and use this designer to explore, or train larger on a GPU with much more text.</p>`;
  }
  function renderJobs() {
    const jobs = status?.jobs ?? [];
    return jobs.length ? jobs.slice(0, 6).map((j) => `<div class="bar"><span class="pill ${j.status === 'done' ? 'bullish' : j.status === 'failed' ? 'bearish' : 'neutral'}">${esc(j.kind)} · ${esc(j.status)}</span>
      <span class="tiny">${esc(j.error ?? j.progress ?? '')}${j.loss != null ? ` · loss ${esc(j.loss)}` : ''}</span></div>`).join('') : '<p class="muted tiny">No jobs yet.</p>';
  }
  let jobTimer = null;
  function watchJobs() {
    clearInterval(jobTimer);
    jobTimer = setInterval(async () => {
      if (!document.body.contains(el)) return clearInterval(jobTimer);
      try {
        status.jobs = await api('/api/ai-lab/jobs');
        const box = $('#alJobs');
        if (box) box.innerHTML = renderJobs();
        if (!status.jobs.some((j) => j.status === 'running')) { clearInterval(jobTimer); await loadStatus(); renderSetup(); renderFinetune(); renderDesign(); loadCatalog(); loadTeach(); }
      } catch { clearInterval(jobTimer); }
    }, 2000);
  }
  $('#alDesign').addEventListener('input', (e) => {
    const f = e.target.closest('#alDesF');
    if (!f) return;
    for (const [k] of FIELDS) S.cfg[k] = Number(f[k].value);
    S.cfg.tied = f.tied.checked; S.micro = Number(f.micro.value) || 2; S.tokensM = Number(f.tokensM.value) || 5;
    const focus = e.target.name, pos = e.target.selectionStart;
    renderDesign();
    const again = $('#alDesF')?.elements[focus];
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* checkbox */ } }
  });
  $('#alDesign').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id !== 'alCorpus') return;
    try { const r = await api('/api/ai-lab/corpus', { method: 'POST', body: { text: e.target.text.value, replace: e.target.replace.checked } }); toast(`Added. Corpus now ${r.totalChars.toLocaleString()} characters`); e.target.text.value = ''; } catch (err) { toast(err.message, true); }
  });
  $('#alDesign').addEventListener('click', async (e) => {
    const b = e.target.closest('button[type=button]');
    if (!b) return;
    const out = $('#alDesOut');
    try {
      if (b.dataset.preset) { S.cfg = { ...PRESETS[b.dataset.preset].cfg }; return renderDesign(); }
      if (b.dataset.des === 'build') {
        out.innerHTML = '<div class="empty">Constructing the model in Python (no downloads)…</div>';
        const r = await api('/api/ai-lab/build', { method: 'POST', body: { cfg: S.cfg } });
        out.innerHTML = `<p class="up">Built: ${esc(r.params.toLocaleString())} parameters (matches the designer) in ${esc(r.seconds)} s on ${esc(r.device)}. Initial weights hash <span class="mono tiny">${esc(r.initHash.slice(0, 16))}…</span>: the same seed always gives the same start.</p>`;
      }
      if (b.dataset.des === 'pilot') {
        await api('/api/ai-lab/pilot', { method: 'POST', body: { cfg: S.cfg, steps: Number($('#alSteps').value), micro: S.micro ?? 2, lr: S.cfg.width <= 256 ? 0.003 : 0.0003, opts: S.opts } });
        toast('Training started'); await loadStatus(); renderDesign(); watchJobs();
      }
      if (b.dataset.export) {
        const name = prompt('Name for the model in Ollama (it will be prefixed with sw-):', `analyst-${new Date().toISOString().slice(5, 10)}`);
        if (!name) return;
        b.disabled = true; b.textContent = 'Exporting…';
        const r = await api('/api/ai-lab/export', { method: 'POST', body: { runId: b.dataset.export, name } });
        toast(`${r.name} is now in Ollama`);
        await loadStatus(); renderDesign(); loadCatalog();
        $('#alDesOut').innerHTML = `<p class="up">Exported ${esc(r.name)} (GGUF ${esc((r.bytes / 2 ** 20).toFixed(1))} MiB, sha256 ${esc(r.sha256.slice(0, 12))}…). Sample: <i>Risk first:</i>${esc(r.sample ?? '')}</p>${r.sampleError ? `<p class="err">${esc(r.sampleError)}</p>` : ''}`;
      }
    } catch (err) { out.innerHTML = `<p class="err">${esc(err.message)}</p>`; if (b.dataset.export) { b.disabled = false; b.textContent = 'Export to Ollama'; } }
  });

  (async () => {
    try { await loadStatus(); } catch (e) { return fail($('#alHw'))(e); }
    renderSetup(); renderLoop(); renderFinetune(); renderDesign(); await loadCatalog(); loadTeach();
    if (status.jobs.some((j) => j.status === 'running')) watchJobs();
  })();
}
