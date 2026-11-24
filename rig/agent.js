// StocksWorks Rig: a visible, owner-controlled mining agent that links to a StocksWorks host.
//  - The rig's OWNER installs it, picks the miner program, and must switch mining on here.
//  - The host only supplies pool + payout address (rewards go straight from pool to the host's wallet)
//    and, if the owner allows it, a run/stop request.
//  - Host link: HTTPS pinned to the host certificate fingerprint from the one-time pairing link.
// Run: npm run rig                (opens the rig window; closing it stops mining)
//      npm run rig -- --headless  (console only, for dedicated rigs the owner runs unattended)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMinerArgs, parsePairingLink, DEFAULT_ARGS, WORKER_RE } from '../lib/fleet.js';
import { safeEqual } from '../lib/security.js';
import { openAppWindow } from '../lib/desktop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data', 'rig');
const CONF_FILE = path.join(DATA, 'config.json');
const UI_PORT = Number(process.env.RIG_UI_PORT || 8790);
const HEADLESS = process.argv.includes('--headless');
const HEARTBEAT_MS = 15_000;

// ---------------- persisted local config (owner's choices + host link) ----------------
const defaults = {
  name: `rig-${crypto.randomBytes(2).toString('hex')}`,
  minerPath: '', argsTemplate: DEFAULT_ARGS, apiPort: 18088,
  consentMining: false, remoteControl: false, localRun: false,
  host: null, fingerprint: null, hostCert: null, token: null, rigId: null,
};
let conf = { ...defaults };
try { conf = { ...defaults, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) }; } catch { /* first run */ }
const save = () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONF_FILE + '.tmp', JSON.stringify(conf, null, 2), { mode: 0o600 });
  fs.renameSync(CONF_FILE + '.tmp', CONF_FILE);
};

const log = [];
const note = (msg) => { const line = `${new Date().toLocaleTimeString()}  ${msg}`; log.push(line); if (log.length > 200) log.shift(); console.log(line); };

// ---------------- host link: TLS pinned to the paired certificate ----------------
/** Trust-on-first-use, but only if the cert matches the fingerprint the host showed its operator. Sends no data. */
function fetchPinnedCert(hostUrl, fingerprint) {
  const u = new URL(hostUrl);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: net.isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.destroy();
      if (!c?.raw || c.fingerprint256 !== fingerprint) return reject(new Error('Host certificate does not match the pairing link (possible interception)'));
      resolve(`-----BEGIN CERTIFICATE-----\n${c.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`);
    });
    s.setTimeout(10_000, () => s.destroy(new Error('Host connection timed out')));
    s.on('error', reject);
  });
}

function hostPost(pathname, body, { host = conf.host, cert = conf.hostCert, fingerprint = conf.fingerprint, token = conf.token } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(pathname, host), {
      method: 'POST', ca: cert, minVersion: 'TLSv1.2', timeout: 15_000,
      // Chain validates against the pinned cert; identity is the fingerprint itself (works for bare LAN IPs).
      checkServerIdentity: (_h, c) => (c.fingerprint256 === fingerprint ? undefined : new Error('Host certificate pin mismatch')),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; if (data.length > 65_536) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(data || '{}'); } catch { /* keep {} */ }
        if (res.statusCode >= 400) { const e = new Error(j.error || `Host returned ${res.statusCode}`); e.status = res.statusCode; reject(e); } else resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Host request timed out')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

// ---------------- miner process (program chosen by the rig owner) ----------------
let child = null, childConf = null, startedAt = 0, minerError = '';
let hostState = { connected: false, desired: 'stop', config: null, error: '', at: 0 };

function startMiner(cfg) {
  if (child) return;
  if (!conf.minerPath || !fs.existsSync(conf.minerPath)) { minerError = 'Set the path to your miner program (e.g. xmrig.exe) first'; return; }
  let args;
  try { args = buildMinerArgs(conf.argsTemplate, { ...cfg, worker: conf.name, apiPort: conf.apiPort }); } catch (e) { minerError = e.message; return; }
  minerError = '';
  note(`starting miner: ${path.basename(conf.minerPath)} -> ${cfg.pool} (${cfg.coin})`);
  // No shell: arguments are passed as an array, never interpolated into a command line.
  child = spawn(conf.minerPath, args, { cwd: path.dirname(conf.minerPath), stdio: ['ignore', 'pipe', 'pipe'] });
  childConf = JSON.stringify(cfg);
  startedAt = Date.now();
  const pipe = (d) => String(d).split(/\r?\n/).filter(Boolean).slice(-5).forEach((l) => note(`miner: ${l.slice(0, 200)}`));
  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);
  child.on('error', (e) => { minerError = e.message; note(`miner error: ${e.message}`); });
  child.on('exit', (code) => { note(`miner exited (${code})`); child = null; childConf = null; });
}
function stopMiner(reason) {
  if (!child) return;
  note(`stopping miner (${reason})`);
  child.kill();
}

