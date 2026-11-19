// Deterministic Korean command → GameCommand parser (zero-model fallback).
// Phase 2 puts an LLM/embedding parser in front of this; when the model is
// unavailable or its JSON fails validation, this parser is used.

import type { PlaceStyle, Weather } from '../engine/types';
import type { GameCommand, TargetRef } from './schema';

const PLACE_WORDS: [RegExp, PlaceStyle][] = [
  [/(노래방|코인노래방|가라오케)/, 'karaoke'],
  [/(카페|커피숍|찻집|다방)/, 'cafe'],
  [/(공원|숲|정원)/, 'park'],
  [/(편의점|상점|가게|마트|슈퍼|시장|잡화점)/, 'store'],
  [/(도서관|서점|책방)/, 'library'],
  [/(사무실|회사|오피스)/, 'office'],
  [/(광장|분수대)/, 'plaza'],
  [/(집|주택|오두막|아파트|여관)/, 'home'],
];
const ANIMAL_RE = /(고양이|냥이|강아지|멍멍이|개\b|댕댕이|새\b|참새|비둘기|까치|앵무새|동물|길냥이)/;
const SPAWN_RE = /(소환|배치|생성|만들어|추가해|등장|놓아|놔줘|데려와|불러|세워|지어)/;
const ROLE_RE = /(샐러리맨|회사원|직장인|바리스타|학생|알바생|알바|선생님|교사|간호사|의사|요리사|셰프|경찰|소방관|작가|화가|가수|아이돌|개발자|프로그래머|디자이너|기술자|노동자|생산직|사서|점원|사장|은퇴자|할머니|할아버지|기사|음유시인|마법사|대장장이|생존자|해커|탐정|과학자|군인|농부|어부|상인|배우|유튜버|스트리머)$/;
const NUM: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5 };

function target(text: string, selectedId?: string | null): TargetRef {
  if (/(선택한|선택된|이 사람|이 윌|이 캐릭터|얘|이 건물|여기)/.test(text) && selectedId) return { selected: true };
  return { name: text.replace(/(에게|한테|의|을|를|이|가|은|는|와|과|랑)$/, '').trim() };
}

/** "고양이를 좋아하는" → "고양이를 좋아한다" */
function clauseToTrait(c: string): string {
  return c
    .trim()
    .replace(/하는$/, '한다')
    .replace(/있는$/, '있다')
    .replace(/없는$/, '없다')
    .replace(/(많|작|크|적|좋|싫)은$/, '$1다')
    .replace(/([^하])는$/, '$1는다');
}

export function parseWeather(t: string): Weather | null {
  if (/(그치|그쳐|맑|해가 ?(뜨|나)|화창|개었|개게)/.test(t)) return 'clear';
  if (/(폭풍|뇌우|천둥 ?번개가 ?치|태풍)/.test(t)) return 'storm';
  if (/(눈이 ?(내|와|오)|눈 ?(내리|와|오게)|함박눈|첫눈|폭설|눈보라)/.test(t)) return 'snow';
  if (/(소나기|비가|비 ?(내리|오게|와)|장마|폭우|이슬비|비를)/.test(t)) return 'rain';
  return null;
}

