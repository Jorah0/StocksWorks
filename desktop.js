// Desktop entry point: starts the StocksWorks server and opens it as an app window.
// Closing the window shuts the server down. Run: npm run desktop (or the desktop shortcut).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openAppWindow, waitForPort } from './lib/desktop.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST === '0.0.0.0' || !process.env.HOST ? '127.0.0.1' : process.env.HOST;
const url = `${process.env.TLS_CERT ? 'https' : 'http'}://${host}:${port}/`;

const server = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.js'], { cwd: ROOT, stdio: 'inherit' });
server.on('exit', (code) => { console.log(`server exited (${code})`); process.exit(code ?? 0); });
const stop = () => server.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  await waitForPort(port, host);
} catch (e) {
  console.error(e.message); stop(); process.exit(1);
}
const win = openAppWindow(url, path.join(ROOT, 'data', 'desktop-profile'));
if (win) win.on('exit', stop);
else console.log(`Opened ${url} in your default browser. Press Ctrl+C here to stop StocksWorks.`);
