// Messages between the storyteller (main thread) and its model workers
// (llmWorker = transformers.js, webllmWorker = WebLLM). Both speak the same protocol.

import type { LoadStep } from './models';

export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export type LlmIn =
  /** load exactly this step of the ladder; `last` = no further fallback, so accept a shaky self-check */
  | { type: 'init'; step: LoadStep; last: boolean }
  | { type: 'generate'; id: number; messages: ChatMsg[]; maxTokens: number; temperature: number; /** share of time the GPU may work (0.2–1): the rest is rest between tokens */ duty?: number; /** rest this long (ms) inside the worker before starting — worker timers aren't throttled in background tabs */ restMs?: number };

export type LlmOut =
  | { type: 'progress'; loaded: number; total: number; stage: string }
  | { type: 'ready'; ms: number; selfCheck: { ok: boolean; sample: string } }
  /** this step can't run here — the main thread moves on to the next step in a fresh worker */
  | { type: 'fail'; why: string }
  | { type: 'error'; message: string; id?: number }
  | { type: 'result'; id: number; text: string; ms: number; tokens: number; /** time spent reading the prompt before the first token (a burst at full GPU) */ prefillMs?: number };
