// Interpreting ARBITRARY free-text traits.
//
// Users can type any sentence as a trait. Instead of a closed keyword list we:
//  1) project each trait onto 7 personality axes by similarity to anchor
//     sentences (lexical now; MiniLM embeddings in Phase 2 → unseen phrasing
//     like "남의 기분을 잘 살핀다" still lands near "다정하다" anchors),
//  2) extract the object of likes/dislikes ("우주 다큐 보는 걸 좋아한다" →
//     "우주 다큐 보는 것") so dialogue can talk about ANY topic.

import { DISLIKE_RE, LIKE_RE, type SemanticMatcher } from './semantic';
import { clamp } from './util';

export type Axis = 'social' | 'kind' | 'temper' | 'cheer' | 'curious' | 'energy' | 'sensitive';
export type Persona = Record<Axis, number>; // each -1..1

export const AXIS_LABEL: Record<Axis, [string, string]> = {
  social: ['내향적', '사교적'],
  kind: ['무심함', '다정함'],
  temper: ['온화함', '다혈질'],
  cheer: ['비관적', '낙천적'],
  curious: ['신중함', '호기심'],
  energy: ['느긋함', '활발함'],
  sensitive: ['무던함', '예민함'],
};

/** Anchor sentences per axis: [positive pole, negative pole]. */
const ANCHORS: Record<Axis, [string[], string[]]> = {
  social: [
    ['사람들과 수다 떠는 것을 좋아한다', '누구에게나 먼저 말을 건다', '새로운 사람을 만나는 걸 좋아한다', '친구가 많다', '분위기 메이커다', '모임을 좋아한다', '사교적이다', '외향적이다', '말이 많다'],
    ['낯을 많이 가린다', '혼자 있는 시간이 필요하다', '말수가 적다', '사람 많은 곳을 싫어한다', '내향적이다', '조용한 성격이다', '혼자가 편하다'],
  ],
  kind: [
    ['우울해 보이는 사람을 보면 가만히 두지 못한다', '정이 많다', '남을 잘 도와준다', '배려심이 깊다', '다정하다', '남의 기분을 잘 살핀다', '위로를 잘한다', '동물을 잘 챙긴다', '착하다'],
    ['남의 일에 관심이 없다', '이기적이다', '냉정하다', '무뚝뚝하다', '차갑다', '남을 잘 믿지 않는다'],
  ],
  temper: [
    ['쉽게 화를 낸다', '욱하는 성격이다', '참을성이 없다', '다혈질이다', '시비를 잘 건다', '짜증이 많다', '성격이 급하다', '경쟁심이 강하다'],
    ['화를 잘 내지 않는다', '온화하다', '참을성이 많다', '느긋하다', '평화주의자다', '차분하다'],
  ],
  cheer: [
    ['잘 웃는다', '언제나 긍정적이다', '낙천적이다', '밝다', '희망을 잃지 않는다', '유쾌하다'],
    ['걱정이 많은 편이다', '우울하다', '비관적이다', '자존감이 낮다', '불안하다', '쉽게 좌절한다', '잘 풀리지 않아 우울하다'],
  ],
  curious: [
    ['호기심이 많다', '새로운 것을 시도하는 걸 좋아한다', '모험을 좋아한다', '탐험을 좋아한다', '궁금한 건 못 참는다', '여행을 좋아한다', '맛집 탐방이 취미다'],
    ['익숙한 것을 좋아한다', '신중하다', '변화를 싫어한다', '조심성이 많다', '경계심이 많다'],
  ],
  energy: [
    ['활기차다', '에너지가 넘친다', '운동을 좋아한다', '가만히 있지 못한다', '발랄하다', '부지런하다', '뛰어다닌다'],
    ['피곤하다', '지쳐 있다', '게으르다', '느긋하다', '잠이 많다', '야근에 지쳐 있다', '무기력하다', '낮잠 자는 걸 좋아한다'],
  ],
  sensitive: [
    ['예민하다', '상처를 잘 받는다', '눈물이 많다', '감수성이 풍부하다', '소리에 민감하다', '쉽게 긴장한다'],
    ['무던하다', '털털하다', '신경 쓰지 않는다', '대범하다', '둔감하다'],
  ],
};

