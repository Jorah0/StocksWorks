// Minimal rig UI. All text goes through textContent; no innerHTML anywhere.
const $ = (s) => document.querySelector(s);
const TOKEN = document.querySelector('meta[name=ui-token]').content;
let s = null;

async function call(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-UI-Token': TOKEN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 4000);
}
const fmtHr = (h) => (h == null ? '—' : h >= 1e6 ? `${(h / 1e6).toFixed(2)} MH/s` : h >= 1e3 ? `${(h / 1e3).toFixed(2)} kH/s` : `${h.toFixed(1)} H/s`);
const fmtUp = (sec) => (!sec ? '—' : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);

function render(st) {
  s = st;
  const m = st.miner, h = st.hostState;
  $('#hr').textContent = m.running ? fmtHr(m.hashrate) : '—';
  $('#up').textContent = fmtUp(m.uptimeSec);
  const pill = $('#pill');
  pill.textContent = m.running ? 'MINING' : !st.consentMining ? 'NOT ALLOWED' : st.paired ? (h.connected ? 'IDLE' : 'HOST OFFLINE') : 'NOT LINKED';
  pill.className = `pill ${m.running ? 'on' : !st.consentMining ? 'off' : ''}`;
  $('#why').textContent = m.error || h.error
    || (!st.paired ? 'Link this rig to your host to receive the pool and payout address.'
      : !st.consentMining ? 'Mining is switched off for this computer (permissions below).'
        : !h.config ? 'Waiting for the host to set a pool and payout address.'
          : st.remoteControl ? `The host controls start/stop (currently: ${h.desired}).` : 'You control start/stop on this machine.');
  $('#pairBox').hidden = st.paired;
  $('#linkedBox').hidden = !st.paired;
  $('#hostUrl').textContent = st.host ?? '';
  $('#fp').textContent = st.fingerprint ?? '';
  $('#poolInfo').textContent = h.config ? `${h.config.coin} via ${h.config.pool} → payout ${h.config.payout.slice(0, 10)}…${h.config.payout.slice(-6)}` : '';
  $('#consentMining').checked = st.consentMining;
  $('#remoteControl').checked = st.remoteControl;
  const manual = !st.remoteControl;
  $('#startBtn').disabled = !manual || !st.consentMining || st.localRun;
  $('#stopBtn').disabled = !manual || !st.localRun;
  const f = $('#setForm');
  if (document.activeElement?.form !== f) {
    f.minerPath.value = st.minerPath; f.argsTemplate.value = st.argsTemplate; f.apiPort.value = st.apiPort;
  }
  $('#log').textContent = st.log.join('\n');
}
const act = (path, body, ok) => call(path, body).then((st) => { render(st); if (ok) toast(ok); }).catch((e) => toast(e.message, true));

$('#pairForm').addEventListener('submit', (e) => { e.preventDefault(); act('/ui/pair', { link: e.target.link.value, name: e.target.name.value }, 'Linked'); e.target.reset(); });
$('#unpairBtn').addEventListener('click', () => act('/ui/unpair', {}, 'Unlinked'));
$('#consentMining').addEventListener('change', (e) => act('/ui/settings', { consentMining: e.target.checked }));
$('#remoteControl').addEventListener('change', (e) => act('/ui/settings', { remoteControl: e.target.checked }));
$('#startBtn').addEventListener('click', () => act('/ui/run', { on: true }, 'Starting…'));
$('#stopBtn').addEventListener('click', () => act('/ui/run', { on: false }, 'Stopping…'));
$('#setForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  act('/ui/settings', { minerPath: f.minerPath.value, argsTemplate: f.argsTemplate.value, apiPort: Number(f.apiPort.value) }, 'Saved');
});

const poll = () => call('/ui/state').then(render).catch((e) => toast(e.message, true));
poll();
setInterval(poll, 3000);
