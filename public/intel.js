// Dossier + fact check (Research tab): every source about one symbol in one place, the cross-source price check,
// and a web fact checker whose verdict only counts with cited sources. Every dynamic value goes through esc().
const num = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const big = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.abs(n) >= 1e12 ? `${num(n / 1e12)}T` : Math.abs(n) >= 1e9 ? `${num(n / 1e9)}B` : Math.abs(n) >= 1e6 ? `${num(n / 1e6)}M` : num(n));
const httpUrl = (u) => { try { const x = new URL(u); return ['https:', 'http:'].includes(x.protocol) ? x.href : null; } catch { return null; } };
const MACRO = { DGS10: ['10-yr Treasury', '%'], DFF: ['Fed funds', '%'], CPIAUCSL: ['CPI index', ''], UNRATE: ['Unemployment', '%'], VIXCLS: ['VIX', ''] };
export const VERDICT_CLS = { supported: 'bullish', refuted: 'bearish', mixed: 'neutral', unverifiable: '' };

/** Fact-check rows shown under an AI analysis. */
export function checksHtml(checks, esc) {
  if (!checks?.length) return '';
  const icon = { verified: '✓', contradicted: '✗', unverifiable: '?' };
  return `<div class="checks-box"><b>Fact check against the data</b><ul class="checks">${checks.map((c) =>
    `<li class="${c.status === 'contradicted' ? 'bad' : ''}">${icon[c.status] ?? '?'} ${esc(c.check)}: ${esc(c.evidence)}</li>`).join('')}</ul></div>`;
}

