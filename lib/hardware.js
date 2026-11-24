// Hardware profile for the AI Lab: GPU memory per device (nvidia-smi), RAM, disk, CPU. Read-only probes.
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const r2 = (x) => Math.round(x * 100) / 100;

/** `nvidia-smi --query-gpu=name,memory.total,memory.free,memory.used,driver_version --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(text) {
  return String(text).split(/\r?\n/).map((l) => l.split(',').map((s) => s.trim())).filter((p) => p.length >= 5 && Number.isFinite(Number(p[1])))
    // "[N/A]" readings become null, so fit checks report "unknown" instead of guessing.
    .map(([name, total, free, used, driver], index) => ({ index, name, totalGiB: r2(total / 1024), freeGiB: Number.isFinite(Number(free)) ? r2(free / 1024) : null, usedGiB: Number.isFinite(Number(used)) ? r2(used / 1024) : null, driver }));
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 8000, windowsHide: true }, (e, out) => resolve(e ? null : out)));

export async function probeHardware(dataDir) {
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,memory.used,driver_version', '--format=csv,noheader,nounits']);
  let diskFreeGiB = null;
  try { const s = fs.statfsSync(dataDir); diskFreeGiB = r2((s.bavail * s.bsize) / 2 ** 30); } catch { /* unsupported */ }
  return {
    at: Date.now(), gpus: smi ? parseNvidiaSmi(smi) : [], telemetry: smi ? 'nvidia-smi' : 'unavailable (no NVIDIA driver tool found)',
    ramTotalGiB: r2(os.totalmem() / 2 ** 30), ramFreeGiB: r2(os.freemem() / 2 ** 30), diskFreeGiB,
    cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, platform: `${os.platform()} ${os.release()}`,
  };
}
