// Free-text appearance → 6 procedural top-down rendering layers.
// Phase 1: deterministic Korean/English keyword lexicon, segment-scoped so a
// color word binds to the item in the same comma segment ("분홍색 단발머리").
// Phase 2 adds an embedding nearest-neighbour fallback for unknown words.

import type {
  AppearanceLayers, Bottom, FaceAcc, Gender, HairShape, Headgear, OutfitStyle, Prop, Species,
} from './types';
import { hashString, makeRng, pick } from './util';

const COLORS: [RegExp, string][] = [
  [/(하늘색|스카이|sky)/i, '#8cc8ec'],
  [/(민트|mint)/i, '#8fdcc0'],
  [/(남색|네이비|navy)/i, '#2b3a67'],
  [/(분홍|핑크|pink)/i, '#f2a0bf'],
  [/(빨간|빨강|붉은|레드|red|진홍)/i, '#d0443e'],
  [/(주황|오렌지|orange)/i, '#ec8a3a'],
  [/(금발|금색|황금|골드|gold|blonde)/i, '#e8c45a'],
  [/(노란|노랑|yellow|개나리)/i, '#f2cf48'],
  [/(연두|라임|lime)/i, '#a6d35a'],
  [/(초록|녹색|그린|green|풀색)/i, '#4f9a5a'],
  [/(청록|teal)/i, '#2f8f8f'],
  [/(파란|파랑|푸른|블루|blue)/i, '#3f6fd0'],
  [/(보라|퍼플|purple|자주|라벤더)/i, '#8a5cc8'],
  [/(은발|은색|실버|silver)/i, '#c9ccd4'],
  [/(흰|하얀|백색|화이트|white|새하얀|흰색)/i, '#f1efe8'],
  [/(검은|검정|흑|블랙|black|까만)/i, '#2a2726'],
  [/(회색|잿빛|그레이|gray|grey)/i, '#8a8a8e'],
  [/(갈색|밤색|브라운|brown|초콜릿)/i, '#7a5236'],
  [/(베이지|beige|크림)/i, '#ddc9a3'],
  [/(카키|khaki|올리브)/i, '#7d7a4a'],
  [/(치즈|황토)/i, '#e1a04a'],
];

export function findColor(text: string): string | null {
  for (const [re, hex] of COLORS) if (re.test(text)) return hex;
  return null;
}

const HAIR: [RegExp, HairShape][] = [
  [/(땋은|땋아|브레이드|braid)/i, 'braid'],
  [/(트윈테일|양갈래|twin)/i, 'twintails'],
  [/(똥머리|올림머리|만두머리|번 ?헤어|bun)/i, 'bun'],
  [/(포니테일|묶은 머리|하나로 묶|ponytail)/i, 'ponytail'],
  [/(단발|보브|bob)/i, 'bob'],
  [/(웨이브|물결|wavy)/i, 'wavy'],
  [/(장발|긴 머리|긴머리|생머리|흘러내리는|반묶음|long hair|(^|\s)긴\s)/i, 'long'],
  [/(곱슬|파마|펌|뽀글|curly)/i, 'curly'],
  [/(부스스|헝클|더벅|산발|messy)/i, 'messy'],
  [/(대머리|민머리|삭발|bald)/i, 'bald'],
  [/(짧게 민|까까머리|빡빡|버즈컷|buzz)/i, 'buzz'],
  [/(삐죽|뾰족|스파이크|spiky)/i, 'spiky'],
  [/(가르마|댄디|포마드|넘긴 머리|side ?part)/i, 'sidePart'],
  // "짧은 검은 머리": a colour word may sit between 짧은 and 머리
  [/(짧은|숏컷|짧은머리|투블럭|스포츠|short)/i, 'short'],
];
const HAIR_WORD = /(머리(?!핀)|헤어(?!핀)|hair|금발|은발|단발|장발|트윈테일|포니테일|양갈래|숏컷|땋|가르마|곱슬|웨이브|투블럭|댄디|파마|펌)/i;

