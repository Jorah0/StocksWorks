# StocksWorks

A self-hosted AI trading desk for stocks and crypto. It bundles a transparent AI opportunity scanner, a Claude-powered analyst with live web research, risk-gated order execution (Alpaca, paper or live), a self-custody crypto wallet panel, Bitcoin mining economics, an investor academy with an AI tutor, and a comparison against the leading AI trading apps.

> Education and tooling, not financial advice. No signal, AI or otherwise, predicts prices reliably. Paper trade first.

## Quick start

Requires Node 22+.

```bash
npm install
cp .env.example .env
npm run hash-password -- "a long unique passphrase"   # paste APP_PASSWORD_HASH into .env
npm run new-totp                                       # paste TOTP_SECRET into .env, add the otpauth URI to your authenticator
# add ALPACA_KEY_ID / ALPACA_SECRET_KEY (free paper keys) and ANTHROPIC_API_KEY
npm start                                              # http://127.0.0.1:8787
npm run verify                                         # tests + syntax checks
```

### Desktop app

```bash
npm run desktop      # starts the server and opens StocksWorks in its own app window; closing it stops the server
npm run shortcuts    # Windows: adds "StocksWorks" and "StocksWorks Rig" to the Desktop and Start Menu
```
The window is Edge or Chrome in app mode with a dedicated profile (no browser chrome, no extra install). It falls back to your default browser if neither is found.

### Remote mining rigs ("Fleet")

The host operator sets one pool and payout address, and every rig mines to it. The **pool pays the host's wallet directly**, so rewards come back to the host without any wallet, key or transfer on the rigs.

1. **Host:** run `npm run make-cert`, then add the printed `FLEET_TLS_CERT`/`FLEET_TLS_KEY` lines and `FLEET_ENABLED=on` to `.env` and restart. Open Mining → Fleet, save the pool and payout, then click **Generate pairing link**.
2. **Each rig:** copy this project (or `git clone`), run `npm install`, then `npm run rig` (or `npm run shortcuts -- -RigOnly`). The minimalist rig window opens.
3. **In the rig window:** paste the link, set the path to your miner (XMRig from github.com/xmrig/xmrig/releases; verify its checksum), and tick **Allow mining on this computer**. Tick **Let the host start and stop mining** if you want central control.
4. **Host:** Run/Stop per rig or for the whole fleet. Hashrate, uptime, errors and owner permissions show live. ✕ revokes a rig instantly.

Rig security:
- The pairing link is one-time, expires in 10 minutes, and carries the host certificate's SHA-256 fingerprint. The rig pins it, so a man-in-the-middle can't pose as the host or swap the payout address.
- Rig tokens are stored hashed on the host.
- The rig listener serves only `/rig/pair` and `/rig/heartbeat`, over TLS only.
- The host can't run commands on a rig. It can only supply pool settings, which the rig re-validates so no extra miner flags can be smuggled in, and run/stop requests the owner opted into.
- The miner program and its arguments are chosen only on the rig.
- The rig UI binds to loopback, with a per-launch token and a DNS-rebinding guard.
- Closing the rig window stops mining. `--headless` exists for dedicated rigs their owner runs unattended.
- Only run rigs on hardware you own or are authorized to use.

The app runs without keys. Mining, the crypto market, watch-only wallets, the Academy and Compare tabs all work on public data. The scanner and trading need Alpaca, and the AI analyst and tutor need Claude.

## Tabs

| Tab | What it does |
|---|---|
| Overview | Equity, day P/L, positions, recent orders, the top-scored setups and your active guardrails |
| AI Scanner | Ranks your watchlist with a 0-100 score (trend 30, momentum 30, RSI zone 20, MACD 20) and a walk-forward backtest against buy-and-hold. Also opens the Claude analyst, with optional web research, which returns stance, confidence, entry, stop and target, risks, sources and a lesson |
| Trade | Order ticket for stocks and crypto with a server-side risk preview. Live mode needs per-order confirmation |
| Crypto & Wallet | Top 25 coins (CoinGecko), watch-only BTC/ETH address balances, and a browser-wallet (EIP-1193) connection that signs transactions in your wallet |
| Mining | Profitability from live network hashrate and fees (mempool.space): rig presets, break-even electricity price, payback period and BTC price sensitivity |
| Academy | 11 lessons with quizzes (progress saved locally), plus the Claude tutor |
| Compare | Feature and price matrix against Trade Ideas, TrendSpider, Tickeron, Danelfin, Composer, Public, TradingView and Coinbase, with sources |
| Integrations | Connection status, webhook formats, key links and the tamper-evident audit log |

## Webhooks and links

**Inbound, TradingView alert → `POST /webhooks/tradingview`.** Expose it only through a TLS tunnel such as Cloudflare Tunnel. The alert message body:
```json
{"secret":"<WEBHOOK_SECRET>","symbol":"{{ticker}}","side":"buy","type":"market","notional":"100"}
```
**Inbound, signed (any service).** Same URL, with these headers:
```
x-timestamp: <unix seconds>                      (must be within 5 minutes)
x-signature: sha256=<hex HMAC_SHA256(WEBHOOK_SECRET, "<timestamp>.<raw body>")>
```
Webhooks only notify unless `WEBHOOK_TRADING=on`. Webhook orders pass the same risk gate as the UI. In live mode they also need `WEBHOOK_LIVE_ACK=I_ACCEPT_REAL_MONEY_RISK`.

**Outbound.** Set `NOTIFY_WEBHOOK_URL` to a Discord or Slack incoming webhook. It fires on orders, the kill switch and alerts.

**Upstream APIs (all called server-side; no keys reach the browser):**

