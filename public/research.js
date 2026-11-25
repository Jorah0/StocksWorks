// Research tab: Finviz screener, Messari assets + news, Invo (Hyperliquid) traders, and "Teach the AI"
// (sends the current view into the AI Lab training corpus). Every dynamic value goes through esc() before innerHTML.

import { mountIntel } from '/intel.js';

const PRESETS = [
  ['Large-cap tech', 'cap_large,sec_technology'],
  ['Oversold (RSI < 30)', 'ta_rsi_os30'],
  ['Unusual volume', 'sh_relvol_o2'],
  ['New 52-week highs', 'ta_highlow52w_nh'],
];
const FV_COLS = [['ticker', 'Ticker'], ['company', 'Company'], ['sector', 'Sector'], ['industry', 'Industry'], ['country', 'Country'],
  ['marketCapM', 'Mkt cap', 1], ['pe', 'P/E', 1], ['price', 'Price', 1], ['changePct', 'Change', 1], ['volume', 'Volume', 1]];
const httpUrl = (u) => { try { const x = new URL(u); return ['https:', 'http:'].includes(x.protocol) ? x.href : null; } catch { return null; } };
const num = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }));
const capM = (m) => (m == null || !Number.isFinite(Number(m)) ? '—' : m >= 1e6 ? `${num(m / 1e6)}T` : m >= 1e3 ? `${num(m / 1e3)}B` : `${num(m)}M`);
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

