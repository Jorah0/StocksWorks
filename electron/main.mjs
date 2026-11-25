// StocksWorks desktop app (Electron). Runs the trading server in-process on loopback and shows it in a native,
// hardened window. Config + data live in the user's profile (%APPDATA%\StocksWorks), never inside the app.
import { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain, session, nativeImage, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import util from 'node:util';
import { hashPassword, verifyPassword, base32Encode, verifyTotp } from '../lib/security.js';
import { SETTINGS, validateSettings, updateEnvFile } from '../lib/envfile.js';
import { createSupervisor, sha256File } from '../lib/supervisor.js';
import { KINDS } from '../lib/workloads.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ICON = path.join(ROOT, 'build', 'icon.png');
if (process.env.STOCKSWORKS_USERDATA) app.setPath('userData', path.resolve(process.env.STOCKSWORKS_USERDATA)); // isolated test profiles
const DATA = app.getPath('userData');
const ENV_FILE = path.join(DATA, '.env');
const BG = '#070c17';

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); } // second launch: hand focus to the first and stop here
let mainWin = null, shareWin = null, tray = null, appUrl = null, quitting = false;
// --minimized: started at login. --share: opened from the "Compute Share" shortcut (main window stays minimized).
const START_MIN = process.argv.includes('--minimized') || process.argv.includes('--share');

// ---------------- desktop preferences (non-secret) ----------------
const PREFS_FILE = path.join(DATA, 'desktop.json');
let prefs = { closeToTaskbar: true };
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }; } catch { /* defaults */ }
const savePrefs = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), { mode: 0o600 }); };
const LOGIN_ARGS = app.isPackaged ? ['--minimized'] : [ROOT, '--minimized'];
const startsAtLogin = () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
// Screenshot/eval test hooks exist only when running from source, never in the packaged exe.
const TEST_HOOKS = !app.isPackaged && Boolean(process.env.STOCKSWORKS_SCREENSHOT);

