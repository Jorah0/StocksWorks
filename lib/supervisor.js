// Runs the desktop's approved workloads (miners, compute-sharing clients) by their schedules and caps.
// Safety: a program runs only if its file still has the SHA-256 recorded when the owner picked it; no shell;
// below-normal priority; the whole process tree is stopped when a rule says stop or the app quits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { validateWorkload, decide, buildArgs, parseHashrate, KINDS } from './workloads.js';

export const sha256File = (f) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(f).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
});
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

// Programs the user approved (miners, BOINC, anything under "Other miner") get only what an OS process needs,
// never the app's secrets (broker/bank/AI keys, TOTP secret, password hash) that live in this process's env.
const SAFE_ENV = /^(PATH|PATHEXT|SystemRoot|SystemDrive|windir|ComSpec|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|CommonProgramFiles|OS|NUMBER_OF_PROCESSORS|PROCESSOR_[A-Z_]+|LANG|LC_[A-Z]+|USER|USERNAME|CUDA_[A-Z_]+|GPU_[A-Z_]+|HIP_[A-Z_]+|OCL_[A-Z_]+|DISPLAY|XDG_RUNTIME_DIR|LD_LIBRARY_PATH)$/;
export const childSafeEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => SAFE_ENV.test(k)));

export function createSupervisor({ file, idleSec = () => 0, onBattery = () => false }) {
  let data = { workloads: [], usage: { date: localDate(), sec: {} } };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  // Re-validate on load: a hand-edited or corrupted file can't smuggle in arguments the UI would refuse.
  // ponytail: another program running as you could still write a valid record; an HMAC over records is the upgrade.
  data.workloads = (Array.isArray(data.workloads) ? data.workloads : []).flatMap((w) => {
    const v = validateWorkload(w);
    const ok = v.ok && typeof w.id === 'string' && path.isAbsolute(String(w.exe)) && /^[a-f0-9]{64}$/.test(w.sha256) && Number.isInteger(w.apiPort);
    return ok ? [{ ...v.workload, id: w.id, exe: w.exe, sha256: w.sha256, apiPort: w.apiPort }] : [];
  });
  if (!data.usage?.sec) data.usage = { date: localDate(), sec: {} };
  let closing = false; // set by stopAll: nothing may start after shutdown began
  const procs = new Map(); // id -> { child, startedAt, lastTick, stopping }
  const info = new Map(); // id -> { reason, error, log[], cooldownUntil, hashrate }
  const meta = (id) => { if (!info.has(id)) info.set(id, { reason: '', error: '', log: [], cooldownUntil: 0, fails: 0, hashrate: null }); return info.get(id); };
  const note = (id, line) => { const m = meta(id); m.log.push(`${new Date().toLocaleTimeString()}  ${line}`.slice(0, 240)); if (m.log.length > 60) m.log.shift(); };
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    dirty = false; lastPersist = Date.now();
  };
  let dirty = false, lastPersist = 0; // the 15 s tick only rewrites workloads.json when usage changed, ≤ once a minute
  const addUsage = (id, p) => { const now = Date.now(); data.usage.sec[id] = (data.usage.sec[id] ?? 0) + (now - p.lastTick) / 1000; p.lastTick = now; dirty = true; };
  const find = (id) => data.workloads.find((w) => w.id === id);

  async function start(w) {
    const m = meta(w.id);
    if (Date.now() < m.cooldownUntil) { m.reason = 'Exited right after starting; retrying in a few minutes'; return; }
    try { if (!fs.statSync(w.exe).isFile()) throw new Error(); } catch { m.reason = 'Blocked'; m.error = 'Program file is missing: choose it again'; return; }
    if ((await sha256File(w.exe)) !== w.sha256) { m.reason = 'Blocked'; m.error = 'Program file changed since you approved it: choose it again to re-approve'; note(w.id, 'refused to start: program hash changed'); return; }
    if (procs.has(w.id) || closing) return; // re-checked after the await: stopAll may have begun meanwhile
    m.error = '';
    const child = spawn(w.exe, buildArgs(w, w.apiPort), { cwd: path.dirname(w.exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childSafeEnv() });
    const p = { child, startedAt: Date.now(), lastTick: Date.now(), stopping: false };
    procs.set(w.id, p);
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* exited already */ }
    const pipe = (d) => String(d).split(/\r?\n/).filter(Boolean).slice(-5).forEach((l) => note(w.id, l.replace(/\x1b\[[0-9;]*m/g, '')));
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    const ended = (why) => {
      if (procs.get(w.id) !== p) return;
      addUsage(w.id, p); procs.delete(w.id); m.hashrate = null;
      note(w.id, why);
      // No crash loop: an exit we didn't ask for within 10 min of starting backs off 2, 4, 8 … up to 60 min.
      if (!p.stopping && Date.now() - p.startedAt < 10 * 60_000) { m.fails += 1; m.cooldownUntil = Date.now() + Math.min(60, 2 ** m.fails) * 60_000; }
      else if (!p.stopping) m.fails = 0;
    };
    child.on('error', (e) => { m.error = e.message; ended(`could not start: ${e.message}`); });
    child.on('exit', (code) => ended(`exited (${code})`));
    note(w.id, `started ${path.basename(w.exe)}`);
  }

  function stop(id, reason) {
    const p = procs.get(id);
    if (!p) return Promise.resolve();
    p.stopping = true;
    note(id, `stopping (${reason})`);
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      p.child.once('exit', () => { clearTimeout(t); resolve(); });
      // Whole tree: compute clients (BOINC) run their work in child processes.
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(p.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else p.child.kill();
    });
  }

  async function hashrate(w) {
    try {
      const r = await fetch(`http://127.0.0.1:${w.apiPort}${KINDS[w.kind].api ?? '/2/summary'}`, { signal: AbortSignal.timeout(1500) });
      meta(w.id).hashrate = parseHashrate(w.kind, await r.json());
    } catch { meta(w.id).hashrate = null; }
  }

  async function run() {
    const now = new Date();
    if (data.usage.date !== localDate(now)) { data.usage = { date: localDate(now), sec: {} }; dirty = true; }
    for (const [id, p] of procs) addUsage(id, p);
    const env = { now, idleSec: idleSec(), onBattery: onBattery(), allowed };
    for (const w of data.workloads) {
      if (closing) break;
      try { // one workload's failure (e.g. antivirus holding the file) must not skip the others
        const d = decide(w, { ...env, ranTodaySec: data.usage.sec[w.id] ?? 0 });
        meta(w.id).reason = d.reason;
        if (d.run && !procs.has(w.id)) await start(w);
        else if (!d.run && procs.has(w.id)) await stop(w.id, d.reason);
        else if (procs.has(w.id) && KINDS[w.kind]?.pool) await hashrate(w);
      } catch (e) { Object.assign(meta(w.id), { reason: 'Blocked', error: e.message }); }
    }
    if (dirty && Date.now() - lastPersist >= 60_000) persist(); // explicit changes (save/toggle/stop) persist at once
  }
  let ticking = null;
  let allowed = null; // Autopilot Focus: Set of activity ids allowed right now (null = no restriction)

  return {
    tick: () => (ticking ??= run().finally(() => { ticking = null; })),
    /** Set by server.js every minute from the Autopilot Focus plan. */
    setAllowed: (set) => { allowed = set instanceof Set ? set : null; },
    list: () => data.workloads.map((w) => {
      const m = meta(w.id), p = procs.get(w.id);
      return {
        ...w, sha256: w.sha256.slice(0, 12), exeName: path.basename(w.exe), running: Boolean(p),
        uptimeSec: p ? Math.round((Date.now() - p.startedAt) / 1000) : 0, ranTodaySec: Math.round(data.usage.sec[w.id] ?? 0),
        reason: m.reason, error: m.error, hashrate: m.hashrate, log: m.log.slice(-20),
      };
    }),
    /** program = {exe, sha256} from the native file picker; omit to keep the current program. */
    save(input, program) {
      const v = validateWorkload(input);
      if (!v.ok) throw new Error(v.errors.join(' | '));
      const old = input?.id ? find(input.id) : null;
      if (input?.id && !old) throw new Error('Unknown workload');
      if (!old && data.workloads.length >= 12) throw new Error('At most 12 workloads');
      const prog = program ?? (old ? { exe: old.exe, sha256: old.sha256 } : null);
      if (!prog?.exe || !path.isAbsolute(prog.exe) || !/^[a-f0-9]{64}$/.test(prog.sha256 ?? '')) throw new Error('Choose the program to run');
      const used = new Set(data.workloads.map((x) => x.apiPort));
      let apiPort = old?.apiPort;
      while (!apiPort || (!old && used.has(apiPort))) apiPort = 18100 + crypto.randomInt(900);
      const w = { ...v.workload, id: old?.id ?? crypto.randomUUID(), exe: prog.exe, sha256: prog.sha256, apiPort };
      if (old) { Object.assign(old, w); stop(w.id, 'settings changed'); } // restarts on the next tick with the new settings
      else data.workloads.push(w);
      Object.assign(meta(w.id), { error: '', cooldownUntil: 0 });
      persist();
      return w;
    },
    toggle(id, on) {
      const w = find(id);
      if (!w) throw new Error('Unknown workload');
      w.enabled = on === true;
      persist();
      return w.enabled ? Promise.resolve() : stop(id, 'switched off'); // resolves once the program has exited
    },
    async remove(id) {
      await stop(id, 'removed');
      data.workloads = data.workloads.filter((w) => w.id !== id);
      persist();
    },
    pauseAll: () => { data.workloads.forEach((w) => { w.enabled = false; }); persist(); return Promise.all([...procs.keys()].map((id) => stop(id, 'all paused'))); },
    async stopAll() {
      closing = true;
      await ticking?.catch(() => {}); // let an in-flight start finish its (now refused) check
      await Promise.all([...procs.keys()].map((id) => stop(id, 'app closing')));
      persist(); // keep today's usage
    },
  };
}
