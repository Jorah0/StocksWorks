// Pre-trade risk gate. Every order (UI, AI-prefilled, or webhook) passes through validateOrder before reaching the broker.

export const STOCK_RE = /^[A-Z]{1,5}(?:\.[A-Z])?$/;
export const CRYPTO_RE = /^[A-Z0-9]{2,10}\/USD[CT]?$/;
const NUM_RE = /^\d{1,12}(?:\.\d{1,9})?$/; // plain decimals only: no exponents, signs, hex
export const isCrypto = (s) => CRYPTO_RE.test(s);

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
/** NYSE regular session (09:30-16:00 New York time, Mon-Fri). ponytail: ignores exchange holidays; a closed day just returns stale prices. */
export function usMarketOpen(d = new Date()) {
  const p = Object.fromEntries(ET.formatToParts(d).map((x) => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 570 && m < 960;
}

/**
 * @param o   raw order {symbol, side, type, qty|notional, limit_price?, confirm?}
 * @param ctx {mode:'paper'|'live', killSwitch, price (latest), equity, ordersToday, limits}
 * @returns {ok, errors[], order (broker-ready), notional}
 */
export function validateOrder(o = {}, ctx) {
  const errors = [];
  const L = ctx.limits;
  const symbol = String(o.symbol ?? '').trim().toUpperCase();
  const crypto = isCrypto(symbol);
  if (!STOCK_RE.test(symbol) && !crypto) errors.push('Invalid symbol (stocks: AAPL, BRK.B; crypto: BTC/USD)');
  if (!['buy', 'sell'].includes(o.side)) errors.push('Side must be buy or sell');
  if (!['market', 'limit', 'trailing_stop'].includes(o.type)) errors.push('Type must be market, limit or trailing_stop');
  if (o.type === 'trailing_stop') {
    // Trailing stops protect an existing long: the stop follows the price up by trail_percent and sells on reversal.
    const tp = Number(o.trail_percent);
    if (!NUM_RE.test(String(o.trail_percent ?? '')) || !(tp >= 0.1 && tp <= 20)) errors.push('trail_percent must be 0.1-20');
    if (o.side !== 'sell') errors.push('Trailing stops are sell orders that protect a position you hold');
    if (crypto) errors.push('Trailing stops are only available for stocks');
    if (o.qty == null || o.qty === '' || !/^\d+$/.test(String(o.qty))) errors.push('Trailing stops need a whole-share quantity');
  }

  const hasQty = o.qty != null && o.qty !== '';
  const hasNotional = o.notional != null && o.notional !== '';
  if (hasQty === hasNotional) errors.push('Provide exactly one of qty or notional ($)');
  for (const f of ['qty', 'notional', 'limit_price']) {
    if (o[f] != null && o[f] !== '' && (!NUM_RE.test(String(o[f])) || Number(o[f]) <= 0)) errors.push(`${f} must be a positive decimal`);
  }
  if (o.type === 'limit' && !o.limit_price) errors.push('Limit orders need a limit_price');
  if (o.type === 'limit' && hasNotional) errors.push('Use qty (not notional) for limit orders');
  for (const f of ['stop_loss', 'take_profit']) {
    if (o[f] != null && o[f] !== '' && (!NUM_RE.test(String(o[f])) || Number(o[f]) <= 0)) errors.push(`${f} must be a positive decimal`);
  }
  const bracket = Boolean(o.stop_loss || o.take_profit);
  if (bracket) {
    if (!o.stop_loss || !o.take_profit) errors.push('Bracket orders need both a stop-loss and a take-profit');
    if (crypto) errors.push('Bracket (stop/target) orders are only available for stocks');
    if (o.side !== 'buy') errors.push('Brackets protect new long positions: use them on buy orders');
    if (!hasQty || !/^\d+$/.test(String(o.qty))) errors.push('Bracket orders need a whole-share quantity');
  }

  if (ctx.killSwitch) errors.push('Kill switch is ON - all trading halted');
  // ctx.confirmed is computed by the server (a redeemed, order-bound confirmation token), never taken from the request.
  if (ctx.mode === 'live' && ctx.confirmed !== true) errors.push('Live orders need a fresh confirmation: run "Check risk" and confirm this exact order');
  if (ctx.ordersToday >= L.maxOrdersPerDay) errors.push(`Daily order limit reached (${L.maxOrdersPerDay})`);
  // Fail closed: an unknown price age counts as stale.
  if (o.type === 'market' && L.maxPriceAgeSec && !(ctx.priceAgeSec != null && Number(ctx.priceAgeSec) <= L.maxPriceAgeSec))
    errors.push(ctx.priceAgeSec == null ? 'Age of the last trade is unknown (stale price risk): use a limit order'
      : `Last trade is ${Math.round(ctx.priceAgeSec / 60)} min old (stale price): use a limit order`);
  if (L.requireStop && o.side === 'buy' && !o.stop_loss) errors.push('A stop-loss is required on every buy (REQUIRE_STOP=on)');

  const price = Number(ctx.price);
  const heldQty = Number(ctx.heldQty) || 0;
  let notional = null, riskUsd = null;
  if (!(price > 0)) errors.push('No reference price available - cannot size risk');
  else if (!(Number(ctx.equity) > 0)) errors.push('Account equity unavailable - refusing to size risk');
  else {
    const px = o.type === 'limit' ? Number(o.limit_price) : price;
    notional = hasNotional ? Number(o.notional) : Number(o.qty) * px;
    if (notional > L.maxOrderUsd) errors.push(`Order $${notional.toFixed(2)} exceeds max order size $${L.maxOrderUsd}`);
    // Position cap includes what you already hold, not just this order.
    if (o.side === 'buy' && (Number(ctx.heldValue) || 0) + notional > (ctx.equity * L.maxPositionPct) / 100)
      errors.push(`Position would exceed ${L.maxPositionPct}% of account equity`);
    // No accidental shorting: a sell can only reduce an existing long.
    if (o.side === 'sell') {
      const sellQty = hasQty ? Number(o.qty) : Number(o.notional) / px;
      if (sellQty > heldQty + 1e-9) errors.push(`You hold ${heldQty} ${symbol}; sells cannot exceed your position (no shorting)`);
    }
    if (o.type === 'limit' && Math.abs(px / price - 1) * 100 > L.maxLimitDeviationPct)
      errors.push(`Limit price deviates >${L.maxLimitDeviationPct}% from last price (fat-finger guard)`);
    if (L.maxDailyNotionalUsd && (Number(ctx.notionalToday) || 0) + notional > L.maxDailyNotionalUsd)
      errors.push(`Would exceed the daily traded limit of $${L.maxDailyNotionalUsd} ($${(Number(ctx.notionalToday) || 0).toFixed(0)} used today)`);
    if (bracket && o.stop_loss && o.take_profit) {
      const stop = Number(o.stop_loss), target = Number(o.take_profit);
      if (!(stop < px)) errors.push('Stop-loss must be below the entry price');
      if (!(target > px)) errors.push('Take-profit target must be above the entry price');
      if (stop < px && L.maxRiskPerTradePct) {
        riskUsd = Number(o.qty) * (px - stop);
        if (riskUsd > (ctx.equity * L.maxRiskPerTradePct) / 100)
          errors.push(`Risk to stop $${riskUsd.toFixed(2)} exceeds ${L.maxRiskPerTradePct}% of equity: move the stop closer or buy fewer shares`);
      }
    }
  }
  if (!crypto && hasQty && !/^\d+$/.test(String(o.qty)) && o.type === 'limit') errors.push('Fractional stock qty only allowed for market orders');

  const order = { symbol, side: o.side, type: o.type, time_in_force: crypto || o.type === 'trailing_stop' ? 'gtc' : 'day' };
  if (o.type === 'trailing_stop') order.trail_percent = String(o.trail_percent);
  if (hasQty) order.qty = String(o.qty);
  if (hasNotional) order.notional = String(o.notional);
  if (o.type === 'limit') order.limit_price = String(o.limit_price);
  if (bracket) Object.assign(order, { order_class: 'bracket', stop_loss: { stop_price: String(o.stop_loss) }, take_profit: { limit_price: String(o.take_profit) } });
  return { ok: errors.length === 0, errors, order, notional, riskUsd };
}
