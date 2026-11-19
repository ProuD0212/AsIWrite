/// <reference lib="webworker" />
// Local storyteller LLM, off the main thread. Model: onnx-community/Qwen2.5-0.5B-Instruct
// (q4f16 ≈ 483 MB on WebGPU, q8 ≈ 512 MB on CPU/WASM). Downloaded once, then browser-cached.
// It only REWRITES lines the game already produced (Layer 2) — the game never waits for it.

import { env, pipeline, type TextGenerationPipeline } from '@huggingface/transformers';

export const LLM_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };
type InMsg = { type: 'init' } | { type: 'generate'; id: number; messages: ChatMsg[]; maxTokens: number; temperature: number };
export type LlmOut =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; ms: number; device: 'webgpu' | 'wasm' }
  | { type: 'error'; message: string; id?: number }
  | { type: 'result'; id: number; text: string; ms: number; tokens: number };

env.allowLocalModels = false;
env.useBrowserCache = true;

let gen: TextGenerationPipeline | null = null;
let loading: Promise<void> | null = null;
const files = new Map<string, { loaded: number; total: number }>();

function post(m: LlmOut) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
}

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function init() {
  if (gen) return;
  if (!loading) {
    loading = (async () => {
      const t0 = performance.now();
      const webgpu = await hasWebGPU();
      try {
        gen = (await pipeline('text-generation', LLM_ID, {
          dtype: webgpu ? 'q4f16' : 'q8',
          device: webgpu ? 'webgpu' : 'wasm',
          progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (p.status === 'progress' && p.file && p.total) {
              files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
              let loaded = 0, total = 0;
              for (const f of files.values()) (loaded += f.loaded), (total += f.total);
              post({ type: 'progress', loaded, total });
            }
          },
        })) as TextGenerationPipeline;
        post({ type: 'ready', ms: performance.now() - t0, device: webgpu ? 'webgpu' : 'wasm' });
      } catch (e) {
        loading = null;
        post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }
  await loading;
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const m = ev.data;
  if (m.type === 'init') return init();
  if (m.type === 'generate') {
    await init();
    if (!gen) return post({ type: 'error', id: m.id, message: 'model not loaded' });
    const t0 = performance.now();
    try {
      const out = await gen(m.messages, { max_new_tokens: m.maxTokens, do_sample: true, temperature: m.temperature, top_p: 0.9, repetition_penalty: 1.1 });
      const g = (out as unknown as { generated_text: string | ChatMsg[] }[])[0]?.generated_text;
      const text = typeof g === 'string' ? g : (g?.at(-1)?.content ?? '');
      post({ type: 'result', id: m.id, text, ms: performance.now() - t0, tokens: text.length });
    } catch (e) {
      post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
};
