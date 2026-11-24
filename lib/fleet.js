// Mining fleet: shared by the host (server.js) and the rig agent (rig/agent.js).
// Rewards flow pool -> host payout address; rigs never hold keys or wallets.
import crypto from 'node:crypto';
import { safeEqual, base32Encode } from './security.js';

export const POOL_RE = /^stratum\+(tcp|ssl|tls):\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,252}:\d{2,5}$/;
export const PAYOUT_RE = /^[A-Za-z0-9][A-Za-z0-9._]{19,127}$/;
export const WORKER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const PASS_RE = /^[A-Za-z0-9._]{0,32}$/;
export const COIN_RE = /^[A-Z0-9]{2,10}$/;
export const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// XMRig flags. The template is chosen by the rig owner, never by the host.
export const DEFAULT_ARGS = '-o {pool} -u {payout} -p {pass} --rig-id {worker} --http-host 127.0.0.1 --http-port {apiPort} --no-color';

export function validateFleetConfig(c = {}) {
  const config = {
    coin: String(c.coin ?? '').trim().toUpperCase(),
    pool: String(c.pool ?? '').trim(),
    payout: String(c.payout ?? '').trim(),
    pass: String(c.pass ?? 'x').trim(),
  };
  const errors = [];
  if (!COIN_RE.test(config.coin)) errors.push('Coin ticker: 2-10 letters/digits (e.g. XMR)');
  if (!POOL_RE.test(config.pool)) errors.push('Pool: stratum+tcp://host:port or stratum+ssl://host:port');
  if (!PAYOUT_RE.test(config.payout)) errors.push('Payout address: 20-128 letters/digits');
  if (!PASS_RE.test(config.pass)) errors.push('Pool password: up to 32 letters/digits/._');
  return { ok: errors.length === 0, errors, config };
}

/** Every host-supplied value is re-validated here, so a compromised host cannot smuggle extra miner flags. */
export function buildMinerArgs(template, v) {
  if (!POOL_RE.test(v.pool) || !PAYOUT_RE.test(v.payout) || !PASS_RE.test(v.pass ?? '') || !WORKER_RE.test(v.worker) || !/^\d{2,5}$/.test(String(v.apiPort)))
    throw new Error('Invalid mining config');
  return String(template).trim().split(/\s+/).map((tok) => tok.replace(/\{(pool|payout|pass|worker|apiPort)\}/g, (_, k) => String(v[k] ?? '')));
}

export class Pairing {
  #codes = new Map(); // code -> expiry
  create(now = Date.now(), ttlMs = 10 * 60_000) {
    const code = base32Encode(crypto.randomBytes(10)); // 16 chars, 80 bits
    this.#codes.set(code, now + ttlMs);
    return { code, expiresAt: now + ttlMs };
  }
  consume(input, now = Date.now()) {
    const code = String(input ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let hit = false;
    for (const [k, exp] of this.#codes) {
      if (exp < now) { this.#codes.delete(k); continue; }
      if (!hit && safeEqual(k, code)) { this.#codes.delete(k); hit = true; }
    }
    return hit;
  }
}

export const newRigToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function sanitizeStats(s = {}) {
  const n = (x) => (x !== null && x !== '' && Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.min(Number(x), 1e15) : null);
  return {
    running: s?.running === true,
    hashrate: n(s?.hashrate),
    uptimeSec: n(s?.uptimeSec),
    miner: String(s?.miner ?? '').replace(/[^\w .:/()-]/g, '').slice(0, 40),
    consentMining: s?.consentMining === true,
    remoteControl: s?.remoteControl === true,
    error: String(s?.error ?? '').replace(/[^\w .:,/()'-]/g, '').slice(0, 120),
  };
}

export const pairingLink = ({ url, code, fingerprint }) =>
  'swrig:' + Buffer.from(JSON.stringify({ u: url, c: code, f: fingerprint })).toString('base64url');

export function parsePairingLink(link) {
  let o;
  try { o = JSON.parse(Buffer.from(String(link).trim().replace(/^swrig:/, ''), 'base64url').toString('utf8')); } catch { throw new Error('Not a StocksWorks pairing link'); }
  let u;
  try { u = new URL(o.u); } catch { throw new Error('Bad host URL in link'); }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.username || u.password) throw new Error('Host URL must be https://host:port');
  if (!FINGERPRINT_RE.test(String(o.f))) throw new Error('Bad certificate fingerprint in link');
  if (!/^[A-Z2-7]{16}$/.test(String(o.c))) throw new Error('Bad pairing code in link');
  return { url: u.origin, code: o.c, fingerprint: o.f };
}