| Service | Used for | Link |
|---|---|---|
| Alpaca Trading API | account, orders, positions (paper `paper-api.alpaca.markets`, live `api.alpaca.markets`) | https://docs.alpaca.markets/ |
| Alpaca Market Data | daily bars, latest trades, news (`data.alpaca.markets`) | https://app.alpaca.markets/signup |
| Anthropic Claude API | analyst (with `web_search`) and tutor | https://console.anthropic.com/ |
| CoinGecko | crypto market table, BTC price | https://www.coingecko.com/en/api |
| mempool.space | BTC hashrate, fees, address balances | https://mempool.space/docs/api/rest |
| Ethereum JSON-RPC | ETH balances (`ETH_RPC_URL`) | https://ethereum-rpc.publicnode.com |
| TradingView alerts | inbound signals | https://www.tradingview.com/support/solutions/43000529348/ |
| Discord / Slack webhooks | outbound alerts | https://support.discord.com/hc/en-us/articles/228383668 · https://api.slack.com/messaging/webhooks |

## Security model

- **Network:** binds to `127.0.0.1` by default. Any other host requires TLS, and HSTS is sent when TLS is on.
- **Auth:** scrypt password hash plus RFC 6238 TOTP (required for live mode). Logins are limited to 5 attempts per 15 min, and every login attempt is audited.
- **Sessions:** a random 256-bit server-side token in an `HttpOnly; SameSite=Strict` cookie (`__Host-` prefixed with TLS), with an 8 h expiry.
- **CSRF:** a per-session token in the `X-CSRF-Token` header plus an Origin check on every state change. JSON bodies only, capped at 64 KB.
- **Browser:** strict CSP (`script-src 'self'`, no inline code, `connect-src 'self'`, `frame-ancestors 'none'`), nosniff, no-referrer, COOP/CORP and a Permissions-Policy. All rendered data is HTML-escaped.
- **Secrets:** broker and AI keys live only in the server's `.env`. Wallets are watch-only. Signing happens in your wallet extension, and seed phrases are never requested or stored.
- **Trading:** paper by default. Live mode requires an explicit acknowledgement env var, TOTP, and confirmation on each order. Server-side limits cover max $ per order, max % of equity per buy, orders per day (counted from the audit log, so restarts don't reset it) and a ±% limit-price fat-finger guard. The kill switch cancels all orders and can flatten positions.
- **AI:** advisory only. It can't place orders, its prompt treats news and web content as untrusted data, and its output is schema-checked before display.
- **Audit:** `data/audit.jsonl` is an append-only, SHA-256 hash-chained log. The UI shows whether the chain is intact.

- **Webhook replays:** an identical authenticated payload is rejected for 10 minutes. Put `{{timenow}}` in TradingView alerts so each one is unique. Expose only `/webhooks/tradingview` through a tunnel, never the whole app, and add the tunnel hostname to `ALLOWED_HOSTS`.
- **Orders:** orders are serialized, so concurrent requests can't race past the daily caps (order count and total $ traded, `MAX_DAILY_NOTIONAL_USD`). Sells can't exceed what you hold (no accidental shorting), and the position cap counts existing holdings. Market orders are refused when the last trade is older than `MAX_PRICE_AGE_SEC` (thin or after-hours tickers).
- **Live confirmation is server-enforced and two-factor:** a passing "Check risk" issues a 2-minute, single-use token HMAC-bound to that exact normalized order. Placing it also needs a fresh authenticator code that can't be replayed, so a hijacked session or injected script can't trade real money. Set `REQUIRE_STOP=on` to make a stop-loss (and so the per-trade risk cap) mandatory on every buy.
- **Bracket orders:** an optional stop-loss and take-profit (stocks, buys) attach at the broker, so they still work if the app is closed. With a stop set, (entry − stop) × qty may not exceed `MAX_RISK_PER_TRADE_PCT` of equity. The ticket's **Size by risk** button computes shares from your risk %, capped by your other limits.
- **Login hardening:** authenticator codes can't be replayed, and expired sessions are swept every 10 minutes.
- **Wallet addresses:** Ethereum addresses are validated with EIP-55 checksums (Keccak-256, `lib/keccak.js`), so a mistyped address is rejected. Sending warns and requires a tick when the wallet isn't on Ethereum mainnet.
- **Records:** Integrations → **Export orders CSV** downloads every placed or rejected order for tax records. Cells are escaped against spreadsheet formula injection. The Overview shows a 3-month equity curve.

**Not included, and why:** in-browser crypto mining (unprofitable for BTC and indistinguishable from cryptojacking); storing private keys (a hot-key server is the most common way people lose crypto); fully autonomous AI trading (only webhook rules you write can trade unattended, and they pass the risk gate).

## Project layout

```
server.js          HTTP(S) server, routes, auth, risk-gated order flow
lib/security.js    scrypt, TOTP, sessions, rate limits, webhook verification, audit chain
lib/risk.js        pre-trade risk gate
lib/signals.js     indicators, composite score, walk-forward backtest (shared with browser)
lib/mining.js      mining economics (shared with browser)
lib/providers.js   Alpaca, CoinGecko, mempool.space, ETH RPC, notifications
lib/ai.js          Claude analyst + tutor
lib/fleet.js       mining fleet: pairing, config/argument validation, rig tokens (shared host + rig)
lib/desktop.js     app-window launcher (Edge/Chrome --app)
desktop.js         desktop entry point for the host
rig/               rig agent (agent.js) + its minimalist UI
scripts/           install-shortcuts.ps1
public/            index.html, app.js, content.js (lessons, comparison), app.css
test/              node:test suites (npm test)
```
