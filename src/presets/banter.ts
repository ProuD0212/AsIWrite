// Layer-1 (0ms) dialogue: template lines picked by situation & shared topic.
//
// How these are written (so the ✨ storyteller — Gemini first of all — can turn them into natural speech):
//  · Every line is plain 해요체. The game turns it into 반말 for close friends (toBanmal), so a draft
//    never fights the register the model is told to use.
//  · A line never invents facts. Anything specific (a cat, a café…) comes from the real town through
//    {tokens}; a line whose token the town doesn't have is simply not used.
//  · One line = one intent (greet, ask, agree, confide…). The intent is also sent to the model
//    (presets/lineIntents.ts), so it can reword freely without losing what the line is *for*.

import { josa, toGeodeunyo } from '../engine/traits';
import { pick } from '../engine/util';

// ───────────────────────── greetings ─────────────────────────
export const GREET = [
  '안녕하세요!', '어, 또 만났네요.', '어디 가는 길이에요?', '오랜만이에요! 잘 지냈어요?', '마침 잘 만났어요.', '여기서 다 보네요!',
  '오늘 하루 어땠어요?', '밥은 먹었어요?', '요즘 어떻게 지내요?', '안녕하세요, 오늘 좀 바빠 보이네요.',
];
export const GREET_MORNING = ['좋은 아침이에요!', '일찍 나왔네요. 잘 잤어요?', '아침부터 만나니까 반갑네요.', '아침은 먹었어요?'];
export const GREET_EVENING = ['퇴근하는 길이에요?', '오늘 하루도 고생 많았어요.', '저녁 먹었어요?', '벌써 저녁이네요. 하루가 금방 가요.'];
export const GREET_WEATHER: Record<'clear' | 'rain' | 'snow' | 'storm', string[]> = {
  clear: ['날씨 진짜 좋네요!', '오늘 햇살 좋죠? 산책하기 딱이에요.'],
  rain: ['비 많이 오죠? 우산 챙겼어요?', '비 오는 날은 괜히 차분해지네요.'],
  snow: ['눈 와요! 봤어요?', '눈 오니까 동네가 다 하얘졌네요.'],
  storm: ['바람이 장난 아니에요. 괜찮아요?', '이런 날은 집에 있는 게 최고인데요.'],
};
/** close friends (마음 40+). Written polite on purpose: at 60+ the game converts them to 반말. */
export const GREET_CLOSE = [
  '반가워요! 딱 보고 싶었는데.', '왔어요? 기다렸잖아요~', '오늘도 만났네요! 헤헤.', '마침 생각하고 있었어요.', '오, 잘 만났다! 할 얘기 있었어요.',
  '어디 가요? 저도 같이 가요.', '얼굴 보니까 좋네요.',
];
export const GREET_COLD = ['…아, 네.', '(못 본 척하고 싶다…)', '또 만났네요.', '네, 뭐… 안녕하세요.'];
export const GREET_LOVERS = ['보고 싶었어요!', '오늘 하루 어땠어요?', '왔어요? 기다렸잖아요.', '같이 있으니까 좋다.', '오늘도 예쁘네요.', '연락하려던 참이었어요.'];

/** greetings between Wills who are still up in the small hours */
export const NIGHT_GREET = [
  '이 시간에 깨어 있는 사람이 또 있었네요.',
  '잠이 안 와요? 저도요.',
  '밤공기 좋네요. 낮이랑은 다른 동네 같아요.',
  '이 시간엔 왠지 솔직해지는 것 같아요.',
  '야식 생각나지 않아요?',
  '다들 자는데 우리만 깨어 있네요.',
];
export const NIGHT_SNACK = ['(라면… 아니 삼각김밥… 둘 다!)', '(이 시간엔 칼로리가 없는 거야.)', '(한밤의 컵라면은 왜 이렇게 맛있지.)'];
export const NIGHT_UP = ['(잠이 안 와…)', '(생각이 많아서 잠이 안 오네.)', '(바람이라도 좀 쐬자.)'];
export const NIGHT_STARS = ['(별이 이렇게 많았나.)', '(이런 밤엔 다 괜찮아질 것 같아.)', '(저 별들도 누군가를 기다리고 있을까.)'];