export function parseCommand(input: string, selectedId?: string | null): GameCommand | null {
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t) return null;

  // pasted structured sheet → spawn
  if (/\[이름\]/.test(t) || /^\s*\[이름\]/m.test(input)) {
    return { type: 'SPAWN_ENTITY', entity: { kind: /\[분류\]\s*(윌|will|사람|인간)/i.test(input) || !/\[분류\]/.test(input) ? 'person' : 'animal', sheet: input } };
  }

  // ── system ──
  if (/^(저장|세이브|save)/i.test(t)) return { type: 'SYSTEM', action: 'SAVE' };
  if (/^(불러오기|로드|load)/i.test(t)) return { type: 'SYSTEM', action: 'LOAD' };
  if (/^(설정|옵션|settings?)$/i.test(t)) return { type: 'SYSTEM', action: 'SETTINGS' };
  if (/^(종료|나가기|타이틀|메인 ?화면|quit|exit)/i.test(t)) return { type: 'SYSTEM', action: 'QUIT' };
  if (/^(도움말|help|\?|명령어)/i.test(t)) return { type: 'SYSTEM', action: 'HELP' };
  if (/(일시 ?정지|멈춰|정지|pause|시간을 ?멈)/i.test(t)) return { type: 'SYSTEM', action: 'PAUSE' };
  if (/(재개|다시 ?움직|계속|resume|시간이 ?흐르)/i.test(t)) return { type: 'SYSTEM', action: 'RESUME' };
  const speed = t.match(/(\d)\s*배속/);
  if (speed) return { type: 'SYSTEM', action: 'SPEED', value: Math.min(4, Math.max(1, +speed[1])) };
  if (/(빠르게|빨리 ?감기)/.test(t)) return { type: 'SYSTEM', action: 'SPEED', value: 3 };
  if (/(보통 ?속도|원래 ?속도)/.test(t)) return { type: 'SYSTEM', action: 'SPEED', value: 1 };
  const follow = t.match(/^(.+?)(을|를)?\s*(따라가|추적|보여|찾아|비춰)/);
  if (follow && !SPAWN_RE.test(t)) return { type: 'SYSTEM', action: 'FOLLOW', target: target(follow[1], selectedId) };

  // ── rumors ──
  const rq = t.match(/^["“'](.+?)["”']\s*(?:이?라는|는)?\s*소문/);
  if (rq && /(퍼뜨|내|흘|돌게|뿌려|소문)/.test(t)) return { type: 'SPREAD_RUMOR', text: rq[1].trim() };
  const rm = t.match(/^(.+?)(다는|라는|이라는|대는|래는)\s*소문(?:을|이)?\s*(?:퍼뜨|내|흘|돌게|뿌려|만들)/);
  if (rm) {
    const body = rm[1].trim();
    const text = rm[2] === '다는' || rm[2] === '대는' ? body + '대' : rm[2] === '이라는' ? body + '이래' : body + '래';
    return { type: 'SPREAD_RUMOR', text };
  }
  const rc = t.match(/^소문\s*[:：]?\s*(.+)$/);
  if (rc) return { type: 'SPREAD_RUMOR', text: rc[1].trim() };

  // ── world context ──
  const ctx =
    t.match(/(?:세계관|배경|세계|월드)(?:을|를)?\s*(.+?)(?:으로|로)\s*(?:바꿔|변경|전환|설정|해)/) ??
    t.match(/(?:지금부터|이제부터|이제)?\s*여기는\s*(.+?)(?:이야|야|다|입니다|이다)(?:\s|$|[!.~])/) ??
    t.match(/(.+?)\s*세계로\s*(?:바꿔|변경|만들어)/);
  if (ctx) return { type: 'SET_WORLD_CONTEXT', context: ctx[1].replace(/^(완전한|완전히)\s*/, '').trim() };

  // ── events ──
  if (/번개/.test(t) && /(내리|떨어|쳐|꽂)/.test(t)) {
    const m = t.match(/^(.+?)(?:에|에게|한테)\s*번개/);
    return { type: 'TRIGGER_EVENT', event: 'LIGHTNING', targets: [m ? target(m[1], selectedId) : { selected: true }] };
  }
  const meet = t.match(/^(.+?)(?:와|과|랑|이랑|하고)\s+(.+?)(?:이|가)?\s*(?:마주치|만나|대화하|이야기하|얘기하)/);
  if (meet) return { type: 'TRIGGER_EVENT', event: 'MEET', targets: [target(meet[1], selectedId), target(meet[2], selectedId)] };
  const bless = t.match(/^(.+?)(?:에게|한테)?\s*(?:축복|힘을 ?줘|기운을)/);
  if (bless && /축복|힘을|기운/.test(t)) return { type: 'TRIGGER_EVENT', event: 'BLESS', targets: [target(bless[1], selectedId)] };
  const gift = t.match(/^(.+?)(?:에게|한테)\s*(?:.*?)선물/);
  if (gift) return { type: 'TRIGGER_EVENT', event: 'GIFT', targets: [target(gift[1], selectedId)] };

  // ── delete ──
  const del = t.match(/^(.+?)(?:을|를)?\s*(?:삭제|없애|지워|제거|치워|사라지게)/);
  if (del) return { type: 'DELETE_ENTITY', target: target(del[1], selectedId) };

  // ── modify ──
  const addTrait = t.match(/^(.+?)(?:에게|한테|의)\s*["“']?(.+?)["”']?\s*(?:라는\s*)?(?:특성|성격|태그|성향)(?:을|를)?\s*(?:추가|달아|붙여|넣어)/);
  if (addTrait) return { type: 'MODIFY_ENTITY', target: target(addTrait[1], selectedId), changes: { addTraits: [addTrait[2].trim()] } };
  const look = t.match(/^(.+?)의\s*(?:외형|외모|모습)(?:을|를)?\s*["“']?(.+?)["”']?\s*(?:으로|로)\s*(?:바꿔|변경|해)/);
  if (look) return { type: 'MODIFY_ENTITY', target: target(look[1], selectedId), changes: { appearance: look[2].trim() } };
  const treasure = t.match(/^(.+?)의\s*(?:애착 ?물건|보물|소중한 ?물건)(?:을|를|은|는)?\s*["“']?(.+?)["”']?\s*(?:으로|로)\s*(?:바꿔|변경|해|정해)/);
  if (treasure) return { type: 'MODIFY_ENTITY', target: target(treasure[1], selectedId), changes: { treasure: treasure[2].trim() } };
  const rename = t.match(/^(.+?)의\s*이름(?:을|를)?\s*(.+?)(?:으로|로)\s*(?:바꿔|변경|해)/);
  if (rename) return { type: 'MODIFY_ENTITY', target: target(rename[1], selectedId), changes: { name: rename[2].trim() } };

  const job = t.match(/^(.+?)(?:을|를|이|가)\s+(.+?)에서\s*일하(?:게|도록)/) ?? t.match(/^(\S+)\s+(.+?)에서\s*일하(?:게|도록)/);
  if (job) return { type: 'MODIFY_ENTITY', target: target(job[1], selectedId), changes: { workplace: { name: job[2].trim() } } };
  const quit = t.match(/^(.+?)(?:을|를|이|가)?\s+(?:일을\s*)?그만두(?:게|도록)/);
  if (quit) return { type: 'MODIFY_ENTITY', target: target(quit[1], selectedId), changes: { workplace: null } };
  const role = t.match(/^(.+?)의\s*직업(?:을|를)?\s*(.+?)(?:으로|로)\s*(?:바꿔|변경|해)/);
  if (role) return { type: 'MODIFY_ENTITY', target: target(role[1], selectedId), changes: { job: role[2].trim() } };

  // ── weather (after events so "번개 내리기" isn't weather) ──
  const w = parseWeather(t);
  if (w) return { type: 'SET_WEATHER', weather: w };

  // ── spawn ──
  if (SPAWN_RE.test(t)) {
    let body = t.replace(/\s*(을|를)?\s*(소환|배치|생성|만들어|추가해|등장|놓아|놔줘|데려와|불러|세워|지어).*$/, '').trim();
    let near: TargetRef | undefined;
    const loc = body.match(/^(.+?)\s*(?:옆에|근처에|앞에|곁에|주변에|뒤에)\s+(.+)$/);
    if (loc) {
      near = target(loc[1].replace(/^(우울해하는|슬퍼하는|외로운|심심한)\s*/, ''), selectedId);
      body = loc[2];
    } else {
      const loc2 = body.match(/^(.+?)에\s+(.+)$/);
      if (loc2 && !ANIMAL_RE.test(loc2[1]) && loc2[1].length < 12) body = loc2[2]; // "골목 어귀에 ..." (flavour)
    }
    let count = 1;
    const cnt = body.match(/\s*(한|두|세|네|다섯|\d)\s*(마리|명|개|채)/);
    if (cnt) {
      count = NUM[cnt[1]] ?? Math.min(5, parseInt(cnt[1], 10) || 1);
      body = body.replace(cnt[0], '').trim();
    }
    const nameM = body.match(/(\S+?)(?:이)?라는\s+/);
    const name = nameM ? nameM[1] : undefined;
    if (nameM) body = body.replace(nameM[0], '').trim();

    for (const [re, style] of PLACE_WORDS) {
      if (re.test(body) && !ANIMAL_RE.test(body.replace(re, ''))) {
        return { type: 'SPAWN_ENTITY', entity: { kind: 'place', style, name: name ?? body, appearance: body }, at: near ? { near } : undefined };
      }
    }

    // relative clause → trait ("고양이를 좋아하는 샐러리맨")
    const traits: string[] = [];
    let noun = body;
    const rel = body.match(/^(.+(?:하는|있는|없는|많은|싫어하는|좋아하는|잘하는))\s+(.+)$/);
    if (rel) {
      traits.push(clauseToTrait(rel[1]));
      noun = rel[2];
    }
    const isAnimal = ANIMAL_RE.test(noun);
    const roleM = !isAnimal ? noun.match(ROLE_RE) : null;
    const job = roleM ? noun : undefined; // "샐러리맨" is a job, not a look
    const cmd: Extract<GameCommand, { type: 'SPAWN_ENTITY' }> = {
      type: 'SPAWN_ENTITY',
      entity: {
        kind: isAnimal ? 'animal' : 'person',
        name,
        category: isAnimal ? (noun.match(ANIMAL_RE)?.[0] ?? '동물') : '윌',
        appearance: /^(사람|주민|윌|will|새 윌|새로운 윌)$/i.test(noun) || (job && noun.split(' ').length <= 2) ? undefined : noun,
        job,
        traits: traits.length ? traits : undefined,
      },
      at: near ? { near } : undefined,
    };
    if (count > 1) cmd.count = count;
    return cmd;
  }
  return null;
}

export const COMMAND_EXAMPLES = [
  '고양이를 좋아하는 샐러리맨 소환',
  '김민수 옆에 작고 노란 길고양이 소환',
  '골목 어귀에 아늑한 노래방 배치',
  '갑자기 소나기가 내리게 해줘',
  '세계관을 중세 판타지로 변경',
  '박철수와 정하늘이 마주치게 해줘',
  '선택한 건물에 번개 내리기',
  '이영희에게 "재즈 피아노를 배우고 싶어 한다" 특성 추가',
  '최서연의 외형을 빨간 베레모, 선글라스로 바꿔',
  '김민수에게 축복',
  '박철수를 새벽별 부품 공장에서 일하게 해줘',
  '김민수가 복권에 당첨됐다는 소문 퍼뜨려',
];
