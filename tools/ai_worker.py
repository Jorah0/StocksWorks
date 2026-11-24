"""StocksWorks AI Lab worker: build and pilot-train a blank (randomly initialized) Llama-style model.

Reads one JSON job on stdin; writes JSON lines on stdout ({"progress": ...} lines, then one final result).
Never downloads weights: the model is constructed from a config (HF_HUB_OFFLINE=1 is set by the caller).
Commands:
  build  {cfg}                                   -> params, initHash, versions
  pilot  {cfg, corpus, runDir, steps, micro, lr} -> trains a tokenizer + the model for a few steps, saves a checkpoint
"""
import hashlib, json, math, os, sys, time


def emit(obj):
    print(json.dumps(obj), flush=True)


def llama_config(cfg, vocab):
    from transformers import LlamaConfig
    return LlamaConfig(
        vocab_size=vocab, hidden_size=cfg["width"], intermediate_size=cfg["mlp"], num_hidden_layers=cfg["layers"],
        num_attention_heads=cfg["heads"], num_key_value_heads=cfg["kvHeads"], head_dim=cfg["headDim"],
        max_position_embeddings=cfg["ctx"], tie_word_embeddings=bool(cfg.get("tied", True)), rms_norm_eps=1e-5,
        attention_bias=False, mlp_bias=False, bos_token_id=0, eos_token_id=1, pad_token_id=2,
    )


def build_model(cfg, vocab):
    import torch
    from transformers import LlamaForCausalLM
    torch.manual_seed(int(cfg.get("seed", 42)))
    model = LlamaForCausalLM(llama_config(cfg, vocab))  # fresh random weights, nothing pretrained
    params = sum(p.numel() for p in model.parameters())  # parameters() yields tied weights once
    h, seen = hashlib.sha256(), set()
    for name, t in sorted(model.state_dict().items()):
        if t.data_ptr() in seen:
            continue
        seen.add(t.data_ptr())
        h.update(name.encode())
        h.update(t.detach().cpu().contiguous().numpy().tobytes())
    return model, params, h.hexdigest()


def versions():
    import torch, transformers
    return {"torch": torch.__version__, "transformers": transformers.__version__, "cuda": torch.cuda.is_available(),
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"}


def cmd_build(job):
    t = time.time()
    _, params, init_hash = build_model(job["cfg"], job["cfg"]["vocab"])
    emit({"ok": True, "params": params, "initHash": init_hash, "seconds": round(time.time() - t, 2), **versions()})


def train_tokenizer(corpus_path, vocab, out_dir):
    from tokenizers import Tokenizer, models, pre_tokenizers, decoders, trainers
    from transformers import PreTrainedTokenizerFast
    tok = Tokenizer(models.BPE())
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    specials = ["<|bos|>", "<|eos|>", "<|pad|>"]  # ids 0, 1, 2 = the config's bos/eos/pad
    trainer = trainers.BpeTrainer(vocab_size=vocab, special_tokens=specials, initial_alphabet=pre_tokenizers.ByteLevel.alphabet())
    tok.train([corpus_path], trainer)
    fast = PreTrainedTokenizerFast(tokenizer_object=tok, bos_token="<|bos|>", eos_token="<|eos|>", pad_token="<|pad|>")
    fast.save_pretrained(out_dir)
    return fast


class Runner:
    """The user's training choices: device, precision (autocast; fp16 uses loss scaling), accumulation, checkpointing."""

    def __init__(self, model, opts, params, lr, steps, betas=(0.9, 0.95), weight_decay=0.1, warmup=0.02):
        import contextlib
        import torch
        self.torch = torch
        o = opts or {}
        self.device = o.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
        if self.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA selected but this PyTorch build has no GPU support (AI Lab -> Training setup)")
        self.precision = o.get("precision") or ("bf16" if self.device == "cuda" else "fp32")
        self.accum = int(o.get("accum", 1))
        self.model = model.to(self.device)
        if o.get("gradCheckpointing"):
            self.model.gradient_checkpointing_enable()
            if hasattr(self.model, "enable_input_require_grads"):
                self.model.enable_input_require_grads()
        self.model.train()
        dt = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(self.precision)
        self.amp = (lambda: torch.autocast(device_type=self.device, dtype=dt)) if dt else contextlib.nullcontext
        self.scaler = torch.amp.GradScaler("cuda") if self.precision == "fp16" else None
        self.params = [p for p in params if p.requires_grad]
        self.opt = torch.optim.AdamW(self.params, lr=lr, betas=betas, weight_decay=weight_decay)
        warm = max(1, int(steps * warmup))
        self.sched = torch.optim.lr_scheduler.LambdaLR(self.opt, lambda s: (s + 1) / warm if s < warm else 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, steps - warm))))
        if self.device == "cuda":
            torch.cuda.reset_peak_memory_stats()

    def step(self, batches):
        """One optimizer update over `accum` micro-batches; returns the mean loss."""
        total = 0.0
        for kw in batches:
            with self.amp():
                loss = self.model(**{k: v.to(self.device) for k, v in kw.items()}).loss / len(batches)
            if not self.torch.isfinite(loss):
                raise RuntimeError("Non-finite loss: lower the learning rate or use fp32")
            (self.scaler.scale(loss) if self.scaler else loss).backward()
            total += loss.item()
        if self.scaler:
            self.scaler.unscale_(self.opt)
        self.torch.nn.utils.clip_grad_norm_(self.params, 1.0)
        if self.scaler:
            self.scaler.step(self.opt)
            self.scaler.update()
        else:
            self.opt.step()
        self.opt.zero_grad(set_to_none=True)
        self.sched.step()
        return total

    def peak(self):
        return round(self.torch.cuda.max_memory_allocated() / 2**30, 3) if self.device == "cuda" else None