export function mountResearch(tab, { api, esc, toast, openSymbol }) {
  const el = document.createElement('div'); // fresh root per mount, so re-opening the tab doesn't stack listeners
  const intelEl = document.createElement('div');
  tab.replaceChildren(intelEl, el);
  mountIntel(intelEl, { api, esc, toast });
  const $ = (s) => el.querySelector(s);
  const teachBtn = (what) => `<button class="btn" type="button" data-teach="${what}" title="Add what this panel shows to the AI Lab training corpus">Teach the AI</button>`;
  el.innerHTML = `<div id="rsSrc" class="card"><div class="empty">Checking data sources…</div></div>
    <div class="card"><div class="bar"><h2>Stock screener (Finviz)</h2><span class="spacer"></span>${teachBtn('finviz')}</div>
      <form id="rsFvForm" class="row"><label>Filter codes (comma separated)<input name="f" value="cap_large,sec_technology" autocomplete="off" spellcheck="false"></label>
        <label>Order (optional, e.g. -change)<input name="o" autocomplete="off" spellcheck="false"></label><button class="btn primary" type="submit">Screen</button></form>
      <div class="bar">${PRESETS.map(([l, f]) => `<button class="btn ghost" type="button" data-preset="${esc(f)}">${esc(l)}</button>`).join('')}</div>
      <div id="rsFv" class="scroll"><p class="muted">Pick a preset or enter filter codes.</p></div></div>
    <div class="grid two"><div class="card"><h2>Crypto assets (Messari)</h2>
        <form id="rsAsForm" class="row"><label>Search<input name="q" placeholder="bitcoin, defi, layer-2…" autocomplete="off"></label><button class="btn" type="submit">Search</button></form>
        <div id="rsAs" class="scroll"></div></div>
      <div class="card"><div class="bar"><h2>Crypto news</h2><span id="rsNewsFor" class="pill">all assets</span><span class="spacer"></span>
        <button class="btn ghost" type="button" data-allnews>All</button>${teachBtn('messari-news')}</div><div id="rsNews"><div class="empty">Loading…</div></div></div></div>
    <div class="card"><h2>Invo traders (Hyperliquid)</h2>
      <p class="muted">Invo is a social copy-trading app on Hyperliquid. Paste a trader's Hyperliquid wallet address from their Invo profile to follow what they hold and how they trade. Read-only: nothing is copied or traded.</p>
      <form id="rsTrForm" class="row"><label>Hyperliquid address (0x…)<input name="address" required autocomplete="off" spellcheck="false"></label>
        <label>Label<input name="label" maxlength="40"></label><button class="btn" type="submit">Follow</button></form>
      <div id="rsTrList"></div><div id="rsTr"></div></div>
    <div class="card"><h2>Teach the AI a note</h2>
      <p class="muted">Anything taught here (and with the Teach buttons above) goes into the AI Lab training corpus.</p>
      <form id="rsNoteForm"><label>Note<textarea name="text" rows="4" maxlength="20000" placeholder="e.g. My rule: never add to a losing position."></textarea></label>
        <button class="btn primary" type="submit">Teach</button></form></div>`;

  let fvRows = [], fvSort = { k: null, dir: 1 }, fvQuery = null, newsAsset = '', trader = null;

  // ---------------- source status ----------------
  const corpus = (n) => { const c = $('#rsCorpus'); if (c) c.textContent = num(n, 0); };
  api('/api/research/sources').then((s) => {
    const row = (name, ok, help) => `<span class="pill ${ok ? 'bullish' : 'bearish'}">${esc(name)}: ${ok ? 'connected' : 'not configured'}</span>${ok ? '' : ` <span class="muted tiny">${help}</span>`}`;
    $('#rsSrc').innerHTML = `<div class="bar"><h2>Research sources</h2><span class="spacer"></span><span class="muted tiny">AI corpus: <b id="rsCorpus" class="mono"></b> chars</span></div>
      <div class="bar">${row('Finviz', s.finviz?.configured, 'Needs <code>FINVIZ_AUTH_TOKEN</code> (Finviz Elite → Settings → API).')}</div>
      <div class="bar">${row('Messari', s.messari?.configured, 'Needs <code>MESSARI_API_KEY</code> (messari.io API).')}</div>
      <div class="bar">${row('Hyperliquid', s.hyperliquid?.configured !== false, '')}</div>
      ${s.finviz?.configured && s.messari?.configured ? '' : '<p class="muted tiny">Add keys under Integrations → Desktop settings, or in <code>.env</code>.</p>'}`;
    corpus(s.corpusChars);
  }).catch((e) => { $('#rsSrc').innerHTML = `<p class="err">${esc(e.message)}</p>`; });

  // ---------------- Finviz ----------------
  const paintFv = () => {
    const rows = fvSort.k ? [...fvRows].sort((a, b) => {
      const x = a[fvSort.k], y = b[fvSort.k];
      return (typeof x === 'number' || typeof y === 'number' ? (x ?? -Infinity) - (y ?? -Infinity) : String(x ?? '').localeCompare(String(y ?? ''))) * fvSort.dir;
    }) : fvRows;
    $('#rsFv').innerHTML = rows.length ? `<table><tr>${FV_COLS.map(([k, l, n]) => `<th class="sort ${n ? 'num' : ''}" data-sort="${k}">${esc(l)}${fvSort.k === k ? (fvSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>
      ${rows.map((r) => `<tr class="click" data-sym="${esc(r.ticker)}"><td><b>${esc(r.ticker)}</b></td><td>${esc(r.company)}</td><td>${esc(r.sector)}</td><td class="muted">${esc(r.industry)}</td><td>${esc(r.country)}</td>
        <td class="num">${capM(r.marketCapM)}</td><td class="num">${num(r.pe)}</td><td class="num">${usd(r.price)}</td><td class="num ${cls(r.changePct)}">${num(r.changePct)}%</td><td class="num">${num(r.volume, 0)}</td></tr>`).join('')}</table>
      <p class="muted tiny">Click a ticker to open it in the AI Scanner. Click a column to sort.</p>` : '<p class="muted">No matches.</p>';
  };
  async function screen(f, o) {
    $('#rsFv').innerHTML = '<div class="empty">Screening…</div>';
    try {
      const r = await api(`/api/research/finviz?f=${encodeURIComponent(f)}${o ? `&o=${encodeURIComponent(o)}` : ''}`);
      fvRows = r.rows ?? []; fvSort = { k: null, dir: 1 }; fvQuery = f;
      paintFv();
    } catch (e) { $('#rsFv').innerHTML = `<p class="err">${esc(e.message)}</p>`; toast(e.message, true); }
  }
  $('#rsFvForm').addEventListener('submit', (e) => { e.preventDefault(); screen(e.target.f.value.trim(), e.target.o.value.trim()); });
  $('#rsFv').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) { fvSort = { k: th.dataset.sort, dir: fvSort.k === th.dataset.sort ? -fvSort.dir : 1 }; return paintFv(); }
    const tr = e.target.closest('tr[data-sym]');
    if (tr) openSymbol(tr.dataset.sym);
  });

  // ---------------- Messari ----------------
  async function loadNews(slug = '') {
    newsAsset = slug;
    $('#rsNewsFor').textContent = slug || 'all assets';
    $('#rsNews').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const { items = [] } = await api(`/api/research/messari/news${slug ? `?asset=${encodeURIComponent(slug)}` : ''}`);
      $('#rsNews').innerHTML = items.length ? `<ul class="feed">${items.map((n) => {
        const u = httpUrl(n.url);
        return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>` : esc(n.title)}
          <div class="muted tiny">${esc(n.source)}${n.at ? ` · ${esc(new Date(n.at).toLocaleString())}` : ''}${n.assets?.length ? ` · ${esc(n.assets.join(', '))}` : ''}</div></li>`;
      }).join('')}</ul>` : '<p class="muted">No news.</p>';
    } catch (e) { $('#rsNews').innerHTML = `<p class="${/not configured/i.test(e.message) ? 'muted' : 'err'}">${esc(e.message)}</p>`; } // missing key = a setup step, not an error
  }
  $('#rsAsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#rsAs').innerHTML = '<div class="empty">Searching…</div>';
    try {
      const { assets = [] } = await api(`/api/research/messari/assets?q=${encodeURIComponent(e.target.q.value.trim())}`);
      $('#rsAs').innerHTML = assets.length ? `<table><tr><th>Asset</th><th>Sector</th><th>Category</th><th>Tags</th></tr>
        ${assets.map((a) => `<tr class="click" data-slug="${esc(a.slug)}"><td><b>${esc(a.symbol)}</b> <span class="muted">${esc(a.name)}</span></td><td>${esc(a.sector)}</td><td>${esc(a.category)}</td>
          <td class="muted tiny">${esc((a.tags ?? []).slice(0, 4).join(', '))}</td></tr>`).join('')}</table><p class="muted tiny">Click an asset for its news.</p>` : '<p class="muted">No assets found.</p>';
    } catch (err) { $('#rsAs').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
  $('#rsAs').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-slug]'); if (tr) loadNews(tr.dataset.slug); });
  loadNews();

  // ---------------- Invo traders ----------------
  const paintTraders = (list) => {
    $('#rsTrList').innerHTML = list.length ? `<table>${list.map((t) => `<tr><td><b>${esc(t.label || 'Trader')}</b><br><span class="mono muted tiny">${esc(t.address)}</span></td>
      <td class="num"><button class="btn" type="button" data-view="${esc(t.address)}">View</button> <button class="btn ghost" type="button" data-unfollow="${esc(t.address)}">Remove</button></td></tr>`).join('')}</table>` : '<p class="muted">No traders followed yet.</p>';
  };
  const loadTraders = () => api('/api/research/traders').then((r) => paintTraders(r.traders ?? [])).catch((e) => { $('#rsTrList').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
  async function viewTrader(address) {
    trader = address;
    const box = $('#rsTr');
    box.innerHTML = '<div class="empty">Reading Hyperliquid…</div>';
    try {
      const t = await api(`/api/research/trader?address=${encodeURIComponent(address)}`);
      const f = t.fills ?? {};
      box.innerHTML = `<div class="bar"><h3>${esc(t.address)}</h3><span class="spacer"></span>${teachBtn('trader')}</div>
        <div class="stats"><div class="stat"><div class="k">Account value</div><div class="v">${usd(t.accountValue)}</div></div>
          <div class="stat"><div class="k">Closed trades</div><div class="v">${num(f.closes, 0)}</div></div>
          <div class="stat"><div class="k">Win rate</div><div class="v">${f.winRate == null ? '—' : `${num(f.winRate * 100, 1)}%`}</div></div>
          <div class="stat"><div class="k">Realized P/L</div><div class="v ${cls(f.realizedPnl)}">${usd(f.realizedPnl)}</div></div></div>
        ${t.style ? `<p class="lesson">${esc(t.style)}</p>` : ''}${f.topCoins?.length ? `<p class="muted">Most traded: ${esc(f.topCoins.join(', '))}</p>` : ''}
        ${t.positions?.length ? `<div class="scroll"><table><tr><th>Coin</th><th>Side</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Value</th><th class="num">Unrealized</th><th class="num">Leverage</th></tr>
          ${t.positions.map((p) => `<tr><td><b>${esc(p.coin)}</b></td><td class="${p.side === 'long' ? 'up' : 'down'}">${esc(p.side)}</td><td class="num">${num(p.size, 6)}</td><td class="num">${usd(p.entryPx)}</td>
            <td class="num">${usd(p.positionValue)}</td><td class="num ${cls(p.unrealizedPnl)}">${usd(p.unrealizedPnl)}</td><td class="num">${num(p.leverage, 1)}×</td></tr>`).join('')}</table></div>` : '<p class="muted">No open positions.</p>'}`;
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }
  $('#rsTrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/research/traders', { method: 'POST', body: { address: e.target.address.value.trim(), label: e.target.label.value.trim() } });
      e.target.reset(); paintTraders(r.traders ?? []); toast('Trader added');
    } catch (err) { toast(err.message, true); }
  });
  $('#rsTrList').addEventListener('click', async (e) => {
    const v = e.target.closest('[data-view]'), u = e.target.closest('[data-unfollow]');
    if (v) return viewTrader(v.dataset.view);
    if (!u) return;
    try {
      const r = await api(`/api/research/traders?address=${encodeURIComponent(u.dataset.unfollow)}`, { method: 'DELETE' });
      paintTraders(r.traders ?? []);
      if (trader === u.dataset.unfollow) { trader = null; $('#rsTr').innerHTML = ''; }
    } catch (err) { toast(err.message, true); }
  });
  loadTraders();

  // ---------------- Teach the AI ----------------
  async function teach(body) {
    try {
      const r = await api('/api/research/learn', { method: 'POST', body });
      toast(`Taught ${num(r.added, 0)} characters to the AI (corpus now ${num(r.totalChars, 0)})`);
      corpus(r.totalChars);
      return true;
    } catch (e) { toast(e.message, true); return false; }
  }
  el.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) { $('#rsFvForm').f.value = p.dataset.preset; $('#rsFvForm').o.value = ''; return screen(p.dataset.preset, ''); }
    if (e.target.closest('[data-allnews]')) return loadNews();
    const t = e.target.closest('[data-teach]');
    if (!t) return;
    if (t.dataset.teach === 'finviz') {
      const f = fvQuery ?? $('#rsFvForm').f.value.trim();
      return f ? teach({ source: 'finviz', f }) : toast('Run a screen first', true);
    }
    if (t.dataset.teach === 'messari-news') return teach(newsAsset ? { source: 'messari-news', asset: newsAsset } : { source: 'messari-news' });
    if (t.dataset.teach === 'trader' && trader) return teach({ source: 'trader', address: trader });
  });
  $('#rsNoteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return toast('Write a note first', true);
    if (await teach({ source: 'note', text })) e.target.reset();
  });
}
