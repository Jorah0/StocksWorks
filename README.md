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

### Windows desktop app (.exe)

```bash
npm run dist:win     # builds dist/StocksWorks-win32-x64/StocksWorks.exe (Electron; ~380 MB folder, no Node needed to run it)
npm run app          # run the desktop app from source
```

Double-click `StocksWorks.exe`:
- **First run:** a setup screen creates your passphrase, optional two-factor login (scan the QR code with your authenticator app), and optional Alpaca and Claude keys.
- **Where settings live:** `%APPDATA%\StocksWorks` (settings file plus data), never inside the program folder.
- **Changing keys later:** Integrations → **Desktop settings** (passphrase required; the app restarts itself).
- **Window and tray:** the header doubles as the title bar. The tray icon opens the app, Compute Share, the browser view or the settings folder, and can pause all mining and sharing.
- **Closing:** the close button minimizes to the taskbar, so mining and sharing keep their schedule. Quit from the tray. Turn this off, or turn on **start when I sign in to Windows**, under Integrations → **Window & startup**.
- **Compute Share:** `StocksWorks.exe --share` opens just the Compute Share window (it's also in the tray and on the Mining tab).
- **Hardening:** sandboxed, context-isolated renderer with no Node access, navigation locked to the app, links opening in your browser, and every permission prompt denied.
- **Wallet extensions:** MetaMask and similar can't run inside the app. Use "Open StocksWorks in your browser" for those.

If you launch it from a VS Code terminal, run `set ELECTRON_RUN_AS_NODE=` first, because VS Code sets a variable that makes Electron behave as plain Node.

### Browser-window mode (no build)

```bash
npm run desktop      # starts the server and opens StocksWorks in an Edge/Chrome app window; closing it stops the server
npm run shortcuts    # Windows: adds "StocksWorks" and "StocksWorks Rig" to the Desktop and Start Menu
```
The window is Edge or Chrome in app mode with a dedicated profile (no browser chrome, no extra install). It falls back to your default browser if neither is found.

### Mining and compute sharing on this computer (desktop app)

- **Where:** Mining tab → **Mine on this computer**, or the **Compute Share** window.
- **Program:** add XMRig for CPU or GPU (NVIDIA CUDA or AMD OpenCL), any other miner, the BOINC client, or another compute-sharing program that runs as a normal app.
- **Approval:** you pick the `.exe` in a Windows file dialog and approve it with your passphrase. Its SHA-256 is recorded, and a program whose file changes is refused until you re-approve it.
- **Rules per program:**
  - on/off;
  - active hours (overnight windows work);
  - only while you're away (idle minutes);
  - pause on battery;
  - a daily-hours limit;
  - for XMRig CPU, a CPU-thread cap (10-100%).
- **Running:** programs run at below-normal priority with no shell, and their output shows in the app. Turning one off, or quitting StocksWorks, stops the program and its child processes.
- **Payouts:** the pool or network pays the address or account you set up. StocksWorks never holds keys.

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

### AI Lab: choose, teach, benchmark and design your own model

The AI Lab tab follows the *Local AI Marketplace* handbook, scaled to this app.

- **Your hardware:**
  - live GPU readings per device (nvidia-smi), RAM, disk, CPU and the Python training tools;
  - **workload profiles** (Idle, OBS live/gaming, or your own) that reserve memory, giving budget = free GPU memory − reserve;
  - **Ollama hosts on your network** (`OLLAMA_HOST=0.0.0.0` on the other machine, then add `http://ip:11434`).
- **Choose a model:**
  - every model installed on every host, with an estimated VRAM range (weights + KV cache for your context and simultaneous requests + overhead) and % of GPU;
  - a verdict: **Fits** (with GiB left), **Borderline**, **Too big** (with the shortfall) or **Unknown**;
  - Hugging Face search (metadata only), with one-click **Install** of GGUF repos into Ollama;
  - **Use** pins the exact model digest for the local analyst.
- **Teach the analyst (the learning loop):**
  - your local model and **Claude (premium teacher)** analyse the same evidence;
  - the local model is held to the analyst JSON schema by Ollama structured output;
  - you **accept, correct or reject** each answer;
  - accepted and corrected answers form a downloadable SFT dataset (`/api/ai-lab/dataset.jsonl`, chat-format JSONL). It's split by symbol, so nothing leaks between train, dev and test, and duplicates are removed. Answers built on third-party news are kept out of training.
  - Without a broker connection the evidence is clearly labelled synthetic practice data.
- **Benchmark & pick the best:**
  - runs several models on the same symbols and reports valid-JSON rate, agreement with your reviewed answers, and p50/p95 latency;
  - a **transparent score** of 100 × Σ weight × normalized metric with weights you set;
  - a model missing a measurement gets no rank rather than a guess.
- **Design your own model:**
  - set vocabulary, layers, width, heads, KV heads, head dimension, context and seed, or start from a preset;
  - see the **exact parameter count**, training memory and served size against your hardware, and the updates and training time for a token budget once a pilot has measured your speed;
  - **Build & verify** constructs it in Python with random weights (no downloads) and checks the count;
  - **Train pilot** trains a tokenizer and the model on the Academy lessons, your journal and text you add, with live loss;
  - **Export to Ollama** writes a GGUF and imports it as `sw-<name>`, and it then appears in the catalog like any other model.

- **Training setup**: one click installs a private Python environment (`%LOCALAPPDATA%StocksWorkspyenv`, your system Python is untouched) with PyTorch for your NVIDIA GPU (CUDA 13.0 or 12.6, chosen from your driver) or CPU-only, plus transformers and peft. Choose how training runs: device (GPU/CPU), precision (bf16/fp16/fp32), gradient accumulation and gradient checkpointing.
- **Fine-tune an existing model**: LoRA on a Hugging Face base (SmolLM2 135M/360M/1.7B suggested) using your reviewed examples. Loss counts only the answer, the dev split measures progress and the test split stays untouched. The adapter is merged and **Export to Ollama** keeps the chat format.
- **Teach via AIs**: a teacher (Claude, or a bigger local model) labels a batch of symbols, either queued for your review or auto-accepted. Claude answers are kept out of training by default (Anthropic's terms restrict training AI models on its outputs); enable it only if your agreement allows. Local teachers: check the teacher model's license.

Requirements: Ollama, plus Python 3.10+ for training (the setup button installs everything else). A home-made or 135M model mostly learns format and style; quality analysis still comes from larger models.

### Phone app (remote control over Wi-Fi)

1. On the PC, open Integrations → **Phone remote** → **Turn on phone access**. If Windows asks, allow StocksWorks on **private networks** only.
2. Press **Pair a phone** and scan the QR code with your phone's camera. The code is one-time and valid for 10 minutes.
3. The phone warns once that the certificate isn't trusted. It's StocksWorks' own self-signed certificate; its SHA-256 fingerprint is shown on the PC. Continue, then unlock with your passphrase (and authenticator code if 2FA is on).
4. Install it: **Share → Add to Home Screen** on iPhone, or **⋮ → Add to Home screen** on Android. It opens full-screen like an app.

What the phone can do:
- **Home:** equity, today's P&L, positions (close), open orders (cancel), and the kill switch.
- **Trade:** the same risk check, with live-mode 2FA and confirmation.
- **Mining:** switch this PC's approved miners and compute-sharing programs on or off, pause all, and run or stop remote rigs.
- **Alerts:** recent alerts.

What it can't do: approve programs, pair other phones, reveal bank numbers, or change settings or keys. Those stay on the PC.

Security:
- Phone access is off by default and has its own TLS listener (port 8789, `PHONE_PORT`). The certificate is generated in-app, no openssl needed.
- An unpaired device gets only the pairing page.
- A paired phone holds a 90-day device token (HttpOnly, Secure, SameSite=Strict, stored hashed) **and** still needs your passphrase.
- Requests are limited to a fixed allowlist of routes.
- Removing a phone on the PC cuts it off on its next request.
- Pairing attempts are rate-limited, and pairing, unpairing and phone-originated switches are audited.
- **Away from home:** install [Tailscale](https://tailscale.com/download) on the PC and the phone, then pair using the PC's 100.x address. Don't port-forward 8789 to the internet.

## Tabs

| Tab | What it does |
|---|---|
| Overview | Equity, day P/L, positions, recent orders, the top-scored setups and your active guardrails |
| AI Scanner | Ranks your watchlist with a 0-100 score (trend 30, momentum 30, RSI zone 20, MACD 20) and a walk-forward backtest against buy-and-hold. Also opens the Claude analyst, with optional web research, which returns stance, confidence, entry, stop and target, risks, sources and a lesson |
| Trade | Order ticket for stocks and crypto with a server-side risk preview, stop-loss/take-profit brackets and a "Size by risk" position sizer. Live mode needs a fresh authenticator code per order |
| Portfolio | Allocation and concentration, Sharpe/Sortino/volatility/max drawdown, a correlation heatmap of what you hold, close 25/50/100% of a position, trailing-stop protection, cancel open orders |
| Strategy Lab | Backtest 4 strategies (composite score, SMA crossover, RSI mean reversion, Donchian breakout) with adjustable settings on ~3 years of data: CAGR, Sharpe, Sortino, drawdown, win rate, trades, all against buy-and-hold |
| Alerts | Price-above/below, daily-move and AI-score alerts, checked every minute on the server; one-shot with re-arm; sent to Discord/Slack and an in-app feed |
| Crypto & Wallet | Top 25 coins (CoinGecko), watch-only BTC/ETH balances, browser-wallet (EIP-1193) sending, and **wallet creation**: a 24-word BIP-39 phrase generated in your browser and never sent anywhere, verified, then its ETH and BTC addresses added to watch-only |
| Banks | **Charles Schwab** direct (balances, positions; trading from the order ticket when SCHWAB_TRADING=on). Link US banks (balances; account and routing numbers for wires/ACH, revealed behind 2FA) and outside brokerages (Fidelity, Schwab, Robinhood… holdings) via Plaid; linked net worth; how to fund your trading account |
| Mining | Profitability from live network hashrate and fees (mempool.space): rig presets, break-even electricity price, payback period and BTC price sensitivity |
| Academy | 11 lessons with quizzes, the Claude tutor, and a **trade journal** (thesis, setup, emotion, outcome, lesson) with win rate and expectancy by setup and emotion |
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

- **Wallet creation:** the recovery phrase is generated in the browser by audited libraries (`@scure/bip39`, `@scure/bip32`, `@noble/curves`, `@noble/hashes`) from the platform's secure random generator. It's shown only on screen (copying is discouraged), checked by asking for 3 random words, then cleared. It's never sent to the server, stored or logged. Derivation paths are standard: ETH `m/44'/60'/0'/0/0` (MetaMask, Rabby, Trust) and BTC `m/84'/0'/0'/0/0` (Sparrow, Electrum), verified against the official BIP-84 and MetaMask test vectors. After `npm install`, rebuild the browser bundle with `npm run build:wallet`.
- **Bank linking:** you sign in to your bank inside Plaid's window, so StocksWorks never sees bank passwords. Plaid access tokens are encrypted at rest with AES-256-GCM (`BANK_ENCRYPTION_KEY`, required, or the server refuses to start). Account numbers are masked. Revealing full account and routing numbers needs a fresh authenticator code, is rate-limited and audited, and the numbers hide after 60 seconds. The page loads Plaid's script only when Plaid is configured.
- **Schwab:** OAuth sign-in happens at Schwab; you paste back the redirect address. Tokens are sealed with the same AES-256-GCM key, and the browser sees only a masked account number and Schwab's opaque account hash. Schwab has no paper mode, so every Schwab order is treated as live: it needs SCHWAB_TRADING=on, TOTP, a passing risk check whose token is bound to that exact order, broker and account, a fresh authenticator code, and it counts toward the same daily caps. Webhooks can never place Schwab orders.
- **What it can't do:** move money between banks. That needs Plaid Transfer (approval required) or a bank's own API, and Alpaca's retail API has no deposit endpoint. The Banks tab shows how to fund by ACH or wire through Alpaca's dashboard instead.

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
