/// <reference lib="webworker" />
// Local storyteller LLM via transformers.js (ONNX Runtime Web), off the main thread.
// Loads exactly ONE step of the load ladder (ai/models.ts). If it fails, the main thread
// throws this worker away and tries the next step in a fresh one — a failed load
// (std::bad_alloc) leaves the WASM heap bloated for good, so retrying in place can't work.
// It only REWRITES lines the game already produced (Layer 2) — the game never waits for it.

import { env, pipeline, type TextGenerationPipeline } from '@huggingface/transformers';
import { LOCAL_MODELS, stepLabel } from './models';
import { CHECK_MESSAGES, mathLooksSane } from './validate';
import type { ChatMsg, LlmIn, LlmOut } from './protocol';

env.allowLocalModels = false;
env.useBrowserCache = true;

let gen: TextGenerationPipeline | null = null;
let ready: Promise<boolean> | null = null;

function post(m: LlmOut) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
}

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  // ONNX Runtime (WASM) aborts with a bare number when it runs out of memory
  return /^\d+$/.test(s.trim()) ? `메모리 부족으로 추정 (코드 ${s.trim()})` : s.slice(0, 160);
}

function text(out: unknown): string {
  const g = (out as { generated_text: string | ChatMsg[] }[])[0]?.generated_text;
  return typeof g === 'string' ? g : (g?.at(-1)?.content ?? '');
}

async function init(m: Extract<LlmIn, { type: 'init' }>): Promise<boolean> {
  const t0 = performance.now();
  const model = LOCAL_MODELS[m.step.key];
  const stage = stepLabel(m.step);
  const files = new Map<string, { loaded: number; total: number }>();
  try {
    gen = (await pipeline('text-generation', model.id, {
      dtype: m.step.device === 'webgpu' ? model.gpu : model.cpu,
      device: m.step.device,
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file && p.total) {
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) (loaded += f.loaded), (total += f.total);
          post({ type: 'progress', loaded, total, stage });
        }
      },
    })) as TextGenerationPipeline;
  } catch (e) {
    post({ type: 'fail', why: `불러오기 실패 — ${errText(e)}` });
    return false;
  }
  let sample = '';
  try {
    sample = text(await gen(CHECK_MESSAGES, { max_new_tokens: 40, do_sample: false, repetition_penalty: 1.1 })).trim();
  } catch (e) {
    sample = errText(e);
  }
  const ok = mathLooksSane(sample);
  if (!ok && !m.last) {
    await gen.dispose().catch(() => undefined);
    gen = null;
    post({ type: 'fail', why: `시험 문장이 깨짐 — “${sample.slice(0, 40)}”` });
    return false;
  }
  post({ type: 'ready', ms: performance.now() - t0, selfCheck: { ok, sample: sample.slice(0, 80) } });
  return true;
}

self.onmessage = async (ev: MessageEvent<LlmIn>) => {
  const m = ev.data;
  if (m.type === 'init') {
    ready ??= init(m);
    return;
  }
  if (m.type === 'generate') {
    if (!ready || !(await ready) || !gen) return post({ type: 'error', id: m.id, message: 'model not loaded' });
    const t0 = performance.now();
    try {
      const out = await gen(m.messages, {
        max_new_tokens: m.maxTokens,
        do_sample: true,
        temperature: m.temperature,
        top_k: 30,
        top_p: 0.85,
        repetition_penalty: 1.1,
        no_repeat_ngram_size: 4,
      });
      const t = text(out);
      post({ type: 'result', id: m.id, text: t, ms: performance.now() - t0, tokens: t.length });
    } catch (e) {
      post({ type: 'error', id: m.id, message: errText(e) });
    }
  }
};
