// Deterministic Korean command → GameCommand parser (zero-model fallback).
// Phase 2 puts an LLM/embedding parser in front of this; when the model is
// unavailable or its JSON fails validation, this parser is used.

import type { PlaceStyle, Weather } from '../engine/types';
import type { GameCommand, TargetRef } from './schema';
import { mapCommandOf } from './mapParser';
import type { WorldEventKind } from '../engine/World';

const PLACE_WORDS: [RegExp, PlaceStyle][] = [
  [/(영화관|극장|시네마)/, 'cinema'],
  [/(빵집|베이커리|제과점)/, 'bakery'],
  [/(꽃집|화원|플라워)/, 'flower'],
  [/(헬스장|체육관|피트니스|운동장|무도장)/, 'gym'],
  [/(병원|의원|약국|진료소|보건소)/, 'hospital'],
  [/(학교|학원|교실|아카데미|서당)/, 'school'],
  [/(술집|호프|포차|선술집|주점|펍|와인바|칵테일바)/, 'bar'],
  [/(식당|음식점|레스토랑|밥집|국밥집|분식집|주막)/, 'restaurant'],
  [/(공장|작업장|철공소|공방)/, 'factory'],
  [/(노래방|코인노래방|가라오케)/, 'karaoke'],
  [/(카페|커피숍|찻집|다방)/, 'cafe'],
  [/(공원|숲|정원)/, 'park'],
  [/(편의점|상점|가게|마트|슈퍼|시장|잡화점)/, 'store'],
  [/(도서관|서점|책방)/, 'library'],
  [/(사무실|회사|오피스)/, 'office'],
  [/(광장|분수대)/, 'plaza'],
  [/(집|주택|오두막|아파트|여관)/, 'home'],
];
/** free text → facility style (first matching word wins) */
export function placeStyleOf(text: string): PlaceStyle | null {
  for (const [re, st] of PLACE_WORDS) if (re.test(text)) return st;
  return null;
}
/** "광장에서 축제 열어", "민지 생일 축하해 줘", "유성우 내려 줘" → WORLD_EVENT */
export function worldEventOf(t: string, selectedId?: string | null): GameCommand | null {
  if (/소문/.test(t)) return null; // "…복권에 당첨됐다는 소문" is a rumor, not an event
  const who = (s?: string): TargetRef | undefined => {
    const n = (s ?? '').replace(/^(오늘은|오늘|이번엔|지금)\s*/, '').replace(/(의|이|가|에게|한테)$/, '').trim();
    if (n && n.length <= 12 && !/^(동네|마을|모두|다 ?같이|여기|광장|공원)$/.test(n)) return target(n, selectedId);
    return selectedId ? { selected: true } : undefined;
  };
  const ev = (event: WorldEventKind, target?: TargetRef): GameCommand => ({ type: 'WORLD_EVENT', event, ...(target ? { target } : {}) });
  if (/축제|페스티벌|잔치/.test(t)) {
    const m = t.match(/^(.+?)에서\s*(?:.*?)(?:축제|페스티벌|잔치)/);
    const spot = m?.[1].replace(/^(오늘|이번 주말에?|주말에?)\s*/, '').trim();
    return ev('FESTIVAL', spot && !/^(동네|마을|여기|광장|공원|거리|시내)$/.test(spot) ? target(spot, selectedId) : undefined);
  }
  if (/무지개/.test(t)) return ev('RAINBOW');
  if (/정전/.test(t)) return ev('BLACKOUT');
  if (/유성우|별똥별|유성/.test(t)) return ev('METEOR');
  if (/버스킹|길거리\s*공연|거리\s*공연/.test(t)) return ev('BUSKING', who(t.match(/^(.+?)(?:이|가)?\s*(?:버스킹|길거리\s*공연|거리\s*공연)/)?.[1]));
  if (/생일/.test(t) && (!/선물/.test(t) || /축하|파티/.test(t))) return ev('BIRTHDAY', who(t.match(/^(.+?)\s*(?:의\s*)?생일/)?.[1]));
  if (/복권|로또/.test(t)) return ev('LOTTERY', who(t.match(/^(.+?)\s*(?:이|가|에게|한테)?\s*(?:복권|로또)/)?.[1]));
  if (/(잃어버|분실|잃게)/.test(t) && /(물건|애착|보물|소중)/.test(t)) return ev('LOST_TREASURE', who(t.match(/^(.+?)(?:이|가|의)?\s*(?:애착\s*)?(?:물건|보물|소중)/)?.[1]));
  return null;
}
const ANIMAL_RE = /(길고양이|고양이|냥이|강아지|멍멍이|댕댕이|길냥이|참새|비둘기|까치|앵무새|토끼|햄스터|다람쥐|오리|거위|여우|고슴도치|거북이|거북|까마귀|부엉이|올빼미|병아리|닭|조랑말|망아지|드래곤|아기 용|동물|(?:^|\s)(?:개|새|말|용)(?=$|\s|[을를이가와과]))/;
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

