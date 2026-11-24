// Opens a local URL as a standalone desktop app window (Edge/Chrome/Chromium "--app" mode).
// ponytail: no Electron. Every Windows 10/11 box ships Edge; packaging with Electron is the upgrade path if you need an .exe installer.
import fs from 'node:fs';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const CANDIDATES = {
  win32: [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'],
};

export function findBrowser() {
  for (const c of CANDIDATES[process.platform] ?? CANDIDATES.linux) {
    if (c.includes('/') || c.includes('\\') ? fs.existsSync(c) : spawnSync('which', [c]).status === 0) return c;
  }
  return null;
}

/** Returns the window's process (exits when the window closes), or null if it fell back to the default browser. */
export function openAppWindow(url, profileDir, { width = 1400, height = 900 } = {}) {
  const browser = findBrowser();
  if (!browser) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    return null;
  }
  fs.mkdirSync(profileDir, { recursive: true });
  // A dedicated profile makes this its own process, so we can tell when the window is closed.
  return spawn(browser, [`--app=${url}`, `--user-data-dir=${profileDir}`, `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });
}

export function waitForPort(port, host = '127.0.0.1', timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, host, () => { s.destroy(); resolve(); });
      s.on('error', () => (Date.now() > until ? reject(new Error(`Nothing listening on ${host}:${port}`)) : setTimeout(tryOnce, 250)));
    };
    tryOnce();
  });
}
