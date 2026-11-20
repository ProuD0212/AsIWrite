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
import { cleanOutput, stripThinking, type Register } from './validate';
import { cloudComplete, cloudModelName, usageToday } from './cloud';
import { hostStatus, onHostStatus, relayJob, hostAIMode, watchHost } from './remote';
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

/** host = playing from another PC: the server PC's model does the work (ai/remote.ts) */
export type StoryBackend = 'local' | 'gemini' | 'groq' | 'host' | 'off';
export type StoryState = 'off' | 'idle' | 'loading' | 'ready' | 'error';
type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export interface StoryJob {
  key: string; // dedupe key
  /** command = sentence → JSON (validated by the caller, not as Korean prose) */
  kind: 'line' | 'monologue' | 'bio' | 'rumor' | 'command' | 'relay';
  /** override the default sampling temperature */
  temperature?: number;
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
  private hostWatch = false;
  /** the last cloud API error (shown in the label) */
  cloudError = '';

  /** run a prompt and hand back the model's raw text (for other PCs' jobs; they validate it themselves) */
  generateRaw(messages: ChatMsg[], maxTokens: number, temperature: number): Promise<string | null> {
    return new Promise((resolve) => {
      const ok = this.enqueue({ key: `relay:${this.nextId}:${Math.random()}`, kind: 'relay', messages, maxTokens, temperature, ttl: 60000, priority: 9, onDone: (t) => resolve(t), onFail: () => resolve(null) });
      if (!ok) resolve(null);
    });
  }

  backend(): StoryBackend {
    const b = read(BACKEND_KEY) as StoryBackend;
    if (b === 'off') return 'off';
    if (hostAIMode()) return 'host';
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
  /** how hard the local model may push the GPU: 절약 30% · 보통 55% · 최대 100% (rest is spread between tokens and jobs) */
  static readonly LOAD_KEY = 'asiwrite.aiLoad';
  static loadSetting(): 'eco' | 'balanced' | 'max' {
    try {
      const v = localStorage.getItem(Storyteller.LOAD_KEY);
      return v === 'eco' || v === 'max' ? v : 'balanced';
    } catch {
      return 'balanced';
    }
  }
  static setLoadSetting(v: 'eco' | 'balanced' | 'max') {
    try {
      localStorage.setItem(Storyteller.LOAD_KEY, v);
    } catch {
      /* ignore */
    }
  }
  private duty() {
    return { eco: 0.3, balanced: 0.55, max: 1 }[Storyteller.loadSetting()];
  }
  /** a pause between jobs, so back-to-back lines don't fuse into one long peak */
  private restUntil = 0;
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
      if (b === 'host' && !this.hostWatch) {
        this.hostWatch = true;
        watchHost();
        onHostStatus(() => this.emit());
      }
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
      this.error =
        (this.failures.join('\n') || '불러올 수 있는 모델이 없어요') +
        (this.failures.some((x) => /WebGPU 없음/.test(x)) ? '\n→ 이 브라우저는 GPU(WebGPU)를 못 써서 내장 모델이 안 돌아가요. 설정에서 Gemini/Groq API 키를 넣으면 돼요(무료 등급 있음).' : '');
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
    if (m.type === 'result') this.finish(m.id, m.text, m.ms, m.prefillMs);
  }

  private finish(id: number, raw: string | null, ms: number, prefillMs = 0) {
    const job = this.pending.get(id);
    this.pending.delete(id);
    this.busy = false;
    // prefill is a burst no streaming can soften: leave a gap after each job (none at 최대)
    const d = this.duty();
    // the prompt-reading burst ran at 100% — rest it off at the chosen share before the next job,
    // so the GPU graph is a steady plateau instead of spikes (token sleeps already cover the writing)
    const burst = prefillMs || ms * 0.15;
    this.restUntil = performance.now() + (d >= 1 ? 0 : Math.min(4000, Math.max(120, burst) * ((1 - d) / d) + 80));
    if (job) {
      this.keys.delete(job.key);
      const text = raw === null ? null : job.kind === 'command' || job.kind === 'relay' ? stripThinking(raw) || null : cleanOutput(raw, job.kind, job.draft, job.register, job.names);
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
    const cloudB = this.backend();
    if (cloudB === 'gemini' || cloudB === 'groq') return this.pumpCloud(cloudB);
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
      // other PCs' jobs (relay) and command reading run at full speed with no rest before them
      const urgent = job.kind === 'command' || job.kind === 'relay';
      this.worker.postMessage({ type: 'generate', id, messages: job.messages, maxTokens: job.maxTokens, temperature: job.temperature ?? (job.kind === 'command' ? 0.1 : job.kind === 'line' ? 0.4 : 0.55), duty: urgent ? 1 : this.duty(), restMs: urgent ? 0 : Math.max(0, this.restUntil - performance.now()) });
    } else if (b === 'host') {
      const t0 = performance.now();
      relayJob<{ text: string | null }>('gen', { messages: job.messages, maxTokens: job.maxTokens, temperature: job.temperature ?? (job.kind === 'command' ? 0.1 : job.kind === 'line' ? 0.4 : 0.55) }).then((r) => this.finish(id, r?.text ?? null, performance.now() - t0));
    } else if (b === 'gemini' || b === 'groq') {
      const t0 = performance.now();
      this.cloud(b, job)
        .then((text) => {
          this.cloudError = '';
          this.finish(id, text, performance.now() - t0);
        })
        .catch((e) => {
          this.cloudError = String((e as Error)?.message ?? e).slice(0, 60);
          this.emit();
          this.finish(id, null, 0);
        });
    } else this.finish(id, null, 0);
  }

  // ───── cloud APIs: several lines per request, two requests at a time, within the free-tier rate ─────
  private cloudInflight = 0;
  private cloudSent: number[] = [];
  private cloudPauseUntil = 0;
  /**
   * Requests per minute we allow ourselves. Free tiers limit requests AND tokens per minute (Groq's token
   * budget is the tight one: a batch of 8 lines is ~3k tokens), so start modest and adapt: a 429 cuts the
   * pace, a run of successes slowly raises it again.
   */
  // Gemini starts at 6/min: with 8 lines per request that still covers a busy town, and the daily quota lasts about twice as long
  private cloudPace: Record<'gemini' | 'groq', number> = { gemini: 6, groq: 6 };
  private cloudOk = 0;
  private cloudRpm(b: 'gemini' | 'groq') {
    return this.cloudPace[b];
  }
  private pumpCloud(b: 'gemini' | 'groq') {
    if (this.state !== 'ready') return;
    const now = performance.now();
    this.queue = this.queue.filter((j) => {
      const ok = now - j.at <= j.ttl;
      if (!ok) {
        this.keys.delete(j.key);
        this.stats.dropped++;
        j.onFail?.();
      }
      return ok;
    });
    this.cloudSent = this.cloudSent.filter((t) => now - t < 60000);
    while (this.queue.length && this.cloudInflight < 2) {
      if (now < this.cloudPauseUntil || this.cloudSent.length >= this.cloudRpm(b)) {
        // out of budget for now: try again when the oldest request leaves the one-minute window
        const wait = Math.max(this.cloudPauseUntil - now, this.cloudSent.length ? 60000 - (now - this.cloudSent[0]) : 0, 200);
        setTimeout(() => this.pump(), Math.min(wait + 20, 15000));
        return;
      }
      this.queue.sort((x, y) => y.priority - x.priority || x.at - y.at);
      // a lone fresh line: wait half a second for company (one request for several lines)
      const top = this.queue[0];
      if (top.kind === 'line' && this.queue.filter((j) => j.kind === 'line').length < 3 && now - top.at < 500) {
        setTimeout(() => this.pump(), 520 - (now - top.at));
        return;
      }
      const first = this.queue.shift()!;
      // ordinary lines travel together (up to 8 per request) — far more lines fit in the rate limit
      const batch = [first];
      if (first.kind === 'line') {
        for (let i = 0; i < this.queue.length && batch.length < 8; ) {
          if (this.queue[i].kind === 'line') batch.push(...this.queue.splice(i, 1));
          else i++;
        }
      }
      const ids = batch.map((job) => {
        const id = this.nextId++;
        this.pending.set(id, job);
        return id;
      });
      this.cloudSent.push(now);
      this.cloudInflight++;
      const t0 = performance.now();
      const run = batch.length > 1 ? this.cloudBatch(b, batch) : this.cloud(b, first).then((t) => [t]);
      run
        .then((texts) => {
          this.cloudError = '';
          if (++this.cloudOk % 15 === 0) this.cloudPace[b] = Math.min(b === 'gemini' ? 10 : 12, this.cloudPace[b] + 1);
          ids.forEach((id, i) => this.finish(id, texts[i] ?? null, performance.now() - t0));
        })
        .catch((e) => {
          const msg = String((e as Error)?.message ?? e);
          this.cloudError = msg.slice(0, 60);
          if (/429 daily/.test(msg)) {
            // today's quota for that model is gone: the next model (own quota) after a breath, or a long rest if none is left
            const all = /daily-all/.test(msg);
            this.cloudPauseUntil = performance.now() + (all ? 30 * 60000 : 3000);
            this.cloudError = all ? '오늘 무료 한도를 다 썼어요 — 기본 문장·📚 배운 문장으로 계속해요' : `하루 한도 → ${msg.split('→ ')[1] ?? '다른 모델'}로 바꿈`;
          } else if (/429/.test(msg)) {
            // rate limited: slow down and wait as long as the server asks (default 15 s)
            const ra = parseFloat(msg.match(/retry=([d.]+)/)?.[1] ?? '15');
            this.cloudPauseUntil = performance.now() + Math.min(60, Math.max(3, ra)) * 1000;
            this.cloudPace[b] = Math.max(2, Math.floor(this.cloudPace[b] * 0.6));
            this.cloudOk = 0;
          }
          this.emit();
          for (const id of ids) this.finish(id, null, 0);
        })
        .finally(() => {
          this.cloudInflight--;
          this.pump();
        });
    }
  }
  /** one request that rewrites several lines; the answer is a JSON array in the same order */
  private async cloudBatch(b: 'gemini' | 'groq', jobs: StoryJob[]): Promise<(string | null)[]> {
    const sys = jobs[0].messages.find((m) => m.role === 'system')?.content ?? '';
    const blocks = jobs.map((j, i) => {
      const user = [...j.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      return `[${i + 1}]\n${user.replace(/다듬은 대사:\s*$/, '').trim()}`;
    });
    const messages: ChatMsg[] = [
      { role: 'system', content: `${sys}\n\n여러 개의 대사를 한 번에 다듬는다. [1], [2] … 블록마다 위 규칙대로 대사 한 줄씩 다듬고, 다른 말 없이 JSON 문자열 배열 하나만 출력한다. 예: ["1번 대사", "2번 대사"]. 블록 수와 순서를 지킨다.` },
      { role: 'user', content: blocks.join('\n\n') },
    ];
    const raw = await cloudComplete(b, read(API_KEY), messages, 70 * jobs.length, 0.7);
    const s = raw.replace(/```(?:json)?/g, '');
    const a = s.indexOf('['), z = s.lastIndexOf(']');
    let arr: unknown = null;
    if (a >= 0 && z > a) {
      try {
        arr = JSON.parse(s.slice(a, z + 1));
      } catch {
        arr = null;
      }
    }
    if (Array.isArray(arr)) return jobs.map((_, i) => (typeof arr[i] === 'string' ? (arr[i] as string) : null));
    // not JSON: "1. …" lines
    const lines = s.split(/\n+/).map((l) => l.replace(/^\s*\[?\d+[\].)]\s*/, '').trim()).filter(Boolean);
    return jobs.map((_, i) => lines[i] ?? null);
  }

  private async cloud(b: 'gemini' | 'groq', job: StoryJob): Promise<string> {
    // the model is discovered from the key (a hard-coded, retired model name answered 404)
    return cloudComplete(b, read(API_KEY), job.messages, job.maxTokens, job.temperature ?? (job.kind === 'command' ? 0.1 : 0.8));
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
    if (this.backend() === 'host') return hostStatus.story ? c * 0.8 : 0; // shared with the server PC and other visitors
    if (this.backend() === 'local') return c;
    // cloud: lines go 8 to a request, so a fairly long queue is still fine; back off while rate-limited
    if (performance.now() < this.cloudPauseUntil) return 0.15;
    const cq = this.queue.length;
    return cq <= 10 ? 1 : cq <= 20 ? 0.6 : 0.3;
  }

  get queued() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  label(): string {
    const b = this.backend();
    if (b === 'off' || this.state === 'off') return '꺼짐';
    if (b === 'gemini' || b === 'groq') {
      const m = cloudModelName(b, read(API_KEY));
      return `${b === 'gemini' ? 'Gemini' : 'Groq'}${m ? ` (${m})` : ''} · 오늘 요청 ${usageToday()}회${this.cloudError ? ` ⚠ ${this.cloudError}` : ''}`;
    }
    if (b === 'host') return hostStatus.story ? `서버 PC의 AI — ${hostStatus.label || '준비됨'}${hostStatus.hidden ? ' · 서버 PC 탭이 뒤에 있음' : ''}` : hostStatus.known ? '서버 PC의 AI 대기 중 (서버 PC 게임 탭에서 이야기꾼을 켜 주세요)' : '서버 PC에 연결하는 중…';
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
