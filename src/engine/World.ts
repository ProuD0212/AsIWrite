// The living simulation. Pure TS, no React. Rendering reads from it; the UI
// (this file: state, creation, lookup, the main update loop — the rest of the World's methods are
//  split by area into ./world/*.ts: thinking, routine, conversation, quests, social, romance,
//  groups, voices, events, mapEdit; they are installed on World.prototype at the end of this file)
// mutates it only through Game.dispatch(GameCommand).

import { parseAppearance, propFromText, SPECIES_WORDS, speciesFromText } from './appearance';
import { parseSheet, serializeSheet, type CharacterSheet } from './sheet';
import { bestMatch, HybridMatcher, LIKE_RE, type EmbeddingSource, type SemanticMatcher } from './semantic';
import { SpatialGrid } from './SpatialGrid';
import { D, PLACE_SIZES, TILE, TileMap, type MapBrush } from './TileMap';
import type { MapAreaSpec } from '../commands/schema';
import { placeStyleOf } from '../commands/ruleParser';
import type { Agent, AgentKind, DoorSide, Gender, LogEntry, Place, PlaceStyle, Thought, Weather, WorldMeta } from './types';
import { genderFromText, randomGender } from '../presets/people';
import { clamp, hashString, pick, uid } from './util';
import { allAnchorTexts, aversionObject, computePersona, extractObject, josa, suffix } from './traits';
import { DEFAULT_CHARACTER_SHEETS, DEFAULT_CONTEXT, DEFAULT_PLACES, type PlacePreset } from '../presets/defaultWorld';
import { animalNamePool, randomAnimalKind, randomAppearance, randomName, randomPlace, randomTraits, randomTreasure } from '../presets/traitPools';
import { RumorMill, type Rumor, type TrendRow } from './rumors';
import { type MutationReason } from './mutation';
import { worldTheme } from './worldTheme';
import { type Quest } from './quests';
import { type Faction } from './factions';
import { mapEditMethods } from './world/mapEdit';
import { thinkingMethods } from './world/thinking';
import { routineMethods } from './world/routine';
import { conversationMethods } from './world/conversation';
import { questsMethods } from './world/quests';
import { socialMethods } from './world/social';
import { romanceMethods } from './world/romance';
import { groupsMethods } from './world/groups';
import { voicesMethods } from './world/voices';
import { eventsMethods } from './world/events';

/** Appearance layers; a treasured item like "낡은 기타" shows up as a prop if nothing else is held. */
function layersFor(appearance: string, kind: AgentKind, name: string, category: string, treasure: string, gender?: Gender) {
  const L = parseAppearance(appearance, kind, name, category, gender ?? 'other');
  if (kind === 'person' && L.prop === 'none' && treasure) {
    const p = propFromText(treasure);
    if (p) L.prop = p;
  }
  return L;
}

/**
 * A thought label as an inner line: "김민수와 즐거운 대화를 나눔" → "(김민수와 즐거운 대화를 나눴다. 좋다.)".
 * Nominal endings ("…함", "…음", "…빎") become past tense; the reaction follows how much it matters.
 */
export function innerFromThought(label: string, value: number): string {
  const past = label
    .replace(/나눔$/, '나눴다')
    .replace(/빎$/, '빌었다')
    .replace(/놀람$/, '놀랐다')
    .replace(/들뜸$/, '들떴다')
    .replace(/떠듦$/, '떠들었다')
    .replace(/봄$/, '봤다')
    .replace(/남$/, '났다')
    .replace(/냄$/, '냈다')
    .replace(/옴$/, '왔다')
    .replace(/줌$/, '줬다')
    .replace(/함$/, '했다')
    // 받음 → 받았다, 먹음 → 먹었다 (vowel harmony on the stem's last syllable)
    .replace(/([가-힣])음$/, (_, c: string) => c + ([0, 8].includes(Math.floor(((c.charCodeAt(0) - 0xac00) % 588) / 28)) ? '았다' : '었다'));
  const sentence = /[다!?]$/.test(past) ? past.replace(/!$/, '') : `${past}…`;
  const react = value >= 8 ? pick([' 좋다.', ' 오늘 운이 좋네.', ' 행복해.']) : value > 0 ? pick(['', ' 괜찮은 하루야.']) : value <= -8 ? pick([' 속상하다.', ' 하아…']) : pick([' 하아.', '']);
  return `(${sentence}${/[.…]$/.test(sentence) ? '' : '.'}${react})`.replace('..', '.').replace(/\. \)$/, '.)').replace(/ \)$/, ')');
}

/** "김민수" → "민수"; short or non-Korean names stay as they are. */
/**
 * The given name: "김민수" → "민수", "남궁현우" → "현우", "아렌 블랙우드" → "아렌".
 * One-word / two-syllable names (and animals) stay as they are.
 */
export function givenName(full: string): string {
  const n = full.trim().replace(/\d+$/, '');
  if (/\s/.test(n)) return n.split(/\s+/)[0]; // given name first (fantasy, pirate, space…)
  if (/^(남궁|황보|제갈|선우|독고|사공|서문)[가-힣]{2}$/.test(n)) return n.slice(2);
  return /^[가-힣]{3}$/.test(n) ? n.slice(1) : n;
}

/** game minutes that pass per real second at 1x speed */
export const MIN_PER_SEC = 1;

export interface Relation {
  a: string;
  b: string;
  /** mutual average of ab/ba (kept in sync; read-only for most code) */
  affinity: number; // -100..100
  /** how `a` feels about `b`, and how `b` feels about `a` — feelings can be one-sided */
  ab: number;
  ba: number;
  chats: number;
  tags: string[];
  memories: { t: number; text: string }[];
  /** romance: together now, or broken up */
  status?: 'lovers' | 'ex';
  since?: number;
  /** game minute of the last confession (no second try for a few days) */
  confessedAt?: number;
  /** game day of the last date */
  lastDate?: number;
  /** what they last talked about properly (brought up again next time) */
  lastTopic?: string;
}

export interface FeedItem {
  t: number; // game minutes
  kind: 'line' | 'event' | 'care' | 'break' | 'system' | 'rumor' | 'monologue' | 'romance';
  speakerId?: string;
  speaker?: string;
  /** who the line was said to (conversation partner) */
  toId?: string;
  to?: string;
  /** inner thought, not said out loud */
  thought?: boolean;
  /** rewritten by the generative storyteller (Layer 2) */
  ai?: boolean;
  /** spoken with a line learned from earlier storyteller rewrites (📚) */
  learned?: boolean;
  text: string;
}

/** A request to the generative storyteller (set by the app; null in Node tests). */
export interface StoryRequest {
  world: World;
  kind: 'line' | 'monologue' | 'groupName' | 'mutation' | 'profile' | 'reply';
  speaker: Agent;
  listener?: Agent;
  draft: string;
  topic?: string;
  important: boolean;
  /** the last few lines of this conversation — so the rewrite answers what was just said */
  history?: { name: string; text: string }[];
  /** what the line is for ("상대의 질문에 대답한다. 그러면서 …") — lets the model reword freely */
  intent?: string;
  apply: (text: string) => void;
  /** the rewrite was rejected / failed — speak the template */
  fail?: () => void;
}

export interface Conversation {
  id: string;
  members: string[];
  topic: string;
  topicSim: number;
  nextAt: number;
  lines: number;
  maxLines: number;
  lastSpeaker?: string;
  argue: boolean;
  initiator?: string; // who started it (matters for arguments)
  monologued?: boolean;
  /** a line is out at the storyteller — the conversation waits for it (buffered output) */
  waiting?: boolean;
  /** a reply that must come next (defending a friend, answering a confession) */
  forced?: { speakerId: string; toId: string; text: string; icon?: string };
  /** last few spoken lines (context for the rewrite and for answering questions) */
  history?: { name: string; text: string }[];
  lastText?: string;
  /** what the last line did (a like, a question, a rumor…) so the next speaker can answer it */
  lastAct?: ConvoAct;
  /** things already talked through in this conversation (not brought up again) */
  covered?: string[];
  /** set while choosing a line; becomes lastAct once it's said */
  pendingAct?: Omit<ConvoAct, 'by'>;
  /** this turn's line answers this act (set when the reply path was taken) — for the storyteller's [의도] */
  answered?: ConvoAct;
  /** lines that went unlogged at 5×+ (the log gets one summary instead) */
  quiet?: number;
}

/** a MapAreaSpec with its targets found */
export type PaintArea = Exclude<MapAreaSpec, { kind: 'around' } | { kind: 'path' }> | { kind: 'around'; target: Agent | Place; radius?: number } | { kind: 'path'; from?: Agent | Place; to: Agent | Place };

export interface ConvoAct {
  kind: 'greet' | 'askBack' | 'like' | 'shared' | 'differ' | 'askLike' | 'askWhy' | 'explained' | 'dislike' | 'askWhyNot' | 'dream' | 'cheered' | 'comforted' | 'comfort' | 'sad' | 'askSad' | 'comfortNeeded' | 'rumor' | 'secret' | 'monologue' | 'treasure' | 'gossipGood' | 'gossipBad' | 'recall' | 'happy' | 'muse' | 'birthdayWish' | 'birthdayNews';
  by: string;
  obj?: string;
  about?: string[];
  sentiment?: number;
  /** greetings: it was a question ("오늘 어땠어요?") */
  ask?: boolean;
}

export interface Effect {
  kind: 'lightning' | 'sparkle' | 'spawn' | 'rainbow' | 'meteor' | 'confetti' | 'notes' | 'stage';
  x: number;
  y: number;
  born: number;
  life: number;
}

export const STYLE_WORDS: Record<PlaceStyle, string> = {
  cafe: '카페 커피 라떼', karaoke: '노래방 노래 열창 음악', park: '공원 산책 벤치 나무', store: '편의점 간식 야식 과자',
  library: '도서관 책 독서 공부', home: '집 휴식', office: '사무실 회사 일 야근', plaza: '광장 분수',
  factory: '공장 기계 생산 일',
  restaurant: '식당 밥 요리 맛집 점심 저녁', bakery: '빵집 빵 크루아상 디저트 베이킹', gym: '헬스장 운동 헬스 러닝 근육 요가',
  hospital: '병원 진료 건강 치료', school: '학교 수업 공부 교실 친구', bar: '술집 맥주 술 한잔 안주',
  flower: '꽃집 꽃 화분 꽃다발 식물', cinema: '영화관 영화 팝콘 극장',
};

