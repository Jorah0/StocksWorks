// Local mining & compute-sharing workloads (desktop app): what may run, when, and with which arguments.
// Pure rules; lib/supervisor.js does the process work. Every value here ends up as a spawn() argument
// (never a shell command line), and the program itself is chosen in a native file dialog, never by a web page.
import { POOL_RE, PAYOUT_RE, PASS_RE, WORKER_RE } from './fleet.js';

export const KINDS = {
  'xmrig-cpu': { category: 'mine', label: 'XMRig miner: CPU', pool: true },
  'xmrig-gpu': { category: 'mine', label: 'XMRig miner: GPU (NVIDIA CUDA / AMD OpenCL)', pool: true },
  miner: { category: 'mine', label: 'Other miner (your own arguments)' },
  boinc: { category: 'share', label: 'BOINC client (science computing, Gridcoin rewards)' },
  share: { category: 'share', label: 'Compute-sharing client (your own arguments)' },
};
const NAME_RE = /^[\w .,()'-]{1,40}$/;
const ARG_RE = /^[^\x00-\x1f"]{1,300}$/; // one argument per line; quotes/control chars refused
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

export function validateSchedule(s = {}, errors = []) {
  const out = {
    hours: s.hours === true, windows: [],
    idleOnly: s.idleOnly === true, idleMinutes: s.idleMinutes == null ? 5 : Number(s.idleMinutes),
    pauseOnBattery: s.pauseOnBattery !== false, maxHoursPerDay: s.maxHoursPerDay == null ? 0 : Number(s.maxHoursPerDay),
  };
  if (out.hours) {
    const wins = Array.isArray(s.windows) ? s.windows : [];
    if (!wins.length || wins.length > 7) errors.push('Active hours: add 1-7 time windows');
    for (const w of wins.slice(0, 7)) {
      const days = [...new Set(Array.isArray(w?.days) ? w.days.map(Number) : [])];
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Active hours: pick at least one day');
      if (!HHMM_RE.test(w?.start) || !HHMM_RE.test(w?.end) || w.start === w.end) errors.push('Active hours: times are HH:MM and start differs from end');
      out.windows.push({ days, start: String(w?.start), end: String(w?.end) });
    }
  }
  if (!Number.isInteger(out.idleMinutes) || out.idleMinutes < 1 || out.idleMinutes > 240) errors.push('Idle wait: 1-240 minutes');
  if (!(out.maxHoursPerDay >= 0 && out.maxHoursPerDay <= 24)) errors.push('Daily limit: 0-24 hours (0 = no limit)');
  return out;
}

export function validateWorkload(w = {}) {
  const errors = [];
  const kind = String(w.kind ?? '');
  const k = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (!k) errors.push('Unknown workload type');
  const name = String(w.name ?? '').trim() || k?.label.split(':')[0] || 'Workload';
  if (!NAME_RE.test(name.slice(0, 40))) errors.push('Name: letters, digits, spaces and . , ( ) \' - only');
  const out = { kind, category: k?.category ?? null, name: name.slice(0, 40), enabled: w.enabled === true, args: [] };
  if (k?.pool) {
    Object.assign(out, { pool: String(w.pool ?? '').trim(), payout: String(w.payout ?? '').trim(), pass: String(w.pass ?? 'x').trim() || 'x', worker: String(w.worker ?? '').trim() || 'desktop' });
    if (!POOL_RE.test(out.pool)) errors.push('Pool: stratum+tcp://host:port or stratum+ssl://host:port');
    if (!PAYOUT_RE.test(out.payout)) errors.push('Payout address: 20-128 letters/digits (your own wallet)');
    if (!PASS_RE.test(out.pass)) errors.push('Pool password: up to 32 letters/digits/._');
    if (!WORKER_RE.test(out.worker)) errors.push('Worker name: up to 32 letters/digits/_-');
    if (kind === 'xmrig-cpu') {
      out.cpuPct = w.cpuPct == null ? 50 : Number(w.cpuPct);
      if (!Number.isInteger(out.cpuPct) || out.cpuPct < 10 || out.cpuPct > 100) errors.push('CPU cap: 10-100 %');
    } else {
      out.gpu = w.gpu ?? 'opencl';
      if (!['cuda', 'opencl'].includes(out.gpu)) errors.push('GPU backend: cuda (NVIDIA) or opencl (AMD)');
    }
  } else if (k) {
    const lines = (Array.isArray(w.args) ? w.args : String(w.args ?? '').split(/\r?\n/)).map((a) => String(a).trim()).filter(Boolean);
    if (lines.length > 40) errors.push('At most 40 arguments');
    if (lines.some((a) => !ARG_RE.test(a))) errors.push('Arguments: one per line, no quotes (none are needed: no shell is used)');
    out.args = lines.slice(0, 40);
  }
  out.schedule = validateSchedule(w.schedule ?? {}, errors);
  return { ok: errors.length === 0, errors, workload: out };
}

/** End is exclusive; a window that ends before it starts runs past midnight into the next day. */
export function inWindow(win, d) {
  const m = d.getHours() * 60 + d.getMinutes(), s = toMin(win.start), e = toMin(win.end), day = d.getDay();
  if (s < e) return win.days.includes(day) && m >= s && m < e;
  return (win.days.includes(day) && m >= s) || (win.days.includes((day + 6) % 7) && m < e);
}

/** Should this workload run right now? Checks in order of what the user most needs to see as the reason. */
export function decide(w, { now = new Date(), idleSec = 0, onBattery = false, ranTodaySec = 0 } = {}) {
  const s = w.schedule;
  if (!w.enabled) return { run: false, reason: 'Off' };
  if (s.hours && !s.windows.some((x) => inWindow(x, now))) return { run: false, reason: 'Outside active hours' };
  if (s.maxHoursPerDay > 0 && ranTodaySec >= s.maxHoursPerDay * 3600) return { run: false, reason: `Daily limit of ${s.maxHoursPerDay} h reached` };
  if (s.pauseOnBattery && onBattery) return { run: false, reason: 'Paused: on battery power' };
  if (s.idleOnly && idleSec < s.idleMinutes * 60) return { run: false, reason: `Waiting until the computer is idle for ${s.idleMinutes} min` };
  return { run: true, reason: 'Running' };
}

export function buildArgs(w, apiPort) {
  if (!KINDS[w.kind]?.pool) return [...w.args];
  const base = ['-o', w.pool, '-u', w.payout, '-p', w.pass, '--rig-id', w.worker, '--http-host', '127.0.0.1', '--http-port', String(apiPort), '--no-color'];
  // XMRig's own cap: share of CPU threads used; priority 1 = below normal, so your apps always win.
  if (w.kind === 'xmrig-cpu') return [...base, '--cpu-max-threads-hint', String(w.cpuPct), '--cpu-priority', '1'];
  return [...base, '--no-cpu', w.gpu === 'cuda' ? '--cuda' : '--opencl'];
}
