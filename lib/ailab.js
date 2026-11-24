// AI Lab learning loop: structured-output schema, reviewed examples -> SFT dataset, benchmark statistics.
import crypto from 'node:crypto';

/** JSON Schema for the analyst output (Ollama `format`), mirroring the Claude analyst contract in lib/ai.js. */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    stance: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] }, confidence: { type: 'number' },
    horizon: { type: 'string' }, thesis: { type: 'string' },
    catalysts: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } },
    entry: { type: ['number', 'null'] }, stop: { type: ['number', 'null'] }, target: { type: ['number', 'null'] },
    positionSizing: { type: 'string' }, lesson: { type: 'string' },
  },
  required: ['stance', 'confidence', 'thesis', 'risks', 'lesson'],
};

/** The exact user prompt the analyst sees (Claude and local): training rows must match inference. */
export const analystUserPrompt = (payload) => `Analyze this data and return the JSON object.
<data>
${JSON.stringify(payload).replace(/</g, String.fromCharCode(92) + 'u003c')}
</data>`;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** Deterministic split by group (symbol): every example of one symbol lands in the same split, so nothing leaks. */
export function splitOf(group) {
  const b = parseInt(sha(`split:${String(group).toUpperCase()}`).slice(0, 8), 16) % 10;
  return b < 8 ? 'train' : b === 8 ? 'dev' : 'test';
}

/** Reviewed examples -> chat SFT rows. Only accepted or corrected, training-permitted examples; exact duplicates once. */
export function buildDataset(reviews, system) {
  const seen = new Set(), rows = [];
  for (const r of reviews) {
    if (!['accept', 'correct'].includes(r.verdict) || r.trainable === false) continue;
    const target = r.verdict === 'correct' ? r.corrected : r.output;
    if (!target || typeof target !== 'object') continue;
    const user = analystUserPrompt(r.evidence);
    const assistant = JSON.stringify(target);
    const hash = sha(`${user}\n${assistant}`);
    if (seen.has(hash)) continue;
    seen.add(hash);
    rows.push({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }, { role: 'assistant', content: assistant }],
      meta: { id: r.id, symbol: r.symbol, split: splitOf(r.symbol), hash, source: r.source ?? null, verdict: r.verdict, auto: r.auto === true },
    });
  }
  return rows;
}

export { benchmarkStats } from './modelfit.js'; // pure, so the browser runs the same math

// ---------------- PyTorch installer + training options ----------------
const TORCH_INDEX = { cu130: 'CUDA 13.0 (NVIDIA driver 580+)', cu126: 'CUDA 12.6 (NVIDIA driver 525+)', cpu: 'CPU only' };
/** Which PyTorch build to install: the user's valid choice, else the newest CUDA build the NVIDIA driver supports. */
export function torchVariant({ driver, choice } = {}) {
  if (choice && choice !== 'auto' && !Object.hasOwn(TORCH_INDEX, choice)) throw new Error(`Unknown PyTorch choice: ${choice}`);
  const major = parseInt(String(driver ?? ''), 10);
  const index = choice && choice !== 'auto' ? choice : major >= 580 ? 'cu130' : major >= 525 ? 'cu126' : 'cpu';
  return { index, label: TORCH_INDEX[index], url: `https://download.pytorch.org/whl/${index}` };
}

/** User-chosen training device/precision, checked against what the installed PyTorch can do. */
export function trainOptions(o = {}, caps = {}) {
  const device = !o.device || o.device === 'auto' ? (caps.cuda ? 'cuda' : 'cpu') : o.device;
  if (!['cuda', 'cpu'].includes(device)) throw new Error('Device: auto, cuda or cpu');
  if (device === 'cuda' && !caps.cuda) throw new Error('CUDA training needs the GPU build of PyTorch (AI Lab → Training setup)');
  const precision = !o.precision || o.precision === 'auto' ? (device === 'cuda' ? (caps.bf16 ? 'bf16' : 'fp16') : 'fp32') : o.precision;
  if (!['fp32', 'bf16', 'fp16'].includes(precision)) throw new Error('Precision: auto, fp32, bf16 or fp16');
  if (precision === 'fp16' && device !== 'cuda') throw new Error('fp16 training needs the GPU (use fp32 on CPU)');
  if (precision === 'bf16' && device === 'cuda' && !caps.bf16) throw new Error('This GPU does not support bf16: use fp16 or fp32');
  const accum = o.accum == null ? 1 : Number(o.accum);
  if (!Number.isInteger(accum) || accum < 1 || accum > 256) throw new Error('Gradient accumulation: 1-256');
  return { device, precision, gradCheckpointing: o.gradCheckpointing === true, accum };
}

/** Every local analyst/teacher call: deterministic, and hard-capped so a looping model stops (about 2-3x a full answer). */
export const ANALYST_OPTIONS = { temperature: 0, num_predict: 1024 };
