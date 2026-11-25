// AI Lab API: hardware-aware model catalog (Ollama hosts + Hugging Face), local analyst with structured output,
// Claude as the premium teacher, reviewed examples -> dataset, and a from-scratch model designer (Python worker).
// Owner-only: wired into server.js routes; none of these are reachable from the phone listener.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { probeHardware } from './hardware.js';
import { createOllama, validHostUrl } from './ollama.js';
import { effectiveBudget, estimateVariant, assessFit, validateArch, scratchParams, trainingMemory } from './modelfit.js';
import { ANALYSIS_SCHEMA, analystUserPrompt, buildDataset, torchVariant, trainOptions, ANALYST_OPTIONS } from './ailab.js';
import { ANALYST_SYSTEM, normalizeAnalysis, analyzeSymbol } from './ai.js';
import { scoreSeries } from './signals.js';
import { HttpError } from './providers.js';

/** Research text taught by the Research tab and Autopilot learning tasks (written by server.js, inside dataDir/ai). */
export const RESEARCH_CORPUS = 'corpus-research.txt';
const MODEL_RE = /^[\w.\-/:]{1,200}$/;
const EXPORT_NAME_RE = /^sw-[a-z0-9][a-z0-9._-]{0,40}$/;
const SYS_PY = process.env.PYTHON || 'python';
const HF_ID_RE = /^[\w.-]{1,96}\/[\w.-]{1,96}$/;
// Small instruction models whose architecture + tokenizer the GGUF exporter handles (Llama + byte-level BPE).
const FINETUNE_BASES = [
  { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', note: '135M · fast, fine on CPU' },
  { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', note: '360M · good starting point' },
  { id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', note: '1.7B · best quality, wants a GPU' },
];
const defaultHost = () => {
  const h = String(process.env.OLLAMA_HOST || '127.0.0.1:11434').replace('0.0.0.0', '127.0.0.1');
  return validHostUrl(/^https?:\/\//.test(h) ? h : `http://${h}`) ?? 'http://127.0.0.1:11434';
};

export function createAiLab({ state, saveState, dataDir, rootDir, analyzeOne, alpacaConfigured, audit, lessons, aiAllowed }) {
  state.ai = {
    profiles: [{ id: 'idle', name: 'Idle', reserveGiB: 1 }, { id: 'obs', name: 'OBS live / gaming', reserveGiB: 4 }],
    profile: 'idle', hosts: [{ id: 'local', name: 'This PC', url: defaultHost() }], selection: null, reviews: [], runs: [],
    ...(state.ai ?? {}),
  };
  const ai = state.ai;
  const AI_DIR = path.join(dataDir, 'ai');
  const jobs = new Map(); // id -> {id, kind, status, progress, result, error, startedAt}
  const showCache = new Map(); // digest -> model_info
  let hwCache = null, pyCache = null;

  const host = (id) => { const h = ai.hosts.find((x) => x.id === (id || 'local')); if (!h) throw new HttpError(404, 'Unknown Ollama host'); return h; };
  const ollamaFor = (id) => createOllama(host(id).url);
  const hardware = async () => (hwCache && Date.now() - hwCache.at < 10_000 ? hwCache : (hwCache = await probeHardware(dataDir)));
  const profile = () => ai.profiles.find((p) => p.id === ai.profile) ?? ai.profiles[0];
  const budgetOf = (hw) => {
    const g = hw.gpus[0];
    return g ? { totalGiB: g.totalGiB, freeGiB: g.freeGiB, budgetGiB: g.freeGiB == null ? null : effectiveBudget({ freeGiB: g.freeGiB, reserveGiB: profile().reserveGiB }) } : { totalGiB: null, freeGiB: null, budgetGiB: null };
  };
  // Python children get the environment minus secrets (API keys, passwords, tokens): they never need them.
  // One environment per machine (not per profile): installed once, used by the exe, source runs and tests.
  const VENV = process.env.STOCKSWORKS_PYENV || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'StocksWorks', 'pyenv');
  const venvPy = path.join(VENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const pyExe = () => (fs.existsSync(venvPy) ? venvPy : SYS_PY); // the app's own environment once installed
  const childEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|SECRET|TOKEN|PASSWORD|HASH|TOTP|ACK|WEBHOOK|_URL$|RPC|SEC_CONTACT/i.test(k))), HF_HUB_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' });
  /** Async, so a slow first import of torch never stalls the server (kill switch included). */
  const runCmd = (cmd, args, opts = {}) => new Promise((resolve) => {
    const c = spawn(cmd, args, { windowsHide: true, env: childEnv(), ...opts });
    let out = '', err = '';
    const t = setTimeout(() => c.kill(), opts.timeout ?? 60_000);
    c.stdout.on('data', (d) => { out = (out + d).slice(-100_000); });
    c.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    c.on('error', (e) => { clearTimeout(t); resolve({ status: -1, out, err: e.message }); });
    c.on('exit', (status) => { clearTimeout(t); resolve({ status, out, err }); });
  });
  const python = () => (pyCache ??= runCmd(pyExe(), ['-c', 'import json,importlib.util as u;m={k:bool(u.find_spec(k)) for k in ["torch","transformers","tokenizers","safetensors","numpy","peft"]};import sys;cuda=False;bf16=False;tv=None;dev=None\ntry:\n import torch;tv=torch.__version__;cuda=torch.cuda.is_available();bf16=bool(cuda and torch.cuda.is_bf16_supported());dev=torch.cuda.get_device_name(0) if cuda else None\nexcept Exception: pass\nprint(json.dumps({"version":sys.version.split()[0],"modules":m,"cuda":cuda,"bf16":bf16,"torch":tv,"device":dev}))']).then((r) => {
    let info = null;
    try { info = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { /* missing */ }
    const ready = Boolean(info && ['torch', 'transformers', 'tokenizers', 'safetensors', 'numpy'].every((k) => info.modules[k]));
    return { found: Boolean(info), ready, ...(info ?? {}), exe: pyExe(), appEnv: pyExe() === venvPy, finetuneReady: ready && Boolean(info?.modules?.peft), missing: info ? Object.entries(info.modules).filter(([k, v]) => !v && k !== 'peft').map(([k]) => k) : ['python'] };
  }));
  let workerBusy = null; // one model job (build / pilot / export) at a time: they compete for the same RAM, GPU and disk
  const claimWorker = (what) => { if (workerBusy) throw new HttpError(409, `A model job is already running (${workerBusy}); wait for it to finish`); workerBusy = what; };

  // ---------------- Python worker (copied out of the app so it also runs from the packaged exe) ----------------
  function workerPath() {
    fs.mkdirSync(AI_DIR, { recursive: true });
    const dest = path.join(AI_DIR, 'ai_worker.py');
    fs.writeFileSync(dest, fs.readFileSync(path.join(rootDir, 'tools', 'ai_worker.py')));
    return dest;
  }
  /** Caller must hold the worker claim (claimWorker); this releases it when the worker exits. */
  async function runWorker(job, onLine, timeoutMs = 2 * 3600_000) {
    try {
      const py = await python();
      if (!py.ready) throw new HttpError(409, `Python model tools missing: ${py.missing.join(', ')}. Install with: python -m pip install torch transformers tokenizers safetensors numpy`);
      return await spawnWorker(job, onLine, timeoutMs);
    } finally { workerBusy = null; }
  }
  function spawnWorker(job, onLine, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(pyExe(), [workerPath()], { windowsHide: true, env: { ...childEnv(), ...(job.online ? { HF_HUB_OFFLINE: '0' } : {}) } });
      child.stdin.on('error', () => { /* worker exited early: reported via exit below */ });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      let buf = '', last = null, err = '';
      child.stdout.on('data', (d) => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          try { const o = JSON.parse(line); if (o.progress) onLine?.(o); else last = o; } catch { /* not ours */ }
        }
      });
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      child.on('error', (e) => { clearTimeout(timer); reject(new HttpError(500, `Could not start Python: ${e.message}`)); });
      child.on('exit', () => {
        clearTimeout(timer);
        if (last?.ok) resolve(last);
        else reject(new HttpError(422, last?.error || `Worker failed: ${err.split(/\r?\n/).filter(Boolean).pop() || 'no output'}`));
      });
      child.stdin.end(JSON.stringify(job));
    });
  }
  function startJob(kind, fn) {
    if ([...jobs.values()].some((j) => j.status === 'running' && ['pilot', 'pull'].includes(j.kind) && ['pilot', 'pull'].includes(kind)))
      throw new HttpError(409, 'Another training or download job is running; wait for it to finish');
    const j = { id: crypto.randomUUID(), kind, status: 'running', progress: 'starting', startedAt: Date.now() };
    jobs.set(j.id, j);
    for (const [id, old] of jobs) if (jobs.size > 50 && old.status !== 'running') jobs.delete(id); // bounded history
    fn(j).then((result) => Object.assign(j, { status: 'done', result, progress: 'done' }), (e) => Object.assign(j, { status: 'failed', error: e.message }));
    return { jobId: j.id };
  }

  // ---------------- evidence: real market data when the broker is connected, otherwise labelled practice data ----------------
  function practicePack(symbol) {
    let seed = [...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const drift = (rnd() - 0.45) * 0.004, closes = [100];
    for (let i = 1; i < 260; i++) closes.push(Math.max(1, closes[i - 1] * (1 + drift + (rnd() - 0.5) * 0.03)));
    return { symbol, asOf: new Date().toISOString().slice(0, 10), signal: scoreSeries(closes), backtest: null, news: [], practiceData: 'synthetic series for model comparison, not market data' };
  }
  async function evidenceFor(symbol) {
    if (!/^[A-Z]{1,5}(\.[A-Z])?$|^[A-Z0-9]{2,10}\/USD[CT]?$/.test(symbol)) throw new HttpError(400, 'Invalid symbol');
    if (!alpacaConfigured()) return practicePack(symbol);
    const d = await analyzeOne(symbol);
    return { symbol, asOf: new Date().toISOString(), signal: d.signal, backtest: d.backtest, news: [] };
  }
  async function localAnalyze({ hostId, model, evidence }) {
    const t = Date.now();
    const r = await ollamaFor(hostId).chat({ model, format: ANALYSIS_SCHEMA, options: ANALYST_OPTIONS, messages: [{ role: 'system', content: ANALYST_SYSTEM }, { role: 'user', content: analystUserPrompt(evidence) }] });
    let parsed = null;
    try { parsed = JSON.parse(r.message?.content ?? ''); } catch { /* invalid */ }
    const cutOff = r.done_reason === 'length'; // hit ANALYST_OPTIONS.num_predict: the model looped or rambled
    const valid = !cutOff && Boolean(parsed && ['bullish', 'bearish', 'neutral'].includes(parsed.stance));
    return { analysis: parsed ? normalizeAnalysis(parsed) : null, valid, raw: valid ? undefined : String(r.message?.content ?? '').slice(0, 500), ms: Date.now() - t, evalCount: r.eval_count ?? null, model };
  }

  /** Keep the newest 50 run records, and delete the folders (corpus copies, checkpoints, GGUFs) of the ones dropped. */
  function keepRun(rec) {
    ai.runs.unshift(rec);
    for (const old of ai.runs.slice(50)) if (/^[\w-]{1,64}$/.test(String(old?.id))) fs.rm(path.join(AI_DIR, 'runs', old.id), { recursive: true, force: true }, () => {});
    ai.runs = ai.runs.slice(0, 50); saveState();
  }

  function corpusText() {
    const parts = lessons.map((l) => `${l.title}\n${l.body}`);
    for (const j of state.journal ?? []) if (j.thesis) parts.push(String(j.thesis));
    for (const r of ai.reviews) if (r.verdict !== 'reject' && r.trainable !== false) { const o = r.verdict === 'correct' ? r.corrected : r.output; if (o?.thesis) parts.push(`${o.thesis} ${o.lesson ?? ''}`); }
    for (const name of ['corpus-user.txt', RESEARCH_CORPUS]) { // your uploads + what Research/Autopilot taught it
      const f = path.join(AI_DIR, name);
      if (fs.existsSync(f)) parts.push(fs.readFileSync(f, 'utf8'));
    }
    return parts.join('\n');
  }

  return {
    'GET /api/ai-lab/status': async () => {
      const hw = await hardware();
      return {
        hardware: hw, budget: budgetOf(hw), profiles: ai.profiles, profile: ai.profile, hosts: ai.hosts, selection: ai.selection,
        python: await python(), reviews: ai.reviews.length, runs: ai.runs.slice(0, 20), jobs: [...jobs.values()].slice(-20).reverse(),
        premium: aiAllowed(), setup: { recommended: torchVariant({ driver: hw.gpus[0]?.driver }), appEnv: fs.existsSync(venvPy), dir: VENV, installed: ai.pyenv ?? null },
        finetuneBases: FINETUNE_BASES, claudeTraining: ai.claudeTraining === true, pending: ai.reviews.filter((r) => r.verdict === 'pending').length,
        dataset: buildDataset(ai.reviews, ANALYST_SYSTEM).reduce((c, r) => { c[r.meta.split]++; return c; }, { train: 0, dev: 0, test: 0 }),
      };
    },
    'POST /api/ai-lab/profile': ({ body }) => {
      if (body.id && ai.profiles.some((p) => p.id === body.id) && body.reserveGiB === undefined) { ai.profile = body.id; saveState(); return { ok: true }; }
      const name = String(body.name ?? '').trim().slice(0, 30), reserve = Number(body.reserveGiB);
      if (!/^[\w ./()-]{1,30}$/.test(name) || !(reserve >= 0 && reserve <= 256)) throw new HttpError(400, 'Profile: a name and a reserve of 0-256 GiB');
      const existing = ai.profiles.find((p) => p.name === name);
      if (existing) existing.reserveGiB = reserve; else { if (ai.profiles.length >= 10) throw new HttpError(400, 'At most 10 profiles'); ai.profiles.push({ id: crypto.randomUUID().slice(0, 8), name, reserveGiB: reserve }); }
      ai.profile = (existing ?? ai.profiles.at(-1)).id; saveState();
      return { ok: true };
    },
    'POST /api/ai-lab/hosts': async ({ body }) => {
      const url = validHostUrl(body.url);
      if (!url) throw new HttpError(400, 'Host must be http(s)://host:port, e.g. http://192.168.1.30:11434');
      const name = String(body.name ?? '').trim().slice(0, 30) || new URL(url).host;
      if (ai.hosts.length >= 8) throw new HttpError(400, 'At most 8 hosts');
      const v = await createOllama(url).version(); // prove it's an Ollama server before saving it
      ai.hosts.push({ id: crypto.randomUUID().slice(0, 8), name: name.replace(/[^\w .()-]/g, ''), url, version: v.version ?? null });
      saveState(); audit.write({ type: 'ai.host.add', url });
      return { ok: true };
    },
    'DELETE /api/ai-lab/hosts': ({ url }) => {
      const id = url.searchParams.get('id');
      if (id === 'local') throw new HttpError(400, 'This PC stays listed');
      ai.hosts = ai.hosts.filter((h) => h.id !== id); saveState();
      return { ok: true };
    },

    /** Installed models on every host, each with a VRAM estimate and a fit verdict for the active profile. */
    'GET /api/ai-lab/catalog': async ({ url }) => {
      const ctx = Math.min(131_072, Math.max(256, Number(url.searchParams.get('ctx')) || 8192));
      const parallel = Math.min(16, Math.max(1, Number(url.searchParams.get('parallel')) || 1));
      const hw = await hardware(), b = budgetOf(hw);
      const out = [], errors = [];
      for (const h of ai.hosts) {
        let models, resident = new Set();
        try { const o = createOllama(h.url); [models, resident] = await Promise.all([o.tags(), o.ps().then((p) => new Set(p.map((m) => m.digest))).catch(() => new Set())]); } catch (e) { errors.push({ host: h.name, error: e.message }); continue; }
        const o = createOllama(h.url);
        models = models.slice(0, 200); // a misbehaving host can't make us issue unbounded /api/show calls
        for (let i = 0; i < models.length; i += 4) {
          await Promise.all(models.slice(i, i + 4).map(async (m) => {
            if (showCache.has(m.digest)) return;
            // Failures aren't cached (a busy host shouldn't leave a model "Unknown" until restart).
            const meta = await o.show(m.name).then((s) => ({ info: s.model_info ?? {}, license: String(s.license ?? '').split('\n')[0].slice(0, 80), caps: s.capabilities ?? [] })).catch(() => null);
            if (!meta) return;
            showCache.set(m.digest, meta);
            if (showCache.size > 500) showCache.delete(showCache.keys().next().value);
          }));
        }
        for (const m of models) {
          const meta = showCache.get(m.digest) ?? { info: {} };
          const est = estimateVariant({ sizeBytes: m.size, info: meta.info, ctx, parallel });
          const local = h.id === 'local';
          const fit = local ? assessFit(est, b) : { status: 'unknown', reason: 'Remote host: open StocksWorks on that machine to measure its GPU' };
          if (local && resident.has(m.digest)) fit.note = 'Already loaded: free memory already excludes it, so the estimate double-counts';
          out.push({
            hostId: h.id, hostName: h.name, name: m.name, digest: m.digest, family: m.details?.family, params: m.details?.parameter_size,
            quant: m.details?.quantization_level, format: m.details?.format, sizeBytes: m.size, ctxMax: meta.info?.[`${meta.info?.['general.architecture']}.context_length`] ?? null,
            capabilities: meta.caps ?? [], license: meta.license ?? '', est, fit, resident: resident.has(m.digest), selected: ai.selection?.model === m.name && ai.selection?.hostId === h.id,
          });
        }
      }
      return { models: out, errors, ctx, parallel, budget: b, profile: profile(), hardwareAt: hw.at };
    },
    /** Hugging Face Hub metadata search (no weights downloaded). GGUF repos can be pulled into Ollama. */
    'GET /api/ai-lab/hf': async ({ url }) => {
      const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 80);
      if (!q) throw new HttpError(400, 'Type a search');
      const p = new URLSearchParams({ search: q, limit: '24', sort: 'downloads', direction: '-1' });
      if (url.searchParams.get('gguf') === '1') p.set('filter', 'gguf');
      const r = await fetch(`https://huggingface.co/api/models?${p}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' }).catch(() => null);
      if (!r?.ok) throw new HttpError(502, 'Hugging Face search is unavailable right now');
      const list = await r.json();
      return (Array.isArray(list) ? list : []).map((m) => ({
        id: String(m.id), task: m.pipeline_tag ?? null, downloads: m.downloads ?? null, likes: m.likes ?? null, updated: m.lastModified ?? null,
        gguf: (m.tags ?? []).includes('gguf'), tags: (m.tags ?? []).filter((t) => !/^(arxiv|base_model|dataset|region|license):/.test(t)).slice(0, 8),
        license: (m.tags ?? []).find((t) => t.startsWith('license:'))?.slice(8) ?? null, url: `https://huggingface.co/${m.id}`,
      }));
    },
    'POST /api/ai-lab/pull': ({ body }) => {
      const model = String(body.model ?? '');
      if (!MODEL_RE.test(model)) throw new HttpError(400, 'Model name like llama3.2:3b or hf.co/owner/repo-GGUF:Q4_K_M');
      const h = host(body.hostId);
      return startJob('pull', async (j) => {
        j.progress = `downloading ${model} to ${h.name} (this can take a long time)`;
        const r = await fetch(`${h.url}/api/pull`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: false }), signal: AbortSignal.timeout(6 * 3600_000) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || `pull failed (${r.status})`);
        audit.write({ type: 'ai.pull', model, host: h.name });
        return { model, status: d.status };
      });
    },
    'POST /api/ai-lab/select': async ({ body }) => {
      const h = host(body.hostId), model = String(body.model ?? '');
      const m = (await createOllama(h.url).tags()).find((x) => x.name === model);
      if (!m) throw new HttpError(404, 'That model is not installed on this host');
      ai.selection = { rev: (ai.selection?.rev ?? 0) + 1, mode: 'existing', hostId: h.id, model, digest: m.digest, at: Date.now() };
      saveState(); audit.write({ type: 'ai.select', model, digest: m.digest, host: h.name });
      return ai.selection;
    },

    // ---------------- learning loop ----------------
    'POST /api/ai-lab/analyze': async ({ body }) => {
      const sel = body.model ? { hostId: body.hostId, model: String(body.model) } : ai.selection;
      if (!sel) throw new HttpError(409, 'Choose a model first (catalog → Use)');
      if (!MODEL_RE.test(sel.model)) throw new HttpError(400, 'Invalid model name');
      const evidence = await evidenceFor(String(body.symbol ?? '').toUpperCase());
      return { ...(await localAnalyze({ hostId: sel.hostId, model: sel.model, evidence })), evidence, hostId: sel.hostId ?? 'local' };
    },
    /** Premium teacher: Claude analyses the same evidence; the user reviews before it becomes training data. */
    'POST /api/ai-lab/teach': async ({ req, body }) => {
      if (!aiAllowed(req)) throw new HttpError(409, 'Claude is not configured or the hourly AI limit is reached');
      const evidence = body.evidence ? cleanEvidence(body.evidence) : await evidenceFor(String(body.symbol ?? '').toUpperCase());
      const t = Date.now();
      const a = await analyzeSymbol({ symbol: evidence.symbol, signal: evidence.signal, backtest: evidence.backtest, news: evidence.news ?? [], web: false });
      return { analysis: normalizeAnalysis(a), model: a.model, ms: Date.now() - t, evidence };
    },
    'POST /api/ai-lab/review': ({ body }) => {
      const verdict = String(body.verdict ?? '');
      if (!['accept', 'correct', 'reject'].includes(verdict)) throw new HttpError(400, 'verdict: accept, correct or reject');
      const evidence = cleanEvidence(body.evidence);
      const symbol = evidence.symbol;
      const rec = {
        id: crypto.randomUUID(), at: Date.now(), symbol, evidence, source: String(body.source ?? '').slice(0, 120), verdict,
        output: body.output ? normalizeAnalysis(body.output) : null, corrected: verdict === 'correct' ? normalizeAnalysis(body.corrected ?? {}) : null,
        trainable: body.trainable !== false && evidence.news.length === 0 && (ai.claudeTraining === true || !String(body.source ?? '').startsWith('claude')), // news: third-party; Claude: provider terms
        practice: Boolean(evidence.practiceData),
        note: String(body.note ?? '').slice(0, 500),
      };
      ai.reviews.unshift(rec); ai.reviews = ai.reviews.slice(0, 5000); saveState();
      return { ok: true, id: rec.id, trainable: rec.trainable, total: ai.reviews.length };
    },
    'GET /api/ai-lab/reviews': () => ai.reviews.slice(0, 300).map(({ evidence, ...r }) => ({ ...r, practice: Boolean(evidence?.practiceData) })),
    /** Accept or reject a teacher's queued suggestion. */
    'POST /api/ai-lab/review-pending': ({ body }) => {
      const r = ai.reviews.find((x) => x.id === body.id && x.verdict === 'pending');
      if (!r) throw new HttpError(404, 'No such queued suggestion');
      if (!['accept', 'reject'].includes(body.verdict)) throw new HttpError(400, 'verdict: accept or reject');
      r.verdict = body.verdict; r.reviewedAt = Date.now(); saveState();
      return { ok: true };
    },
    'POST /api/ai-lab/settings': ({ body }) => {
      if (typeof body.claudeTraining === 'boolean') { ai.claudeTraining = body.claudeTraining; audit.write({ type: 'ai.claude-training', on: body.claudeTraining }); }
      saveState();
      return { claudeTraining: ai.claudeTraining === true };
    },
    /** Teaching via AIs: a teacher (Claude or a local model) labels many symbols; queued for review or auto-accepted. */
    'POST /api/ai-lab/teach-batch': ({ req, body }) => {
      const symbols = [...new Set((Array.isArray(body.symbols) ? body.symbols : []).map((s) => String(s).trim().toUpperCase()))].slice(0, 50);
      if (!symbols.length) throw new HttpError(400, 'List 1-50 symbols');
      const mode = body.mode === 'auto' ? 'auto' : 'review';
      const t = body.teacher === 'claude' ? { kind: 'claude' } : { kind: 'local', hostId: String(body.hostId || 'local'), model: String(body.model ?? '') };
      if (t.kind === 'claude' && !aiAllowed()) throw new HttpError(409, 'Claude is not configured');
      if (t.kind === 'local') { host(t.hostId); if (!MODEL_RE.test(t.model)) throw new HttpError(400, 'Pick a teacher model'); }
      return startJob('teach', async (j) => {
        let done = 0, failed = 0;
        for (const symbol of symbols) {
          j.progress = `${t.kind === 'claude' ? 'Claude' : t.model} labelling ${symbol} (${done + failed + 1}/${symbols.length})`;
          try {
            const evidence = await evidenceFor(symbol);
            let output, source;
            if (t.kind === 'claude') {
              if (!aiAllowed(req)) throw new Error('hourly AI limit reached');
              const a = await analyzeSymbol({ symbol, signal: evidence.signal, backtest: evidence.backtest, news: [], web: false });
              output = normalizeAnalysis(a); source = `claude:${a.model}`;
            } else {
              const r = await localAnalyze({ hostId: t.hostId, model: t.model, evidence });
              if (!r.valid) throw new Error('teacher returned invalid JSON');
              output = r.analysis; source = `teacher:${t.model}`;
            }
            const trainable = evidence.news.length === 0 && (t.kind === 'local' || ai.claudeTraining === true);
            ai.reviews.unshift({ id: crypto.randomUUID(), at: Date.now(), symbol, evidence, source, verdict: mode === 'auto' ? 'accept' : 'pending', auto: mode === 'auto', output, corrected: null, trainable, practice: Boolean(evidence.practiceData) });
            done++;
          } catch (e) { failed++; j.lastError = `${symbol}: ${e.message}`; }
        }
        ai.reviews = ai.reviews.slice(0, 5000); saveState();
        audit.write({ type: 'ai.teach-batch', teacher: t.kind === 'claude' ? 'claude' : t.model, mode, done, failed });
        if (!done) throw new Error(j.lastError || 'teacher produced nothing');
        return { done, failed, mode };
      });
    },
    'DELETE /api/ai-lab/reviews': ({ url }) => { ai.reviews = ai.reviews.filter((r) => r.id !== url.searchParams.get('id')); saveState(); return { ok: true }; },
    'GET /api/ai-lab/dataset.jsonl': ({ url }) => {
      const split = url.searchParams.get('split');
      if (split && !['train', 'dev', 'test'].includes(split)) throw new HttpError(400, 'split: train, dev or test');
      const rows = buildDataset(ai.reviews, ANALYST_SYSTEM).filter((r) => !split || r.meta.split === split);
      return { __csv: rows.map((r) => JSON.stringify(r)).join('\n'), filename: `stocksworks-analyst-${split || 'all'}.jsonl` };
    },

    // ---------------- design your own model ----------------
    'POST /api/ai-lab/corpus': ({ body }) => {
      const text = String(body.text ?? '');
      if (text.length > 60_000) throw new HttpError(413, 'Up to 60,000 characters per upload (send more in parts)');
      fs.mkdirSync(AI_DIR, { recursive: true });
      const f = path.join(AI_DIR, 'corpus-user.txt');
      if (body.replace !== true && fs.existsSync(f) && fs.statSync(f).size + text.length > 20 * 2 ** 20) throw new HttpError(413, 'Added text is capped at 20 MB; replace it or start over');
      if (body.replace === true) fs.writeFileSync(f, text); else fs.appendFileSync(f, `\n${text}`);
      return { ok: true, chars: fs.statSync(f).size, totalChars: corpusText().length };
    },
    'POST /api/ai-lab/build': async ({ body }) => {
      const cfg = cfgOf(body.cfg);
      if (scratchParams(cfg) > 400_000_000) throw new HttpError(400, 'Build & verify is limited to 400M parameters (the check copies all weights to hash them)');
      claimWorker('build');
      const r = await runWorker({ cmd: 'build', cfg }, null, 10 * 60_000);
      if (r.params !== scratchParams(cfg)) throw new HttpError(500, `Parameter count mismatch: model ${r.params}, designer ${scratchParams(cfg)}`);
      return r;
    },
    'POST /api/ai-lab/pilot': async ({ body }) => {
      const cfg = cfgOf(body.cfg);
      const steps = Math.round(Number(body.steps)), micro = Math.round(Number(body.micro || 2)), lr = Number(body.lr || 3e-4);
      if (!(steps >= 5 && steps <= 20_000) || !(micro >= 1 && micro <= 64) || !(lr > 0 && lr <= 0.01)) throw new HttpError(400, 'steps 5-20000, micro-batch 1-64, learning rate up to 0.01');
      // Preflight: refuse a run that can't fit where it will train (GPU budget with CUDA, otherwise free RAM).
      const [py, hw] = await Promise.all([python(), hardware()]);
      let opts;
      try { opts = trainOptions(body.opts, py); } catch (e) { throw new HttpError(400, e.message); }
      const mem = trainingMemory({ params: scratchParams(cfg), layers: cfg.layers, width: cfg.width, seq: cfg.ctx, micro, vocab: cfg.vocab });
      const room = opts.device === 'cuda' ? budgetOf(hw).budgetGiB : hw.ramFreeGiB;
      if (Number.isFinite(room) && mem.lowGiB > room) throw new HttpError(409, `Needs about ${mem.lowGiB}-${mem.highGiB} GiB but only ${room} GiB is available ${opts.device === 'cuda' ? 'on the GPU' : 'in RAM'}: lower context, micro-batch or model size`);
      claimWorker('pilot'); // before writing anything, so a refused run leaves no files behind
      const id = `run-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
      const runDir = path.join(AI_DIR, 'runs', id);
      const corpus = path.join(runDir, 'corpus.txt');
      try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(corpus, corpusText()); } catch (e) { workerBusy = null; throw e; }
      try { return startJob('pilot', async (j) => {
        const r = await runWorker({ cmd: 'pilot', cfg, corpus, runDir, steps, micro, lr, opts }, (o) => { j.progress = o.progress; if (o.loss != null) j.loss = o.loss; });
        const rec = { id, at: Date.now(), cfg, ...r };
        keepRun(rec);
        audit.write({ type: 'ai.pilot', run: id, params: r.params, steps, lossStart: r.lossStart, lossEnd: r.lossEnd });
        return rec;
      }); } catch (e) { workerBusy = null; throw e; }
    },
    /** Export a trained run to GGUF and import it into the local Ollama as sw-<name>, then smoke-test it. */
    'POST /api/ai-lab/export': async ({ body }) => {
      const run = ai.runs.find((r) => r.id === body.runId);
      if (!run) throw new HttpError(404, 'Run not found');
      const name = `sw-${String(body.name ?? run.id).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^sw-/, '').slice(0, 40)}`;
      if (!EXPORT_NAME_RE.test(name)) throw new HttpError(400, 'Name: letters, digits, . _ -');
      const runDir = path.join(AI_DIR, 'runs', run.id);
      const existing = await createOllama(host('local').url).tags().catch(() => []);
      if (body.overwrite !== true && existing.some((m) => m.name === name || m.name === `${name}:latest`)) throw new HttpError(409, `${name} already exists in Ollama: choose another name`);
      claimWorker('export');
      const x = await runWorker({ cmd: 'export', runDir, name }, null, 30 * 60_000);
      const chatml = x.chatml ? 'TEMPLATE """{{- range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n"""\nPARAMETER stop "<|im_end|>"\n' : '';
      fs.writeFileSync(path.join(runDir, 'Modelfile'), `FROM ./model.gguf\nPARAMETER temperature 0\nPARAMETER num_ctx ${run.cfg?.ctx ?? 4096}\n${chatml}`);
      const created = await runCmd('ollama', ['create', name, '-f', 'Modelfile'], { cwd: runDir, timeout: 15 * 60_000 });
      if (created.status !== 0) throw new HttpError(422, `ollama create failed: ${String(created.err || created.out).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split(/\r?\n/).pop()}`);
      const sample = await fetch(`${host('local').url}/api/generate`, { method: 'POST', redirect: 'error', body: JSON.stringify({ model: name, prompt: 'Risk first:', raw: true, stream: false, options: { num_predict: 24 } }), signal: AbortSignal.timeout(120_000) })
        .then((r) => r.json()).catch((e) => ({ error: e.message }));
      run.exported = { name, gguf: x.sha256, bytes: x.bytes, at: Date.now() }; saveState();
      audit.write({ type: 'ai.export', run: run.id, model: name, sha256: x.sha256 });
      return { name, ...x, sample: sample.response ?? null, sampleError: sample.error ?? null };
    },
    'GET /api/ai-lab/jobs': () => [...jobs.values()].slice(-20).reverse(),
    /** Training setup: a private Python environment (in the data folder) with PyTorch for the CPU or the NVIDIA GPU. */
    'POST /api/ai-lab/setup': async ({ body }) => {
      const hw = await hardware();
      let v;
      try { v = torchVariant({ driver: hw.gpus[0]?.driver, choice: body.variant }); } catch (e) { throw new HttpError(400, e.message); }
      const sys = await runCmd(SYS_PY, ['-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])']);
      if (sys.status !== 0 || !(Number(sys.out.trim()) >= 310)) throw new HttpError(409, 'Python 3.10 or newer is needed first: install it from python.org (tick "Add to PATH"), then retry');
      claimWorker('setup');
      try {
        return startJob('setup', async (j) => {
          try {
            const pip = async (args, label) => {
              j.progress = label;
              const r = await runCmd(venvPy, ['-m', 'pip', ...args, '--disable-pip-version-check', '--no-input'], { timeout: 90 * 60_000 });
              if (r.status !== 0) throw new Error(`${label} failed: ${(r.err || r.out).trim().split(/\r?\n/).slice(-2).join(' ')}`);
            };
            if (!fs.existsSync(venvPy)) {
              j.progress = 'creating the AI Lab Python environment';
              const r = await runCmd(SYS_PY, ['-m', 'venv', VENV], { timeout: 10 * 60_000 });
              if (r.status !== 0) throw new Error(`venv: ${r.err.trim()}`);
            }
            await pip(['install', '--upgrade', 'pip'], 'updating pip');
            await pip(['install', '--upgrade', 'torch', '--index-url', v.url], `installing PyTorch (${v.label}): about ${v.index === 'cpu' ? '200 MB' : '3 GB'}, can take a while`);
            await pip(['install', '--upgrade', 'transformers', 'tokenizers', 'safetensors', 'numpy', 'peft', 'accelerate'], 'installing transformers, peft and helpers');
            pyCache = null;
            const py = await python();
            if (!py.ready || !py.finetuneReady) throw new Error(`installed, but still missing ${py.missing.join(', ') || 'peft'}`);
            if (v.index !== 'cpu' && !py.cuda) throw new Error('PyTorch installed but cannot see the GPU: update the NVIDIA driver, or choose the CPU build');
            ai.pyenv = { variant: v.index, torch: py.torch, cuda: py.cuda, device: py.device, at: Date.now() }; saveState();
            audit.write({ type: 'ai.setup', variant: v.index, torch: py.torch, cuda: py.cuda });
            return ai.pyenv;
          } finally { workerBusy = null; pyCache = null; }
        });
      } catch (e) { workerBusy = null; throw e; }
    },
    /** Fine-tune an existing model (LoRA) on the reviewed dataset and merge it; Export puts it in Ollama. */
    'POST /api/ai-lab/finetune': async ({ body }) => {
      const base = String(body.base ?? '');
      if (!HF_ID_RE.test(base)) throw new HttpError(400, 'Base model: a Hugging Face id like HuggingFaceTB/SmolLM2-360M-Instruct');
      const epochs = Math.round(Number(body.epochs ?? 2)), lr = Number(body.lr ?? 1e-4), r = Math.round(Number(body.r ?? 16)), micro = Math.round(Number(body.micro ?? 1)), maxLen = Math.round(Number(body.maxLen ?? 2048));
      if (!(epochs >= 1 && epochs <= 50) || !(lr > 0 && lr <= 1e-2) || ![4, 8, 16, 32, 64].includes(r) || !(micro >= 1 && micro <= 32) || !(maxLen >= 256 && maxLen <= 8192))
        throw new HttpError(400, 'epochs 1-50, learning rate up to 0.01, LoRA rank 4/8/16/32/64, micro-batch 1-32, max length 256-8192');
      const py = await python();
      if (!py.finetuneReady) throw new HttpError(409, 'Fine-tuning needs PyTorch + peft: run Training setup first');
      let opts;
      try { opts = trainOptions(body.opts, py); } catch (e) { throw new HttpError(400, e.message); }
      const rows = buildDataset(ai.reviews, ANALYST_SYSTEM);
      const train = rows.filter((x) => x.meta.split === 'train'), dev = rows.filter((x) => x.meta.split === 'dev');
      if (train.length < 3) throw new HttpError(409, `Only ${train.length} training example(s): review or teach at least 3 (the test split stays untouched for evaluation)`);
      claimWorker('finetune');
      const id = `ft-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
      const runDir = path.join(AI_DIR, 'runs', id);
      try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'train.jsonl'), train.map((x) => JSON.stringify({ messages: x.messages })).join('\n'));
        fs.writeFileSync(path.join(runDir, 'dev.jsonl'), dev.map((x) => JSON.stringify({ messages: x.messages })).join('\n'));
        return startJob('finetune', async (j) => {
          const res = await runWorker({ cmd: 'finetune', online: true, base, runDir, train: path.join(runDir, 'train.jsonl'), dev: path.join(runDir, 'dev.jsonl'), epochs, lr, r, alpha: r * 2, micro, maxLen, opts },
            (o) => { j.progress = o.progress; if (o.loss != null) j.loss = o.loss; }, 6 * 3600_000);
          const rec = { id, kind: 'finetune', at: Date.now(), cfg: { ctx: maxLen }, ...res };
          keepRun(rec);
          audit.write({ type: 'ai.finetune', run: id, base, examples: res.examples, devLossBefore: res.devLossBefore, devLossAfter: res.devLossAfter });
          return rec;
        });
      } catch (e) { workerBusy = null; throw e; }
    },
  };
}

