// Prompt builders for the storyteller. Everything the model needs comes from the
// simulation state: sheet, personality axes, mood, two-way feelings, place, topic.
// The template line is passed as a draft so the model only has to restyle it —
// a task small local models handle far better than free generation.

import { personaSummary } from '../engine/traits';
import type { Agent } from '../engine/types';
import type { World } from '../engine/World';
import { activityOf, moodLabel, relationLabel } from '../ui/describe';

type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

function who(a: Agent): string {
  const persona = personaSummary(a.persona, 3).join(', ') || '평범함';
  const traits = a.traits.slice(0, 4).join(' / ');
  const job = a.kind === 'person' ? a.job || '직업 없음' : a.category;
  return `${a.name} / ${job} / 성격: ${persona} / 지금 기분: ${moodLabel(a.mood).text}(${Math.round(a.mood)}) / 특성: ${traits}${a.treasure ? ` / 애착 물건: ${a.treasure}` : ''}`;
}

function bond(w: World, s: Agent, l: Agent): string {
  const mine = w.feel(s.id, l.id), theirs = w.feel(l.id, s.id);
  return `${l.name} / 관계: ${relationLabel(mine, theirs, l.name)} / ${s.name}→${l.name} 마음 ${Math.round(mine)} / ${l.name}→${s.name} 마음 ${Math.round(theirs)}`;
}

const LINE_SYSTEM = [
  '너는 따뜻한 한국어 생활 소설 작가다. 게임 속 인물("윌")의 대사를 자연스럽게 다듬는다.',
  '규칙:',
  '1. 한국어로만 쓴다.',
  '2. 대사 한 줄(1~2문장, 50자 이내)만 출력한다. 따옴표, 이름표, 설명, 이모지는 붙이지 않는다.',
  '3. 초안의 뜻과 사실(이름, 사물, 장소)은 바꾸지 않는다. 새로운 사건을 지어내지 않는다.',
  '4. 화자의 성격과 기분이 말투에 드러나게 한다.',
  '5. 화자→상대 마음이 60 이상이면 반말, 그 외에는 존댓말을 쓴다.',
].join('\n');

const LINE_EXAMPLE_USER = `[화자] 박철수 / 편의점 알바생 / 성격: 낙천적, 활발함 / 지금 기분: 좋음(70) / 특성: 노래방에서 노래하는 걸 좋아한다
[상대] 정하늘 / 관계: 절친 / 박철수→정하늘 마음 80 / 정하늘→박철수 마음 76
[상황] 별빛 코인노래방, 화제: 노래방
[초안] 하늘 씨, 이따 노래방 갈래요?
다듬은 대사:`;
const LINE_EXAMPLE_ANSWER = '하늘아, 이따 노래방 가자! 오늘 고음 제대로 뽑을 거야.';

export function linePrompt(w: World, s: Agent, l: Agent | undefined, draft: string, topic?: string): ChatMsg[] {
  const where = activityOf(w, s).replace(/ 중$/, '');
  const user = [
    `[화자] ${who(s)}`,
    l ? `[상대] ${bond(w, s, l)}` : '[상대] 혼잣말',
    `[상황] ${where}${topic ? `, 화제: ${topic}` : ''}`,
    `[초안] ${draft}`,
    '다듬은 대사:',
  ].join('\n');
  return [
    { role: 'system', content: LINE_SYSTEM },
    { role: 'user', content: LINE_EXAMPLE_USER },
    { role: 'assistant', content: LINE_EXAMPLE_ANSWER },
    { role: 'user', content: user },
  ];
}

const LONG_SYSTEM = [
  '너는 따뜻한 한국어 생활 소설 작가다. 게임 속 인물("윌")의 속마음 이야기를 다듬는다.',
  '규칙: 한국어로만, 3~5문장(220자 이내)의 자연스러운 이야기 한 단락만 출력한다. 제목, 따옴표, 설명, 이모지 금지.',
  '초안에 나온 사실(과거사, 애착 물건, 좋아하는 것, 꿈, 이름)을 그대로 살리고, 새로운 사건을 지어내지 않는다.',
  '상대가 있으면 그 사람에게 털어놓는 말투로(마음이 60 이상이면 반말, 아니면 존댓말), 혼자라면 독백체로 쓴다.',
].join('\n');

export function monologuePrompt(w: World, s: Agent, l: Agent | undefined, draft: string): ChatMsg[] {
  return [
    { role: 'system', content: LONG_SYSTEM },
    { role: 'user', content: [`[화자] ${who(s)}`, l ? `[상대] ${bond(w, s, l)}` : '[상대] 혼자 있을 때의 독백', `[초안] ${draft}`, '다듬은 이야기:'].join('\n') },
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