/** hairstyles people mostly get when the text doesn't say (weights) */
const HAIR_DEFAULT: Record<Gender, [HairShape, number][]> = {
  female: [['long', 26], ['bob', 15], ['ponytail', 14], ['wavy', 12], ['braid', 8], ['bun', 8], ['twintails', 4], ['curly', 5], ['short', 5], ['sidePart', 3]],
  male: [['short', 28], ['sidePart', 18], ['messy', 12], ['spiky', 9], ['buzz', 8], ['curly', 10], ['ponytail', 3], ['bob', 3], ['long', 3], ['bald', 2], ['wavy', 4]],
  other: [['short', 12], ['bob', 12], ['long', 10], ['messy', 10], ['curly', 10], ['ponytail', 10], ['sidePart', 8], ['wavy', 8], ['bun', 6], ['spiky', 6], ['braid', 4], ['buzz', 4]],
};
const BOTTOM_DEFAULT: Record<Gender, [Bottom, number][]> = {
  female: [['skirt', 50], ['longSkirt', 12], ['pants', 32], ['shorts', 6]],
  male: [['pants', 88], ['shorts', 12]],
  other: [['pants', 60], ['skirt', 20], ['longSkirt', 10], ['shorts', 10]],
};
function weighted<T>(table: [T, number][], r: number): T {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [v, w] of table) if ((x -= w) < 0) return v;
  return table[0][0];
}
const BOTTOM_COLORS = ['#2f3a52', '#3f5f8a', '#2a2726', '#5a4a3a', '#8a8a8e', '#ddc9a3', '#7a2f3a', '#3a5a4a'];
function bottomOf(seg: string): Bottom | null {
  if (/(롱 ?스커트|긴 치마|롱치마|롱 ?원피스)/.test(seg)) return 'longSkirt';
  if (/(치마|스커트|skirt)/i.test(seg)) return 'skirt';
  if (/(반바지|숏팬츠|shorts)/i.test(seg)) return 'shorts';
  if (/(바지|청바지|슬랙스|레깅스|팬츠|진\b|jeans|pants)/i.test(seg)) return 'pants';
  return null;
}

const HEADGEAR: [RegExp, Headgear][] = [
  [/(베레모|beret)/i, 'beret'],
  [/(왕관|티아라|crown)/i, 'crown'],
  [/(고양이 ?귀|cat ?ears|고양이귀)/i, 'catEars'],
  [/(후드를 쓴|후드 쓴|두건|hood\b)/i, 'hood'],
  [/(헬멧|투구|helmet)/i, 'helmet'],
  [/(별 ?모양 ?머리핀|별 ?핀|머리핀|헤어핀|hairpin)/i, 'starPin'],
  [/(모자|캡|야구모자|cap|비니|갓)/i, 'cap'],
  [/(머리 ?리본|헤어 ?리본)/i, 'ribbon'],
];

const OUTFIT: [RegExp, OutfitStyle][] = [
  [/(교복|세일러|uniform)/i, 'uniform'],
  [/(우주복|점프슈트|spacesuit)/i, 'armor'],
  [/(도포|두루마기)/i, 'cloak'],
  [/(한복|저고리)/i, 'dress'],
  [/(체육복)/i, 'hoodie'],
  [/(가죽 조끼|조끼)/i, 'apron'],
  [/(정장|양복|수트|슈트|suit|와이셔츠|넥타이|샐러리맨|회사원|직장인)/i, 'suit'],
  [/(망토|로브|클로크|cloak|robe|마법사)/i, 'cloak'],
  [/(갑옷|아머|armor|기사)/i, 'armor'],
  [/(우비|비옷|레인코트|raincoat)/i, 'raincoat'],
  [/(후드티|후디|hoodie|맨투맨)/i, 'hoodie'],
  [/(원피스|드레스|dress)/i, 'dress'],
  [/(앞치마|에이프런|apron|바리스타|요리사)/i, 'apron'],
];

const FACE: [RegExp, FaceAcc][] = [
  [/(선글라스|썬글라스|sunglasses)/i, 'sunglasses'],
  [/(뿔테|안경|glasses)/i, 'glasses'],
  [/(안대|eyepatch)/i, 'eyepatch'],
  [/(수염|턱수염|beard)/i, 'beard'],
  [/(홍조|발그레|볼터치|blush|수줍)/i, 'blush'],
];

const PROPS: [RegExp, Prop][] = [
  [/(기타|guitar)/i, 'guitarCase'],
  [/(대검|장검|검을|칼|sword)/i, 'greatsword'],
  [/(서류 ?가방|브리프케이스|briefcase)/i, 'briefcase'],
  [/(배낭|백팩|가방|backpack)/i, 'backpack'],
  [/(우산|umbrella)/i, 'umbrella'],
  [/(책|book|노트)/i, 'book'],
  [/(지팡이|스태프|staff|완드)/i, 'staff'],
];