// Fast lexical cues that complement anchors for very short traits.
const CUES: [RegExp, Partial<Persona>][] = [
  [/(수다|말을 건|친구|사교|외향|분위기 메이커|모임)/, { social: 0.7 }],
  [/(낯을|내향|혼자|조용|말수가 적)/, { social: -0.7 }],
  [/(정이 많|다정|배려|도와|위로|챙겨|착하|우울해 보이는 사람)/, { kind: 0.7 }],
  [/(냉정|무뚝뚝|차갑|이기적|관심이 없)/, { kind: -0.6 }],
  [/(화를|욱|짜증|시비|다혈|급하|경쟁)/, { temper: 0.7 }],
  [/(온화|참을성이 많|차분|평화)/, { temper: -0.6 }],
  [/(웃|긍정|낙천|밝|유쾌|희망)/, { cheer: 0.6 }],
  [/(우울|걱정|비관|불안|좌절|떨어져|힘들)/, { cheer: -0.6 }],
  [/(호기심|모험|탐험|탐방|새로운|궁금|여행)/, { curious: 0.6 }],
  [/(신중|경계심|조심|익숙한)/, { curious: -0.5 }],
  [/(활기|에너지|운동|발랄|뛰어|부지런|씩씩)/, { energy: 0.6 }],
  [/(피곤|지쳐|게으|잠이 많|낮잠|무기력|야근)/, { energy: -0.6 }],
  [/(예민|상처|눈물|감수성|민감|긴장)/, { sensitive: 0.6 }],
  [/(무던|털털|대범|둔감)/, { sensitive: -0.5 }],
];

const AXES = Object.keys(ANCHORS) as Axis[];

/** every anchor sentence (pre-embedded when the model becomes ready) */
export function allAnchorTexts(): string[] {
  return AXES.flatMap((ax) => [...ANCHORS[ax][0], ...ANCHORS[ax][1]]);
}

function maxSim(m: SemanticMatcher, t: string, list: string[]) {
  let best = 0;
  for (const s of list) best = Math.max(best, m.similarity(t, s));
  return best;
}

/** Project a list of traits onto personality axes. Unknown traits contribute 0. */
export function computePersona(traits: string[], m: SemanticMatcher): Persona {
  const p: Persona = { social: 0, kind: 0, temper: 0, cheer: 0, curious: 0, energy: 0, sensitive: 0 };
  for (const t of traits) {
    for (const ax of AXES) {
      const [pos, neg] = ANCHORS[ax];
      const sp = maxSim(m, t, pos);
      const sn = maxSim(m, t, neg);
      const d = sp - sn;
      if (Math.abs(d) > 0.25) p[ax] += d * 0.8;
    }
    for (const [re, delta] of CUES) if (re.test(t)) for (const k in delta) p[k as Axis] += delta[k as Axis]! * 0.6;
  }
  for (const ax of AXES) p[ax] = clamp(p[ax], -1, 1);
  return p;
}

export function personaSummary(p: Persona, max = 3): string[] {
  return AXES.map((ax) => [ax, p[ax]] as const)
    .filter(([, v]) => Math.abs(v) >= 0.3)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, max)
    .map(([ax, v]) => AXIS_LABEL[ax][v > 0 ? 1 : 0]);
}

// ───────────────────────── object extraction ─────────────────────────

const VERB_TAIL =
  /\s*(을|를|이|가|은|는|에|에게|과|와|랑|이랑)?\s*(정말|매우|아주|너무|무척|특히|가장|제일|꽤|은근히|몰래|푹)?\s*(좋아|사랑|즐기|즐겨|싫어|무서워|질색|못 견|동경|존경|그리워|관심|빠져|미쳐|집착|챙겨|아낀|아끼|수집|모으|모은|삶의 ?낙|낙이|유일한 ?낙).*$/;

