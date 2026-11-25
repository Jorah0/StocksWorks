// Automated phone-app emulation test: runs the real desktop app on a throwaway profile, opens the phone emulator
// for each device, unlocks, visits every tab, screenshots each and fails on console errors, 5xx responses,
// horizontal overflow or error cards. Usage: npm run phone:test [-- iphone,pixel] [--out <dir>]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from '../lib/security.js';

const ROOT = path.join(import.meta.dirname, '..');
const electron = createRequire(import.meta.url)('electron'); // path to the Electron binary
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = path.resolve(outAt >= 0 ? args[outAt + 1] : path.join(os.tmpdir(), 'stocksworks-phone-test'));
const devices = (args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1)) ?? 'iphone,pixel,galaxy,ipad').split(',');

const pw = crypto.randomBytes(18).toString('base64url');
let failed = false;
for (const device of devices) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-phone-profile-'));
  fs.writeFileSync(path.join(profile, '.env'), `APP_PASSWORD_HASH=${hashPassword(pw)}\nTRADING_MODE=paper\nPORT=18878\nPHONE_PORT=18879\n`);
  const dir = path.join(out, device);
  fs.rmSync(dir, { recursive: true, force: true });
  const env = { ...process.env, STOCKSWORKS_USERDATA: profile, STOCKSWORKS_PHONE_TEST: dir, STOCKSWORKS_TEST_PASSPHRASE: pw, STOCKSWORKS_PHONE_DEVICE: device };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (/^(ALPACA|ANTHROPIC|PLAID|SCHWAB|FINVIZ|MESSARI|TOTP|AUTOPILOT|LIVE_TRADING|BANK_)/.test(k)) delete env[k]; // never a real account
  const code = await new Promise((resolve) => {
    const child = spawn(electron, [ROOT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const t = setTimeout(() => { child.kill(); resolve(-1); }, 180_000);
    child.on('exit', (c) => { clearTimeout(t); if (c) console.log(log.slice(-2000)); resolve(c); });
  });
  fs.rmSync(profile, { recursive: true, force: true });
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')); } catch { console.log(`✖ ${device}: no report (app exit ${code})`); failed = true; continue; }
  const problems = [
    report.fatal && `fatal: ${report.fatal}`,
    ...report.consoleErrors.map((e) => `console: ${e}`),
    ...report.failedRequests.map((e) => `request: ${e}`),
    ...report.tabs.filter((t) => t.overflow).map((t) => `${t.tab}: content wider than the screen`),
    ...report.tabs.filter((t) => t.width != null && report.screenWidth && t.width !== report.screenWidth).map((t) => `${t.tab}: laid out at ${t.width}px, not the device's ${report.screenWidth}px (phone viewport not applied)`),
    ...report.tabs.filter((t) => t.error).map((t) => `${t.tab}: ${t.error}`),
    report.tabs.length < 2 && 'never got past the lock screen',
  ].filter(Boolean);
  console.log(`${problems.length ? '✖' : '✔'} ${report.device}: ${report.tabs.map((t) => t.tab).join(', ')}  (screenshots: ${dir})`);
  for (const p of problems) console.log(`   - ${p}`);
  failed ||= problems.length > 0;
}
process.exit(failed ? 1 : 0);