// ───────────────────────── moods ─────────────────────────
export const HAPPY = [
  '오늘 기분 진짜 좋아요!', '오늘은 왠지 다 잘될 것 같아요.', '이렇게 얘기하니까 좋네요.', '요즘 하루하루가 즐거워요.',
  '오늘따라 모든 게 다 예뻐 보여요.', '좋은 일이 있었던 건 아닌데, 그냥 기분이 좋아요.', '요즘 이 동네가 점점 좋아져요.',
];
export const SAD = [
  '요즘 좀 힘드네요…', '그냥… 아무것도 하기 싫어요.', '하아… 됐어요.', '괜찮은 척하는 것도 지쳐요.',
  '요즘 잠을 잘 못 자요.', '저만 제자리인 것 같아요.', '오늘은 좀 혼자 있고 싶었어요.',
];
export const COMFORT = [
  '무슨 일 있어요? 얘기해 봐요.', '힘내요, 제가 들어줄게요.', '괜찮아요, 다 잘 될 거예요.', '같이 뭐라도 먹으러 갈래요?',
  '오늘은 무리하지 말아요.', '얼굴이 좀 안 좋아 보여요. 괜찮아요?', '힘들면 힘들다고 해도 돼요.',
];
export const ARGUE = ['지금 뭐라고 했어요?', '그건 아니죠!', '말 좀 가려서 하세요.', '진짜 짜증 나네.', '저한테 왜 그래요?', '그 얘긴 그만하죠.'];
export const SIGH = ['하아…', '…', '왜 나만 이럴까.', '집에 가고 싶다.'];
export const SAD_SONG = ['♪ 비가 오면~ 생각나는 그 사람…', '♪ 혼자라는 게… 익숙해…', '♪ 라라라… 라…'];
export const HUM = ['♪ 흥~ 흥흥~', '♪ 라라라~', '♪ 오늘도 좋은 날~'];
/** small talk when there's nothing particular to say */
export const FILLER = ['그렇구나…', '음, 그럴 수도 있겠네요.', '진짜요?', '아하!', '그건 몰랐어요.', '오, 그래요?', '듣고 보니 그렇네요.'];

// ───────────────────────── topic lines (with real-town tokens) ─────────────────────────
/**
 * Things a line may name. Filled from the actual town (World.topicFacts); a line that needs a token
 * the town doesn't have is skipped, so nobody talks about a café or cat that doesn't exist.
 */
export interface TopicFacts {
  cat?: string;
  dog?: string;
  animal?: string;
  cafe?: string;
  karaoke?: string;
  library?: string;
  park?: string;
  store?: string;
  bakery?: string;
  restaurant?: string;
  cinema?: string;
  gym?: string;
  bar?: string;
  flower?: string;
  /** the place we're in right now */
  here?: string;
}

