import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateWorkload, decide, buildArgs, inWindow } from '../lib/workloads.js';
import { createSupervisor } from '../lib/supervisor.js';

const POOL = { pool: 'stratum+ssl://pool.supportxmr.com:443', payout: '4' + 'A'.repeat(94), worker: 'desk1', pass: 'x' };
const at = (day, hh, mm = 0) => new Date(2026, 10, 22 + day, hh, mm); // 2026-11-22 is a Sunday (day 0)

test('workloads: validation (kinds, pool fields, caps, args one per line, schedule)', () => {
  const ok = validateWorkload({ kind: 'xmrig-cpu', name: 'Night CPU', ...POOL, cpuPct: 50, schedule: { hours: true, windows: [{ days: [1, 2, 3, 4, 5], start: '22:00', end: '07:00' }] } });
  assert.equal(ok.ok, true, ok.errors.join());
  assert.equal(ok.workload.category, 'mine');
  assert.equal(ok.workload.schedule.pauseOnBattery, true, 'safe default');
  assert.equal(validateWorkload({ kind: 'boinc', args: '--dir\nC:\\ProgramData\\BOINC data' }).workload.args[1], 'C:\\ProgramData\\BOINC data', 'spaces fine: no shell, one arg per line');
  assert.equal(validateWorkload({ kind: 'boinc' }).workload.category, 'share');
  for (const bad of [
    { kind: 'nope' },
    { kind: 'xmrig-cpu', ...POOL, pool: 'http://evil' },
    { kind: 'xmrig-cpu', ...POOL, cpuPct: 150 },
    { kind: 'xmrig-gpu', ...POOL, gpu: 'quantum' },
    { kind: 'miner', args: 'ok\nbad"quote' },
    { kind: 'share', args: Array(41).fill('a').join('\n') },
    { kind: 'share', schedule: { hours: true, windows: [] } },
    { kind: 'share', schedule: { hours: true, windows: [{ days: [9], start: '22:00', end: '07:00' }] } },
    { kind: 'share', schedule: { hours: true, windows: [{ days: [1], start: '25:00', end: '07:00' }] } },
    { kind: 'share', schedule: { maxHoursPerDay: 30 } },
  ]) assert.equal(validateWorkload(bad).ok, false, JSON.stringify(bad));
});

test('workloads: active hours, including windows that cross midnight', () => {
  const nights = { days: [1, 2, 3, 4, 5], start: '22:00', end: '07:00' }; // Mon-Fri nights
  assert.equal(inWindow(nights, at(1, 23)), true, 'Mon 23:00');
  assert.equal(inWindow(nights, at(2, 3)), true, 'Tue 03:00 belongs to Monday night');
  assert.equal(inWindow(nights, at(1, 3)), false, 'Mon 03:00 belongs to Sunday night (not listed)');
  assert.equal(inWindow(nights, at(6, 6, 59)), true, 'Sat 06:59 is the tail of Friday night');
  assert.equal(inWindow(nights, at(6, 7)), false, 'end is exclusive');
  assert.equal(inWindow({ days: [0], start: '09:00', end: '17:00' }, at(0, 12)), true);
});

test('workloads: decide() honours off, hours, daily cap, battery and idle', () => {
  const w = validateWorkload({ kind: 'xmrig-cpu', ...POOL, enabled: true, schedule: { hours: true, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }], idleOnly: true, idleMinutes: 5, maxHoursPerDay: 4 } }).workload;
  const env = { now: at(1, 12), idleSec: 600, onBattery: false, ranTodaySec: 0 };
  assert.equal(decide(w, env).run, true);
  assert.equal(decide({ ...w, enabled: false }, env).run, false);
  assert.match(decide(w, { ...env, idleSec: 30 }).reason, /idle/);
  assert.match(decide(w, { ...env, onBattery: true }).reason, /battery/);
  assert.match(decide(w, { ...env, ranTodaySec: 4 * 3600 }).reason, /limit/);
  assert.match(decide(w, { ...env, now: at(1, 23, 59) }).reason, /hours/);
});