// ---------------- hardening shared by every window ----------------
const secureWebPrefs = (preload) => ({ preload: path.join(HERE, preload), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false });
function harden(win, allowedPrefix) {
  // New windows never open inside the app; https links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
  const guard = (e, url) => {
    if (url.startsWith(allowedPrefix)) return;
    e.preventDefault();
    if (url.startsWith('https://')) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

// ---------------- first-run setup ----------------
const needsSetup = () => !fs.existsSync(ENV_FILE) || !/^APP_PASSWORD_HASH=scrypt\$/m.test(fs.readFileSync(ENV_FILE, 'utf8'));
// Values go into KEY=value lines: anything outside the expected format (incl. newlines) is rejected.
const clean = (v, re) => { const s = String(v ?? '').trim(); if (!s) return ''; if (!re.test(s)) throw new Error('invalid'); return s; };

function runSetup() {
  return new Promise((resolve) => {
    const pendingTotp = base32Encode(crypto.randomBytes(20));
    const w = new BrowserWindow({ width: 680, height: 880, resizable: false, show: false, backgroundColor: BG, icon: ICON, title: 'Set up StocksWorks', autoHideMenuBar: true, webPreferences: secureWebPrefs('setup-preload.cjs') });
    harden(w, pathToFileURL(path.join(HERE, 'setup.html')).href); // only the setup page itself
    w.once('ready-to-show', () => w.show());
    let saved = false;
    ipcMain.handle('setup:totp', async () => {
      const uri = `otpauth://totp/StocksWorks?secret=${pendingTotp}&issuer=StocksWorks`;
      return { secret: pendingTotp, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: '#0b1220', light: '#ffffff' } }) };
    });
    ipcMain.handle('setup:save', async (_e, d) => {
      try {
        const pw = String(d?.password ?? '');
        if (pw.length < 12 || pw.length > 512) return { error: 'Passphrase must be 12-512 characters' };
        if (pw !== String(d?.confirm ?? '')) return { error: 'Passphrases do not match' };
        if (d?.enable2fa && !verifyTotp(pendingTotp, String(d?.totpCode ?? ''))) return { error: 'That authenticator code is not valid. Check the time on your phone and enter the current code.' };
        let keyId, secret, anthropic;
        try {
          keyId = clean(d?.alpacaKey, /^[A-Z0-9]{10,40}$/);
          secret = clean(d?.alpacaSecret, /^[A-Za-z0-9/+=_-]{20,100}$/);
          anthropic = clean(d?.anthropicKey, /^sk-ant-[A-Za-z0-9_-]{20,300}$/);
        } catch { return { error: 'One of the API keys has an unexpected format. Paste it again without spaces.' }; }
        if (Boolean(keyId) !== Boolean(secret)) return { error: 'Enter both the Alpaca key ID and secret (or neither)' };
        const lines = [
          '# StocksWorks desktop settings. Advanced options: see .env.example in the project.',
          `APP_PASSWORD_HASH=${hashPassword(pw)}`,
          d?.enable2fa ? `TOTP_SECRET=${pendingTotp}` : '# TOTP_SECRET=',
          'TRADING_MODE=paper',
          keyId ? `ALPACA_KEY_ID=${keyId}` : '# ALPACA_KEY_ID=',
          secret ? `ALPACA_SECRET_KEY=${secret}` : '# ALPACA_SECRET_KEY=',
          anthropic ? `ANTHROPIC_API_KEY=${anthropic}` : '# ANTHROPIC_API_KEY=',
          `WEBHOOK_SECRET=${crypto.randomBytes(32).toString('base64url')}`,
          `BANK_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64url')}`,
          '',
        ];
        fs.mkdirSync(DATA, { recursive: true });
        if (fs.existsSync(ENV_FILE)) {
          // Never destroy an existing settings file: back it up, and keep the keys that existing data depends on
          // (bank tokens are sealed with BANK_ENCRYPTION_KEY; webhook senders know WEBHOOK_SECRET).
          fs.copyFileSync(ENV_FILE, `${ENV_FILE}.bak-${Date.now()}`);
          const old = util.parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
          for (const k of ['BANK_ENCRYPTION_KEY', 'WEBHOOK_SECRET']) {
            if (old[k]) { const i = lines.findIndex((l) => l.startsWith(`${k}=`)); lines[i] = `${k}=${old[k]}`; }
          }
        }
        fs.writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
        saved = true;
        setImmediate(() => w.close());
        return { ok: true };
      } catch (e) { return { error: e.message }; }
    });
    w.on('closed', () => {
      ipcMain.removeHandler('setup:totp'); ipcMain.removeHandler('setup:save');
      if (saved) resolve(); else app.quit();
    });
    if (TEST_HOOKS) {
      w.webContents.once('did-finish-load', () => setTimeout(async () => {
        fs.writeFileSync(process.env.STOCKSWORKS_SCREENSHOT, (await w.webContents.capturePage()).toPNG());
        app.exit(0);
      }, 2000));
    }
    w.loadFile(path.join(HERE, 'setup.html'));
  });
}

// ---------------- in-app Connections settings (desktop only) ----------------
const readEnv = () => util.parseEnv(fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "");
// Only the app's own pages (main window, Compute Share window) may use the desktop bridge.
const fromApp = (e) => Boolean(appUrl) && String(e.senderFrame?.url ?? '').startsWith(appUrl);
let passFails = [];
/** null if the StocksWorks passphrase is right; else an error. 5 wrong tries lock it for 15 minutes. */
function checkPassphrase(p) {
  passFails = passFails.filter((t) => Date.now() - t < 15 * 60_000);
  if (passFails.length >= 5) return 'Too many wrong passphrases. Try again in 15 minutes.';
  if (!verifyPassword(String(p ?? ''), readEnv().APP_PASSWORD_HASH)) { passFails.push(Date.now()); return 'Wrong passphrase'; }
  return null;
}
function registerSettingsIpc() {
  ipcMain.handle('desktop:settings:get', (e) => {
    if (!fromApp(e)) return { error: 'Not allowed' };
    const env = readEnv();
    return { set: Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, Boolean(env[k])])), plaidEnv: env.PLAID_ENV || 'sandbox', dataFolder: DATA };
  });
  ipcMain.handle('desktop:settings:save', async (e, d) => {
    if (!fromApp(e)) return { error: 'Not allowed' };
    const bad = checkPassphrase(d?.passphrase);
    if (bad) return { error: bad };
    const v = validateSettings(d?.values, readEnv());
    if (!v.ok) return { error: v.error };
    updateEnvFile(ENV_FILE, v.updates);
    // Restart so the server picks up the new connections; app.exit skips will-quit, so stop workloads first.
    setTimeout(async () => { await supervisor?.stopAll(); app.relaunch(); app.exit(0); }, 400);
    return { ok: true, changed: v.changed };
  });
}

