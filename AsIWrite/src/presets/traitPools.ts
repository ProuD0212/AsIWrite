// Random sentence-trait generator used when something is placed without
// traits ("최초로 배치할 때 태그들이 랜덤하게 달림").
//
// Traits are COMPOSED from categories (personality × likes × dislikes ×
// habits × quirks × dreams × backstory) and context-specific topic lists, so a
// handful of lists yields thousands of distinct, coherent characters. The
// simulation never depends on these exact strings: engine/traits.ts interprets
// any sentence (including user-typed ones) by similarity.

import { josa } from '../engine/traits';
import { makeRng, pick } from '../engine/util';

// ───────────────────────── shared personality (개성) ─────────────────────────
const PERSONALITY = [
  '잘 웃는다', '걱정이 많은 편이다', '정이 많다', '쉽게 화를 낸다', '낯을 많이 가린다', '누구에게나 먼저 말을 건다',
  '혼자 있는 시간이 필요하다', '사람들과 수다 떠는 것을 좋아한다', '꿈을 포기하지 않았다', '눈물이 많다', '털털하다',
  '호기심이 많다', '겉으로는 무뚝뚝하지만 속은 따뜻하다', '거짓말을 못 한다', '고집이 세다', '남의 부탁을 거절하지 못한다',
  '자존심이 강하다', '칭찬을 받으면 쑥스러워한다', '분위기 메이커다', '말수가 적다', '생각이 많다', '즉흥적이다', '계획적이다',
  '예민한 편이다', '덤벙거린다', '책임감이 강하다', '귀가 얇다', '승부욕이 강하다', '허세가 조금 있다', '의외로 겁이 많다',
  '감수성이 풍부하다', '남의 기분을 잘 살핀다', '참을성이 많다', '성격이 급하다', '낙천적이다', '비관적인 편이다',
  '질투가 많다', '솔직하다', '엉뚱하다', '진지하다', '장난기가 많다', '조용하지만 관찰력이 좋다', '리더십이 있다',
  '외로움을 잘 탄다', '자기 일에 철저하다', '의리가 있다', '부끄러움이 많다', '수다스럽다', '느긋하다', '부지런하다',
  '게으른 편이다', '쉽게 감동한다', '독설가지만 틀린 말은 안 한다', '남 몰래 선행을 한다', '정의감이 강하다',
  '뒤끝이 없다', '뒤끝이 길다', '상상력이 풍부하다', '현실적이다', '눈치가 빠르다', '눈치가 없다', '잘 삐진다',
];

const LIKE_TEMPLATES = [
  (x: string) => `${josa(x, '을/를')} 좋아한다`,
  (x: string) => `${josa(x, '을/를')} 정말 좋아한다`,
  (x: string) => `요즘 ${x}에 푹 빠져 있다`,
  (x: string) => `${x} 이야기만 나오면 눈이 반짝인다`,
  (x: string) => `${josa(x, '을/를')} 사랑한다`,
  (x: string) => `남몰래 ${josa(x, '을/를')} 즐긴다`,
  (x: string) => `${josa(x, '이/가')} 삶의 낙이다`,
];
const DISLIKE_TEMPLATES = [
  (x: string) => `${josa(x, '을/를')} 싫어한다`,
  (x: string) => `${josa(x, '을/를')} 무서워한다`,
  (x: string) => `${josa(x, '이/가')} 질색이다`,
  (x: string) => `${josa(x, '을/를')} 싫어해서 피해 다닌다`,
];

type Pool = {
  likes: string[];
  dislikes: string[];
  habits: string[];
  dreams: string[];
  backstory: string[];
  animals: string[];
  names: string[];
  roles: string[];
};

