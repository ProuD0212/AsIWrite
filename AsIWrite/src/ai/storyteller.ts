// "AI 이야기꾼" — Layer-2 generative rewriting.
//
// The simulation always speaks instantly with templates (Layer 1). Some of those
// lines (and long monologues, bios) are queued here and rewritten by a
// generative model with the character's sheet, mood, relationship and situation
// as context. When the rewrite comes back and passes validation, it replaces
// the template text in the speech bubble / story log. If anything fails, the
// template simply stays — the game never waits for the model.
//
// Backends: local model in a Web Worker (ai/models.ts — WebLLM Qwen3.5 by default, Gemma via
// transformers.js as the light fallback; no key) · Gemini · Groq.

import type { LlmOut } from './protocol';
import { cleanOutput, type Register } from './validate';
import { DEFAULT_MODEL, LOCAL_MODELS, MODEL_KEY_STORAGE, loadLadder, stepLabel, type LoadStep, type LocalModelKey } from './models';
export { cleanOutput };

/** Is WebGPU there, and can it do 16-bit float shaders (WebLLM's q4f16 builds need it)? */
async function gpuInfo(): Promise<{ ok: boolean; f16: boolean }> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    return { ok: !!adapter, f16: !!adapter?.features.has('shader-f16') };
  } catch {
    return { ok: false, f16: false };
  }
}

export type StoryBackend = 'local' | 'gemini' | 'groq' | 'off';
export type StoryState = 'off' | 'idle' | 'loading' | 'ready' | 'error';
type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export interface StoryJob {
  key: string; // dedupe key
  kind: 'line' | 'monologue' | 'bio' | 'rumor';
  messages: ChatMsg[];
  maxTokens: number;
  /** drop if not started within this many ms (lines go stale fast) */
  ttl: number;
  priority: number; // higher first
  /** the template text being rewritten — the output must stay recognisably close to it */
  draft?: string;
  /** required speech level when talking to someone (반말 only between close Wills) */
  register?: Register;
  /** names the line may address as "○○ 씨" (listener's full and given name) */
  names?: string[];
  onDone: (text: string) => void;
  /** called when the job is rejected, dropped or errors (the template stays) */
  onFail?: () => void;
}

const BACKEND_KEY = 'asiwrite.storyBackend';
const PROVIDER_KEY = 'asiwrite.apiProvider';
const API_KEY = 'asiwrite.apiKey';

function read(k: string) {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}

export class Storyteller {
  state: StoryState = 'idle';
  progress = 0;
  error = '';
  device: 'webgpu' | 'wasm' | '' = '';
  /** what is being downloaded right now ("GPU", "CPU (GPU 출력 이상)") */
  stage = '';
  /** start-up test sentence: did the loaded model write sane Korean? */
  selfCheck: { ok: boolean; sample: string; fellBack: boolean } | null = null;
  /** the model that actually loaded (may be a fallback of the chosen one) */
  activeModel: LocalModelKey | null = null;
  /** every load/self-check step that failed on this computer, in order */
  failures: string[] = [];
  stats = { done: 0, rejected: 0, dropped: 0, avgMs: 0 };
  /** the latest outputs that failed validation (for the research panel / debugging) */
  rejects: { draft: string; raw: string }[] = [];

  private worker: Worker | null = null;
  /** load ladder for this start and the step currently being tried */
  private ladder: LoadStep[] = [];
  private stepIndex = 0;
  private queue: (StoryJob & { at: number })[] = [];
  private busy = false;
  private nextId = 1;
  private pending = new Map<number, StoryJob>();
  private keys = new Set<string>();
  private listeners = new Set<() => void>();

  backend(): StoryBackend {
    const b = read(BACKEND_KEY) as StoryBackend;
    if (b === 'off') return 'off';
    const provider = read(PROVIDER_KEY);
    if ((provider === 'gemini' || provider === 'groq') && read(API_KEY)) return provider;
    return 'local';
  }
  /** which local model to load (persisted) */
  modelKey(): LocalModelKey {
    const k = read(MODEL_KEY_STORAGE) as LocalModelKey;
    return LOCAL_MODELS[k] ? k : DEFAULT_MODEL;
  }
  static setModelSetting(key: LocalModelKey) {
    try {
      localStorage.setItem(MODEL_KEY_STORAGE, key);
    } catch {
      /* ignore */
    }
  }
  /** switch the local model: drop the current worker and load the chosen one */
  restart() {
    this.stopLocal();
    this.state = 'idle';
    this.selfCheck = null;
    this.activeModel = null;
    this.failures = [];
    this.error = '';
    this.start();
  }
  static setBackendSetting(on: boolean) {
    try {
      localStorage.setItem(BACKEND_KEY, on ? 'auto' : 'off');
    } catch {
      /* ignore */
    }
  }

