// Minimal Ollama HTTP client (one per host: this PC or another machine on your network).
import { HttpError } from './providers.js';

/** Only a plain http(s)://host:port base URL; no credentials, paths, queries or other schemes. */
export function validHostUrl(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  const hn = u.hostname.toLowerCase().replace('[', '');
  if (hn.startsWith('169.254.') || hn.startsWith('fe80:')) return null; // link-local (cloud metadata endpoints)
  return u.origin;
}

export function createOllama(base, { fetchImpl = fetch } = {}) {
  const origin = validHostUrl(base);
  if (!origin) throw new HttpError(400, 'Ollama host must be http(s)://host:port');
  async function call(path, body, timeoutMs = 10_000) {
    let r;
    try {
      r = await fetchImpl(origin + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { throw new HttpError(502, `Ollama at ${origin} is not reachable (${e.name === 'TimeoutError' ? 'timed out' : e.message})`); }
    let data = {};
    try { data = await r.json(); } catch { /* keep {} */ }
    if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, `Ollama: ${data.error || r.status}`);
    return data;
  }
  return {
    origin,
    version: () => call('/api/version', undefined, 3000),
    tags: async () => (await call('/api/tags', undefined, 5000)).models ?? [],
    ps: async () => (await call('/api/ps', undefined, 5000)).models ?? [],
    show: (model) => call('/api/show', { model }, 15_000),
    /** Non-streaming chat; `format` takes a JSON Schema for structured output. */
    chat: ({ model, messages, format, options }) => call('/api/chat', { model, messages, format, options, stream: false, keep_alive: '10m' }, 300_000),
  };
}