const SPECIES: [RegExp, Species][] = [
  [/(드래곤|dragon|와이번|아기\s?용|(^|[\s,])용($|[\s,]))/i, 'dragon'],
  [/(조랑말|망아지|horse|pony|유니콘|(^|[\s,])말($|[\s,]))/i, 'horse'],
  [/(여우|fox)/i, 'fox'],
  [/(토끼|rabbit|bunny)/i, 'rabbit'],
  [/(햄스터|hamster|다람쥐|기니피그)/i, 'hamster'],
  [/(고슴도치|hedgehog)/i, 'hedgehog'],
  [/(거북|turtle|tortoise|자라)/i, 'turtle'],
  [/(오리|duck|거위)/i, 'duck'],
  [/(닭|병아리|chicken|chick|수탉|암탉)/i, 'chicken'],
  [/(부엉이|올빼미|owl)/i, 'owl'],
  [/(까마귀|crow|raven)/i, 'crow'],
  [/(고양이|냥이|cat|길냥)/i, 'cat'],
  [/(강아지|멍멍|dog|puppy|댕댕|들개|진돗개|백구|누렁이|(^|[\s,])개($|[\s,]))/i, 'dog'],
  [/(새|참새|비둘기|까치|bird|앵무)/i, 'bird'],
];

/** Korean words for each species (used for matching likes/dislikes and labels). */
export const SPECIES_WORDS: Record<Species, string> = {
  cat: '고양이 길고양이', dog: '강아지 개', bird: '새', creature: '생물', rabbit: '토끼', hamster: '햄스터', duck: '오리', fox: '여우',
  hedgehog: '고슴도치', turtle: '거북이', crow: '까마귀 새', owl: '부엉이 새', horse: '말', chicken: '닭', dragon: '용 드래곤',
};
export const SPECIES_LABEL: Record<Species, string> = {
  cat: '고양이', dog: '강아지', bird: '새', creature: '동물', rabbit: '토끼', hamster: '햄스터', duck: '오리', fox: '여우',
  hedgehog: '고슴도치', turtle: '거북이', crow: '까마귀', owl: '부엉이', horse: '말', chicken: '닭', dragon: '용',
};
/** fur colour when the description doesn't name one */
const SPECIES_FUR: Partial<Record<Species, string[]>> = {
  rabbit: ['#f1efe8', '#d9c3a5', '#8a8a8e', '#7a5236'], hamster: ['#e8b878', '#f1efe8', '#c9a27a'], duck: ['#f2d84a', '#f1efe8'],
  fox: ['#e0782e', '#d9662a'], hedgehog: ['#8a6e52', '#6e5a48'], turtle: ['#5f8a4a', '#6e7f3a'], crow: ['#2a2a30'],
  owl: ['#9a7a5a', '#c9b08a', '#e8e2d6'], horse: ['#7a5236', '#3b2a20', '#e8e2d6', '#a87a4a'], chicken: ['#f1efe8', '#c9743a'],
  dragon: ['#4fa86a', '#c94a3a', '#4a7ac9', '#8a5ac9'],
};

const SKIN = ['#f6d7bd', '#efc7a4', '#e2b28c', '#c98f68', '#a26d4b', '#fbe2cf'];
const DEFAULT_HAIR = ['#2a2420', '#3b2a20', '#5a3a26', '#1e1e24', '#7a5236'];
const DEFAULT_OUTFIT = ['#6b7fa8', '#a8685a', '#5c8a6e', '#c9a25c', '#7c6aa8', '#4f5d6e', '#b0b8c0'];

export function propFromText(text: string): Prop | null {
  return match(PROPS, text);
}

export function speciesFromText(text: string): Species | null {
  for (const [re, s] of SPECIES) if (re.test(text)) return s;
  return null;
}

function match<T>(table: [RegExp, T][], text: string): T | null {
  for (const [re, v] of table) if (re.test(text)) return v;
  return null;
}

/**
 * Parse free-text appearance. `seed` (usually the name) keeps unspecified
 * layers stable across reloads, since saves only store text.
 */
