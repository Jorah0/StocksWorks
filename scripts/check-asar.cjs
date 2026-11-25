// Packaging check (runs after every `npm run dist:win`): the built app.asar must contain everything the app loads
// at runtime (every lib/ and public/ module, the Python worker, the Electron entry points, the bundled npm
// packages) and nothing private (data/, .env, keys, tests, scripts, audit/state files). Exit 1 lists what's wrong.
// Usage: node scripts/check-asar.cjs [path/to/app.asar]
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');
const file = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'StocksWorks-win32-x64', 'resources', 'app.asar'));
if (!fs.existsSync(file)) { console.error(`check-asar: ${file} not found (build first: npm run dist:win)`); process.exit(1); }

const inside = new Set(asar.listPackage(file).map((p) => p.replace(/\\/g, '/').replace(/^\//, '')));
const filesIn = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).map((f) => `${dir}/${f}`);
const pkg = require(path.join(ROOT, 'package.json'));
const required = [
  'package.json', 'server.js', 'electron/main.mjs', 'electron/preload.cjs', 'electron/setup.html', 'electron/setup.js',
  'tools/ai_worker.py', 'build/icon.png',
  ...filesIn('lib', /\.js$/), ...filesIn('public', /\.(js|html|css|webmanifest|svg)$/), 'public/vendor/walletkit.js',
  ...Object.keys(pkg.dependencies ?? {}).map((d) => `node_modules/${d}/package.json`),
];
const missing = required.filter((f) => !inside.has(f));

const FORBIDDEN = [/^data(\/|$)/, /^\.env(\.|$)/, /^test(\/|$)/, /^scripts(\/|$)/, /^docs(\/|$)/, /^dist(\/|$)/, /^\.git(\/|$)/,
  /^\.playwright-mcp(\/|$)/, /^\.(mypy|ruff)_cache(\/|$)/, /(^|\/)(audit\.jsonl|state\.json|workloads\.json|desktop\.json)$/];
const KEYS = /\.(pem|key|pfx|p12)$/; // outside node_modules (some packages ship test certificates)
const leaked = [...inside].filter((f) => FORBIDDEN.some((re) => re.test(f)) || (!f.startsWith('node_modules/') && KEYS.test(f)));

if (missing.length || leaked.length) {
  if (missing.length) console.error(`check-asar: MISSING from the exe (the app would break):\n  ${missing.join('\n  ')}`);
  if (leaked.length) console.error(`check-asar: PRIVATE files inside the exe:\n  ${leaked.slice(0, 40).join('\n  ')}`);
  process.exit(1);
}
console.log(`check-asar: ok (${inside.size} entries, ${required.length} required present, nothing private) ${file}`);
