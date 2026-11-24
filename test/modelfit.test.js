// Acceptance numbers taken from the Local AI Marketplace handbook (pp. 6-7, 13-15, 49-51).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GiB, effectiveBudget, kvBytes, assessFit, estimateVariant, scratchParams, validateArch, trainPlan, trainingMemory, appropriateness } from '../lib/modelfit.js';

test('budget + KV cache: handbook worked examples', () => {
  assert.equal(effectiveBudget({ freeGiB: 18, reserveGiB: 3 }), 15);
  assert.equal(effectiveBudget({ freeGiB: 2, reserveGiB: 3 }), 0, 'never negative');
  assert.equal(kvBytes({ layers: 32, kvHeads: 8, headDim: 128, bytes: 2, positions: 8192 }), 1 * GiB);
  assert.equal(kvBytes({ layers: 32, kvHeads: 8, headDim: 128, bytes: 2, positions: 2 * 8192 }), 2 * GiB, 'two sequences');
});

test('fit status: fit / borderline / incompatible / unknown with % of total and headroom', () => {
  const hw = { totalGiB: 24, budgetGiB: 15 };
  const a = assessFit({ lowGiB: 8, highGiB: 10 }, hw);
  assert.deepEqual([a.status, a.pctLow, a.pctHigh, a.headroomLow, a.headroomHigh], ['fit', 33, 42, 5, 7]);
  assert.equal(assessFit({ lowGiB: 14, highGiB: 17 }, hw).status, 'borderline');
  const c = assessFit({ lowGiB: 26, highGiB: 30 }, hw);
  assert.deepEqual([c.status, c.pctLow, c.pctHigh, c.shortLow, c.shortHigh], ['incompatible', 108, 125, 11, 15]);
  assert.equal(assessFit(null, hw).status, 'unknown');
  assert.equal(assessFit({ lowGiB: 8, highGiB: 10 }, { totalGiB: null, budgetGiB: null }).status, 'unknown', 'no GPU reading: no claim');
  assert.equal(assessFit({ lowGiB: 8, highGiB: 10 }, { totalGiB: 24, budgetGiB: NaN }).status, 'unknown', 'nvidia-smi [N/A] free memory: no claim');
});

test('variant estimate from Ollama metadata: weights + KV + overhead, unknown when metadata is missing', () => {
  const info = { 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 };
  const e = estimateVariant({ sizeBytes: 4 * GiB, info, ctx: 8192, parallel: 1 });
  assert.equal(e.parts.kvGiB, 1);
  assert.ok(e.lowGiB > 5 && e.lowGiB < e.highGiB && e.highGiB < 7, JSON.stringify(e));
  assert.equal(estimateVariant({ sizeBytes: 4 * GiB, info: {}, ctx: 8192 }).kvKnown, false);
  assert.equal(estimateVariant({ sizeBytes: null, info }), null, 'no size: unknown');
});

test('scratch builder: exact parameter count and validation (handbook preset)', () => {
  const preset = { vocab: 8192, layers: 8, width: 512, mlp: 1376, heads: 8, kvHeads: 2, headDim: 64, ctx: 1024, tied: true };
  assert.equal(scratchParams(preset), 26_354_176);
  assert.equal(scratchParams({ ...preset, tied: false }), 26_354_176 + 4_194_304);
  assert.deepEqual(validateArch(preset), []);
  assert.ok(validateArch({ ...preset, kvHeads: 3 }).some((e) => /divisible/.test(e)));
  assert.ok(validateArch({ ...preset, headDim: 63 }).some((e) => /even/.test(e)));
  assert.ok(validateArch({ ...preset, width: 500 }).length, 'heads x headDim must equal width for this design');
  assert.ok(validateArch({ ...preset, layers: 0 }).length);
  // Found by importing a real export into Ollama: a q8_0/q4_0 KV cache needs head dim divisible by its 32-element block.
  assert.ok(validateArch({ ...preset, width: 128, heads: 8, kvHeads: 2, headDim: 16 }).some((e) => /multiple of 32/.test(e)));
});

test('training plan + memory: handbook pilot numbers', () => {
  const p = trainPlan({ tokens: 50_000_000, uniqueTokens: 25_000_000, seq: 1024, micro: 2, accum: 8, devices: 1, tokensPerSec: 600 });
  assert.equal(p.tokensPerUpdate, 16_384);
  assert.equal(p.updates, 3052);
  assert.equal(p.hours, 23.1);
  assert.equal(p.exposures, 2);
  const m = trainingMemory({ params: 26_354_176, layers: 8, width: 512, seq: 1024, micro: 2 });
  assert.ok(m.lowGiB > 0.3 && m.lowGiB < m.highGiB && m.highGiB < 3, JSON.stringify(m));
});

test('appropriateness score: 73 vs 69 fixture, invalid bounds rejected, unmeasured gets no rank', () => {
  const metrics = [
    { key: 'f1', weight: 0.5, dir: 'benefit', floor: 0.7, target: 0.9 },
    { key: 'support', weight: 0.3, dir: 'benefit', floor: 0.9, target: 1.0 },
    { key: 'p95', weight: 0.2, dir: 'cost', ceiling: 2.8, target: 1.2 },
  ];
  const r = appropriateness([{ id: 'small', f1: 0.84, support: 0.96, p95: 1.2 }, { id: 'large', f1: 0.88, support: 0.98, p95: 2.8 }, { id: 'blank' }], metrics);
  assert.deepEqual(r.map((x) => [x.id, x.score]), [['small', 73], ['large', 69], ['blank', null]]);
  assert.throws(() => appropriateness([], [{ ...metrics[0], weight: 1, floor: 0.9, target: 0.7 }]), /bounds/);
  assert.throws(() => appropriateness([], metrics.map((m) => ({ ...m, weight: 0.5 }))), /sum to 1/);
  assert.throws(() => appropriateness([], [{ ...metrics[0], weight: 0.5 }, { ...metrics[0], weight: 0.5 }]), /duplicate/);
});
