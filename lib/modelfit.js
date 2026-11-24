// Hardware fit, scratch-model sizing and appropriateness scoring for the AI Lab (handbook pp. 6-7, 13-15).
// Pure and dependency-free: shared with the browser so estimates on a card, detail view and preflight agree.
export const GiB = 2 ** 30;
const r1 = (x) => Math.round(x * 10) / 10;

/** Effective budget = max(0, currently free - additional reserve). Existing usage (OBS...) is already in "free". */
export const effectiveBudget = ({ freeGiB, reserveGiB = 0 }) => Math.max(0, r1(Number(freeGiB) - Number(reserveGiB)));

/** Uniform full attention: 2 (K and V) x layers x KV heads x head dim x bytes x cached positions (all sequences). */
export const kvBytes = ({ layers, kvHeads, headDim, bytes = 2, positions }) => 2 * layers * kvHeads * headDim * bytes * positions;

/** est {lowGiB, highGiB} vs hw {totalGiB, budgetGiB} -> fit | borderline | incompatible | unknown. */
export function assessFit(est, hw) {
  if (!est || !(hw?.totalGiB > 0) || !Number.isFinite(hw.budgetGiB)) return { status: 'unknown' };
  const pct = (x) => Math.round((100 * x) / hw.totalGiB);
  const status = est.highGiB <= hw.budgetGiB ? 'fit' : est.lowGiB > hw.budgetGiB ? 'incompatible' : 'borderline';
  return {
    status, pctLow: pct(est.lowGiB), pctHigh: pct(est.highGiB),
    headroomLow: r1(Math.max(0, hw.budgetGiB - est.highGiB)), headroomHigh: r1(Math.max(0, hw.budgetGiB - est.lowGiB)),
    shortLow: r1(Math.max(0, est.lowGiB - hw.budgetGiB)), shortHigh: r1(Math.max(0, est.highGiB - hw.budgetGiB)),
  };
}

const first = (v) => (Array.isArray(v) ? Math.max(...v.map(Number)) : v == null ? null : Number(v));
/**
 * Full-GPU inference estimate for a GGUF variant from Ollama /api/show model_info.
 * ponytail: broad documented estimate (weights = file size, +KV, +0.3-0.8 GiB and 10% graph/allocator margin);
 * a local measured peak should replace it once the user benchmarks the variant.
 */
export function estimateVariant({ sizeBytes, info = {}, ctx = 8192, parallel = 1, kvBytesPerElem = 2 }) {
  if (!(Number(sizeBytes) > 0)) return null;
  const arch = info['general.architecture'];
  const g = (k) => first(info[`${arch}.${k}`]);
  const layers = g('block_count'), heads = g('attention.head_count'), kvHeads = g('attention.head_count_kv') ?? heads;
  const headDim = g('attention.key_length') ?? (g('embedding_length') && heads ? g('embedding_length') / heads : null);
  const window = g('attention.sliding_window');
  const weightsGiB = Number(sizeBytes) / GiB;
  const kvKnown = Boolean(arch && layers && kvHeads && headDim);
  const kv = (positions) => (kvKnown ? kvBytes({ layers, kvHeads, headDim, bytes: kvBytesPerElem, positions }) / GiB : 0);
  const kvHigh = kv(ctx * parallel), kvLow = kv(Math.min(ctx, window || ctx) * parallel); // sliding windows can cap the cache
  return {
    lowGiB: r1(weightsGiB + kvLow + 0.3), highGiB: r1((weightsGiB + kvHigh) * 1.1 + 0.8 + (kvKnown ? 0 : 1)),
    kvKnown, confidence: kvKnown ? 'estimated' : 'low (no attention metadata)',
    parts: { weightsGiB: r1(weightsGiB), kvGiB: kvKnown ? r1(kvHigh) : null, ctx, parallel, kvBytesPerElem },
  };
}

// ---------------- scratch (blank) model ----------------
/** Unique weights of a bias-free Llama-style decoder (RMSNorm, gated SiLU MLP, RoPE). */
export function scratchParams({ vocab, layers, width, mlp, heads, kvHeads, headDim, tied = true }) {
  const d = width, q = heads * headDim, k = kvHeads * headDim;
  const block = 2 * d * q + 2 * d * k + 3 * d * mlp + 2 * d; // q,o + k,v + gate,up,down + 2 norms
  return vocab * d + layers * block + d + (tied ? 0 : vocab * d);
}