const MODERN: Pool = {
  likes: [
    '고양이', '강아지', '커피', '라떼', '노래방', '발라드', '아이돌 음악', '인디 음악', '재즈', '기타 연주', '비 오는 날', '눈 오는 날',
    '달콤한 간식', '떡볶이', '붕어빵', '치킨', '라면', '편의점 신상 과자', '맛집 탐방', '책 읽기', '추리 소설', '만화책', '웹툰',
    '사진 찍기', '산책', '공원 벤치', '게임', '보드게임', '운동', '등산', '자전거', '요리', '베이킹', '꽃', '식물 키우기', '별 보기',
    '영화', '공포 영화', '로맨스 드라마', '애니메이션', '그림 그리기', '일기 쓰기', '캠핑', '바다', '여행', '레트로 소품', '향수',
    '빈티지 옷', '야구', '축구', '춤', '뜨개질', '퍼즐', '우주 다큐멘터리', '역사 이야기', '옛날 노래', '조용한 카페', '새벽 공기',
  ],
  dislikes: ['비 오는 날', '강아지', '벌레', '시끄러운 곳', '사람 많은 곳', '야근', '오이', '매운 음식', '천둥', '거짓말', '월요일', '높은 곳', '어둠', '잔소리'],
  habits: [
    '퇴근길 편의점 맥주 한 캔이 낙이다', '매일 아침 같은 카페에 들른다', '밤늦게 공원 벤치에서 생각을 정리한다', '길고양이에게 몰래 밥을 챙겨준다',
    '긴장하면 머리를 긁는다', '혼잣말을 자주 한다', '이어폰을 항상 끼고 다닌다', '하루에 커피를 세 잔 마신다', '사진으로 하루를 기록한다',
    '좋아하는 노래를 흥얼거리며 걷는다', '사람 이름을 잘 잊어버린다', '모르는 사람에게도 인사를 한다', '노래방 탬버린 담당이다',
    '매일 밤 일기를 쓴다', '중요한 날엔 꼭 같은 옷을 입는다', '배고프면 예민해진다', '화가 나면 말없이 산책을 나간다',
  ],
  dreams: [
    '언젠가 밴드로 데뷔하는 것이 꿈이다', '작은 카페를 차리는 것이 꿈이다', '고양이를 키우는 것이 꿈이다', '세계 일주가 꿈이다',
    '웹툰 작가가 되는 것이 꿈이다', '가족에게 집을 사드리는 것이 꿈이다', '자기 이름으로 된 책을 내는 것이 꿈이다', '유명한 요리사가 되는 것이 꿈이다',
    '언젠가 오로라를 보는 것이 꿈이다', '평범하게 사는 것이 꿈이다',
  ],
  backstory: [
    '요즘 일이 잘 풀리지 않아 우울하다', '최근 이사 와서 아는 사람이 없다', '오디션에 계속 떨어지고 있다', '얼마 전 실연을 당했다',
    '시험 기간이라 조금 예민하다', '어릴 적 키우던 고양이를 그리워한다', '고향을 떠나 혼자 살고 있다', '최근 승진해서 들떠 있다',
    '오랜 친구와 연락이 끊겨 아쉬워한다', '퇴사를 고민 중이다', '첫 월급을 받아 기분이 좋다',
  ],
  animals: ['햇볕 아래서 낮잠 자는 걸 좋아한다', '사람을 잘 따른다', '경계심이 많다', '간식을 주는 사람을 기억한다', '장난치는 걸 좋아한다', '비를 싫어한다', '기타 소리를 좋아한다', '높은 곳에 올라가는 걸 좋아한다', '호기심이 많다', '겁이 많다'],
  names: ['김지훈', '이수빈', '박서준', '최유나', '정민재', '강하은', '조현우', '윤채원', '임도현', '한소희', '오세진', '신예린', '서강민', '권나연', '황태오', '문가람', '배준호', '송다인', '유하람', '장은솔', '고민지', '남궁현', '하지원', '설태양', '엄나래', '진서우', '표하린', '육도윤', '변소율', '맹지석', '추은비', '탁건우', '방예나', '노을', '차가온', '연시우', '마루', '봄이', '여름', '한결'],
  roles: ['대학생', '회사원', '바리스타', '고등학생', '프리랜서 디자이너', '편의점 알바생', '작가 지망생', '퇴직한 어르신', '배달 기사', '간호사', '초등학교 선생님'],
};

