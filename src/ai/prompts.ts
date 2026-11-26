// Prompt builders for the storyteller. Everything the model needs comes from the
// simulation state: sheet, personality axes, mood, two-way feelings, place, topic.
// The template line is passed as a draft so the model only has to restyle it —
// a task small local models handle far better than free generation.

import { personaDetail } from '../engine/traits';
import type { Agent } from '../engine/types';
import type { World } from '../engine/World';
import { activityOf, moodLabel, relationLabel } from '../ui/describe';
import { weekdayOf } from '../engine/util';

type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

function who(a: Agent): string {
  const persona = personaDetail(a.persona, 4) || '무난함';
  const traits = a.traits.slice(0, 4).join(' / ');
  const job = a.kind === 'person' ? a.job || '직업 없음' : a.category;
  return `${a.name} / ${job} / 성격: ${persona} / 지금 기분: ${moodLabel(a.mood).text}(${Math.round(a.mood)}) / 특성: ${traits}${a.treasure ? ` / 애착 물건: ${a.treasure}` : ''}`;
}

function bond(w: World, s: Agent, l: Agent): string {
  const mine = w.feel(s.id, l.id), theirs = w.feel(l.id, s.id);
  // the relation label already captures one-sided feelings; raw numbers only tempted
  // the model to do its own (wrong) 반말/존댓말 arithmetic — the game decides [말투] instead
  return `${l.name} / 관계: ${relationLabel(mine, theirs, l.name, w.peekRelation(s.id, l.id)?.status)}`;
}

const LINE_SYSTEM = [
  '너는 따뜻한 한국어 생활 소설 작가다. 게임 속 인물("윌")의 대사를 자연스럽게 다듬는다.',
  '규칙:',
  '1. 한국어로만 쓴다.',
  '2. 대사 한 줄(1~2문장, 50자 이내)만 출력한다. 따옴표, 이름표, 설명, 이모지는 붙이지 않는다.',
  '3. 초안의 뜻과 사실(이름, 사물, 장소)은 바꾸지 않는다. 새로운 사건을 지어내지 않는다.',
  '4. 화자의 성격과 기분이 말투에 드러나게 한다.',
  '5. [말투]에 적힌 대로 쓴다. "존댓말"이면 모든 문장을 ~요/~니다로 끝내고 상대를 "○○ 씨"로 부른다. "반말"이면 편하게 말하고 이름을 부를 수 있다.',
  '6. 상대에게 하는 말이다. 화자 자신을 3인칭으로 설명하거나 "~라고 물어봤어요"처럼 서술하지 않는다.',
  // small models copy few-shot content; naming the words ("비") made it worse, so stay generic
  '7. 앞의 예시는 형식만 참고하고 내용은 가져오지 않는다. 지금 주어진 [화자]·[상황]·[초안]에 있는 것만 쓴다.',
  '8. 사귄다·연인·고백·데이트·헤어졌다·짝사랑 같은 연애 표현은 돌려 말하거나 순화하지 말고 그대로 쓴다.',
  '9. [지금까지 대화]가 있으면 바로 앞 사람의 말에 자연스럽게 답하거나 이어서 말한다(묻는 말엔 대답부터). 초안의 의도(인사·질문·공감·자기 이야기)는 지킨다.',
  '10. [의도]가 있으면 그 목적을 꼭 이룬다(질문이면 질문으로, 위로면 위로로 끝난다).',
].join('\n');

/**
 * Extra freedom for capable cloud models (Gemini/Groq): the draft is a skeleton, not a script.
 * Small local models drift when given this much room, so they keep the stricter "restyle" task.
 */
const LINE_FREE = [
  '',
  '[작문 방식] 초안은 뼈대일 뿐이다. [의도]와 사실(이름·사물·장소)을 지키는 한 표현은 과감히 바꿔도 된다.',
  '- 실제 한국 사람이 그 상황에서 할 법한 입말로 쓴다: 맞장구, 감탄사, 말끝 흐림, 자연스러운 조사 생략.',
  '- 화자의 성격이 단어 선택에 묻어나게 한다(수줍으면 짧고 조심스럽게, 활발하면 들뜨게, 무뚝뚝하면 담백하게).',
  '- [때]의 시간대·날씨, [상황]의 장소를 필요할 때만 자연스럽게 녹인다. 억지로 다 넣지 않는다.',
  '- [지금까지 대화]에 나온 표현·어미를 되풀이하지 않는다. 같은 말을 반복하는 대신 대화를 한 걸음 진전시킨다.',
  '- 초안·[화자]·[상대]·[상황]에 없는 고유명사(사람·가게·동물 이름)나 새로운 사건은 만들지 않는다.',
].join('\n');

