// Optional cloud backends (the player's own API key). Model names change over time, so instead of
// hard-coding one (a retired name answers 404), ask the API which models this key can use and pick
// a fast, cheap one. The choice is remembered per key; a 404/400 forgets it and picks again.

import type { ChatMsg } from './protocol';

type Provider = 'gemini' | 'groq';
// v2: re-pick (v1 could land on a reasoning model with a tiny free token budget)
const CHOICE_KEY = 'asiwrite.cloudModel.v2';
const memo = new Map<string, string>();

function load(provider: Provider, key: string): string | undefined {
  const k = `${provider}:${key.slice(-6)}`;
  if (memo.has(k)) return memo.get(k);
  try {
    const all = JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}') as Record<string, string>;
    return all[k];
  } catch {
    return undefined;
  }
}
function save(provider: Provider, key: string, model: string | undefined) {
  const k = `${provider}:${key.slice(-6)}`;
  if (model) memo.set(k, model);
  else memo.delete(k);
  try {
    const all = JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}') as Record<string, string>;
    if (model) all[k] = model;
    else delete all[k];
    localStorage.setItem(CHOICE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** rank: small/fast first ("flash-lite" < "flash" < others), newest version first, no previews/experiments if possible */
function rankGemini(names: string[]): string[] {
  const score = (n: string) => {
    const v = parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0');
    return (/flash-lite/.test(n) ? 0 : /flash/.test(n) ? 1 : 3) * 100 - v * 10 + (/(preview|exp|thinking|tts|image|live|audio|embedding)/.test(n) ? 50 : 0);
  };
  return names.filter((n) => /gemini/.test(n) && !/(embedding|tts|image-generation|aqa)/.test(n)).sort((a, b) => score(a) - score(b));
}
/** Groq: good Korean and a big free token budget first (Llama 4 Scout ~30k tokens/min); reasoning models last */
function rankGroq(names: string[]): string[] {
  const score = (n: string) =>
    /(whisper|guard|tts|playai|prompt-guard|compound|saba)/.test(n) ? 999 : /llama-4-scout/.test(n) ? 0 : /llama-4-maverick/.test(n) ? 1 : /llama-3.3-70b/.test(n) ? 2 : /kimi|qwen3/.test(n) ? 3 : /8b-instant/.test(n) ? 4 : /gpt-oss/.test(n) ? 8 : 6;
  return names.filter((n) => score(n) < 999).sort((a, b) => score(a) - score(b));
}

export async function listModels(provider: Provider, key: string): Promise<string[]> {
  if (provider === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    if (!r.ok) throw new Error(`gemini models ${r.status}`);
    const j = await r.json();
    const names = (j.models ?? []).filter((m: { supportedGenerationMethods?: string[] }) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m: { name: string }) => m.name.replace(/^models\//, ''));
    return rankGemini(names);
  }
  const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`groq models ${r.status}`);
  const j = await r.json();
  return rankGroq((j.data ?? []).filter((m: { active?: boolean }) => m.active !== false).map((m: { id: string }) => m.id));
}

async function pickModel(provider: Provider, key: string): Promise<string> {
  const known = load(provider, key);
  if (known) return known;
  const list = await listModels(provider, key);
  if (!list.length) throw new Error(`${provider}: 이 키로 쓸 수 있는 모델이 없어요`);
  save(provider, key, list[0]);
  return list[0];
}

async function callOnce(provider: Provider, key: string, model: string, messages: ChatMsg[], maxTokens: number, temperature: number): Promise<Response> {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  if (provider === 'gemini')
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
        contents: rest.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature, maxOutputTokens: Math.max(64, maxTokens * 2) },
      }),
    });
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: Math.max(64, maxTokens * 2) }),
  });
}

/** models whose daily free quota ran out this session */
const exhausted = new Set<string>();

/** requests sent today (shown in the settings / HUD so the daily quota isn't a surprise) */
const USAGE_KEY = 'asiwrite.cloudUsage';
export function usageToday(): number {
  try {
    const u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') as { d?: string; n?: number };
    return u.d === new Date().toDateString() ? (u.n ?? 0) : 0;
  } catch {
    return 0;
  }
}
function countRequest() {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify({ d: new Date().toDateString(), n: usageToday() + 1 }));
  } catch {
    /* ignore */
  }
}

/** one completion; on "model not found / not supported" it re-picks a model once */
export async function cloudComplete(provider: Provider, key: string, messages: ChatMsg[], maxTokens: number, temperature: number): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const model = await pickModel(provider, key);
    const res = await callOnce(provider, key, model, messages, maxTokens, temperature);
    countRequest();
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      const text = await res.clone().text().catch(() => '');
      // the DAILY quota is used up for this model (not just a busy minute): every model has its own
      // daily quota, so move on to the next one; when none is left, say so
      if (/(per ?day|PerDay|daily)/i.test(text)) {
        exhausted.add(`${provider}:${model}`);
        const next = (await listModels(provider, key).catch(() => [] as string[])).find((m) => !exhausted.has(`${provider}:${m}`));
        save(provider, key, next);
        throw new Error(next ? `${provider} 429 daily → ${next}` : `${provider} 429 daily-all`);
      }
      throw new Error(`${provider} 429${ra ? ` retry=${ra}` : ''}`);
    }
    // only a missing/retired model is a reason to switch models (a 400 can also be a bad key or a too-long request)
    const body = res.ok ? '' : await res.clone().text().catch(() => '');
    if (res.status === 404 || (res.status === 400 && /model/i.test(body) && /(not found|decommission|does not exist|not supported|unavailable|deprecated)/i.test(body))) {
      save(provider, key, undefined); // retired or unsupported: choose again
      if (attempt === 0) {
        const list = await listModels(provider, key);
        const next = list.find((m) => m !== model);
        if (next) save(provider, key, next);
        continue;
      }
    }
    if (!res.ok) throw new Error(`${provider} ${res.status}${body ? ' ' + (body.match(/"message"s*:s*"([^"]{0,80})/)?.[1] ?? '') : ''}`);
    const j = await res.json();
    if (provider === 'gemini') return j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    return j?.choices?.[0]?.message?.content ?? '';
  }
  throw new Error(`${provider}: 모델을 찾지 못했어요`);
}

/** the model in use for this key (for the settings screen) */
export function cloudModelName(provider: Provider, key: string) {
  return load(provider, key);
}
