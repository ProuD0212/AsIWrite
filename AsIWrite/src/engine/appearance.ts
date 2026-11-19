// Free-text appearance → 6 procedural top-down rendering layers.
// Phase 1: deterministic Korean/English keyword lexicon, segment-scoped so a
// color word binds to the item in the same comma segment ("분홍색 단발머리").
// Phase 2 adds an embedding nearest-neighbour fallback for unknown words.

import type {
  AppearanceLayers, FaceAcc, HairShape, Headgear, OutfitStyle, Prop, Species,
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
  [/(트윈테일|양갈래|twin)/i, 'twintails'],
  [/(포니테일|묶은 머리|하나로 묶|ponytail)/i, 'ponytail'],
  [/(단발|보브|bob)/i, 'bob'],
  [/(장발|긴 머리|긴머리|생머리|흘러내리는|long hair|웨이브)/i, 'long'],
  [/(부스스|헝클|더벅|곱슬|산발|messy)/i, 'messy'],
  [/(대머리|민머리|삭발|bald)/i, 'bald'],
  [/(짧은 머리|숏컷|짧은머리|투블럭|스포츠|short)/i, 'short'],
];

const HEADGEAR: [RegExp, Headgear][] = [
  [/(베레모|beret)/i, 'beret'],
  [/(왕관|티아라|crown)/i, 'crown'],
  [/(고양이 ?귀|cat ?ears|고양이귀)/i, 'catEars'],
  [/(후드를 쓴|후드 쓴|두건|hood\b)/i, 'hood'],
  [/(헬멧|투구|helmet)/i, 'helmet'],
  [/(별 ?모양 ?머리핀|별 ?핀|머리핀|헤어핀|hairpin)/i, 'starPin'],
  [/(모자|캡|야구모자|cap|비니)/i, 'cap'],
  [/(머리 ?리본|헤어 ?리본)/i, 'ribbon'],
];

const OUTFIT: [RegExp, OutfitStyle][] = [
  [/(교복|세일러|uniform)/i, 'uniform'],
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
  [/(배낭|백팩|가방|backpack)/i, 'backpack'],
  [/(우산|umbrella)/i, 'umbrella'],
  [/(책|book|노트)/i, 'book'],
  [/(지팡이|스태프|staff|완드)/i, 'staff'],
  [/(서류 ?가방|브리프케이스|briefcase)/i, 'briefcase'],
];

const SPECIES: [RegExp, Species][] = [
  [/(고양이|냥이|cat|길냥)/i, 'cat'],
  [/(강아지|개|멍멍|dog|puppy|댕댕)/i, 'dog'],
  [/(새|참새|비둘기|까치|bird|앵무)/i, 'bird'],
];

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
): AppearanceLayers {
  const rng = makeRng(hashString(seed + '|' + appearance));
  const L: AppearanceLayers = {
    hairShape: pick<HairShape>(['short', 'bob', 'long', 'ponytail', 'messy', 'short'], rng()),
    hairColor: pick(DEFAULT_HAIR, rng()),
    headgear: 'none',
    headgearColor: '#c9a25c',
    outfitStyle: 'casual',
    outfitColor: pick(DEFAULT_OUTFIT, rng()),
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
    if (c) L.furColor = c;
    if (/(삼색|calico)/i.test(appearance)) L.furPattern = 'calico';
    else if (/(줄무늬|태비|tabby|치즈)/i.test(appearance)) L.furPattern = 'tabby';
    else if (/(턱시도|tuxedo|흑백)/i.test(appearance)) L.furPattern = 'tuxedo';
    if (/(작은|아기|새끼|꼬마|작고)/.test(appearance)) L.bodyScale = 0.8;
    if (/(큰|거대|덩치|뚱뚱|통통)/.test(appearance)) L.bodyScale = 1.25;
    return L;
  }

  for (const seg of segments) {
    const color = findColor(seg);
    const hair = /(머리|헤어|hair|발\b|금발|은발|단발|장발|트윈테일|포니테일|양갈래)/i.test(seg) ? match(HAIR, seg) : null;
    const isHairSeg = /(머리(?!핀)|헤어(?!핀)|hair|금발|은발|단발|장발|트윈테일|포니테일|양갈래|숏컷)/i.test(seg);
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
    } else if (color && !isHairSeg && !head && !prop && !face && /(옷|작업복|유니폼|셔츠|티셔츠|재킷|자켓|코트|니트|스웨터|조끼|점퍼|패딩|치마|바지)/.test(seg)) {
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
