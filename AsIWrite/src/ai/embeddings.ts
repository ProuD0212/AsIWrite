// Embedding service (main thread side).
//
// The simulation asks for similarities synchronously every frame, but the
// model answers asynchronously. So: similarity() uses cached vectors when both
// texts are known, otherwise falls back to the lexical score and queues the
// missing texts. Batches are flushed to the worker; as vectors arrive the cache
// fills and the world gets notified to recompute derived values.
//
// Vectors are NEVER saved — saves stay text-only and are re-embedded on load.

import type { OutMsg } from './embedWorker';
import { b64ToF32, hostStatus, relayJob, hostAIMode, watchHost } from './remote';

export type EmbedState = 'off' | 'idle' | 'loading' | 'ready' | 'error';

const BATCH = 32;
const STORAGE_KEY = 'asiwrite.embeddings';

/**
 * Playing from another PC with "AI on the server PC": looks like the embedding worker, but every
 * batch is sent to the server PC's meaning model through the share server (ai/remote.ts).
 */
class RemoteEmbedWorker {
  onmessage: ((ev: MessageEvent<OutMsg>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  private alive = true;
  private send(m: OutMsg) {
    this.onmessage?.({ data: m } as MessageEvent<OutMsg>);
  }
  postMessage(m: { type: 'init' } | { type: 'embed'; id: number; texts: string[] }) {
    if (m.type === 'init') {
      watchHost();
      const t0 = performance.now();
      const wait = () => {
        if (!this.alive) return;
        if (hostStatus.embed) return this.send({ type: 'ready', ms: performance.now() - t0 });
        this.send({ type: 'progress', loaded: 0, total: 1, file: '서버 PC의 의미 모델 기다리는 중' });
        setTimeout(wait, 3000);
      };
      wait();
      return;
    }
    const t0 = performance.now();
    void relayJob<{ dim: number; data: string }>('embed', { texts: m.texts }, 60000).then((r) => {
      if (!this.alive) return;
      if (!r) return this.send({ type: 'vectors', id: m.id, dim: 0, data: new Float32Array(0), ms: 0 });
      this.send({ type: 'vectors', id: m.id, dim: r.dim, data: b64ToF32(r.data), ms: performance.now() - t0 });
    });
  }
  terminate() {
    this.alive = false;
  }
}

export class EmbeddingService {
  state: EmbedState = 'idle';
  progress = 0; // 0..1 download progress
  error = '';
  readyMs = 0;
  /** telemetry */
  stats = { embedded: 0, batches: 0, avgBatchMs: 0, cacheHits: 0, cacheMisses: 0 };

  private worker: Worker | null = null;
  private cache = new Map<string, Float32Array>();
  private pending = new Set<string>();
  private inflight = new Map<number, string[]>();
  private nextId = 1;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private updateListeners = new Set<() => void>();

  constructor() {
    if (!EmbeddingService.enabledSetting()) this.state = 'off';
  }

  static enabledSetting(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      return true;
    }
  }
  static setEnabledSetting(on: boolean) {
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }

  /** subscribe to state/progress changes (UI) */
  onState(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** subscribe to "new vectors arrived" (simulation recomputes derived values) */
  onUpdate(fn: () => void) {
    this.updateListeners.add(fn);
    return () => this.updateListeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  start() {
    if (this.state === 'off' || this.worker || typeof Worker === 'undefined') return;
    try {
      this.worker = hostAIMode() ? (new RemoteEmbedWorker() as unknown as Worker) : new Worker(new URL('./embedWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      this.state = 'error';
      this.error = String(e);
      this.emit();
      return;
    }
    this.worker.onmessage = (ev: MessageEvent<OutMsg>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.state = 'error';
      this.error = ev.message || 'worker error';
      this.emit();
    };
    this.state = 'loading';
    this.emit();
    this.worker.postMessage({ type: 'init' });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.state = 'off';
    this.pending.clear();
    this.inflight.clear();
    this.emit();
  }

  private onMessage(m: OutMsg) {
    switch (m.type) {
      case 'progress':
        this.progress = m.total ? m.loaded / m.total : 0;
        this.emit();
        break;
      case 'ready':
        this.state = 'ready';
        this.progress = 1;
        this.readyMs = m.ms;
        this.emit();
        this.scheduleFlush(0);
        break;
      case 'error':
        this.state = 'error';
        this.error = m.message;
        this.emit();
        break;
      case 'vectors': {
        const waiter = this.batchWaiters.get(m.id);
        if (waiter) {
          this.batchWaiters.delete(m.id);
          waiter(m.dim ? { dim: m.dim, data: m.data } : null);
          return;
        }
        const texts = this.inflight.get(m.id);
        this.inflight.delete(m.id);
        if (!texts) return;
        // a failed remote batch: try those texts again later
        if (!m.dim) {
          for (const t of texts) this.pending.add(t);
          this.scheduleFlush(5000);
          return;
        }
        for (let i = 0; i < texts.length; i++) this.cache.set(texts[i], m.data.subarray(i * m.dim, (i + 1) * m.dim));
        this.stats.embedded += texts.length;
        this.stats.batches++;
        this.stats.avgBatchMs = this.stats.avgBatchMs * 0.8 + m.ms * 0.2;
        for (const l of this.updateListeners) l();
        if (this.pending.size) this.scheduleFlush(0);
        break;
      }
    }
  }

  private scheduleFlush(delay = 120) {
    if (this.flushTimer || this.state !== 'ready') return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }

  private flush() {
    if (!this.worker || this.state !== 'ready' || !this.pending.size) return;
    if (this.inflight.size >= 2) return this.scheduleFlush(60); // keep the worker lightly loaded
    const texts = [...this.pending].slice(0, BATCH);
    for (const t of texts) this.pending.delete(t);
    const id = this.nextId++;
    this.inflight.set(id, texts);
    this.worker.postMessage({ type: 'embed', id, texts });
    if (this.pending.size) this.scheduleFlush(30);
  }

  private key(text: string) {
    return text.trim().slice(0, 200);
  }

  private batchWaiters = new Map<number, (r: { dim: number; data: Float32Array } | null) => void>();
  /** embed a batch right away and hand back the raw vectors (the server PC answering other PCs) */
  embedBatch(texts: string[]): Promise<{ dim: number; data: Float32Array } | null> {
    if (!this.worker || this.state !== 'ready' || !texts.length) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.batchWaiters.set(id, resolve);
      this.worker!.postMessage({ type: 'embed', id, texts: texts.map((t) => this.key(t)) });
      setTimeout(() => {
        if (this.batchWaiters.delete(id)) resolve(null);
      }, 30000);
    });
  }

  /** queue texts for embedding (no-op if cached/pending) */
  request(texts: Iterable<string>) {
    if (this.state === 'off' || this.state === 'error') return;
    for (const raw of texts) {
      const t = this.key(raw);
      if (!t || this.cache.has(t) || this.pending.has(t)) continue;
      if ([...this.inflight.values()].some((arr) => arr.includes(t))) continue;
      this.pending.add(t);
    }
    if (this.pending.size) this.scheduleFlush();
  }

  get(text: string): Float32Array | undefined {
    return this.cache.get(this.key(text));
  }

  /** cosine of two cached (normalised) vectors, or null if either is missing (and queues it) */
  cosine(a: string, b: string): number | null {
    const va = this.get(a), vb = this.get(b);
    if (!va || !vb) {
      this.stats.cacheMisses++;
      const miss: string[] = [];
      if (!va) miss.push(a);
      if (!vb) miss.push(b);
      this.request(miss);
      return null;
    }
    this.stats.cacheHits++;
    let dot = 0;
    for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
    return dot;
  }

  /** Embed one text now (resolves when its vector arrives, or undefined after `timeout` ms). */
  embedNow(text: string, timeout = 3000): Promise<Float32Array | undefined> {
    const hit = this.get(text);
    if (hit) return Promise.resolve(hit);
    if (this.state !== 'ready') return Promise.resolve(undefined);
    this.request([text]);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        off();
        resolve(this.get(text));
      }, timeout);
      const off = this.onUpdate(() => {
        const v = this.get(text);
        if (v) {
          clearTimeout(t);
          off();
          resolve(v);
        }
      });
    });
  }

  /** cosine between a raw vector and a cached text (null if the text isn't embedded yet) */
  cosineVec(v: Float32Array, text: string): number | null {
    const u = this.get(text);
    if (!u) return null;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * u[i];
    return dot;
  }

  get size() {
    return this.cache.size;
  }
  get queued() {
    return this.pending.size;
  }
}

/** one shared instance for the whole app */
export const embeddings = new EmbeddingService();
