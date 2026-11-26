// Gender, names and looks for Wills.
//
// Gender shapes the defaults — "mostly", never always: women are mostly given long hair and skirts,
// men short hair and trousers, and names follow the same pattern. Anything the player writes wins.

import type { Gender } from '../engine/types';
import { makeRng, pick } from '../engine/util';
import type { WorldTheme } from '../engine/worldTheme';

export const GENDER_LABEL: Record<Gender, string> = { female: '여성', male: '남성', other: '기타' };

/** "[성별] 여" / "여자 대학생" / "할아버지" → gender (null = not said) */
export function genderFromText(text: string): Gender | null {
  const t = text.trim();
  if (/^(여|여성|여자|female|f|woman|girl)$/i.test(t)) return 'female';
  if (/^(남|남성|남자|male|m|man|boy)$/i.test(t)) return 'male';
  if (/^(기타|논바이너리|nonbinary|other|무성|없음)$/i.test(t)) return 'other';
  if (/(여자|여성|소녀|할머니|아줌마|아주머니|언니|누나|엄마|어머니|아가씨|공주|여왕|마녀|여신|여학생|숙녀|새댁|낭자|아씨)/.test(t)) return 'female';
  if (/(남자|남성|소년|할아버지|아저씨|오빠|아빠|아버지|왕자|국왕|황제|남학생|신사|총각|도령|선비|청년)/.test(t)) return 'male';
  return null;
}

export function randomGender(seed: number): Gender {
  const r = makeRng(seed ^ 0x6d2b79f5)();
  return r < 0.48 ? 'female' : r < 0.96 ? 'male' : 'other';
}

// ───────────────────────── names ─────────────────────────
// Korean given names: a curated list + a syllable generator, so a big town never runs out
// (the old pool ran dry and fell back to "김지훈54").
const KO_F = ['수빈', '유나', '하은', '채원', '소희', '예린', '나연', '가람', '다인', '하람', '은솔', '민지', '지원', '나래', '서우', '하린', '소율', '은비', '예나', '나윤', '서율', '지안', '로아', '세아', '채아', '윤슬', '서연', '지민', '수아', '다은', '아린', '보민', '혜원', '시은', '연우', '주하'];
const KO_M = ['지훈', '서준', '민재', '현우', '도현', '세진', '강민', '태오', '준호', '도윤', '지석', '건우', '도겸', '태윤', '이든', '준서', '가온', '시우', '하준', '은호', '재민', '현수', '동훈', '승민', '우진', '성현', '규민', '정우', '한결', '윤재'];
const F1 = ['서', '지', '하', '수', '유', '예', '채', '민', '윤', '소', '다', '은', '가', '나', '아', '혜', '세', '시', '연', '주', '보', '미', '별', '초'];
const F2 = ['연', '은', '아', '윤', '린', '원', '희', '현', '진', '빈', '영', '서', '나', '율', '경', '미', '정', '리', '인', '하', '람', '솔', '온', '비'];
const M1 = ['민', '준', '도', '서', '현', '지', '우', '시', '건', '태', '정', '재', '성', '승', '하', '동', '은', '영', '주', '진', '윤', '강', '한', '규'];
const M2 = ['준', '호', '우', '진', '현', '민', '훈', '혁', '빈', '성', '원', '석', '수', '율', '환', '윤', '규', '겸', '찬', '오', '결', '후', '재', '범'];

function koGiven(g: Gender, rng: () => number): string {
  const female = g === 'female' || (g === 'other' && rng() < 0.5);
  if (rng() < 0.4) return pick(female ? KO_F : KO_M, rng());
  const [a, b] = female ? [F1, F2] : [M1, M2];
  for (let k = 0; k < 6; k++) {
    const n = pick(a, rng()) + pick(b, rng());
    if (n[0] !== n[1]) return n;
  }
  return pick(female ? KO_F : KO_M, rng());
}