const FANTASY: Pool = {
  likes: ['용', '마법', '검술 수련', '선술집 음악', '약초', '별자리', '모험 이야기', '고대 유적', '갓 구운 빵', '음유시인의 노래', '마법 고양이', '숲의 정령', '보석', '전설'],
  dislikes: ['어둠의 마법', '고블린', '왕국의 세금', '거미', '천둥', '배신'],
  habits: ['매일 새벽 검을 닦는다', '여관에서 늘 같은 자리에 앉는다', '숲에 들어가면 정령에게 인사한다', '모르는 주문을 중얼거린다'],
  dreams: ['왕국의 기사가 되는 것이 꿈이다', '대마법사가 되는 것이 꿈이다', '용을 길들이는 것이 꿈이다', '전설 속 보물을 찾는 것이 꿈이다'],
  backstory: ['고향 마을이 불타 떠돌고 있다', '마법학교에서 쫓겨났다', '잃어버린 형제를 찾고 있다', '왕족의 숨겨진 핏줄이라는 소문이 있다'],
  animals: ['마법의 기운에 민감하다', '모험가를 따라다닌다', '반짝이는 것을 좋아한다'],
  names: ['아렌', '리리엘', '브람', '세렌', '토린', '엘라', '카이란', '미르', '로웬', '이솔데', '가렛', '펠리아'],
  roles: ['견습 기사', '떠돌이 음유시인', '마법학교 학생', '약초상', '대장장이', '여관 주인'],
};

const APOCALYPSE: Pool = {
  likes: ['통조림', '라디오', '작은 텃밭', '기타', '옛날 사진', '깨끗한 물', '해 질 녘 하늘', '오래된 책', '불멍'],
  dislikes: ['좀비 소리', '어둠', '배신', '빈 통조림', '사이렌 소리'],
  habits: ['잠들기 전 무기를 꼭 확인한다', '라디오로 생존자 신호를 찾는다', '빈 건물에 들어가면 먼저 귀를 기울인다', '아이들에게 옛날이야기를 들려준다'],
  dreams: ['안전한 마을을 세우는 것이 꿈이다', '가족을 다시 만나는 것이 꿈이다', '다시 바다를 보는 것이 꿈이다'],
  backstory: ['무너지기 전의 도시를 그리워한다', '밤에는 잠을 잘 이루지 못한다', '동료를 잃은 적이 있다', '누구도 쉽게 믿지 않는다'],
  animals: ['위험을 먼저 알아챈다', '사람 곁을 떠나지 않는다', '먹을 것을 잘 찾는다'],
  names: ['재건', '희망', '레이', '도겸', '마야', '진', '하율', '서준', '노아'],
  roles: ['생존자', '정찰병', '의무병', '정비공', '방랑자'],
};

const CYBER: Pool = {
  likes: ['네온사인', '해킹', '레트로 음악', '진짜 커피', '비 오는 밤거리', '의체 튜닝', '옛날 게임기', '홀로그램 아이돌'],
  dislikes: ['거대 기업', '감시 드론', '정전', '가짜 음식'],
  habits: ['항상 후드를 눌러쓴다', '말끝마다 코드 용어를 쓴다', '골목 포장마차의 단골이다'],
  dreams: ['기업의 비밀을 폭로하는 것이 꿈이다', '진짜 하늘을 보는 것이 꿈이다'],
  backstory: ['기억 일부를 잃어버렸다', '빚 때문에 위험한 일을 한다', '예전엔 기업 연구원이었다'],
  animals: ['전자음에 반응한다', '네온 불빛을 쫓아다닌다'],
  names: ['네오', '키라', '제트', '루나', '아이언', '사이', '바이퍼'],
  roles: ['해커', '배달 라이더', '의체 기술자', '바텐더'],
};

export function poolFor(context: string): Pool {
  if (/(판타지|중세|마법|왕국|fantasy)/i.test(context)) return FANTASY;
  if (/(아포칼립스|좀비|멸망|폐허|apocalypse)/i.test(context)) return APOCALYPSE;
  if (/(사이버|네온|미래|cyber)/i.test(context)) return CYBER;
  return MODERN;
}

