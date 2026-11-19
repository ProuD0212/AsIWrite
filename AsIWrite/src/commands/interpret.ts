// Natural language → GameCommand, in three tiers:
//   1. rules        — the deterministic Korean parser (fast, precise)
//   2. embeddings   — nearest intent by meaning (MiniLM), slots filled by rules
//   3. suggestion   — "혹시 이런 뜻인가요?" the closest known sentence (works even without the model)
// No LLM is used for control.

import { embeddings } from '../ai/embeddings';
import { semanticCalib } from '../engine/semantic';
import type { World } from '../engine/World';
import { buildFromIntent, INTENT_ANCHORS, type IntentId } from './intents';
import { COMMAND_EXAMPLES, parseCommand } from './ruleParser';
import type { GameCommand } from './schema';
import { suggest } from './suggest';

export interface Interpretation {
  cmd: GameCommand | null;
  source: 'rule' | 'embedding' | 'none';
  intent?: IntentId;
  confidence?: number; // calibrated 0..1
  suggestion?: string;
}

const calibrate = (c: number) => Math.max(0, Math.min(1, (c - semanticCalib.lo) / (semanticCalib.hi - semanticCalib.lo)));

export async function interpret(text: string, selectedId: string | null, world?: World): Promise<Interpretation> {
  const cmd = parseCommand(text, selectedId);
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

  // tier 3: closest known sentence (context-aware suggestions first). Compare the
  // *content* only — shared endings like "~게 해 줘" must not make sentences look alike.
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
  return { cmd: null, source: 'none', suggestion: bestV >= 0.35 ? bestS : undefined };
}

export const INTENT_LABEL: Record<IntentId, string> = {
  spawn_person: '윌 소환', spawn_animal: '동물 소환', spawn_place: '건물 배치', weather_rain: '비', weather_snow: '눈', weather_storm: '폭풍',
  weather_clear: '맑음', world: '세계관 변경', meet: '만남', lightning: '번개', bless: '축복', gift: '선물', delete: '지우기', rumor: '소문',
  expand: '세계 넓히기', slow: '느리게', fast: '빠르게', pause: '일시정지', resume: '재개', save: '저장', help: '도움말', follow: '따라가기',
};