/** "고양이를 정말 좋아하지만 키울 형편이 안 된다" → "고양이" */
export function extractObject(trait: string): string | null {
  if (!LIKE_RE.test(trait) && !DISLIKE_RE.test(trait) && !/(빠져|미쳐|수집|모으|아끼)/.test(trait)) return null;
  const head = trait.split(/(지만|는데|고 ?있|그래서|,)/)[0];
  let obj = head.replace(VERB_TAIL, '').trim();
  obj = obj.replace(/^(언제나|항상|요즘|매일|가끔|늘|옛날부터)\s*/, '');
  obj = obj.replace(/\s*(걸|것을)$/, ' 것').replace(/([^ ])것$/, '$1 것').replace(/(는|은) ?게$/, '$1 것');
  obj = obj.replace(/(하는|보는|듣는|먹는|치는|부르는|읽는|하기|보기)$/, (m) => (m.endsWith('기') ? m : m + ' 것'));
  if (obj.length < 1 || obj.length > 24) return null;
  return obj;
}

/** "언젠가 밴드로 데뷔하는 것이 꿈이다" → "밴드로 데뷔하는 것" */
export function extractDream(trait: string): string | null {
  const m = trait.match(/(?:언젠가\s*)?(.+?)(?:이|가)?\s*꿈이다/);
  return m ? m[1].trim() : null;
}

export function traitPolarity(trait: string): 1 | -1 | 0 {
  if (DISLIKE_RE.test(trait)) return -1;
  if (LIKE_RE.test(trait) || /(빠져|미쳐|수집|모으)/.test(trait)) return 1;
  return 0;
}

// ───────────────────────── Korean particles ─────────────────────────

function hasBatchim(word: string): boolean {
  const ch = word.trim().replace(/[^가-힣a-zA-Z0-9]+$/, '').slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(ch)) return '013678'.includes(ch);
  if (/[a-zA-Z]/.test(ch)) return /[lmnr]/i.test(ch);
  return false;
}

/** josa("민수", "이/가") → "민수가", josa("철수","와/과") → "철수와" */
export function josa(word: string, pair: '이/가' | '을/를' | '은/는' | '와/과' | '으로/로' | '아/야' | '이랑/랑'): string {
  const b = hasBatchim(word);
  // first form = after a final consonant (과 for 와/과)
  const [withB, without] = pair === '와/과' ? ['과', '와'] : pair.split('/');
  if (pair === '으로/로') {
    const last = word.trim().replace(/[^가-힣a-zA-Z0-9]+$/, '').slice(-1).charCodeAt(0);
    const rieul = last >= 0xac00 && (last - 0xac00) % 28 === 8;
    return word + (b && !rieul ? withB : without);
  }
  return word + (b ? withB : without);
}

/** copula("회사원") → "회사원이다", copula("바리스타") → "바리스타다" */
export function copula(word: string): string {
  return word + (hasBatchim(word) ? '이다' : '다');
}
/** particle only: suffix("민수", "이/가") → "가" */
export function suffix(word: string, pair: Parameters<typeof josa>[1]): string {
  return josa(word, pair).slice(word.length);
}

/**
 * Plain sentence → casual-polite "~거든요" form for dialogue.
 * "입는다"→"입거든요", "좋아한다"→"좋아하거든요", "느긋하다"→"느긋하거든요", "학생이다"→"학생이거든요"
 */
export function toGeodeunyo(t: string): string {
  const s = t.trim().replace(/[.!]$/, '');
  if (s.endsWith('는다')) return s.slice(0, -2) + '거든요';
  if (s.endsWith('다')) {
    const body = s.slice(0, -1);
    const last = body.slice(-1);
    const code = last.charCodeAt(0);
    // ㄴ받침 present-tense verbs: 한다 → 하, 간다 → 가
    if (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 4 && body.length >= 1) {
      return body.slice(0, -1) + String.fromCharCode(code - 4) + '거든요';
    }
    return body + '거든요';
  }
  return s + '요';
}
