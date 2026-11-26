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

export type Axis = 'social' | 'kind' | 'temper' | 'cheer' | 'curious' | 'energy' | 'sensitive' | 'humor' | 'diligence' | 'confidence' | 'candor' | 'romance';
export type Persona = Record<Axis, number>; // each -1..1

export const AXIS_LABEL: Record<Axis, [string, string]> = {
  social: ['내향적', '사교적'],
  kind: ['무심함', '다정함'],
  temper: ['온화함', '다혈질'],
  cheer: ['비관적', '낙천적'],
  curious: ['신중함', '호기심'],
  energy: ['느긋함', '활발함'],
  sensitive: ['무던함', '예민함'],
  humor: ['진지함', '유머러스함'],
  diligence: ['즉흥적', '성실함'],
  confidence: ['소심함', '당당함'],
  candor: ['속을 숨김', '솔직함'],
  romance: ['현실적', '낭만적'],
};

/** how the player reads each axis (inspector) — and what it changes in the simulation */
export const AXIS_INFO: Record<Axis, { group: '관계' | '감정' | '행동' | '마음가짐'; effect: string }> = {
  social: { group: '관계', effect: '사교적일수록 먼저 말을 걸고 여럿이 어울려요. 내향적이면 혼자 있는 시간을 좋아해요.' },
  kind: { group: '관계', effect: '다정할수록 기운 없는 윌을 위로하고, 힘들다는 소문을 들으면 찾아가요.' },
  candor: { group: '관계', effect: '솔직할수록 생각을 바로 말하고, 속을 숨기는 윌은 마음을 잘 드러내지 않아요(말투).' },
  cheer: { group: '감정', effect: '낙천적일수록 기분이 쉽게 회복돼요. 비관적이면 기분이 잘 가라앉아요.' },
  sensitive: { group: '감정', effect: '예민할수록 세상이 바뀌거나 사건이 생기면 빨리, 크게 반응해요.' },
  temper: { group: '감정', effect: '다혈질일수록 사이가 나쁜 윌과 말다툼이 잦아요.' },
  energy: { group: '행동', effect: '활발할수록 많이 돌아다니고, 느긋하면 한곳에 오래 머물러요.' },
  curious: { group: '행동', effect: '호기심이 많을수록 멀리 돌아다니고 새로운 것에 빨리 적응해요.' },
  diligence: { group: '행동', effect: '성실할수록 근무 시간을 잘 지키고, 즉흥적이면 일을 빼먹고 놀러 가기도 해요.' },
  confidence: { group: '마음가짐', effect: '당당할수록 좋아하는 사람에게 먼저 고백해요. 소심하면 마음만 품고 있어요.' },
  humor: { group: '마음가짐', effect: '유머러스할수록 농담과 장난이 많아요(말투).' },
  romance: { group: '마음가짐', effect: '낭만적일수록 별·노을·사랑에 마음이 움직여요(말투·속마음).' },
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
  humor: [
    ['농담을 잘한다', '장난을 좋아한다', '남을 잘 웃긴다', '아재 개그를 좋아한다', '재치가 있다', '익살스럽다', '유머 감각이 있다'],
    ['농담이 안 통한다', '진지하다', '무게를 잡는다', '엄격하다', '장난을 싫어한다'],
  ],
  diligence: [
    ['성실하다', '계획을 세우고 지킨다', '꼼꼼하다', '약속 시간을 잘 지킨다', '정리 정돈을 잘한다', '책임감이 강하다', '맡은 일은 끝까지 한다'],
    ['즉흥적이다', '계획 없이 산다', '덤벙댄다', '늘 지각한다', '일을 미룬다', '물건을 잘 잃어버린다', '방이 늘 어질러져 있다'],
  ],
  confidence: [
    ['자신감이 넘친다', '당당하다', '리더십이 있다', '앞에 나서는 걸 좋아한다', '하고 싶은 말은 한다', '결정을 빨리 내린다'],
    ['소심하다', '수줍음이 많다', '자존감이 낮다', '남의 눈치를 많이 본다', '거절을 잘 못 한다', '앞에 나서는 게 무섭다'],
  ],
  candor: [
    ['솔직하다', '거짓말을 못 한다', '직설적이다', '생각을 바로 말한다', '속마음이 얼굴에 다 드러난다'],
    ['속마음을 잘 숨긴다', '자기 얘기를 잘 안 한다', '비밀이 많다', '속을 알 수 없다', '괜찮은 척한다', '늘 긍정적인 척한다'],
  ],
  romance: [
    ['낭만적이다', '감성적이다', '별을 보는 걸 좋아한다', '사랑 노래를 좋아한다', '운명을 믿는다', '시를 쓴다', '노을을 좋아한다'],
    ['현실적이다', '계산이 빠르다', '실용적인 걸 좋아한다', '돈 관리를 잘한다', '감상에 젖지 않는다'],
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
  [/(농담|장난|웃기|개그|재치|익살)/, { humor: 0.6 }],
  [/(진지|엄격|무게를)/, { humor: -0.5 }],
  [/(성실|꼼꼼|계획을|책임감|정리 정돈에|정리 정돈을|일찍 온|끝까지)/, { diligence: 0.6 }],
  [/(즉흥|덤벙|지각|미루|잃어버|어질러)/, { diligence: -0.6 }],
  [/(자신감|당당|리더|앞에 나서는 걸 좋|대장)/, { confidence: 0.6 }],
  [/(소심|수줍|눈치|거절을 잘 못|자존감이 낮|앞에 나서는 게)/, { confidence: -0.6 }],
  [/(솔직|직설|거짓말을 못|바로 말)/, { candor: 0.6 }],
  [/(숨긴|척한|비밀이|속을 알 수|자기 얘기는 잘 안|일기에만)/, { candor: -0.6 }],
  [/(낭만|감성|운명|별을|별이|노을|시를|사랑 노래)/, { romance: 0.5 }],
  [/(현실적|계산이|실용|돈 관리)/, { romance: -0.5 }],
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

export const PERSONA_AXES = AXES;

/** Project a list of traits onto personality axes. Unknown traits contribute 0. */
export function computePersona(traits: string[], m: SemanticMatcher): Persona {
  return explainPersona(traits, m).persona;
}

/**
 * The same projection, keeping the evidence: which trait sentence pushed which axis, and how far.
 * The inspector shows it ("「정이 많다」 → 다정함"), so the player can see WHY a Will is how it is.
 */
export function explainPersona(traits: string[], m: SemanticMatcher): { persona: Persona; why: Record<Axis, { trait: string; d: number }[]> } {
  const p = Object.fromEntries(AXES.map((ax) => [ax, 0])) as Persona;
  const why = Object.fromEntries(AXES.map((ax) => [ax, [] as { trait: string; d: number }[]])) as Record<Axis, { trait: string; d: number }[]>;
  for (const t of traits) {
    const add: Partial<Record<Axis, number>> = {};
    const ds = AXES.map((ax) => maxSim(m, t, ANCHORS[ax][0]) - maxSim(m, t, ANCHORS[ax][1]));
    const top = Math.max(...ds.map(Math.abs));
    AXES.forEach((ax, i) => {
      const d = ds[i];
      // a trait speaks mainly to the axes it matches best: a short one like "정이 많다" shares word pieces
      // with "잠이 많다"·"비밀이 많다"… and used to light up six axes at once
      if (Math.abs(d) > 0.3 && Math.abs(d) >= top * 0.8) add[ax] = (add[ax] ?? 0) + d * 0.8;
    });
    for (const [re, delta] of CUES) if (re.test(t)) for (const k in delta) add[k as Axis] = (add[k as Axis] ?? 0) + delta[k as Axis]! * 0.6;
    for (const k in add) {
      const ax = k as Axis;
      p[ax] += add[ax]!;
      if (Math.abs(add[ax]!) >= 0.12) why[ax].push({ trait: t, d: add[ax]! });
    }
  }
  for (const ax of AXES) {
    p[ax] = clamp(p[ax], -1, 1);
    why[ax].sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  }
  return { persona: p, why };
}

/** 조금 · 꽤 · 아주 (null = 보통, not worth mentioning) */
export function axisLevel(v: number): '조금' | '꽤' | '아주' | null {
  const a = Math.abs(v);
  return a >= 0.7 ? '아주' : a >= 0.45 ? '꽤' : a >= 0.25 ? '조금' : null;
}

/** the strongest axes: [{ axis, label, level, v }] */
export function personaTop(p: Persona, max = 4, min = 0.25) {
  return AXES.map((ax) => ({ axis: ax, v: p[ax] }))
    .filter((x) => Math.abs(x.v) >= min)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, max)
    .map((x) => ({ ...x, label: AXIS_LABEL[x.axis][x.v > 0 ? 1 : 0], level: axisLevel(x.v)! }));
}

export function personaSummary(p: Persona, max = 3): string[] {
  return personaTop(p, max, 0.3).map((x) => x.label);
}

/** "아주 다정함, 꽤 사교적, 조금 예민함" — with strength, for the storyteller */
export function personaDetail(p: Persona, max = 5): string {
  return personaTop(p, max).map((x) => `${x.level} ${x.label}`).join(', ');
}

/** label → [adnominal, connective]: 다정함 → 다정한 / 다정하고 */
const FORMS: Record<string, [string, string]> = {
  내향적: ['내향적인', '내향적이고'], 사교적: ['사교적인', '사교적이고'], 무심함: ['무심한', '무심하고'], 다정함: ['다정한', '다정하고'],
  온화함: ['온화한', '온화하고'], 다혈질: ['욱하는', '욱하고'], 비관적: ['비관적인', '비관적이고'], 낙천적: ['낙천적인', '낙천적이고'],
  신중함: ['신중한', '신중하고'], 호기심: ['호기심 많은', '호기심 많고'], 느긋함: ['느긋한', '느긋하고'], 활발함: ['활발한', '활발하고'],
  무던함: ['무던한', '무던하고'], 예민함: ['예민한', '예민하고'], 진지함: ['진지한', '진지하고'], 유머러스함: ['유머러스한', '유머러스하고'],
  즉흥적: ['즉흥적인', '즉흥적이고'], 성실함: ['성실한', '성실하고'], 소심함: ['소심한', '소심하고'], 당당함: ['당당한', '당당하고'],
  '속을 숨김': ['속을 잘 드러내지 않는', '속을 잘 드러내지 않고'], 솔직함: ['솔직한', '솔직하고'], 현실적: ['현실적인', '현실적이고'], 낭만적: ['낭만적인', '낭만적이고'],
};
/** "아주 다정하고 꽤 사교적이지만, 조금 예민한 편이다." (null if nothing stands out) */
export function personaSentence(p: Persona, max = 3): string | null {
  const top = personaTop(p, max);
  if (!top.length) return null;
  const words = top.map((x) => `${x.level === '조금' ? '조금 ' : x.level === '아주' ? '아주 ' : '꽤 '}`);
  const parts = top.map((x, i) => {
    const [adn, con] = FORMS[x.label] ?? [`${x.label}인`, `${x.label}이고`];
    return { adn: words[i] + adn, con: words[i] + con };
  });
  if (parts.length === 1) return `${parts[0].adn} 편이다.`;
  return `${parts.slice(0, -1).map((x) => x.con).join(' ')} ${parts[parts.length - 1].adn} 편이다.`;
}

// ───────────────────────── object extraction ─────────────────────────

const VERB_TAIL =
  /\s*(을|를|이|가|은|는|에|에게|과|와|랑|이랑)?\s*(정말|매우|아주|너무|무척|특히|가장|제일|꽤|은근히|몰래|푹)?\s*(좋아|사랑|즐기|즐겨|싫어|무서워|두려워|질색|못 견|동경|존경|그리워|관심|빠져|미쳐|집착|챙겨|아낀|아끼|수집|모으|모은|삶의 ?낙|낙이|유일한 ?낙).*$/;

/** "고양이를 정말 좋아하지만 키울 형편이 안 된다" → "고양이" */
export function extractObject(trait: string): string | null {
  if (!LIKE_RE.test(trait) && !DISLIKE_RE.test(trait) && !/(빠져|미쳐|수집|모으|아끼)/.test(trait)) return null;
  const head = trait.split(/(지만|는데|고 ?있|그래서|,)/)[0];
  let obj = head.replace(VERB_TAIL, '').trim();
  obj = obj.replace(/^(언제나|항상|요즘|매일|가끔|늘|옛날부터)\s*/, '');
  obj = obj.replace(/\s*(걸|것을)$/, ' 것').replace(/([^ ])것$/, '$1 것').replace(/(는|은) ?게$/, '$1 것');
  obj = obj.replace(/(하는|보는|듣는|먹는|치는|부르는|읽는|하기|보기)$/, (m) => (m.endsWith('기') ? m : m + ' 것'));
  if (obj.length < 1 || obj.length > 24) return null;
  // a whole sentence is not a thing ("…가 꿈이다" is a dream, see extractDream)
  if (/꿈이다$/.test(trait.trim()) || /다$/.test(obj)) return null;
  return obj;
}

/**
 * What a trait says the character recoils from, or null.
 * "비 오는 날을 싫어한다" → "비 오는 날", "큰 소리에 예민하다" → "큰 소리",
 * "시험 기간이라 조금 예민하다" → null (a state of mind, not a dislike of anything).
 */
export function aversionObject(trait: string): string | null {
  if (!DISLIKE_RE.test(trait)) return null;
  const sensitive = trait.match(/^(.+?)에\s*(?:조금|좀|많이|특히|무척|매우|유난히)?\s*예민/);
  if (sensitive) return sensitive[1].trim();
  if (!/(싫어|무서워|질색|못 견|짜증|두려워)/.test(trait)) return null; // only "예민" without an object
  const obj = extractObject(trait);
  return obj && obj !== trait.trim() ? obj : null;
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

/**
 * Polite 해요체 → casual 해체, for Wills who feel close (≥60) to the listener.
 * Rule-based and conservative: only sentence endings and a few pronouns change.
 * "저도 그거 좋아해요!" → "나도 그거 좋아해!", "어디 가는 길이에요?" → "어디 가는 길이야?"
 */
export function toBanmal(text: string): string {
  if (text.startsWith('(')) return text; // inner thoughts are already plain
  let t = text;
  const END = '(?=[.!?~…,]|\\s|$)';
  const rules: [RegExp, string][] = [
    [/안녕하세요/g, '안녕'],
    [/고맙습니다|감사합니다/g, '고마워'],
    [/죄송해요|죄송합니다/g, '미안해'],
    [new RegExp(`이에요${END}`, 'g'), '이야'],
    [new RegExp(`예요${END}`, 'g'), '야'],
    [new RegExp(`주세요${END}`, 'g'), '줘'],
    [new RegExp(`하세요${END}`, 'g'), '해'],
    [new RegExp(`세요${END}`, 'g'), ''],
    [new RegExp(`(습|ㅂ)니다${END}`, 'g'), '어'],
    [new RegExp(`죠${END}`, 'g'), '지'],
    [new RegExp(`요${END}`, 'g'), ''],
  ];
  for (const [re, to] of rules) t = t.replace(re, to);
  t = t
    .replace(/(^|\s)저는(?=\s)/g, '$1나는')
    .replace(/(^|\s)저도(?=\s)/g, '$1나도')
    .replace(/(^|\s)제가(?=\s)/g, '$1내가')
    .replace(/(^|\s)저한테(?=\s)/g, '$1나한테')
    .replace(/(^|\s)저랑(?=\s)/g, '$1나랑')
    .replace(/(^|\s)제(?=\s)/g, '$1내');
  // "…해 줘"·"…할래" stay natural; tidy double spaces/punctuation
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([.!?~…])/g, '$1').trim();
}
