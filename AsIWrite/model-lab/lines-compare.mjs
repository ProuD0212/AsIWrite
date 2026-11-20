// 대사 다듬기 비교: 같은 대사 10개를 게임의 실제 프롬프트·검사기로 — node lines-compare.mjs <모델> <dtype>
// 예) node lines-compare.mjs onnx-community/gemma-4-E2B-it-ONNX q4
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const T = await import('@huggingface/transformers');
// downloaded models live outside the repo (default: <repo>/../model-cache); override with MODEL_CACHE
T.env.cacheDir = process.env.MODEL_CACHE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../model-cache');
const [model, dtype] = process.argv.slice(2);
const V = await import('../src/ai/validate.ts');

const SYSTEM = [
  '너는 따뜻한 한국어 생활 소설 작가다. 게임 속 인물("윌")의 대사를 자연스럽게 다듬는다.',
  '규칙:',
  '1. 한국어로만 쓴다.',
  '2. 대사 한 줄(1~2문장, 50자 이내)만 출력한다. 따옴표, 이름표, 설명, 이모지는 붙이지 않는다.',
  '3. 초안의 뜻과 사실(이름, 사물, 장소)은 바꾸지 않는다. 새로운 사건을 지어내지 않는다.',
  '4. 화자의 성격과 기분이 말투에 드러나게 한다.',
  '5. [말투]에 적힌 대로 쓴다. "존댓말"이면 모든 문장을 ~요/~니다로 끝내고 상대를 "○○ 씨"로 부른다. "반말"이면 편하게 말하고 이름을 부를 수 있다.',
  '6. 상대에게 하는 말이다. 화자 자신을 3인칭으로 설명하거나 "~라고 물어봤어요"처럼 서술하지 않는다.',
  '7. 앞의 예시는 형식만 참고하고 내용은 가져오지 않는다. 지금 주어진 [화자]·[상황]·[초안]에 있는 것만 쓴다.',
].join('\n');
const EX = [
  [`[화자] 박철수 / 편의점 알바생 / 성격: 낙천적, 활발함 / 지금 기분: 좋음(70) / 특성: 노래방에서 노래하는 걸 좋아한다
[상대] 정하늘 / 관계: 절친
[말투] 반말
[상황] 별빛 코인노래방, 화제: 노래방
[초안] 하늘 씨, 이따 노래방 갈래요?
다듬은 대사:`, '하늘아, 이따 노래방 가자! 오늘 고음 제대로 뽑을 거야.'],
  [`[화자] 이영희 / 바리스타 / 성격: 다정함, 수줍음 / 지금 기분: 보통(55) / 특성: 남을 잘 챙긴다
[상대] 김민수 / 관계: 아는 사이
[말투] 존댓말
[상황] 골목 끝 카페, 화제: 점심
[초안] 김민수 씨, 점심 먹었어요?
다듬은 대사:`, '김민수 씨, 점심은 드셨어요? 바쁘셔도 끼니는 꼭 챙기세요.'],
];

// [speaker, listener (or null), relation, register, place, draft]
const cases = [
  ['윤지호 / 바리스타 / 성격: 다정함, 느긋함 / 지금 기분: 보통(55) / 특성: 고양이를 좋아한다', '한도윤', '아는 사이', 'polite', '골목 끝 카페, 화제: 고양이', '와, 그거 저도 좋아해요!'],
  ['박철수 / 편의점 알바생 / 성격: 낙천적, 활발함 / 지금 기분: 우울(30) / 특성: 오디션에 계속 떨어져 우울하다', '강보람', '친구', 'polite', '공원, 화제: 성격', '강보람 씨, 사실 저… 겉으로는 무뚝뚝하지만 속은 따뜻하거든요.'],
  ['한도윤 / 회사원 / 성격: 예민함, 호기심 / 지금 기분: 좋음(68) / 특성: 길고양이에게 몰래 밥을 챙겨준다', '윤지호', '서로 아끼는 사이', 'casual', '골목, 화제: 길고양이', '윤지호 씨, 혹시 길고양이에게 몰래 밥 챙겨요?'],
  ['김민수 / 회사원 / 성격: 다정함, 과묵함 / 지금 기분: 지침(28) / 특성: 매일 야근에 지쳐 있다', null, '', undefined, '한빛 사무실', '이 보고서 언제 끝나지…'],
  ['정하늘 / 대학생 / 성격: 수줍음, 다정함 / 지금 기분: 좋음(72) / 특성: 언젠가 고양이를 키우고 싶다', '김민수', '친구', 'polite', '공원, 화제: 기분', '김민수 씨, 오늘 기분 진짜 좋아요!'],
  ['이영희 / 바리스타 / 성격: 활발함 / 지금 기분: 보통(60) / 특성: 커피 향을 사랑한다', '최서연', '단골손님', 'polite', '골목 끝 카페', '어서 오세요!'],
  ['최서연 / 고등학생 / 성격: 내성적, 예민함 / 지금 기분: 보통(50) / 특성: 추리 소설 마니아다', '강보람', '절친', 'casual', '도서관, 화제: 추리 소설', '보람 씨, 요즘 추리 소설에 푹 빠져 있어요.'],
  ['강보람 / 공장 생산직 / 성격: 성실함 / 지금 기분: 좋음(66) / 특성: 기계 소리를 좋아한다', null, '', undefined, '새벽별 부품 공장', '기계 소리가 오늘따라 경쾌하네.'],
  ['한도윤 / 회사원 / 성격: 예민함 / 지금 기분: 보통(50) / 특성: 비 오는 날을 싫어한다', '박철수', '서먹한 사이', 'polite', '공원, 화제: 날씨', '박철수 씨, 오늘 날씨 어때요?'],
  ['박철수 / 편의점 알바생 / 성격: 낙천적 / 지금 기분: 좋음(75) / 특성: 노래방에서 노래하는 걸 좋아한다', '정하늘', '절친', 'casual', '별빛 코인노래방, 화제: 노래방', '하늘 씨, 오늘 고음 제대로 올라갈 것 같아요!'],
];

const gen = await T.pipeline('text-generation', model, { dtype, device: 'cpu' });
let pass = 0;
for (const [s, l, rel, reg, w, d] of cases) {
  const user = [`[화자] ${s}`, l ? `[상대] ${l} / 관계: ${rel}` : '[상대] 혼잣말', `[말투] ${l ? (reg === 'casual' ? '반말' : '존댓말') : '혼잣말 (편하게)'}`, `[상황] ${w}`, `[초안] ${d}`, '다듬은 대사:'].join('\n');
  const msgs = [{ role: 'system', content: SYSTEM }, ...EX.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]), { role: 'user', content: user }];
  const t1 = Date.now();
  const out = await gen(msgs, { max_new_tokens: 60, do_sample: true, temperature: 0.4, top_k: 30, top_p: 0.85, repetition_penalty: 1.1, no_repeat_ngram_size: 4 });
  const g = out[0].generated_text;
  const raw = typeof g === 'string' ? g : g.at(-1).content;
  const ok = V.cleanOutput(raw, 'line', d, reg, l ? [ {한도윤:'한도윤',강보람:'강보람',윤지호:'윤지호',김민수:'김민수',최서연:'최서연',박철수:'박철수',정하늘:'정하늘'}[l], l.slice(1)] : []);
  if (ok) pass++;
  console.log(`- [${l ? (reg === 'casual' ? '반말' : '존댓말') : '혼잣말'}] 초안: ${d}\n  ${ok ? '통과' : '거절'}: ${raw.trim().replace(/\n/g, ' ⏎ ')}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
}
console.log(`통과 ${pass}/${cases.length}`);