async function minerStats() {
  if (!child) return { running: false, hashrate: null };
  try {
    const r = await fetch(`http://127.0.0.1:${conf.apiPort}/2/summary`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return { running: true, hashrate: j?.hashrate?.total?.[0] ?? null, miner: `xmrig ${j?.version ?? ''}`.trim() };
  } catch {
    return { running: true, hashrate: null, miner: path.basename(conf.minerPath) };
  }
}

/** One control-loop step: report to the host, then reconcile the miner with the owner's consent. */
async function tick() {
  const stats = await minerStats();
  if (conf.token) {
    try {
      const r = await hostPost('/rig/heartbeat', { stats: { ...stats, uptimeSec: child ? Math.round((Date.now() - startedAt) / 1000) : 0, consentMining: conf.consentMining, remoteControl: conf.remoteControl, error: minerError } });
      hostState = { connected: true, desired: r.desired, config: r.config, error: '', at: Date.now() };
      if (r.name && r.name !== conf.name && WORKER_RE.test(r.name)) { conf.name = r.name; save(); }
    } catch (e) {
      hostState = { ...hostState, connected: false, error: e.message, at: Date.now() };
      if (e.status === 401) { note('host revoked this rig; unpairing'); Object.assign(conf, { token: null, rigId: null }); save(); hostState.config = null; }
    }
  }
  const cfg = hostState.config;
  const wantRun = conf.consentMining && Boolean(cfg) && (conf.remoteControl ? hostState.desired === 'run' : conf.localRun);
  if (!wantRun) stopMiner(!conf.consentMining ? 'mining not allowed on this machine' : 'stop requested');
  else if (child && childConf !== JSON.stringify(cfg)) stopMiner('pool config changed'); // restarts next tick
  else startMiner(cfg);
}

// ---------------- minimalist local UI (loopback only) ----------------
const UI_TOKEN = crypto.randomBytes(24).toString('base64url'); // per launch; other web pages can't read it
const FILES = { '/ui.js': ['ui.js', 'text/javascript'], '/ui.css': ['ui.css', 'text/css'] };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const publicState = async () => ({
  name: conf.name, minerPath: conf.minerPath, argsTemplate: conf.argsTemplate, apiPort: conf.apiPort,
  consentMining: conf.consentMining, remoteControl: conf.remoteControl, localRun: conf.localRun,
  paired: Boolean(conf.token), host: conf.host, fingerprint: conf.fingerprint,
  hostState: { connected: hostState.connected, desired: hostState.desired, error: hostState.error, at: hostState.at, config: hostState.config },
  miner: { ...(await minerStats()), uptimeSec: child ? Math.round((Date.now() - startedAt) / 1000) : 0, error: minerError },
  log: log.slice(-40),
});

const actions = {
  async pair(b) {
    const link = parsePairingLink(b.link);
    const name = WORKER_RE.test(String(b.name)) ? String(b.name) : conf.name;
    const cert = await fetchPinnedCert(link.url, link.fingerprint);
    const r = await hostPost('/rig/pair', { code: link.code, name }, { host: link.url, cert, fingerprint: link.fingerprint, token: null });
    Object.assign(conf, { host: link.url, fingerprint: link.fingerprint, hostCert: cert, token: r.token, rigId: r.rigId, name: r.name });
    save(); note(`paired with ${link.url} as ${r.name}`);
  },
  async settings(b) {
    if (typeof b.minerPath === 'string') {
      const p = b.minerPath.trim();
      if (p && (!path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile())) throw new Error('Miner path must be an existing file (absolute path)');
      conf.minerPath = p;
    }
    if (typeof b.argsTemplate === 'string') {
      if (!b.argsTemplate.includes('{pool}') || b.argsTemplate.length > 500) throw new Error('Arguments must include {pool} (and usually {payout})');
      conf.argsTemplate = b.argsTemplate.trim();
    }
    if (b.apiPort !== undefined) { const n = Number(b.apiPort); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('API port 1024-65535'); conf.apiPort = n; }
    if (typeof b.consentMining === 'boolean') conf.consentMining = b.consentMining;
    if (typeof b.remoteControl === 'boolean') conf.remoteControl = b.remoteControl;
    save(); note(`settings saved (mining ${conf.consentMining ? 'allowed' : 'NOT allowed'}, host control ${conf.remoteControl ? 'on' : 'off'})`);
  },
  async run(b) { conf.localRun = b.on === true; save(); },
  async unpair() { stopMiner('unpaired'); Object.assign(conf, { host: null, fingerprint: null, hostCert: null, token: null, rigId: null }); hostState = { connected: false, desired: 'stop', config: null, error: '', at: 0 }; save(); note('unpaired'); },
};

const uiServer = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    // DNS-rebinding guard: only answer to our own loopback name.
    if (![`127.0.0.1:${UI_PORT}`, `localhost:${UI_PORT}`].includes(req.headers.host)) return json(421, { error: 'Bad host' });
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'GET' && pathname === '/') {
      const html = fs.readFileSync(path.join(HERE, 'ui.html'), 'utf8').replace('__UI_TOKEN__', UI_TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && Object.hasOwn(FILES, pathname)) {
      res.writeHead(200, { 'Content-Type': `${FILES[pathname][1]}; charset=utf-8` });
      return res.end(fs.readFileSync(path.join(HERE, FILES[pathname][0])));
    }
    if (!pathname.startsWith('/ui/')) return json(404, { error: 'Not found' });
    if (!safeEqual(req.headers['x-ui-token'] ?? '', UI_TOKEN)) return json(403, { error: 'Forbidden' });
    if (req.method === 'GET' && pathname === '/ui/state') return json(200, await publicState());
    const name = pathname.slice(4);
    const action = req.method === 'POST' && Object.hasOwn(actions, name) ? actions[name] : null;
    if (!action) return json(404, { error: 'Not found' });
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 16_384) return json(413, { error: 'Too large' }); }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    await action(body);
    tick().catch(() => {});
    return json(200, await publicState());
  } catch (e) {
    return json(400, { error: e.message });
  }
});

uiServer.listen(UI_PORT, '127.0.0.1', () => {
  note(`StocksWorks Rig UI on http://127.0.0.1:${UI_PORT}  (mining ${conf.consentMining ? 'allowed' : 'not allowed'} on this machine)`);
  setInterval(() => tick().catch((e) => note(`tick error: ${e.message}`)), HEARTBEAT_MS);
  tick().catch(() => {});
  if (!HEADLESS) {
    const win = openAppWindow(`http://127.0.0.1:${UI_PORT}/`, path.join(DATA, 'window-profile'), { width: 520, height: 860 });
    win?.on('exit', () => shutdown('window closed')); // visible operation: closing the window stops mining
  }
});

function shutdown(why) {
  note(`shutting down (${why})`);
  stopMiner(why);
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('terminated'));