export function parseAppearance(
  appearance: string,
  kind: 'person' | 'animal',
  seed: string,
  category = '',
  gender: Gender = 'other',
): AppearanceLayers {
  const rng = makeRng(hashString(seed + '|' + appearance));
  const L: AppearanceLayers = {
    hairShape: weighted(HAIR_DEFAULT[gender], rng()),
    hairColor: pick(DEFAULT_HAIR, rng()),
    headgear: 'none',
    headgearColor: '#c9a25c',
    outfitStyle: 'casual',
    outfitColor: pick(DEFAULT_OUTFIT, rng()),
    bottom: weighted(BOTTOM_DEFAULT[gender], rng()),
    bottomColor: pick(BOTTOM_COLORS, rng()),
    faceAcc: 'none',
    prop: 'none',
    propColor: '#6b4a30',
    bodyScale: 1,
    gait: 'normal',
    skinColor: pick(SKIN, rng()),
    species: 'cat',
    furColor: pick(['#e1a04a', '#2a2726', '#f1efe8', '#8a8a8e', '#7a5236'], rng()),
    furPattern: 'solid',
  };

  const segments = appearance.split(/[,，、/·\n]|그리고/).map((s) => s.trim()).filter(Boolean);

  if (kind === 'animal') {
    L.species = speciesFromText(category + ' ' + appearance) ?? 'creature';
    const c = findColor(appearance);
    const fur = SPECIES_FUR[L.species];
    if (c) L.furColor = c;
    else if (fur) L.furColor = pick(fur, rng());
    if (/(삼색|calico)/i.test(appearance)) L.furPattern = 'calico';
    else if (/(줄무늬|태비|tabby|치즈)/i.test(appearance)) L.furPattern = 'tabby';
    else if (/(턱시도|tuxedo|흑백)/i.test(appearance)) L.furPattern = 'tuxedo';
    if (/(작은|아기|새끼|꼬마|작고)/.test(appearance)) L.bodyScale = 0.8;
    if (/(큰|거대|덩치|뚱뚱|통통)/.test(appearance)) L.bodyScale = 1.25;
    return L;
  }

  for (const seg of segments) {
    const color = findColor(seg);
    const isHairSeg = HAIR_WORD.test(seg);
    const hair = isHairSeg || /머리/.test(seg) ? match(HAIR, seg) : null;
    const bottom = isHairSeg ? null : bottomOf(seg);
    if (bottom) {
      L.bottom = bottom;
      if (color) L.bottomColor = color;
      else if (/청/.test(seg)) L.bottomColor = '#3f5f8a';
    }
    const head = match(HEADGEAR, seg);
    const outfit = match(OUTFIT, seg);
    const face = match(FACE, seg);
    const prop = match(PROPS, seg);

    if (head) {
      L.headgear = head;
      if (color) L.headgearColor = color;
    }
    if (isHairSeg) {
      if (hair) L.hairShape = hair;
      // color binds to hair unless the segment is about a pin/hat
      if (color && !head) L.hairColor = color;
      else if (/금발/.test(seg)) L.hairColor = '#e8c45a';
      else if (/은발/.test(seg)) L.hairColor = '#c9ccd4';
    }
    if (outfit) {
      L.outfitStyle = outfit;
      if (color && !isHairSeg && !head) L.outfitColor = color;
    } else if (color && !bottom && !isHairSeg && !head && !prop && !face && /(옷|작업복|유니폼|셔츠|티셔츠|재킷|자켓|코트|니트|스웨터|조끼|점퍼|패딩)/.test(seg)) {
      L.outfitColor = color;
    }
    if (face) L.faceAcc = face;
    if (prop) {
      L.prop = prop;
      if (color && !outfit && !isHairSeg) L.propColor = color;
    }
    if (/(덩치|거구|건장|근육|큰 키|키가 큰|장신)/.test(seg)) L.bodyScale = 1.2;
    else if (/(작은 키|키가 작|아담|꼬마|어린)/.test(seg)) L.bodyScale = 0.85;
    else if (/(마른|호리호리|가냘픈)/.test(seg)) L.bodyScale = 0.92;
    if (/(활기|생기|씩씩|발랄|통통 튀)/.test(seg)) L.gait = 'bouncy';
    else if (/(피곤|지친|축 처진|구부정|무기력|우울)/.test(seg)) L.gait = 'slouch';
  }

  // Outfit can be implied by a role word anywhere (e.g. "샐러리맨").
  if (L.outfitStyle === 'casual') {
    const o = match(OUTFIT, appearance + ' ' + category);
    if (o) L.outfitStyle = o;
  }
  // "교복" default colors look like school uniforms.
  if (L.outfitStyle === 'suit' && !findColor(appearance.replace(/[^,]*머리[^,]*/g, ''))) L.outfitColor = '#33384a';
  if (L.outfitStyle === 'armor' && !findColor(appearance.replace(/[^,]*머리[^,]*/g, ''))) L.outfitColor = '#9aa3ad';
  return L;
}
