// First-run setup UI. Talks to the main process only through window.setup (contextBridge).
const f = document.getElementById('f');
const err = (m) => { document.getElementById('err').textContent = m || ''; };

window.setup.totp().then(({ secret, qr }) => {
  document.getElementById('qr').src = qr;
  document.getElementById('secret').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
});
document.getElementById('en2fa').addEventListener('change', (e) => { document.getElementById('twofa').hidden = !e.target.checked; });

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err('');
  const d = Object.fromEntries(new FormData(f));
  d.enable2fa = f.enable2fa.checked;
  if (d.password.length < 12) return err('Passphrase must be at least 12 characters.');
  if (d.password !== d.confirm) return err('Passphrases do not match.');
  if (d.enable2fa && !/^\d{6}$/.test(d.totpCode)) return err('Enter the 6-digit code from your authenticator app (or untick two-factor).');
  const btn = document.getElementById('go');
  btn.disabled = true; btn.textContent = 'Securing your settings…';
  const r = await window.setup.save(d);
  if (r?.error) { err(r.error); btn.disabled = false; btn.textContent = 'Finish setup and open StocksWorks'; }
});
