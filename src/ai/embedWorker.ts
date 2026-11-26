/// <reference lib="webworker" />
// Runs the multilingual sentence-embedding model off the main thread so the
// 60fps simulation never stalls. Model: Xenova/paraphrase-multilingual-MiniLM-L12-v2
// (q8 quantized ONNX, ~118 MB, downloaded once and kept in the browser cache).

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

// Korean sentence embeddings. Replaced paraphrase-multilingual-MiniLM-L12-v2, which on our own
// anchors scored unrelated Korean phrases HIGHER than related ones (see 요청_및_진행현황.md 4-38).
export const MODEL_ID = 'jhgan/ko-sroberta-multitask';

type InMsg = { type: 'init' } | { type: 'embed'; id: number; texts: string[] };
export type OutMsg =
  | { type: 'progress'; loaded: number; total: number; file?: string }
  | { type: 'ready'; ms: number }
  | { type: 'error'; message: string }
  | { type: 'vectors'; id: number; dim: number; data: Float32Array; ms: number };

env.allowLocalModels = false;
env.useBrowserCache = true;

let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<void> | null = null;
const fileProgress = new Map<string, { loaded: number; total: number }>();

function post(m: OutMsg, transfer: Transferable[] = []) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
}

async function init() {
  if (extractor) return;
  if (!loading) {
    const t0 = performance.now();
    loading = pipeline('feature-extraction', MODEL_ID, {
      dtype: 'fp32', // the repo ships fp32 (≈440 MB); its int8 file is AVX-512 specific
      device: 'wasm',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file && p.total) {
          fileProgress.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          let loaded = 0, total = 0;
          for (const f of fileProgress.values()) (loaded += f.loaded), (total += f.total);
          post({ type: 'progress', loaded, total, file: p.file });
        }
      },
    })
      .then((ex) => {
        extractor = ex as FeatureExtractionPipeline;
        post({ type: 'ready', ms: performance.now() - t0 });
      })
      .catch((e: unknown) => {
        loading = null;
        post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  }
  await loading;
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === 'init') return init();
  if (msg.type === 'embed') {
    await init();
    if (!extractor) return;
    const t0 = performance.now();
    try {
      // mean pooling + L2 normalisation → cosine similarity = dot product
      const out = await extractor(msg.texts, { pooling: 'mean', normalize: true });
      const data = out.data as Float32Array;
      const dim = out.dims[out.dims.length - 1];
      const copy = new Float32Array(data); // own buffer so it can be transferred
      post({ type: 'vectors', id: msg.id, dim, data: copy, ms: performance.now() - t0 }, [copy.buffer]);
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }
};