const LIMITS = { vocab: [256, 262_144], layers: [1, 128], width: [64, 16_384], mlp: [64, 65_536], heads: [1, 256], kvHeads: [1, 256], headDim: [8, 512], ctx: [64, 131_072] };
export function validateArch(c = {}) {
  const e = [];
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (!Number.isInteger(c[k]) || c[k] < lo || c[k] > hi) e.push(`${k} must be a whole number ${lo}-${hi}`);
  if (e.length) return e;
  if (c.heads % c.kvHeads) e.push('Query heads must be divisible by KV heads');
  if (c.headDim % 2) e.push('Head dimension must be even (rotary positions)');
  else if (c.headDim % 32) e.push('Head dimension must be a multiple of 32 to run in Ollama with a quantized KV cache (q8_0/q4_0 use 32-element blocks)');
  if (c.heads * c.headDim !== c.width) e.push(`Heads x head dimension (${c.heads * c.headDim}) must equal width (${c.width}) for this design`);
  return e;
}

export function trainPlan({ tokens, uniqueTokens, seq, micro, accum, devices = 1, tokensPerSec }) {
  const tokensPerUpdate = seq * micro * accum * devices;
  return {
    tokensPerUpdate, updates: Math.ceil(tokens / tokensPerUpdate),
    hours: tokensPerSec > 0 ? r1(tokens / tokensPerSec / 3600) : null,
    exposures: uniqueTokens > 0 ? Math.round((tokens / uniqueTokens) * 100) / 100 : null,
  };
}

/** Full-parameter AdamW in fp32: weights 4 + grads 4 + moments 8 bytes/param, plus activations and logits (estimate). */
export function trainingMemory({ params, layers, width, seq, micro, vocab = 0 }) {
  const states = params * 16;
  const act = (k) => micro * seq * width * layers * 4 * k;
  const logits = micro * seq * vocab * 4 * 2;
  return { lowGiB: r1((states + act(16) + logits) / GiB + 0.2), highGiB: r1((states + act(34) + logits) / GiB + 0.6), statesGiB: r1(states / GiB) };
}

// ---------------- benchmark ----------------
const pctl = (sorted, p) => {
  if (!sorted.length) return null;
  const i = p * (sorted.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)) / 10) / 100; // ms -> s, 2 dp
};
/** results: [{valid, stance, teacher, ms}] -> validity, agreement with the teacher (premium/reviewed) label, latency p50/p95 (s). */
export function benchmarkStats(results) {
  const n = results.length;
  const withTeacher = results.filter((r) => r.teacher);
  const ms = results.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n, validity: n ? results.filter((r) => r.valid).length / n : null,
    agreement: withTeacher.length ? withTeacher.filter((r) => r.valid && r.stance === r.teacher).length / withTeacher.length : null,
    teacherN: withTeacher.length, p50: pctl(ms, 0.5), p95: pctl(ms, 0.95),
  };
}

// ---------------- appropriateness (transparent, feature-specific) ----------------
/**
 * metrics: [{key, weight, dir:'benefit', floor, target} | {key, weight, dir:'cost', ceiling, target}]
 * Score = 100 x sum(weight x clamp-normalized value). A candidate missing any metric gets no rank.
 */
export function appropriateness(candidates, metrics) {
  const sum = metrics.reduce((s, m) => s + Number(m.weight), 0);
  if (new Set(metrics.map((m) => m.key)).size !== metrics.length) throw new Error('Each metric can appear once (duplicate key)');
  if (Math.abs(sum - 1) > 1e-9 || metrics.some((m) => !(m.weight >= 0))) throw new Error('Metric weights must sum to 1');
  for (const m of metrics) {
    const ok = m.dir === 'benefit' ? m.target > m.floor : m.dir === 'cost' ? m.ceiling > m.target : false;
    if (!ok) throw new Error(`Invalid bounds for ${m.key}: equal or reversed`);
  }
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const norm = (m, v) => (m.dir === 'benefit' ? clamp((v - m.floor) / (m.target - m.floor)) : clamp((m.ceiling - v) / (m.ceiling - m.target)));
  return candidates.map((c) => {
    const missing = metrics.filter((m) => !Number.isFinite(c[m.key])).map((m) => m.key);
    const parts = missing.length ? null : Object.fromEntries(metrics.map((m) => [m.key, r1(100 * m.weight * norm(m, c[m.key]))]));
    return { ...c, score: parts ? r1(Object.values(parts).reduce((a, b) => a + b, 0)) : null, parts, missing };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