/** "요즘 기분 어떠(냐고)" → "요즘 기분 어떠나요?" · "꿈이 뭐(냐고)" → "꿈이 뭐예요?" */
function reported(s: string, question: boolean): string {
  if (!question) return s;
  if (/(뭐|누구|어디|언제|몇 ?살|얼마)$/.test(s)) return `${s}예요?`;
  if (/왜$/.test(s)) return `${s}요?`;
  return `${s}나요?`;
}

export function parseCommand(input: string, selectedId?: string | null): GameCommand | null {
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t) return null;

  // pasted structured sheet → spawn
  if (/\[이름\]/.test(t) || /^\s*\[이름\]/m.test(input)) {
    return { type: 'SPAWN_ENTITY', entity: { kind: /\[분류\]\s*(윌|will|사람|인간)/i.test(input) || !/\[분류\]/.test(input) ? 'person' : 'animal', sheet: input } };
  }

  // ── naming the world: "세계 이름을 별빛마을로 정해 줘", "월드 이름: 우리 동네" ──
  const wname = t.match(/(?:세계|월드|마을|동네|저장|세이브|맵)\s*(?:의\s*)?이름(?:을|를|은|는)?\s*[:：]?\s*["“'「]?(.+?)["”'」]?\s*(?:(?:으로|로|이라고|라고)\s*(?:바꿔|변경|정해|지어|해|하자|할래|부르자)|$)/);
  if (wname && wname[1].trim() && !/^(뭐|무엇|뭔)/.test(wname[1])) return { type: 'RENAME_WORLD', name: wname[1].trim().replace(/(으로|로)$/, '').slice(0, 30) };

  // ── system ──
  if (/^(저장|세이브|save)/i.test(t)) return { type: 'SYSTEM', action: 'SAVE' };
  if (/^(불러오기|로드|load)/i.test(t)) return { type: 'SYSTEM', action: 'LOAD' };
  if (/^(설정|옵션|settings?)$/i.test(t)) return { type: 'SYSTEM', action: 'SETTINGS' };
  if (/^(종료|나가기|타이틀|메인 ?화면|quit|exit)/i.test(t)) return { type: 'SYSTEM', action: 'QUIT' };
  if (/^(도움말|help|\?|명령어)/i.test(t)) return { type: 'SYSTEM', action: 'HELP' };
  // the brush palette itself ("맵 편집", "직접 길 그릴래")
  if (/(맵|지도) ?(편집|수정)|편집 ?모드|직접 ?(길|그리|칠|꾸미)|손으로 ?(그리|칠)/.test(t))
    return { type: 'SYSTEM', action: 'EDIT_MAP', value: /(끝|그만|종료|마치|닫|꺼)/.test(t) ? 0 : 1 };
  // painting / resizing the map in words ("중앙에 인도를 쭉 깔아 줘", "공원 주변에 꽃 심어")
  const mapCmd = mapCommandOf(t, selectedId, target);
  if (mapCmd) return mapCmd;
  if (/((밤|새벽|잠).*(건너|스킵|skip|넘겨|넘기|빨리)|아침까지|아침으로|아침이 ?(오게|되게)|skip ?night)/i.test(t)) return { type: 'SYSTEM', action: 'SKIP_NIGHT' };
  if (/(일시 ?정지|멈춰|정지|pause|시간을 ?멈)/i.test(t)) return { type: 'SYSTEM', action: 'PAUSE' };
  if (/(재개|다시 ?움직|계속|resume|시간이 ?흐르)/i.test(t)) return { type: 'SYSTEM', action: 'RESUME' };
  if (/(0\.5|½|반)\s*배속|느리게|천천히|슬로우|절반\s*속도/.test(t)) return { type: 'SYSTEM', action: 'SPEED', value: /0\.25|¼|아주\s*(느리게|천천히)/.test(t) ? 0.25 : 0.5 };
  if (/(0\.25|¼)\s*배속/.test(t)) return { type: 'SYSTEM', action: 'SPEED', value: 0.25 };
  const speed = t.match(/(\d+)\s*배속/);
  if (speed) return { type: 'SYSTEM', action: 'SPEED', value: Math.min(10, Math.max(1, +speed[1])) };
  if (/(최고 ?속도|최대 ?속도|아주 ?빠르게|엄청 ?빠르게)/.test(t)) return { type: 'SYSTEM', action: 'SPEED', value: 10 };
  if (/(빠르게|빨리 ?감기)/.test(t)) return { type: 'SYSTEM', action: 'SPEED', value: 3 };
  if (/(보통 ?속도|원래 ?속도)/.test(t)) return { type: 'SYSTEM', action: 'SPEED', value: 1 };
  const follow = t.match(/^(.+?)(을|를)?\s*(따라가|추적|보여|찾아|비춰)/);
  if (follow && !SPAWN_RE.test(t)) return { type: 'SYSTEM', action: 'FOLLOW', target: target(follow[1], selectedId) };

  // ── groups ──
  const tag = t.match(/#[^\s,.!?]+/)?.[0];
  const g = tag?.replace(/(에서|에게|에|을|를|은|는|이|가|의|으로|로)$/, '');
  if (/(결성|모임을?\s*만들|그룹을?\s*만들|조직해)/.test(t)) {
    const named = g ?? t.match(/(\S+?)(?:이)?라는\s*(?:모임|그룹)/)?.[1];
    const head = t.split(/#|(?:\S+?(?:이)?라는\s*(?:모임|그룹))/)[0].replace(/(으로|로)?\s*(모임|그룹)?\s*(결성|만들|조직).*$/, '');
    const members = head
      .split(/\s*(?:,|，|와|과|랑|이랑|하고|그리고)\s*/)
      .map((x) => x.replace(/(으로|로|을|를|이|가|은|는)$/, '').trim())
      .filter((x) => x.length >= 2 && !/^(모임|그룹)$/.test(x));
    return { type: 'GROUP', action: 'FORM', name: named, members: members.map((n) => ({ name: n })) };
  }
  if (g && /(해산|해체|없애|흩어)/.test(t)) return { type: 'GROUP', action: 'DISBAND', group: g };
  const ren = t.match(/#[^\s]+?(?:의)?\s*이름(?:을|를)?\s*#?([^\s]+?)(?:으로|로)\s*(?:바꿔|변경|해)/);
  if (g && ren) return { type: 'GROUP', action: 'RENAME', group: g, name: ren[1] };
  const add = t.match(/^(.+?)(?:을|를)\s*#\S+?에\s*(?:넣어|추가|가입|들여)/);
  if (g && add) return { type: 'GROUP', action: 'ADD', group: g, members: [target(add[1], selectedId)] };
  const rem = t.match(/^(.+?)(?:을|를)\s*#\S+?에서\s*(?:빼|탈퇴|내보내|제외)/);
  if (g && rem) return { type: 'GROUP', action: 'REMOVE', group: g, members: [target(rem[1], selectedId)] };

  // ── rumors ──
  const rq = t.match(/^["“'](.+?)["”']\s*(?:이?라는|는)?\s*소문/);
  if (rq && /(퍼뜨|내|흘|돌게|뿌려|소문)/.test(t)) return { type: 'SPREAD_RUMOR', text: rq[1].trim() };
  const rm = t.match(/^(.+?)(다는|라는|이라는|대는|래는)\s*(?:소문|얘기|이야기|말)(?:을|이|를|가)?\s*(?:퍼뜨|퍼지게|내|흘|돌게|뿌려|만들)/);
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
    t.match(/(.+?)\s*세계로\s*(?:바꿔|변경|만들어)/) ??
    t.match(/^(?:여기|이곳|이 ?동네|이 ?마을|우리 ?동네|우리 ?마을)(?:를|을)?\s*(.*(?:마을|도시|왕국|세계|시대|항구|섬|행성|정거장|학교|학원|나라|제국|기지|도시국가))(?:으로|로)\s*(?:바꿔|만들어|변경|바꾸)/);
  if (ctx) return { type: 'SET_WORLD_CONTEXT', context: ctx[1].replace(/^(완전한|완전히)\s*/, '').trim() };

  // ── world events (사건) ──
  const we = worldEventOf(t, selectedId);
  if (we) return we;

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
  const del = t.match(/^(.+?)(?:을|를)\s+(?:.{0,12}?\s)?(?:삭제|없애|지워|제거|치워|사라지게)/) ?? t.match(/^(.+?)(?:을|를)?\s*(?:삭제|없애|지워|제거|치워|사라지게)/);
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

  // ── talk to a Will: 한별에게 "요즘 어때?" · 한별한테 요즘 어떠냐고 물어봐 ──
  const talkQ = t.match(/^(.+?)(?:에게|한테)\s*["“'](.+?)["”']\s*(?:라고|하고)?\s*(?:말|물어|전해|해|이라고)?/);
  if (talkQ) return { type: 'TALK', target: target(talkQ[1], selectedId), text: talkQ[2].trim() };
  const talkR = t.match(/^(.+?)(?:에게|한테)\s+(.+?)(?:라고|냐고|느냐고|는지)\s*(?:말해|물어|전해)/);
  if (talkR) return { type: 'TALK', target: target(talkR[1], selectedId), text: reported(talkR[2].trim(), /냐고|느냐고|는지/.test(talkR[0])) };
  const talkSel = t.match(/^(?:말 ?걸기|말하기)\s*[:：]\s*(.+)$/);
  if (talkSel && selectedId) return { type: 'TALK', target: { selected: true }, text: talkSel[1].trim() };

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
    body = body.replace(/\s*(하나|한\s*개|한\s*채|한\s*곳)\s*$/, '').trim(); // "노래방 하나" → "노래방"
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
        category: isAnimal ? (noun.match(ANIMAL_RE)?.[0].trim() ?? '동물') : '윌',
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
  '김민수, 이영희, 박철수로 #야근_동지회 결성',
];
