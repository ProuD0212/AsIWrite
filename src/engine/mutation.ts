import { worldTheme } from './worldTheme';
// Reactive tag mutation (spec §3.3).
//
// When the world context shifts or a high-impact being appears nearby, a Will
// rewrites one related trait to fit the new reality and gains one reactive
// trait. Rule-based (instant, zero-model); the storyteller may polish the
// wording afterwards. Processing is LAZY: queued per Will and done only for
// Wills inside the camera view, ~1–2 per second (see World.processMutations).

import { extractObject, josa, traitPolarity } from './traits';
import type { Agent } from './types';
import { pick } from './util';
import { poolFor, randomTraits } from '../presets/traitPools';

export type MutationReason =
  | { kind: 'context'; from: string; to: string }
  /** slow drift from lived experience (no environmental change needed) */
  | { kind: 'drift'; source: 'friend' | 'place' | 'experience' | 'heal' | 'group'; text: string; replaces?: string; note: string }
  | { kind: 'impact'; byId: string; byName: string; what: 'dragon' | 'celebrity' | 'monster' | 'ghost' | 'alien' };

export const IMPACT_RE: [RegExp, Extract<MutationReason, { kind: 'impact' }>['what']][] = [
  [/(용|드래곤|dragon)/i, 'dragon'],
  [/(연예인|아이돌|유명인|스타|가수|배우|celebrity)/i, 'celebrity'],
  [/(괴물|몬스터|좀비|monster)/i, 'monster'],
  [/(유령|귀신|ghost)/i, 'ghost'],
  [/(외계인|우주인|alien|UFO)/i, 'alien'],
];

function theme(ctx: string) {
  return worldTheme(ctx);
}

/** Rewrite a liked object into the new world's terms. */
function transformLike(obj: string, th: ReturnType<typeof theme>, ctx: string): string {
  switch (th) {
    case 'apocalypse':
      return pick([`무너진 ${obj}의 흔적을 보며 옛날을 그리워한다`, `폐허 속에서 ${josa(obj, '을/를')} 다시 찾아다닌다`, `${obj} 이야기를 하면 세상이 무너지기 전이 떠오른다`]);
    case 'fantasy':
      return pick([`이 왕국에도 ${josa(obj, '이/가')} 있다는 소문을 믿는다`, `${josa(obj, '을/를')} 마법처럼 귀한 것이라 여긴다`, `음유시인에게 ${obj} 이야기를 들려달라고 조른다`]);
    case 'cyber':
      return pick([`네온 불빛 아래에서 진짜 ${josa(obj, '을/를')} 찾아다닌다`, `홀로그램 ${obj}로는 만족하지 못한다`, `${josa(obj, '을/를')} 데이터가 아닌 손으로 느끼고 싶어 한다`]);
    case 'modern':
      return pick([`다시 평범하게 ${josa(obj, '을/를')} 즐길 수 있어서 행복하다`, `예전 세계에서도 ${josa(obj, '을/를')} 좋아했던 것 같다`]);
    case 'school':
      return pick([`쉬는 시간마다 ${obj} 얘기를 한다`, `${obj} 동아리를 만들고 싶어 한다`]);
    case 'pirate':
      return pick([`항구에 내리면 제일 먼저 ${josa(obj, '을/를')} 찾는다`, `배 위에서도 ${josa(obj, '을/를')} 그리워한다`]);
    case 'space':
      return pick([`지구의 ${josa(obj, '을/를')} 그리워하며 사진을 본다`, `우주에서도 ${josa(obj, '을/를')} 재현해 보려 애쓴다`]);
    case 'joseon':
      return pick([`장터에서 ${josa(obj, '을/를')} 닮은 것을 찾아다닌다`, `${obj} 이야기를 시로 지어 읊는다`]);
    default:
      return `「${ctx}」에서도 ${josa(obj, '을/를')} 포기하지 않는다`;
  }
}

function reactiveTrait(reason: Exclude<MutationReason, { kind: 'drift' }>, a: Agent): string {
  if (reason.kind === 'impact') {
    const n = reason.byName;
    const brave = a.persona.curious > 0.2 || a.persona.energy > 0.3;
    switch (reason.what) {
      case 'dragon':
        return brave ? `${josa(n, '을/를')} 처음 본 날을 잊지 못한다` : '하늘에 큰 그림자가 지나가면 몸을 움츠린다';
      case 'celebrity':
        return brave ? `${n}의 사인을 받고 싶어 안달이 났다` : `${josa(n, '이/가')} 지나가면 괜히 머리를 매만진다`;
      case 'monster':
        return brave ? `언젠가 ${josa(n, '을/를')} 물리치는 상상을 한다` : '밤이 되면 문단속을 두 번씩 한다';
      case 'ghost':
        return brave ? '귀신 이야기에 묘하게 끌린다' : '어두운 골목을 혼자 걷지 못하게 되었다';
      case 'alien':
        return brave ? '밤하늘에서 이상한 빛을 찾는 게 취미가 되었다' : '외계인이 자기를 데려갈까 봐 걱정한다';
    }
  }
  const th = theme(reason.to);
  if (th === 'other') return `「${reason.to}」 세상에 적응하려고 애쓰고 있다`; // the storyteller may phrase it better
  const fresh = randomTraits(reason.to, 'person', 1, Math.floor(Math.random() * 1e9), a.traits)[0];
  return fresh ?? pick(poolFor(reason.to).habits);
}

export interface MutationResult {
  replaced?: { from: string; to: string };
  added: string;
}

/**
 * Pick the trait most related to the change (likes first) and rewrite it; add a reactive trait.
 * `related(trait)` scores relevance (lexical/embedding matcher supplied by the world).
 */
export function mutateTraits(a: Agent, reason: MutationReason, related: (t: string) => number): MutationResult {
  if (reason.kind === 'drift') return reason.replaces ? { replaced: { from: reason.replaces, to: reason.text }, added: '' } : { added: reason.text };
  const added = reactiveTrait(reason, a);
  if (reason.kind === 'impact') return { added };
  const th = theme(reason.to);
  const likes = a.traits.filter((t) => traitPolarity(t) > 0 && extractObject(t));
  const pool = likes.length ? likes : [];
  let best: string | undefined, bv = -1;
  for (const t of pool) {
    const v = related(t) + Math.random() * 0.15;
    if (v > bv) (bv = v), (best = t);
  }
  if (!best) return { added };
  const obj = extractObject(best)!;
  return { replaced: { from: best, to: transformLike(obj, th, reason.to) }, added };
}

/** Does this newly spawned being shake up the neighbourhood? */
export function impactOf(category: string, appearance: string, name: string): Extract<MutationReason, { kind: 'impact' }>['what'] | null {
  for (const [re, what] of IMPACT_RE) if (re.test(`${category} ${appearance} ${name}`)) return what;
  return null;
}
