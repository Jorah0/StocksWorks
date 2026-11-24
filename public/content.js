// Static content: Academy curriculum + competitor comparison. Plain data, rendered with escaping in app.js.

export const LESSONS = [
  {
    id: 'risk', title: '1. Risk first: position sizing and stops',
    body: `Professionals decide how much they can lose before deciding what to buy.
The 1% rule: risk at most 1% of your account on one trade. With $20,000 and a stop 5% below entry, the position size is $20,000 × 1% ÷ 5% = $4,000.
A stop-loss is decided before entry and never moved further away. StocksWorks enforces a hard cap per order, a cap per position (% of equity), a daily order limit and a kill switch, so a bad day stays a bad day rather than a disaster.`,
    quiz: { q: 'Account $10,000, 1% risk, stop 4% below entry. Maximum position size?', options: ['$400', '$2,500', '$4,000', '$10,000'], answer: 1 },
  },
  {
    id: 'trend', title: '2. Trend: moving averages',
    body: `A simple moving average (SMA) is the mean of the last N closes. Price above a rising 50-day SMA is the textbook definition of an uptrend; the 20-day crossing above the 50-day is a "golden cross" style confirmation.
Trend-following works in persistent trends and bleeds in choppy ranges. That is why the scanner weights trend at only 30 of 100 points.`,
    quiz: { q: 'Price $105, SMA20 $102, SMA50 $98 and rising. The scanner would call this trend…', options: ['Down', 'Mixed', 'Up (full trend points)'], answer: 2 },
  },
  {
    id: 'momentum', title: '3. Momentum and RSI',
    body: `Momentum is the tendency of recent winners to keep winning over weeks to months. The scanner measures the 20-day return.
RSI(14) compares average gains to average losses on a 0-100 scale. Above 70 is "overbought" (strong but stretched), below 30 is "oversold". The scanner prefers 45-65: healthy strength that is not yet stretched.`,
    quiz: { q: 'RSI of 82 means…', options: ['The stock must fall', 'Strong recent gains; entry risk is higher', 'The stock is cheap'], answer: 1 },
  },
  {
    id: 'macd', title: '4. MACD: is momentum accelerating?',
    body: `MACD = EMA(12) − EMA(26). Its signal line is a 9-period EMA of MACD, and the histogram is the gap between them.
A positive and rising histogram means short-term momentum is improving relative to longer-term momentum. It lags, like every indicator built from past prices.`,
    quiz: { q: 'A MACD histogram that is negative but rising suggests…', options: ['Downside momentum is fading', 'A guaranteed rally', 'Nothing at all'], answer: 0 },
  },
  {
    id: 'vol', title: '5. Volatility and the expected move',
    body: `Volatility is the standard deviation of returns. The scanner shows a "1-sigma 20-day move" = price × daily volatility × √20.
Roughly two thirds of the time, price ends a 20-day window within that band, in either direction. Use it to set stops outside normal noise and to size positions: higher volatility means a smaller position for the same dollar risk.`,
    quiz: { q: 'Price $100, daily volatility 2%. The 1-sigma 20-day move is about…', options: ['$2', '$8.94', '$40'], answer: 1 },
  },
  {
    id: 'backtest', title: '6. Backtesting honestly',
    body: `A backtest replays a rule on history. Common traps: look-ahead bias (using data you would not have had at that moment), overfitting (tuning until the past looks perfect), survivorship bias (testing only companies that still exist) and ignoring fees.
StocksWorks' walk-forward test decides each day using only data up to that day and charges a fee on every switch. Always compare against buy-and-hold: many signals lose to doing nothing.`,
    quiz: { q: 'A strategy returned +12% while buy-and-hold returned +30% with less work. Conclusion?', options: ['Great strategy', 'It underperformed the passive benchmark', 'Increase leverage'], answer: 1 },
  },
  {
    id: 'ai', title: '7. Using AI without being used by it',
    body: `AI can read more news and filings than you can, and explain a setup clearly. It cannot see the future. In a public 2026 test, eight AI models each traded $10,000 of real money for two weeks; only 6 of 32 runs ended in profit.
Treat AI as a research assistant: check its sources, compare its thesis to the numbers, and keep your own risk rules. In StocksWorks the AI can only suggest; you place the order.`,
    quiz: { q: 'The AI says "bullish, 80% confidence". What do you do first?', options: ['Buy with all buying power', 'Check sources, size by your stop, and paper trade it', 'Ignore all AI forever'], answer: 1 },
  },
  {
    id: 'diversify', title: '8. Diversification and the index baseline',
    body: `Most active traders underperform a low-cost index fund after fees and taxes. A sensible structure is a core of broad index funds plus a small "satellite" for active ideas.
Correlation matters: owning five chip stocks is one bet, not five.`,
    quiz: { q: 'You own NVDA, AMD, AVGO, TSM and SMH. How diversified is this?', options: ['Very', 'Concentrated in one sector', 'Perfectly hedged'], answer: 1 },
  },
  {
    id: 'crypto', title: '9. Crypto: custody, keys and scams',
    body: `"Not your keys, not your coins": assets on an exchange are an IOU from that exchange. Self-custody means you hold the private key, usually in a hardware wallet.
Your seed phrase is the master key. Never type it into any website or app, this one included. StocksWorks only stores public addresses (watch-only) and asks your browser wallet to sign; it never sees a key.
Common scams: fake support agents, "airdrop" approvals that drain wallets, and guaranteed-yield schemes.`,
    quiz: { q: 'A "support agent" asks for your 24-word phrase to fix a stuck transaction. You…', options: ['Send it', 'Refuse: nobody legitimate ever needs it', 'Send half the words'], answer: 1 },
  },
  {
    id: 'mining', title: '10. Mining economics',
    body: `Your share of rewards ≈ your hashrate ÷ network hashrate. Revenue per day ≈ share × 144 blocks × (subsidy + fees) × BTC price, minus pool fees.
Electricity usually decides profit: an ASIC at 17 J/TH and $0.06/kWh can profit while the same rig at $0.15/kWh loses money. Difficulty adjusts every ~2 weeks and rises as more miners join, so today's profit is an upper bound. Browser or CPU mining of Bitcoin is not profitable.`,
    quiz: { q: 'Network hashrate doubles while price stays flat. Your BTC mined per day…', options: ['Doubles', 'Roughly halves', 'Stays the same'], answer: 1 },
  },
  {
    id: 'tax', title: '11. Records and taxes',
    body: `Every sale is a taxable event in most countries, including crypto-to-crypto swaps. Short-term gains (held ≤1 year in the US) are usually taxed higher. The US wash-sale rule disallows a loss if you rebuy the same security within 30 days.
StocksWorks keeps a tamper-evident audit log of every order. Export your broker's statements for filing and consult a tax professional.`,
    quiz: { q: 'Swapping ETH for SOL is usually…', options: ['Not taxable', 'A taxable disposal of ETH', 'Only taxable above $10k'], answer: 1 },
  },
];

