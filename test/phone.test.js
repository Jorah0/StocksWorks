// End to end: real server.js process, desktop (loopback) side enables + pairs, "phone" talks TLS to the phone listener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { hashPassword } from '../lib/security.js';

const PW = 'correct horse battery staple';
const PORT = 18861, PHONE_PORT = 18862;

test('phone remote: off by default, pairing required, least-privilege routes, revocation is immediate', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-phone-'));
  const env = { ...process.env, APP_PASSWORD_HASH: hashPassword(PW), STOCKSWORKS_DATA: data, PORT: String(PORT), PHONE_PORT: String(PHONE_PORT), TRADING_MODE: 'paper' };
  for (const k of ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'TOTP_SECRET', 'PLAID_CLIENT_ID', 'SCHWAB_CLIENT_ID', 'FLEET_ENABLED']) delete env[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => String(d).includes('StocksWorks on') && resolve()); child.once('exit', reject); });

  // ---- desktop side (loopback, plain HTTP) ----
  let dCookie = '', dCsrf = '';
  const desk = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: dCookie, 'x-csrf-token': dCsrf }, body: body && JSON.stringify(body) });
    if (r.headers.get('set-cookie')) dCookie = r.headers.get('set-cookie').split(';')[0];
    return { status: r.status, json: await r.json() };
  };
  dCsrf = (await desk('POST', '/api/login', { password: PW })).json.csrf;
  assert.equal((await desk('GET', '/api/phone')).json.enabled, false, 'off by default');
  const on = await desk('POST', '/api/phone/enable', { on: true });
  assert.equal(on.json.running, true, JSON.stringify(on.json));
  const ca = fs.readFileSync(path.join(data, 'tls', 'phone-cert.pem'));

  // ---- phone side (TLS to the phone listener) ----
  const jar = {};
  const phone = (method, p, body, csrf) => new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: PHONE_PORT, path: p, method, ca, headers: {
      'Content-Type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'x-csrf-token': csrf } : {}),
    } }, (res) => {
      for (const c of [res.headers['set-cookie'] ?? []].flat()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; if (c.includes('Max-Age=0')) delete jar[k]; jar.__last = c; }
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, json, text: d }); });
    });
    r.on('error', reject);
    r.end(body && JSON.stringify(body));
  });

  assert.equal((await phone('GET', '/api/status')).status, 401, 'unpaired phone reaches nothing');
  assert.equal((await phone('GET', '/remote.html')).status, 200, 'pairing screen is served');
  assert.equal((await phone('GET', '/index.html')).status, 404, 'the desktop app itself is not exposed');
  assert.equal((await phone('POST', '/phone/pair', { code: 'AAAAAAAAAAAAAAAA', name: 'x' })).status, 403);

  const p = (await desk('POST', '/api/phone/pair')).json;
  assert.match(p.code, /^[A-Z2-7]{16}$/);
  assert.ok(p.links.some((l) => l.includes(`#pair=${p.code}`)));
  assert.match(p.qrs[0], /^data:image\/png;base64,/);
  const paired = await phone('POST', '/phone/pair', { code: p.code, name: 'Test phone' });
  assert.equal(paired.status, 200, JSON.stringify(paired.json));
  assert.match(jar.__last, /HttpOnly/); assert.match(jar.__last, /Secure/); assert.match(jar.__last, /SameSite=Strict/);
  assert.equal((await phone('POST', '/phone/pair', { code: p.code, name: 'again' })).status, 403, 'codes are one-time');

  assert.equal((await phone('GET', '/api/session')).json.authenticated, false, 'paired is not logged in');
  assert.equal((await phone('GET', '/api/status')).status, 401, 'still needs the passphrase');
  const login = await phone('POST', '/api/login', { password: PW });
  assert.equal(login.status, 200);
  assert.match(jar.__last, /Secure/, 'session cookie is Secure on the phone listener');
  const csrf = login.json.csrf;
  assert.equal((await phone('GET', '/api/status')).status, 200);
  assert.equal((await phone('POST', '/api/kill', { on: false }, csrf)).status, 200, 'kill switch reachable from the phone');
  for (const blocked of ['/api/phone', '/api/banks', '/api/audit']) assert.equal((await phone('GET', blocked)).status, 403, `${blocked} not exposed to the phone`);
  assert.equal((await phone('POST', '/api/phone/pair', {}, csrf)).status, 403, 'a phone cannot pair more devices');
  assert.equal((await phone('GET', '/api/desktop/workloads')).status, 409, 'workloads exist only inside the desktop app');

  const devices = (await desk('GET', '/api/phone')).json.devices;
  assert.deepEqual(devices.map((d) => d.name), ['Test phone']);
  assert.equal((await desk('DELETE', `/api/phone/devices?id=${devices[0].id}`)).status, 200);
  assert.equal((await phone('GET', '/api/status')).status, 401, 'revoked instantly, even with a live session');
  assert.equal((await desk('POST', '/api/phone/enable', { on: false })).json.running, false);
  await assert.rejects(phone('GET', '/remote.html'), 'listener closed');

  // Port taken by another program: enabling fails cleanly and is not remembered as "on".
  const squatter = (await import('node:net')).createServer().listen(PHONE_PORT, '0.0.0.0');
  await new Promise((r) => squatter.once('listening', r));
  const busy = await desk('POST', '/api/phone/enable', { on: true });
  squatter.close();
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /EADDRINUSE/);
  const after = (await desk('GET', '/api/phone')).json;
  assert.deepEqual([after.enabled, after.running], [false, false]);
});