/** given names for worlds where the given name comes first ("아렌 블랙우드") */
const WEST_GIVEN: Partial<Record<WorldTheme, { f: string[]; m: string[] }>> = {
  fantasy: { f: ['리리엘', '세렌', '엘라', '이솔데', '펠리아', '아이린', '로제타', '미레야', '셀린', '에스텔', '니나', '오필리아', '레아', '클로에'], m: ['아렌', '브람', '토린', '카이란', '로웬', '가렛', '에드릭', '레오닉', '칼렌', '루시안', '오스카', '테오도르', '알릭', '펠릭스'] },
  cyber: { f: ['키라', '루나', '노바', '미코', '제나', '아이리스', '사야', '레나', '유키'], m: ['네오', '제트', '바이퍼', '렉스', '카토', '데커', '조니', '케인', '레오'] },
  pirate: { f: ['로즈', '마린', '코라', '넬라', '시엘', '펄', '앤', '메리'], m: ['잭', '해랑', '플린트', '모건', '윌리엄', '토마스', '빌리', '닉'] },
  space: { f: ['베가', '루나', '아스트라', '스텔라', '리라', '카시', '미라', '아이라'], m: ['오리온', '카이', '시리우스', '레오', '타이탄', '아틀라스', '이온', '노아'] },
};
/** Korean-style worlds with their own flavour of given names */
const KO_THEMED: Partial<Record<WorldTheme, { f: string[]; m: string[] }>> = {
  joseon: { f: ['연이', '단비', '설화', '향이', '순이', '옥분', '꽃님', '분이', '달래', '보름'], m: ['석주', '무영', '도령', '갑돌', '돌쇠', '만석', '수봉', '천복', '덕배', '을용'] },
  apocalypse: { f: ['마야', '하율', '희망', '새벽', '윤슬', '바람'], m: ['재건', '레이', '도겸', '서준', '노아', '강철'] },
};

export function givenNameFor(theme: WorldTheme, g: Gender, rng: () => number): { name: string; west: boolean } {
  const west = WEST_GIVEN[theme];
  const female = g === 'female' || (g === 'other' && rng() < 0.5);
  if (west) return { name: pick(female ? west.f : west.m, rng()), west: true };
  const themed = KO_THEMED[theme];
  if (themed && rng() < 0.6) return { name: pick(female ? themed.f : themed.m, rng()), west: false };
  return { name: koGiven(g, rng), west: false };
}

// ───────────────────────── looks ─────────────────────────
const HAIR_F = ['긴 생머리', '갈색 단발머리', '검은 포니테일', '밤색 웨이브 머리', '양갈래 땋은 머리', '똥머리', '금발 긴 머리', '분홍색 트윈테일', '파란 단발머리', '빨간 긴 머리', '갈색 곱슬 단발머리', '검은 긴 머리', '하나로 땋은 머리', '은색 웨이브 머리'];
const HAIR_M = ['짧은 검은 머리', '가르마 머리', '부스스한 머리', '삐죽 솟은 머리', '짧게 민 머리', '갈색 곱슬머리', '은색 짧은 머리', '민트색 숏컷', '금발 짧은 머리', '검은 댄디 머리', '투블럭 머리', '갈색 가르마 머리', '검은 곱슬머리', '하나로 묶은 머리'];
const BOTTOM_F = ['검은 치마', '플리츠 치마', '청바지', '베이지 롱스커트', '체크 치마', '검은 슬랙스', '데님 치마', '하얀 롱스커트', '남색 치마'];
const BOTTOM_M = ['청바지', '검은 슬랙스', '베이지 면바지', '회색 트레이닝 바지', '반바지', '카키 카고 바지', '남색 바지', '검은 청바지'];

export function hairWordFor(g: Gender, rng: () => number): string {
  if (g === 'other') return pick(rng() < 0.5 ? HAIR_F : HAIR_M, rng());
  // mostly — about one in seven goes the other way
  const mine = g === 'female' ? HAIR_F : HAIR_M, theirs = g === 'female' ? HAIR_M : HAIR_F;
  return pick(rng() < 0.86 ? mine : theirs, rng());
}
export function bottomWordFor(g: Gender, rng: () => number): string {
  if (g === 'female') return pick(BOTTOM_F, rng());
  if (g === 'male') return pick(BOTTOM_M, rng());
  return pick(rng() < 0.6 ? BOTTOM_M : BOTTOM_F, rng());
}
/** outfits that read as one gender (filtered out for the other, unless the player writes them) */
export function outfitFits(outfit: string, g: Gender): boolean {
  if (g === 'male') return !/(원피스|드레스|저고리|치마)/.test(outfit);
  return true;
}