  onState(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  /** Start (or switch) the backend. Local model downloads in the background. */
  start() {
    const b = this.backend();
    if (b === 'off') {
      this.stopLocal();
      this.state = 'off';
      return this.emit();
    }
    if (b !== 'local') {
      this.stopLocal();
      this.state = 'ready';
      this.device = '';
      return this.emit();
    }
    if (this.worker && this.state === 'error') return this.restart(); // "확인" in settings = try again
    if (this.worker || this.state === 'loading') return;
    this.state = 'loading';
    this.failures = [];
    this.emit();
    void gpuInfo().then((gpu) => {
      this.ladder = loadLadder(this.modelKey(), gpu);
      if (!gpu.ok) this.failures.push('WebGPU 없음 — GPU 전용 모델은 건너뜀');
      this.spawnStep(0);
    });
  }

  /**
   * Try one step of the load ladder in a brand-new worker of the right kind. A failed
   * attempt's memory can't be handed back inside its worker, so every step starts fresh.
   */
  private spawnStep(i: number): void {
    this.worker?.terminate();
    this.worker = null;
    this.stepIndex = i;
    const step = this.ladder[i];
    if (!step) {
      this.state = 'error';
      this.error = this.failures.join('\n') || '불러올 수 있는 모델이 없어요';
      console.warn('[이야기꾼] 불러오기 실패', this.failures);
      return this.emit();
    }
    try {
      // literal `new URL(...)` per branch so Vite bundles both workers
      this.worker =
        LOCAL_MODELS[step.key].engine === 'webllm'
          ? new Worker(new URL('./webllmWorker.ts', import.meta.url), { type: 'module' })
          : new Worker(new URL('./llmWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      this.failures.push(`${stepLabel(step)}: 작업 공간을 만들지 못함 — ${String(e).slice(0, 100)}`);
      return this.spawnStep(i + 1);
    }
    this.worker.onmessage = (ev: MessageEvent<LlmOut>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      // a crash while loading (e.g. GPU device lost) = this step failed; after that = broken
      if (this.state === 'loading') this.stepFailed(`작업 공간이 멈춤 — ${ev.message || 'worker error'}`);
      else {
        this.state = 'error';
        this.error = ev.message || 'worker error';
        this.emit();
      }
    };
    this.state = 'loading';
    this.stage = stepLabel(step);
    this.progress = 0;
    this.emit();
    this.worker.postMessage({ type: 'init', step, last: i === this.ladder.length - 1 });
  }

  private stepFailed(why: string): void {
    const step = this.ladder[this.stepIndex];
    this.failures.push(`${step ? stepLabel(step) : '?'}: ${why}`);
    console.warn('[이야기꾼] 다음 방법으로', this.failures.at(-1));
    this.spawnStep(this.stepIndex + 1);
  }

  private stopLocal() {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.pending.clear();
  }

  private onMessage(m: LlmOut) {
    if (m.type === 'fail') return this.stepFailed(m.why);
    if (m.type === 'progress') {
      this.progress = m.total ? m.loaded / m.total : 0;
      this.stage = m.stage;
      return this.emit();
    }
    if (m.type === 'ready') {
      const step = this.ladder[this.stepIndex];
      this.state = 'ready';
      this.device = step.device;
      this.progress = 1;
      this.selfCheck = { ...m.selfCheck, fellBack: step.key !== this.modelKey() || this.stepIndex > 0 };
      this.activeModel = step.key;
      // the chosen model couldn't run in this browser: remember the one that did, so the next
      // start doesn't re-download gigabytes just to fail again (the choice can be changed in settings)
      if (step.key !== this.modelKey()) Storyteller.setModelSetting(step.key);
      console.info('[이야기꾼] 준비됨', { step: stepLabel(step), selfCheck: m.selfCheck, failures: this.failures, sec: Math.round(m.ms / 1000) });
      this.emit();
      return this.pump();
    }
    if (m.type === 'error') {
      if (m.id !== undefined) return this.finish(m.id, null, 0);
      return this.stepFailed(m.message);
    }
    if (m.type === 'result') this.finish(m.id, m.text, m.ms);
  }

  private finish(id: number, raw: string | null, ms: number) {
    const job = this.pending.get(id);
    this.pending.delete(id);
    this.busy = false;
    if (job) {
      this.keys.delete(job.key);
      const text = raw === null ? null : cleanOutput(raw, job.kind, job.draft, job.register, job.names);
      if (text) {
        this.stats.done++;
        this.stats.avgMs = this.stats.avgMs ? this.stats.avgMs * 0.8 + ms * 0.2 : ms;
        job.onDone(text);
      } else {
        this.stats.rejected++;
        job.onFail?.();
        if (raw !== null) {
          this.rejects.unshift({ draft: job.draft ?? '', raw: raw.trim().slice(0, 200) });
          this.rejects.length = Math.min(this.rejects.length, 8);
          console.debug('[이야기꾼] 거절:', { draft: job.draft, raw });
        }
      }
    }
    this.pump();
  }

  /** Queue a rewrite. Returns false if the storyteller is off or the job is a duplicate. */
  enqueue(job: StoryJob): boolean {
    if (this.state === 'off' || this.state === 'error' || this.keys.has(job.key)) return false;
    // keep the queue short: lines are only worth rewriting while they're on screen
    if (this.queue.length > 12) {
      this.queue.sort((a, b) => b.priority - a.priority);
      const dropped = this.queue.splice(12);
      for (const d of dropped) this.keys.delete(d.key), d.onFail?.();
      this.stats.dropped += dropped.length;
    }
    this.keys.add(job.key);
    this.queue.push({ ...job, at: performance.now() });
    this.pump();
    return true;
  }

  private pump() {
    if (this.busy || this.state !== 'ready') return;
    const now = performance.now();
    // discard stale jobs
    this.queue = this.queue.filter((j) => {
      const ok = now - j.at <= j.ttl;
      if (!ok) {
        this.keys.delete(j.key);
        this.stats.dropped++;
        j.onFail?.();
      }
      return ok;
    });
    if (!this.queue.length) return;
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    const job = this.queue.shift()!;
    const id = this.nextId++;
    this.pending.set(id, job);
    this.busy = true;
    const b = this.backend();
    if (b === 'local' && this.worker) {
      // a 0.5B model's Korean falls apart quickly at high temperature — keep it conservative
      this.worker.postMessage({ type: 'generate', id, messages: job.messages, maxTokens: job.maxTokens, temperature: job.kind === 'line' ? 0.4 : 0.55 });
    } else if (b === 'gemini' || b === 'groq') {
      const t0 = performance.now();
      this.cloud(b, job)
        .then((text) => this.finish(id, text, performance.now() - t0))
        .catch(() => this.finish(id, null, 0));
    } else this.finish(id, null, 0);
  }

  private async cloud(b: 'gemini' | 'groq', job: StoryJob): Promise<string> {
    const key = read(API_KEY);
    const sys = job.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = job.messages.filter((m) => m.role !== 'system');
    if (b === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: user.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { temperature: 0.8, maxOutputTokens: job.maxTokens * 2, thinkingConfig: { thinkingBudget: 0 } },
        }),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}`);
      const j = await res.json();
      return j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    }
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: job.messages, temperature: 0.8, max_tokens: job.maxTokens * 2 }),
    });
    if (!res.ok) throw new Error(`groq ${res.status}`);
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Spare capacity (0..1): how large a share of ordinary lines to send right now. Measured, not
   * guessed — a fast GPU drains the queue and gets ~everything, a slow one backs up and is
   * asked only for what matters (long talks and the selected Will are always sent).
   */
  capacity(): number {
    if (this.state !== 'ready' || this.backend() === 'off') return 0;
    const q = this.queue.length + (this.busy ? 1 : 0);
    const c = q <= 1 ? 1 : q <= 3 ? 0.6 : q <= 6 ? 0.3 : 0.1;
    // free API tiers allow only a handful of requests a minute
    return this.backend() === 'local' ? c : Math.min(c, 0.35);
  }

  get queued() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  label(): string {
    const b = this.backend();
    if (b === 'off' || this.state === 'off') return '꺼짐';
    if (b === 'gemini') return 'Gemini';
    if (b === 'groq') return 'Groq';
    if (this.state === 'loading') return `${this.stage || LOCAL_MODELS[this.modelKey()].label} 불러오는 중 ${Math.round(this.progress * 100)}%`;
    if (this.state === 'ready') {
      const name = LOCAL_MODELS[this.activeModel ?? this.modelKey()].label.split(' (')[0];
      const dev = this.device === 'webgpu' ? 'GPU' : 'CPU';
      return `${name} 준비됨 (${dev}${this.selfCheck?.fellBack ? ' · 대체' : ''})${this.selfCheck && !this.selfCheck.ok ? ' ⚠ 시험 문장 실패' : ''}`;
    }
    if (this.state === 'error') return '실패 → 템플릿만 (마우스를 올리면 이유)';
    return '대기';
  }
}

export const storyteller = new Storyteller();