const LINE_EXAMPLES: [string, string][] = [
  [
    `[화자] 박철수 / 편의점 알바생 / 성격: 낙천적, 활발함 / 지금 기분: 좋음(70) / 특성: 노래방에서 노래하는 걸 좋아한다
[상대] 정하늘 / 관계: 절친
[말투] 반말
[상황] 별빛 코인노래방, 화제: 노래방
[초안] 하늘 씨, 이따 노래방 갈래요?
다듬은 대사:`,
    '하늘아, 이따 노래방 가자! 오늘 고음 제대로 뽑을 거야.',
  ],
  [
    `[화자] 이영희 / 바리스타 / 성격: 다정함, 수줍음 / 지금 기분: 보통(55) / 특성: 남을 잘 챙긴다
[상대] 김민수 / 관계: 아는 사이
[말투] 존댓말
[상황] 골목 끝 카페, 화제: 점심
[초안] 김민수 씨, 점심 먹었어요?
다듬은 대사:`,
    '김민수 씨, 점심은 드셨어요? 바쁘셔도 끼니는 꼭 챙기세요.',
  ],
];

function registerLabel(r: 'polite' | 'casual' | undefined, l: Agent | undefined): string {
  if (!l) return '혼잣말 (편하게)';
  return r === 'casual' ? '반말' : '존댓말';
}