const stemOf = (t: string) => t.replace(/\s*(을|를|이|가)?\s*(정말\s*)?(좋아한다|싫어한다|무서워한다|질색이다|사랑한다).*$/, '').replace(/^요즘\s*/, '');

/**
 * Compose `count` random traits. Mix: 2 personality, 2-3 likes, ≤1 dislike,
 * 1 habit, 1 dream or backstory. Avoids liking and disliking the same thing.
 */
export function randomTraits(context: string, kind: 'person' | 'animal', count: number, seed: number, exclude: string[] = []): string[] {
  const rng = makeRng(seed);
  const pool = poolFor(context);
  const out: string[] = [];
  const stems = new Set(exclude.map(stemOf));
  const add = (t: string | undefined) => {
    if (!t || out.length >= count) return;
    const s = stemOf(t);
    if (out.includes(t) || exclude.includes(t) || stems.has(s)) return;
    stems.add(s);
    out.push(t);
  };
  if (kind === 'animal') {
    for (let k = 0; k < 20 && out.length < count; k++) add(pick(pool.animals, rng()));
    return out;
  }
  const plan: (() => string)[] = [
    () => pick(PERSONALITY, rng()),
    () => pick(LIKE_TEMPLATES, rng())(pick(pool.likes, rng())),
    () => pick(PERSONALITY, rng()),
    () => pick(LIKE_TEMPLATES, rng())(pick(pool.likes, rng())),
    () => pick(pool.habits, rng()),
    () => (rng() < 0.5 ? pick(pool.dreams, rng()) : pick(pool.backstory, rng())),
    () => pick(DISLIKE_TEMPLATES, rng())(pick(pool.dislikes, rng())),
    () => pick(LIKE_TEMPLATES, rng())(pick(pool.likes, rng())),
    () => pick(PERSONALITY, rng()),
    () => pick(pool.backstory, rng()),
  ];
  for (let pass = 0; pass < 4 && out.length < count; pass++) for (const f of plan) add(f());
  return out;
}

export function randomName(context: string, seed: number, taken: Set<string>): string {
  const rng = makeRng(seed);
  const names = poolFor(context).names;
  for (let k = 0; k < 30; k++) {
    const n = pick(names, rng());
    if (!taken.has(n)) return n;
  }
  return `${pick(names, rng())}${Math.floor(rng() * 90 + 10)}`;
}

const HAIR_WORDS = ['짧은 검은 머리', '갈색 단발머리', '긴 생머리', '금발 포니테일', '부스스한 머리', '은색 짧은 머리', '분홍색 트윈테일', '파란 단발머리', '밤색 웨이브 머리', '빨간 긴 머리', '민트색 숏컷', '검은 포니테일'];
const OUTFIT_MODERN = ['파란 후드티', '남색 정장', '베이지 셔츠', '빨간 후드티', '교복', '노란 원피스', '초록색 앞치마', '검은 재킷', '하늘색 셔츠', '보라색 니트', '회색 후드티', '흰 셔츠'];
const OUTFIT_FANTASY = ['보라색 망토', '은빛 갑옷', '갈색 로브', '초록 망토', '붉은 망토', '남색 로브'];
const OUTFIT_APOC = ['카키 재킷', '낡은 회색 후드티', '검은 우비', '헤진 갈색 코트'];
const OUTFIT_CYBER = ['검은 재킷', '네온 보라 후드티', '은색 재킷', '민트색 후드티'];
const ACCS = ['', '', '뿔테 안경', '선글라스', '홍조', '수염', '베레모', '야구 모자', '배낭', '책', '기타 케이스', '우산', '별 모양 머리핀', '고양이 귀 머리띠', '서류 가방'];
const ACC_FANTASY = ['', '지팡이', '대검', '왕관', '후드를 쓴', '안대', '책', '배낭'];
const ACC_APOC = ['', '배낭', '헬멧', '안대', '대검', '선글라스'];
const ANIMAL_COLORS = ['노란 줄무늬', '검은', '하얀', '회색', '삼색', '턱시도', '갈색'];

