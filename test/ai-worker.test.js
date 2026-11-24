// Real Python worker: builds a blank model from config and trains a tiny pilot. Skips when Python/torch are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratchParams } from '../lib/modelfit.js';

const PY = process.env.PYTHON || 'python';
const WORKER = path.join(import.meta.dirname, '..', 'tools', 'ai_worker.py');
const hasTorch = spawnSync(PY, ['-c', 'import torch, transformers, tokenizers'], { windowsHide: true }).status === 0;
const runWorker = (job) => {
  const r = spawnSync(PY, [WORKER], { input: JSON.stringify(job), encoding: 'utf8', windowsHide: true, timeout: 600_000, env: { ...process.env, HF_HUB_OFFLINE: '1' } });
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, stderr: r.stderr, last: lines.at(-1), lines };
};

test('worker: handbook preset builds offline with the exact count; same seed = same initial weights', { skip: !hasTorch && 'python with torch/transformers/tokenizers not installed' }, () => {
  const cfg = { vocab: 8192, layers: 8, width: 512, mlp: 1376, heads: 8, kvHeads: 2, headDim: 64, ctx: 1024, tied: true, seed: 42 };
  const a = runWorker({ cmd: 'build', cfg });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.last.params, 26_354_176);
  assert.equal(a.last.params, scratchParams(cfg), 'the UI count and the real model agree');
  const b = runWorker({ cmd: 'build', cfg });
  assert.equal(b.last.initHash, a.last.initHash, 'reproducible initialization');
  assert.notEqual(runWorker({ cmd: 'build', cfg: { ...cfg, seed: 7 } }).last.initHash, a.last.initHash);
});

test('worker: tiny pilot trains (loss falls), saves a checkpoint with tokenizer, reports throughput', { skip: !hasTorch && 'python with torch/transformers/tokenizers not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ai-'));
  const corpus = path.join(dir, 'corpus.txt');
  fs.writeFileSync(corpus, Array.from({ length: 300 }, (_, i) => `Lesson ${i % 7}: decide your stop before you enter, then size the position so the stop costs at most one percent.`).join('\n'));
  const cfg = { vocab: 512, layers: 2, width: 64, mlp: 172, heads: 4, kvHeads: 2, headDim: 16, ctx: 128, tied: true, seed: 1 };
  const r = runWorker({ cmd: 'pilot', cfg, corpus, runDir: path.join(dir, 'run'), steps: 40, micro: 4, lr: 0.003 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.last.ok, true, JSON.stringify(r.last));
  assert.ok(r.last.lossEnd < r.last.lossStart * 0.8, `loss ${r.last.lossStart} -> ${r.last.lossEnd}`);
  assert.ok(r.last.tokensPerSec > 0);
  assert.ok(r.lines.some((l) => l.progress), 'streams progress lines');
  for (const f of ['config.json', 'model.safetensors', 'tokenizer.json', 'manifest.json']) assert.ok(fs.existsSync(path.join(dir, 'run', 'model', f)), f);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run', 'model', 'manifest.json'), 'utf8'));
  assert.equal(manifest.params, r.last.params);
  assert.equal(manifest.vocab, r.last.vocab);

  // GGUF export (what Ollama on Windows imports). Ollama import + generation was verified by hand; see README.
  const x = runWorker({ cmd: 'export', runDir: path.join(dir, 'run'), name: 'test' });
  assert.equal(x.last.ok, true, JSON.stringify(x.last));
  const head = fs.readFileSync(x.last.gguf).subarray(0, 24);
  assert.equal(head.subarray(0, 4).toString(), 'GGUF');
  assert.equal(head.readUInt32LE(4), 3, 'GGUF v3');
  assert.equal(Number(head.readBigUInt64LE(8)), 2 * 9 + 2, 'tensor count: 9 per block + embeddings + final norm (tied output)');
  assert.equal(x.last.vocab, r.last.vocab);
  assert.match(x.last.sha256, /^[a-f0-9]{64}$/);
});