// ---------------- local mining & compute sharing ----------------
let supervisor = null, picked = null, serverHooks = {};
function registerWorkloadIpc() {
  supervisor = createSupervisor({ file: path.join(DATA, 'workloads.json'), idleSec: () => powerMonitor.getSystemIdleTime(), onBattery: () => powerMonitor.isOnBatteryPower() });
  setInterval(() => supervisor.tick().catch((err) => console.error('workloads:', err.message)), 15_000);
  const handle = (name, fn) => ipcMain.handle(`desktop:${name}`, async (e, ...args) => {
    if (!fromApp(e)) return { error: 'Not allowed' };
    try { return (await fn(e, ...args)) ?? { ok: true }; } catch (err) { return { error: err.message }; }
  });
  handle('wl:list', () => ({ workloads: supervisor.list(), kinds: KINDS }));
  // The program is chosen in a native dialog and hashed here; a web page can never name a file to run.
  handle('wl:pick', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose the program to run', properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    picked = { exe: r.filePaths[0], sha256: await sha256File(r.filePaths[0]), sender: e.sender.id }; // only the window that picked it can use it
    return { exe: picked.exe, sha256: picked.sha256.slice(0, 12) };
  });
  handle('wl:save', async (e, d) => {
    const bad = checkPassphrase(d?.passphrase);
    if (bad) return { error: bad };
    const old = d?.workload?.id ? supervisor.list().find((x) => x.id === d.workload.id) : null;
    const prog = d?.useNewProgram && picked?.sender === e.sender.id ? picked : null;
    if (!prog && !old) return { error: 'Choose the program to run' };
    // Final say in a native dialog the web page can't draw or click: what will run, and where rewards go.
    const w = d.workload, exe = prog?.exe ?? old.exe;
    const pay = w.pool ? `\nPool: ${w.pool}\nPayout address: ${w.payout}` : '';
    const ok = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
      type: 'warning', buttons: ['Approve', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: 'Approve program',
      message: `Allow StocksWorks to run this program on your schedule?`,
      detail: `${exe}\nSHA-256: ${(prog?.sha256 ?? '').slice(0, 16) || 'unchanged'}${pay}\n\nOnly approve software you downloaded from its official source.`,
    });
    if (ok.response !== 0) return { error: 'Not approved' };
    const saved = supervisor.save(w, prog ?? undefined);
    if (prog) picked = null;
    supervisor.tick().catch(() => {});
    return { ok: true, id: saved.id };
  });
  handle('wl:toggle', async (_e, id, on) => { await supervisor.toggle(String(id), on === true); supervisor.tick().catch(() => {}); });
  handle('wl:remove', (_e, id) => supervisor.remove(String(id)));
  handle('prefs:get', () => ({ closeToTaskbar: prefs.closeToTaskbar, startAtLogin: startsAtLogin() }));
  handle('prefs:set', (_e, d) => {
    if (typeof d?.closeToTaskbar === 'boolean') { prefs.closeToTaskbar = d.closeToTaskbar; savePrefs(); }
    if (typeof d?.startAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: d.startAtLogin, args: LOGIN_ARGS });
    return { closeToTaskbar: prefs.closeToTaskbar, startAtLogin: startsAtLogin() };
  });
  handle('openShare', () => { openShareWindow(); });
  handle('openPhone', async (_e, device) => { await openPhoneEmulator(Object.hasOwn(PHONES, device) ? device : 'iphone'); });
}

// ---------------- server ----------------
function freePort(preferred) {
  const probe = (port) => new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(null)).once('listening', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.listen(port, '127.0.0.1');
  });
  return probe(preferred).then((p) => p ?? probe(0));
}

