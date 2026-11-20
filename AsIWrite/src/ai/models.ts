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

export type LocalModelKey = 'gemma4' | 'gemma';
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
    note: '대사가 가장 자연스럽고 반말·존댓말도 잘 지켜요(권장). GPU가 필요해요 — 안 되면 Gemma 3 1B로 자동 전환.',
    fallback: 'gemma',
    gpuOnly: true,
  },
  gemma: {
    key: 'gemma',
    engine: 'transformers',
    id: 'onnx-community/gemma-3-1b-it-ONNX',
    label: 'Gemma 3 1B (가벼움)',
    gpu: 'q4f16',
    cpu: 'q8',
    size: '약 0.8GB (GPU) / 1.5GB (CPU)',
    note: '가볍고 GPU가 없어도 돌아가요. 문장이 가끔 어색해요.',
  },
};

export const DEFAULT_MODEL: LocalModelKey = 'gemma4';
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