/** words that map a free-text job onto a workplace style */
export const JOB_WORDS: Partial<Record<PlaceStyle, string>> = {
  cafe: '바리스타 카페 점원 알바 커피',
  karaoke: '노래방 알바 점원 사장',
  store: '편의점 알바 알바생 점원 캐셔 계산원 마트 상점 가게',
  library: '사서 도서관 책',
  office: '회사원 직장인 사무직 샐러리맨 개발자 디자이너 프리랜서 기획자 회사',
  factory: '공장 생산직 노동자 기술자 정비공 엔지니어 대장장이 기계',
  restaurant: '요리사 셰프 주방장 식당 서빙 종업원 사장',
  bakery: '제빵사 파티시에 빵집 베이커',
  gym: '헬스 트레이너 코치 운동 체육관 관장 사범',
  hospital: '의사 간호사 약사 의료진 병원 치료사 의원',
  school: '선생님 교사 학생 강사 교수 훈장 학교',
  bar: '바텐더 술집 사장 주인장',
  flower: '꽃집 플로리스트 정원사 원예',
  cinema: '영화관 직원 영사기사 극장',
};
export const DEFAULT_ROLE: Partial<Record<PlaceStyle, string>> = {
  cafe: '카페 점원', karaoke: '노래방 알바생', store: '편의점 알바생', library: '사서', office: '회사원', factory: '공장 기술자',
  restaurant: '요리사', bakery: '제빵사', gym: '헬스 트레이너', hospital: '간호사', school: '선생님', bar: '바텐더', flower: '꽃집 직원', cinema: '영화관 직원',
};
export const WORK_LINES: Partial<Record<PlaceStyle, string[]>> = {
  cafe: ['주문하신 라떼 나왔습니다~', '어서 오세요!', '오늘의 원두는 에티오피아예요.'],
  karaoke: ['3번 방 시간 연장하실래요?', '어서 오세요, 몇 분이세요?'],
  store: ['어서오세요~', '봉투 필요하세요?', '2+1 행사 중이에요!'],
  library: ['도서관에서는 조용히 해 주세요.', '반납 기한이 지났어요~'],
  office: ['이 보고서 언제 끝나지…', '회의만 세 번째다…', '오늘은 칼퇴할 수 있을까?'],
  factory: ['오늘 할당량 거의 다 채웠다!', '기계 소리가 오늘따라 경쾌하네.', '안전제일!'],
  restaurant: ['주문하신 김치찌개 나왔습니다!', '오늘의 메뉴는 제육볶음이에요~', '맛있게 드세요!', '반찬 더 필요하시면 말씀하세요.'],
  bakery: ['갓 구운 소금빵 나왔어요~', '크루아상 막 나왔습니다!', '빵 냄새 좋죠?', '오늘은 반죽이 잘 부풀었다.'],
  gym: ['하나 더! 할 수 있어요!', '호흡 잊지 마세요~', '오늘은 하체 하는 날이에요.', '자세 좋아요!'],
  hospital: ['다음 분 들어오세요~', '많이 아프셨죠? 금방 나으실 거예요.', '약은 식후 30분에 드세요.', '푹 쉬는 게 제일이에요.'],
  school: ['자, 교과서 34쪽 펴세요.', '이 문제 풀어 볼 사람?', '숙제 검사하겠습니다~', '조용! 수업 시작합니다.'],
  bar: ['오늘 하루도 고생 많으셨어요.', '한 잔 더 드릴까요?', '안주는 서비스예요.', '무슨 일 있으셨어요?'],
  flower: ['선물하실 거예요? 예쁘게 싸 드릴게요.', '오늘 들어온 튤립이에요~', '꽃말이 참 예쁜 꽃이에요.'],
  cinema: ['팝콘은 달콤한 맛으로 드릴까요?', '상영관은 왼쪽입니다~', '곧 상영 시작합니다!'],
};
export const MEAL_MORNING: PlaceStyle[] = ['cafe', 'store', 'bakery'];
export const MEAL_LUNCH: PlaceStyle[] = ['cafe', 'store', 'bakery', 'restaurant'];
export const STUDENT_LINES = ['(졸려…)', '선생님, 질문 있어요!', '쉬는 시간 언제야…', '(시험 범위가 어디까지였지?)', '급식 메뉴 뭐야?', '(필기 열심히 하자.)'];
/** price of leisure per visit (원). Always far below income. */
export const PRICE: Record<PlaceStyle, number> = { cafe: 4500, karaoke: 8000, store: 3000, library: 0, home: 0, office: 0, park: 0, plaza: 0, factory: 0, restaurant: 9000, bakery: 4000, gym: 6000, hospital: 5000, school: 0, bar: 12000, flower: 7000, cinema: 13000 };
/** 원 per game minute */
export const WAGE = 160;
export const ALLOWANCE = 60;
export const SHIFT_LEN_H = 6;
/** places that keep the lights on: an owl who works here takes the night shift (start hour) */
export const NIGHT_SHIFT_START: Partial<Record<PlaceStyle, number>> = { store: 22, bar: 19, karaoke: 19 };
/** animals that are up at night (the rest curl up and sleep) */
export const NOCTURNAL = new Set(['owl', 'cat', 'fox', 'hedgehog']);
export const STYLE_LABEL: Record<PlaceStyle, string> = {
  cafe: '카페', karaoke: '노래방', park: '공원', store: '상점', library: '도서관', home: '집', office: '사무실', plaza: '광장', factory: '공장',
  restaurant: '식당', bakery: '빵집', gym: '헬스장', hospital: '병원', school: '학교', bar: '술집', flower: '꽃집', cinema: '영화관',
};
export const STYLE_EMOTE: Record<PlaceStyle, string> = {
  cafe: '☕', karaoke: '🎵', park: '🌳', store: '🛒', library: '📖', home: '🏠', office: '💻', plaza: '⛲', factory: '🔧',
  restaurant: '🍲', bakery: '🥐', gym: '💪', hospital: '🩺', school: '✏️', bar: '🍺', flower: '💐', cinema: '🎬',
};

type Listener = (item: FeedItem) => void;

export type WorldEventKind = 'FESTIVAL' | 'RAINBOW' | 'BLACKOUT' | 'BUSKING' | 'METEOR' | 'BIRTHDAY' | 'LOTTERY' | 'LOST_TREASURE';
export const WORLD_EVENTS: { kind: WorldEventKind; icon: string; label: string; target?: 'person' | 'place'; hint: string }[] = [
  { kind: 'FESTIVAL', icon: '🎉', label: '동네 축제', target: 'place', hint: '광장·공원(또는 고른 장소)에 모두가 모여요' },
  { kind: 'BUSKING', icon: '🎸', label: '버스킹', target: 'person', hint: '음악을 좋아하는 윌이 길거리 공연을 해요' },
  { kind: 'BIRTHDAY', icon: '🎂', label: '생일', target: 'person', hint: '친구들이 축하하러 와요' },
  { kind: 'LOTTERY', icon: '🍀', label: '복권 당첨', target: 'person', hint: '큰돈이 생기면 한턱낼지도' },
  { kind: 'LOST_TREASURE', icon: '🔎', label: '애착 물건 분실', target: 'person', hint: '잃어버린 물건, 누군가 찾아 줄까요?' },
  { kind: 'RAINBOW', icon: '🌈', label: '무지개', hint: '낮에만 · 모두 하늘을 올려다봐요' },
  { kind: 'METEOR', icon: '🌠', label: '유성우', hint: '밤에만 · 소원을 빌어요' },
  { kind: 'BLACKOUT', icon: '🔌', label: '정전', hint: '불이 꺼져요 · 누군가는 별을 봐요' },
];
/** 0 = day … 1 = night (same curve as the renderer) — true when it's dark enough for stars */
export function Renderer_dark(minutes: number) {
  const h = (minutes % 1440) / 60;
  return h >= 19.5 || h < 5;
}

export class World {
  map: TileMap;
  agents: Agent[] = [];
  places: Place[] = [];
  meta: WorldMeta;
  grid: SpatialGrid<Agent>;
  relations = new Map<string, Relation>();
  feed: FeedItem[] = [];
  convos: Conversation[] = [];
  effects: Effect[] = [];
  /** history of multi-person conversations (for Phase-3 faction detection) */
  groupHistory: { t: number; members: string[] }[] = [];
  rumors = new RumorMill();
  /** emergent / player-made groups (a Will can be in several) */
  factions: Faction[] = [];
  factionAcc = 0;
  /** current game speed (set by Game): 3×+ skips the storyteller, 5×+ summarises conversations */
  simSpeed = 1;
  pendingPolish: { deadline: number; fire: () => void; done: () => boolean }[] = [];
  needAcc = 0;
  relAcc = 0;
  /** game minute until which the power is out (사건: 정전) */
  blackoutUntil = 0;
  /** follow-ups of world events, in game minutes (not saved: transient story beats) */
  pending: { at: number; run: () => void }[] = [];
  eventAcc = 0;
  lastEventAt = -1e9;
  /** the visible area's centre, for sky-wide effects (set by Game each frame via viewRect) */
  /** lazy reactive-trait mutations waiting per Will: due at `readyAt` (game min), applied only when on screen */
  mutationQueue = new Map<string, (MutationReason & { readyAt: number })[]>();
  /** current camera view in world px (set by Game each frame) */
  viewRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  mutAcc = 0;
  mutationsDone = 0;
  topRumorId: string | null = null;
  simTime = 0;
  matcher: SemanticMatcher;
  semanticDirty = false;
  semanticAcc = 0;
  offSemantic: (() => void) | null = null;
  stats = { thinkMs: 0, thinks: 0, pathMs: 0 };

  favorCache = new Map<string, number>();
  seatTaken = new Map<string, string>();
  listeners = new Set<Listener>();
  tmp: Agent[] = [];
  placeDoorSide = new Map<string, DoorSide>();

