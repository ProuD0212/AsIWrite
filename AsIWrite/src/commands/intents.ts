// Embedding + rules command interpretation (Phase 2).
//
// When the rule parser doesn't recognise a sentence, we compare its meaning to
// example sentences ("anchors") for each command type, pick the nearest intent,
// and fill its slots with lenient rules (names found in the world, the selected
// entity, the raw text as a description). No LLM is involved in control.

import type { World } from '../engine/World';
import type { GameCommand, TargetRef } from './schema';

export type IntentId =
  | 'spawn_person' | 'spawn_animal' | 'spawn_place'
  | 'weather_rain' | 'weather_snow' | 'weather_storm' | 'weather_clear'
  | 'world' | 'meet' | 'lightning' | 'bless' | 'gift' | 'delete' | 'rumor'
  | 'expand' | 'slow' | 'fast' | 'pause' | 'resume' | 'save' | 'help' | 'follow';

/** Anchor sentences per intent. Kept varied on purpose (paraphrases, casual/polite). */
export const INTENT_ANCHORS: Record<IntentId, string[]> = {
  spawn_person: ['새로운 사람을 만들어 줘', '주민 한 명 데려와', '여기에 학생 한 명 나타나게 해', '외로운 화가를 등장시켜', '사람을 하나 추가해 줘'],
  spawn_animal: ['고양이 한 마리 데려와', '강아지를 풀어 줘', '동물 하나 나타나게 해', '귀여운 새끼 고양이를 놓아 줘', '길고양이를 등장시켜'],
  spawn_place: ['카페를 하나 지어 줘', '여기에 가게를 세워', '공원을 만들어 줘', '노래방을 하나 열어 줘', '건물을 하나 지어'],
  weather_rain: ['비 좀 뿌려 줘', '하늘에서 비가 쏟아지게 해', '촉촉하게 비 오게 해', '장마가 시작되게 해'],
  weather_snow: ['눈 좀 뿌려 줘', '하얗게 눈이 쌓이게 해', '겨울처럼 만들어 줘'],
  weather_storm: ['천둥 번개 치는 폭풍을 일으켜', '태풍이 몰아치게 해', '하늘을 험악하게 만들어'],
  weather_clear: ['날씨 맑게 해 줘', '해가 쨍쨍하게 해', '하늘을 개게 해 줘', '비 그만 와'],
  world: ['이 세상을 중세 판타지로 바꿔', '배경을 미래 도시로 해 줘', '여기를 좀비가 나오는 세상으로', '세계관 변경'],
  meet: ['두 사람을 만나게 해 줘', '둘이 마주치게 해', '두 사람 대화 좀 시켜 봐', '둘이 얘기하게 해 줘'],
  lightning: ['번개를 내려', '벼락을 떨어뜨려', '천벌을 내려 줘'],
  bless: ['기분 좋게 해 줘', '힘을 북돋아 줘', '행복하게 만들어 줘', '위로해 줘'],
  gift: ['선물을 줘', '깜짝 선물을 두고 와', '좋아하는 걸 선물해 줘'],
  delete: ['없애 버려', '지워 줘', '사라지게 해', '치워 줘'],
  rumor: ['이상한 소문을 퍼뜨려', '헛소문을 흘려', '소문 좀 내 줘'],
  expand: ['땅을 넓혀 줘', '맵을 더 크게 해', '세상을 확장해'],
  slow: ['천천히 흘러가게 해', '속도 좀 늦춰', '느리게 보여 줘'],
  fast: ['빨리 감기 해', '시간을 빠르게 해', '속도를 올려'],
  pause: ['시간을 멈춰', '잠깐 정지', '일시 정지해'],
  resume: ['다시 시간이 흐르게 해', '계속 진행해', '재생해'],
  save: ['지금 상태를 저장해', '세이브 해 줘', '기록해 둬'],
  help: ['뭘 할 수 있어?', '어떻게 하는 거야', '사용법 알려 줘'],
  follow: ['카메라로 따라가', '보여 줘', '어디 있는지 찾아 줘'],
};

export function allIntentAnchors(): string[] {
  return Object.values(INTENT_ANCHORS).flat();
}

/** Strip command-ish words, leaving a description ("작고 노란 고양이 데려와" → "작고 노란 고양이"). */
function describe(t: string): string {
  return t
    .replace(/(좀|좀만|한번|하나|한 명|한 마리|하나만)\s*/g, '')
    .replace(/\s*(을|를)?\s*(만들어|데려와|데려와 줘|나타나게|등장시켜|풀어|놓아|추가해|세워|지어|열어|생기게|보내)(\s*(줘|봐|주세요|해 줘|해|라))*[.!?~]*$/u, '')
    .trim();
}

