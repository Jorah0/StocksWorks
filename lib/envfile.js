// Validated updates to the desktop app's .env (KEY=value lines). Pure + fs only, so it is unit-tested outside Electron.
import fs from 'node:fs';

// Every accepted value matches a strict pattern: no whitespace or newlines can reach the file, so no key injection.
export const SETTINGS = {
  ALPACA_KEY_ID: ['Alpaca key ID', /^[A-Z0-9]{10,40}$/],
  ALPACA_SECRET_KEY: ['Alpaca secret', /^[A-Za-z0-9/+=_-]{20,100}$/],
  ANTHROPIC_API_KEY: ['Anthropic API key', /^sk-ant-[A-Za-z0-9_-]{20,300}$/],
  PLAID_CLIENT_ID: ['Plaid client ID', /^[a-f0-9]{24}$/],
  PLAID_SECRET: ['Plaid secret', /^[a-f0-9]{30}$/],
  PLAID_ENV: ['Plaid environment', /^(sandbox|production)$/],
  SCHWAB_CLIENT_ID: ['Schwab app key', /^[A-Za-z0-9]{16,64}$/],
  SCHWAB_CLIENT_SECRET: ['Schwab app secret', /^[A-Za-z0-9]{8,64}$/],
  NOTIFY_WEBHOOK_URL:['Discord/Slack webhook URL', /^https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?\/[\w\-./~%?=&]{1,300}$/],
};

/** values: user input (blank = keep). current: parsed current env. */
export function validateSettings(values = {}, current = {}) {
  const updates = {};
  for (const [k, [label, re]] of Object.entries(SETTINGS)) {
    const v = String(values?.[k] ?? '').trim();
    if (!v) continue;
    if (!re.test(v)) return { ok: false, error: `${label} has an unexpected format` };
    updates[k] = v;
  }
  const has = (k) => Boolean(updates[k] || current[k]);
  if (has('ALPACA_KEY_ID') !== has('ALPACA_SECRET_KEY')) return { ok: false, error: 'Alpaca needs both the key ID and the secret' };
  if (has('PLAID_CLIENT_ID') !== has('PLAID_SECRET')) return { ok: false, error: 'Plaid needs both the client ID and the secret' };
  if (has('SCHWAB_CLIENT_ID') !== has('SCHWAB_CLIENT_SECRET')) return { ok: false, error: 'Schwab needs both the app key and the secret' };
  if (!Object.keys(updates).length) return { ok: false, error: 'Nothing to change' };
  return { ok: true, updates, changed: Object.keys(updates).map((k) => SETTINGS[k][0]) };
}

/** Replace KEY= (or a commented "# KEY=") line in place, else append; atomic write. */
export function updateEnvFile(file, updates) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [k, v] of Object.entries(updates)) {
    if (!Object.hasOwn(SETTINGS, k) || !SETTINGS[k][1].test(v)) throw new Error(`Refusing to write ${k}`);
    // Prefer the active line (the last active one wins when the file is loaded), else a commented placeholder.
    const active = lines.findLastIndex((l) => l.startsWith(`${k}=`));
    const i = active >= 0 ? active : lines.findIndex((l) => new RegExp(`^#\\s*${k}=`).test(l));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${k}=${v}`);
  }
  fs.writeFileSync(file + '.tmp', lines.join('\n'), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