test('workloads: XMRig args carry the CPU cap / GPU backend; custom args pass through untouched', () => {
  const cpu = buildArgs(validateWorkload({ kind: 'xmrig-cpu', ...POOL, cpuPct: 40 }).workload, 18123);
  assert.deepEqual(cpu.slice(0, 8), ['-o', POOL.pool, '-u', POOL.payout, '-p', 'x', '--rig-id', 'desk1']);
  assert.equal(cpu[cpu.indexOf('--cpu-max-threads-hint') + 1], '40');
  assert.equal(cpu[cpu.indexOf('--http-port') + 1], '18123');
  const gpu = buildArgs(validateWorkload({ kind: 'xmrig-gpu', ...POOL, gpu: 'cuda' }).workload, 18124);
  assert.ok(gpu.includes('--no-cpu') && gpu.includes('--cuda') && !gpu.includes('--opencl'));
  assert.deepEqual(buildArgs(validateWorkload({ kind: 'share', args: 'a b\n--c' }).workload), ['a b', '--c']);
});

test('supervisor: starts an approved program, stops it when switched off, refuses a changed program', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wl-'));
  const script = path.join(dir, 'fake-miner.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000); console.log("hashing");');
  const sup = createSupervisor({ file: path.join(dir, 'workloads.json'), idleSec: () => 9999, onBattery: () => false });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
  const w = sup.save({ kind: 'share', name: 'Fake', args: script, enabled: true }, { exe: process.execPath, sha256: sha });
  await sup.tick();
  let s = sup.list().find((x) => x.id === w.id);
  assert.equal(s.running, true, s.reason + s.error);
  sup.toggle(w.id, false);
  await sup.tick();
  await new Promise((r) => setTimeout(r, 500));
  s = sup.list().find((x) => x.id === w.id);
  assert.equal(s.running, false);
  assert.match(s.reason, /Off/);

  const tampered = sup.save({ kind: 'share', name: 'Tampered', args: script, enabled: true }, { exe: process.execPath, sha256: '0'.repeat(64) });
  await sup.tick();
  s = sup.list().find((x) => x.id === tampered.id);
  assert.equal(s.running, false);
  assert.match(s.error, /changed/);
  assert.equal(s.reason, 'Blocked', 'status must not say Running when the start was refused');
  await sup.stopAll();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'workloads.json'), 'utf8')).workloads.length, 2, 'persisted');
});

test('supervisor: nothing starts once stopAll() began, even a start already hashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wl-'));
  const script = path.join(dir, 'm.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const sup = createSupervisor({ file: path.join(dir, 'w.json'), idleSec: () => 9999 });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
  const w = sup.save({ kind: 'share', args: script, enabled: true }, { exe: process.execPath, sha256: sha });
  const t = sup.tick(); // hashing node.exe takes a moment
  await sup.stopAll();
  await t;
  assert.equal(sup.list().find((x) => x.id === w.id).running, false, 'no miner may outlive shutdown');
});

test('supervisor: on load, records that fail validation are dropped (hand-edited workloads.json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wl-'));
  const file = path.join(dir, 'w.json');
  fs.writeFileSync(file, JSON.stringify({ workloads: [
    { id: 'a', kind: 'share', args: ['ok'], exe: process.execPath, sha256: 'f'.repeat(64), apiPort: 18100, schedule: {} },
    { id: 'b', kind: 'share', args: ['bad"arg'], exe: process.execPath, sha256: 'f'.repeat(64), apiPort: 18101, schedule: {} },
    { id: 'c', kind: 'share', args: [], exe: 'relative.exe', sha256: 'f'.repeat(64), apiPort: 18102, schedule: {} },
  ] }));
  assert.deepEqual(createSupervisor({ file }).list().map((w) => w.id), ['a']);
});