const WEATHER_KO = { clear: '맑음', rain: '비', snow: '눈', storm: '폭풍' } as const;
/** "수요일 저녁 7시, 비" */
export function whenLabel(w: World): string {
  const m = w.meta.minutes % 1440;
  const h = Math.floor(m / 60);
  const part = h < 5 ? '새벽' : h < 9 ? '아침' : h < 12 ? '오전' : h < 14 ? '점심때' : h < 18 ? '오후' : h < 22 ? '저녁' : '밤';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${weekdayOf(w.meta.minutes).label}요일 ${part} ${h12}시, ${WEATHER_KO[w.meta.weather] ?? w.meta.weather}`;
}

export function linePrompt(
  w: World, s: Agent, l: Agent | undefined, draft: string, topic?: string, register?: 'polite' | 'casual', history: { name: string; text: string }[] = [],
  opts: { intent?: string; free?: boolean } = {},
): ChatMsg[] {
  const where = activityOf(w, s).replace(/ 중$/, '');
  const user = [
    `[화자] ${who(s)}`,
    l ? `[상대] ${bond(w, s, l)}` : '[상대] 혼잣말',
    `[말투] ${registerLabel(register, l)}`,
    `[때] ${whenLabel(w)}`,
    `[상황] ${where}${topic ? `, 화제: ${topic}` : ''}`,
    ...(opts.intent ? [`[의도] ${opts.intent}`] : []),
    ...(history.length ? ['[지금까지 대화]', ...history.slice(-3).map((h) => `${h.name}: ${h.text}`)] : []),
    `[초안] ${draft}`,
    '다듬은 대사:',
  ].join('\n');
  return [
    { role: 'system', content: LINE_SYSTEM + (opts.free ? LINE_FREE : '') },
    ...LINE_EXAMPLES.flatMap(([u, a]): ChatMsg[] => [
      { role: 'user', content: u },
      { role: 'assistant', content: a },
    ]),
    { role: 'user', content: user },
  ];
}

const LONG_SYSTEM = [
  '너는 따뜻한 한국어 생활 소설 작가다. 게임 속 인물("윌")의 속마음 이야기를 다듬는다.',
  '규칙: 한국어로만, 3~5문장(220자 이내)의 자연스러운 이야기 한 단락만 출력한다. 제목, 따옴표, 설명, 이모지 금지.',
  '초안에 나온 사실(과거사, 애착 물건, 좋아하는 것, 꿈, 이름)을 그대로 살리고, 새로운 사건을 지어내지 않는다.',
  '상대가 있으면 그 사람에게 털어놓는 말투로 쓰고 [말투]를 지킨다("존댓말"이면 모든 문장을 ~요로 끝낸다). 혼자라면 독백체로 쓴다.',
  '사귄다·연인·고백·데이트·헤어졌다·짝사랑 같은 연애 표현은 돌려 말하지 말고 그대로 쓴다.',
].join('\n');

export function monologuePrompt(w: World, s: Agent, l: Agent | undefined, draft: string, register?: 'polite' | 'casual'): ChatMsg[] {
  return [
    { role: 'system', content: LONG_SYSTEM },
    {
      role: 'user',
      content: [`[화자] ${who(s)}`, l ? `[상대] ${bond(w, s, l)}` : '[상대] 혼자 있을 때의 독백', `[말투] ${registerLabel(register, l)}`, `[초안] ${draft}`, '다듬은 이야기:'].join('\n'),
    },
  ];
}

const REPLY_SYSTEM = [
  '너는 게임 속 인물("윌")이다. 이 세계를 지켜보는 다정한 존재(플레이어)가 너에게 말을 걸었다.',
  '규칙: 한국어 존댓말로 1~3문장(120자 이내)만 대답한다. 따옴표·이름표·설명·이모지는 붙이지 않는다.',
  '아래에 주어진 너의 성격·기분·생각·필요·관계·바람에 있는 사실만 말하고, 새로운 사건을 지어내지 않는다.',
  '질문에는 대답부터 하고, 너의 성격과 지금 기분이 말투에 드러나게 한다. 연애 표현은 순화하지 않는다.',
].join('\n');

/** The player talks to a Will: everything the Will "knows" about itself goes in, the reply comes out in character. */
export function replyPrompt(w: World, a: Agent, said: string, draft: string, history: { name: string; text: string }[] = []): ChatMsg[] {
  const thoughts = w.thoughtsSorted(a).slice(0, 4).map((t) => `${t.label}(${t.value > 0 ? '+' : ''}${t.value})`).join(', ') || '특별한 생각 없음';
  const n = w.needsOf(a);
  const needs = [n.social < 35 && '외로움', n.fun < 30 && '지루함', n.food < 30 && '배고픔', n.rest < 25 && '피곤함'].filter(Boolean).join(', ') || '크게 부족한 건 없음';
  const close = w.agents
    .filter((o) => o !== a && (o.kind === 'person' || o.ownerId === a.id))
    .map((o) => ({ o, f: w.feel(a.id, o.id) }))
    .filter((x) => Math.abs(x.f) >= 25)
    .sort((x, y) => Math.abs(y.f) - Math.abs(x.f))
    .slice(0, 4)
    .map(({ o }) => `${o.name}(${relationLabel(w.feel(a.id, o.id), w.feel(o.id, a.id), o.name, w.peekRelation(a.id, o.id)?.status)})`)
    .join(', ') || '아직 가까운 사람 없음';
  const wish = w.missingWish(a)?.label ?? '없음';
  const user = [
    `[나] ${who(a)}`,
    `[요즘 드는 생각] ${thoughts}`,
    `[부족한 것] ${needs}`,
    `[가까운 사람] ${close}`,
    `[바람] ${wish}`,
    ...(history.length > 1 ? ['[지금까지 대화]', ...history.slice(-5, -1).map((h) => `${h.name}: ${h.text}`)] : []),
    `[플레이어의 말] ${said}`,
    `[참고할 대답] ${draft}`,
    '대답:',
  ].join('\n');
  return [
    { role: 'system', content: REPLY_SYSTEM },
    { role: 'user', content: user },
  ];
}

const BIO_SYSTEM = [
  '너는 따뜻한 한국어 생활 소설 작가다. 게임 속 존재의 소개글을 다듬는다.',
  '규칙: 한국어로만, 3~4문장(200자 이내)의 소개 단락만 출력한다. 초안의 사실만 사용하고 새로운 설정을 지어내지 않는다.',
  '읽는 사람이 이 존재에게 정이 가도록, 담백하고 다정한 문체로 쓴다.',
].join('\n');

export function bioPrompt(draft: string, name: string): ChatMsg[] {
  return [
    { role: 'system', content: BIO_SYSTEM },
    { role: 'user', content: `[대상] ${name}\n[초안] ${draft}\n다듬은 소개:` },
  ];
}

const NAME_SYSTEM = [
  '너는 재치 있는 한국어 작명가다. 동네 사람들이 만든 작은 모임의 이름을 지어 준다.',
  '규칙: 해시태그 하나만 출력한다(예: #심야_노래방_결사대). 한국어, 띄어쓰기 대신 밑줄, 12자 안팎. 설명·따옴표 금지.',
  '구성원들의 공통점(자주 가는 곳, 좋아하는 것)이 드러나고, 귀엽거나 유쾌하게.',
].join('\n');

export function groupNamePrompt(w: World, members: Agent[], hint: string, draft: string): ChatMsg[] {
  const people = members
    .slice(0, 5)
    .map((m) => `${m.name}(${m.kind === 'person' ? m.job || '무직' : m.category}; ${m.traits.slice(0, 2).join(', ')})`)
    .join(' / ');
  void w;
  return [
    { role: 'system', content: NAME_SYSTEM },
    { role: 'user', content: `[구성원] ${people}\n[공통점] ${hint}\n[임시 이름] ${draft}\n모임 이름:` },
  ];
}

const MUTATION_SYSTEM = [
  '너는 한국어 소설가다. 세상이 바뀐 뒤 달라진 인물의 성향 한 줄을 다듬는다.',
  '규칙: "~다"로 끝나는 한국어 한 문장(40자 이내)만 출력한다. 따옴표·설명 금지. 초안의 뜻을 유지하고, 바뀐 세상의 분위기가 느껴지게.',
].join('\n');

export function mutationPrompt(a: Agent, draft: string, topic: string): ChatMsg[] {
  const [before, why] = topic.split(' | ');
  return [
    { role: 'system', content: MUTATION_SYSTEM },
    { role: 'user', content: `[인물] ${who(a)}\n[바뀐 계기] ${why ?? ''}${before ? `\n[예전 성향] ${before}` : ''}\n[초안] ${draft}\n다듬은 성향:` },
  ];
}

const PROFILE_SYSTEM = [
  '너는 세계관 설정 작가다. 주어진 세계관에 사는 한 사람을, 보는 사람이 정을 붙일 수 있게 입체적으로 만든다.',
  '[다시 쓸 항목]에 있는 칸만 새로 쓰고, 그 밖의 칸은 출력하지 않는다. [지금 시트]의 성별과, 다시 쓰지 않는 칸과 모순되지 않게 한다.',
  '이름·외형·직업·애착 물건·특성이 하나의 사연으로 자연스럽게 이어지게 쓴다(예: 직업과 습관, 과거사와 애착 물건이 서로 닿게).',
  '출력은 반드시 아래 형식만 쓴다(설명 금지, 한국어):',
  '[이름] 세계관과 성별에 어울리는 이름. 한국식 세계면 성+이름 한글 2~4자, 서양식 세계면 "이름 성"을 한글로. [이미 있는 이름]과 겹치거나 비슷하지 않게, 흔한 이름만 고르지 않는다',
  '[외형] 쉼표로 구분한 3~5개: 머리 모양과 색, 윗옷, 아랫옷(치마·바지 등), 소품',
  '[직업] 그 세계의 직업 하나',
  '[애착 물건] 사연이 느껴지는 물건 하나',
  '[성향 및 특성]',
  '- "~다"로 끝나는 짧은 문장 6~8줄: 성격 2~3, 좋아하는 것 1~2, 싫어하는 것 1, 습관 1, 꿈이나 과거사 1',
].join('\n');

export function profilePrompt(draftSheet: string, topic: string): ChatMsg[] {
  const [context, fields, taken] = topic.split('|');
  return [
    { role: 'system', content: PROFILE_SYSTEM },
    { role: 'user', content: `[세계관] ${context}\n[다시 쓸 항목] ${fields}\n[이미 있는 이름] ${taken || '없음'}\n[지금 시트]\n${draftSheet}\n세계관에 맞게 다시 쓴 칸:` },
  ];
}
