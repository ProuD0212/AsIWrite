// Natural language → GameCommand, in four tiers:
//   1. rules        — the deterministic Korean parser (fast, precise; compositional for map sentences)
//   2. embeddings   — nearest intent by meaning (ko-sroberta), slots filled by rules
//   3. LLM          — the storyteller model translates the sentence to JSON; validated before use
//   4. suggestion   — "혹시 이런 뜻인가요?" the closest known sentence (works even without any model)

import { embeddings } from '../ai/embeddings';
import { semanticCalib } from '../engine/semantic';
import type { World } from '../engine/World';
import { buildFromIntent, INTENT_ANCHORS, type IntentId } from './intents';
import { COMMAND_EXAMPLES, parseCommand } from './ruleParser';
import type { GameCommand } from './schema';
import { suggest } from './suggest';
import { llmAvailable, llmInterpret } from '../ai/commandLLM';

export interface Interpretation {
  cmd: GameCommand | null;
  source: 'rule' | 'embedding' | 'llm' | 'none';
  intent?: IntentId;
  confidence?: number; // calibrated 0..1
  suggestion?: string;
}

/** the generic spawn fallback: nothing recognised but the verb */
function weakRule(c: GameCommand): boolean {
  if (c.type !== 'SPAWN_ENTITY' || c.entity.kind !== 'person') return false;
  const e = c.entity;
  if (e.traits?.length || e.job || e.name || e.sheet) return false;
  const look = e.appearance ?? '';
  // nothing says it's a person at all ("뭔가 근사한 걸 만들어 봐"), or a long phrase swallowed whole
  return look.length > 8 || (look.length > 0 && !/(윌|사람|주민|캐릭터|남자|여자|아이|소년|소녀|할머니|할아버지|친구|청년|아저씨|아줌마|언니|오빠|형|누나)/.test(look));
}

const calibrate = (c: number) => Math.max(0, Math.min(1, (c - semanticCalib.lo) / (semanticCalib.hi - semanticCalib.lo)));

export async function interpret(text: string, selectedId: string | null, world?: World, onThinking?: () => void): Promise<Interpretation> {
  const cmd = parseCommand(text, selectedId);
  // a rule hit that only matched the ending ("…만들어 줘" → a Will whose look is the whole sentence)
  // is a guess: let the model read it first and keep the guess as the fallback
  if (cmd && world && weakRule(cmd) && llmAvailable()) {
    onThinking?.();
    const c = await llmInterpret(text, world, selectedId);
    if (c) return { cmd: c, source: 'llm' };
    // the model didn't see a command either: offer the closest known sentence instead of guessing
    return { cmd: null, source: 'none', suggestion: closest(text, selectedId, world) };
  }
  if (cmd) return { cmd, source: 'rule' };
  if (!world) return { cmd: null, source: 'none' };

  // tier 2: meaning-based intent
  if (embeddings.state === 'ready') {
    const v = await embeddings.embedNow(text, 3000);
    if (v) {
      let best: { intent: IntentId; score: number } | null = null;
      for (const [intent, anchors] of Object.entries(INTENT_ANCHORS) as [IntentId, string[]][]) {
        for (const a of anchors) {
          const c = embeddings.cosineVec(v, a);
          if (c !== null && (!best || c > best.score)) best = { intent, score: c };
        }
      }
      if (best) {
        const confidence = calibrate(best.score);
        if (confidence >= 0.55) {
          const built = buildFromIntent(best.intent, text, world, selectedId);
          if (built) return { cmd: built, source: 'embedding', intent: best.intent, confidence };
        }
      }
    }
  }

  // tier 3: the language model reads it (only if one is loaded; output is validated)
  if (llmAvailable()) {
    onThinking?.();
    const c = await llmInterpret(text, world, selectedId);
    if (c) return { cmd: c, source: 'llm' };
  }

  // tier 4: closest known sentence
  return { cmd: null, source: 'none', suggestion: closest(text, selectedId, world) };
}

/** the closest known sentence (context-aware suggestions first). Compares the *content* only —
 * shared endings like "~게 해 줘" must not make sentences look alike. */
function closest(text: string, selectedId: string | null, world: World): string | undefined {
  const core = (s: string) => s.replace(/(좀|한번|해\s*줘|해\s*주세요|줘|봐|주세요|하게|되게|게|해)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const names = [...world.agents, ...world.places].map((e) => e.name).filter((n) => text.includes(n) || (n.length === 3 && text.includes(n.slice(1))));
  const candidates = [...suggest(world, selectedId, 8).items.map((s) => s.text), ...COMMAND_EXAMPLES];
  let bestS = '', bestV = 0;
  for (const c of candidates) {
    let v = world.matcher.similarity(core(text), core(c));
    if (names.length && names.some((n) => c.includes(n))) v += 0.25; // same person/place mentioned
    if (names.length && !names.some((n) => c.includes(n)) && /[가-힣]{2,}(에게|를|을|와|과)/.test(c)) v -= 0.1;
    if (v > bestV) (bestV = v), (bestS = c);
  }
  return bestV >= 0.35 ? bestS : undefined;
}

/** a short "what I understood" label for any command (shown when a model did the reading) */
export function describeCommand(c: GameCommand): string {
  switch (c.type) {
    case 'SPAWN_ENTITY':
      return c.entity.kind === 'place' ? '건물 짓기' : c.entity.kind === 'animal' ? '동물 부르기' : '윌 부르기';
    case 'MODIFY_ENTITY':
      return `${c.target.name ?? '선택한 대상'} 고치기`;
    case 'DELETE_ENTITY':
      return `${c.target.name ?? '선택한 대상'} 지우기`;
    case 'SET_WORLD_CONTEXT':
      return '세계관 바꾸기';
    case 'SET_WEATHER':
      return { clear: '맑게', rain: '비', snow: '눈', storm: '폭풍' }[c.weather];
    case 'SPREAD_RUMOR':
      return '소문 퍼뜨리기';
    case 'TRIGGER_EVENT':
      return { MEET: '두 윌 만나게 하기', BLESS: '축복', GIFT: '선물', LIGHTNING: '번개' }[c.event];
    case 'WORLD_EVENT':
      return '사건 일으키기';
    case 'TALK':
      return `${c.target.name ?? '윌'}에게 말 걸기`;
    case 'PAINT_MAP':
      return '맵 꾸미기';
    case 'RESIZE_MAP':
      return '맵 크기 바꾸기';
    case 'RENAME_WORLD':
      return '세계 이름 짓기';
    case 'GROUP':
      return '그룹';
    case 'SYSTEM':
      return '조작';
  }
}

export const INTENT_LABEL: Record<IntentId, string> = {
  spawn_person: '윌 소환', spawn_animal: '동물 소환', spawn_place: '건물 배치', weather_rain: '비', weather_snow: '눈', weather_storm: '폭풍',
  weather_clear: '맑음', world: '세계관 변경', meet: '만남', lightning: '번개', bless: '축복', gift: '선물', delete: '지우기', rumor: '소문',
  expand: '세계 넓히기', slow: '느리게', fast: '빠르게', pause: '일시정지', resume: '재개', save: '저장', help: '도움말', follow: '따라가기', world_event: '사건',
};