async function startServer() {
  process.loadEnvFile(ENV_FILE);
  Object.assign(process.env, { STOCKSWORKS_DATA: DATA, STOCKSWORKS_EMBEDDED: '1', HOST: '127.0.0.1' }); // desktop UI is loopback-only
  process.env.PORT = String(await freePort(Number(process.env.PORT) || 8787));
  const server = await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
  await server.ready;
  serverHooks = server.desktopHooks;
  return `http://127.0.0.1:${process.env.PORT}/`;
}

// ---------------- windows, tray ----------------
function showMain() { if (!appUrl) return; if (!mainWin) createMainWindow(); if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }

// Compute Share: a small, separate window for the compute-sharing workloads (same hardened bridge).
function openShareWindow() {
  if (!appUrl) return;
  if (shareWin) { if (shareWin.isMinimized()) shareWin.restore(); shareWin.show(); shareWin.focus(); return; }
  shareWin = new BrowserWindow({ width: 600, height: 860, minWidth: 460, minHeight: 600, backgroundColor: BG, icon: ICON, title: 'StocksWorks Compute Share', autoHideMenuBar: true, webPreferences: secureWebPrefs('preload.cjs') });
  harden(shareWin, appUrl);
  shareWin.on('closed', () => { shareWin = null; });
  if (TEST_HOOKS && process.env.STOCKSWORKS_SCREENSHOT_SHARE) {
    shareWin.webContents.once('did-finish-load', () => setTimeout(async () => {
      fs.writeFileSync(process.env.STOCKSWORKS_SCREENSHOT_SHARE, (await shareWin.webContents.capturePage()).toPNG());
      app.quit();
    }, 2500));
  }
  shareWin.loadURL(`${appUrl}share.html`);
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1100, minHeight: 700, show: false, backgroundColor: BG, icon: ICON, title: 'StocksWorks',
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b1324', symbolColor: '#e6ecf7', height: 52 },
    webPreferences: secureWebPrefs('preload.cjs'),
  });
  harden(mainWin, appUrl);
  mainWin.once('ready-to-show', () => { if (START_MIN) { mainWin.showInactive(); mainWin.minimize(); } else mainWin.show(); });
  // The close button minimizes to the taskbar (so mining/sharing keep their schedule) unless turned off in Integrations.
  mainWin.on('close', (e) => { if (!quitting && prefs.closeToTaskbar) { e.preventDefault(); mainWin.minimize(); } });
  mainWin.on('session-end', () => { quitting = true; }); // Windows sign-out/shutdown must not be blocked by close-to-taskbar
  mainWin.on('closed', () => { mainWin = null; });
  // Test hook: STOCKSWORKS_SCREENSHOT=<file.png> captures the window once loaded, then quits.
  if (TEST_HOOKS && !process.env.STOCKSWORKS_SCREENSHOT_SHARE) {
    mainWin.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.STOCKSWORKS_TEST_PASSPHRASE) { // test-only: sign in and open a tab before capturing
        await mainWin.webContents.executeJavaScript(`(() => { const f = document.getElementById('loginForm');
          f.password.value = ${JSON.stringify(process.env.STOCKSWORKS_TEST_PASSPHRASE)}; f.requestSubmit(); })()`);
        await new Promise((r) => setTimeout(r, 2000));
        if (process.env.STOCKSWORKS_TEST_TAB) await mainWin.webContents.executeJavaScript(`document.querySelector('[data-tab=${JSON.stringify(process.env.STOCKSWORKS_TEST_TAB)}]').click()`);
        await new Promise((r) => setTimeout(r, 2500));
        if (process.env.STOCKSWORKS_TEST_EVAL) console.log('TEST_EVAL', JSON.stringify(await mainWin.webContents.executeJavaScript(process.env.STOCKSWORKS_TEST_EVAL)));
      }
      fs.writeFileSync(process.env.STOCKSWORKS_SCREENSHOT, (await mainWin.webContents.capturePage()).toPNG());
      app.quit();
    }, 2500));
  }
  mainWin.loadURL(appUrl);
}

