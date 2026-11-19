// "AI 이야기꾼" — Layer-2 generative rewriting.
//
// The simulation always speaks instantly with templates (Layer 1). Some of those
// lines (and long monologues, bios) are queued here and rewritten by a
// generative model with the character's sheet, mood, relationship and situation
// as context. When the rewrite comes back and passes validation, it replaces
// the template text in the speech bubble / story log. If anything fails, the
// template simply stays — the game never waits for the model.
//
// Backends: local Qwen2.5-0.5B in a Web Worker (no key, default) · Gemini · Groq.

import type { LlmOut } from './llmWorker';

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
  onDone: (text: string) => void;
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

/** Reject anything that isn't clean Korean prose of a sensible length. */
export function cleanOutput(raw: string, kind: StoryJob['kind']): string | null {
  let t = raw.trim();
  t = t.replace(/^(대사|답변|출력|수정된 대사|다듬은 대사|소개)\s*[:：]\s*/u, '');
  t = t.replace(/^[A-Za-z가-힣]{1,6}\s*[:：]\s*/u, (m) => (/[가-힣]/.test(m) && m.length <= 6 ? '' : m)); // "민수: …"
  t = t.replace(/^["“'「『]+|["”'」』]+$/gu, '').trim();
  if (kind === 'line') t = t.split('\n')[0].trim();
  else t = t.replace(/\n{2,}/g, '\n').trim();
  if (/[一-鿿぀-ヿ]/.test(t)) return null; // Chinese/Japanese leakage
  const hangul = (t.match(/[가-힣]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  if (hangul < 4 || latin > hangul * 0.2) return null;
  const max = kind === 'line' ? 90 : kind === 'rumor' ? 70 : 420;
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf('…'), cut.lastIndexOf('요'));
    if (end < max * 0.5) return null;
    t = cut.slice(0, end + 1);
  }
  return t;
}

export class Storyteller {
  state: StoryState = 'idle';
  progress = 0;
  error = '';
  device: 'webgpu' | 'wasm' | '' = '';
  stats = { done: 0, rejected: 0, dropped: 0, avgMs: 0 };

  private worker: Worker | null = null;
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
    if (this.worker) return;
    try {
      this.worker = new Worker(new URL('./llmWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      this.state = 'error';
      this.error = String(e);
      return this.emit();
    }
    this.worker.onmessage = (ev: MessageEvent<LlmOut>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.state = 'error';
      this.error = ev.message || 'worker error';
      this.emit();
    };
    this.state = 'loading';
    this.emit();
    this.worker.postMessage({ type: 'init' });
  }

  private stopLocal() {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.pending.clear();
  }

  private onMessage(m: LlmOut) {
    if (m.type === 'progress') {
      this.progress = m.total ? m.loaded / m.total : 0;
      return this.emit();
    }
    if (m.type === 'ready') {
      this.state = 'ready';
      this.device = m.device;
      this.progress = 1;
      this.emit();
      return this.pump();
    }
    if (m.type === 'error') {
      if (m.id !== undefined) {
        this.finish(m.id, null, 0);
        return;
      }
      this.state = 'error';
      this.error = m.message;
      return this.emit();
    }
    if (m.type === 'result') this.finish(m.id, m.text, m.ms);
  }

  private finish(id: number, raw: string | null, ms: number) {
    const job = this.pending.get(id);
    this.pending.delete(id);
    this.busy = false;
    if (job) {
      this.keys.delete(job.key);
      const text = raw === null ? null : cleanOutput(raw, job.kind);
      if (text) {
        this.stats.done++;
        this.stats.avgMs = this.stats.avgMs ? this.stats.avgMs * 0.8 + ms * 0.2 : ms;
        job.onDone(text);
      } else this.stats.rejected++;
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
      for (const d of dropped) this.keys.delete(d.key);
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
      this.worker.postMessage({ type: 'generate', id, messages: job.messages, maxTokens: job.maxTokens, temperature: 0.8 });
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

  get queued() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  label(): string {
    const b = this.backend();
    if (b === 'off' || this.state === 'off') return '꺼짐';
    if (b === 'gemini') return 'Gemini';
    if (b === 'groq') return 'Groq';
    if (this.state === 'loading') return `내려받는 중 ${Math.round(this.progress * 100)}%`;
    if (this.state === 'ready') return `준비됨 (${this.device === 'webgpu' ? 'GPU' : 'CPU'})`;
    if (this.state === 'error') return '실패 → 템플릿만';
    return '대기';
  }
}

export const storyteller = new Storyteller();
