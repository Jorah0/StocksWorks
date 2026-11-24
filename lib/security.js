// Auth, sessions, TOTP 2FA, rate limiting, webhook verification, tamper-evident audit log.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Constant-time string compare (hash first so lengths never leak). */
export const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, key] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(got, expected);
}

// ---- TOTP (RFC 6238, SHA1; works with Google Authenticator / 1Password / Authy) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = '';
  for (const c of String(s).toUpperCase().replace(/=+$|\s/g, '')) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error('invalid base32');
    bits += v.toString(2).padStart(5, '0');
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}
export function base32Encode(buf) {
  const bits = [...buf].map((b) => b.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? []).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join('');
}
export function totp(secretB32, timeMs = Date.now(), step = 30, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / step)));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
/** Accepts the current code and one step of clock drift either side. */
export function verifyTotp(secretB32, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false;
  return [-1, 0, 1].map((w) => safeEqual(totp(secretB32, now + w * 30_000), code)).includes(true);
}

/** Rejects a TOTP code whose time step was already used (or is older than the last one used). */
export function totpReplayGuard() {
  let lastStep = -Infinity;
  return (secretB32, code, now = Date.now()) => {
    if (!/^\d{6}$/.test(String(code))) return false;
    const base = Math.floor(now / 30_000);
    const step = [base - 1, base, base + 1].find((s) => safeEqual(totp(secretB32, s * 30_000), code));
    if (step === undefined || step <= lastStep) return false;
    lastStep = step;
    return true;
  };
}

/**
 * Live-order confirmation: the server issues a token bound to the exact normalized order at preview time;
 * placing a live order requires redeeming it. Expires in 2 minutes, single use.
 */
export function createConfirmer(key = crypto.randomBytes(32), ttlMs = 120_000) {
  const used = new Map();
  const mac = (exp, order) => crypto.createHmac('sha256', key).update(`${exp}.${JSON.stringify(order)}`).digest('base64url');
  return {
    issue: (order, now = Date.now()) => { const exp = now + ttlMs; return `${exp}.${mac(exp, order)}`; },
    redeem(token, order, now = Date.now()) {
      const [expStr, sig] = String(token ?? '').split('.');
      const exp = Number(expStr);
      if (!sig || !Number.isFinite(exp) || exp < now || used.has(sig) || !safeEqual(sig, mac(exp, order))) return false;
      for (const [k, e] of used) if (e < now) used.delete(k);
      used.set(sig, exp);
      return true;
    },
  };
}

// ---- Sessions: opaque random tokens held server-side; CSRF token bound per session ----
export class Sessions {
  #map = new Map();
  constructor(ttlMs = 8 * 3600_000) { this.ttlMs = ttlMs; }
  create(now = Date.now()) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    this.#map.set(token, { csrf, expires: now + this.ttlMs });
    return { token, csrf };
  }
  get(token, now = Date.now()) {
    const s = token && this.#map.get(token);
    if (!s) return null;
    if (s.expires < now) { this.#map.delete(token); return null; }
    return s;
  }
  destroy(token) { this.#map.delete(token); }
  sweep(now = Date.now()) {
    let n = 0;
    for (const [t, s] of this.#map) if (s.expires < now) { this.#map.delete(t); n++; }
    return n;
  }
}

// ponytail: in-memory sliding window, per-process only; move to Redis if this ever runs multi-instance.
// hit(key) counts and returns allowed?; hit.blocked(key) checks without counting.
export function rateLimiter(max, windowMs, maxKeys = 10_000) {
  const hits = new Map();
  const live = (key, now) => (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  const hit = (key, now = Date.now()) => {
    if (!hits.has(key) && hits.size >= maxKeys) {
      for (const [k, arr] of hits) if (now - arr.at(-1) >= windowMs) hits.delete(k); // evict only stale keys
      if (hits.size >= maxKeys) return false; // still full: fail closed, never flush active lockouts
    }
    const arr = live(key, now);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= max;
  };
  hit.blocked = (key, now = Date.now()) => live(key, now).length >= max;
  return hit;
}

/**
 * Two accepted schemes:
 *  1. HMAC: headers x-timestamp (unix s) + x-signature "sha256=<hex HMAC(secret, `${ts}.${raw}`)>", 5-min replay window.
 *  2. Shared secret in the JSON body ("secret") - for TradingView, which cannot sign requests.
 * No (or weak) secret configured => always deny.
 */
export function verifyWebhook({ raw, json, headers, secret, now = Date.now() }) {
  if (!secret || secret.length < 16) return { ok: false, reason: 'webhook secret not configured' };
  const sig = headers['x-signature'];
  if (sig) {
    const ts = Number(headers['x-timestamp']);
    if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return { ok: false, reason: 'stale or missing timestamp' };
    const want = 'sha256=' + crypto.createHmac('sha256', secret).update(`${headers['x-timestamp']}.${raw}`).digest('hex');
    return safeEqual(want, sig) ? { ok: true } : { ok: false, reason: 'bad signature' };
  }
  return typeof json?.secret === 'string' && safeEqual(json.secret, secret) ? { ok: true } : { ok: false, reason: 'bad secret' };
}

// ---- Append-only audit log; each line carries the hash of the previous line ----
const ZERO = '0'.repeat(64);
const lineHash = (prev, entry) => crypto.createHash('sha256').update(prev + JSON.stringify(entry)).digest('hex');

export function createAuditLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const readLines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
  // Tolerate a torn last line (crash mid-write): continue from the last parseable entry; verify() will flag it.
  let prev = ZERO;
  for (const line of readLines().reverse()) {
    try { prev = JSON.parse(line).hash; break; } catch { console.warn('audit: skipping corrupt line'); }
  }
  return {
    write(event) {
      const entry = { ts: new Date().toISOString(), ...event };
      const hash = lineHash(prev, entry);
      fs.appendFileSync(file, JSON.stringify({ ...entry, prev, hash }) + '\n', { mode: 0o600 });
      prev = hash;
    },
    lines: readLines,
    read(limit = 200) {
      const lines = readLines();
      return { entries: lines.slice(-limit).map((l) => JSON.parse(l)).reverse(), valid: verifyAuditChain(lines) };
    },
  };
}

export function verifyAuditChain(lines) {
  let prev = ZERO;
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return false; }
    const { prev: p, hash, ...entry } = parsed;
    if (p !== prev || lineHash(prev, entry) !== hash) return false;
    prev = hash;
  }
  return true;
}