/** A random free-text appearance in the current world context. */
export function randomAppearance(context: string, kind: 'person' | 'animal', category: string, seed: number): string {
  const rng = makeRng(seed ^ 0x9e3779b9);
  if (kind === 'animal') {
    const what = /(강아지|개|dog)/.test(category) ? '강아지' : /(새|bird)/.test(category) ? '새' : '고양이';
    return `${pick(ANIMAL_COLORS, rng())} ${what}${rng() < 0.4 ? ', 작은' : ''}`;
  }
  const pool = poolFor(context);
  const outfits = pool === FANTASY ? OUTFIT_FANTASY : pool === APOCALYPSE ? OUTFIT_APOC : pool === CYBER ? OUTFIT_CYBER : OUTFIT_MODERN;
  const accs = pool === FANTASY ? ACC_FANTASY : pool === APOCALYPSE ? ACC_APOC : ACCS;
  const parts = [pick(HAIR_WORDS, rng()), pick(outfits, rng()), pick(accs, rng()), pick(accs, rng())].filter(Boolean);
  return [...new Set(parts)].join(', ');
}

export function randomRole(context: string, seed: number): string {
  return pick(poolFor(context).roles, makeRng(seed)());
}

// ───────────────────────── treasured items (애착 물건) ─────────────────────────
const TREASURE: Record<'modern' | 'fantasy' | 'apocalypse' | 'cyber', string[]> = {
  modern: [
    '할머니가 떠 주신 빨간 목도리', '첫 월급으로 산 만년필', '낡은 필름 카메라', '어릴 적 친구와 나눠 가진 우정 팔찌', '멈춰 버린 아버지의 손목시계',
    '이름 모를 인디 가수의 사인 CD', '닳고 닳은 기타 피크', '엄마가 싸 주던 도시락통', '뒷면에 낙서가 가득한 행운의 동전', '모서리가 해진 일기장',
    '수학여행 때 산 열쇠고리', '한 번도 안 신은 운동화', '첫 공연 티켓', '고양이 털이 묻은 담요', '빛바랜 가족사진', '손때 묻은 추리 소설 한 권',
    '친구가 그려 준 캐리커처', '녹음이 지워지지 않는 낡은 MP3', '파란 접이식 우산', '네잎클로버 책갈피',
  ],
  fantasy: ['스승에게 물려받은 낡은 지팡이', '어머니의 은 펜던트', '고향 마을의 흙 한 줌이 든 주머니', '이가 빠진 첫 번째 검', '정령이 깃들었다는 조약돌', '읽을 수 없는 문자로 쓰인 책'],
  apocalypse: ['녹슨 휴대용 라디오', '마지막 가족사진', '아직 따지 않은 복숭아 통조림', '잃어버린 동료의 군번줄', '태엽을 감으면 아직 울리는 오르골', '물에 젖었다 마른 지도'],
  cyber: ['구형 스마트폰', '옛 연인의 홀로그램 메시지 칩', '종이로 된 진짜 책', '첫 의체 수술 때 빼낸 나사', '네온이 고장 난 배지'],
};
const ANIMAL_TREASURE = ['구석에 숨겨 둔 병뚜껑', '햇볕 드는 벤치 자리', '누가 준 털실 뭉치', '좋아하는 상자', '반짝이는 유리 조각', '낡은 테니스공'];

export function randomTreasure(context: string, kind: 'person' | 'animal', seed: number): string {
  const rng = makeRng(seed ^ 0x51ed27);
  if (kind === 'animal') return pick(ANIMAL_TREASURE, rng());
  const pool = poolFor(context);
  const key = pool === FANTASY ? 'fantasy' : pool === APOCALYPSE ? 'apocalypse' : pool === CYBER ? 'cyber' : 'modern';
  return pick(TREASURE[key], rng());
}