/** topic keyword → lines about it */
export const TOPIC_LINES: [RegExp, string[]][] = [
  [/고양이|냥/, ['혹시 {cat} 봤어요? 오늘도 어슬렁거리던데.', '{cat}{이/가} 요즘 저만 보면 도망가요.', '고양이 발바닥은 진짜 반칙이에요.', '언젠간 고양이 키우고 싶어요.', '고양이 영상 보다가 밤새운 적 있어요?']],
  [/강아지|개(?![가-힣])|산책시키/, ['{dog} 봤어요? 꼬리 흔드는 거 진짜 귀여워요.', '강아지 산책시키는 사람만 보면 부러워요.', '언젠가 큰 강아지랑 같이 살고 싶어요.']],
  [/동물|새|토끼|햄스터/, ['{animal} 요즘 잘 지내는 것 같아요.', '동물들은 말을 안 해도 마음을 아는 것 같아요.']],
  [/노래|노래방|음악|기타|밴드|애니송|가수|피아노/, ['이따 {karaoke} 갈래요?', '요즘 꽂힌 노래가 있는데 들어볼래요?', '저 고음 연습 중이에요!', '요즘 무슨 노래 들어요?', '노래 한 곡이면 기분이 확 바뀌어요.']],
  [/커피|카페|라떼|바리스타|차를/, ['{cafe} 라떼 마셔 봤어요?', '커피 없으면 저 못 살아요.', '오늘 커피 몇 잔째예요?', '{cafe} 창가 자리 좋아해요?']],
  [/책|도서관|소설|추리|시를|글을/, ['요즘 무슨 책 읽어요?', '{library}에 새 책 들어왔대요.', '책 읽다가 정류장 놓친 적 있어요.', '추천해 줄 만한 책 있어요?']],
  [/간식|과자|편의점|라면|야식/, ['{store} 신상 과자 먹어봤어요?', '출출하지 않아요? 뭐 좀 먹을래요?', '달달한 거 먹으면 기분 좋아져요.', '야식은 역시 라면이죠.']],
  [/빵|크루아상|베이킹|디저트|케이크/, ['{bakery} 소금빵 먹어 봤어요? 진짜 맛있어요.', '빵 냄새 맡으면 그냥 못 지나가요.', '갓 구운 빵은 반칙이에요.']],
  [/맛집|요리|김치찌개|국밥|파스타|먹는 거|음식/, ['{restaurant} 가 봤어요? 거기 진짜 맛있어요.', '오늘 점심 뭐 먹었어요?', '맛있는 거 먹으러 갈래요?', '요즘 요리 좀 배워 볼까 해요.']],
  [/영화|드라마|애니메이션|팝콘/, ['요즘 볼 만한 영화 있어요?', '{cinema}에서 같이 영화 볼래요?', '드라마 정주행하다가 밤새웠어요.']],
  [/운동|헬스|러닝|요가|수영|등산|자전거/, ['요즘 운동하고 있어요?', '{gym} 다닌 지 좀 됐어요. 할 만해요.', '땀 흘리고 나면 개운하잖아요.']],
  [/술|맥주|와인|칵테일|포차/, ['오늘 같은 날은 한잔하고 싶네요.', '{bar}에서 한잔할래요?']],
  [/꽃|화분|식물|다육이|정원/, ['{flower}에 오늘 튤립 들어왔대요.', '키우는 화분에 꽃이 폈어요!', '식물 키우면 마음이 차분해져요.']],
  [/비 오는|비가|비를|빗소리/, ['비 오는 날엔 괜히 센치해져요.', '빗소리 듣는 거 좋아해요?', '우산 챙겼어요?']],
  [/야근|회사|출근|시험|공부|마감|일이 많/, ['요즘 너무 바빠서 정신이 없어요.', '오늘도 야근이에요?', '시험 끝나면 놀러 가요.', '주말만 기다리고 있어요.']],
  [/공원|산책|벤치|노을/, ['{park} 한 바퀴 돌래요?', '{park} 벤치가 명당이에요.', '산책하면 머리가 맑아져요.', '오늘 노을 봤어요?']],
  [/사진|카메라/, ['여기 사진 찍으면 예쁘겠다!', '요즘 사진 찍는 재미에 빠졌어요.']],
  [/옛날|은퇴|터줏대감|오래 살/, ['제가 젊었을 때는 말이에요…', '이 동네도 많이 변했어요.']],
  [/웃|발랄|유쾌|장난/, ['웃어요! 웃으면 복이 와요!', '제가 재밌는 얘기 해 줄까요?']],
  [/게임|오락실|보드게임/, ['요즘 하는 게임 있어요?', '다음에 같이 게임 한 판 해요.']],
  [/여행|바다|기차|캠핑/, ['요즘 어디 멀리 떠나고 싶어요.', '바다 보러 가고 싶지 않아요?', '여행 가면 꼭 기차 타고 싶어요.']],
  [/용|마법|기사|모험/, ['요즘 마법 공부는 잘 돼요?', '언젠가 먼 곳으로 모험을 떠나고 싶어요.']],
  [/좀비|생존|통조림|폐허/, ['오늘 밤도 무사히 넘겨야 할 텐데요.', '통조림 남은 거 있어요?']],
];

/** "{cat}{이/가}" etc. — fill tokens with real names; null if the town lacks one */
export function fillTokens(line: string, facts: TopicFacts): string | null {
  let missing = false;
  const out = line.replace(/\{(\w+)\}(\{(이\/가|을\/를|은\/는|와\/과|이랑\/랑)\})?/g, (_m, key: string, _j, pair?: string) => {
    const v = facts[key as keyof TopicFacts];
    if (!v) {
      missing = true;
      return '';
    }
    return pair ? josa(v, pair as '이/가') : v;
  });
  return missing ? null : out;
}

