// Outside dependencies the exe can't bundle: Python (AI Lab training) and Ollama (local models).
// npm packages ship inside app.asar; these are separate programs, so the app finds them, and when one is missing
// and the user presses the button that needs it, installs it with winget (Windows' package manager: signed
// sources, hash-checked installers, per-user, no admin prompt). Only the allowlisted packages below.
import path from 'node:path';

export const WINGET = { python: 'Python.Python.3.12', ollama: 'Ollama.Ollama' };

export function wingetArgs(what) {
  if (!Object.hasOwn(WINGET, what)) throw new Error(`Installing "${what}" is not allowed`);
  return ['install', '--exact', '--id', WINGET[what], '--scope', 'user', '--silent',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
}

/**
 * Where Python may be, in order. A per-user install made a moment ago isn't on this process's PATH yet,
 * so its standard folder is checked directly.
 */
export function pythonCandidates({ env = process.env, platform = process.platform, exists = () => false } = {}) {
  const out = [];
  if (env.PYTHON) out.push({ cmd: env.PYTHON, args: [] });
  if (platform !== 'win32') return [...out, { cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  out.push({ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] });
  const base = env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'Python') : null;
  for (const v of ['315', '314', '313', '312', '311', '310']) { // newest first
    const p = base && path.win32.join(base, `Python${v}`, 'python.exe');
    if (p && exists(p)) out.push({ cmd: p, args: [] });
  }
  return out;
}

/** First candidate that runs and is Python 3.10+, as { cmd, args, version } (e.g. version 312), else null. */
export async function findPython(runCmd, candidates) {
  for (const c of candidates) {
    const r = await runCmd(c.cmd, [...c.args, '-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])'], { timeout: 20_000 });
    const version = Number(String(r.out ?? '').trim());
    if (r.status === 0 && version >= 310) return { ...c, version };
  }
  return null;
}
