// Layer-1 (0ms) dialogue: template lines picked by situation & shared topic.
// Phase 2 picks the template by embedding similarity and Layer-2 LLM lines
// replace them asynchronously when ready — characters never freeze waiting.

import { josa, toGeodeunyo } from '../engine/traits';
import { pick } from '../engine/util';

export const GREET = ['안녕하세요!', '어, 또 만났네요.', '오늘 날씨 어때요?', '어디 가는 길이에요?', '오랜만이에요!'];
export const GREET_CLOSE = ['야, 반가워!', '오늘도 왔구나!', '딱 너 생각하고 있었어.', '왔어? 기다렸잖아~'];
export const GREET_COLD = ['…아, 네.', '(못 본 척하고 싶다…)', '또 당신이에요?'];

export const HAPPY = ['오늘 기분 진짜 좋아요!', '하하, 그거 웃기다!', '나도 그거 좋아해요!', '역시 말이 잘 통하네요.'];
export const SAD = ['요즘 좀 힘드네요…', '그냥… 아무것도 하기 싫어요.', '하아… 됐어요.', '괜찮은 척하는 것도 지쳐요.'];
export const COMFORT = ['무슨 일 있어요? 얘기해 봐요.', '힘내요, 제가 들어줄게요.', '괜찮아요, 다 잘 될 거예요.', '같이 뭐라도 먹으러 갈래요?'];
export const ARGUE = ['지금 뭐라고 했어요?', '그건 아니죠!', '말 좀 가려서 하세요.', '진짜 짜증 나네.'];
export const SIGH = ['하아…', '…', '왜 나만 이럴까.', '집에 가고 싶다.'];
export const SAD_SONG = ['♪ 비가 오면~ 생각나는 그 사람…', '♪ 혼자라는 게… 익숙해…', '♪ 라라라… 라…'];
export const HUM = ['♪ 흥~ 흥흥~', '♪ 라라라~', '♪ 오늘도 좋은 날~'];

/** topic keyword → lines about it. {p} = partner name */
export const TOPIC_LINES: [RegExp, string[]][] = [
  [/고양이|냥/, ['혹시 저 골목 치즈 고양이 봤어요?', '고양이 발바닥은 진짜 반칙이에요.', '언젠간 고양이 키우고 싶어요.']],
  [/노래|노래방|음악|기타|밴드|애니송/, ['이따 노래방 갈래요?', '요즘 꽂힌 노래가 있는데 들어볼래요?', '저 고음 연습 중이에요!']],
  [/커피|카페|라떼|바리스타/, ['물방울 카페 라떼 마셔봤어요?', '커피 없으면 저 못 살아요.', '라떼 아트로 고양이 그려줄 수 있어요?']],
  [/책|도서관|소설|추리/, ['요즘 무슨 책 읽어요?', '그 추리 소설 범인… 아니에요, 스포 안 할게요.', '도서관 만화책 코너 가봤어요?']],
  [/간식|과자|맛집|빵|편의점/, ['편의점 신상 과자 먹어봤어요?', '맛있는 거 먹으러 갈래요?', '달달한 거 먹으면 기분 좋아져요.']],
  [/비 오는|비가|비를/, ['비 오는 날엔 괜히 센치해져요.', '빗소리 듣는 거 좋아해요?', '우산 챙겼어요?']],
  [/야근|일|회사|시험|공부/, ['요즘 너무 바빠서 정신이 없어요.', '오늘도 야근이에요?', '시험 끝나면 놀러 가요.']],
  [/공원|산책|벤치/, ['공원 한 바퀴 돌래요?', '저 벤치가 명당이에요.', '산책하면 머리가 맑아져요.']],
  [/사진/, ['여기 사진 찍으면 예쁘겠다!', '찰칵! 잘 나왔어요.']],
  [/옛날|은퇴|터줏대감/, ['내가 젊었을 때는 말이야…', '이 동네도 많이 변했지.']],
  [/웃|발랄|유쾌/, ['웃어요! 웃으면 복이 와요!', '제가 재밌는 얘기 해줄까요?']],
  [/용|마법|기사|모험/, ['어젯밤 북쪽 하늘에 용이 날았대요!', '마법 수업은 어땠어요?']],
  [/좀비|생존|통조림|폐허/, ['오늘 밤도 무사히 넘겨야 할 텐데.', '통조림 남은 거 있어요?']],
];

export const ANIMAL_SOUNDS: Record<string, string[]> = {
  cat: ['냐아~', '야옹.', '골골골…', '먀!'],
  dog: ['멍!', '왈왈!', '킁킁…', '끼잉~'],
  bird: ['짹짹!', '삐요~'],
  creature: ['…크르릉.', '그르르…'],
  rabbit: ['(코를 씰룩씰룩)', '(깡총!)', '푸웅…'],
  hamster: ['찍찍!', '(볼주머니가 빵빵하다)', '(쳇바퀴 도는 소리)'],
  duck: ['꽥꽥!', '꽥!', '(뒤뚱뒤뚱)'],
  fox: ['캥!', '꺄웅~', '(꼬리를 살랑)'],
  hedgehog: ['킁킁.', '(가시를 세운다)', '(동그랗게 몸을 만다)'],
  turtle: ['(느릿느릿)', '…', '(고개를 쏙 내민다)'],
  crow: ['까악!', '까악 까악!', '(반짝이는 걸 쳐다본다)'],
  owl: ['부엉~', '부엉 부엉.', '(고개를 빙글 돌린다)'],
  horse: ['히이잉!', '푸르릉…', '(발굽으로 땅을 긁는다)'],
  chicken: ['꼬꼬댁!', '꼬끼오~!', '(모이를 콕콕)'],
  dragon: ['크아앙!', '(작은 불꽃을 뿜는다)', '그르릉…'],
};

export function topicLine(text: string, r = Math.random()): string | null {
  for (const [re, lines] of TOPIC_LINES) if (re.test(text)) return pick(lines, r);
  return null;
}

// ───── generic templates: work for ANY extracted topic (incl. user-typed traits) ─────

export const GENERIC_LIKE: ((x: string) => string)[] = [
  (x) => `요즘 ${x}에 푹 빠져 있어요.`,
  (x) => `${josa(x, '은/는')} 진짜 최고예요!`,
  (x) => `${x} 얘기라면 밤새도록 할 수 있어요.`,
  (x) => `혹시 ${x} 관심 있어요?`,
  (x) => `어제도 ${x} 생각만 했다니까요.`,
  (x) => `${x} 좋아하는 사람 만나면 너무 반가워요.`,
];
export const GENERIC_DISLIKE: ((x: string) => string)[] = [
  (x) => `${josa(x, '은/는')} 정말 별로예요…`,
  (x) => `솔직히 ${josa(x, '은/는')} 좀 무서워요.`,
  (x) => `${x} 얘기는 그만해요, 제발.`,
];
export const GENERIC_DREAM: ((x: string) => string)[] = [
  (x) => `언젠가 ${x}… 그게 제 꿈이에요.`,
  (x) => `${x}, 꼭 이루고 말 거예요.`,
];
export const AGREE = ['저도요! 완전 공감해요.', '오, 우리 취향 비슷하네요!', '맞아요 맞아요!', '와, 그거 저도 좋아해요!'];
export const MUSE: ((t: string) => string)[] = [
  (t) => `있잖아요, 저는 ${toGeodeunyo(t)}.`,
  (t) => `사실 저… ${toGeodeunyo(t)}.`,
  (t) => `저 원래 ${toGeodeunyo(t)}.`,
];