// ---------------- phone emulator ----------------
// The real phone app, served by the real phone listener (TLS + pairing + phone route allowlist), in a window that
// emulates a phone: screen size, pixel density, touch input and a mobile user agent. What works here works on a phone.
const PHONES = {
  iphone: { name: 'iPhone 15', w: 393, h: 852, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  pixel: { name: 'Pixel 8', w: 412, h: 915, dpr: 2.625, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' },
  galaxy: { name: 'Galaxy S23', w: 360, h: 780, dpr: 3, ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' },
  ipad: { name: 'iPad mini', w: 744, h: 1133, dpr: 2, ua: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
};
const PHONE_PARTITION = 'persist:phone-emulator'; // its own cookie jar: paired once, like a real phone
let phoneWin = null;
async function openPhoneEmulator(deviceId = 'iphone') {
  if (!serverHooks?.phoneEmulator) return null;
  const d = PHONES[deviceId] ?? PHONES.iphone;
  if (phoneWin && phoneWin.__device === deviceId) { phoneWin.show(); phoneWin.focus(); return phoneWin; }
  phoneWin?.destroy();
  const ses = session.fromPartition(PHONE_PARTITION);
  const paired = (await ses.cookies.get({ name: 'swdev' })).length > 0;
  const { url, origin, fingerprint } = await serverHooks.phoneEmulator({ paired });
  // Pinned: this session trusts exactly the StocksWorks phone certificate on loopback, nothing else.
  ses.setCertificateVerifyProc((req, cb) => {
    try { cb(req.hostname === '127.0.0.1' && new crypto.X509Certificate(req.certificate.data).fingerprint256 === fingerprint ? 0 : -2); } catch { cb(-2); }
  });
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  const ua = `${d.ua} StocksWorksEmulator`;
  const win = new BrowserWindow({
    useContentSize: true, width: d.w, height: d.h, resizable: false, maximizable: false, backgroundColor: BG, icon: ICON, autoHideMenuBar: true,
    title: `StocksWorks phone emulator · ${d.name}`,
    webPreferences: { partition: PHONE_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  win.__device = deviceId;
  phoneWin = win;
  harden(win, `${origin}/`);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { if (phoneWin === win) { phoneWin = null; serverHooks.phoneEmulatorClosed?.(); } });
  const wc = win.webContents;
  wc.setUserAgent(ua);
  await win.loadURL(url);
  // Phone viewport (device-width layout, pixel density) + touch via the DevTools protocol, the engine behind
  // Chrome's device mode. Sent once a page exists: before the first load the target can close under us.
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: true, screenWidth: d.w, screenHeight: d.h });
    await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await wc.debugger.sendCommand('Page.reload', {}); // re-lay out from scratch at the phone's width
    await new Promise((r) => wc.once('did-finish-load', r));
  } catch (e) { console.warn('phone emulation:', e.message); }
  return win;
}

/**
 * Automated phone test (source runs only): STOCKSWORKS_PHONE_TEST=<dir> plus STOCKSWORKS_TEST_PASSPHRASE.
 * Opens the emulator, unlocks, visits every tab, screenshots each, and writes report.json (console errors,
 * failed requests, horizontal overflow, tab errors) before quitting. scripts/emulate-phone.mjs drives it.
 */
async function runPhoneTest(dir) {
  const report = { device: null, step: 'start', tabs: [], consoleErrors: [], failedRequests: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  const finish = () => { fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2)); app.exit(0); };
  setTimeout(() => { report.fatal = `timed out at step: ${report.step}`; finish(); }, 120_000).unref(); // a hang still reports where
  try {
    const deviceId = process.env.STOCKSWORKS_PHONE_DEVICE || 'iphone';
    report.device = PHONES[deviceId]?.name ?? deviceId;
    report.screenWidth = PHONES[deviceId]?.w ?? null;
    const ses = session.fromPartition(PHONE_PARTITION);
    ses.webRequest.onCompleted((det) => { if (det.statusCode >= 500) report.failedRequests.push(`${det.statusCode} ${det.method} ${new URL(det.url).pathname}`); });
    report.step = 'open emulator';
    const win = await openPhoneEmulator(deviceId);
    const wc = win.webContents;
    wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') report.consoleErrors.push(String(e.message).slice(0, 300)); });
    const js = (code) => wc.executeJavaScript(code);
    report.step = 'unlock';
    await wait(2500);
    await js(`(() => { const f = document.getElementById('loginForm'); if (f) { f.password.value = ${JSON.stringify(process.env.STOCKSWORKS_TEST_PASSPHRASE ?? '')}; f.requestSubmit(); } })()`);
    await wait(2500);
    const tabs = await js(`[...document.querySelectorAll('#rNav:not([hidden]) button[data-tab]')].map((b) => b.dataset.tab)`);
    if (!tabs.length) report.tabs.push({ tab: 'login', error: await js(`document.getElementById('rView').innerText.slice(0, 300)`) });
    for (const t of tabs) {
      report.step = `tab ${t}`;
      await js(`document.querySelector('#rNav [data-tab=${JSON.stringify(t)}]').click()`);
      await wait(3500);
      const r = await js(`({ overflow: document.documentElement.scrollWidth > window.innerWidth + 1, width: window.innerWidth,
        error: [...document.querySelectorAll('#rView .card.err')].map((x) => x.innerText).join(' | ').slice(0, 300) || null,
        text: document.getElementById('rView').innerText.slice(0, 160) })`);
      const shot = await wc.capturePage().catch(async () => { await wait(1500); return wc.capturePage(); }); // GPU busy: one retry
      fs.writeFileSync(path.join(dir, `${deviceId}-${t}.png`), shot.toPNG());
      report.tabs.push({ tab: t, ...r });
    }
    report.step = 'done';
  } catch (e) { report.fatal = `${report.step}: ${e.message}`; report.stack = String(e.stack).split('\n').slice(0, 6); }
  finish();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('StocksWorks');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open StocksWorks', click: showMain },
    { label: 'Compute Share', click: openShareWindow },
    { label: 'Phone emulator', submenu: Object.entries(PHONES).map(([id, d]) => ({ label: d.name, click: () => openPhoneEmulator(id).catch((e) => dialog.showErrorBox('Phone emulator', e.message)) })) },
    { label: 'Open in web browser', click: () => shell.openExternal(appUrl) },
    { label: 'Open settings & data folder', click: () => shell.openPath(DATA) },
    { type: 'separator' },
    { label: 'Pause all mining && sharing', click: () => supervisor?.pauseAll() },
    { label: 'Quit StocksWorks', click: () => app.quit() },
  ]));
  tray.on('click', showMain);
}

