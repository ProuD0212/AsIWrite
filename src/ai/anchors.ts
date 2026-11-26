// Calibration anchors for the meaning model. Groups of texts that belong together; pairs inside
// a group are "same meaning", pairs across groups are "different meaning". Kept separate for
// short phrases ("고양이" vs "길고양이") and whole trait sentences, because embedding models
// behave very differently on the two (measured: see 요청_및_진행현황.md 4-38).

export const PHRASE_GROUPS: string[][] = [
  ['고양이', '길고양이', '검은 고양이', '고양이 발바닥'],
  ['커피', '카페라떼', '아메리카노', '카페'],
  ['노래', '노래방', '애니송 부르기', '트로트'],
  ['책', '추리 소설', '도서관', '소설책'],
  ['비 오는 날', '소나기', '빗소리', '장마'],
  ['강아지', '강아지 산책', '댕댕이', '골든 리트리버'],
  ['빵', '갓 구운 빵', '빵집', '크루아상'],
  ['운동', '헬스', '조깅', '근력 운동'],
  ['영화', '영화관', '심야 영화', '팝콘'],
  ['꽃', '꽃다발', '장미', '꽃집'],
  ['맥주', '술집', '소주 한잔', '퇴근길 맥주'],
  ['시험', '시험 공부', '중간고사', '성적표'],
  ['큰 소리', '시끄러운 소음', '고함', '경적 소리'],
  ['벌레', '바퀴벌레', '모기', '거미'],
];

export const SENTENCE_GROUPS: string[][] = [
  ['고양이를 정말 좋아한다', '길고양이에게 몰래 밥을 챙겨준다', '언젠간 고양이를 키우고 싶다'],
  ['노래방에서 노래하는 걸 좋아한다', '몰래 노래방에서 애니송을 부른다', '밴드로 데뷔하는 것이 꿈이다'],
  ['도서관에서 책 읽는 것을 가장 좋아한다', '추리 소설 마니아다', '책 냄새를 좋아한다'],
  ['매일 야근에 지쳐 있다', '회사 일이 너무 많아 피곤하다', '퇴근만 기다리며 산다'],
  ['비 오는 날을 싫어한다', '장마철이면 우울해진다', '빗소리를 들으면 기분이 가라앉는다'],
  ['운동하는 걸 좋아한다', '매일 아침 조깅을 한다', '헬스장에 가는 게 낙이다'],
  ['커피 향을 사랑한다', '하루에 커피를 세 잔 마신다', '라떼 아트를 연습한다'],
];

/** short noun-ish text (vs a full trait sentence) → which calibration applies */
export function isPhrase(t: string): boolean {
  const s = t.trim();
  return s.length <= 10 && !/(다|요|죠|네)[.!?…]*$/.test(s);
}
