// Fails if any relative import/require in the project points at a file that doesn't exist.
// (`node --check` only parses syntax; it doesn't resolve imports.)
import fs from 'node:fs';
import path from 'node:path';

const roots = ['server.js', 'desktop.js', 'lib', 'electron', 'rig', 'public', 'test', 'scripts'];
const files = [];
const walk = (p) => {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) { for (const f of fs.readdirSync(p)) if (f !== 'vendor') walk(path.join(p, f)); }
  else if (/\.(m?js|cjs)$/.test(p)) files.push(p);
};
roots.forEach(walk);

const missing = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+|\/(?:lib|vendor)\/[^'"]+|\/[\w-]+\.js)['"]/g)) {
    const spec = m[1];
    // Browser absolute paths map to served files: /lib/* -> lib/*, /vendor/* and /<name>.js -> public/*
    const target = spec.startsWith('/lib/') ? spec.slice(1) : spec.startsWith('/') ? path.join('public', spec) : path.join(path.dirname(f), spec);
    if (!fs.existsSync(target)) missing.push(`${f}: ${spec}`);
  }
}
if (missing.length) { console.error('Unresolved imports:\n  ' + missing.join('\n  ')); process.exit(1); }
console.log(`imports ok (${files.length} files)`);
