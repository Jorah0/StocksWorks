import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { validateSettings, updateEnvFile } from '../lib/envfile.js';

const ALPACA = { ALPACA_KEY_ID: 'PKABCDEFGHIJ1234', ALPACA_SECRET_KEY: 'abcdefghijABCDEFGHIJ0123456789xyz' };

test('settings validation: formats, pairs, blank keeps, injection rejected', () => {
  assert.equal(validateSettings(ALPACA).ok, true);
  assert.equal(validateSettings({ ALPACA_KEY_ID: 'PKABCDEFGHIJ1234' }).ok, false, 'secret missing');
  assert.equal(validateSettings({ ALPACA_KEY_ID: 'PKABCDEFGHIJ1234' }, { ALPACA_SECRET_KEY: 'x' }).ok, true, 'secret already set');
  assert.equal(validateSettings({}).ok, false, 'nothing to change');
  for (const evil of [
    { ANTHROPIC_API_KEY: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa\nTRADING_MODE=live' },
    { NOTIFY_WEBHOOK_URL: 'https://hooks.slack.com/x\nLIVE_TRADING_ACK=I_ACCEPT_REAL_MONEY_RISK' },
    { NOTIFY_WEBHOOK_URL: 'http://evil.example/x' },
    { PLAID_ENV: 'development' },
    { ALPACA_KEY_ID: 'pk lower case', ALPACA_SECRET_KEY: ALPACA.ALPACA_SECRET_KEY },
  ]) assert.equal(validateSettings(evil).ok, false, JSON.stringify(evil));
  assert.deepEqual(validateSettings({ ...ALPACA, TRADING_MODE: 'live' }).updates, ALPACA, 'unknown keys ignored');
  const SCHWAB = { SCHWAB_CLIENT_ID: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345', SCHWAB_CLIENT_SECRET: 'Zy9Xw8Vu7Ts6Rq5P' };
  assert.equal(validateSettings(SCHWAB).ok, true);
  assert.equal(validateSettings({ SCHWAB_CLIENT_ID: SCHWAB.SCHWAB_CLIENT_ID }).ok, false, 'Schwab needs both');
  assert.equal(validateSettings({ ...SCHWAB, SCHWAB_CLIENT_SECRET: 'bad secret\nSCHWAB_TRADING=on' }).ok, false);
  assert.equal(validateSettings({ SCHWAB_TRADING: 'on' }).ok, false, 'trading switch is .env-only, like live mode');
});

test('env file update: replaces values and commented placeholders, appends new, keeps the rest', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-env-')), '.env');
  fs.writeFileSync(file, 'APP_PASSWORD_HASH=scrypt$a$b\n# ALPACA_KEY_ID=\nALPACA_SECRET_KEY=old\nTRADING_MODE=paper\n');
  updateEnvFile(file, { ...ALPACA, PLAID_ENV: 'sandbox' });
  const env = util.parseEnv(fs.readFileSync(file, 'utf8'));
  assert.equal(env.APP_PASSWORD_HASH, 'scrypt$a$b');
  assert.equal(env.ALPACA_KEY_ID, ALPACA.ALPACA_KEY_ID);
  assert.equal(env.ALPACA_SECRET_KEY, ALPACA.ALPACA_SECRET_KEY);
  assert.equal(env.PLAID_ENV, 'sandbox');
  assert.equal(env.TRADING_MODE, 'paper');
  assert.throws(() => updateEnvFile(file, { TRADING_MODE: 'live' }), 'only known settings can be written');
  assert.throws(() => updateEnvFile(file, { PLAID_ENV: 'x\nY=1' }));
});

test('env file update: with a commented AND an active line, the active one is updated (it is the one that loads)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-env-')), '.env');
  fs.writeFileSync(file, '# PLAID_ENV=\nPLAID_ENV=production\n');
  updateEnvFile(file, { PLAID_ENV: 'sandbox' });
  assert.equal(util.parseEnv(fs.readFileSync(file, 'utf8')).PLAID_ENV, 'sandbox');
});
