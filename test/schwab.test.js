import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchwab, codeFromRedirect, toSchwabOrder, accountView } from '../lib/schwab.js';

test('schwab: authorize URL and pasted-back redirect parsing', () => {
  const s = createSchwab({ clientId: 'APPKEY1234567890ABCD', secret: 'SECRET123456' });
  const u = new URL(s.authorizeUrl());
  assert.equal(u.origin + u.pathname, 'https://api.schwabapi.com/v1/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'APPKEY1234567890ABCD');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://127.0.0.1');
  assert.equal(codeFromRedirect('https://127.0.0.1/?code=C0.abc.def%40&session=7ce316f9'), 'C0.abc.def@');
  assert.throws(() => codeFromRedirect('https://evil.example/?code=C0.abc.def%40'), /callback/);
  assert.throws(() => codeFromRedirect('https://127.0.0.1/?session=1'), /code/);
  assert.throws(() => codeFromRedirect('not a url'), /address/);
  assert.equal(createSchwab({}).configured, false);
});

test('schwab: tokens exchange with Basic auth, refresh near expiry, and expire after 7 days', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({ access_token: `A${calls.length}`, refresh_token: 'R1', expires_in: 1800 }), { status: 200 });
  };
  const s = createSchwab({ clientId: 'APPKEY1234567890ABCD', secret: 'SECRET123456', fetchImpl });
  const t0 = 1_000_000;
  const tok = await s.exchange('C0.code@', t0);
  assert.equal(calls[0].url, 'https://api.schwabapi.com/v1/oauth/token');
  assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('APPKEY1234567890ABCD:SECRET123456').toString('base64')}`);
  assert.equal(new URLSearchParams(calls[0].opts.body).get('grant_type'), 'authorization_code');
  assert.deepEqual({ access: tok.access, refresh: tok.refresh, accessExp: tok.accessExp, refreshExp: tok.refreshExp }, { access: 'A1', refresh: 'R1', accessExp: t0 + 1_800_000, refreshExp: t0 + 7 * 86_400_000 });
  assert.equal(await s.fresh(tok, t0 + 60_000), tok, 'still valid: no network call');
  const next = await s.fresh(tok, t0 + 1_790_000);
  assert.equal(next.access, 'A2');
  assert.equal(new URLSearchParams(calls[1].opts.body).get('grant_type'), 'refresh_token');
  assert.equal(next.refreshExp, tok.refreshExp, 'refreshing does not extend the 7-day window');
  await assert.rejects(s.fresh(tok, t0 + 8 * 86_400_000), (e) => e.status === 409 && /7 days/.test(e.message));
});

test('schwab: order mapping is equity-only, whole shares, market/limit, no brackets', () => {
  assert.deepEqual(toSchwabOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: '3' }), {
    orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE',
    orderLegCollection: [{ instruction: 'BUY', quantity: 3, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  });
  assert.equal(toSchwabOrder({ symbol: 'MSFT', side: 'sell', type: 'limit', qty: '2', limit_price: '410.5' }).price, '410.5');
  for (const bad of [
    { symbol: 'BTC/USD', side: 'buy', type: 'market', qty: '1' },
    { symbol: 'AAPL', side: 'buy', type: 'market', notional: '100' },
    { symbol: 'AAPL', side: 'buy', type: 'market', qty: '0.5' },
    { symbol: 'AAPL', side: 'sell', type: 'trailing_stop', qty: '1', trail_percent: '2' },
    { symbol: 'AAPL', side: 'buy', type: 'market', qty: '1', order_class: 'bracket' },
  ]) assert.throws(() => toSchwabOrder(bad), JSON.stringify(bad));
});

test('schwab: account view masks the number and nets long/short quantities', () => {
  const v = accountView({ securitiesAccount: { accountNumber: '12345678', type: 'MARGIN', currentBalances: { liquidationValue: 5000, cashBalance: 1200, buyingPower: 2400 },
    positions: [{ instrument: { symbol: 'AAPL', assetType: 'EQUITY' }, longQuantity: 10, shortQuantity: 0, marketValue: 2000, averagePrice: 150, currentDayProfitLoss: 12 }] } }, { '12345678': 'HASHVALUE' });
  assert.equal(v.hash, 'HASHVALUE');
  assert.equal(v.mask, '5678');
  assert.equal(JSON.stringify(v).includes('12345678'), false, 'full account number never leaves the server');
  assert.deepEqual(v.positions[0], { symbol: 'AAPL', assetType: 'EQUITY', qty: 10, marketValue: 2000, avgPrice: 150, dayPl: 12 });
  assert.equal(v.equity, 5000);
});
