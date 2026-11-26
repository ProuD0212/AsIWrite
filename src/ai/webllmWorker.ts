/// <reference lib="webworker" />
// Local storyteller LLM via WebLLM (MLC), off the main thread.
// Unlike ONNX Runtime Web, WebLLM uploads the weights straight into GPU memory, so it isn't
// capped by the browser's WASM heap — that's what lets 2–4B models (Qwen3.5) run here while
// a 2.4B ONNX model died with std::bad_alloc. Needs WebGPU. Same protocol as llmWorker.

import { CreateMLCEngine, type MLCEngine } from '@mlc-ai/web-llm';
import { LOCAL_MODELS, stepLabel } from './models';
import { CHECK_MESSAGES, mathLooksSane } from './validate';
import type { ChatMsg, LlmIn, LlmOut } from './protocol';

let engine: MLCEngine | null = null;
let ready: Promise<boolean> | null = null;
let thinking = false;

function post(m: LlmOut) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 160);
}

/** set once a model refuses a system role — from then on it's folded into the first user turn */
let foldSystem = false;
function fold(messages: ChatMsg[]): ChatMsg[] {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  if (!sys || !rest.length) return rest;
  return [{ ...rest[0], content: `${sys}\n\n${rest[0].content}` }, ...rest.slice(1)];
}

async function complete(messages: ChatMsg[], maxTokens: number, temperature: number, duty = 1): Promise<string> {
  try {
    return await request(foldSystem ? fold(messages) : messages, maxTokens, temperature, duty);
  } catch (e) {
    if (foldSystem || !/system/i.test(errText(e))) throw e;
    foldSystem = true;
    return request(fold(messages), maxTokens, temperature, duty);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** prompt-reading time of the last streamed job (reported back so the next job waits it off) */
let lastPrefillMs = 0;
/**
 * duty < 1: stream token by token and rest between them so the GPU isn't pinned at 100% —
 * the work is spread out instead of arriving as a spike (rest = work time × (1−duty)/duty).
 */
async function request(messages: ChatMsg[], maxTokens: number, temperature: number, duty = 1): Promise<string> {
  if (duty < 0.99) {
    const stream = await engine!.chat.completions.create({
      messages,
      max_tokens: maxTokens,
      temperature,
      top_p: 0.9,
      repetition_penalty: 1.05,
      stream: true,
      ...(thinking ? { extra_body: { enable_thinking: false } } : {}),
    });
    let out = '';
    let t = performance.now();
    let first = true;
    for await (const chunk of stream) {
      if (first) {
        lastPrefillMs = performance.now() - t;
        first = false;
      }
      out += chunk.choices[0]?.delta?.content ?? '';
      const work = performance.now() - t;
      await sleep(Math.min(120, (work * (1 - duty)) / duty));
      t = performance.now();
    }
    return out;
  }
  const r = await engine!.chat.completions.create({
    messages,
    max_tokens: maxTokens,
    temperature,
    top_p: 0.9,
    repetition_penalty: 1.05,
    // one quick line, no hidden reasoning (Qwen3-family hybrid thinking)
    ...(thinking ? { extra_body: { enable_thinking: false } } : {}),
  });
  return r.choices[0]?.message?.content ?? '';
}

async function init(m: Extract<LlmIn, { type: 'init' }>): Promise<boolean> {
  const t0 = performance.now();
  const model = LOCAL_MODELS[m.step.key];
  thinking = !!model.thinking;
  const id = m.step.f32 && model.idF32 ? model.idF32 : model.id;
  const stage = stepLabel(m.step);
  try {
    engine = await CreateMLCEngine(id, {
      initProgressCallback: (p) => post({ type: 'progress', loaded: p.progress, total: 1, stage }),
    });
  } catch (e) {
    post({ type: 'fail', why: `불러오기 실패 — ${errText(e)}` });
    return false;
  }
  let sample = '';
  try {
    sample = (await complete(CHECK_MESSAGES, 40, 0)).trim();
  } catch (e) {
    sample = errText(e);
  }
  const ok = mathLooksSane(sample);
  if (!ok && !m.last) {
    await engine.unload().catch(() => undefined);
    engine = null;
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
    if (!ready || !(await ready) || !engine) return post({ type: 'error', id: m.id, message: 'model not loaded' });
    if (m.restMs && m.restMs > 0) await sleep(Math.min(3000, m.restMs));
    const t0 = performance.now();
    try {
      const t = await complete(m.messages, m.maxTokens, m.temperature, m.duty ?? 1);
      post({ type: 'result', id: m.id, text: t, ms: performance.now() - t0, tokens: t.length, prefillMs: lastPrefillMs });
      lastPrefillMs = 0;
    } catch (e) {
      post({ type: 'error', id: m.id, message: errText(e) });
    }
  }
};