/** Evidence a client sends back (teach/review): allowlisted shape, so rights flags can't be dodged by renaming fields. */
const SYMBOL_RE = /^[A-Z]{1,5}(\.[A-Z])?$|^[A-Z0-9]{2,10}\/USD[CT]?$/;
function cleanEvidence(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new HttpError(400, 'Evidence missing');
  const symbol = String(e.symbol ?? '').toUpperCase();
  if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Invalid symbol in evidence');
  if (e.news !== undefined && !Array.isArray(e.news)) throw new HttpError(400, 'Evidence news must be a list');
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const out = { symbol, asOf: String(e.asOf ?? '').slice(0, 40), signal: obj(e.signal), backtest: obj(e.backtest), news: e.news ?? [], ...(e.practiceData ? { practiceData: String(e.practiceData).slice(0, 120) } : {}) };
  if (JSON.stringify(out).length > 20_000) throw new HttpError(413, 'Evidence too large');
  return out;
}

function cfgOf(c) {
  c = c && typeof c === 'object' ? c : {};
  const n = (k, d) => (c[k] === undefined ? d : Number(c[k]));
  const cfg = { vocab: n('vocab'), layers: n('layers'), width: n('width'), mlp: n('mlp'), heads: n('heads'), kvHeads: n('kvHeads'), headDim: n('headDim'), ctx: n('ctx'), tied: c.tied !== false, seed: n('seed', 42) };
  const errors = validateArch(cfg);
  if (!Number.isInteger(cfg.seed) || cfg.seed < 0) errors.push('seed must be a whole number');
  if (scratchParams(cfg) > 2_000_000_000) errors.push('Over 2 billion parameters: too large for this lab');
  if (errors.length) throw new HttpError(400, errors.join(' | '));
  return cfg;
}