def cmd_pilot(job):
    import torch
    cfg, steps, micro = job["cfg"], int(job.get("steps", 30)), int(job.get("micro", 2))
    seq = min(int(cfg["ctx"]), int(job.get("seq", cfg["ctx"])))
    out = os.path.join(job["runDir"], "model")
    os.makedirs(out, exist_ok=True)
    opts = job.get("opts") or {}

    emit({"progress": "training tokenizer"})
    tok = train_tokenizer(job["corpus"], int(cfg["vocab"]), out)
    vocab = len(tok)  # a small corpus can yield fewer merges than requested: the model is sized to the real tokenizer
    with open(job["corpus"], encoding="utf-8") as f:
        ids = []
        for line in f:
            if line.strip():
                ids += [tok.bos_token_id] + tok.encode(line.strip(), add_special_tokens=False) + [tok.eos_token_id]
    if len(ids) < seq * micro + 1:
        emit({"ok": False, "error": f"Corpus too small: {len(ids)} tokens for one batch of {micro}x{seq}"})
        return
    data = torch.tensor(ids, dtype=torch.long)

    emit({"progress": f"building model (vocab {vocab})"})
    model, params, init_hash = build_model(cfg, vocab)
    run = Runner(model, opts, model.parameters(), float(job.get("lr", 3e-4)), steps)
    gen = torch.Generator().manual_seed(int(cfg.get("seed", 42)))
    losses, tokens, t0 = [], 0, time.time()
    for step in range(steps):
        batches = []
        for _ in range(run.accum):
            starts = torch.randint(0, len(data) - seq - 1, (micro,), generator=gen)
            batch = torch.stack([data[s:s + seq] for s in starts])
            batches.append({"input_ids": batch, "labels": batch})  # labels are shifted inside the model
        try:
            loss = run.step(batches)
        except RuntimeError as e:
            emit({"ok": False, "error": f"Step {step}: {e}"})
            return
        losses.append(loss)
        tokens += micro * seq * run.accum
        if step % max(1, steps // 10) == 0 or step == steps - 1:
            emit({"progress": f"step {step + 1}/{steps}", "step": step + 1, "loss": round(loss, 4)})
    secs = time.time() - t0
    device = run.device

    emit({"progress": "saving checkpoint"})
    tail = max(1, len(losses) // 5)
    result = {
        "ok": True, "params": params, "vocab": vocab, "initHash": init_hash, "steps": steps, "seq": seq, "micro": micro,
        "lossStart": round(sum(losses[:tail]) / tail, 4), "lossEnd": round(sum(losses[-tail:]) / tail, 4),
        "tokensPerSec": round(tokens / secs, 1), "seconds": round(secs, 1), "corpusTokens": len(ids),
        "peakVramGiB": run.peak(), "trainDevice": device, "precision": run.precision, "accum": run.accum, **versions(),
    }
    model.to("cpu").float().save_pretrained(out, safe_serialization=True)  # export reads float32 weights
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({**result, "cfg": cfg, "created": time.time()}, f, indent=2)
    torch.save({"optimizer": run.opt.state_dict(), "scheduler": run.sched.state_dict(), "step": steps}, os.path.join(job["runDir"], "training_state.pt"))
    emit(result)


# ---------------- fine-tune an existing model (LoRA) on reviewed examples ----------------
LORA_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def _chat_examples(tok, path, max_len):
    """Chat rows -> (input_ids, labels) with loss only on the assistant answer; truncated answers are dropped."""
    import torch
    out, dropped = [], 0
    if not path or not os.path.exists(path):
        return out, dropped
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            msgs = json.loads(line)["messages"]
            prompt = tok.apply_chat_template(msgs[:-1], add_generation_prompt=True, tokenize=False)
            p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
            a_ids = tok(msgs[-1]["content"], add_special_tokens=False)["input_ids"] + [tok.eos_token_id]
            if len(p_ids) + len(a_ids) > max_len:
                dropped += 1  # never train on a cut-off answer
                continue
            ids = torch.tensor(p_ids + a_ids)
            labels = torch.tensor([-100] * len(p_ids) + a_ids)
            out.append((ids, labels))
    return out, dropped


def _batches(examples, micro, pad_id, gen):
    import torch
    order = torch.randperm(len(examples), generator=gen).tolist()
    for i in range(0, len(order), micro):
        chunk = [examples[j] for j in order[i:i + micro]]
        n = max(len(x) for x, _ in chunk)
        ids = torch.full((len(chunk), n), pad_id)
        labels = torch.full((len(chunk), n), -100)
        mask = torch.zeros((len(chunk), n), dtype=torch.long)
        for k, (x, y) in enumerate(chunk):
            ids[k, :len(x)], labels[k, :len(y)], mask[k, :len(x)] = x, y, 1
        yield {"input_ids": ids, "labels": labels, "attention_mask": mask}


def cmd_finetune(job):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model
    opts, base = job.get("opts") or {}, job["base"]
    out = os.path.join(job["runDir"], "model")
    os.makedirs(out, exist_ok=True)
    emit({"progress": f"loading {base} (first use downloads it)"})
    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    if not tok.chat_template:
        emit({"ok": False, "error": "This base model has no chat template: pick an instruction-tuned model"})
        return
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float32)
    max_len = int(job.get("maxLen", 2048))
    train, dropped = _chat_examples(tok, job["train"], max_len)
    dev, _ = _chat_examples(tok, job.get("dev"), max_len)
    if not train:
        emit({"ok": False, "error": f"No usable training examples ({dropped} were longer than {max_len} tokens)"})
        return
    lora = LoraConfig(r=int(job.get("r", 16)), lora_alpha=int(job.get("alpha", 32)), lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=[m for m in LORA_TARGETS if any(n.endswith(m) for n, _ in model.named_modules())])
    model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    epochs, micro = int(job.get("epochs", 2)), int(job.get("micro", 1))
    accum = int(opts.get("accum", 1))
    steps = max(1, math.ceil(len(train) / micro / accum) * epochs)
    run = Runner(model, opts, model.parameters(), float(job.get("lr", 1e-4)), steps, betas=(0.9, 0.999), weight_decay=0.0, warmup=0.03)
    gen = torch.Generator().manual_seed(int(job.get("seed", 42)))

    def dev_loss():
        if not dev:
            return None
        run.model.eval()
        tot = 0.0
        with torch.no_grad():
            for b in _batches(dev, micro, tok.pad_token_id, gen):
                with run.amp():
                    tot += run.model(**{k: v.to(run.device) for k, v in b.items()}).loss.item()
        run.model.train()
        return round(tot / math.ceil(len(dev) / micro), 4)

    emit({"progress": f"LoRA: training {trainable:,} of {total:,} weights ({100 * trainable / total:.2f}%) on {run.device} {run.precision}"})
    dev_before = dev_loss()
    losses, t0, step, tokens = [], time.time(), 0, 0
    for epoch in range(epochs):
        it = _batches(train, micro, tok.pad_token_id, gen)
        while True:
            group = [b for _, b in zip(range(accum), it)]
            if not group:
                break
            try:
                losses.append(run.step(group))
            except RuntimeError as e:
                emit({"ok": False, "error": f"Step {step}: {e}"})
                return
            tokens += sum(int(b["attention_mask"].sum()) for b in group)
            step += 1
            if step % max(1, steps // 10) == 0 or step == steps:
                emit({"progress": f"epoch {epoch + 1}/{epochs} step {step}/{steps}", "step": step, "loss": round(losses[-1], 4)})
    secs = time.time() - t0
    dev_after = dev_loss()

    emit({"progress": "merging the adapter into the base weights"})
    peak = run.peak()
    adapter_dir = os.path.join(job["runDir"], "adapter")
    run.model.save_pretrained(adapter_dir)  # the LoRA adapter on its own (small)
    merged = run.model.merge_and_unload().to("cpu").float()
    merged.save_pretrained(out, safe_serialization=True)
    tok.save_pretrained(out)
    tail = max(1, len(losses) // 5)
    result = {
        "ok": True, "base": base, "arch": merged.config.model_type, "params": total, "trainable": trainable, "examples": len(train),
        "devExamples": len(dev), "droppedTooLong": dropped, "epochs": epochs, "steps": step, "lossStart": round(sum(losses[:tail]) / tail, 4),
        "lossEnd": round(sum(losses[-tail:]) / tail, 4), "devLossBefore": dev_before, "devLossAfter": dev_after,
        "tokensPerSec": round(tokens / max(secs, 1e-6), 1), "seconds": round(secs, 1), "peakVramGiB": peak,
        "trainDevice": run.device, "precision": run.precision, "accum": accum, "r": lora.r, **versions(),
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({**result, "created": time.time()}, f, indent=2)
    emit(result)


# ---------------- GGUF export (Ollama on Windows imports GGUF, not raw safetensors) ----------------
# Minimal GGUF v3 writer for the Llama architecture, F32 tensors; no llama.cpp checkout or gguf package needed.
# ponytail: F32 only (exact, fine for small lab models); quantize with llama.cpp if a large model needs it.
def _gguf_str(s):
    import struct
    b = s.encode("utf-8")
    return struct.pack("<Q", len(b)) + b


def _gguf_kv(key, value):
    import struct
    head = _gguf_str(key)
    if isinstance(value, bool):
        return head + struct.pack("<IB", 7, int(value))
    if isinstance(value, int):
        return head + struct.pack("<II", 4, value)
    if isinstance(value, float):
        return head + struct.pack("<If", 6, value)
    if isinstance(value, str):
        return head + struct.pack("<I", 8) + _gguf_str(value)
    if isinstance(value, list) and value and isinstance(value[0], str):
        return head + struct.pack("<IIQ", 9, 8, len(value)) + b"".join(_gguf_str(v) for v in value)
    if isinstance(value, list):
        return head + struct.pack("<IIQ", 9, 5, len(value)) + struct.pack(f"<{len(value)}i", *value)
    raise TypeError(key)


def cmd_export(job):
    import struct
    import numpy as np
    from safetensors.numpy import load_file
    d = os.path.join(job["runDir"], "model")
    cfg = json.load(open(os.path.join(d, "config.json"), encoding="utf-8"))
    tj = json.load(open(os.path.join(d, "tokenizer.json"), encoding="utf-8"))
    # This writer covers Llama-architecture models with a byte-level BPE tokenizer (our scratch models, SmolLM2...).
    if cfg.get("model_type") != "llama" or tj.get("model", {}).get("type") != "BPE" or "ByteLevel" not in json.dumps(tj.get("pre_tokenizer")):
        emit({"ok": False, "error": f"Export supports Llama-architecture models with a byte-level BPE tokenizer (e.g. SmolLM2); this is {cfg.get('model_type')} / {tj.get('model', {}).get('type')}. The trained weights are saved in the run folder."})
        return
    if cfg.get("attention_bias") or cfg.get("mlp_bias"):
        emit({"ok": False, "error": "Export does not support attention/MLP bias tensors yet"})
        return
    tcfg_path = os.path.join(d, "tokenizer_config.json")
    tcfg = json.load(open(tcfg_path, encoding="utf-8")) if os.path.exists(tcfg_path) else {}
    jinja = os.path.join(d, "chat_template.jinja")
    chat_template = open(jinja, encoding="utf-8").read() if os.path.exists(jinja) else tcfg.get("chat_template")
    if isinstance(chat_template, list):
        chat_template = next((t.get("template") for t in chat_template if t.get("name") == "default"), None)

    def tid(name, fallback):
        v = cfg.get(f"{name}_token_id")
        if isinstance(v, list):
            v = v[0]
        return int(v) if v is not None else fallback
    w = load_file(os.path.join(d, "model.safetensors"))
    nh, nkv, hd = cfg["num_attention_heads"], cfg["num_key_value_heads"], cfg.get("head_dim") or cfg["hidden_size"] // cfg["num_attention_heads"]

    def permute(t, heads):  # HF rotate-half layout -> GGML interleaved rope layout (as llama.cpp's converter does)
        return t.reshape(heads, 2, t.shape[0] // heads // 2, *t.shape[1:]).swapaxes(1, 2).reshape(t.shape)

    names = {"model.embed_tokens.weight": "token_embd.weight", "model.norm.weight": "output_norm.weight", "lm_head.weight": "output.weight"}
    per = {"input_layernorm": "attn_norm", "self_attn.q_proj": "attn_q", "self_attn.k_proj": "attn_k", "self_attn.v_proj": "attn_v",
           "self_attn.o_proj": "attn_output", "post_attention_layernorm": "ffn_norm", "mlp.gate_proj": "ffn_gate", "mlp.up_proj": "ffn_up", "mlp.down_proj": "ffn_down"}
    tensors = []
    for k, t in sorted(w.items()):
        t = t.astype(np.float32)
        if k in names:
            g = names[k]
        else:
            parts = k.split(".")  # model.layers.N.<sub>.weight
            sub = ".".join(parts[3:-1])
            g = f"blk.{parts[2]}.{per[sub]}.weight"
            if sub == "self_attn.q_proj":
                t = permute(t, nh)
            elif sub == "self_attn.k_proj":
                t = permute(t, nkv)
        tensors.append((g, np.ascontiguousarray(t)))
    if cfg.get("tie_word_embeddings") and not any(n == "output.weight" for n, _ in tensors):
        pass  # llama runtimes reuse token_embd when output.weight is absent

    vocab = tj["model"]["vocab"]
    tokens = [None] * len(vocab)
    for tok, i in vocab.items():
        tokens[i] = tok
    specials = {a["id"]: a["content"] for a in tj.get("added_tokens", [])}
    for i, c in specials.items():
        if i >= len(tokens):
            tokens += [None] * (i + 1 - len(tokens))
        tokens[i] = c
    merges = [m if isinstance(m, str) else " ".join(m) for m in tj["model"].get("merges", [])]
    kv = {
        "general.architecture": "llama", "general.name": job.get("name", "stocksworks-scratch"), "general.file_type": 0,
        "llama.context_length": cfg["max_position_embeddings"], "llama.embedding_length": cfg["hidden_size"],
        "llama.block_count": cfg["num_hidden_layers"], "llama.feed_forward_length": cfg["intermediate_size"],
        "llama.attention.head_count": nh, "llama.attention.head_count_kv": nkv, "llama.rope.dimension_count": hd,
        "llama.attention.key_length": hd, "llama.attention.value_length": hd,
        "llama.attention.layer_norm_rms_epsilon": float(cfg.get("rms_norm_eps", 1e-5)), "llama.rope.freq_base": float(cfg.get("rope_theta") or (cfg.get("rope_parameters") or {}).get("rope_theta") or 10000.0),
        "llama.vocab_size": len(tokens), "general.alignment": 32,
        "tokenizer.ggml.model": "gpt2", "tokenizer.ggml.pre": "default", "tokenizer.ggml.tokens": tokens,
        "tokenizer.ggml.token_type": [3 if i in specials else 1 for i in range(len(tokens))], "tokenizer.ggml.merges": merges,
        "tokenizer.ggml.bos_token_id": tid("bos", 0), "tokenizer.ggml.eos_token_id": tid("eos", 1), "tokenizer.ggml.padding_token_id": tid("pad", tid("eos", 1)),
        "tokenizer.ggml.add_bos_token": False, "tokenizer.ggml.add_eos_token": False,
    }
    if chat_template:
        kv["tokenizer.chat_template"] = chat_template  # lets Ollama apply the model's own chat format
    out = job.get("out") or os.path.join(job["runDir"], "model.gguf")
    with open(out, "wb") as f:
        f.write(b"GGUF" + struct.pack("<IQQ", 3, len(tensors), len(kv)))
        for k, v in kv.items():
            f.write(_gguf_kv(k, v))
        offset = 0
        for name, t in tensors:
            f.write(_gguf_str(name) + struct.pack("<I", t.ndim) + struct.pack(f"<{t.ndim}Q", *reversed(t.shape)) + struct.pack("<IQ", 0, offset))
            offset += (t.nbytes + 31) // 32 * 32
        f.write(b"\0" * ((32 - f.tell() % 32) % 32))
        for _, t in tensors:
            b = t.tobytes()
            f.write(b + b"\0" * ((32 - len(b) % 32) % 32))
    hasher = hashlib.sha256()
    with open(out, "rb") as f:  # chunked: a large model must not be read into memory at once
        for chunk in iter(lambda: f.read(1 << 20), b""):
            hasher.update(chunk)
    h = hasher.hexdigest()
    emit({"ok": True, "gguf": out, "bytes": os.path.getsize(out), "sha256": h, "tensors": len(tensors), "vocab": len(tokens), "chatTemplate": bool(chat_template), "chatml": "<|im_start|>" in (chat_template or "")})


if __name__ == "__main__":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    job = json.loads(sys.stdin.read())
    try:
        {"build": cmd_build, "pilot": cmd_pilot, "finetune": cmd_finetune, "export": cmd_export}[job["cmd"]](job)
    except Exception as e:  # report, don't hang the caller
        emit({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)