export function topicLine(text: string, facts: TopicFacts = {}, r = Math.random()): string | null {
  for (const [re, lines] of TOPIC_LINES) {
    if (!re.test(text)) continue;
    const usable = lines.map((l) => fillTokens(l, facts)).filter((l): l is string => !!l);
    if (usable.length) return pick(usable, r);
  }
  return null;
}

// ───────────────────────── animals ─────────────────────────
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

/** what a Will says while petting an animal; `call` is "치즈야" */
export function petLine(call: string, species: string): string {
  const common = [`${call}, 이리 와!`, `${call}, 오늘도 귀엽네.`, `${call}, 누가 이렇게 예쁘래?`, `${call}, 간식은 없는데… 미안해.`, `${call}, 잘 지냈어?`];
  const by: Record<string, string[]> = {
    cat: [`${call}, 골골송 부르는 거야?`, '꾹꾹이 하는 것 좀 봐…!'],
    dog: [`${call}, 꼬리 흔드는 것 좀 봐!`, `${call}, 산책 가고 싶어?`],
    rabbit: [`${call}, 코 씰룩거리는 것 좀 봐.`],
    hamster: [`${call}, 볼에 뭘 그렇게 넣었어?`],
    duck: [`${call}, 뒤뚱뒤뚱 어디 가?`],
    turtle: [`${call}, 천천히 가도 괜찮아.`],
    dragon: [`${call}, 불은 뿜지 마…!`],
  };
  return pick([...common, ...(by[species] ?? [])]);
}

// ───── generic templates: work for ANY extracted topic (incl. user-typed traits) ─────

export const GENERIC_LIKE: ((x: string) => string)[] = [
  (x) => `요즘 ${x}에 푹 빠져 있어요.`,
  (x) => `${josa(x, '은/는')} 진짜 최고예요!`,
  (x) => `${x} 얘기라면 밤새도록 할 수 있어요.`,
  (x) => `혹시 ${x} 관심 있어요?`,
  (x) => `어제도 ${x} 생각만 했다니까요.`,
  (x) => `${x} 좋아하는 사람 만나면 너무 반가워요.`,
  (x) => `저는 요즘 ${x} 덕분에 살아요.`,
  (x) => `${josa(x, '을/를')} 좋아해요? 저는 진짜 좋아하거든요.`,
  (x) => `요즘 제 낙은 ${josa(x, '이/가').slice(0, -1)}${/[가-힣]$/.test(x) && (x.charCodeAt(x.length - 1) - 0xac00) % 28 ? '이에요' : '예요'}.`,
];
export const GENERIC_DISLIKE: ((x: string) => string)[] = [
  (x) => `${josa(x, '은/는')} 정말 별로예요…`,
  (x) => `솔직히 ${josa(x, '은/는')} 좀 무서워요.`,
  (x) => `${x} 얘기는 그만해요, 제발.`,
  (x) => `저는 ${josa(x, '은/는')} 아무리 해도 적응이 안 돼요.`,
  (x) => `${josa(x, '을/를')} 좋아하는 사람도 있겠지만, 저는 좀요.`,
];
export const GENERIC_DREAM: ((x: string) => string)[] = [
  (x) => `언젠가 ${x}… 그게 제 꿈이에요.`,
  (x) => `${x}, 꼭 이루고 말 거예요.`,
  (x) => `웃을지도 모르지만, 제 꿈은 ${x}… 그런 거예요.`,
  (x) => `요즘 ${x} 생각을 자주 해요. 언젠가는 꼭이요.`,
];
export const AGREE = ['저도요! 완전 공감해요.', '오, 우리 취향 비슷하네요!', '맞아요 맞아요!', '와, 그거 저도 좋아해요!', '그쵸? 제 말이요!'];
export const MUSE: ((t: string) => string)[] = [
  (t) => `있잖아요, 저는 ${toGeodeunyo(t)}.`,
  (t) => `사실 저… ${toGeodeunyo(t)}.`,
  (t) => `저 원래 ${toGeodeunyo(t)}.`,
  (t) => `말한 적 있나요? 저 ${toGeodeunyo(t)}.`,
];
