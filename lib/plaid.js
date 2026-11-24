// Plaid: link banks (balances, account/routing numbers for wires/ACH) and outside brokerages (holdings).
// Server-side only; client_id/secret never reach the browser. Access tokens are sealed at rest by the caller.
import { HttpError } from './providers.js';

const BASE = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
export const LINK_KINDS = { bank: ['auth'], brokerage: ['investments'] };

export function createPlaid({ clientId, secret, env = 'sandbox', fetchImpl = fetch } = {}) {
  if (!clientId || !secret) return { configured: false };
  if (!Object.hasOwn(BASE, env)) throw new Error('PLAID_ENV must be sandbox or production');
  async function call(path, body = {}) {
    const r = await fetchImpl(BASE[env] + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ client_id: clientId, secret, ...body }),
    });
    let data = {};
    try { data = await r.json(); } catch { /* keep {} */ }
    // Plaid errors carry error_code/error_message; never echo the request (it contains the secret).
    if (!r.ok) throw new HttpError(r.status >= 500 ? 502 : 400, `Plaid: ${data.error_message || data.error_code || r.status}`);
    return data;
  }
  return {
    configured: true, env,
    linkToken: (kind, userId) => call('/link/token/create', {
      client_name: 'StocksWorks', language: 'en', country_codes: ['US'], user: { client_user_id: userId },
      products: LINK_KINDS[kind] ?? LINK_KINDS.bank,
    }),
    exchange: (publicToken) => call('/item/public_token/exchange', { public_token: publicToken }),
    balances: (accessToken) => call('/accounts/balance/get', { access_token: accessToken }),
    auth: (accessToken) => call('/auth/get', { access_token: accessToken }),
    holdings: (accessToken) => call('/investments/holdings/get', { access_token: accessToken }),
    remove: (accessToken) => call('/item/remove', { access_token: accessToken }),
  };
}
