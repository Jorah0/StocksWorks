// Charles Schwab Trader API: connect (OAuth, code pasted back from the browser), accounts + positions, quotes,
// equity orders. Server-side only; tokens are sealed at rest by the caller. Schwab has no paper environment,
// so every Schwab order is a real-money order and goes through the live gates in server.js.
import { HttpError } from './providers.js';
import { STOCK_RE } from './risk.js';

const API = 'https://api.schwabapi.com';
export const DEFAULT_REDIRECT = 'https://127.0.0.1';
const DAY = 86_400_000;

/** Schwab redirects to https://127.0.0.1/?code=...%40&session=... (a "can't connect" page); the user pastes that address. */
export function codeFromRedirect(pasted, redirectUri = DEFAULT_REDIRECT) {
  let u;
  try { u = new URL(String(pasted ?? '').trim()); } catch { throw new HttpError(400, 'Paste the full address from the browser bar (it starts with https://127.0.0.1)'); }
  if (u.origin !== new URL(redirectUri).origin) throw new HttpError(400, 'That address is not your Schwab callback URL');
  const code = u.searchParams.get('code') ?? '';
  if (!/^[A-Za-z0-9.@_~+/=-]{8,2000}$/.test(code)) throw new HttpError(400, 'No authorization code in that address: sign in again and paste the new address');
  return code;
}

export function toSchwabOrder(o) {
  if (!STOCK_RE.test(o.symbol)) throw new HttpError(400, 'Schwab orders: US stocks and ETFs only');
  if (!['market', 'limit'].includes(o.type)) throw new HttpError(400, 'Schwab orders: market or limit only');
  if (o.order_class || !/^\d+$/.test(String(o.qty ?? ''))) throw new HttpError(400, 'Schwab orders: whole-share quantity, no stop/target brackets (place the stop at Schwab)');
  return {
    orderType: o.type.toUpperCase(), session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE',
    ...(o.type === 'limit' ? { price: String(o.limit_price) } : {}),
    orderLegCollection: [{ instruction: o.side.toUpperCase(), quantity: Number(o.qty), instrument: { symbol: o.symbol, assetType: 'EQUITY' } }],
  };
}

/** Browser-safe view: the opaque account hash Schwab uses in URLs, never the account number. */
export function accountView(a, hashes = {}) {
  const s = a?.securitiesAccount ?? {};
  const b = s.currentBalances ?? {};
  return {
    hash: hashes[s.accountNumber] ?? null, mask: String(s.accountNumber ?? '').slice(-4), type: s.type ?? null,
    equity: b.liquidationValue ?? null, cash: b.cashBalance ?? null, buyingPower: b.buyingPower ?? null,
    positions: (s.positions ?? []).map((p) => ({
      symbol: p.instrument?.symbol, assetType: p.instrument?.assetType, qty: (p.longQuantity ?? 0) - (p.shortQuantity ?? 0),
      marketValue: p.marketValue, avgPrice: p.averagePrice, dayPl: p.currentDayProfitLoss,
    })),
  };
}

export function createSchwab({ clientId, secret, redirectUri = DEFAULT_REDIRECT, fetchImpl = fetch } = {}) {
  if (!clientId || !secret) return { configured: false };
  const basic = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
  async function call(path, opts = {}) {
    const r = await fetchImpl(API + path, { redirect: 'error', signal: AbortSignal.timeout(20_000), ...opts });
    let data = {};
    try { const t = await r.text(); data = t ? JSON.parse(t) : {}; } catch { /* keep {} */ }
    if (!r.ok) {
      const msg = data.error_description || data.message || data.errors?.[0]?.detail || data.error || r.status;
      throw new HttpError(r.status === 401 ? 409 : r.status >= 500 ? 502 : 400, `Schwab: ${msg}${r.status === 401 ? ' (reconnect Schwab)' : ''}`);
    }
    return { data, headers: r.headers };
  }
  const token = async (params) => (await call('/v1/oauth/token', {
    method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  })).data;
  const get = async (path, access) => (await call(path, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } })).data;
  return {
    configured: true, redirectUri,
    authorizeUrl: () => `${API}/v1/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri })}`,
    async exchange(code, now = Date.now()) {
      const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      return { access: t.access_token, refresh: t.refresh_token, accessExp: now + (t.expires_in ?? 1800) * 1000, refreshExp: now + 7 * DAY };
    },
    /** Same object if the access token has > 60 s left; else refreshed. Schwab refresh tokens die after 7 days. */
    async fresh(tok, now = Date.now()) {
      if (tok.accessExp - now > 60_000) return tok;
      if (tok.refreshExp <= now) throw new HttpError(409, 'Schwab connection expired (Schwab requires signing in again every 7 days). Reconnect Schwab.');
      const t = await token({ grant_type: 'refresh_token', refresh_token: tok.refresh });
      return { ...tok, access: t.access_token, refresh: t.refresh_token || tok.refresh, accessExp: now + (t.expires_in ?? 1800) * 1000 };
    },
    accounts: (access) => get('/trader/v1/accounts?fields=positions', access),
    accountNumbers: (access) => get('/trader/v1/accounts/accountNumbers', access),
    async quote(access, symbol) {
      const q = (await get(`/marketdata/v1/quotes?symbols=${encodeURIComponent(symbol)}`, access))?.[symbol]?.quote ?? {};
      return { price: q.lastPrice ?? null, at: q.tradeTime ?? q.quoteTime ?? null };
    },
    async placeOrder(access, accountHash, order) {
      if (!/^[A-Za-z0-9]{16,128}$/.test(String(accountHash))) throw new HttpError(400, 'Pick a Schwab account');
      const { headers } = await call(`/trader/v1/accounts/${accountHash}/orders`, {
        method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify(order),
      });
      // Schwab answers 201 with the new order's URL in Location and an empty body.
      return { id: (headers.get('location') ?? '').split('/').pop() || null, status: 'accepted' };
    },
  };
}
