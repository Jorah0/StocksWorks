import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pythonCandidates, findPython, wingetArgs, WINGET } from '../lib/pydeps.js';

const LAD = 'C:\\Users\\u\\AppData\\Local';

test('pythonCandidates: PYTHON env first, then the py launcher, PATH, and fresh per-user installs PATH does not know yet', () => {
  const exists = (p) => p.endsWith('Python312\\python.exe');
  const c = pythonCandidates({ env: { PYTHON: 'D:\\py\\python.exe', LOCALAPPDATA: LAD }, platform: 'win32', exists });
  assert.deepEqual(c[0], { cmd: 'D:\\py\\python.exe', args: [] });
  assert.deepEqual(c[1], { cmd: 'py', args: ['-3'] });
  assert.deepEqual(c[2], { cmd: 'python', args: [] });
  assert.ok(c.some((x) => x.cmd === `${LAD}\\Programs\\Python\\Python312\\python.exe`), 'just-installed Python found by path');
  assert.equal(c.some((x) => x.cmd.includes('Python311')), false, 'only paths that exist');
  assert.deepEqual(pythonCandidates({ env: {}, platform: 'linux', exists: () => false }).map((x) => x.cmd), ['python3', 'python']);
});

test('findPython: the first candidate that runs and is 3.10+', async () => {
  const versions = { py: '309', python: 'boom', 'C:\\p\\python.exe': '312' };
  const runCmd = async (cmd) => (versions[cmd] === 'boom' || versions[cmd] == null ? { status: 1, out: '' } : { status: 0, out: `${versions[cmd]}\n` });
  const found = await findPython(runCmd, [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'C:\\p\\python.exe', args: [] }]);
  assert.deepEqual(found, { cmd: 'C:\\p\\python.exe', args: [], version: 312 });
  assert.equal(await findPython(async () => ({ status: 1, out: '' }), [{ cmd: 'python', args: [] }]), null);
});

test('winget: only allowlisted packages, per-user, silent, no prompts', () => {
  assert.deepEqual(Object.keys(WINGET).sort(), ['ollama', 'python']);
  const a = wingetArgs('python');
  assert.deepEqual(a.slice(0, 4), ['install', '--exact', '--id', 'Python.Python.3.12']);
  for (const f of ['--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']) assert.ok(a.includes(f), f);
  assert.throws(() => wingetArgs('anything-else'), /not allowed/);
});