/** All entity names mentioned in the text (longest first so "김민수" beats "민수"). */
function namesIn(t: string, w: World): TargetRef[] {
  const all = [...w.agents, ...w.places].map((e) => ({ id: e.id, name: e.name })).sort((a, b) => b.name.length - a.name.length);
  const hits: TargetRef[] = [];
  let rest = t;
  for (const e of all) {
    const given = e.name.length === 3 && /^[가-힣]{3}$/.test(e.name) ? e.name.slice(1) : null;
    if (rest.includes(e.name) || (given && rest.includes(given))) {
      hits.push({ id: e.id });
      rest = rest.replace(e.name, ' ').replace(given ?? '\u0000', ' ');
    }
  }
  return hits;
}

/** Build a command for an intent with lenient slot filling. Returns null if a required slot is missing. */
export function buildFromIntent(intent: IntentId, text: string, w: World, selectedId: string | null): GameCommand | null {
  const names = namesIn(text, w);
  const target: TargetRef | null = names[0] ?? (selectedId ? { id: selectedId } : null);
  switch (intent) {
    case 'spawn_person': {
      const d = describe(text);
      return { type: 'SPAWN_ENTITY', entity: { kind: 'person', appearance: d && !/^(사람|주민|누군가)$/.test(d) ? d : undefined }, at: names[0] ? { near: names[0] } : undefined };
    }
    case 'spawn_animal': {
      const d = describe(text);
      const cat = /(강아지|개)/.test(d) ? '강아지' : /새/.test(d) ? '새' : '길고양이';
      return { type: 'SPAWN_ENTITY', entity: { kind: 'animal', category: cat, appearance: d || undefined }, at: names[0] ? { near: names[0] } : undefined };
    }
    case 'spawn_place': {
      const style = /노래/.test(text) ? 'karaoke' : /공원|숲/.test(text) ? 'park' : /편의점|가게|마트|상점/.test(text) ? 'store' : /도서관|책/.test(text) ? 'library' : /사무실|회사/.test(text) ? 'office' : /공장/.test(text) ? 'factory' : /집/.test(text) ? 'home' : 'cafe';
      return { type: 'SPAWN_ENTITY', entity: { kind: 'place', style, name: describe(text) || undefined } };
    }
    case 'weather_rain':
      return { type: 'SET_WEATHER', weather: 'rain' };
    case 'weather_snow':
      return { type: 'SET_WEATHER', weather: 'snow' };
    case 'weather_storm':
      return { type: 'SET_WEATHER', weather: 'storm' };
    case 'weather_clear':
      return { type: 'SET_WEATHER', weather: 'clear' };
    case 'world': {
      const ctx = text.replace(/(이\s*)?(세상|세계|배경|여기|세계관)(을|를|은|는)?/g, '').replace(/(으로|로)?\s*(바꿔|변경|해|만들어)(\s*(줘|봐))*.*$/u, '').trim();
      return ctx.length >= 2 ? { type: 'SET_WORLD_CONTEXT', context: ctx } : null;
    }
    case 'meet':
      return names.length >= 2 ? { type: 'TRIGGER_EVENT', event: 'MEET', targets: [names[0], names[1]] } : names.length === 1 && selectedId && names[0].id !== selectedId ? { type: 'TRIGGER_EVENT', event: 'MEET', targets: [{ id: selectedId }, names[0]] } : null;
    case 'lightning':
      return target ? { type: 'TRIGGER_EVENT', event: 'LIGHTNING', targets: [target] } : null;
    case 'bless':
      return target ? { type: 'TRIGGER_EVENT', event: 'BLESS', targets: [target] } : null;
    case 'gift':
      return target ? { type: 'TRIGGER_EVENT', event: 'GIFT', targets: [target] } : null;
    case 'delete':
      return target ? { type: 'DELETE_ENTITY', target } : null;
    case 'rumor': {
      const body = text.replace(/(이상한|헛|이런)?\s*소문(을|이)?\s*(좀)?\s*(퍼뜨려|흘려|내|돌게|만들어)(\s*(줘|봐))*.*$/u, '').trim();
      return body.length >= 4 ? { type: 'SPREAD_RUMOR', text: body } : null;
    }
    case 'expand':
      return { type: 'SYSTEM', action: 'EXPAND' };
    case 'slow':
      return { type: 'SYSTEM', action: 'SPEED', value: 0.5 };
    case 'fast':
      return { type: 'SYSTEM', action: 'SPEED', value: 3 };
    case 'pause':
      return { type: 'SYSTEM', action: 'PAUSE' };
    case 'resume':
      return { type: 'SYSTEM', action: 'RESUME' };
    case 'save':
      return { type: 'SYSTEM', action: 'SAVE' };
    case 'help':
      return { type: 'SYSTEM', action: 'HELP' };
    case 'follow':
      return target ? { type: 'SYSTEM', action: 'FOLLOW', target } : null;
  }
}