  /** Shared embedding source (set once by the app; absent in Node tests → lexical only). */
  /** generative Layer-2 rewriting hook (see ai/storyteller.ts) */
  static storyHook: ((req: StoryRequest) => void) | null = null;
  /** a line learned from earlier rewrites for this template (ai/phraseBank) — used when the storyteller isn't */
  static learnedLine: ((draft: string, speaker: Agent, listener: Agent) => string | null) | null = null;
  /** ✨ let the storyteller create every new random Will (setting; on by default in the app) */
  static aiCreate = false;
  /** 0..1 — share of ordinary lines worth sending to the storyteller right now (set by the app) */
  static storyCapacity: () => number = () => 0.2;
  /** how much longer to wait for a rewrite (2 when the AI is on another PC) */
  static polishPatience = 1;
  /** the entity the player is looking at — rewrites are spent there first */
  watchedId: string | null = null;
  static embeddingSource: (EmbeddingSource & { onUpdate?: (fn: () => void) => () => void }) | null = null;

  constructor(context = DEFAULT_CONTEXT, weather: Weather = 'clear', opts: { empty?: boolean } = {}) {
    const src = World.embeddingSource ?? { state: 'off', cosine: () => null, request: () => {} };
    this.matcher = new HybridMatcher(src);
    // when new vectors arrive, recompute favour/persona on a later tick (throttled)
    this.offSemantic = src.onUpdate?.(() => (this.semanticDirty = true)) ?? null;
    src.request(allAnchorTexts());
    this.map = new TileMap(opts.empty ? 64 : 72, opts.empty ? 44 : 48, 7, !opts.empty);
    this.meta = { context, weather, minutes: 8 * 60 + 30 };
    this.grid = new SpatialGrid<Agent>(this.map.w * TILE, 64);
  }

  dispose() {
    this.offSemantic?.();
    this.offSemantic = null;
  }

  /** queue every text this entity can be compared by */
  warmSemantics(e: Agent | Place) {
    const src = World.embeddingSource;
    if (!src) return;
    const texts = this.facets(e);
    if (e.kind !== 'place')
      for (const t of e.traits) {
        const o = extractObject(t);
        if (o) texts.push(o);
      }
    src.request(texts.filter(Boolean));
  }

  static createDefault(context = DEFAULT_CONTEXT, weather: Weather = 'clear', withPreset = true, empty = false): World {
    const w = new World(context, weather, { empty });
    if (withPreset && !empty) {
      for (const p of DEFAULT_PLACES) w.addPlace(p);
      w.map.scatterNature(11);
      for (const s of DEFAULT_CHARACTER_SHEETS) w.addAgentFromSheet(s);
    } else w.map.scatterNature(11);
    return w;
  }

  /**
   * "현대 서울에서 윌 8명, 건물 7채, 동물 2마리로 시작": preset residents/places first,
   * then randomised extras that fit the world context. 0/0/0 → an open, empty world.
   */
  static createWith(o: { context?: string; weather?: Weather; wills?: number; places?: number; animals?: number; empty?: boolean }): World {
    const presetPeople = DEFAULT_CHARACTER_SHEETS.filter((t) => /\[분류\]\s*윌/.test(t));
    const presetAnimals = DEFAULT_CHARACTER_SHEETS.filter((t) => !/\[분류\]\s*윌/.test(t));
    const def = (n: number) => (o.empty ? 0 : n); // an empty world starts empty unless counts say otherwise
    const nW = Math.max(0, Math.min(60, o.wills ?? def(presetPeople.length)));
    const nP = Math.max(0, Math.min(30, o.places ?? def(DEFAULT_PLACES.length)));
    const nA = Math.max(0, Math.min(30, o.animals ?? def(presetAnimals.length)));
    const empty = o.empty || (nW === 0 && nP === 0 && nA === 0);
    const w = new World(o.context ?? DEFAULT_CONTEXT, o.weather ?? 'clear', { empty });
    const modern = worldTheme(w.meta.context) === 'modern';
    const styles: PlaceStyle[] = ['cafe', 'restaurant', 'park', 'store', 'karaoke', 'bakery', 'school', 'library', 'factory', 'office', 'gym', 'cinema', 'bar', 'hospital', 'flower', 'plaza'];
    for (let i = 0; i < nP; i++) {
      if (i < DEFAULT_PLACES.length && modern) w.addPlace(DEFAULT_PLACES[i]);
      else {
        const style = styles[i % styles.length];
        w.addPlace({ style, ...randomPlace(style, hashString(w.meta.context + i), w.meta.context) });
      }
    }
    w.map.scatterNature(11);
    for (let i = 0; i < nW; i++) {
      if (i < presetPeople.length && modern) w.addAgentFromSheet(presetPeople[i]);
      else w.spawnRandomized({ kind: 'person' });
    }
    for (let i = 0; i < nA; i++) {
      if (i < presetAnimals.length && modern) w.addAgentFromSheet(presetAnimals[i]);
      else w.spawnRandomized({ kind: 'animal', category: randomAnimalKind(w.meta.context, hashString(w.meta.context + 'a' + i)) });
    }
    if (!empty) for (const a of w.agents) w.ensureHome(a);
    w.rumors.rumors = []; // the founding moments shouldn't start as gossip
    return w;
  }

  /** Enlarge the world (no hard size limit). Re-indexes the spatial grid. */
  growMap(addW = 24, addH = 16) {
    this.map.grow(addW, addH, hashString('grow' + this.map.w));
    this.rebuildGrid();
  }
  rebuildGrid() {
    const g = new SpatialGrid<Agent>(this.map.w * TILE, 64);
    for (const a of this.agents) g.insert(a);
    this.grid = g;
  }

  // ───────────────────────── map editing ─────────────────────────
  static readonly MAP_MIN = { w: 24, h: 16 };
  static readonly MAP_MAX = { w: 400, h: 300 };