// y = yes, p = partial, n = no. Compiled Nov 2026 from vendor sites and reviews; verify before relying on it.
export const COMPARE_COLS = ['AI picks / signals', 'Explains its reasoning', 'Backtesting', 'Places trades', 'Crypto trading', 'Self-custody wallet', 'Mining tools', 'Education', 'Webhooks / API', 'Self-hosted, your keys', 'Price (approx.)'];
export const COMPARE = [
  { name: 'StocksWorks (this app)', us: true, cells: ['y', 'y', 'y', 'y', 'y', 'p', 'y', 'y', 'y', 'y'], price: 'Free + your data/AI API usage', note: 'Transparent 0-100 score, Claude analyst with web sources, walk-forward backtest, Alpaca paper/live, watch-only + browser-wallet signing, mining calculator, Academy + AI tutor, TradingView/HMAC/Discord hooks.' },
  { name: 'Trade Ideas', cells: ['y', 'p', 'y', 'y', 'n', 'n', 'n', 'p', 'p', 'n'], price: '~$89+/mo', note: 'AI "Holly" intraday signals with entry, stop and target; real-time scanner; broker-linked execution.' },
  { name: 'TrendSpider', cells: ['y', 'p', 'y', 'p', 'p', 'n', 'n', 'p', 'y', 'n'], price: '~$54-82+/mo', note: 'Automated technical analysis, AI assistant, pattern recognition, backtesting, trading bots and webhook alerts.' },
  { name: 'Tickeron', cells: ['y', 'p', 'y', 'p', 'p', 'n', 'n', 'p', 'n', 'n'], price: '~$20-30/mo per tool', note: 'AI robots, pattern search and trend-prediction engines with confidence levels.' },
  { name: 'Danelfin', cells: ['y', 'y', 'p', 'n', 'n', 'n', 'n', 'y', 'p', 'n'], price: 'Free tier + subscription', note: 'AI Score 1-10 per US stock/ETF with feature explanations; research only, no execution.' },
  { name: 'Composer', cells: ['p', 'p', 'y', 'y', 'y', 'n', 'n', 'p', 'n', 'n'], price: 'Subscription', note: 'No-code / AI-assisted strategy "symphonies", backtests and automated execution.' },
  { name: 'Public', cells: ['y', 'y', 'n', 'y', 'y', 'n', 'n', 'p', 'y', 'n'], price: 'Free for account holders', note: 'Brokerage-native AI agents and prompt-based portfolio automation; MCP access.' },
  { name: 'TradingView', cells: ['p', 'n', 'y', 'p', 'y', 'n', 'n', 'p', 'y', 'n'], price: 'Free / paid tiers', note: 'Charting, Pine Script strategies and webhook alerts (StocksWorks can receive these).' },
  { name: 'Coinbase', cells: ['n', 'n', 'n', 'y', 'y', 'y', 'n', 'p', 'y', 'p'], price: 'Trading fees', note: 'Exchange plus separate self-custody wallet; no stock AI.' },
];
export const COMPARE_SOURCES = [
  ['Trade Ideas: Best AI trading software 2026', 'https://www.trade-ideas.com/best-ai-trading-software/'],
  ['Walnut: Best AI for stock trading 2026', 'https://walnutinvest.com/resources/best-ai-for-stock-trading'],
  ['Finder: Best AI trading bots 2026', 'https://www.finder.com/stock-trading/ai-trading-bot'],
  ['RockFlow: Fully automated AI trading apps (Nov 2026)', 'https://rockflow.ai/blog/fully-automated-ai-trading-apps'],
  ['WallStreetZen: 7 best AI stock analyzers 2026', 'https://www.wallstreetzen.com/blog/ai-stock-analysis/'],
];

export const LINKS = [
  ['Alpaca: free paper trading account + API keys (stocks & crypto)', 'https://app.alpaca.markets/signup'],
  ['Alpaca API docs', 'https://docs.alpaca.markets/'],
  ['Anthropic Console: Claude API key', 'https://console.anthropic.com/'],
  ['TradingView webhook alerts guide', 'https://www.tradingview.com/support/solutions/43000529348/'],
  ['Discord: create a channel webhook', 'https://support.discord.com/hc/en-us/articles/228383668'],
  ['Slack: incoming webhooks', 'https://api.slack.com/messaging/webhooks'],
  ['CoinGecko API (public crypto market data)', 'https://www.coingecko.com/en/api'],
  ['mempool.space API (Bitcoin network + addresses)', 'https://mempool.space/docs/api/rest'],
  ['MetaMask (browser wallet for signing)', 'https://metamask.io/'],
  ['SEC investor education', 'https://www.investor.gov/'],
];