app.on('second-instance', (_e, argv) => (argv.includes('--share') ? openShareWindow() : showMain()));
app.on('window-all-closed', () => app.quit()); // with "close minimizes" off, closing the last window quits
app.on('before-quit', () => { quitting = true; });
let workloadsStopped = false;
app.on('will-quit', (e) => { // mining/sharing programs never outlive the app
  if (workloadsStopped || !supervisor) return;
  e.preventDefault();
  workloadsStopped = true;
  supervisor.stopAll().finally(() => app.quit());
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.stocksworks.desktop');
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // no camera/mic/geo/notification prompts
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle('desktop:openInBrowser', (e) => fromApp(e) && shell.openExternal(appUrl));
  ipcMain.handle('desktop:openDataFolder', (e) => fromApp(e) && shell.openPath(DATA));
  registerSettingsIpc();
  try {
    if (needsSetup()) await runSetup();
    appUrl = await startServer();
  } catch (e) {
    dialog.showErrorBox('StocksWorks could not start', `${e.message}\n\nSettings file: ${ENV_FILE}`);
    app.quit();
    return;
  }
  registerWorkloadIpc();
  serverHooks.supervisor = supervisor; // lets the API (and so the paired phone) switch approved workloads on/off
  createMainWindow();
  createTray();
  if (process.argv.includes('--share')) openShareWindow();
  const phoneArg = process.argv.find((a) => a.startsWith('--phone'));
  if (!app.isPackaged && process.env.STOCKSWORKS_PHONE_TEST) runPhoneTest(path.resolve(process.env.STOCKSWORKS_PHONE_TEST));
  else if (phoneArg) openPhoneEmulator(phoneArg.split('=')[1]).catch((e) => dialog.showErrorBox('Phone emulator', e.message));
  supervisor.tick().catch(() => {});
});