  // ───────────────────────── events / feed ─────────────────────────
  onFeed(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  pushFeed(item: Omit<FeedItem, 't'>) {
    const full = { ...item, t: this.meta.minutes };
    this.feed.push(full);
    if (this.feed.length > 400) this.feed.splice(0, this.feed.length - 400);
    for (const l of this.listeners) l(full);
  }

  log(e: { logs: LogEntry[] }, kind: LogEntry['kind'], text: string, withId?: string) {
    e.logs.push({ t: this.meta.minutes, kind, text, withId });
    if (e.logs.length > 250) e.logs.splice(0, e.logs.length - 250);
  }

  // ───────────────────────── lookup ─────────────────────────
  agent(id?: string) {
    return id ? this.agents.find((a) => a.id === id) : undefined;
  }
  place(id?: string) {
    return id ? this.places.find((p) => p.id === id) : undefined;
  }
  /** fuzzy name lookup: exact → startsWith → includes → (given name) */
  findByName(name: string): Agent | Place | undefined {
    const n = name.trim();
    if (!n) return undefined;
    const all: (Agent | Place)[] = [...this.agents, ...this.places];
    return (
      all.find((e) => e.name === n) ??
      all.find((e) => e.name.startsWith(n)) ??
      all.find((e) => e.name.includes(n)) ??
      all.find((e) => n.length >= 2 && e.name.length >= 3 && n.includes(e.name.slice(1))) ??
      // "카페", "도서관": the kind of building (its own name may be 「고양이 다방」)
      this.places.find((p) => STYLE_LABEL[p.style] === n) ??
      (n.length <= 6 ? this.places.find((p) => p.style === placeStyleOf(n)) : undefined) ??
      // "고양이", "강아지": an animal by its kind
      this.agents.find((a) => a.kind === 'animal' && (a.category === n || a.category.includes(n)))
    );
  }

  relation(a: string, b: string): Relation {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let r = this.relations.get(key);
    if (!r) {
      r = { a: a < b ? a : b, b: a < b ? b : a, affinity: 0, ab: 0, ba: 0, chats: 0, tags: [], memories: [] };
      this.relations.set(key, r);
    }
    return r;
  }
  peekRelation(a: string, b: string) {
    return this.relations.get(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  /** directional feeling: how `from` feels about `to` (-100..100) */
  feel(from: string, to: string): number {
    const r = this.peekRelation(from, to);
    if (!r) return 0;
    return r.a === from ? r.ab : r.ba;
  }
  /** change how `from` feels about `to`; returns [before, after] */
  addFeel(from: string, to: string, delta: number): [number, number] {
    if (delta > 2)
      for (const o of this.relations.values()) {
        if ((o.a !== from && o.b !== from) || (o.a === to || o.b === to)) continue;
        if (o.a === from) o.ab *= 0.997;
        else o.ba *= 0.997;
        o.affinity = (o.ab + o.ba) / 2;
      }
    const r = this.relation(from, to);
    const before = r.a === from ? r.ab : r.ba;
    const after = clamp(before + delta, -100, 100);
    if (r.a === from) r.ab = after;
    else r.ba = after;
    r.affinity = (r.ab + r.ba) / 2;
    return [before, after];
  }

  facets(e: Agent | Place): string[] {
    const base = [e.name, e.category, ...e.appearance.split(/[,，]/), ...e.traits];
    if (e.kind === 'place') base.push(STYLE_WORDS[e.style], STYLE_LABEL[e.style]);
    if (e.kind === 'animal') base.push(SPECIES_WORDS[e.layers.species]);
    return base;
  }

  /** How much agent `a` is drawn to target (0..1), via like-traits. */
  favor(a: Agent, target: Agent | Place): number {
    const key = `${a.id}|${target.id}`;
    const hit = this.favorCache.get(key);
    if (hit !== undefined) return hit;
    const facets = this.facets(target);
    let best = 0;
    for (const t of a.traits) {
      if (!LIKE_RE.test(t)) continue;
      best = Math.max(best, bestMatch(this.matcher, t, facets));
      // the object alone ("고양이") is a sharper probe than the whole sentence
      const obj = extractObject(t);
      if (obj) best = Math.max(best, bestMatch(this.matcher, obj, facets));
    }
    this.favorCache.set(key, best);
    return best;
  }
  aversion(a: Agent, target: Agent | Place): number {
    let best = 0;
    // for people, only what is visible (not their inner trait sentences)
    // judge only what is visible: an animal's/person's look and kind, never their inner trait sentences
    const facets =
      target.kind === 'person'
        ? target.appearance.split(/[,，]/)
        : target.kind === 'animal'
          ? [target.category, ...target.appearance.split(/[,，]/), SPECIES_WORDS[target.layers.species]]
          : this.facets(target);
    // Compare only the OBJECT of the dislike ("비 오는 날을 싫어한다" → "비 오는 날").
    // Whole sentences fooled the embedding model: "고양이를 좋아한다"-ish phrasing and
    // "시험 기간이라 조금 예민하다" (a mood, not a dislike) made cat lovers flee from cats.
    for (const t of a.traits) {
      const obj = aversionObject(t);
      if (obj) best = Math.max(best, bestMatch(this.matcher, obj, facets));
    }
    return best;
  }

  /** Which visible feature of `target` matches which of `a`'s dislikes (for a specific inner line). */
  dislikeDetail(a: Agent, target: Agent): { score: number; obj: string; facet: string } | null {
    const facets = target.kind === 'person' ? target.appearance.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [target.category, SPECIES_WORDS[target.layers.species]];
    let best: { score: number; obj: string; facet: string } | null = null;
    for (const t of a.traits) {
      const obj = aversionObject(t);
      if (!obj) continue;
      for (const f of facets) {
        const s = this.matcher.similarity(obj, f);
        if (!best || s > best.score) best = { score: s, obj, facet: f };
      }
    }
    return best;
  }

  /**
   * Why (if at all) `a` feels uneasy around `b`: real history (they don't get on), opposite temperaments
   * between near-strangers, or something they dislike plainly visible on b. No reason → no unease.
   */
  unease(a: Agent, b: Agent): { kind: 'history' | 'clash' | 'look'; detail: string } | null {
    const mine = this.feel(a.id, b.id);
    if (mine <= -20) return { kind: 'history', detail: '' };
    if (mine < 20) {
      const P = a.persona, Q = b.persona;
      if (P.social < -0.35 && Q.social > 0.55) return { kind: 'clash', detail: '너무 시끌벅적해서' };
      if (P.sensitive > 0.45 && Q.temper > 0.5) return { kind: 'clash', detail: '말투가 세서' };
      if (P.temper < -0.35 && Q.temper > 0.6) return { kind: 'clash', detail: '욱하는 게 보여서' };
    }
    const d = this.dislikeDetail(a, b);
    if (d && d.score >= 0.75) return { kind: 'look', detail: d.facet };
    return null;
  }
  invalidateFavor(id: string) {
    for (const k of this.favorCache.keys()) if (k.includes(id)) this.favorCache.delete(k);
  }

  // ───────────────────────── creation ─────────────────────────
  addPlace(preset: PlacePreset, prefTile?: { tx: number; ty: number }): Place | null {
    const [tw, th] = PLACE_SIZES[preset.style];
    let lot = this.map.findLot(tw, th, prefTile?.tx, prefTile?.ty);
    // no room? the world simply grows (up to a generous safety cap)
    for (let k = 0; !lot && k < 6 && this.map.w < 400; k++) {
      this.growMap(Math.max(24, tw + 4), Math.max(16, th + 4));
      lot = this.map.findLot(tw, th, prefTile?.tx, prefTile?.ty);
    }
    if (!lot) return null;
    const p: Place = {
      id: uid('p'), kind: 'place', name: preset.name, category: STYLE_LABEL[preset.style], appearance: preset.appearance,
      traits: [...preset.traits], style: preset.style, tx: lot.tx, ty: lot.ty, tw, th, door: { tx: 0, ty: 0 }, seats: [], workSpots: [], regulars: {}, logs: [],
    };
    return this.stampPlace(p, lot.doorSide);
  }

  stampPlace(p: Place, doorSide: DoorSide): Place {
    const { seats, door, workSpots } = this.map.buildPlace(p, doorSide, hashString(p.name));
    p.seats = seats;
    p.workSpots = workSpots;
    p.door = door;
    p.regulars ??= {};
    this.places.push(p);
    this.warmSemantics(p);
    // people whose job fits this new workplace start working here
    for (const a of this.agents) if (a.kind === 'person' && a.job && !a.jobId) this.assignJob(a, false);
    if (p.style === 'home') for (const a of this.agents) if (a.kind === 'person' && !this.place(a.homeId)) this.ensureHome(a, false);
    this.placeDoorSide.set(p.id, doorSide);
    this.log(p, 'system', `${josa(p.name, '이/가')} 세워졌다.`);
    const someone = this.agents.find((a) => a.kind === 'person');
    if (someone && this.simTime > 1) this.naturalRumor(`${josa(p.name, '이/가')} 새로 생겼대`, [p], someone, 0.3, 'event', 14);
    // anyone standing inside a newly blocked tile gets nudged out
    for (const a of this.agents) {
      const t = this.tileOf(a);
      if (this.map.isBlocked(t.tx, t.ty)) {
        const n = this.map.nearestWalkable(t.tx, t.ty);
        a.x = (n.tx + 0.5) * TILE;
        a.y = (n.ty + 0.5) * TILE;
        a.ai.path = [];
      }
    }
    return p;
  }
  doorSideOf(p: Place): DoorSide {
    return this.placeDoorSide.get(p.id) ?? 'bottom';
  }
  /** one step into the room from its door (and the way people face once inside) */
  inwardOf(p: Place): { dx: number; dy: number; facing: 'up' | 'down' | 'left' | 'right' } {
    return { bottom: { dx: 0, dy: -1, facing: 'up' as const }, top: { dx: 0, dy: 1, facing: 'down' as const }, left: { dx: 1, dy: 0, facing: 'right' as const }, right: { dx: -1, dy: 0, facing: 'left' as const } }[this.doorSideOf(p)];
  }

  addAgentFromSheet(sheetText: string, x?: number, y?: number): Agent {
    const { sheet, kind } = parseSheet(sheetText);
    return this.addAgent(sheet, kind, x, y);
  }

  addAgent(sheet: CharacterSheet, kind: AgentKind, x?: number, y?: number): Agent {
    const seed = hashString(sheet.name + this.agents.length + this.simTime);
    if (x === undefined || y === undefined) {
      const t = this.map.randomWalkable(Math.random);
      x = (t.tx + 0.5) * TILE;
      y = (t.ty + 0.5) * TILE;
    } else {
      const t = this.map.nearestWalkable(Math.floor(x / TILE), Math.floor(y / TILE));
      if (this.map.isBlocked(Math.floor(x / TILE), Math.floor(y / TILE))) {
        x = (t.tx + 0.5) * TILE;
        y = (t.ty + 0.5) * TILE;
      }
    }
    // Wills always have a gender: the sheet's [성별], else words like "할머니"/"여학생", else a coin flip
    const gender = kind === 'person' ? sheet.gender ?? genderFromText(`${sheet.category} ${sheet.job ?? ''} ${sheet.appearance}`) ?? randomGender(seed) : undefined;
    const a: Agent = {
      id: uid(kind === 'person' ? 'h' : 'a'),
      kind,
      name: sheet.name,
      category: sheet.category,
      gender,
      appearance: sheet.appearance,
      traits: sheet.traits,
      persona: computePersona(sheet.traits, this.matcher),
      layers: layersFor(sheet.appearance, kind, sheet.name, `${sheet.category} ${sheet.job ?? ''}`, sheet.treasure ?? '', gender),
      x, y,
      facing: 'down',
      speed: kind === 'person' ? 64 + (seed % 14) : 52 + (seed % 20),
      moving: false,
      animPhase: (seed % 100) / 10,
      money: 30000 + (seed % 70) * 1000,
      job: sheet.job?.trim() ?? '',
      treasure: sheet.treasure?.trim() ?? '',
      mood: sheet.mood,
      baseMood: sheet.mood,
      thoughts: [],
      ai: { mode: 'idle', path: [], pathIndex: 0, timer: 1 + (seed % 30) / 10, nextThinkAt: this.simTime + (seed % 10) / 10, lastChatAt: {} },
      logs: [],
    };
    this.agents.push(a);
    this.grid.insert(a);
    this.warmSemantics(a);
    if (this.simTime > 1) this.queueImpact(a);
    if (kind === 'person') this.log(a, 'system', `「${this.meta.context}」 세계에 윌로 태어났다. 지금부터는 스스로의 의지로 살아간다.`);
    else this.log(a, 'system', `「${this.meta.context}」 세계에 ${josa(a.name, '이/가')} 나타났다.`);
    if (kind === 'person') this.assignJob(a, !sheet.job);
    if (kind === 'person' && this.simTime > 1) this.ensureHome(a);
    this.effects.push({ kind: 'spawn', x: a.x, y: a.y, born: this.simTime, life: 0.9 });
    if (this.simTime > 1) this.naturalRumor(kind === 'person' ? `처음 보는 윌, ${josa(a.name, '이/가')} 동네에 나타났대` : `동네에 ${a.category} ${josa(a.name, '이/가')} 나타났대`, [a], a, 0.2, 'event', 8);
    return a;
  }

  /** Spawn with random traits/appearance when not given ("배치 시 랜덤 태그"). */
  spawnRandomized(spec: { kind: AgentKind; name?: string; category?: string; appearance?: string; traits?: string[]; mood?: number; job?: string; treasure?: string; gender?: Gender }, x?: number, y?: number) {
    const seed = hashString((spec.name ?? '') + (spec.appearance ?? '') + Date.now() + ':' + this.agents.length + ':' + Math.random());
    const taken = new Set(this.agents.map((a) => a.name));
    const kind = spec.kind;
    const category = spec.category ?? (kind === 'person' ? '윌' : '길고양이');
    const gender = kind === 'person' ? spec.gender ?? genderFromText(`${category} ${spec.job ?? ''} ${spec.appearance ?? ''}`) ?? randomGender(seed) : undefined;
    const appearance = spec.appearance?.trim() || randomAppearance(this.meta.context, kind, category, seed, gender);
    // fill with random context traits only when the user gave few/none
    const given = spec.traits ?? [];
    const target = kind === 'person' ? 7 : 3;
    const need = given.length >= 3 ? 0 : target - given.length;
    const extra = need > 0 ? randomTraits(this.meta.context, kind, need, seed, given) : [];
    const traits = [...given, ...extra].slice(0, 12);
    let name = spec.name?.trim();
    if (!name) {
      if (kind === 'animal') {
        const sp = speciesFromText(category + ' ' + appearance) ?? 'creature';
        name = pick(animalNamePool(sp), (seed % 97) / 97);
        // another 나비? pick a different one rather than numbering it ("나비2")
        for (let k = 1; taken.has(name) && k < 12; k++) name = pick(animalNamePool(sp), ((seed >>> k) % 97) / 97);
      } else name = randomName(this.meta.context, seed, taken, gender);
    }
    const treasure = spec.treasure?.trim() || randomTreasure(this.meta.context, kind, seed);
    const a = this.addAgent({ name, category, appearance, traits, mood: spec.mood ?? 50 + (seed % 30), job: spec.job, treasure, gender }, kind, x, y);
    // ✨ the storyteller writes the parts we filled at random into one coherent person (name, looks, job,
    // treasured item, traits) — always in an uncurated world ("고양이들이 다스리는 왕국"), and in every world
    // when "이야기꾼이 새 윌 만들기" is on. Whatever the player wrote stays as written.
    if (kind === 'person' && (World.aiCreate || worldTheme(this.meta.context) === 'other'))
      this.reimagine(a, { name: !spec.name?.trim(), appearance: !spec.appearance?.trim(), job: !spec.job?.trim(), treasure: !spec.treasure?.trim(), keepTraits: given.length });
    return a;
  }

  removeEntity(id: string): boolean {
    const a = this.agent(id);
    if (a) {
      this.grid.remove(a);
      this.agents = this.agents.filter((x) => x !== a);
      this.releaseSeat(a);
      for (const c of this.convos) c.members = c.members.filter((m) => m !== id);
      this.invalidateFavor(id);
      this.rumors.forget(id);
      for (const x of this.agents) if (x.ownerId === id) x.ownerId = undefined;
      // their requests go with them; anything they were part of fails on the next check
      this.quests = this.quests.filter((q) => q.from !== id);
      this.talks.delete(id);
      for (const f of [...this.factions]) {
        if (!f.members.includes(id)) continue;
        f.members = f.members.filter((m) => m !== id);
        f.logs.push({ t: this.meta.minutes, text: `${a.name}이(가) 세상을 떠났다.`.replace('이(가)', suffix(a.name, '이/가')) });
        if (f.members.length < 3) this.disbandFaction(f.id, '남은 사람이 너무 적어 흩어졌다.');
      }
      return true;
    }
    const p = this.place(id);
    if (p) {
      this.map.clearPlace(p);
      this.places = this.places.filter((x) => x !== p);
      for (const ag of this.agents) {
        if (ag.ai.targetPlaceId === id) this.setIdle(ag, 0.5);
        if (ag.homeId === id) {
          ag.homeId = undefined;
          this.addThought(ag, 'homeless', '살던 집이 사라졌다', -12, 600);
          this.log(ag, 'event', `살던 ${josa(p.name, '이/가')} 사라졌다. 어디서 자야 하지…`);
        }
        if (ag.jobId === id || ag.workPin === id) {
          const pinned = ag.workPin === id;
          ag.jobId = undefined;
          if (pinned) ag.workPin = undefined;
          ag.ai.working = false;
          this.log(ag, 'event', `일하던 ${josa(p.name, '이/가')} 사라져 버렸다.`);
          if (pinned) this.addThought(ag, 'jobloss', '일터가 사라져 막막함', -10, 300);
        }
      }
      this.invalidateFavor(id);
      return true;
    }
    return false;
  }

  // ───────────────────────── undo support · moving things ─────────────────────────
  /** Everything needed to bring a deleted Will/animal back exactly (relations stay in the map by id). */
  snapshotAgent(a: Agent) {
    return {
      id: a.id, sheet: this.sheetOf(a), x: a.x, y: a.y, mood: a.mood, money: a.money, jobId: a.jobId, homeId: a.homeId, workPin: a.workPin,
      thoughts: a.thoughts.map((t) => ({ ...t })), logs: [...a.logs], factions: this.factions.filter((f) => f.members.includes(a.id)).map((f) => f.id),
    };
  }
  restoreAgent(s: ReturnType<World['snapshotAgent']>): Agent {
    const ag = this.addAgentFromSheet(s.sheet, s.x, s.y);
    this.grid.remove(ag);
    ag.id = s.id;
    this.grid.insert(ag);
    ag.mood = s.mood;
    ag.money = s.money;
    ag.jobId = s.jobId && this.place(s.jobId) ? s.jobId : undefined;
    ag.homeId = s.homeId && this.place(s.homeId) ? s.homeId : undefined;
    ag.workPin = s.workPin;
    ag.thoughts = s.thoughts;
    ag.logs = s.logs;
    for (const fid of s.factions) {
      const f = this.faction(fid);
      if (f && !f.members.includes(ag.id)) f.members.push(ag.id);
    }
    return ag;
  }
  /** A building, plus who lived / worked there, so deleting it can be undone. */
  snapshotPlace(p: Place) {
    return {
      place: { ...p, door: { ...p.door }, seats: [], workSpots: [], logs: [...p.logs], regulars: { ...p.regulars }, traits: [...p.traits] } as Place,
      doorSide: this.doorSideOf(p),
      residents: this.agents.filter((a) => a.homeId === p.id).map((a) => a.id),
      pinned: this.agents.filter((a) => a.workPin === p.id).map((a) => a.id),
    };
  }
  restorePlace(s: ReturnType<World['snapshotPlace']>): Place | null {
    this.map.clearPlace(s.place); // (no-op if the ground is already free)
    if (!this.map.rectFree(s.place.tx, s.place.ty, s.place.tw, s.place.th) && !this.rectFreeIgnoringPaint(s.place)) return null;
    const p = this.stampPlace({ ...s.place }, s.doorSide);
    for (const id of s.residents) {
      const a = this.agent(id);
      if (a) a.homeId = p.id;
    }
    for (const id of s.pinned) {
      const a = this.agent(id);
      if (a) a.workPin = p.id;
    }
    return p;
  }
  /** a building's old spot may have been painted over since; undo puts it back regardless of paint */
  rectFreeIgnoringPaint(p: { tx: number; ty: number; tw: number; th: number }) {
    for (let y = p.ty; y < p.ty + p.th; y++)
      for (let x = p.tx; x < p.tx + p.tw; x++) if (!this.map.inBounds(x, y) || this.map.owner[this.map.idx(x, y)] !== 0) return false;
    return true;
  }

  /** Which side the door should face at this spot: toward a street above, otherwise below. */
  doorSideAt(tx: number, ty: number, tw: number): 'top' | 'bottom' {
    const street = (y: number) => {
      for (let x = tx; x < tx + tw; x++) if (this.map.inBounds(x, y) && [1, 2].includes(this.map.ground[this.map.idx(x, y)])) return true;
      return false;
    };
    return street(ty - 1) || street(ty - 2) ? 'top' : 'bottom';
  }
  /** Can a building of this style stand with its top-left at (tx, ty)? (the placement ghost asks this) */
  canBuildAt(style: PlaceStyle, tx: number, ty: number, ignore?: Place, turned = false) {
    const [tw0, th0] = PLACE_SIZES[style];
    const [tw, th] = turned ? [th0, tw0] : [tw0, th0];
    if (!ignore) return this.map.rectFree(tx, ty, tw, th);
    // moving: the building's own footprint counts as free
    for (let y = ty - 1; y <= ty + th; y++)
      for (let x = tx - 1; x <= tx + tw; x++) {
        if (!this.map.inBounds(x, y)) return false;
        const i = this.map.idx(x, y);
        const own = this.map.ownerIds[this.map.owner[i]] === ignore.id;
        if (this.map.owner[i] !== 0 && !own) return false;
        const inside = x >= tx && x < tx + tw && y >= ty && y < ty + th;
        if (inside && !own && this.map.ground[i] !== 0) return false;
      }
    return true;
  }
  /** Build exactly here (top-left tile), or null if the spot isn't free. */
  addPlaceAt(preset: PlacePreset, tx: number, ty: number, door?: DoorSide): Place | null {
    const turned = door === 'left' || door === 'right';
    if (!this.canBuildAt(preset.style, tx, ty, undefined, turned)) return null;
    const [tw0, th0] = PLACE_SIZES[preset.style];
    const [tw, th] = turned ? [th0, tw0] : [tw0, th0];
    const p: Place = {
      id: uid('p'), kind: 'place', name: preset.name, category: STYLE_LABEL[preset.style], appearance: preset.appearance,
      traits: [...preset.traits], style: preset.style, tx, ty, tw, th, door: { tx: 0, ty: 0 }, seats: [], workSpots: [], regulars: {}, logs: [],
    };
    return this.stampPlace(p, door ?? this.doorSideAt(tx, ty, tw));
  }
  /** Move a building (top-left to tx, ty); people inside come along. */
  movePlace(p: Place, tx: number, ty: number, door?: DoorSide): { ok: boolean; message: string } {
    const was = this.doorSideOf(p);
    // keep a turned building turned unless told otherwise
    const side0 = door ?? (was === 'left' || was === 'right' ? was : undefined);
    const turned = side0 === 'left' || side0 === 'right';
    if (tx === p.tx && ty === p.ty && (door === undefined || door === was)) return { ok: true, message: '' };
    if (!this.canBuildAt(p.style, tx, ty, p, turned)) return { ok: false, message: '그 자리엔 옮길 수 없어요 — 길이나 다른 건물과 겹쳐요.' };
    const inside = this.agents.filter((a) => {
      const t = this.tileOf(a);
      return t.tx >= p.tx && t.tx < p.tx + p.tw && t.ty >= p.ty && t.ty < p.ty + p.th;
    });
    for (const a of this.agents) if (a.ai.targetPlaceId === p.id) this.releaseSeat(a);
    const dx = (tx - p.tx) * TILE, dy = (ty - p.ty) * TILE;
    this.map.clearPlace(p);
    p.tx = tx;
    p.ty = ty;
    const [tw0, th0] = PLACE_SIZES[p.style];
    [p.tw, p.th] = turned ? [th0, tw0] : [tw0, th0];
    const side = side0 ?? this.doorSideAt(tx, ty, p.tw);
    const { seats, door: doorTile, workSpots } = this.map.buildPlace(p, side, hashString(p.name));
    p.seats = seats;
    p.door = doorTile;
    p.workSpots = workSpots;
    this.placeDoorSide.set(p.id, side);
    for (const a of inside) {
      this.grid.remove(a);
      a.x += dx;
      a.y += dy;
      this.grid.insert(a);
    }
    for (const a of this.agents) {
      if (a.ai.targetPlaceId === p.id) this.setIdle(a, 0.3); // walk back in via the new door
      const t = this.tileOf(a);
      if (this.map.isBlocked(t.tx, t.ty)) {
        const n = this.map.nearestWalkable(t.tx, t.ty);
        a.x = (n.tx + 0.5) * TILE;
        a.y = (n.ty + 0.5) * TILE;
        a.ai.path = [];
        a.ai.pathIndex = 0;
      }
    }
    this.invalidateFavor(p.id);
    this.log(p, 'event', '새 자리로 옮겨졌다.');
    return { ok: true, message: `🏗️ ${josa(p.name, '을/를')} 옮겼어요.` };
  }
  /** Pick a Will/animal up and put it down somewhere walkable. */
  teleport(a: Agent, x: number, y: number) {
    const t = this.map.nearestWalkable(Math.floor(x / TILE), Math.floor(y / TILE));
    this.releaseSeat(a);
    const c = this.convoOf(a);
    if (c) c.members = c.members.filter((m) => m !== a.id);
    this.grid.remove(a);
    a.x = (t.tx + 0.5) * TILE;
    a.y = (t.ty + 0.5) * TILE;
    this.grid.insert(a);
    this.setIdle(a, 1);
  }
  /** send a Will to a place right away (tutorial: go and enjoy the karaoke you just built) */
  visitNow(a: Agent, p: Place) {
    this.releaseSeat(a);
    this.goVisit(a, p);
  }
  /** who lives here (homes) */
  residentsOf(p: Place) {
    return this.agents.filter((a) => a.homeId === p.id);
  }
  /** move a Will into a home (or out: undefined) */
  setHome(a: Agent, p: Place | undefined) {
    const prev = this.place(a.homeId);
    a.homeId = p?.id;
    if (p && prev !== p) {
      this.log(a, 'event', `${josa(p.name, '으로/로')} 이사했다.`, p.id);
      this.log(p, 'event', `${josa(a.name, '이/가')} 이사 왔다.`, a.id);
      this.addThought(a, 'moved', '새 집으로 이사함', 4, 600);
    }
  }

  /** Apply edited sheet / fields; re-parse appearance so the sprite updates. */
  updateAgent(a: Agent, patch: Partial<CharacterSheet>) {
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.category !== undefined) a.category = patch.category;
    if (patch.gender !== undefined && a.kind === 'person') a.gender = patch.gender;
    if (patch.appearance !== undefined) a.appearance = patch.appearance;
    if (patch.traits !== undefined) a.traits = patch.traits;
    if (patch.treasure !== undefined) a.treasure = patch.treasure;
    if (patch.job !== undefined && patch.job !== a.job) {
      a.job = patch.job;
      if (a.kind === 'person') this.assignJob(a, false);
    }
    if (patch.mood !== undefined) {
      a.baseMood = patch.mood;
      a.mood = patch.mood;
    }
    a.layers = layersFor(a.appearance, a.kind, a.name, `${a.category} ${a.job}`, a.treasure, a.gender);
    a.persona = computePersona(a.traits, this.matcher);
    this.invalidateFavor(a.id);
    this.warmSemantics(a);
  }
  sheetOf(a: Agent): string {
    return serializeSheet({ name: a.name, category: a.category, gender: a.gender, appearance: a.appearance, job: a.job || undefined, treasure: a.treasure || undefined, traits: a.traits, mood: a.baseMood });
  }

  // ───────────────────────── mood & expression ─────────────────────────
  addThought(a: Agent, key: string, label: string, value: number, durationMin: number) {
    const existing = a.thoughts.find((t) => t.key === key);
    const expiresAt = this.meta.minutes + durationMin;
    if (existing) {
      existing.expiresAt = expiresAt;
      existing.label = label;
      existing.value = value;
      return false;
    }
    a.thoughts.push({ key, label, value, expiresAt });
    return true;
  }
  hasThought(a: Agent, key: string) {
    return a.thoughts.some((t) => t.key === key);
  }
  moodTarget(a: Agent) {
    let s = 50 + (a.baseMood - 50) * 0.5 + a.persona.cheer * 6;
    for (const t of a.thoughts) s += t.value;
    return clamp(s, 0, 100);
  }
  say(a: Agent, text: string, opts: { thought?: boolean; kind?: FeedItem['kind']; silentFeed?: boolean; to?: Agent } = {}) {
    const cap = opts.kind === 'monologue' ? 11 : 5;
    a.bubble = { text, born: this.simTime, life: Math.min(cap, 2.2 + text.length * 0.07), thought: opts.thought };
    if (opts.silentFeed && !opts.thought) return undefined; // inner voice is always logged (filterable as 속마음)
    this.pushFeed({ kind: opts.kind ?? 'line', speakerId: a.id, speaker: a.name, text, thought: opts.thought, toId: opts.to?.id, to: opts.to?.name });
    return this.feed[this.feed.length - 1];
  }

  /** Ask the storyteller to restyle a line; swap it in when (if) it comes back. */
  /**
   * Layer 2, buffered: the storyteller rewrites the line BEFORE anyone sees it; `done` runs once with
   * the rewrite, or with the template if the model rejects it or takes too long (9 s / 20 s for long
   * talks). So the story log never changes under the reader's eyes. Returns false if no storyteller.
   */
  requestPolish(kind: 'line' | 'monologue', a: Agent, draft: string, listener: Agent | undefined, topic: string | undefined, important: boolean, history: { name: string; text: string }[], done: (text: string, ai: boolean) => void, intent?: string): boolean {
    const hook = World.storyHook;
    if (!hook) return false;
    let settled = false;
    const finish = (text: string, ai: boolean) => {
      if (settled) return;
      settled = true;
      done(text, ai);
    };
    this.pendingPolish.push({ deadline: performance.now() + (kind === 'monologue' ? 20000 : 9000) * World.polishPatience, fire: () => finish(draft, false), done: () => settled });
    hook({
      world: this, kind, speaker: a, listener, draft, topic, important, history: [...history], intent,
      apply: (text) => finish(draft.startsWith('(') && !text.startsWith('(') ? `(${text})` : text, true),
      fail: () => finish(draft, false),
    });
    return true;
  }
  /** Speak a monologue/inner line, through the storyteller when there's capacity ("…" while it writes). */
  speakPolished(a: Agent, draft: string, important: boolean, opts: { thought?: boolean; kind?: FeedItem['kind'] }) {
    const cap = this.simSpeed >= 3 ? 0 : World.storyCapacity();
    if (cap > 0 && (important || Math.random() < Math.max(0.5, cap))) {
      a.bubble = { text: '…', born: this.simTime, life: 60, thought: opts.thought };
      const ok = this.requestPolish('monologue', a, draft, undefined, undefined, important, [], (text, ai) => {
        if (a.bubble?.text === '…') a.bubble = undefined;
        const fi = this.say(a, text, opts);
        if (fi && ai) fi.ai = true;
      });
      if (ok) return;
      a.bubble = undefined;
    }
    this.say(a, draft, opts);
  }

  /**
   * How `speaker` addresses `target`. Lines are written in polite 해요체, so the
   * vocative stays polite too: close → "철수 씨", otherwise "박철수 씨"; animals → "치즈야".
   * (Casual speech between close friends is left to the Phase-2b LLM rewrite.)
   */
  callName(speaker: Agent, target: Agent): string {
    if (target.kind === 'animal') return josa(target.name, '아/야');
    if (this.speaksCasually(speaker, target)) return josa(givenName(target.name), '아/야');
    return this.referName(speaker, target);
  }
  /** Name used inside a sentence: "철수" (very close), "철수 씨" (close) or "박철수 씨" (not yet). */
  referName(speaker: Agent, target: Agent): string {
    if (target.kind === 'animal') return target.name;
    if (this.speaksCasually(speaker, target)) return givenName(target.name);
    return this.feel(speaker.id, target.id) >= this.addressStyle(speaker).given ? `${givenName(target.name)} 씨` : `${target.name} 씨`;
  }
  /**
   * How quickly a Will drops the family name and switches to 반말, by temperament:
   * formal / reserved Wills keep "박철수 씨" long and rarely go casual; warm, outgoing ones
   * say "철수 씨" early and "철수야" sooner.
   */
  addressStyle(a: Agent): { given: number; casual: number; label: string } {
    const t = a.traits.join(' ');
    if (/(예의|정중|깍듯|격식|존댓말|선을 긋|무뚝뚝|낯을 (많이 )?가)/.test(t) || a.persona.social < -0.4) return { given: 70, casual: 82, label: '격식 있게' };
    if (/(친근|살갑|넉살|붙임성|사교적|분위기 메이커|말을 잘 놓)/.test(t) || a.persona.social > 0.5) return { given: 22, casual: 48, label: '금방 친근하게' };
    return { given: 45, casual: 60, label: '보통' };
  }
  /** 반말 when the speaker feels close enough for their temperament (the storyteller gets the same verdict). */
  speaksCasually(speaker: Agent, target: Agent) {
    return target.kind === 'animal' || this.feel(speaker.id, target.id) >= this.addressStyle(speaker).casual;
  }
  emote(a: Agent, icon: string) {
    a.emote = { icon, born: this.simTime, life: 1.8 };
  }

  // ───────────────────────── main update ─────────────────────────
  update(dt: number) {
    this.simTime += dt;
    this.meta.minutes += dt * MIN_PER_SEC;
    for (const a of this.agents) {
      this.move(a, dt);
      a.ai.timer -= dt;
      if (a.kind === 'person') {
        const earn = ALLOWANCE + (a.ai.working && a.ai.mode === 'visit' && a.ai.pathIndex >= a.ai.path.length ? WAGE : 0);
        const gain = earn * dt * MIN_PER_SEC;
        a.money += gain;
        if (a.ai.working) a.ai.shiftEarned = (a.ai.shiftEarned ?? 0) + gain;
      }
      const target = this.moodTarget(a);
      a.mood += (target - a.mood) * Math.min(1, dt * 0.08);
      if (a.emote && this.simTime - a.emote.born > a.emote.life) a.emote = undefined;
      if (a.bubble && this.simTime - a.bubble.born > a.bubble.life) a.bubble = undefined;
    }
    this.thinkSliced();
    // rewrites that take too long: speak the template (checked in real time — the model is real time)
    if (this.pendingPolish.length) {
      const now = performance.now();
      this.pendingPolish = this.pendingPolish.filter((p) => {
        if (p.done()) return false;
        if (now < p.deadline) return true;
        p.fire();
        return false;
      });
    }
    this.tickConvos();
    this.needAcc += dt * MIN_PER_SEC;
    if (this.needAcc >= 10) {
      this.tickNeeds(this.needAcc);
      this.needAcc = 0;
    }
    this.questAcc += dt * MIN_PER_SEC;
    if (this.questAcc >= 10) {
      this.questAcc = 0;
      this.tickQuests();
    }
    this.relAcc += dt * MIN_PER_SEC;
    if (this.relAcc >= 60) {
      this.decayRelations(this.relAcc);
      this.relAcc = 0;
    }
    this.effects = this.effects.filter((e) => this.simTime - e.born < e.life);
    this.rumors.tick(dt * MIN_PER_SEC, this.meta.minutes);
    this.tickEvents(dt * MIN_PER_SEC);
    this.factionAcc += dt * MIN_PER_SEC;
    if (this.factionAcc >= 30) {
      this.factionAcc = 0;
      this.updateFactions();
      // ≈ once every 1.5 game days per Will, something in them shifts on its own
      for (const a of this.agents) if (a.kind === 'person' && Math.random() < 1 / 72) this.planDrift(a);
    }
    this.mutAcc += dt;
    if (this.mutAcc >= 2.5 && this.mutationQueue.size) {
      this.mutAcc = 0;
      this.processOneMutation();
    }
    this.semanticAcc += dt;
    if (this.semanticDirty && this.semanticAcc > 1.5) {
      this.semanticAcc = 0;
      this.semanticDirty = false;
      this.favorCache.clear();
      for (const a of this.agents) a.persona = computePersona(a.traits, this.matcher);
    }
  }

  /** Time-sliced decisions: at most ~2.5ms or 10 agents per frame. */
  thinkCursor = 0;
  thinkSliced() {
    const n = this.agents.length;
    if (!n) return;
    const t0 = performance.now();
    let processed = 0;
    for (let k = 0; k < n && processed < 10; k++) {
      this.thinkCursor = (this.thinkCursor + 1) % n;
      const a = this.agents[this.thinkCursor];
      if (a.ai.nextThinkAt > this.simTime) continue;
      this.think(a);
      processed++;
      if (performance.now() - t0 > 2.5) break;
    }
    const ms = performance.now() - t0;
    this.stats.thinkMs = this.stats.thinkMs * 0.95 + ms * 0.05;
    this.stats.thinks += processed;
  }

  tileOf(a: { x: number; y: number }) {
    return { tx: Math.floor(a.x / TILE), ty: Math.floor(a.y / TILE) };
  }

  speedMul(a: Agent) {
    const e = 1 + a.persona.energy * 0.12;
    if (a.ai.mode === 'break') return 0.6;
    if (a.mood >= 80) return 1.22 * e;
    if (a.mood <= 20) return 0.72 * e;
    return e;
  }

  move(a: Agent, dt: number) {
    const ai = a.ai;
    const walking = (ai.mode === 'goto' || ai.mode === 'wander' || ai.mode === 'break') && ai.pathIndex < ai.path.length;
    if (walking) {
      const wp = ai.path[ai.pathIndex];
      const dx = wp.x - a.x;
      const dy = wp.y - a.y;
      const dist = Math.hypot(dx, dy);
      const step = a.speed * this.speedMul(a) * dt;
      if (dist <= step) {
        a.x = wp.x;
        a.y = wp.y;
        ai.pathIndex++;
        if (ai.pathIndex >= ai.path.length) this.arrive(a);
      } else {
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
        if (Math.abs(dx) > Math.abs(dy) * 1.1) a.facing = dx > 0 ? 'right' : 'left';
        else a.facing = dy > 0 ? 'down' : 'up';
      }
      a.moving = true;
      this.grid.update(a);
    } else a.moving = false;
    a.animPhase += dt * (a.moving ? a.speed / 9 : 1.6);
    this.separate(a, dt);
  }

  /**
   * Keep bodies from stacking exactly on top of each other (so everyone stays visible and
   * clickable): a gentle push away from anyone closer than ~12px. Seated and sleeping Wills
   * keep their spot; the push never moves anyone into a wall.
   */
  sepBuf: Agent[] = [];
  separate(a: Agent, dt: number) {
    if (a.ai.sleeping || this.isSeated(a)) return;
    const R = 12;
    const near = this.grid.queryRadius(a.x, a.y, R, this.sepBuf);
    let px = 0, py = 0;
    for (const b of near) {
      if (b === a) continue;
      let dx = a.x - b.x, dy = a.y - b.y;
      let d = Math.hypot(dx, dy);
      if (d >= R) continue;
      if (d < 0.01) {
        // exactly on top: split along a direction that differs per pair
        const ang = ((hashString(a.id + b.id) % 628) / 100) * (a.id < b.id ? 1 : -1);
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        d = 1;
      }
      const f = (R - d) / R;
      px += (dx / d) * f;
      py += (dy / d) * f;
    }
    if (!px && !py) return;
    const k = Math.min(1, dt * 8) * 5;
    const nx = a.x + px * k, ny = a.y + py * k;
    if (this.map.isBlocked(Math.floor(nx / TILE), Math.floor(ny / TILE))) return;
    a.x = nx;
    a.y = ny;
    this.grid.update(a);
  }

  pathTo(a: Agent, tx: number, ty: number): boolean {
    const t0 = performance.now();
    const s = this.tileOf(a);
    const path = this.map.findPath(s.tx, s.ty, tx, ty);
    this.stats.pathMs = this.stats.pathMs * 0.9 + (performance.now() - t0) * 0.1;
    if (!path) return false;
    a.ai.path = path.map((p) => ({ x: (p.tx + 0.5) * TILE + (Math.random() - 0.5) * 6, y: (p.ty + 0.5) * TILE + (Math.random() - 0.5) * 6 }));
    a.ai.pathIndex = 0;
    return true;
  }

  setIdle(a: Agent, seconds: number) {
    this.releaseSeat(a);
    a.ai.working = false;
    a.ai.mode = 'idle';
    a.ai.path = [];
    a.ai.pathIndex = 0;
    a.ai.timer = seconds;
    a.ai.targetPlaceId = undefined;
  }

  releaseSeat(a: Agent) {
    for (const [k, v] of this.seatTaken) if (v === a.id) this.seatTaken.delete(k);
  }

  arrive(a: Agent) {
    const ai = a.ai;
    ai.path = [];
    ai.pathIndex = 0;
    if (ai.mode === 'goto' && ai.targetPlaceId) {
      const p = this.place(ai.targetPlaceId);
      if (p) return this.enterVisit(a, p);
    }
    if (ai.mode === 'break') {
      a.facing = 'down';
      return; // keep sitting / sulking until timer ends
    }
    if (ai.mode === 'goto' && ai.meetWith) {
      ai.mode = 'idle';
      ai.timer = 4;
      return;
    }
    ai.mode = 'idle';
    ai.timer = 1.5 + Math.random() * 4;
  }

  // ───────────────────────── goals · requests · moments (목표 · 의뢰 · 작은 사건) ─────────────────────────
  quests: Quest[] = [];
  /** world events that happened (for "make X happen" goals) */
  eventLog: { kind: string; t: number; target?: string }[] = [];
  questsDone = 0;
  /** Wills move in when the town is happy and leave after long unhappiness (settings toggle) */
  migration = true;
  /** no new requests/goals/moving while the tutorial runs */
  questsPaused = false;
  questAcc = 0;
  lastRequestAt = -1e9;
  lastMomentAt = -1e9;
  lastDay = -1;
  recentQuestKeys: { key: string; t: number }[] = [];
  goalCursor = 0;

  lastBirthday = new Map<string, number>();

  /** who already wished this Will a happy birthday today */
  wished = new Map<string, Set<string>>();

  // ───────────────────────── talking to a Will (말 걸기) ─────────────────────────
  /** recent exchanges per Will (not saved): who said what */
  talks = new Map<string, { who: 'me' | 'will'; text: string; ai?: boolean }[]>();

  /** what the Will's last answer to the player was about (for "왜요?" follow-ups) */
  talkTopic = new Map<string, { key: string; obj?: string; who?: string }>();

  // ───────────────────────── reacting to what was just said (대화 문맥) ─────────────────────────
  /** what the last topical line was about (set by topicalLine, read by lineFor) */
  lastTopical: { obj?: string; pol?: number; dream?: string; muse?: string } | undefined;

  // ───────────────────────── staged events (공연 · 축제) ─────────────────────────
  // People who go to a show really go: they stop chatting on the way, stand in a half circle facing
  // the stage, clap, cheer and tip — and stay until it ends.
  shows: { id: string; kind: 'busking' | 'festival'; placeId?: string; starId?: string; stage: { tx: number; ty: number }; until: number; social: boolean; crowd: string[] }[] = [];

  // ───────────────────────── misc ─────────────────────────
  /** everyone under a point, nearest first (repeated clicks cycle through a crowd) */
  agentsAtAll(x: number, y: number, r = 18): Agent[] {
    return this.agents
      .map((a) => ({ a, d: Math.hypot(a.x - x, a.y - 12 * a.layers.bodyScale - y) }))
      .filter((h) => h.d < r)
      .sort((p, q) => p.d - q.d)
      .map((h) => h.a);
  }
  agentsAt(x: number, y: number, r = 18): Agent | undefined {
    let best: Agent | undefined;
    let bd = r;
    for (const a of this.agents) {
      const d = Math.hypot(a.x - x, a.y - 12 * a.layers.bodyScale - y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }
  placeAt(x: number, y: number): Place | undefined {
    const id = this.map.placeIdAt(Math.floor(x / TILE), Math.floor(y / TILE));
    return this.place(id ?? undefined);
  }

  hasDeco(tx: number, ty: number, d: number) {
    return this.map.deco[this.map.idx(tx, ty)] === d;
  }
  isSeated(a: Agent) {
    if (a.ai.mode !== 'visit' && a.ai.mode !== 'break') return false;
    if (a.ai.pathIndex < a.ai.path.length) return false;
    const t = this.tileOf(a);
    const d = this.map.deco[this.map.idx(t.tx, t.ty)];
    return d === D.Chair || d === D.Sofa || d === D.Bench;
  }

  thoughtsSorted(a: Agent): Thought[] {
    return [...a.thoughts].sort((x, y) => Math.abs(y.value) - Math.abs(x.value));
  }
}

// ── the World's methods that live in ./world/*.ts (one file per area of the simulation) ──
export interface World {
  paintArea(brush: MapBrush, area: PaintArea, opt?: {
      width?: number;
      count?: number;
      density?: 'few' | 'many';
      only?: MapBrush;
  }): {
      ok: boolean;
      message: string;
      changed: number;
  };
  groundRoute(s: {
      tx: number;
      ty: number;
  }, g: {
      tx: number;
      ty: number;
  }): {
      tx: number;
      ty: number;
  }[] | null;
  paintMap(tx: number, ty: number, brush: MapBrush, size?: number): number;
  resizeMap(dl: number, dt: number, dr: number, db: number): {
      ok: boolean;
      message: string;
  };
  think(a: Agent): void;
  canChat(a: Agent, b: Agent): boolean;
  chatChance(a: Agent, b: Agent): number;
  wantsToJoin(a: Agent, c: Conversation): boolean;
  perceive(a: Agent): void;
  meetAnimal(a: Agent, b: Agent): void;
  perceiveWeather(a: Agent): void;
  decide(a: Agent): void;
  goMeet(a: Agent, friend: Agent): void;
  bestFriend(a: Agent): Agent | undefined;
  decideAnimal(a: Agent): undefined;
  wander(a: Agent, radius: number): void;
  goVisit(a: Agent, p: Place, sleeping?: boolean): void;
  enterVisit(a: Agent, p: Place): void;
  visitEffect(a: Agent, p: Place): void;
  visitTick(a: Agent): void;
  worksAtAll(a: Agent): boolean;
  dreamFit(a: Agent, p: Place): number;
  chooseWorkplace(a: Agent): Place | undefined;
  assignJob(a: Agent, _allowRandom: boolean): void;
  setJob(a: Agent, p: Place | undefined | 'none'): void;
  noteWorkplace(a: Agent, p: Place): void;
  shiftStart(a: Agent): number;
  onShift(a: Agent): boolean;
  goWork(a: Agent, p: Place): void;
  startWork(a: Agent, p: Place): void;
  endShiftIfOver(a: Agent): void;
  innerMonologue(a: Agent): void;
  renameAgent(a: Agent, name: string): void;
  reimagine(a: Agent, which: {
      name?: boolean;
      appearance: boolean;
      job: boolean;
      treasure: boolean;
      keepTraits: number;
  }): void;
  dayPhase(): 'morning' | 'lunch' | 'day' | 'evening' | 'late';
  isNight(): boolean;
  hour(): number;
  lateHours(h?: number): boolean;
  chronotype(a: Agent): 'lark' | 'normal' | 'owl';
  nightShift(a: Agent): boolean;
  sleepWindow(a: Agent): [number, number];
  isBedtime(a: Agent): boolean;
  openAt(p: Place, h?: number): boolean;
  maybeInsomnia(a: Agent): boolean;
  nightActivity(a: Agent): void;
  nightVisitEffect(a: Agent, p: Place): void;
  homeCapacity(p: Place): number;
  ensureHome(a: Agent, allowBuild?: boolean): void;
  goSleep(a: Agent): void;
  wakeUp(a: Agent): void;
  startBreak(a: Agent): void;
  breakTick(a: Agent): void;
  endBreak(a: Agent): void;
  convoOf(a: Agent): Conversation | undefined;
  startConvo(members: Agent[], argue: boolean): void;
  joinConvo(c: Conversation, a: Agent): void;
  faceEachOther(c: Conversation): void;
  tickConvos(): void;
  speakInConvo(c: Conversation, speaker: Agent, listener: Agent, text: string, icon: string | undefined, long: boolean, ai: boolean, learned?: boolean): void;
  lineFor(c: Conversation, s: Agent, l: Agent): {
      text: string;
      icon?: string;
  };
  topicalLine(s: Agent, convoTopic: string): string | null;
  topicFacts(s: Agent): import('../presets/banter').TopicFacts;
  endConvo(c: Conversation): void;
  person(id?: string): Agent | undefined;
  avgMood(): number;
  loverCount(): number;
  checkQuest(q: Quest): boolean | null;
  questProgress(q: Quest): number | null;
  acceptQuest(id: string): void;
  declineQuest(id: string): void;
  completeQuest(q: Quest): void;
  failQuest(q: Quest): void;
  addQuest(q: Omit<Quest, 'id' | 'createdAt' | 'status'> & {
      status?: Quest['status'];
  }): Quest;
  recentlyAsked(key: string): boolean;
  offerRequest(): void;
  offerGoal(): void;
  offerMoment(): void;
  tickQuests(): void;
  adopt(owner: Agent, pet: Agent): {
      ok: boolean;
      message: string;
  };
  dailyTick(): void;
  birthdayIn(a: Agent): number;
  isBirthday(a: Agent): boolean;
  nearbyReact(who: Agent, radiusTiles: number, react: (b: Agent) => void): void;
  moveOut(a: Agent): void;
  moveIn(): void;
  talkTo(a: Agent, text: string, done?: () => void): void;
  templateReply(a: Agent, text: string): string;
  templateReplyBase(a: Agent, text: string, set: (key: string, extra?: {
      obj?: string;
      who?: string;
  }) => void): string;
  needsOf(a: Agent): {
      social: number;
      fun: number;
      food: number;
      rest: number;
  };
  tickNeeds(mins: number): void;
  missingWish(a: Agent): {
      key: string;
      label: string;
      line: string;
      diary: string;
  } | null;
  clash(x: Agent, y: Agent): number;
  decayRelations(mins: number): void;
  stance(s: Agent, obj: string): number;
  reactTo(c: Conversation, s: Agent, l: Agent): {
      text: string;
      icon?: string;
  } | null;
  gossipLine(c: Conversation, s: Agent, l: Agent): {
      text: string;
      icon?: string;
  } | null;
  secretArrives(l: Agent, r: Rumor, from: Agent): void;
  loverOf(a: Agent): Agent | undefined;
  maybeConfess(p: Agent, q: Agent): void;
  planDate(a: Agent, b: Agent): boolean;
  dateMoment(a: Agent, p: Place): void;
  romanceNews(l: Agent, r: Rumor): void;
  breakUp(r: Relation): void;
  factionsOf(id: string): Faction[];
  faction(id?: string): Faction | undefined;
  sharesGroup(a: string, b: string): boolean;
  mutual(a: string, b: string): number;
  groupHome(members: string[]): Place | undefined;
  groupKeyword(members: Agent[], home?: Place): string;
  formFaction(memberIds: string[], opts?: {
      name?: string;
      origin?: Faction['origin'];
  }): Faction | null;
  disbandFaction(id: string, why?: string): void;
  renameFaction(id: string, name: string): boolean;
  updateFactions(): void;
  naturalRumor(text: string, about: (Agent | Place)[], origin: Agent, sentiment: number, kind: Rumor['kind'], heat?: number, selfTold?: boolean): Rumor | null;
  globalTrends(limit?: number): (TrendRow & {
      reach: number;
  })[];
  groupTrends(fid: string, limit?: number): (TrendRow & {
      reach: number;
  })[];
  plantRumor(text: string, whisperTo?: Agent[]): Rumor | null;
  hearRumor(l: Agent, r: Rumor, from: Agent): void;
  checkTopRumor(): void;
  composeMonologue(a: Agent, listener?: Agent): string;
  setWeather(w: Weather): void;
  setContext(ctx: string): void;
  queueImpact(e: Agent): void;
  processOneMutation(): void;
  planDrift(a: Agent): void;
  applyMutation(a: Agent, reason: MutationReason): void;
  showOf(a: Agent): {
      id: string;
      kind: 'busking' | 'festival';
      placeId?: string;
      starId?: string;
      stage: {
          tx: number;
          ty: number;
      };
      until: number;
      social: boolean;
      crowd: string[];
  } | undefined;
  showBusy(a: Agent): boolean;
  crowdSpot(s: World['shows'][number], i: number): {
      tx: number;
      ty: number;
  };
  joinShow(a: Agent, s: World['shows'][number], spot?: {
      tx: number;
      ty: number;
  }): void;
  showTick(a: Agent): boolean;
  endShow(id: string): void;
  stageOf(p: Place): {
      tx: number;
      ty: number;
  };
  stagePx(s: {
      stage: {
          tx: number;
          ty: number;
      };
  }): {
      x: number;
      y: number;
  };
  drawCrowd(s: World['shows'][number], radiusTiles: number, chance: number): void;
  startBusking(star: Agent, p: Place): void;
  startFestival(p: Place): void;
  awakePeople(): Agent[];
  skyCenter(): {
      x: number;
      y: number;
  };
  later(minutes: number, run: () => void): void;
  announce(text: string): void;
  outdoorPlace(): Place | undefined;
  musicFan(): Agent | undefined;
  tickEvents(dm: number): void;
  happen(kind: WorldEventKind, target?: Agent | Place): {
      ok: boolean;
      message: string;
  };
  happenInner(kind: WorldEventKind, target?: Agent | Place): {
      ok: boolean;
      message: string;
  };
  lightning(x: number, y: number): void;
  bless(a: Agent): void;
  gift(a: Agent): void;
  meet(a: Agent, b: Agent): void;
}
for (const methods of [mapEditMethods, thinkingMethods, routineMethods, conversationMethods, questsMethods, socialMethods, romanceMethods, groupsMethods, voicesMethods, eventsMethods]) Object.defineProperties(World.prototype, Object.getOwnPropertyDescriptors(methods));