export function mountIntel(el, { api, esc, toast }) {
  el.innerHTML = `<div class="card"><div class="bar"><h2>Dossier &amp; fact check</h2><span class="spacer"></span><span id="inSrc" class="muted tiny"></span></div>
      <p class="muted">Everything the app knows about one stock or coin from every source (prices, fundamentals and SEC filings, DeFi, macro, sentiment, news), with a check that the sources agree. The AI analyst uses the same dossier.</p>
      <form id="inForm" class="row"><label>Symbol<input name="s" placeholder="AAPL or BTC/USD" autocapitalize="characters" autocomplete="off"></label><button class="btn primary" type="submit">Build dossier</button>
        <button class="btn ghost" type="button" data-macro>Macro &amp; sentiment</button></form>
      <div id="inOut"></div>
      <h3>Fact-check a claim</h3>
      <form id="fcForm"><label>Claim<textarea name="claim" rows="2" maxlength="1000" placeholder="e.g. Apple's revenue grew more than 10% last fiscal year"></textarea></label>
        <label>Related symbol (optional: compares with our data too)<input name="symbol" autocapitalize="characters" autocomplete="off"></label>
        <button class="btn" type="submit">Fact-check</button></form><div id="fcOut"></div></div>`;
  const $ = (s) => el.querySelector(s);
  api('/api/intel/sources').then((s) => {
    const on = Object.entries(s).filter(([, v]) => v).map(([k]) => k), off = Object.entries(s).filter(([, v]) => !v).map(([k]) => k);
    $('#inSrc').textContent = `Sources on: ${on.join(', ')}${off.length ? ` · not set up: ${off.join(', ')}` : ''}`;
  }).catch(() => {});
  const macroHtml = (m, f) => `${m ? `<div class="kv">${Object.entries(m).filter(([, v]) => v).map(([k, v]) => `<span>${esc(MACRO[k]?.[0] ?? k)}</span><b>${esc(num(v.value))}${esc(MACRO[k]?.[1] ?? '')} <span class="muted tiny">${esc(v.date)}</span></b>`).join('')}</div>` : ''}
    ${f ? `<p>Crypto Fear &amp; Greed: <b>${esc(f.value)}</b> (${esc(f.label)})</p>` : ''}`;
  let last = null;
  $('#inForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = e.target.s.value.trim().toUpperCase(); if (!s) return;
    $('#inOut').innerHTML = '<div class="empty">Gathering from every source…</div>';
    try {
      const d = last = await api(`/api/intel?s=${encodeURIComponent(s)}`);
      const ag = d.agreement;
      const f = d.edgar?.facts;
      $('#inOut').innerHTML = `<div class="bar"><h3>${esc(d.symbol)} ${d.price != null ? `· ${esc(num(d.price))}` : ''}</h3>
          <span class="pill ${ag.status === 'agree' ? 'bullish' : ag.status === 'disagree' ? 'bearish' : ''}">${ag.status === 'agree' ? `prices agree (${esc(ag.sources.join(', '))})` : ag.status === 'disagree' ? `prices DISAGREE: ${esc(ag.outliers.join(', '))} off by up to ${esc(ag.maxDevPct)}%` : esc(ag.status)}</span>
          <span class="spacer"></span><button class="btn" type="button" data-teach>Teach the AI this dossier</button></div>
        ${d.signal ? `<p>Technical score <b>${esc(d.signal.score)}</b>/100 · RSI ${esc(num(d.signal.metrics?.rsi14, 1))}</p>` : ''}
        ${d.edgar ? `<p><b>${esc(d.edgar.name)}</b> (SEC CIK ${esc(d.edgar.cik)}): revenue ${esc(big(f?.revenue?.annual?.val))} FY ${esc(f?.revenue?.annual?.end ?? '')}${f?.revenueGrowthPct != null ? ` (${esc(f.revenueGrowthPct)}% y/y)` : ''}, net income ${esc(big(f?.netIncome?.annual?.val))}, diluted EPS ${esc(num(f?.epsDiluted?.annual?.val))}, cash ${esc(big(f?.cash?.latest?.val))}</p>
          <p class="tiny">Recent filings: ${d.edgar.filings.slice(0, 8).map((x) => { const u = httpUrl(x.url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(x.form)} ${esc(x.date)}</a>` : ''; }).join(' · ')}</p>` : ''}
        ${d.finviz ? `<p>Finviz: ${esc(d.finviz.sector)} / ${esc(d.finviz.industry)} · P/E ${esc(num(d.finviz.pe))} · market cap ${esc(big((d.finviz.marketCapM ?? 0) * 1e6))}</p>` : ''}
        ${d.coin ? `<p>${esc(d.coin.name)}: rank #${esc(d.coin.rank)} · market cap ${esc(big(d.coin.marketCap))} · 24h ${esc(num(d.coin.change24hPct))}%</p>` : ''}
        ${d.messari ? `<p>Messari: ${esc(d.messari.sector)} · ${esc(d.messari.category)}</p>` : ''}
        ${d.defi ? `<p>DeFi (${esc(d.defi.kind)} ${esc(d.defi.name)}): TVL ${esc(big(d.defi.tvlUsd))}</p>` : ''}
        ${macroHtml(d.macro, d.sentiment)}
        ${d.news.length ? `<h3>News</h3><ul class="feed">${d.news.slice(0, 12).map((n) => { const u = httpUrl(n.url); return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>` : esc(n.title)} <span class="muted tiny">${esc(n.source)}</span></li>`; }).join('')}</ul>` : ''}
        <p class="muted tiny">Sources: ${Object.entries(d.sources).map(([k, v]) => `${esc(k)} ${v === 'ok' ? '✓' : `(${esc(v)})`}`).join(' · ')}</p>`;
    } catch (err) { $('#inOut').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.macro !== undefined) { const r = await api('/api/intel/macro'); $('#inOut').innerHTML = `<h3>Macro &amp; sentiment</h3>${macroHtml(r.macro, r.sentiment)}${r.macroError ? `<p class="muted">${esc(r.macroError)}</p>` : ''}`; }
      if (b.dataset.teach !== undefined && last) { const r = await api('/api/research/learn', { method: 'POST', body: { source: 'dossier', symbol: last.symbol } }); toast(`Taught the AI ${r.added} chars`); }
    } catch (err) { toast(err.message, true); }
  });
  $('#fcForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const claim = e.target.claim.value.trim(); if (!claim) return;
    $('#fcOut').innerHTML = '<div class="empty">Checking sources on the web…</div>';
    try {
      const r = await api('/api/factcheck', { method: 'POST', body: { claim, symbol: e.target.symbol.value.trim() } });
      $('#fcOut').innerHTML = `<p><span class="pill ${VERDICT_CLS[r.verdict] ?? ''}">${esc(r.verdict)}</span> confidence ${esc(r.confidence)}%</p><p>${esc(r.explanation)}</p>
        ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}
        ${r.sources.length ? `<ul class="feed">${r.sources.map((x) => { const u = httpUrl(x.url); return u ? `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(x.title || u)}</a></li>` : ''; }).join('')}</ul>` : ''}`;
    } catch (err) { $('#fcOut').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
}
