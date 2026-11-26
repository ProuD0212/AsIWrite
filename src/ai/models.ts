// The local storyteller models the player can pick. Shared by the workers and the UI.
// Download size doesn't count toward the 10 MB source limit — models are fetched at run time.
//
// How we got here (all measured on the game's own rewrite prompts, see 요청_및_진행현황.md 4-34):
// · Qwen2.5-0.5B (transformers.js): word salad even on CPU ("강 → 철 / 박 → 노 / …") — dropped.
// · EXAONE 3.5 2.4B (transformers.js): best Korean in Node (10/10), but the browser can't
//   create the session — std::bad_alloc while the 1.7 GB file is read into WASM memory — dropped.
// · Gemma 3 1B (transformers.js): runs everywhere, 8/10, but often awkward → kept as the light fallback.
// · WebLLM (MLC) uploads weights straight to GPU memory, so it isn't capped by the WASM heap,
//   which makes 2–4B models possible in the browser. Tested (Node, same prompts, ONNX builds):
//     Gemma 4 E2B  10/10, natural and faithful, follows 반말/존댓말 ("지호야, 너 혹시 길냥이한테…")
//     Qwen3.5 2B   10/10 but typos and drift ("무뚱뚱해", invented "스타벅스") — not better than Gemma 3 1B
//     Qwen3.5 4B   wrote long English "Thinking Process…" first (40–50 s per line) — unusable here
//   → Gemma 4 E2B is the default.

export type LocalModelKey = 'gemma4' | 'qwen35';
export type Engine = 'transformers' | 'webllm';

export interface LocalModel {
  key: LocalModelKey;
  engine: Engine;
  /** transformers.js: Hugging Face repo · WebLLM: prebuilt model id (q4f16 variant) */
  id: string;
  /** WebLLM: the variant for GPUs without 16-bit float shaders */
  idF32?: string;
  label: string;
  /** transformers.js dtype on WebGPU / on CPU (WASM).
   *  CPU must be q8: the q4 exports use a GatherBlockQuantized node that the browser's
   *  WASM runtime doesn't implement — it only worked in our Node tests. */
  gpu?: 'q4f16' | 'q4' | 'q8' | 'fp16';
  cpu?: 'q8';
  /** human-readable download size / GPU memory */
  size: string;
  note: string;
  /** tried next if this model can't be loaded or writes broken text on this computer */
  fallback?: LocalModelKey;
  /** no CPU path (WebLLM needs WebGPU; big models are useless on CPU) */
  gpuOnly?: boolean;
  /** hybrid "thinking" model: ask it not to think (we want one quick line) */
  thinking?: boolean;
}

export const LOCAL_MODELS: Record<LocalModelKey, LocalModel> = {
  gemma4: {
    key: 'gemma4',
    engine: 'webllm',
    id: 'gemma-4-E2B-it-q4f16_1-MLC',
    idF32: 'gemma-4-E2B-it-q4f32_1-MLC',
    label: 'Gemma 4 E2B',
    size: '그래픽 메모리 약 3.4GB',
    note: '대사가 가장 자연스럽고 반말·존댓말도 잘 지켜요(권장). GPU(WebGPU)가 필요해요 — 안 되면 Qwen3.5 2B로 자동 전환.',
    fallback: 'qwen35',
    gpuOnly: true,
  },
  // C111: between the two (memory ~2.2GB). Node test on the game's 10 lines: passes the checks 10/10,
  // but drifts in meaning more often than Gemma 4 (a question becomes a remark, viewpoint flips) — closer to Gemma 3.
  qwen35: {
    key: 'qwen35',
    engine: 'webllm',
    id: 'Qwen3.5-2B-q4f16_1-MLC',
    idF32: 'Qwen3.5-2B-q4f32_1-MLC',
    label: 'Qwen3.5 2B (중간 · 실험)',
    size: '그래픽 메모리 약 2.2GB',
    note: 'Gemma 4보다 가벼워요(그래픽 메모리 약 2.2GB). 문장은 매끄럽지만 가끔 뜻이 바뀌어요. GPU(WebGPU)가 필요해요.',
    gpuOnly: true,
    thinking: true,
  },
};

export const DEFAULT_MODEL: LocalModelKey = 'gemma4';

/**
 * How good each storyteller's Korean is, for 📚 learned lines: a line is reused only while a model of
 * the same tier or lower is running (stronger → weaker is fine, never weaker → stronger).
 * 'old' = learned before authors were recorded.
 */
export const MODEL_TIERS: Record<string, { tier: number; label: string }> = {
  old: { tier: 0, label: '이전 기록' },
  qwen35: { tier: 1, label: 'Qwen3.5 2B' },
  gemma4: { tier: 2, label: 'Gemma 4 E2B' },
  groq: { tier: 3, label: 'Groq' },
  gemini: { tier: 4, label: 'Gemini' },
};
export function modelTier(id: string): number {
  return MODEL_TIERS[id]?.tier ?? 0;
}
/** which storyteller a status label (e.g. the server PC's) describes */
export function modelFromLabel(label: string): string {
  return /gemini/i.test(label) ? 'gemini' : /groq/i.test(label) ? 'groq' : /gemma/i.test(label) ? 'gemma4' : /qwen/i.test(label) ? 'qwen35' : '';
}
// v3: earlier builds saved 'exaone' / 'gemma' as the choice; start everyone on the new default
export const MODEL_KEY_STORAGE = 'asiwrite.storyModel.v3';

export interface LoadStep {
  key: LocalModelKey;
  device: 'webgpu' | 'wasm';
  /** WebLLM only: the GPU can't do 16-bit float shaders → use the f32 build */
  f32?: boolean;
}

/** The load ladder: chosen model on GPU (→ CPU if it has one) → its fallback … */
export function loadLadder(key: LocalModelKey, gpu: { ok: boolean; f16: boolean }): LoadStep[] {
  const steps: LoadStep[] = [];
  for (let k: LocalModelKey | undefined = key, n = 0; k && n < 5; k = LOCAL_MODELS[k].fallback, n++) {
    const m = LOCAL_MODELS[k];
    if (gpu.ok) steps.push({ key: k, device: 'webgpu', f32: m.engine === 'webllm' && !gpu.f16 });
    if (!m.gpuOnly) steps.push({ key: k, device: 'wasm' });
  }
  return steps;
}

export function stepLabel(s: LoadStep) {
  return `${LOCAL_MODELS[s.key].label} · ${s.device === 'webgpu' ? 'GPU' : 'CPU'}`;
}
