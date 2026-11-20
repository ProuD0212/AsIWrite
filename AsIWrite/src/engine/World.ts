// The living simulation. Pure TS, no React. Rendering reads from it; the UI
// mutates it only through Game.dispatch(GameCommand).

import { parseAppearance, propFromText, SPECIES_WORDS, speciesFromText } from './appearance';
import { parseSheet, serializeSheet, type CharacterSheet } from './sheet';
import { bestMatch, DISLIKE_RE, HybridMatcher, LIKE_RE, type EmbeddingSource, type SemanticMatcher } from './semantic';
import { SpatialGrid } from './SpatialGrid';
import { D, G, PLACE_SIZES, TILE, TileMap, type MapBrush } from './TileMap';
import type { MapAreaSpec } from '../commands/schema';
import { placeStyleOf } from '../commands/ruleParser';
import type { Agent, AgentKind, BreakKind, DoorSide, LogEntry, Place, PlaceStyle, Thought, Weather, WorldMeta } from './types';
import { clamp, hashString, pick, uid, weekdayOf } from './util';
import {
  AGREE, ANIMAL_SOUNDS, ARGUE, COMFORT, GENERIC_DISLIKE, GENERIC_DREAM, GENERIC_LIKE, GREET, GREET_CLOSE, GREET_COLD, HAPPY, HUM, MUSE,
  SAD, SAD_SONG, SIGH, topicLine, NIGHT_GREET, NIGHT_SNACK, NIGHT_STARS, NIGHT_UP,
} from '../presets/banter';
import { allAnchorTexts, aversionObject, computePersona, copula, extractDream, extractObject, josa, suffix, toBanmal, toGeodeunyo, traitPolarity } from './traits';
import { DEFAULT_CHARACTER_SHEETS, DEFAULT_CONTEXT, DEFAULT_PLACES, type PlacePreset } from '../presets/defaultWorld';
import { animalNamePool, randomAnimalKind, randomAppearance, randomName, randomPlace, randomTraits, randomTreasure } from '../presets/traitPools';
import { guessSentiment, hearsay, makeTag, RumorMill, type Rumor, type TrendRow } from './rumors';
import { impactOf, mutateTraits, type MutationReason } from './mutation';
import { worldTheme } from './worldTheme';
import { PLACE_HINT } from '../presets/placeHints';
import { questId, type Quest } from './quests';
import { coChatCounts, coinName, factionColor, findNewGroups, scopeSpec, type Faction } from './factions';

/** Appearance layers; a treasured item like "낡은 기타" shows up as a prop if nothing else is held. */
function layersFor(appearance: string, kind: AgentKind, name: string, category: string, treasure: string) {
  const L = parseAppearance(appearance, kind, name, category);
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
function innerFromThought(label: string, value: number): string {
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
const DEFAULT_ROLE: Partial<Record<PlaceStyle, string>> = {
  cafe: '카페 점원', karaoke: '노래방 알바생', store: '편의점 알바생', library: '사서', office: '회사원', factory: '공장 기술자',
  restaurant: '요리사', bakery: '제빵사', gym: '헬스 트레이너', hospital: '간호사', school: '선생님', bar: '바텐더', flower: '꽃집 직원', cinema: '영화관 직원',
};
const WORK_LINES: Partial<Record<PlaceStyle, string[]>> = {
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
const MEAL_MORNING: PlaceStyle[] = ['cafe', 'store', 'bakery'];
const MEAL_LUNCH: PlaceStyle[] = ['cafe', 'store', 'bakery', 'restaurant'];
const STUDENT_LINES = ['(졸려…)', '선생님, 질문 있어요!', '쉬는 시간 언제야…', '(시험 범위가 어디까지였지?)', '급식 메뉴 뭐야?', '(필기 열심히 하자.)'];
/** price of leisure per visit (원). Always far below income. */
const PRICE: Record<PlaceStyle, number> = { cafe: 4500, karaoke: 8000, store: 3000, library: 0, home: 0, office: 0, park: 0, plaza: 0, factory: 0, restaurant: 9000, bakery: 4000, gym: 6000, hospital: 5000, school: 0, bar: 12000, flower: 7000, cinema: 13000 };
/** 원 per game minute */
export const WAGE = 160;
export const ALLOWANCE = 60;
const SHIFT_LEN_H = 6;
/** places that keep the lights on: an owl who works here takes the night shift (start hour) */
const NIGHT_SHIFT_START: Partial<Record<PlaceStyle, number>> = { store: 22, bar: 19, karaoke: 19 };
/** animals that are up at night (the rest curl up and sleep) */
const NOCTURNAL = new Set(['owl', 'cat', 'fox', 'hedgehog']);
export const STYLE_LABEL: Record<PlaceStyle, string> = {
  cafe: '카페', karaoke: '노래방', park: '공원', store: '상점', library: '도서관', home: '집', office: '사무실', plaza: '광장', factory: '공장',
  restaurant: '식당', bakery: '빵집', gym: '헬스장', hospital: '병원', school: '학교', bar: '술집', flower: '꽃집', cinema: '영화관',
};
const STYLE_EMOTE: Record<PlaceStyle, string> = {
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
function Renderer_dark(minutes: number) {
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
  private factionAcc = 0;
  /** current game speed (set by Game): 3×+ skips the storyteller, 5×+ summarises conversations */
  simSpeed = 1;
  private pendingPolish: { deadline: number; fire: () => void; done: () => boolean }[] = [];
  private needAcc = 0;
  private relAcc = 0;
  /** game minute until which the power is out (사건: 정전) */
  blackoutUntil = 0;
  /** follow-ups of world events, in game minutes (not saved: transient story beats) */
  private pending: { at: number; run: () => void }[] = [];
  private eventAcc = 0;
  private lastEventAt = -1e9;
  /** the visible area's centre, for sky-wide effects (set by Game each frame via viewRect) */
  /** lazy reactive-trait mutations waiting per Will: due at `readyAt` (game min), applied only when on screen */
  mutationQueue = new Map<string, (MutationReason & { readyAt: number })[]>();
  /** current camera view in world px (set by Game each frame) */
  viewRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private mutAcc = 0;
  mutationsDone = 0;
  private topRumorId: string | null = null;
  simTime = 0;
  matcher: SemanticMatcher;
  private semanticDirty = false;
  private semanticAcc = 0;
  private offSemantic: (() => void) | null = null;
  stats = { thinkMs: 0, thinks: 0, pathMs: 0 };

  private favorCache = new Map<string, number>();
  private seatTaken = new Map<string, string>();
  private listeners = new Set<Listener>();
  private tmp: Agent[] = [];
  private placeDoorSide = new Map<string, DoorSide>();

  /** Shared embedding source (set once by the app; absent in Node tests → lexical only). */
  /** generative Layer-2 rewriting hook (see ai/storyteller.ts) */
  static storyHook: ((req: StoryRequest) => void) | null = null;
  /** a line learned from earlier rewrites for this template (ai/phraseBank) — used when the storyteller isn't */
  static learnedLine: ((draft: string, speaker: Agent, listener: Agent) => string | null) | null = null;
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
  private warmSemantics(e: Agent | Place) {
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
  private rebuildGrid() {
    const g = new SpatialGrid<Agent>(this.map.w * TILE, 64);
    for (const a of this.agents) g.insert(a);
    this.grid = g;
  }

  // ───────────────────────── map editing ─────────────────────────
  static readonly MAP_MIN = { w: 24, h: 16 };
  static readonly MAP_MAX = { w: 400, h: 300 };

  /**
   * Map painting from a sentence ("중앙에 인도를 쭉 깔아 줘", "공원 주변에 꽃 심어 줘",
   * "카페에서 도서관까지 흙길", "길가에 가로등"). Ground brushes cover the area; trees, flowers,
   * lamps and benches are spaced out or scattered. Buildings are never painted over.
   */
  paintArea(brush: MapBrush, area: PaintArea, opt: { width?: number; count?: number; density?: 'few' | 'many'; only?: MapBrush } = {}): { ok: boolean; message: string; changed: number } {
    const m = this.map;
    const ground = brush === 'road' || brush === 'sidewalk' || brush === 'dirt' || brush === 'plaza' || brush === 'grass';
    const deco = !ground && brush !== 'erase';
    const GROUND_OF: Partial<Record<MapBrush, number>> = { road: G.Road, sidewalk: G.Sidewalk, dirt: G.Dirt, plaza: G.Plaza, grass: G.Grass };
    const DECO_OF: Partial<Record<MapBrush, number>> = { tree: D.Tree, bush: D.Bush, flower: D.Flower, lamp: D.Lamp, bench: D.Bench };
    const free = (x: number, y: number) => m.inBounds(x, y) && m.owner[m.idx(x, y)] === 0;
    const isRoad = (x: number, y: number) => m.inBounds(x, y) && m.ground[m.idx(x, y)] === G.Road;
    const nearDoor = (x: number, y: number) => this.places.some((p) => Math.abs(p.door.tx - x) <= 1 && Math.abs(p.door.ty - y) <= 2);
    // a decoration may go here: open land, not on asphalt, not in front of a door
    const decoOk = (x: number, y: number) => {
      if (!free(x, y) || isRoad(x, y) || nearDoor(x, y)) return false;
      const i = m.idx(x, y);
      if (m.deco[i] !== D.None) return false;
      const g = m.ground[i];
      return brush === 'lamp' || brush === 'bench' ? true : g === G.Grass || g === G.Dirt || (brush === 'flower' && g === G.Plaza);
    };
    let changed = 0, roadHits = 0;
    const put = (x: number, y: number, size = 1) => {
      if (!m.inBounds(x, y)) return;
      // a path of earth or pavement doesn't dig up an existing road
      if (ground && brush !== 'road' && size === 1 && isRoad(x, y) && !opt.only) return void roadHits++;
      changed += this.paintMap(x, y, brush, size);
    };
    const spaced = (tiles: { tx: number; ty: number }[]) => {
      const gap = { tree: 3, bush: 2, flower: 1, lamp: 6, bench: 7 }[brush as 'tree'] ?? 2;
      let last = -1e9, k = 0;
      for (const t of tiles) {
        k++;
        if (k - last < gap || !decoOk(t.tx, t.ty)) continue;
        if (m.paint(t.tx, t.ty, brush)) (changed++, (last = k));
      }
    };
    const scatter = (cands: { tx: number; ty: number }[], n0: number) => {
      const n = opt.count ?? Math.max(1, Math.round(n0 * (opt.density === 'many' ? 2 : opt.density === 'few' ? 0.4 : 1)));
      const pool = cands.filter((t) => decoOk(t.tx, t.ty));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const t of pool.slice(0, n)) changed += this.paintMap(t.tx, t.ty, brush, 1);
    };
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      const out: { tx: number; ty: number }[] = [];
      for (let y = Math.max(0, y0); y <= Math.min(m.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(m.w - 1, x1); x++) out.push({ tx: x, ty: y });
      return out;
    };
    const W = m.w, H = m.h;
    const width = Math.max(1, Math.min(6, opt.width ?? ({ road: 2, sidewalk: 2, dirt: 1, plaza: 3, grass: 2 }[brush as 'road'] ?? 1)));
    // clear / replace: "나무 다 베어 줘", "도로를 다 없애 줘"
    const replace = (tiles: { tx: number; ty: number }[]) => {
      const only = opt.only;
      for (const t of tiles) {
        if (!free(t.tx, t.ty)) continue;
        const i = m.idx(t.tx, t.ty);
        if (brush === 'erase') {
          if (m.deco[i] === D.None || (only && DECO_OF[only] !== undefined && m.deco[i] !== DECO_OF[only]) || m.deco[i] === D.Wall || m.deco[i] === D.Door) continue;
          if (m.paint(t.tx, t.ty, 'erase')) changed++;
        } else if (only && GROUND_OF[only] !== undefined) {
          const g = m.ground[i];
          const match = only === 'road' ? g === G.Road || g === G.Sidewalk : g === GROUND_OF[only];
          if (match && m.ground[i] !== GROUND_OF[brush]) {
            m.paint(t.tx, t.ty, brush);
            changed++;
          }
        }
      }
    };
    let where = '';
    switch (area.kind) {
      case 'line': {
        const at = area.at ?? 'center';
        const rowAt = { center: Math.floor(H / 2), top: Math.floor(H * 0.25), bottom: Math.floor(H * 0.75), left: Math.floor(H / 2), right: Math.floor(H / 2) }[at];
        const colAt = { center: Math.floor(W / 2), left: Math.floor(W * 0.25), right: Math.floor(W * 0.75), top: Math.floor(W / 2), bottom: Math.floor(W / 2) }[at];
        const dir = area.dir ?? (at === 'left' || at === 'right' ? 'v' : at === 'top' || at === 'bottom' ? 'h' : W >= H ? 'h' : 'v');
        const off = -Math.floor((width - 1) / 2);
        const h = () => {
          const row = Array.from({ length: W }, (_, x) => ({ tx: x, ty: rowAt }));
          if (deco) spaced(row);
          else for (let k = 0; k < width; k++) for (let x = 0; x < W; x++) put(x, rowAt + off + k);
        };
        const v = () => {
          const col = Array.from({ length: H }, (_, y) => ({ tx: colAt, ty: y }));
          if (deco) spaced(col);
          else for (let k = 0; k < width; k++) for (let y = 0; y < H; y++) put(colAt + off + k, y);
        };
        if (dir !== 'v') h();
        if (dir !== 'h') v();
        where = `${{ center: '가운데', top: '위쪽', bottom: '아래쪽', left: '왼쪽', right: '오른쪽' }[at]}에 ${{ h: '가로로', v: '세로로', cross: '십자로' }[dir]}`;
        break;
      }
      case 'border': {
        const ring: { tx: number; ty: number }[] = [];
        for (let x = 1; x < W - 1; x++) ring.push({ tx: x, ty: 1 });
        for (let y = 2; y < H - 1; y++) ring.push({ tx: W - 2, ty: y });
        for (let x = W - 3; x >= 1; x--) ring.push({ tx: x, ty: H - 2 });
        for (let y = H - 3; y >= 2; y--) ring.push({ tx: 1, ty: y });
        if (deco) spaced(ring);
        else for (const t of ring) put(t.tx, t.ty, 1);
        where = '맵 테두리를 따라';
        break;
      }
      case 'roadside': {
        const side: { tx: number; ty: number }[] = [];
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            if (isRoad(x, y)) continue;
            // the first tile off the asphalt (past the auto-sidewalk)
            const n4 = [isRoad(x - 2, y), isRoad(x + 2, y), isRoad(x, y - 2), isRoad(x, y + 2), isRoad(x - 1, y), isRoad(x + 1, y), isRoad(x, y - 1), isRoad(x, y + 1)];
            if (n4.some(Boolean)) side.push({ tx: x, ty: y });
          }
        if (!side.length) return { ok: false, message: '아직 도로가 없어요. 먼저 「가운데에 도로 깔아 줘」처럼 길을 내 보세요.', changed: 0 };
        // walk them in reading order per row/column so spacing looks even
        side.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
        if (deco) spaced(side);
        else for (const t of side) put(t.tx, t.ty, 1);
        where = '길가에';
        break;
      }
      case 'around': {
        const e = area.target;
        const r = area.radius ?? (ground ? 1 : 3);
        let tiles: { tx: number; ty: number }[];
        if ('tw' in e) tiles = rect(e.tx - r, e.ty - r, e.tx + e.tw - 1 + r, e.ty + e.th - 1 + r).filter((t) => free(t.tx, t.ty));
        else {
          const c = this.tileOf(e);
          tiles = rect(c.tx - r, c.ty - r, c.tx + r, c.ty + r).filter((t) => (t.tx - c.tx) ** 2 + (t.ty - c.ty) ** 2 <= r * r + 1);
        }
        if (deco) scatter(tiles, Math.max(2, Math.round(tiles.length * ({ flower: 0.4, tree: 0.15, bush: 0.15, lamp: 0.04, bench: 0.04 }[brush as 'tree'] ?? 0.1))));
        else if (brush === 'erase' || opt.only) replace(tiles);
        else for (const t of tiles) if (!nearDoor(t.tx, t.ty) || brush !== 'grass') put(t.tx, t.ty, 1);
        where = `${e.name} 주변에`;
        break;
      }
      case 'path': {
        const from = area.from, to = area.to;
        const outside = (p: Agent | Place): { tx: number; ty: number } => {
          if (!('tw' in p)) return this.tileOf(p);
          const d = p.door;
          for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (free(d.tx + dx, d.ty + dy)) return { tx: d.tx + dx, ty: d.ty + dy };
          return d;
        };
        const goal = outside(to);
        let start: { tx: number; ty: number } | null = from ? outside(from) : null;
        if (!start) {
          // from the nearest road or pavement (or the middle of the map if there's none)
          let best = Infinity;
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const g = m.ground[m.idx(x, y)];
              if ((g !== G.Road && g !== G.Sidewalk && g !== G.Plaza && g !== G.Dirt) || !free(x, y)) continue;
              const d = Math.abs(x - goal.tx) + Math.abs(y - goal.ty);
              if (d < best && d > 1) (best = d), (start = { tx: x, ty: y });
            }
          start ??= { tx: Math.floor(W / 2), ty: Math.floor(H / 2) };
        }
        const route = this.groundRoute(start, goal);
        if (!route) return { ok: false, message: '건물에 막혀 길을 이을 수 없어요.', changed: 0 };
        if (deco) spaced(route);
        else for (const t of route) put(t.tx, t.ty, width >= 2 ? 2 : 1);
        where = from ? `${from.name}에서 ${to.name}까지` : `${to.name}까지`;
        break;
      }
      case 'region': {
        const q = area.where;
        const x3 = Math.floor(W / 3), y3 = Math.floor(H / 3), xm = Math.floor(W / 2), ym = Math.floor(H / 2);
        const R: Record<typeof q, [number, number, number, number]> = {
          all: [0, 0, W - 1, H - 1], top: [0, 0, W - 1, y3], bottom: [0, H - y3, W - 1, H - 1], left: [0, 0, x3, H - 1], right: [W - x3, 0, W - 1, H - 1],
          topleft: [0, 0, xm, ym], topright: [xm, 0, W - 1, ym], bottomleft: [0, ym, xm, H - 1], bottomright: [xm, ym, W - 1, H - 1], center: [x3, y3, W - x3, H - y3],
        };
        const tiles = rect(...R[q]);
        if (brush === 'erase' || opt.only) replace(tiles);
        else if (deco) scatter(tiles, Math.max(4, Math.round(tiles.length * ({ flower: 0.03, tree: 0.016, bush: 0.012, lamp: 0.004, bench: 0.004 }[brush as 'tree'] ?? 0.01))));
        else for (const t of tiles) if (free(t.tx, t.ty) && !nearDoor(t.tx, t.ty)) put(t.tx, t.ty, 1);
        where = { all: '마을 전체에', top: '위쪽에', bottom: '아래쪽에', left: '왼쪽에', right: '오른쪽에', topleft: '왼쪽 위에', topright: '오른쪽 위에', bottomleft: '왼쪽 아래에', bottomright: '오른쪽 아래에', center: '가운데에' }[q];
        break;
      }
    }
    const NAME: Record<MapBrush, string> = { road: '도로', sidewalk: '인도', dirt: '흙길', plaza: '돌바닥', grass: '잔디', tree: '나무', bush: '덤불', flower: '꽃', lamp: '가로등', bench: '벤치', erase: '장식' };
    if (!changed) {
      if (area.kind === 'line' && ground && brush !== 'road' && roadHits > 0) return { ok: false, message: `${where}에는 이미 큰길과 양옆 ${NAME.sidewalk}${suffix(NAME.sidewalk, '이/가')} 있어요 — 「위쪽에 가로로 ${NAME[brush]}」처럼 다른 곳을 말해 보세요.`, changed: 0 };
      const what = brush === 'erase' ? (opt.only ? NAME[opt.only] : '장식') : NAME[opt.only ?? brush];
      return { ok: false, message: brush === 'erase' || opt.only ? `바뀐 곳이 없어요 — ${where.replace(/에$/, '')}에는 ${josa(what, '이/가')} 없어요.` : `바뀐 곳이 없어요 — ${where.replace(/에$/, '')}에는 이미 ${josa(what, '이/가')} 있거나 건물에 막혔어요.`, changed: 0 };
    }
    const verb = brush === 'erase' ? `${josa(opt.only ? NAME[opt.only] : '나무·꽃 같은 장식', '을/를')} 치웠어요` : opt.only ? `${josa(NAME[opt.only], '을/를')} ${NAME[brush]}${josa(NAME[brush], '으로/로').slice(NAME[brush].length)} 바꿨어요` : ground ? `${josa(NAME[brush], '을/를')} 깔았어요` : `${josa(NAME[brush], '을/를')} ${{ tree: '심었어요', flower: '심었어요', bush: '심었어요', lamp: '세웠어요', bench: '놓았어요' }[brush as 'tree']}`;
    return { ok: true, message: `🛠️ ${where} ${verb} (${changed}칸). 마음에 안 들면 Ctrl+Z`, changed };
  }

  /** a walkable-on-foot route for a new path: around buildings, preferring existing roads (4-way A*) */
  private groundRoute(s: { tx: number; ty: number }, g: { tx: number; ty: number }): { tx: number; ty: number }[] | null {
    const m = this.map;
    const N = m.w * m.h;
    const cost = new Float32Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const open: [number, number][] = [];
    const push = (i: number, f: number) => {
      open.push([f, i]);
      let k = open.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (open[p][0] <= open[k][0]) break;
        [open[p], open[k]] = [open[k], open[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = open[0];
      const last = open.pop()!;
      if (open.length) {
        open[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let s2 = k;
          if (l < open.length && open[l][0] < open[s2][0]) s2 = l;
          if (r < open.length && open[r][0] < open[s2][0]) s2 = r;
          if (s2 === k) break;
          [open[s2], open[k]] = [open[k], open[s2]];
          k = s2;
        }
      }
      return top;
    };
    const si = m.idx(s.tx, s.ty), gi = m.idx(g.tx, g.ty);
    const h = (i: number) => Math.abs((i % m.w) - g.tx) + Math.abs(Math.floor(i / m.w) - g.ty);
    cost[si] = 0;
    push(si, h(si));
    let seen = 0;
    while (open.length && seen++ < 200000) {
      const [, i] = pop();
      if (i === gi) break;
      const x = i % m.w, y = Math.floor(i / m.w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!m.inBounds(nx, ny)) continue;
        const j = m.idx(nx, ny);
        if (m.owner[j] !== 0 && j !== gi) continue;
        const gnd = m.ground[j];
        const step = gnd === G.Road || gnd === G.Sidewalk || gnd === G.Dirt || gnd === G.Plaza ? 1 : 1.6;
        const c = cost[i] + step;
        if (c < cost[j]) {
          cost[j] = c;
          prev[j] = i;
          push(j, c + h(j));
        }
      }
    }
    if (prev[gi] < 0 && gi !== si) return null;
    const out: { tx: number; ty: number }[] = [];
    for (let i = gi; i >= 0; i = prev[i]) out.push({ tx: i % m.w, ty: Math.floor(i / m.w) });
    return out.reverse();
  }

  /** Paint a square brush (size 1–3) centred on a tile. Returns how many tiles changed. */
  paintMap(tx: number, ty: number, brush: MapBrush, size = 1): number {
    let n = 0;
    const r0 = -Math.floor((size - 1) / 2), r1 = r0 + size - 1;
    for (let dy = r0; dy <= r1; dy++) for (let dx = r0; dx <= r1; dx++) if (this.map.paint(tx + dx, ty + dy, brush)) n++;
    if (n) {
      // nobody gets stuck inside a freshly planted tree or lamp post
      for (const a of this.agents) {
        const t = this.tileOf(a);
        if (!this.map.isBlocked(t.tx, t.ty)) continue;
        const free = this.map.nearestWalkable(t.tx, t.ty);
        this.grid.remove(a);
        a.x = (free.tx + 0.5) * TILE;
        a.y = (free.ty + 0.5) * TILE;
        this.grid.insert(a);
        a.ai.path = [];
        a.ai.pathIndex = 0;
      }
    }
    return n;
  }

  /**
   * Resize the map like a window: tiles added (+) or cut (−) on the left, top, right and bottom.
   * Buildings may not be cut; everything shifts by (dl, dt) tiles when the left/top edge moves.
   */
  resizeMap(dl: number, dt: number, dr: number, db: number): { ok: boolean; message: string } {
    const W = this.map.w + dl + dr, H = this.map.h + dt + db;
    if (!dl && !dt && !dr && !db) return { ok: true, message: '' };
    const { MAP_MIN: mn, MAP_MAX: mx } = World;
    if (W < mn.w || H < mn.h) return { ok: false, message: `세계가 너무 작아져요 (최소 ${mn.w}×${mn.h}칸)` };
    if (W > mx.w || H > mx.h) return { ok: false, message: `세계가 너무 커져요 (최대 ${mx.w}×${mx.h}칸)` };
    for (const p of this.places) {
      const x0 = p.tx + dl, y0 = p.ty + dt;
      if (x0 < 1 || y0 < 1 || x0 + p.tw > W - 1 || y0 + p.th > H - 1) return { ok: false, message: `${josa(p.name, '이/가')} 잘려요 — 그쪽 건물을 먼저 지우거나 덜 줄여 주세요.` };
    }
    this.map.resize(dl, dt, dr, db, hashString(`resize${W}x${H}`));
    if (dl || dt) {
      const ox = dl * TILE, oy = dt * TILE;
      const mv = (s: { tx: number; ty: number }) => {
        s.tx += dl;
        s.ty += dt;
      };
      for (const p of this.places) {
        mv(p);
        mv(p.door);
        p.seats.forEach(mv);
        p.workSpots.forEach(mv);
      }
      for (const a of this.agents) {
        a.x += ox;
        a.y += oy;
        for (const n of a.ai.path) (n.x += ox), (n.y += oy);
      }
      for (const e of this.effects) (e.x += ox), (e.y += oy);
      const seats = [...this.seatTaken];
      this.seatTaken.clear();
      for (const [k, id] of seats) {
        const [x, y] = k.split(',').map(Number);
        this.seatTaken.set(`${x + dl},${y + dt}`, id);
      }
    }
    // anyone left outside a shrunk edge walks back in
    for (const a of this.agents) {
      const tx = Math.floor(a.x / TILE), ty = Math.floor(a.y / TILE);
      if (this.map.inBounds(tx, ty) && !this.map.isBlocked(tx, ty)) continue;
      const free = this.map.nearestWalkable(Math.max(0, Math.min(W - 1, tx)), Math.max(0, Math.min(H - 1, ty)));
      a.x = (free.tx + 0.5) * TILE;
      a.y = (free.ty + 0.5) * TILE;
      a.ai.path = [];
      a.ai.pathIndex = 0;
    }
    this.rebuildGrid();
    return { ok: true, message: `🗺️ 세계 크기를 ${W}×${H}칸으로 바꿨어요.` };
  }

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
  private dislikeDetail(a: Agent, target: Agent): { score: number; obj: string; facet: string } | null {
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
  private unease(a: Agent, b: Agent): { kind: 'history' | 'clash' | 'look'; detail: string } | null {
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
    const a: Agent = {
      id: uid(kind === 'person' ? 'h' : 'a'),
      kind,
      name: sheet.name,
      category: sheet.category,
      appearance: sheet.appearance,
      traits: sheet.traits,
      persona: computePersona(sheet.traits, this.matcher),
      layers: layersFor(sheet.appearance, kind, sheet.name, `${sheet.category} ${sheet.job ?? ''}`, sheet.treasure ?? ''),
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
  spawnRandomized(spec: { kind: AgentKind; name?: string; category?: string; appearance?: string; traits?: string[]; mood?: number; job?: string; treasure?: string }, x?: number, y?: number) {
    const seed = hashString((spec.name ?? '') + (spec.appearance ?? '') + Date.now() + ':' + this.agents.length + ':' + Math.random());
    const taken = new Set(this.agents.map((a) => a.name));
    const kind = spec.kind;
    const category = spec.category ?? (kind === 'person' ? '윌' : '길고양이');
    const appearance = spec.appearance?.trim() || randomAppearance(this.meta.context, kind, category, seed);
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
        if (taken.has(name)) name += (seed % 9) + 1;
      } else name = randomName(this.meta.context, seed, taken);
    }
    const treasure = spec.treasure?.trim() || randomTreasure(this.meta.context, kind, seed);
    const a = this.addAgent({ name, category, appearance, traits, mood: spec.mood ?? 50 + (seed % 30), job: spec.job, treasure }, kind, x, y);
    // an uncurated world ("고양이들이 다스리는 왕국"…): let the storyteller re-imagine the random parts
    if (kind === 'person' && worldTheme(this.meta.context) === 'other')
      this.reimagine(a, { appearance: !spec.appearance?.trim(), job: !spec.job?.trim(), treasure: !spec.treasure?.trim(), keepTraits: given.length });
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
  private rectFreeIgnoringPaint(p: { tx: number; ty: number; tw: number; th: number }) {
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
    a.layers = layersFor(a.appearance, a.kind, a.name, `${a.category} ${a.job}`, a.treasure);
    a.persona = computePersona(a.traits, this.matcher);
    this.invalidateFavor(a.id);
    this.warmSemantics(a);
  }
  sheetOf(a: Agent): string {
    return serializeSheet({ name: a.name, category: a.category, appearance: a.appearance, job: a.job || undefined, treasure: a.treasure || undefined, traits: a.traits, mood: a.baseMood });
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
  private requestPolish(kind: 'line' | 'monologue', a: Agent, draft: string, listener: Agent | undefined, topic: string | undefined, important: boolean, history: { name: string; text: string }[], done: (text: string, ai: boolean) => void): boolean {
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
      world: this, kind, speaker: a, listener, draft, topic, important, history: [...history],
      apply: (text) => finish(draft.startsWith('(') && !text.startsWith('(') ? `(${text})` : text, true),
      fail: () => finish(draft, false),
    });
    return true;
  }
  /** Speak a monologue/inner line, through the storyteller when there's capacity ("…" while it writes). */
  private speakPolished(a: Agent, draft: string, important: boolean, opts: { thought?: boolean; kind?: FeedItem['kind'] }) {
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
  private thinkCursor = 0;
  private thinkSliced() {
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

  private speedMul(a: Agent) {
    const e = 1 + a.persona.energy * 0.12;
    if (a.ai.mode === 'break') return 0.6;
    if (a.mood >= 80) return 1.22 * e;
    if (a.mood <= 20) return 0.72 * e;
    return e;
  }

  private move(a: Agent, dt: number) {
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
  private sepBuf: Agent[] = [];
  private separate(a: Agent, dt: number) {
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

  private pathTo(a: Agent, tx: number, ty: number): boolean {
    const t0 = performance.now();
    const s = this.tileOf(a);
    const path = this.map.findPath(s.tx, s.ty, tx, ty);
    this.stats.pathMs = this.stats.pathMs * 0.9 + (performance.now() - t0) * 0.1;
    if (!path) return false;
    a.ai.path = path.map((p) => ({ x: (p.tx + 0.5) * TILE + (Math.random() - 0.5) * 6, y: (p.ty + 0.5) * TILE + (Math.random() - 0.5) * 6 }));
    a.ai.pathIndex = 0;
    return true;
  }

  private setIdle(a: Agent, seconds: number) {
    this.releaseSeat(a);
    a.ai.working = false;
    a.ai.mode = 'idle';
    a.ai.path = [];
    a.ai.pathIndex = 0;
    a.ai.timer = seconds;
    a.ai.targetPlaceId = undefined;
  }

  private releaseSeat(a: Agent) {
    for (const [k, v] of this.seatTaken) if (v === a.id) this.seatTaken.delete(k);
  }

  private arrive(a: Agent) {
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

  // ───────────────────────── thinking ─────────────────────────
  private think(a: Agent) {
    const ai = a.ai;
    ai.nextThinkAt = this.simTime + 0.5 + Math.random() * 0.7;
    const now = this.meta.minutes;
    if (a.thoughts.length) a.thoughts = a.thoughts.filter((t) => t.expiresAt > now);

    this.perceive(a);
    if (ai.mode === 'chat') return;

    // meeting a requested partner (MEET event / seeking a friend)
    if (ai.meetWith && this.showBusy(a)) ai.meetWith = undefined;
    if (ai.meetWith) {
      const b = this.agent(ai.meetWith);
      if (!b || ai.timer <= 0) {
        // partner gone or gave up looking
        ai.meetWith = undefined;
        ai.meetForced = false;
      } else {
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < 44) {
          const forced = ai.meetForced;
          const grumble = ai.mode === 'break' && ai.breakKind === 'grumble';
          ai.meetWith = undefined;
          ai.meetForced = false;
          if (b.ai.meetWith === a.id) b.ai.meetWith = undefined;
          const existing = this.convoOf(b);
          if (existing && existing.members.length < 5 && !grumble) this.joinConvo(existing, a);
          else if (existing && grumble) this.endConvo(existing);
          if (!existing || grumble) {
            if (forced || this.canChat(a, b)) this.startConvo([a, b], grumble);
            else this.setIdle(a, 2);
          }
          return;
        } else if (ai.pathIndex >= ai.path.length || Math.random() < 0.25) {
          const bt = this.tileOf(b);
          if (ai.mode !== 'break') ai.mode = 'goto';
          ai.targetPlaceId = undefined;
          this.pathTo(a, bt.tx, bt.ty);
          return;
        }
      }
    }

    // spontaneous encounters
    if (a.kind === 'person' && ai.mode !== 'break' && !this.showBusy(a)) {
      const near = this.grid.queryRadius(a.x, a.y, 52, this.tmp);
      for (const b of near) {
        if (b === a || b.kind !== 'person') continue;
        const c = this.convoOf(b);
        if (c) {
          if (c.members.length < 5 && !c.argue && this.wantsToJoin(a, c) && Math.random() < 0.35) {
            this.joinConvo(c, a);
            return;
          }
          continue;
        }
        if (Math.hypot(b.x - a.x, b.y - a.y) < 38 && this.canChat(a, b) && b.ai.mode !== 'break' && Math.random() < this.chatChance(a, b)) {
          // bad blood, clashing tempers or a foul mood can turn a meeting into an argument
          const feel = this.feel(a.id, b.id);
          const hot = Math.max(0, a.persona.temper);
          const argue = (feel <= -20 && Math.random() < 0.35) || (this.clash(a, b) >= 0.5 && Math.random() < 0.12 + hot * 0.2) || (a.mood < 30 && Math.random() < hot * 0.25);
          this.startConvo([a, b], argue);
          return;
        }
      }
    }

    switch (ai.mode) {
      case 'idle':
        if (ai.timer <= 0) this.decide(a);
        else if (a.mood >= 80 && Math.random() < 0.04 && a.kind === 'person') this.say(a, pick(HUM), { silentFeed: true });
        else if (Math.random() < 0.03) this.innerMonologue(a);
        break;
      case 'visit':
        this.visitTick(a);
        if (ai.timer <= 0) this.decide(a);
        break;
      case 'break':
        this.breakTick(a);
        if (ai.timer <= 0) this.endBreak(a);
        break;
      case 'goto':
      case 'wander':
        if (ai.pathIndex >= ai.path.length) this.decide(a);
        else if (ai.timer < -40) this.decide(a); // safety
        break;
    }
  }

  private canChat(a: Agent, b: Agent) {
    if (a.ai.sleeping || b.ai.sleeping || this.showBusy(a) || this.showBusy(b)) return false;
    const last = Math.max(a.ai.lastChatAt[b.id] ?? -999, b.ai.lastChatAt[a.id] ?? -999);
    return this.simTime - last > 75 && b.ai.mode !== 'chat' && a.ai.mode !== 'chat';
  }
  private chatChance(a: Agent, b: Agent) {
    const rel = this.peekRelation(a.id, b.id);
    let p = 0.16 + a.persona.social * 0.15 + b.persona.social * 0.08 + (this.sharesGroup(a.id, b.id) ? 0.12 : 0);
    if (rel) p += this.feel(a.id, b.id) / 200;
    if (a.mood >= 80) p += 0.25;
    if (a.mood <= 25) p -= 0.15;
    return clamp(p, 0.05, 0.85);
  }
  private wantsToJoin(a: Agent, c: Conversation) {
    for (const m of c.members) {
      if (this.feel(a.id, m) >= 30 || this.sharesGroup(a.id, m)) return true;
    }
    for (const t of a.traits) if (this.matcher.similarity(t, c.topic) >= 0.65) return true;
    return false;
  }

  private perceive(a: Agent) {
    if (a.ai.sleeping) return; // asleep: the world can wait till morning
    const near = this.grid.queryRadius(a.x, a.y, 80, this.tmp);
    for (const b of near) {
      if (b === a) continue;
      if (a.kind === 'person' && b.kind === 'animal') this.meetAnimal(a, b);
      if (a.kind === 'person' && b.kind === 'animal' && !this.hasThought(a, `fear:${b.id}`)) {
        // only a dislike that really is about this kind of animal (the old embedding scored
        // "비 오는 날" ≈ "길고양이", so cat lovers screamed at cats — see 4-38)
        const d = this.dislikeDetail(a, b);
        if (d && d.score >= 0.7) {
          const sp = SPECIES_WORDS[b.layers.species].split(' ')[0];
          this.addThought(a, `fear:${b.id}`, `${josa(b.name, '을/를')} 보고 깜짝 놀람`, -8, 90);
          this.emote(a, '❗');
          this.say(a, pick(['으악, 저리 가!', '히익… 가까이 오지 마.', `(${sp}… 난 정말 ${d.obj.includes(sp) ? '무서워' : '별로야'}.)`, '저, 저기로 가 줄래?']), { thought: false });
          this.log(a, 'diary', `${josa(b.name, '을/를')} 마주쳤다. ${d.obj}만 보면 아직도 몸이 굳는다.`, b.id);
          if (a.ai.mode !== 'chat') this.wander(a, 8);
        }
      }
      if (a.kind === 'person' && b.kind === 'person' && !this.hasThought(a, `uneasy:${b.id}`)) {
        const u = this.unease(a, b);
        if (u) {
          const n = this.referName(a, b);
          const line =
            u.kind === 'history'
              ? pick([`(${n}… 저 사람이랑은 좀 어색해.)`, `(${josa(n, '이랑/랑')}은 잘 안 맞는 것 같아.)`, `(또 ${n}… 마주치기 싫다.)`, `(${n}… 지난번 일이 아직 마음에 걸려.)`])
              : u.kind === 'clash'
                ? pick([`(${n}, 나랑은 결이 좀 다른 것 같아.)`, `(${n}, ${u.detail}… 같이 있으면 기가 빨려.)`, `(${n}… 아직은 좀 어렵다.)`])
                : pick([`(저 ${u.detail}… 괜히 신경 쓰이네.)`, `(${n}의 ${u.detail}, 왠지 눈에 거슬려.)`]);
          this.addThought(a, `uneasy:${b.id}`, u.kind === 'history' ? `${josa(b.name, '와/과')} 마주쳐 어색함` : `${b.name} 곁이 왠지 불편함`, u.kind === 'history' ? -5 : -3, 120);
          this.emote(a, '💦');
          this.say(a, line, { thought: true });
          if (u.kind === 'history' && Math.random() < 0.5) this.log(a, 'diary', `${josa(b.name, '을/를')} 또 마주쳤다. 아직은 어색하다.`, b.id);
          if (u.kind === 'history' && a.ai.mode !== 'chat' && Math.random() < 0.6) this.wander(a, 6);
        }
      }
    }
    if (a.kind === 'person') {
      this.perceiveWeather(a);
      if (a.money < 10000) this.addThought(a, 'money', '돈이 궁해서 걱정', -4, 30);
      else if (a.money > 400000) this.addThought(a, 'money', '통장이 두둑해 든든함', 3, 30);
      else if (this.hasThought(a, 'money')) a.thoughts = a.thoughts.filter((t) => t.key !== 'money');
    }
  }

  private meetAnimal(a: Agent, b: Agent) {
    const key = `pet:${b.id}`;
    if (this.hasThought(a, key) || a.ai.mode === 'chat') return;
    const f = this.favor(a, b);
    if (f < 0.45) return;
    const lowBefore = a.mood <= 40;
    const val = lowBefore ? 20 : 14;
    const label = lowBefore ? `운명처럼 나타난 ${josa(b.name, '을/를')} 쓰다듬음` : `${josa(b.name, '을/를')} 쓰다듬음`;
    this.addThought(a, key, label, val, 240);
    a.facing = b.x < a.x ? 'left' : 'right';
    this.emote(a, '❤️');
    this.emote(b, '❤️');
    const line = topicLine(b.category + b.appearance) ?? `${b.name}야~ 이리 와!`;
    this.say(a, line);
    this.say(b, pick(ANIMAL_SOUNDS[b.layers.species] ?? ANIMAL_SOUNDS.cat), { silentFeed: true });
    this.addFeel(a.id, b.id, 8);
    this.addFeel(b.id, a.id, 6);
    const rel = this.relation(a.id, b.id);
    if (rel.memories.length < 1 || Math.random() < 0.3) rel.memories.push({ t: this.meta.minutes, text: `${josa(a.name, '이/가')} ${josa(b.name, '을/를')} 쓰다듬었다.` });
    this.log(b, 'diary', pick([
      `${josa(a.name, '이/가')}라는 인간이 나를 쓰다듬었다. 나쁘지 않았다.`,
      `오늘도 ${josa(a.name, '이/가')} 내 이름을 불렀다. 못 이기는 척 다가가 줬다.`,
      `${a.name}의 손은 따뜻했다. 다음에도 와 주면 좋겠다.`,
    ]), a.id);
    if (lowBefore && !this.hasThought(a, 'cared')) {
      this.addThought(a, 'cared', '누군가 나를 위로해 준 하루', 3, 720);
      this.log(a, 'diary', `힘든 하루였는데, ${b.name} 덕분에 오랜만에 웃었다. 고마워.`, b.id);
      this.pushFeed({ kind: 'care', speakerId: a.id, speaker: a.name, text: `${a.name}의 표정이 밝아졌다 — ${b.name} 덕분에.` });
      this.naturalRumor(`${josa(a.name, '이/가')} ${b.name} 덕분에 다시 웃게 됐대`, [a, b], a, 0.6, 'care');
    } else this.log(a, 'diary', `${josa(b.name, '을/를')} 만나 쓰다듬어 줬다.`, b.id);
    if (a.ai.mode !== 'break' && a.ai.mode !== 'visit') this.setIdle(a, 3);
    if (b.ai.mode !== 'chat') this.setIdle(b, 4);
  }

  private perceiveWeather(a: Agent) {
    const w = this.meta.weather;
    const t = this.tileOf(a);
    const outdoor = this.map.isOutdoor(t.tx, t.ty);
    const likesRain = a.traits.some((s) => /비 ?오는|빗소리|비가/.test(s) && LIKE_RE.test(s));
    const hatesRain = a.traits.some((s) => /비 ?오는|비가|비를/.test(s) && DISLIKE_RE.test(s));
    if (w === 'rain' || w === 'storm') {
      if (likesRain) this.addThought(a, 'weather', '빗소리가 좋다', 8, 30);
      else if (hatesRain) this.addThought(a, 'weather', '비 오는 날은 질색이다', -10, 30);
      else if (outdoor && a.layers.prop !== 'umbrella' && a.layers.outfitStyle !== 'raincoat') this.addThought(a, 'weather', '비에 쫄딱 젖음', -6, 20);
      if (w === 'storm' && !this.hasThought(a, 'thunder') && Math.random() < 0.05) {
        this.addThought(a, 'thunder', '천둥소리에 깜짝 놀람', -5, 40);
        this.emote(a, '❗');
      }
    } else if (w === 'snow') {
      this.addThought(a, 'weather', '눈이 내려 설렘', 6, 30);
    }
  }

  private decide(a: Agent) {
    // keep sleeping through the night without giving up the bed (unless sleep won't come)
    if (a.kind === 'person' && a.ai.sleeping && a.ai.mode === 'visit' && this.isBedtime(a)) {
      if (this.maybeInsomnia(a)) return;
      a.ai.timer = 40;
      return;
    }
    if (this.showTick(a)) return;
    this.releaseSeat(a);
    a.ai.targetPlaceId = undefined;
    if (a.kind === 'animal') return this.decideAnimal(a);
    if (a.ai.working) this.endShiftIfOver(a);
    // ── each Will's own bedtime (아침형 · 보통 · 올빼미형 · 야간 근무); waking up ──
    if (this.isBedtime(a)) return this.goSleep(a);
    if (a.ai.sleeping) this.wakeUp(a);
    if (a.mood <= 20 && Math.random() < 0.4 && this.simTime - (a.ai.lastBreakAt ?? -999) > 90) return this.startBreak(a);
    if (this.worksAtAll(a) && this.onShift(a) && Math.random() < 0.92) {
      const work = this.chooseWorkplace(a);
      if (work) {
        this.noteWorkplace(a, work);
        return this.goWork(a, work);
      }
    }

    // ── the rhythm of a day ──
    const phase = this.dayPhase();
    const home = this.place(a.homeId);
    if (this.lateHours()) {
      // owls (and the sleepless) stay out; everyone else mostly drifts home before bed
      const up = this.chronotype(a) === 'owl' || (a.ai.awakeUntil ?? 0) > this.simTime;
      if (!up && home && Math.random() < 0.55) return this.goVisit(a, home);
      return this.nightActivity(a);
    }
    if ((phase === 'morning' || phase === 'lunch') && !this.hasThought(a, `meal-${phase}`)) {
      const food = this.places
        .filter((p) => (phase === 'lunch' ? MEAL_LUNCH : MEAL_MORNING).includes(p.style))
        .sort((x, y) => this.favor(a, y) - this.favor(a, x) + (Math.random() - 0.5) * 0.4 + (phase === 'lunch' && y.style === 'restaurant' ? 0.3 : 0))[0];
      const want = !food ? 0 : phase === 'lunch' ? 0.7 : 0.3 + this.favor(a, food) * 0.5;
      if (food && Math.random() < want) {
        a.ai.meal = phase === 'lunch' ? 'lunch' : 'breakfast';
        return this.goVisit(a, food);
      }
    }

    const weekend = weekdayOf(this.meta.minutes).weekend;
    // ── love and needs come before whims ──
    const lover = this.loverOf(a);
    if (lover && (phase === 'evening' || (weekend && this.hour() >= 13)) && !lover.ai.sleeping && !lover.ai.working && !this.hasThought(a, 'date-today') && Math.random() < 0.3 && this.planDate(a, lover)) return;
    const need = this.needsOf(a);
    if (need.food < 30) {
      const food = this.places.filter((p) => MEAL_LUNCH.includes(p.style) && this.openAt(p)).sort((x, y) => this.favor(a, y) - this.favor(a, x))[0];
      if (food && Math.random() < 0.7) {
        a.ai.meal = 'lunch';
        return this.goVisit(a, food);
      }
    }
    // group hangout: members drift to their group's usual spot now and then
    const hang = this.factionsOf(a.id).map((f) => this.place(f.homePlaceId)).find(Boolean);
    if (hang && Math.random() < (weekend ? 0.35 : 0.18)) return this.goVisit(a, hang);

    const raining = this.meta.weather === 'rain' || this.meta.weather === 'storm';
    // favourite place scoring
    let bestPlace: Place | undefined;
    let bestScore = -1;
    for (const p of this.places) {
      if (p.style === 'home' && p.id !== a.homeId && !this.residentsOf(p).some((r) => this.feel(a.id, r.id) >= 50)) continue;
      let s = this.favor(a, p) + Math.random() * 0.35;
      if (raining && p.style !== 'park' && p.style !== 'plaza') s += 0.25;
      if ((p.style === 'bar' || p.style === 'cinema') && this.dayPhase() === 'evening') s += 0.3;
      if (p.style === 'bar' && this.dayPhase() === 'morning') s -= 0.5;
      if (p.style === 'hospital') s += a.mood < 35 ? 0.35 : -0.35;
      if (p.style === 'school' && !/학생|선생|교사/.test(a.job)) s -= 0.25;
      if (this.aversion(a, p) > 0.5) s -= 0.6;
      if (s > bestScore) {
        bestScore = s;
        bestPlace = p;
      }
    }
    // evenings are for favourite places and friends; mornings are quieter
    const eve = (phase === 'evening' ? 1.4 : phase === 'morning' ? 0.7 : 1) * (weekend ? 1.3 : 1);
    const wVisit = bestPlace ? (0.9 + bestScore * 2.5) * eve * (need.fun < 30 ? 1.6 : 1) : 0;
    const wWander = (raining ? 0.4 : 1) * (phase === 'evening' ? 0.7 : 1);
    const wIdle = phase === 'morning' ? 0.9 : 0.5;
    // lonely Wills go looking for company; bored ones for their favourite places
    const wSocial = (a.mood >= 80 ? 1.6 : a.mood <= 30 ? 0.2 : 0.5) * (1 + a.persona.social * 0.6) * eve * (need.social < 30 ? 2.5 : 1);
    const total = wVisit + wWander + wIdle + wSocial;
    let r = Math.random() * total;
    if ((r -= wVisit) < 0 && bestPlace) return this.goVisit(a, bestPlace);
    if ((r -= wWander) < 0) return this.wander(a, Math.round(10 + a.persona.curious * 5));
    if ((r -= wIdle) < 0) {
      this.setIdle(a, 2 + Math.random() * 5);
      return;
    }
    const friend = this.bestFriend(a);
    if (friend && this.canChat(a, friend)) return this.goMeet(a, friend);
    this.wander(a, 10);
  }

  /** walk over to a friend to talk */
  private goMeet(a: Agent, friend: Agent) {
    a.ai.meetWith = friend.id;
    a.ai.meetForced = false;
    a.ai.mode = 'goto';
    a.ai.timer = 30;
    const ft = this.tileOf(friend);
    this.pathTo(a, ft.tx, ft.ty);
  }

  private bestFriend(a: Agent): Agent | undefined {
    let best: Agent | undefined;
    let bestAff = -Infinity;
    for (const b of this.agents) {
      if (b === a || b.kind !== 'person') continue;
      const aff = this.feel(a.id, b.id) + Math.random() * 25;
      if (aff > bestAff) {
        bestAff = aff;
        best = b;
      }
    }
    return best;
  }

  private decideAnimal(a: Agent) {
    const owner = this.agent(a.ownerId);
    if (owner) {
      const home = this.place(owner.homeId);
      if (owner.ai.sleeping && home) {
        // curl up at home
        const spot = home.seats[home.seats.length - 1] ?? home.door;
        const t = this.tileOf(a);
        if (Math.abs(t.tx - spot.tx) + Math.abs(t.ty - spot.ty) > 1 && this.pathTo(a, spot.tx, spot.ty)) return void (a.ai.mode = 'wander');
        this.setIdle(a, 40);
        this.emote(a, '💤');
        return;
      }
      // far away → trot back to them; close by → mostly stay near, sometimes sniff around
      const far = Math.hypot(a.x - owner.x, a.y - owner.y) > 5 * TILE;
      if (far || Math.random() < 0.6) {
        const t = this.tileOf(owner);
        const spot = this.map.nearestWalkable(t.tx + (Math.random() < 0.5 ? -1 : 1), t.ty + 1);
        a.ai.mode = 'wander';
        if (this.pathTo(a, spot.tx, spot.ty) || this.pathTo(a, t.tx, t.ty)) return;
      }
    } else if (a.ownerId) a.ownerId = undefined;
    // night: most animals curl up; owls, cats, foxes and hedgehogs come out
    if (this.isNight() && !NOCTURNAL.has(a.layers.species)) {
      this.setIdle(a, 30 + Math.random() * 30);
      this.emote(a, '💤');
      return;
    }
    if (this.isNight() && a.layers.species === 'owl' && Math.random() < 0.25) this.say(a, '부엉~ 부엉~', { silentFeed: true });
    const r = Math.random();
    if (r < 0.3) {
      this.setIdle(a, 8 + Math.random() * 14);
      this.emote(a, '💤');
      return;
    }
    if (r < 0.5) {
      // wander toward someone who likes animals
      let target: Agent | undefined;
      let best = 0.45;
      for (const b of this.agents) {
        if (b.kind !== 'person') continue;
        const f = this.favor(b, a);
        if (f > best) {
          best = f;
          target = b;
        }
      }
      if (target) {
        const t = this.tileOf(target);
        a.ai.mode = 'wander';
        if (this.pathTo(a, t.tx + 1, t.ty)) return;
      }
    }
    this.wander(a, 6);
  }

  private wander(a: Agent, radius: number) {
    this.releaseSeat(a);
    const t = this.tileOf(a);
    const dest = this.map.randomWalkable(Math.random, { tx: t.tx, ty: t.ty, r: radius });
    a.ai.mode = 'wander';
    a.ai.targetPlaceId = undefined;
    a.ai.timer = 0;
    if (!this.pathTo(a, dest.tx, dest.ty)) this.setIdle(a, 2);
  }

  private goVisit(a: Agent, p: Place, sleeping = false) {
    a.ai.working = false;
    a.ai.sleeping = sleeping;
    if (sleeping) a.ai.meal = undefined;
    let seat = p.seats.find((s) => !this.seatTaken.has(`${s.tx},${s.ty}`));
    if (!seat) {
      const inn = this.inwardOf(p);
      seat = this.map.randomWalkable(Math.random, { tx: p.door.tx + inn.dx * 2, ty: p.door.ty + inn.dy * 2, r: 1 });
    }
    this.seatTaken.set(`${seat.tx},${seat.ty}`, a.id);
    a.ai.mode = 'goto';
    a.ai.targetPlaceId = p.id;
    a.ai.timer = 0;
    if (!this.pathTo(a, seat.tx, seat.ty)) this.wander(a, 6);
  }

  private enterVisit(a: Agent, p: Place) {
    a.ai.mode = 'visit';
    a.ai.timer = 14 + Math.random() * 22;
    a.facing = this.inwardOf(p).facing;
    if (a.ai.working) return this.startWork(a, p);
    if (a.ai.sleeping) {
      a.ai.timer = 40 + Math.random() * 40; // re-checked by decide(); stays asleep while it's night
      this.emote(a, '💤');
      return;
    }
    if (a.kind === 'person') {
      const n = this.needsOf(a);
      if (a.ai.meal || ['restaurant', 'bakery', 'cafe', 'store'].includes(p.style)) n.food = Math.min(100, n.food + (a.ai.meal ? 60 : 30));
      if (this.favor(a, p) >= 0.4 || ['karaoke', 'cinema', 'park', 'bar', 'gym'].includes(p.style)) n.fun = Math.min(100, n.fun + 25);
      if (a.ai.dateWith) this.dateMoment(a, p);
    }
    if (a.ai.meal) {
      const lunch = a.ai.meal === 'lunch';
      a.ai.meal = undefined;
      this.addThought(a, lunch ? 'meal-lunch' : 'meal-morning', lunch ? '점심을 맛있게 먹음' : '모닝커피로 하루를 시작함', 3, lunch ? 300 : 240);
      this.emote(a, lunch ? '🍙' : '☕');
      if (Math.random() < 0.25) this.say(a, lunch ? pick(['(배부르다~)', '(오늘 점심 성공.)', '(역시 여기 밥이 최고야.)']) : pick(['(커피 한 잔이면 충분해.)', '(이제 좀 정신이 드네.)']), { thought: true, silentFeed: true });
    }
    // regulars: the place remembers who keeps coming back
    const n = (p.regulars[a.id] = (p.regulars[a.id] ?? 0) + 1);
    if (n === 3) this.log(p, 'event', `${josa(a.name, '이/가')} 요즘 자주 온다. 단골이 될 것 같다.`, a.id);
    else if (n === 10) this.log(p, 'event', `${josa(a.name, '은/는')} 이제 누가 봐도 이곳의 단골이다.`, a.id);
    // leisure costs a little (always far below income)
    // simplified economy: you only pay when comfortably able to → income always wins
    const price = PRICE[p.style];
    if (price > 0 && a.money > price * 3) a.money -= price;
    const f = this.favor(a, p);
    if (f >= 0.4) {
      const sing = p.style === 'karaoke';
      const label = sing ? `좋아하는 ${p.name}에서 열창함` : `좋아하는 ${p.name}에서 시간을 보냄`;
      if (this.addThought(a, `place:${p.id}`, label, sing ? 15 : 10, 180)) {
        this.log(a, 'diary', sing ? `${p.name}에서 목이 쉬도록 노래했다. 속이 뻥 뚫렸다!` : `${p.name}에 갔다. 역시 여기가 좋다.`);
        this.log(p, 'event', `${josa(a.name, '이/가')} 즐거운 시간을 보냈다.`, a.id);
      }
      this.emote(a, STYLE_EMOTE[p.style]);
    }
    if (p.style === 'office' && a.traits.some((t) => /야근/.test(t))) this.addThought(a, 'overtime', '또 야근이다…', -4, 120);
    this.visitEffect(a, p);
    this.nightVisitEffect(a, p);
  }

  /** What each kind of facility does for a visitor (small, always-on flavour on top of favourites). */
  private visitEffect(a: Agent, p: Place) {
    const fx: Partial<Record<PlaceStyle, [string, number, number, string, string]>> = {
      // [label, mood, minutes, diary, emote]
      gym: ['땀 흘리며 운동해서 개운함', 6, 200, `${p.name}에서 땀을 쫙 뺐다. 몸이 가볍다.`, '💪'],
      cinema: ['영화의 여운이 남음', 8, 240, `${p.name}에서 영화를 봤다. 장면 하나가 계속 떠오른다.`, '🎬'],
      bar: ['한잔하며 털어놓음', 6, 180, `${p.name}에서 한잔했다. 하루가 조금 가벼워졌다.`, '🍺'],
      flower: ['꽃 한 송이를 샀음', 5, 240, `${p.name}에서 꽃을 한 송이 샀다. 방이 환해질 것 같다.`, '💐'],
      bakery: ['갓 구운 빵 냄새에 기분 좋음', 4, 180, `${p.name} 빵 냄새는 반칙이다.`, '🥐'],
      restaurant: ['든든하게 한 끼 먹음', 4, 200, `${p.name}에서 든든하게 먹었다.`, '🍲'],
      hospital: [a.mood < 40 ? '진료를 받고 마음이 놓임' : '건강 검진을 받음', a.mood < 40 ? 8 : 2, 300, `${p.name}에 다녀왔다. 괜찮다는 말을 들으니 안심이 된다.`, '🩺'],
      school: ['오랜만에 배우는 즐거움', 3, 240, `${p.name}에 들렀다. 칠판 냄새가 그립다.`, '✏️'],
    };
    const e = fx[p.style];
    if (!e || a.ai.working) return;
    const [label, mood, mins, diary, emo] = e;
    if (this.addThought(a, `visit:${p.style}`, label, mood, mins)) {
      if (Math.random() < 0.5) this.log(a, 'diary', diary);
      this.emote(a, emo);
    }
  }

  private visitTick(a: Agent) {
    const p = this.place(a.ai.targetPlaceId);
    if (a.ai.sleeping) {
      if (Math.random() < 0.06) this.emote(a, '💤');
      return;
    }
    if (!p || Math.random() > 0.08) return;
    if (a.ai.working) {
      const lines = p.style === 'school' && /학생/.test(a.job) ? STUDENT_LINES : WORK_LINES[p.style];
      if (lines && Math.random() < 0.5) this.say(a, pick(lines), { silentFeed: Math.random() < 0.7 });
      else this.emote(a, STYLE_EMOTE[p.style]);
      return;
    }
    if (Math.random() < 0.25) return this.innerMonologue(a);
    if (Math.random() < 0.04 && this.favor(a, p) >= 0.4 && a.kind === 'person' && this.simTime - (a.ai.lastMonologueAt ?? -1e9) > 240) {
      a.ai.lastMonologueAt = this.simTime;
      const text = this.composeMonologue(a);
      this.speakPolished(a, `(${text})`, a.id === this.watchedId, { thought: true, kind: 'monologue' });
      return;
    }
    if (p.style === 'karaoke') {
      this.emote(a, '🎵');
      this.say(a, a.mood > 40 ? pick(HUM) : pick(SAD_SONG), { silentFeed: Math.random() < 0.6 });
    } else this.emote(a, STYLE_EMOTE[p.style]);
  }

  // ───────────────────────── work ─────────────────────────
  /** Map free-text job → best workplace (or a random open one if allowed). */
  // ── work: the job in a Will's sheet is what they DREAM of doing (장래희망); actual work is freelance ──
  /** retired / travelling / "not working" Wills take no shifts */
  worksAtAll(a: Agent) {
    if (a.kind !== 'person' || a.workPin === 'none') return false;
    return !/(은퇴|백수|무직|여행자|방랑|퇴직|주부)/.test(a.job);
  }
  /** how well a workplace fits the Will's dream job (0..1) */
  dreamFit(a: Agent, p: Place) {
    return a.job ? Math.max(this.matcher.similarity(a.job, JOB_WORDS[p.style] ?? ''), this.matcher.similarity(a.job, DEFAULT_ROLE[p.style] ?? '')) : 0;
  }
  /**
   * Today's workplace. Pinned by the player → that one. Otherwise freelance: wherever there's a free
   * spot, preferring places close to their dream job, places they like, and (a little) where they
   * worked last time. Students go to school; only teachers work there otherwise.
   */
  chooseWorkplace(a: Agent): Place | undefined {
    if (a.workPin && a.workPin !== 'none') {
      const p = this.place(a.workPin);
      if (p) return p;
    }
    const student = /학생/.test(a.job);
    const teacher = /(선생|교사|강사)/.test(a.job);
    let best: Place | undefined;
    let bs = -Infinity;
    for (const p of this.places) {
      if (!p.workSpots.length || !JOB_WORDS[p.style] || !this.openAt(p)) continue;
      if (student !== (p.style === 'school') && !(teacher && p.style === 'school')) continue;
      const busy = this.agents.filter((x) => x !== a && x.ai.working && x.ai.targetPlaceId === p.id).length;
      if (busy >= p.workSpots.length) continue;
      // the dream job pulls, but freelancers wander — curious ones more often
      const s = this.dreamFit(a, p) * 0.9 + this.favor(a, p) * 0.8 + (p.id === a.jobId ? 0.1 : 0) - (this.aversion(a, p) > 0.5 ? 1 : 0) + Math.random() * (1 + Math.max(0, a.persona.curious) * 0.6);
      if (s > bs) (bs = s), (best = p);
    }
    return best;
  }
  /** a first idea of where they'd work (no logs) — used when a Will appears */
  assignJob(a: Agent, _allowRandom: boolean) {
    void _allowRandom;
    if (this.worksAtAll(a)) a.jobId = this.chooseWorkplace(a)?.id;
  }
  /** player's choice: pin a workplace (p), stop working ('none'), or freelance again (undefined) */
  setJob(a: Agent, p: Place | undefined | 'none') {
    a.workPin = p === 'none' ? 'none' : p?.id;
    if (p && p !== 'none') {
      a.jobId = p.id;
      this.log(a, 'event', `앞으로는 ${p.name}에서 일하기로 했다.`, p.id);
      this.log(p, 'event', `${josa(a.name, '이/가')} 이곳에 자리를 잡았다.`, a.id);
    } else if (p === 'none') this.log(a, 'event', '당분간 일을 쉬기로 했다.');
    else this.log(a, 'event', '정해진 일터 없이, 그날그날 일할 곳을 찾기로 했다.');
  }
  private noteWorkplace(a: Agent, p: Place) {
    const prev = this.place(a.jobId);
    a.jobId = p.id;
    if (prev !== p) {
      this.log(p, 'event', `${josa(a.name, '이/가')} 일하러 왔다.`, a.id);
      if (Math.random() < 0.4) this.log(a, 'diary', prev ? `오늘은 ${prev.name} 대신 ${p.name}에서 일했다.` : `${p.name}에서 일을 시작했다.`, p.id);
    }
  }

  /** Each worker has a 6h shift; start hour spread by id so the town never empties. */
  shiftStart(a: Agent) {
    if (this.nightShift(a)) return NIGHT_SHIFT_START[this.place(a.jobId)!.style]!;
    if (this.chronotype(a) === 'owl') return [10, 13, 15][hashString(a.id) % 3]; // owls never take the 8 a.m. shift
    return [8, 10, 13, 15][hashString(a.id) % 4];
  }
  onShift(a: Agent) {
    if (weekdayOf(this.meta.minutes).weekend) return false; // weekends off
    const h = this.hour();
    const s = this.shiftStart(a);
    const e = s + SHIFT_LEN_H;
    return e <= 24 ? h >= s && h < e : h >= s || h < e - 24; // night shifts run past midnight
  }

  private goWork(a: Agent, p: Place) {
    const taken = (s: { tx: number; ty: number }) => {
      const k = `${s.tx},${s.ty}`;
      return this.seatTaken.has(k) && this.seatTaken.get(k) !== a.id;
    };
    const spot = p.workSpots.find((s) => !taken(s)) ?? p.seats.find((s) => !taken(s));
    if (!spot) return this.wander(a, 6);
    this.seatTaken.set(`${spot.tx},${spot.ty}`, a.id);
    a.ai.mode = 'goto';
    a.ai.targetPlaceId = p.id;
    a.ai.working = true;
    a.ai.timer = 0;
    if (!this.pathTo(a, spot.tx, spot.ty)) {
      a.ai.working = false;
      this.wander(a, 6);
    }
  }

  private startWork(a: Agent, p: Place) {
    const h = (this.meta.minutes % 1440) / 60;
    const leftMin = (this.shiftStart(a) + SHIFT_LEN_H - h) * 60;
    a.ai.timer = Math.max(8, Math.min(70, leftMin / MIN_PER_SEC));
    if (!a.ai.shiftEarned) {
      a.ai.shiftEarned = 0;
      const dream = this.dreamFit(a, p);
      if (dream >= 0.5 && this.addThought(a, 'dreamwork', `꿈꾸던 ${a.job} 일을 하고 있다`, 6, 300)) {
        if (Math.random() < 0.4) this.log(a, 'diary', `${p.name}에서 일했다. ${a.job}… 언젠가 진짜 내 일이 될 것 같다.`, p.id);
      } else if (Math.max(this.favor(a, p), dream) >= 0.4 || a.persona.energy > 0.3) this.addThought(a, 'work', '일하는 게 꽤 즐겁다', 4, 240);
      else if (a.persona.energy < -0.3) this.addThought(a, 'work', '출근하기 싫다…', -3, 240);
      this.emote(a, '💼');
    }
  }

  private endShiftIfOver(a: Agent) {
    if (this.onShift(a) && this.place(a.jobId)) return;
    const earned = Math.round(a.ai.shiftEarned ?? 0);
    a.ai.working = false;
    a.ai.shiftEarned = 0;
    if (earned > 0) {
      this.log(a, 'diary', pick(['오늘도 무사히 일을 마쳤다. 수고했어, 나.', '퇴근! 이 순간을 위해 일한다.', '조금 힘들었지만 보람찬 하루였다.']) + ` (+${earned.toLocaleString('ko-KR')}원)`);
      if (Math.random() < 0.5) this.say(a, pick(['퇴근이다~!', '오늘 하루도 끝!', '하아, 집에 가자.']), { silentFeed: true });
    }
  }

  /** RimWorld-ish inner voice: a quiet thought bubble drawn from traits & mood. */
  private innerMonologue(a: Agent) {
    if (a.kind !== 'person') return;
    const top = this.thoughtsSorted(a)[0];
    const r = Math.random();
    let text: string | null = null;
    if (top && r < 0.4) text = innerFromThought(top.label, top.value);
    else {
      const t = pick(a.traits.length ? a.traits : ['오늘은 무슨 일이 있을까']);
      const obj = extractObject(t);
      const dream = extractDream(t);
      // only short, clean objects read naturally inside a thought ("고양이", not "동네 맛집 탐방이 취미다")
      const cleanObj = obj && obj.length <= 9 && !/(다|요)$/.test(obj) && obj.split(' ').length <= 2 ? obj : null;
      if (a.treasure && Math.random() < 0.25) text = pick([`(${a.treasure}… 오늘도 함께야.)`, `(${josa(a.treasure, '을/를')} 보면 마음이 놓여.)`, `(${a.treasure}, 잃어버리면 안 돼.)`]);
      else if (dream) text = pick([`(${dream}… 언젠가는 꼭.)`, `(${dream}. 그날까지 버텨 보자.)`]);
      else if (cleanObj && traitPolarity(t) > 0) text = pick([`(${cleanObj} 생각나네…)`, `(요즘은 ${josa(cleanObj, '이/가')} 제일 좋아.)`, `(오늘은 ${josa(cleanObj, '이랑/랑')} 함께하고 싶다.)`]);
      else if (a.money < 15000) text = '(이번 달 좀 빠듯한데…)';
      else if (a.mood < 35) text = pick(['(다들 행복해 보이네…)', '(나만 이런 걸까.)', '(누가 말 좀 걸어줬으면.)']);
      else if (a.mood > 75) text = pick(['(오늘 기분 최고야!)', '(세상이 반짝반짝해 보여.)']);
    }
    if (text) this.say(a, text, { thought: true, silentFeed: true });
  }

  /**
   * Generative world-fitting: ask the storyteller to rewrite the RANDOMLY filled parts of a
   * Will's sheet for the current world. Player-written fields are never touched.
   */
  reimagine(a: Agent, which: { appearance: boolean; job: boolean; treasure: boolean; keepTraits: number }) {
    const hook = World.storyHook;
    const fields = [which.appearance && '외형', which.job && '직업', which.treasure && '애착 물건', a.traits.length > which.keepTraits && '특성'].filter(Boolean) as string[];
    if (!hook || !fields.length) return;
    hook({
      world: this, kind: 'profile', speaker: a, draft: this.sheetOf(a), topic: `${this.meta.context}|${fields.join(',')}`, important: true,
      apply: (text) => {
        if (!this.agents.includes(a)) return;
        const parsed = parseSheet(`[이름] ${a.name}\n` + text.replace(/^\[이름\][^\n]*\n?/m, ''));
        const sh = parsed.sheet;
        const okSentence = (t: string) => /[가-힣]/.test(t) && t.length <= 40 && !/[A-Za-z]{3,}/.test(t);
        const patch: Partial<CharacterSheet> = {};
        if (which.appearance && sh.appearance && sh.appearance.length <= 60) patch.appearance = sh.appearance;
        if (which.job && sh.job && sh.job.length <= 15) patch.job = sh.job;
        if (which.treasure && sh.treasure && sh.treasure.length <= 30) patch.treasure = sh.treasure;
        const fresh = sh.traits.filter(okSentence).slice(0, 7);
        if (fields.includes('특성') && fresh.length >= 3) patch.traits = [...a.traits.slice(0, which.keepTraits), ...fresh].slice(0, 10);
        if (!Object.keys(patch).length) return;
        this.updateAgent(a, patch);
        this.log(a, 'mutation', `「${this.meta.context}」 세계에 어울리는 모습으로 다시 그려졌다. ✨`);
      },
    });
  }

  // ───────────────────────── homes & night ─────────────────────────
  /** morning 6:30–9 · lunch 12–13:30 · evening 18–22 · late 22–23 · otherwise day */
  dayPhase(): 'morning' | 'lunch' | 'day' | 'evening' | 'late' {
    const h = (this.meta.minutes % 1440) / 60;
    if (h >= 6.5 && h < 9) return 'morning';
    if (h >= 12 && h < 13.5) return 'lunch';
    if (h >= 18 && h < 22) return 'evening';
    if (h >= 22 && h < 23) return 'late';
    return 'day';
  }

  isNight() {
    const h = (this.meta.minutes % 1440) / 60;
    return h >= 23 || h < 6.5;
  }
  hour() {
    return (this.meta.minutes % 1440) / 60;
  }
  /** late evening through the small hours: most places are closed */
  private lateHours(h = this.hour()) {
    return h >= 22 || h < 6.5;
  }

  // ───────────────────────── sleep rhythm (chronotype) ─────────────────────────
  /**
   * 아침형 · 보통 · 올빼미형. The Will's own words decide first ("밤하늘 보는 걸 좋아한다"
   * → owl); otherwise a stable coin flip from the id, so a reload doesn't change anyone.
   */
  chronotype(a: Agent): 'lark' | 'normal' | 'owl' {
    const likes = a.traits.filter((t) => !DISLIKE_RE.test(t)).join(' ');
    if (/(아침형|일찍 일어|새벽 운동|조깅|아침 산책|일출)/.test(likes)) return 'lark';
    if (/(밤|야행|올빼미|새벽|심야|불면|야식|별을|별 보)/.test(likes)) return 'owl';
    const r = hashString(a.id + ':chrono') % 100;
    return r < 22 ? 'owl' : r < 35 ? 'lark' : 'normal';
  }
  /** an owl who works where the lights stay on takes the night shift */
  nightShift(a: Agent) {
    const p = this.place(a.jobId);
    return !!p && NIGHT_SHIFT_START[p.style] !== undefined && this.chronotype(a) === 'owl';
  }
  /** [fall asleep, wake up] in hours (may wrap past midnight) */
  sleepWindow(a: Agent): [number, number] {
    if (this.nightShift(a)) return [5, 12];
    const c = this.chronotype(a);
    return c === 'lark' ? [21.5, 5.5] : c === 'owl' ? [1.5, 8] : [23, 6.5];
  }
  isBedtime(a: Agent) {
    if (a.ai.awakeUntil !== undefined && this.simTime < a.ai.awakeUntil) return false;
    const [s, e] = this.sleepWindow(a);
    const h = this.hour();
    return s < e ? h >= s && h < e : h >= s || h < e;
  }
  /** opening hours: at night only the bar, karaoke, late cinema, 24h store and open air stay open */
  openAt(p: Place, h = this.hour()) {
    if (!this.lateHours(h)) return true;
    switch (p.style) {
      case 'store':
      case 'park':
      case 'plaza':
      case 'home':
        return true;
      case 'bar':
        return h >= 17 || h < 2;
      case 'karaoke':
        return h >= 12 || h < 3;
      case 'cinema':
        return h >= 12 || h < 1;
      default:
        return false;
    }
  }

  /** Sleepless in the small hours: a low-mood Will may get up and go out for a while. */
  private maybeInsomnia(a: Agent): boolean {
    const h = this.hour();
    if (a.mood > 32 || h >= 4.5 || h < 0.5 || Math.random() > 0.05 || this.hasThought(a, 'insomnia')) return false;
    a.ai.sleeping = false;
    a.ai.awakeUntil = this.simTime + 50 + Math.random() * 50;
    this.addThought(a, 'insomnia', '잠이 안 와서 뒤척이다 밖으로 나옴', -2, 300);
    this.emote(a, '🌙');
    this.say(a, pick(NIGHT_UP), { thought: true });
    this.log(a, 'diary', '잠이 오지 않아 밖으로 나왔다. 밤공기가 차다.');
    this.releaseSeat(a);
    this.nightActivity(a);
    return true;
  }

  /** What an awake Will does after dark: friends who are also up, late-night spots, stars, snacks, a walk. */
  private nightActivity(a: Agent) {
    const h = this.hour();
    const open = this.places.filter((p) => p.style !== 'home' && this.openAt(p, h));
    const clear = this.meta.weather === 'clear';
    const opts: [number, () => void][] = [];
    const friend = this.agents
      .filter((b) => b !== a && b.kind === 'person' && !b.ai.sleeping && this.feel(a.id, b.id) >= 25)
      .sort((x, y) => this.feel(a.id, y.id) - this.feel(a.id, x.id))[0];
    if (friend && this.canChat(a, friend)) opts.push([1.2 * (1 + a.persona.social * 0.6), () => this.goMeet(a, friend)]);
    let best: Place | undefined;
    let bs = -1;
    for (const p of open) {
      if (p.style === 'park' || p.style === 'plaza') continue; // the sky gets its own option
      const s = this.favor(a, p) + Math.random() * 0.35 + (p.style === 'bar' ? 0.15 : 0) - (this.aversion(a, p) > 0.5 ? 0.6 : 0);
      if (s > bs) (bs = s), (best = p);
    }
    if (best) {
      const b = best;
      opts.push([0.8 + bs * 2, () => this.goVisit(a, b)]);
    }
    const sky = open.filter((p) => p.style === 'park' || p.style === 'plaza');
    if (sky.length) opts.push([(clear ? 0.7 : 0.25) + Math.max(0, a.persona.curious) * 0.4, () => this.goVisit(a, pick(sky))]);
    const store = open.find((p) => p.style === 'store');
    if (store) opts.push([0.5, () => this.goVisit(a, store)]);
    opts.push([0.6, () => this.wander(a, 12)]); // a walk through the quiet streets
    const home = this.place(a.homeId);
    if (home) opts.push([0.5, () => this.goVisit(a, home)]); // a quiet night in
    let r = Math.random() * opts.reduce((s, o) => s + o[0], 0);
    for (const [w, go] of opts) if ((r -= w) < 0) return go();
    this.wander(a, 8);
  }

  /** Night-only flavour when arriving somewhere after 22:00. */
  private nightVisitEffect(a: Agent, p: Place) {
    const h = this.hour();
    if (!this.lateHours(h) || a.ai.working || a.ai.sleeping || a.kind !== 'person') return;
    if (p.style === 'store') {
      if (this.addThought(a, 'night:snack', '한밤의 야식은 진리', 4, 240)) {
        this.emote(a, '🍜');
        if (Math.random() < 0.5) this.say(a, pick(NIGHT_SNACK), { thought: true, silentFeed: Math.random() < 0.5 });
        if (Math.random() < 0.4) this.log(a, 'diary', `${p.name}에서 야식을 먹었다. 이 시간의 라면은 왜 이렇게 맛있을까.`);
      }
      return;
    }
    if (p.style === 'park' || p.style === 'plaza') {
      const clear = this.meta.weather === 'clear';
      if (!this.addThought(a, 'night:sky', clear ? '밤하늘의 별을 올려다봄' : '밤 산책으로 머리를 식힘', clear ? 6 : 3, 300)) return;
      this.emote(a, clear ? '✨' : '🌙');
      if (!clear) return;
      this.log(a, 'diary', `${p.name}에서 별을 봤다. 별이 이렇게 많았나 싶었다.`);
      // a starry night loosens the heart: the long inner monologue comes easily here
      if (this.simTime - (a.ai.lastMonologueAt ?? -1e9) > 240 && Math.random() < 0.35) {
        a.ai.lastMonologueAt = this.simTime;
        const text = this.composeMonologue(a);
        this.speakPolished(a, `(${text})`, a.id === this.watchedId, { thought: true, kind: 'monologue' });
      } else this.say(a, pick(NIGHT_STARS), { thought: true });
    }
  }

  private homeCapacity(p: Place) {
    return Math.max(2, Math.min(4, p.seats.length + 1));
  }

  /** Give a homeless Will a home: an existing one with room, else build "○○네 집" (not in empty worlds). */
  ensureHome(a: Agent, allowBuild = this.map.roads) {
    if (a.kind !== 'person' || this.place(a.homeId)) return;
    const homes = this.places.filter((p) => p.style === 'home');
    let home = homes.find((p) => this.agents.filter((x) => x.homeId === p.id).length < this.homeCapacity(p));
    if (!home && allowBuild) {
      const near = this.place(a.jobId);
      home =
        this.addPlace(
          { name: `${givenName(a.name)}네 집`, style: 'home', ...(() => { const r = randomPlace('home', hashString(a.name), this.meta.context); return { appearance: r.appearance, traits: r.traits }; })() },
          near ? { tx: near.tx, ty: near.ty } : undefined,
        ) ?? undefined;
    }
    if (!home) return;
    a.homeId = home.id;
    this.log(a, 'event', `${josa(home.name, '을/를')} 집으로 삼았다.`, home.id);
    this.log(home, 'event', `${josa(a.name, '이/가')} 이사 왔다.`, a.id);
  }

  private goSleep(a: Agent) {
    a.ai.sleeping = true;
    a.ai.working = false;
    const home = this.place(a.homeId);
    if (home) return this.goVisit(a, home, true);
    // homeless: a bench (or wherever they are) for the night
    const bench = this.places.filter((p) => p.style === 'park' || p.style === 'plaza')[0];
    this.addThought(a, 'sleep', '잘 곳이 없어 벤치에서 밤을 지새움', -6, 600);
    if (bench) return this.goVisit(a, bench, true);
    this.setIdle(a, 40);
    a.ai.sleeping = true;
  }

  private wakeUp(a: Agent) {
    a.ai.sleeping = false;
    if (a.kind === 'person') this.needsOf(a).rest = 100;
    const home = this.place(a.homeId);
    if (home && !this.hasThought(a, 'sleep')) {
      const good = a.mood >= 35;
      this.addThought(a, 'sleep', good ? '푹 자고 일어남' : '밤새 뒤척였다', good ? 4 : -3, 600);
      if (weekdayOf(this.meta.minutes).weekend && a.jobId) this.addThought(a, 'weekend', '오늘은 쉬는 날!', 5, 900);
      if (Math.random() < 0.3) this.log(a, 'diary', good ? '아침이다. 오늘은 좋은 일이 있을 것 같다.' : '잠을 설쳤다. 오늘도 버텨 보자.');
    }
    if (Math.random() < 0.5) this.say(a, a.mood >= 40 ? pick(['(으음… 잘 잤다.)', '(아침이다!)', '(오늘도 힘내 보자.)']) : '(하아… 벌써 아침이야.)', { thought: true, silentFeed: true });
  }

  // ───────────────────────── mental breaks ─────────────────────────
  private startBreak(a: Agent) {
    const music = a.traits.some((t) => /노래|음악|기타|밴드/.test(t));
    const kind: BreakKind = music && Math.random() < 0.6 ? 'sadSong' : Math.random() < 0.25 + Math.max(0, a.persona.temper) * 0.45 ? 'grumble' : 'sigh';
    a.ai.mode = 'break';
    a.ai.breakKind = kind;
    a.ai.timer = 30 + Math.random() * 20;
    a.ai.lastBreakAt = this.simTime;
    const label = { sigh: '벤치에 주저앉아 한숨만 쉰다', sadSong: '혼자 슬픈 노래를 부른다', grumble: '괜히 누군가에게 시비를 걸고 싶다' }[kind];
    this.pushFeed({ kind: 'break', speakerId: a.id, speaker: a.name, text: `⚠ ${josa(a.name, '이/가')} 한계에 다다랐다: ${label}` });
    this.naturalRumor(kind === 'grumble' ? `${josa(a.name, '이/가')} 요즘 날이 서 있대. 건드리지 말래` : `${josa(a.name, '이/가')} 요즘 많이 힘들어 보인대`, [a], a, kind === 'grumble' ? -0.3 : 0, 'struggle');
    this.log(a, 'diary', `오늘은 정말… 더는 못 버티겠다. (${label})`);
    if (kind === 'sigh') {
      let best: { tx: number; ty: number } | undefined;
      let bd = Infinity;
      const t = this.tileOf(a);
      for (const p of this.places) {
        if (p.style !== 'park' && p.style !== 'plaza') continue;
        for (const s of p.seats) {
          const d = Math.hypot(s.tx - t.tx, s.ty - t.ty);
          if (d < bd && !this.seatTaken.has(`${s.tx},${s.ty}`)) {
            bd = d;
            best = s;
          }
        }
      }
      if (best) {
        this.seatTaken.set(`${best.tx},${best.ty}`, a.id);
        this.pathTo(a, best.tx, best.ty);
      }
    } else if (kind === 'grumble') {
      const near = this.grid.queryRadius(a.x, a.y, 320, this.tmp).filter((b) => b !== a && b.kind === 'person');
      const victim = near[0];
      if (victim) {
        a.ai.meetWith = victim.id;
        a.ai.meetForced = true;
        const vt = this.tileOf(victim);
        this.pathTo(a, vt.tx, vt.ty);
      }
    }
  }

  private breakTick(a: Agent) {
    if (a.ai.pathIndex < a.ai.path.length) return;
    if (Math.random() > 0.12) return;
    switch (a.ai.breakKind) {
      case 'sigh':
        this.emote(a, '💨');
        this.say(a, pick(SIGH), { silentFeed: true });
        break;
      case 'sadSong':
        this.emote(a, '🎵');
        this.say(a, pick(SAD_SONG), { silentFeed: Math.random() < 0.5 });
        break;
      case 'grumble':
        this.emote(a, '💢');
        break;
    }
  }

  private endBreak(a: Agent) {
    a.ai.breakKind = undefined;
    a.ai.meetWith = undefined;
    this.addThought(a, 'catharsis', '실컷 감정을 쏟아내고 나니 조금 후련함', 10, 150);
    if (a.treasure) {
      this.addThought(a, 'treasure', `${josa(a.treasure, '이/가')} 곁에 있어 위로가 됨`, 4, 240);
      this.log(a, 'diary', `${josa(a.treasure, '을/를')} 꼭 쥐고 마음을 추슬렀다. 그래, 아직 괜찮아.`);
      this.say(a, `(${a.treasure}… 오늘도 곁에 있어 줘서 고마워.)`, { thought: true, silentFeed: true });
    } else this.log(a, 'diary', '실컷 울고 나니 조금은 괜찮아졌다.');
    this.setIdle(a, 2);
  }

  // ───────────────────────── conversations ─────────────────────────
  convoOf(a: Agent) {
    return this.convos.find((c) => c.members.includes(a.id));
  }

  private startConvo(members: Agent[], argue: boolean) {
    const [a, b] = members;
    // shared topic = most similar pair of traits
    let topic = a.traits.length ? pick(a.traits) : '날씨';
    let topicSim = 0;
    for (const ta of a.traits)
      for (const tb of b.traits) {
        const s = this.matcher.similarity(ta, tb);
        if (s > topicSim) {
          topicSim = s;
          topic = Math.random() < 0.5 ? ta : tb;
        }
      }
    const c: Conversation = {
      id: uid('c'), members: members.map((m) => m.id), topic, topicSim, nextAt: this.simTime + 0.3,
      lines: 0, maxLines: argue ? 3 : 4 + Math.floor(Math.random() * 4), argue, initiator: a.id,
    };
    this.convos.push(c);
    for (const m of members) {
      this.releaseSeat(m);
      m.ai.mode = 'chat';
      m.ai.path = [];
      m.ai.pathIndex = 0;
      m.ai.partnerId = members.find((x) => x !== m)?.id;
    }
    this.faceEachOther(c);
  }

  private joinConvo(c: Conversation, a: Agent) {
    // not everyone likes being interrupted: reserved or sensitive Wills, or a close 1:1 talk
    const intimate = c.members.length === 2 && this.feel(c.members[0], c.members[1]) >= 50;
    for (const id of c.members) {
      const m = this.agent(id);
      if (!m || this.feel(m.id, a.id) >= 15) continue;
      if ((intimate || m.persona.social < -0.2 || m.persona.sensitive > 0.4) && Math.random() < 0.7) {
        this.addFeel(m.id, a.id, -4);
        this.addThought(m, `intrude:${a.id}`, `${josa(a.name, '이/가')} 대화에 불쑥 끼어들어 언짢음`, -3, 90);
        if (intimate && Math.random() < 0.6) this.say(m, pick(['(둘이 얘기하던 중이었는데…)', '(아, 타이밍이…)', '(조금 아쉽네.)']), { thought: true });
      }
    }
    c.members.push(a.id);
    c.maxLines += 2;
    this.releaseSeat(a);
    a.ai.mode = 'chat';
    a.ai.path = [];
    a.ai.pathIndex = 0;
    this.emote(a, '❓');
    const first = this.agent(c.members[0]);
    this.say(a, first ? `뭐 해요? 저도 껴도 돼요?` : '안녕하세요!');
    this.faceEachOther(c);
  }

  private faceEachOther(c: Conversation) {
    const ms = c.members.map((id) => this.agent(id)).filter(Boolean) as Agent[];
    const cx = ms.reduce((s, m) => s + m.x, 0) / ms.length;
    const cy = ms.reduce((s, m) => s + m.y, 0) / ms.length;
    for (const m of ms) {
      const dx = cx - m.x, dy = cy - m.y;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      m.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    }
  }

  private tickConvos() {
    for (const c of [...this.convos]) {
      const ms = c.members.map((id) => this.agent(id)).filter(Boolean) as Agent[];
      if (ms.length < 2 && !c.waiting) {
        this.endConvo(c);
        continue;
      }
      if (c.waiting) continue; // the storyteller is still writing this line — everyone waits for it
      if (this.simTime < c.nextAt) continue;
      // a reply that has to come next (defending a friend, answering a confession…)
      if (c.forced) {
        const f = c.forced;
        c.forced = undefined;
        const sp = this.agent(f.speakerId), li = this.agent(f.toId);
        if (sp && li) {
          this.speakInConvo(c, sp, li, f.text, f.icon, false, false);
          continue;
        }
      }
      const choices = ms.filter((m) => m.id !== c.lastSpeaker);
      const speaker = pick(choices.length ? choices : ms);
      const others = ms.filter((m) => m !== speaker);
      const listener = others.find((o) => o.id === c.lastSpeaker) ?? pick(others); // answer whoever just spoke
      c.pendingAct = undefined;
      let line = this.lineFor(c, speaker, listener) as { text: string; icon?: string; long?: boolean; named?: boolean };
      const said = (t: string) => (c.history ?? []).some((h) => h.text.replace(/^[^,]{1,12}, /, '').replace(/[.!?…\s]/g, '').includes(t.replace(/[.!?…\s]/g, '')));
      for (let i = 0; i < 3 && said(line.text) && (!c.pendingAct || /^(like|dislike|dream|happy)$/.test((c.pendingAct as Conversation['pendingAct'])!.kind)); i++) {
        c.pendingAct = undefined;
        line = this.lineFor(c, speaker, listener) as typeof line;
      }
      const { text, icon } = line;
      // address the listener by name now and then so it's clear who is talking to whom
      const vocChance = c.lines === 0 ? 0.75 : c.members.length > 2 ? 0.6 : 0.3;
      const casual = this.speaksCasually(speaker, listener);
      const body = casual ? toBanmal(text) : text;
      const spoken = !line.long && !text.startsWith('(') && !line.named && Math.random() < vocChance ? `${this.callName(speaker, listener)}, ${body}` : body;
      // Layer 2: how much to rewrite follows this computer's spare capacity; never at 3× and up
      const watched = !!this.watchedId && (speaker.id === this.watchedId || listener.id === this.watchedId);
      const cap = this.simSpeed >= 3 ? 0 : World.storyCapacity();
      const chance = cap === 0 ? 0 : line.long ? 1 : c.argue ? 0 : c.lines === 0 ? cap * 0.5 : watched ? Math.max(0.8, cap) : cap;
      if (Math.random() < chance) {
        // buffered: hold the line until the rewrite arrives, then say it once ("…" meanwhile)
        const kind = line.long ? 'monologue' : 'line';
        c.waiting = true;
        speaker.bubble = { text: '…', born: this.simTime, life: 60, thought: false };
        const ok = this.requestPolish(kind, speaker, spoken, listener, c.topic, line.long || watched, c.history ?? [], (final, ai) => {
          c.waiting = false;
          if (speaker.bubble?.text === '…') speaker.bubble = undefined;
          this.speakInConvo(c, speaker, listener, final, icon, !!line.long, ai);
        });
        if (ok) continue;
        c.waiting = false;
        speaker.bubble = undefined;
      }
      // not rewritten this time: a line learned from earlier rewrites of the same template, if any
      const learned = !line.long && !c.argue && Math.random() < 0.75 ? World.learnedLine?.(spoken, speaker, listener) : null;
      this.speakInConvo(c, speaker, listener, learned ?? spoken, icon, !!line.long, false, !!learned);
    }
  }

  /** Say one conversation line (after any rewrite) and move the conversation on. */
  private speakInConvo(c: Conversation, speaker: Agent, listener: Agent, text: string, icon: string | undefined, long: boolean, ai: boolean, learned = false) {
    // fast-forward (5× and up): lines still happen (bubbles, effects) but the log gets one summary at the end
    const quiet = this.simSpeed >= 5;
    const fi = this.say(speaker, text, { kind: long ? 'monologue' : 'line', to: listener, silentFeed: quiet });
    if (fi && ai) fi.ai = true;
    if (fi && learned) fi.learned = true;
    if (quiet) c.quiet = (c.quiet ?? 0) + 1;
    if (icon) this.emote(speaker, icon);
    (c.history ??= []).push({ name: speaker.name, text });
    if (c.history.length > 4) c.history.shift();
    c.lastSpeaker = speaker.id;
    c.lastText = text;
    c.lastAct = c.pendingAct ? { ...c.pendingAct, by: speaker.id } : undefined;
    c.pendingAct = undefined;
    c.lines++;
    // a calmer pace so lines can actually be read (and slower game speeds stretch it further)
    c.nextAt = this.simTime + (long ? 6 : 3.4 + Math.random() * 1.8);
    const hanging = c.lastAct && /^(greet|ask|like|dislike|secret|monologue|sad|comfortNeeded|differ|birthday)/.test(c.lastAct.kind) && c.lines < c.maxLines + 2;
    if (c.lines >= c.maxLines && !c.forced && !hanging && this.convos.includes(c)) this.endConvo(c);
  }

  private lineFor(c: Conversation, s: Agent, l: Agent): { text: string; icon?: string } {
    const rel = this.relation(s.id, l.id);
    if (c.argue) return { text: pick(ARGUE), icon: '💢' };
    const greet = (text: string, icon?: string) => {
      c.pendingAct = { kind: 'greet', ask: /(어땠|어때|잘 지냈|뭐 해|뭐 하|괜찮|어디 가)/.test(text), obj: /날씨/.test(text) ? '날씨' : /어디 가/.test(text) ? '어디' : undefined };
      return { text, icon };
    };
    if (c.lines === 0 && this.isBirthday(l) && !this.wished.get(l.id)?.has(s.id) && (this.feel(s.id, l.id) >= 0 || this.rumors.rumors.some((r) => /생일/.test(r.text) && r.about.includes(l.id) && r.knownBy.includes(s.id)))) {
      (this.wished.get(l.id) ?? this.wished.set(l.id, new Set()).get(l.id)!).add(s.id);
      c.pendingAct = { kind: 'birthdayWish' };
      return { text: pick(['생일 축하해요! 오늘 좋은 일만 가득하길!', '오늘 생일이라면서요? 진짜 축하해요!', '생일 축하해요! 선물은 못 챙겼지만 마음만은 가득이에요.']), icon: '🎂' };
    }
    if (c.lines === 0 && this.isBirthday(s) && !this.wished.get(s.id)?.has(l.id) && this.feel(s.id, l.id) >= 20 && Math.random() < 0.6) {
      c.pendingAct = { kind: 'birthdayNews' };
      return { text: pick(['있잖아요… 사실 오늘 제 생일이에요!', '헤헤, 오늘 제 생일인 거 알아요?']), icon: '🎂' };
    }
    if (c.lines === 0 && this.peekRelation(s.id, l.id)?.status === 'lovers') return greet(pick(['보고 싶었어!', '오늘 하루 어땠어?', '왔어? 기다렸잖아.', '같이 있으니까 좋다.']), '💕');
    if (c.lines === 0) {
      const mine = this.feel(s.id, l.id);
      const h = this.hour();
      // picking up where they left off last time
      const last = this.peekRelation(s.id, l.id)?.lastTopic;
      if (last && mine > -10 && Math.random() < 0.3) {
        c.topic = last;
        const o = extractObject(last) ?? extractDream(last) ?? (last.length <= 12 && !/다$/.test(last) ? last : null);
        if (o) {
          c.pendingAct = { kind: 'recall', obj: o };
          return { text: pick([`지난번에 했던 ${o} 얘기요, 그 뒤로 계속 생각났어요.`, `아, 저번에 말한 ${o} 말인데요…`, `그때 얘기한 ${o}, 기억나요?`]), icon: '💭' };
        }
      }
      if ((h >= 23 || h < 5) && mine > -30 && Math.random() < 0.6) return greet(pick(NIGHT_GREET), '🌙');
      if (mine >= 40) return greet(pick(GREET_CLOSE), '❤️');
      if (mine <= -30) return greet(pick(GREET_COLD), '💭');
      return greet(pick(GREET), Math.random() < 0.4 ? '👋' : undefined);
    }
    // first, answer what the other person just said (agree, ask back, defend a friend, say thanks…)
    const mustAnswer = !!c.lastAct && (c.lastAct.ask || /^(ask|secret|monologue|comfort|recall|shared|explained|birthday)/.test(c.lastAct.kind));
    if (c.lastAct?.by === l.id && (mustAnswer || Math.random() < 0.85)) {
      const r = this.reactTo(c, s, l);
      if (r) return r;
    }
    const caring = s.persona.kind > 0.3 || s.traits.some((t) => /(우울해 보이|위로|웃게|정이 많)/.test(t));
    if (l.mood <= 30 && (caring || s.mood >= 70) && Math.random() < 0.55) {
      if (this.addThought(l, `comfort:${s.id}`, `${josa(s.name, '이/가')} 위로해 줌`, 8, 180)) {
        this.addFeel(l.id, s.id, 6); // the comforted one remembers it
        this.log(l, 'diary', `${josa(s.name, '이/가')} 내 얘기를 들어줬다. 조금 힘이 났다.`, s.id);
        rel.memories.push({ t: this.meta.minutes, text: `${josa(s.name, '이/가')} 우울해하던 ${josa(l.name, '을/를')} 위로했다.` });
      }
      c.pendingAct = { kind: 'comfort' };
      return { text: pick(COMFORT), icon: '❤️' };
    }
    if (s.mood <= 25 && Math.random() < 0.5) {
      c.pendingAct = { kind: 'sad' };
      return { text: pick(SAD), icon: '💧' };
    }
    // answer what was just said: a question gets an answer, not a brand-new topic
    if (!c.lastAct && c.lastText && c.lastSpeaker === l.id && /\?["”]?\s*$/.test(c.lastText) && Math.random() < 0.75) {
      const mine = s.traits.reduce((m, t) => Math.max(m, this.matcher.similarity(t, c.topic)), 0);
      return mine >= 0.5
        ? { text: pick(['네! 저도 그거 진짜 좋아해요.', '맞아요, 저도 딱 그래요.', '오, 저도 관심 많아요!', '그럼요, 저도 자주 그래요.']), icon: '😊' }
        : { text: pick(['음, 저는 잘 모르겠어요. 그래도 재밌겠네요.', '저는 그쪽은 잘 몰라서요… 더 얘기해 줘요.', '글쎄요, 저는 아직 안 해 봤어요.']), icon: '💭' };
    }
    // talking about someone who isn't here: badmouthing (험담) or praise
    if (c.lines >= 1 && Math.random() < 0.14) {
      const g = this.gossipLine(c, s, l);
      if (g) return g;
    }
    // agreeing with the previous speaker when the topic is shared
    if (c.topicSim >= 0.45 && c.lines === 2 && Math.random() < 0.6) return { text: pick(AGREE), icon: '❤️' };
    // confiding a crush to a close friend ("비밀이에요!") — secrets have a way of travelling
    if (c.lines >= 1 && c.members.length === 2 && Math.random() < 0.18) {
      const crush = this.agents.find((x) => x.kind === 'person' && x !== s && x !== l && this.feel(s.id, x.id) >= 65 && this.peekRelation(s.id, x.id)?.status !== 'lovers');
      if (crush && this.feel(s.id, l.id) >= 45 && !this.rumors.rumors.some((r) => r.secretOf === s.id && r.about.includes(crush.id))) {
        this.rumors.add({
          text: hearsay(`${josa(s.name, '이/가')} ${josa(crush.name, '을/를')} 좋아한다`), tag: makeTag('짝사랑', [s.name, crush.name]), about: [s.id, crush.id],
          sentiment: 0.3, knownBy: [l.id], origin: 'natural', born: this.meta.minutes, kind: 'romance', heat: 10, secretOf: s.id, confidant: l.id,
        });
        this.log(s, 'diary', `${l.name}에게만 ${crush.name} 얘기를 털어놓았다. 비밀 지켜 주겠지?`, l.id);
        c.pendingAct = { kind: 'secret', about: [crush.id] };
        return { text: `사실… 저 ${this.referName(s, crush)} 좋아하는 것 같아요. 비밀이에요!`, icon: '🤫' };
      }
    }
    // gossip: pass on a rumor the listener hasn't heard
    if (c.lines >= 1 && Math.random() < 0.22) {
      const r = this.rumors.pickToTell(s.id, l.id);
      // a good friend keeps a secret (mostly)
      const keeps = r?.secretOf && this.feel(s.id, r.secretOf) >= 60 && Math.random() < 0.7;
      if (r && !keeps) {
        const aboutListener = r.about.includes(l.id);
        const text = aboutListener ? `${this.callName(s, l)}, 혹시 알아요? 요즘 이런 얘기가 돌던데… "${r.text}"` : pick([`그거 들었어요? ${r.text}.`, `있잖아요, ${r.text}.`, `소문 들었어요? ${r.text}!`]);
        this.hearRumor(l, r, s);
        c.pendingAct = { kind: 'rumor', about: r.about, sentiment: r.sentiment };
        return { text, icon: '💬', named: aboutListener } as { text: string; icon?: string };
      }
    }
    // a rare long-form heart-to-heart — the small hours make people more candid
    const lateNight = this.hour() >= 23 || this.hour() < 5;
    if (!c.monologued && this.simTime - (s.ai.lastMonologueAt ?? -1e9) > 240 && c.members.length === 2 && c.lines >= 2 && (this.feel(s.id, l.id) >= (lateNight ? 30 : 45) || (s.mood <= 28 && l.persona.kind > 0.2)) && Math.random() < (lateNight ? 0.4 : 0.2)) {
      c.monologued = true;
      s.ai.lastMonologueAt = this.simTime;
      const text = this.composeMonologue(s, l);
      this.addFeel(l.id, s.id, 8); // being trusted with a secret moves the listener most
      this.addFeel(s.id, l.id, 4);
      rel.memories.push({ t: this.meta.minutes, text: `${josa(s.name, '이/가')} ${l.name}에게 속마음을 털어놓았다: "${text.split(/(?<=[.?!…])\s/)[1] ?? text.slice(0, 30)}"` });
      this.log(l, 'diary', `${josa(s.name, '이/가')} 오늘 속마음을 털어놓았다. 왠지 더 가까워진 느낌이다.`, s.id);
      this.log(s, 'diary', `${l.name}에게 처음으로 솔직한 이야기를 했다. 조금 후련하다.`, l.id);
      this.addThought(s, `heart:${l.id}`, `${l.name}에게 속마음을 털어놓음`, 6, 300);
      c.maxLines = Math.max(c.maxLines, c.lines + 2);
      c.nextAt = this.simTime + 6; // give the long line room to be read
      c.pendingAct = { kind: 'monologue' };
      return { text, icon: '💭', long: true } as { text: string; icon?: string };
    }
    if (s.treasure && c.lines >= 2 && this.feel(s.id, l.id) >= 20 && Math.random() < 0.12) {
      c.pendingAct = { kind: 'treasure' };
      return { text: pick([`이거요? ${copula(s.treasure).replace(/이다$/, '이에요').replace(/다$/, '예요')}. 저한테는 보물이에요.`, `제 ${josa(s.treasure, '은/는')} 절대 못 버려요.`, `${s.treasure} 얘기 해 드릴까요? 사연이 좀 있어요.`]), icon: '💭' };
    }
    this.lastTopical = undefined;
    let topical = Math.random() < 0.75 ? this.topicalLine(s, c.topic) : null;
    const done = (m?: { obj?: string; dream?: string }) => !!m && !!c.covered?.includes((m.obj ?? m.dream)!);
    // already talked through: say something else (another of their own interests)
    if (topical && done(this.lastTopical) && s.traits.length) {
      this.lastTopical = undefined;
      topical = this.topicalLine(s, pick(s.traits));
      if (done(this.lastTopical)) topical = null;
    }
    if (topical) {
      const m = this.lastTopical as { obj?: string; pol?: number; dream?: string; muse?: string } | undefined;
      if (m?.muse) c.pendingAct = { kind: 'muse', obj: m.muse };
      else if (m?.dream) c.pendingAct = { kind: 'dream', obj: m.dream };
      else if (m?.obj && m.pol !== undefined) c.pendingAct = { kind: m.pol < 0 ? 'dislike' : 'like', obj: m.obj };
      const icon = /노래|♪|음악|기타/.test(topical + c.topic) ? '🎵' : this.feel(s.id, l.id) >= 50 ? '❤️' : Math.random() < 0.3 ? '💬' : undefined;
      return { text: topical, icon };
    }
    if (s.mood >= 60) {
      if (Math.random() < 0.5) c.pendingAct = { kind: 'happy' };
      return { text: pick(HAPPY), icon: Math.random() < 0.4 ? '😊' : undefined };
    }
    return { text: pick(['그렇구나…', '음, 그럴 수도 있겠네요.', '진짜요?', '아하!', '그건 몰랐어요.']), icon: Math.random() < 0.3 ? '❓' : undefined };
  }

  /**
   * Speak about a topic. Curated lines first; otherwise build a line from the
   * extracted object of ANY trait (so user-written traits are voiced too).
   */
  private topicalLine(s: Agent, convoTopic: string): string | null {
    const own = s.traits.length ? pick(s.traits) : convoTopic;
    const src = Math.random() < 0.6 ? convoTopic : own;
    const curated = topicLine(src);
    const obj = extractObject(src);
    const dream = extractDream(src);
    this.lastTopical = obj ? { obj, pol: traitPolarity(src) < 0 ? -1 : 1 } : dream ? { dream } : undefined;
    if (curated && Math.random() < 0.6) return curated;
    if (obj) return traitPolarity(src) < 0 ? pick(GENERIC_DISLIKE)(obj) : pick(GENERIC_LIKE)(obj);
    if (dream) return pick(GENERIC_DREAM)(dream);
    if (/다$/.test(src) && src.length <= 28 && Math.random() < 0.5) {
      this.lastTopical = { muse: src };
      return pick(MUSE)(src);
    }
    return curated;
  }

  private endConvo(c: Conversation) {
    this.convos = this.convos.filter((x) => x !== c);
    const ms = c.members.map((id) => this.agent(id)).filter(Boolean) as Agent[];
    if (ms.length === 2 && !c.argue && c.lines >= 3) this.relation(ms[0].id, ms[1].id).lastTopic = c.topic;
    if (ms.length >= 3) this.groupHistory.push({ t: this.meta.minutes, members: ms.map((m) => m.id).sort() });
    const herePlace = ms[0] ? this.placeAt(ms[0].x, ms[0].y) : undefined;
    if (c.argue && ms.length >= 2 && c.lines >= 2) this.naturalRumor(`${josa(ms[0].name, '이랑/랑')} ${josa(ms[1].name, '이/가')} ${herePlace ? herePlace.name + '에서' : '길에서'} 대판 싸웠대`, ms.slice(0, 2), ms[0], -0.5, 'fight');
    const sameSet = (h: { members: string[] }) => h.members.length === ms.length && ms.every((m) => h.members.includes(m.id));
    if (ms.length >= 4 && this.groupHistory.filter(sameSet).length >= 2) this.naturalRumor(`${ms.map((m) => m.name).join(', ')}${suffix(ms[ms.length - 1].name, '이/가')} ${herePlace ? herePlace.name + '에서' : '동네에서'} 자주 모인대`, [...ms, ...(herePlace ? [herePlace] : [])], ms[0], 0.3, 'bond');
    // the place where it happened remembers it too
    if (ms[0] && c.lines >= 3) {
      const here = this.placeAt(ms[0].x, ms[0].y);
      if (here && Math.random() < (c.argue ? 1 : 0.5)) {
        const names = ms.map((m) => m.name).join(', ');
        this.log(here, 'event', c.argue ? `${names} 사이에 언성이 높아졌다.` : `${names}${suffix(ms[ms.length - 1].name, '이/가')} 이곳에서 한참 이야기를 나눴다.`);
      }
    }
    for (let i = 0; i < ms.length; i++)
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i], b = ms[j];
        const rel = this.relation(a.id, b.id);
        const before = rel.affinity;
        // each side feels it differently: own mood, sociability and who picked the fight
        // temperaments and values can clash: then a chat leaves them cooler, not warmer
        const awkward = c.topicSim < 0.15 && Math.random() < 0.35; // nothing in common to talk about
        const warm = (x: Agent, y: Agent) => 2 + Math.random() * 3 + c.topicSim * 7 + (x.mood - 50) / 22 + x.persona.social * 1.2 - this.clash(x, y) * 9 - (awkward ? 4 + Math.random() * 3 : 0);
        const hurt = (x: Agent) => -(c.initiator === x.id ? 3 + Math.random() * 3 : 7 + Math.random() * 6 + Math.max(0, x.persona.sensitive) * 4);
        this.addFeel(a.id, b.id, c.argue ? hurt(a) : warm(a, b));
        this.addFeel(b.id, a.id, c.argue ? hurt(b) : warm(b, a));
        if (!c.argue)
          for (const [x, y] of [[a, b], [b, a]] as const)
            if (this.clash(x, y) >= 0.6 && this.addThought(x, `clash:${y.id}`, `${josa(y.name, '와/과')}는 말이 잘 안 통한다`, -3, 180)) {
              rel.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} 보기엔 대화가 자꾸 겉돌았다.` });
              if (Math.random() < 0.5) this.log(x, 'diary', `${y.name}… 나쁜 사람은 아닌데, 이상하게 잘 안 맞는다.`, y.id);
            }
        rel.chats++;
        // one-sided feelings make stories: a crush that isn't (yet) returned
        for (const [x, y] of [[a, b], [b, a]] as const) {
          const mine = this.feel(x.id, y.id), theirs = this.feel(y.id, x.id);
          if (mine >= 65 && theirs < 30 && !rel.memories.some((m) => m.text.includes(`${josa(x.name, '이/가')} ${josa(y.name, '을/를')} 짝사랑`))) {
            rel.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} ${josa(y.name, '을/를')} 짝사랑하기 시작했다. ${y.name}은(는) 아직 모르는 눈치다.`.replace('은(는)', suffix(y.name, '은/는')) });
            this.log(x, 'diary', `요즘 자꾸 ${y.name} 생각이 난다. …이게 뭐지.`, y.id);
            this.naturalRumor(`${josa(x.name, '이/가')} ${josa(y.name, '을/를')} 좋아한다는 말이 있더라`, [x, y], x, 0.3, 'bond', 14);
          }
        }

        const topicShort = c.topic.length > 18 ? c.topic.slice(0, 18) + '…' : c.topic;
        if (rel.chats === 1) rel.memories.push({ t: this.meta.minutes, text: c.argue ? `${josa(a.name, '와/과')} ${josa(b.name, '이/가')} 처음부터 말다툼을 벌였다.` : `처음으로 대화를 나눴다. 화제: "${topicShort}"` });
        else if (c.argue) rel.memories.push({ t: this.meta.minutes, text: `말다툼을 벌였다.` });
        else if (before < 30 && rel.affinity >= 30) rel.memories.push({ t: this.meta.minutes, text: `"${topicShort}" 이야기로 꽤 친해졌다.` });
        else if (before < 60 && rel.affinity >= 60) {
          rel.memories.push({ t: this.meta.minutes, text: `서로를 깊이 신뢰하는 사이가 되었다.` });
          this.naturalRumor(`${josa(a.name, '이랑/랑')} ${b.name}, 요즘 엄청 친하대`, [a, b], a, 0.5, 'bond');
        } else if (before < 85 && rel.affinity >= 85) this.naturalRumor(`${josa(a.name, '이랑/랑')} ${b.name}, 혹시 사귀는 거 아니냐는 말이 있더라`, [a, b], b, 0.4, 'bond', 16);
        if (rel.memories.length > 40) rel.memories.shift();
      }
    // a 1:1 talk between two who like each other a lot may end in a confession
    if (ms.length === 2 && !c.argue) this.maybeConfess(ms[0], ms[1]);
    // at 5×+ the lines weren't logged one by one: one line sums the talk up
    if (c.quiet && ms.length >= 2) {
      const names = ms.map((m) => m.name).join(', ');
      const topicShort = c.topic.length > 16 ? c.topic.slice(0, 16) + '…' : c.topic;
      this.pushFeed({ kind: 'event', speakerId: ms[0].id, text: c.argue ? `💢 ${names}${suffix(ms[ms.length - 1].name, '이/가')} 말다툼을 벌였다.` : `💬 ${names}${suffix(ms[ms.length - 1].name, '이/가')} 「${topicShort}」 이야기를 나눴다 (${c.lines}마디).` });
    }
    for (const m of ms) {
      if (m.kind === 'person') {
        const n = this.needsOf(m);
        n.social = Math.min(100, n.social + (c.argue ? 8 : ms.length >= 3 ? 30 : 25));
        n.fun = Math.min(100, n.fun + (c.argue ? 0 : 6));
      }
      const others = ms.filter((x) => x !== m);
      for (const o of others) m.ai.lastChatAt[o.id] = this.simTime;
      const names = others.map((o) => o.name).join(', ');
      if (c.argue) {
        this.addThought(m, `argue:${others[0]?.id}`, `${josa(names, '와/과')} 말다툼을 함`, -8, 180);
        this.emote(m, '💢');
        this.log(m, 'diary', `${josa(names, '와/과')} 싸웠다. 기분이 나쁘다.`, others[0]?.id);
      } else {
        const key = ms.length >= 3 ? 'groupchat' : `chat:${others[0]?.id}`;
        this.addThought(m, key, ms.length >= 3 ? '여럿이서 왁자지껄 떠듦' : `${josa(names, '와/과')} 즐거운 대화를 나눔`, ms.length >= 3 ? 8 : 5, 120);
        if (Math.random() < 0.5) this.log(m, 'chat', `${josa(names, '와/과')} 이야기를 나눴다.`, others[0]?.id);
      }
      m.ai.partnerId = undefined;
      this.setIdle(m, 0.8 + Math.random() * 1.5);
    }
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
  private questAcc = 0;
  private lastRequestAt = -1e9;
  private lastMomentAt = -1e9;
  private lastDay = -1;
  private recentQuestKeys: { key: string; t: number }[] = [];
  private goalCursor = 0;

  private person(id?: string) {
    const a = this.agent(id);
    return a && a.kind === 'person' ? a : undefined;
  }
  private avgMood() {
    const ps = this.agents.filter((a) => a.kind === 'person');
    return ps.length ? ps.reduce((s, a) => s + a.mood, 0) / ps.length : 0;
  }
  private loverCount() {
    let n = 0;
    for (const r of this.relations.values()) if (r.status === 'lovers') n++;
    return n;
  }
  private checkQuest(q: Quest): boolean | null {
    const c = q.check;
    const now = this.meta.minutes;
    switch (c.type) {
      case 'placeStyle':
        return this.places.some((p) => p.style === c.style);
      case 'feelBoth':
        if (!this.agent(c.a) || !this.agent(c.b)) return null;
        return this.feel(c.a, c.b) >= c.value && this.feel(c.b, c.a) >= c.value;
      case 'confessOrLovers': {
        if (!this.agent(c.a) || !this.agent(c.b)) return null;
        const r = this.peekRelation(c.a, c.b);
        return r?.status === 'lovers' || (r?.confessedAt ?? -1e9) >= c.since;
      }
      case 'friend':
        if (!this.agent(c.a)) return null;
        return this.agents.some((o) => o.kind === 'person' && o.id !== c.a && this.feel(c.a, o.id) >= c.value && this.feel(o.id, c.a) >= c.value * 0.6);
      case 'ownsPet':
        if (!this.agent(c.a)) return null;
        return this.agents.some((x) => x.ownerId === c.a);
      case 'mood': {
        const a = this.agent(c.a);
        return a ? a.mood >= c.value : null;
      }
      case 'avgMoodHold':
        if (this.avgMood() >= c.value) {
          c.heldSince ??= now;
          return now - c.heldSince >= c.minutes;
        }
        c.heldSince = undefined;
        return false;
      case 'groups':
        return this.factions.length >= c.n;
      case 'lovers':
        return this.loverCount() >= c.n;
      case 'population':
        return this.agents.filter((a) => a.kind === 'person').length >= c.n;
      case 'event':
        return this.eventLog.some((e) => e.kind === c.event && e.t >= c.since && (!c.target || e.target === c.target));
      case 'weather':
        return this.meta.weather === c.weather;
    }
  }
  /** a 0..1 progress hint for the goal list */
  questProgress(q: Quest): number | null {
    const c = q.check;
    if (c.type === 'avgMoodHold') return c.heldSince === undefined ? Math.min(0.99, this.avgMood() / c.value) * 0.5 : 0.5 + Math.min(0.5, ((this.meta.minutes - c.heldSince) / c.minutes) * 0.5);
    if (c.type === 'population') return Math.min(1, this.agents.filter((a) => a.kind === 'person').length / c.n);
    if (c.type === 'feelBoth') return Math.max(0, Math.min(1, (Math.min(this.feel(c.a, c.b), this.feel(c.b, c.a)) + 50) / (c.value + 50)));
    if (c.type === 'mood') return Math.min(1, (this.agent(c.a)?.mood ?? 0) / c.value);
    return null;
  }
  acceptQuest(id: string) {
    const q = this.quests.find((x) => x.id === id);
    if (!q || q.status !== 'offered') return;
    q.status = 'active';
    q.expiresAt = this.meta.minutes + 2 * 1440;
    if (q.check.type === 'confessOrLovers') q.check.since = this.meta.minutes;
    const a = this.person(q.from);
    if (a) {
      this.addThought(a, `asked:${q.id}`, '부탁을 들어준대!', 4, 600);
      this.say(a, pick(['(정말요? 고마워요!)', '(들어주는구나… 다행이다.)']), { thought: true });
    }
    this.pushFeed({ kind: 'event', speakerId: q.from, text: `📮 「${q.title}」 의뢰를 맡았어요.` });
  }
  declineQuest(id: string) {
    const q = this.quests.find((x) => x.id === id);
    if (!q || q.status !== 'offered') return;
    q.status = 'declined';
    const a = this.person(q.from);
    if (a) this.addThought(a, `declined:${q.id}`, '부탁이 거절됐다', -2, 360);
  }
  private completeQuest(q: Quest) {
    q.status = 'done';
    this.questsDone++;
    const a = this.person(q.from);
    if (q.kind === 'request' && a) {
      this.addThought(a, `wish-granted:${q.id}`, '바라던 일이 이루어졌다', 12, 720);
      this.say(a, pick(['정말 고마워요! 꿈만 같아요.', '이렇게 될 줄은 몰랐어요… 고마워요!', '최고예요, 진짜로!']));
      this.emote(a, '💖');
      this.log(a, 'diary', `「${q.title}」 — 바라던 일이 정말 이루어졌다. 누군가 내 마음을 알아준 것 같다.`);
      this.pushFeed({ kind: 'care', speakerId: a.id, text: `🎉 의뢰 완료! ${a.name}: 「정말 고마워요!」 — ${q.title}` });
    } else if (q.kind === 'goal') {
      this.pushFeed({ kind: 'care', text: `🏆 동네 목표 달성: ${q.title}` });
      for (const p of this.awakePeople()) this.addThought(p, 'town-goal', '요즘 동네 분위기가 참 좋다', 4, 480);
    } else {
      if (a) this.addThought(a, `moment:${q.id}`, '오늘 운이 좋았다', 5, 360);
      this.pushFeed({ kind: 'care', speakerId: q.from, text: `✨ ${q.title} — 잘 해결됐어요.` });
    }
  }
  private failQuest(q: Quest) {
    q.status = 'failed';
    const a = this.person(q.from);
    if (q.kind === 'request' && a) {
      this.addThought(a, `quest-fail:${q.id}`, '기다렸는데… 결국 안 됐다', -3, 480);
      this.pushFeed({ kind: 'event', speakerId: a.id, text: `⌛ ${a.name}의 의뢰 「${q.title}」 기한이 지났어요.` });
    }
  }
  private addQuest(q: Omit<Quest, 'id' | 'createdAt' | 'status'> & { status?: Quest['status'] }) {
    const full: Quest = { ...q, id: questId(), createdAt: this.meta.minutes, status: q.status ?? 'offered' };
    this.quests.push(full);
    this.recentQuestKeys.push({ key: q.key, t: this.meta.minutes });
    return full;
  }
  private recentlyAsked(key: string) {
    return this.recentQuestKeys.some((k) => k.key === key && this.meta.minutes - k.t < 2 * 1440);
  }

  /** A Will asks for something that grows out of their own situation. */
  private offerRequest() {
    const busy = new Set(this.quests.filter((q) => q.status === 'offered' || q.status === 'active').map((q) => q.from));
    const now = this.meta.minutes;
    const options: Omit<Quest, 'id' | 'createdAt' | 'status'>[] = [];
    for (const a of this.awakePeople()) {
      if (busy.has(a.id)) continue;
      const wish = this.missingWish(a);
      if (wish && wish.key !== 'dream') {
        const style = wish.key as PlaceStyle;
        const name = STYLE_LABEL[style];
        options.push({ kind: 'request', from: a.id, icon: '🏗️', key: `wish:${a.id}:${style}`, title: `${josa(name, '을/를')} 지어 주세요`, text: `${name}${suffix(name, '이/가')} 있으면 정말 좋겠어요. 하나만 지어 주실 수 있을까요?`, check: { type: 'placeStyle', style }, action: { label: `🏗️ ${name} 짓기`, cmd: { type: 'SPAWN_ENTITY', entity: { kind: 'place', style } } }, expiresAt: now + 360 });
      } else if (wish?.key === 'dream') {
        const style = (Object.keys(JOB_WORDS) as PlaceStyle[]).map((s) => ({ s, v: this.matcher.similarity(a.job, JOB_WORDS[s]!) })).sort((x, y) => y.v - x.v)[0];
        if (style && style.v >= 0.35) options.push({ kind: 'request', from: a.id, icon: '💭', key: `dream:${a.id}`, title: `${STYLE_LABEL[style.s]}에서 일하고 싶어요`, text: `언젠가 ${a.job} 일을 해 보고 싶어요. 그럴 만한 곳이 생기면 좋겠어요.`, check: { type: 'placeStyle', style: style.s }, action: { label: `🏗️ ${STYLE_LABEL[style.s]} 짓기`, cmd: { type: 'SPAWN_ENTITY', entity: { kind: 'place', style: style.s } } }, expiresAt: now + 360 });
      }
      const rival = this.agents.find((b) => b.kind === 'person' && b !== a && this.feel(a.id, b.id) <= -15 && (a.persona.kind >= 0 || (this.peekRelation(a.id, b.id)?.chats ?? 0) >= 2));
      if (rival) options.push({ kind: 'request', from: a.id, icon: '🤝', key: `repair:${a.id}:${rival.id}`, title: `${josa(rival.name, '와/과')} 화해하고 싶어요`, text: `${josa(rival.name, '이랑/랑')} 사이가 틀어졌어요… 다시 잘 지내고 싶어요. 둘이 만날 기회를 만들어 주실래요?`, check: { type: 'feelBoth', a: a.id, b: rival.id, value: 5 }, action: { label: '👣 둘이 만나게 하기', cmd: { type: 'TRIGGER_EVENT', event: 'MEET', targets: [{ id: a.id }, { id: rival.id }] } }, expiresAt: now + 360 });
      const crush = this.agents.find((b) => b.kind === 'person' && b !== a && this.feel(a.id, b.id) >= 62 && this.peekRelation(a.id, b.id)?.status !== 'lovers' && !this.loverOf(a));
      if (crush) options.push({ kind: 'request', from: a.id, icon: '💌', key: `crush:${a.id}:${crush.id}`, title: `${crush.name}에게 마음을 전하고 싶어요`, text: `사실 ${josa(crush.name, '을/를')} 좋아해요… 용기를 낼 수 있게 둘만 있을 기회를 만들어 주세요.`, check: { type: 'confessOrLovers', a: a.id, b: crush.id, since: now }, action: { label: '👣 둘이 만나게 하기', cmd: { type: 'TRIGGER_EVENT', event: 'MEET', targets: [{ id: a.id }, { id: crush.id }] } }, expiresAt: now + 360 });
      const needs = this.needsOf(a);
      const hasFriend = this.agents.some((o) => o.kind === 'person' && o !== a && this.feel(a.id, o.id) >= 40);
      if (needs.social < 35 && !hasFriend) options.push({ kind: 'request', from: a.id, icon: '🫂', key: `lonely:${a.id}`, title: '친구가 생기면 좋겠어요', text: '요즘 너무 외로워요. 마음 맞는 친구가 한 명이라도 있으면 좋겠어요.', check: { type: 'friend', a: a.id, value: 40 }, expiresAt: now + 360 });
      const petLove = a.traits.find((t) => traitPolarity(t) > 0 && /(고양이|강아지|개를|토끼|햄스터|고슴도치|새를|오리|동물)/.test(t));
      if (petLove && !this.agents.some((x) => x.ownerId === a.id) && this.place(a.homeId)) {
        const stray = this.agents.filter((x) => x.kind === 'animal' && !x.ownerId).sort((x, y) => this.favor(a, y) - this.favor(a, x))[0];
        const sp = petLove.match(/(고양이|강아지|토끼|햄스터|고슴도치|오리)/)?.[1] ?? '반려동물';
        options.push({ kind: 'request', from: a.id, icon: '🐾', key: `pet:${a.id}`, title: `${josa(sp, '을/를')} 키우고 싶어요`, text: `${josa(sp, '을/를')} 키우고 싶어요… 집에 돌아오면 반겨 주는 친구가 있으면 좋겠어요.`, check: { type: 'ownsPet', a: a.id },
          action: stray && this.favor(a, stray) >= 0.4 ? { label: `🐾 ${josa(stray.name, '을/를')} 입양 보내기`, cmd: { type: 'SYSTEM', action: 'ADOPT', value: stray.id, target: { id: a.id } } } : { label: `🐾 ${sp} 소환하기`, cmd: { type: 'SPAWN_ENTITY', entity: { kind: 'animal', category: sp }, at: { near: { id: a.id } } } }, expiresAt: now + 360 });
      }
    }
    const fresh = options.filter((o) => !this.recentlyAsked(o.key));
    if (!fresh.length) return;
    const q = this.addQuest(pick(fresh));
    const a = this.person(q.from);
    if (a) {
      this.say(a, pick(['(누가 내 부탁 좀 들어줬으면…)', '(부탁하면 들어줄까…?)']), { thought: true });
      this.pushFeed({ kind: 'event', speakerId: a.id, text: `📮 ${a.name}의 의뢰: ${q.title}` });
    }
    this.lastRequestAt = this.meta.minutes;
  }
  /** A town-wide goal: always achievable from where the town is now. */
  private offerGoal() {
    const now = this.meta.minutes;
    const people = this.agents.filter((a) => a.kind === 'person').length;
    const wants = new Map<PlaceStyle, number>();
    for (const a of this.agents) if (a.kind === 'person') { const w = this.missingWish(a); if (w && w.key !== 'dream') wants.set(w.key as PlaceStyle, (wants.get(w.key as PlaceStyle) ?? 0) + 1); }
    const topWant = [...wants].sort((x, y) => y[1] - x[1])[0];
    const all: (Omit<Quest, 'id' | 'createdAt' | 'status'> | null)[] = [
      this.avgMood() < 65 && people >= 2 ? { kind: 'goal', icon: '😊', key: 'goal:mood', title: '모두의 기분을 65 이상으로 2시간 지키기', text: '마을 모두가 웃는 날을 만들어 보세요. 좋아하는 것을 가까이 두거나, 축제를 열거나…', check: { type: 'avgMoodHold', value: 65, minutes: 120 }, expiresAt: now + 5 * 1440 } : null,
      people >= 4 ? { kind: 'goal', icon: '🎌', key: `goal:group${this.factions.length + 1}`, title: '새 그룹이 생기게 하기', text: '마음이 맞는 윌 넷 이상이 자주 어울리면 모임이 생겨요. 취향이 비슷한 윌을 만나게 해 보세요.', check: { type: 'groups', n: this.factions.length + 1 }, expiresAt: now + 5 * 1440 } : null,
      people >= 2 ? { kind: 'goal', icon: '💘', key: `goal:lovers${this.loverCount() + 1}`, title: '연인 한 쌍 탄생시키기', text: '서로 좋아하는 두 윌에게 함께할 시간을 만들어 주세요. 고백은 쉽게 받아들여지지 않아요!', check: { type: 'lovers', n: this.loverCount() + 1 }, expiresAt: now + 5 * 1440 } : null,
      this.migration ? { kind: 'goal', icon: '🧳', key: `goal:pop${people + 2}`, title: `주민 ${people + 2}명 되기`, text: '동네 분위기가 좋으면 새 윌이 이사 와요. 물론 직접 불러도 돼요.', check: { type: 'population', n: people + 2 }, expiresAt: now + 5 * 1440 } : null,
      topWant ? { kind: 'goal', icon: '🏗️', key: `goal:build:${topWant[0]}`, title: `주민들이 바라는 ${josa(STYLE_LABEL[topWant[0]], '을/를')} 짓기`, text: `${topWant[1]}명이 ${STYLE_LABEL[topWant[0]]}${suffix(STYLE_LABEL[topWant[0]], '이/가')} 있었으면 해요.`, check: { type: 'placeStyle', style: topWant[0] }, expiresAt: now + 5 * 1440 } : null,
      { kind: 'goal', icon: '🎉', key: `goal:festival:${Math.floor(now / 1440)}`, title: '동네 축제 열기', text: '광장이나 공원에서 축제를 열어 모두 모이게 해 보세요. (🎪 사건 창 또는 「광장에서 축제 열어 줘」)', check: { type: 'event', event: 'FESTIVAL', since: now }, action: { label: '🎉 축제 열기', cmd: { type: 'WORLD_EVENT', event: 'FESTIVAL' } }, expiresAt: now + 2 * 1440 },
    ];
    const options = all.filter((o): o is NonNullable<typeof o> => !!o && !this.recentlyAsked(o.key) && !this.checkQuest({ ...o, id: '', createdAt: now, status: 'active' } as Quest));
    if (!options.length) return;
    const q = options[this.goalCursor++ % options.length];
    this.addQuest({ ...q, status: 'active' });
    this.pushFeed({ kind: 'event', text: `🎯 새 동네 목표: ${q.title}` });
  }
  /** A small, short-lived moment the player can answer with one click. */
  private offerMoment() {
    const now = this.meta.minutes;
    const people = this.awakePeople();
    if (!people.length) return;
    const options: Omit<Quest, 'id' | 'createdAt' | 'status'>[] = [];
    const sad = people.filter((a) => a.mood < 32).sort((x, y) => x.mood - y.mood)[0];
    if ((this.meta.weather === 'rain' || this.meta.weather === 'storm') && people.length) {
      const who = people.find((a) => a.traits.some((t) => /비/.test(t) && traitPolarity(t) < 0)) ?? sad ?? pick(people);
      options.push({ kind: 'moment', from: who.id, icon: '🌧️', key: `moment:rain:${who.id}`, title: `비 때문에 ${josa(who.name, '이/가')} 시무룩해요`, text: '하늘을 맑게 개게 해 줄까요?', check: { type: 'weather', weather: 'clear' }, action: { label: '☀️ 맑게 하기', cmd: { type: 'SET_WEATHER', weather: 'clear' } }, expiresAt: now + 120 });
    }
    if (sad) options.push({ kind: 'moment', from: sad.id, icon: '💤', key: `moment:sad:${sad.id}`, title: `${josa(sad.name, '이/가')} 많이 지쳤어요`, text: '좋아하는 걸 근처에 두거나, 살짝 축복을 내려 줄 수도 있어요.', check: { type: 'mood', a: sad.id, value: 45 }, action: { label: '✨ 축복하기', cmd: { type: 'TRIGGER_EVENT', event: 'BLESS', targets: [{ id: sad.id }] } }, expiresAt: now + 240 });
    const singer = people.find((a) => a.traits.some((t) => /(노래|음악|기타|밴드|버스킹)/.test(t)));
    const day = this.hour() >= 9 && this.hour() < 20;
    if (singer && day) options.push({ kind: 'moment', from: singer.id, icon: '🎸', key: `moment:busk:${singer.id}`, title: `${josa(singer.name, '이/가')} 광장에서 노래하고 싶대요`, text: '작은 무대를 열어 줄까요? 사람들이 모이면 둘 사이도 가까워져요.', check: { type: 'event', event: 'BUSKING', since: now }, action: { label: '🎸 버스킹 열기', cmd: { type: 'WORLD_EVENT', event: 'BUSKING', target: { id: singer.id } } }, expiresAt: now + 180 });
    const bday = pick(people);
    if (day) options.push({ kind: 'moment', from: bday.id, icon: '🎂', key: `moment:bday:${bday.id}`, title: `오늘이 ${givenName(bday.name)}의 생일이래요!`, text: '친구들이 축하해 주면 정말 기뻐할 거예요.', check: { type: 'event', event: 'BIRTHDAY', since: now, target: bday.id }, action: { label: '🎂 생일 축하하기', cmd: { type: 'WORLD_EVENT', event: 'BIRTHDAY', target: { id: bday.id } } }, expiresAt: now + 240 });
    if (this.meta.weather === 'clear' && (this.hour() >= 21 || this.hour() < 4)) options.push({ kind: 'moment', icon: '🌠', key: `moment:meteor:${Math.floor(now / 1440)}`, title: '별이 유난히 잘 보이는 밤이에요', text: '유성우를 내려 줄까요? 깨어 있는 윌들이 소원을 빌 거예요.', check: { type: 'event', event: 'METEOR', since: now }, action: { label: '🌠 유성우', cmd: { type: 'WORLD_EVENT', event: 'METEOR' } }, expiresAt: now + 120 });
    if (this.meta.weather === 'clear' && day && Math.random() < 0.5) options.push({ kind: 'moment', icon: '🌈', key: `moment:rainbow:${Math.floor(now / 1440)}`, title: '하늘이 참 맑아요', text: '무지개를 띄우면 다들 하늘을 올려다볼 거예요.', check: { type: 'event', event: 'RAINBOW', since: now }, action: { label: '🌈 무지개', cmd: { type: 'WORLD_EVENT', event: 'RAINBOW' } }, expiresAt: now + 120 });
    const fresh = options.filter((o) => !this.recentlyAsked(o.key));
    if (!fresh.length) return;
    const q = this.addQuest({ ...pick(fresh), status: 'active' });
    this.pushFeed({ kind: 'event', speakerId: q.from, text: `${q.icon} ${q.title}` });
    this.lastMomentAt = now;
  }
  private tickQuests() {
    const now = this.meta.minutes;
    for (const q of this.quests) {
      if (q.status === 'offered' && now > q.expiresAt) q.status = 'failed';
      if (q.status !== 'active') continue;
      const r = this.checkQuest(q);
      if (r === null) q.status = 'failed';
      else if (r) this.completeQuest(q);
      else if (now > q.expiresAt) this.failQuest(q);
    }
    if (this.questsPaused) return;
    const open = this.quests.filter((q) => q.status === 'offered' || q.status === 'active');
    if (!open.some((q) => q.kind === 'request') && now - this.lastRequestAt > 240 && Math.random() < 0.5) this.offerRequest();
    if (!open.some((q) => q.kind === 'goal')) this.offerGoal();
    if (!open.some((q) => q.kind === 'moment') && now - this.lastMomentAt > 300 && Math.random() < 0.35) this.offerMoment();
    // keep a short history
    const old = this.quests.filter((q) => q.status !== 'offered' && q.status !== 'active');
    if (old.length > 30) this.quests = this.quests.filter((q) => !old.slice(0, old.length - 30).includes(q));
    this.recentQuestKeys = this.recentQuestKeys.filter((k) => now - k.t < 2 * 1440);
    // pets: a Will who loves an animal they've bonded with may take it home
    for (const a of this.agents) {
      if (a.kind !== 'person' || a.ai.sleeping || !this.place(a.homeId) || this.agents.some((x) => x.ownerId === a.id)) continue;
      const near = this.grid.queryRadius(a.x, a.y, 120, this.tmp).find((x) => x.kind === 'animal' && !x.ownerId && this.feel(a.id, x.id) >= 30 && this.favor(a, x) >= 0.55);
      if (near && Math.random() < 0.12) this.adopt(a, near);
    }
    // once a day (in the morning): people move in and out
    const day = Math.floor(now / 1440);
    if (this.lastDay < 0) this.lastDay = day; // the first morning only starts the count
    else if (day !== this.lastDay && this.hour() >= 7) {
      this.lastDay = day;
      this.dailyTick();
    }
  }

  // ───────────────────────── pets (입양) ─────────────────────────
  adopt(owner: Agent, pet: Agent): { ok: boolean; message: string } {
    if (owner.kind !== 'person' || pet.kind !== 'animal') return { ok: false, message: '윌이 동물을 입양할 수 있어요.' };
    if (pet.ownerId) return { ok: false, message: `${josa(pet.name, '은/는')} 이미 가족이 있어요.` };
    pet.ownerId = owner.id;
    this.addFeel(owner.id, pet.id, 20);
    this.addFeel(pet.id, owner.id, 20);
    this.addThought(owner, 'adopted', `${josa(pet.name, '와/과')} 가족이 되었다`, 12, 1440);
    this.emote(owner, '💖');
    this.emote(pet, '❤️');
    this.say(owner, pick([`${josa(pet.name, '아/야')}, 오늘부터 우리 집에서 같이 살자!`, `${josa(givenName(pet.name), '아/야')}, 이제 넌 우리 가족이야.`]));
    this.log(owner, 'diary', `오늘 ${josa(pet.name, '을/를')} 집에 데려왔다. 집이 갑자기 따뜻해졌다.`, pet.id);
    this.log(pet, 'diary', `${owner.name}네 집에 살게 됐다. 밥이 맛있고 이불이 푹신하다.`, owner.id);
    this.relation(owner.id, pet.id).memories.push({ t: this.meta.minutes, text: `${josa(owner.name, '이/가')} ${josa(pet.name, '을/를')} 입양했다.` });
    this.pushFeed({ kind: 'care', speakerId: owner.id, text: `🐾 ${josa(owner.name, '이/가')} ${josa(pet.name, '을/를')} 입양했어요!` });
    this.naturalRumor(`${josa(owner.name, '이/가')} ${josa(pet.name, '을/를')} 키우기 시작했대`, [owner, pet], owner, 0.6, 'care', 10);
    return { ok: true, message: `🐾 ${josa(pet.name, '이/가')} ${owner.name}의 가족이 되었어요.` };
  }

  // ───────────────────────── moving in & out (이사) ─────────────────────────
  private dailyTick() {
    const people = this.agents.filter((a) => a.kind === 'person');
    if (!people.length) return;
    // birthdays come round by themselves (every Will has one in each 14-day cycle)
    const today = Math.floor(this.meta.minutes / 1440);
    for (const a of people)
      if (this.birthdayIn(a) === 0 && this.lastBirthday.get(a.id) !== today) {
        this.lastBirthday.set(a.id, today);
        this.later(20 + Math.random() * 360, () => {
          if (this.agents.includes(a) && !a.ai.sleeping) this.happen('BIRTHDAY', a);
        });
      }
    for (const a of people) {
      a.lowDays = a.mood < 28 ? (a.lowDays ?? 0) + 1 : 0;
      if (!this.migration) continue;
      if (a.lowDays === 1) {
        this.addThought(a, 'thinking-leaving', '이 동네를 떠날까 고민 중', -2, 1440);
        this.log(a, 'diary', '요즘 이 동네에서 버티는 게 힘들다. 떠나야 할까.');
        this.say(a, '(여길 떠나야 할까…)', { thought: true });
        this.addQuest({ kind: 'moment', from: a.id, icon: '😟', key: `stay:${a.id}`, status: 'active', title: `${josa(a.name, '이/가')} 동네를 떠날까 고민해요`, text: `내일 아침까지 기분을 50 이상으로 올려 주면 남을 거예요. 좋아하는 것, 친구, 바람을 살펴보세요.`, check: { type: 'mood', a: a.id, value: 50 }, action: { label: `🎥 ${a.name}에게 가기`, cmd: { type: 'SYSTEM', action: 'FOLLOW', target: { id: a.id } } }, expiresAt: this.meta.minutes + 1440 });
        this.pushFeed({ kind: 'break', speakerId: a.id, text: `😟 ${josa(a.name, '이/가')} 동네를 떠날까 고민하고 있어요.` });
      } else if (a.lowDays >= 2 && people.length > 2) this.moveOut(a);
    }
    const avg = this.avgMood();
    const homesFree = this.places.some((p) => p.style === 'home' && this.residentsOf(p).length < 3) || this.map.roads;
    if (this.migration && avg >= 62 && people.length < 30 && homesFree && Math.random() < 0.6) this.moveIn();
  }
  private lastBirthday = new Map<string, number>();
  /** days until this Will's next birthday (0 = today); a 14-day cycle fixed by who they are */
  birthdayIn(a: Agent): number {
    const day = Math.floor(this.meta.minutes / 1440);
    const b = hashString(a.id + a.name) % 14;
    return (b - (day % 14) + 14) % 14;
  }
  /** who already wished this Will a happy birthday today */
  private wished = new Map<string, Set<string>>();
  /** today is their birthday (it came round, or the player made it happen) */
  isBirthday(a: Agent) {
    return this.hasThought(a, 'birthday');
  }
  /** everyone close by notices and reacts (cheer, clap, a word or two) */
  private nearbyReact(who: Agent, radiusTiles: number, react: (b: Agent) => void) {
    for (const b of this.agents) {
      if (b === who || b.kind !== 'person' || b.ai.sleeping) continue;
      if (Math.hypot(b.x - who.x, b.y - who.y) > radiusTiles * TILE) continue;
      react(b);
    }
  }

  private moveOut(a: Agent) {
    const friends = this.agents.filter((o) => o.kind === 'person' && o !== a && this.feel(o.id, a.id) >= 30);
    this.say(a, pick(['…다들 잘 지내요.', '그동안 고마웠어요.', '언젠가 다시 올게요.']));
    for (const f of friends) {
      this.addThought(f, `missed:${a.id}`, `${josa(a.name, '이/가')} 떠나서 쓸쓸하다`, -6, 1440);
      this.log(f, 'diary', `${josa(a.name, '이/가')} 동네를 떠났다. 잘 지냈으면 좋겠다.`, a.id);
    }
    for (const x of this.agents) if (x.ownerId === a.id) x.ownerId = undefined;
    this.pushFeed({ kind: 'break', text: `👋 ${josa(a.name, '이/가')} 동네를 떠났어요… (오래 힘들어했어요)` });
    this.removeEntity(a.id);
  }
  private moveIn() {
    const r = Math.floor((this.map.roadRows[0] + this.map.roadRows[1]) / 2);
    const fromLeft = Math.random() < 0.5;
    const x = (fromLeft ? 1.5 : this.map.w - 1.5) * TILE, y = (r + 0.5) * TILE;
    const t = this.map.nearestWalkable(Math.floor(x / TILE), Math.floor(y / TILE));
    const a = this.spawnRandomized({ kind: 'person' }, (t.tx + 0.5) * TILE, (t.ty + 0.5) * TILE);
    this.ensureHome(a);
    this.log(a, 'diary', '살기 좋은 동네라는 얘기를 듣고 이사 왔다. 잘 지낼 수 있겠지?');
    this.pushFeed({ kind: 'care', speakerId: a.id, text: `🧳 ${josa(a.name, '이/가')} 이사 왔어요 — "살기 좋은 동네라던데요!"` });
  }

  // ───────────────────────── talking to a Will (말 걸기) ─────────────────────────
  /** recent exchanges per Will (not saved): who said what */
  talks = new Map<string, { who: 'me' | 'will'; text: string; ai?: boolean }[]>();
  /**
   * The player speaks to a Will; the Will answers in character (storyteller, or a template built
   * from their state if no model is available). Being listened to warms them a little.
   */
  talkTo(a: Agent, text: string, done?: () => void) {
    const log = this.talks.get(a.id) ?? [];
    log.push({ who: 'me', text });
    this.talks.set(a.id, log.slice(-20));
    this.pushFeed({ kind: 'system', text: `🗣️ 나 → ${a.name}: "${text}"` });
    if (this.addThought(a, 'heard', '누군가 내 이야기를 들어 줬다', 4, 360) && /(힘내|괜찮|응원|고마|사랑|잘하고|멋져|최고)/.test(text)) this.addThought(a, 'cheered', '따뜻한 말을 들었다', 4, 360);
    this.emote(a, '💬');
    const draft = this.templateReply(a, text);
    const finish = (reply: string, ai: boolean) => {
      const l = this.talks.get(a.id) ?? [];
      l.push({ who: 'will', text: reply, ai });
      this.talks.set(a.id, l.slice(-20));
      const fi = this.say(a, reply, { kind: reply.length > 60 ? 'monologue' : 'line' });
      if (fi) {
        fi.to = '나';
        if (ai) fi.ai = true;
      }
      done?.();
    };
    const hook = World.storyHook;
    if (!hook || World.storyCapacity() === 0) return finish(draft, false);
    a.bubble = { text: '…', born: this.simTime, life: 60 };
    let settled = false;
    const once = (t: string, ai: boolean) => {
      if (settled) return;
      settled = true;
      if (a.bubble?.text === '…') a.bubble = undefined;
      finish(t, ai);
    };
    this.pendingPolish.push({ deadline: performance.now() + 25000 * World.polishPatience, fire: () => once(draft, false), done: () => settled });
    hook({ world: this, kind: 'reply', speaker: a, draft, topic: text, important: true, history: log.slice(-6).map((m) => ({ name: m.who === 'me' ? '나' : a.name, text: m.text })), apply: (t) => once(t, true), fail: () => once(draft, false) });
  }
  /** what the Will's last answer to the player was about (for "왜요?" follow-ups) */
  private talkTopic = new Map<string, { key: string; obj?: string; who?: string }>();
  /** an in-character answer from the Will's own state (used when no model is around, and as the draft) */
  templateReply(a: Agent, text: string): string {
    const log = this.talks.get(a.id) ?? [];
    const mine = log.filter((m) => m.who === 'me');
    const prevAsk = mine.length >= 2 ? mine[mine.length - 2].text : undefined;
    const last = this.talkTopic.get(a.id);
    const set = (key: string, extra: { obj?: string; who?: string } = {}) => void this.talkTopic.set(a.id, { key, ...extra });
    // the same question twice in a row
    const again = prevAsk && prevAsk.replace(/[\s?!.]/g, '') === text.replace(/[\s?!.]/g, '') ? '아까도 물어봤잖아요, 하하. ' : '';
    // a follow-up to the last answer: "왜요?", "진짜요?", "더 얘기해 줘요"
    if (last && !again && /^(왜|어째서|무슨 일|진짜|정말|그래요|그래\?|어떻게|더 (얘기|말))|^(왜|어째서)[요?]*$/.test(text.trim())) {
      const th = this.thoughtsSorted(a);
      switch (last.key) {
        case 'mood': {
          const two = th.slice(0, 2).map((t) => t.label.replace(/[!.]$/, ''));
          if (two.length) return `${two.join('… 그리고 ')}. 그래서 그런 것 같아요.`;
          return '딱히 이유는 없어요. 그냥 그런 날이 있잖아요.';
        }
        case 'like':
          return last.obj ? `그냥 ${josa(last.obj, '을/를')} 생각만 해도 마음이 편해지거든요. 이상하죠?` : '말로 설명하긴 어려워요, 하하.';
        case 'friend': {
          const f = this.agent(last.who);
          const mem = f && this.peekRelation(a.id, f.id)?.memories.slice(-1)[0];
          return mem ? `${mem.text.replace(/다\.?$/, '어요.')} 그때부터 더 가까워졌어요.` : '같이 있으면 말이 잘 통해요. 억지로 웃을 필요가 없달까요.';
        }
        case 'dream':
          return '어릴 때부터 막연히 그랬어요. 지금도 가끔 상상해요.';
        case 'wish':
          return last.obj ? `${last.obj}… 그게 있으면 하루가 훨씬 나을 것 같아서요.` : '그냥 그런 게 있으면 좋겠다 싶었어요.';
        case 'person': {
          const p = this.agent(last.who);
          const mem = p && this.peekRelation(a.id, p.id)?.memories.slice(-1)[0];
          return mem ? `음… ${mem.text.replace(/다\.?$/, '어요.')}` : '아직 같이 보낸 시간이 많지 않아서요.';
        }
      }
    }
    // asking about another Will by name: what they think of them
    const named = this.agents.find((o) => o !== a && (text.includes(o.name) || (o.kind === 'person' && givenName(o.name).length >= 2 && text.includes(givenName(o.name)))));
    if (named && !/(에게|한테) /.test(text)) {
      set('person', { who: named.id });
      const f = this.feel(a.id, named.id);
      const nm = this.referName(a, named);
      const status = this.peekRelation(a.id, named.id)?.status;
      if (named.ownerId === a.id) return again + `${josa(named.name, '은/는')} 우리 집 가족이에요! 제일 소중해요.`;
      if (status === 'lovers') return again + `${nm}요? 헤헤… 제 연인이에요. 생각만 해도 웃음이 나요.`;
      if (status === 'ex') return again + `${nm}… 예전에 만났었죠. 지금은 그냥 잘 지냈으면 해요.`;
      if (f >= 60) return again + `${nm}요? 정말 좋아해요. 같이 있으면 편해요.`;
      if (f >= 25) return again + `${nm}… 좋은 사람이에요. 더 친해지고 싶어요.`;
      if (f > -10) return again + `${nm}요? 아직 잘 몰라요. 몇 번 얘기해 본 정도예요.`;
      if (f > -40) return again + `솔직히 ${nm}랑은 좀 어색해요…`;
      return again + `${nm} 얘기는… 별로 하고 싶지 않아요.`;
    }
    const reply = this.templateReplyBase(a, text, set);
    return again + reply;
  }
  private templateReplyBase(a: Agent, text: string, set: (key: string, extra?: { obj?: string; who?: string }) => void): string {
    const top = this.thoughtsSorted(a)[0];
    const likes = a.traits.filter((t) => traitPolarity(t) > 0).map(extractObject).filter(Boolean) as string[];
    const friend = this.agents.filter((o) => o.kind === 'person' && o !== a).sort((x, y) => this.feel(a.id, y.id) - this.feel(a.id, x.id))[0];
    const wish = this.missingWish(a);
    const dream = a.traits.map(extractDream).find(Boolean);
    if (/(기분|어때|괜찮|요즘|지내)/.test(text)) set('mood');
    if (/(좋아|취미|뭐 해|즐겨)/.test(text) && !/(기분|어때|괜찮|요즘|지내)/.test(text)) set('like', { obj: likes[0] });
    if (/(친구|누구|사람)/.test(text)) set('friend', { who: friend?.id });
    if (/(꿈|하고 싶|되고 싶)/.test(text)) set('dream');
    if (/(필요|원해|바라|소원|부탁)/.test(text)) set('wish', { obj: wish?.label.replace(/[이가]? ?(있|생기)(으면|었으면).*$/, '') });
    if (/(기분|어때|괜찮|요즘|지내)/.test(text)) return a.mood >= 65 ? `요즘 꽤 좋아요!${top && top.value > 0 ? ` ${top.label.replace(/[!.]$/, '')}… 그래서 그런가 봐요.` : ''}` : a.mood >= 40 ? `그럭저럭 지내요.${top ? ` 요즘은 ${top.label.replace(/[!.]$/, '')}…` : ''}` : `솔직히 좀 힘들어요.${top && top.value < 0 ? ` ${top.label.replace(/[!.]$/, '')}…` : ''}`;
    if (/(좋아|취미|뭐 해|즐겨)/.test(text)) return likes.length ? `${josa(likes[0], '을/를')} 정말 좋아해요. 얘기만 해도 신나요!` : '음… 아직 잘 모르겠어요. 이것저것 해 보는 중이에요.';
    if (/(친구|누구|사람)/.test(text)) return friend && this.feel(a.id, friend.id) >= 30 ? `${this.referName(a, friend)}랑 제일 친해요. 같이 있으면 편해요.` : '아직 친한 사람이 별로 없어요… 조금 외로워요.';
    if (/(꿈|하고 싶|되고 싶)/.test(text)) return dream ? `언젠가 ${dream}… 그게 제 꿈이에요.` : a.job ? `언젠가 ${a.job} 일을 제대로 해 보고 싶어요.` : '꿈이요? 생각해 본 적이 별로 없네요.';
    if (/(필요|원해|바라|소원|부탁)/.test(text)) return wish ? `${wish.label.replace(/다$/, '어요')}.` : '지금은 이대로도 괜찮아요. 물어봐 줘서 고마워요.';
    if (/(힘내|응원|고마|사랑|멋져|최고)/.test(text)) return pick(['헤헤, 그런 말 들으니 힘이 나요!', '고마워요… 덕분에 오늘 하루 버틸 수 있겠어요.', '정말요? 갑자기 기분이 좋아졌어요.']);
    return pick([`음… ${a.mood >= 50 ? '그렇게 생각해 줘서 고마워요.' : '잘 모르겠어요. 요즘 생각이 많아서요.'}`, '그런 얘기는 처음 들어 봐요. 조금 더 얘기해 줄래요?', '하하, 재밌는 분이네요.']);
  }

  // ───────────────────────── needs (필요) ─────────────────────────
  needsOf(a: Agent) {
    return (a.needs ??= { social: 70, fun: 70, food: 80, rest: 90 });
  }
  /** every ~10 game minutes: needs drift, and what's missing gets said out loud (thoughts, diary, wishes) */
  private tickNeeds(mins: number) {
    const h = mins / 60;
    const people = this.agents.filter((a) => a.kind === 'person');
    for (const a of people) {
      const n = this.needsOf(a);
      const asleep = !!a.ai.sleeping;
      const nobody = people.length <= 1;
      n.social = clamp(n.social + (a.ai.mode === 'chat' ? 10 : asleep ? -0.5 : -6 * (1 + Math.max(0, a.persona.social) * 0.6) * (nobody ? 2.5 : 1)) * h, 0, 100);
      n.fun = clamp(n.fun + (asleep ? 0 : -4) * h, 0, 100);
      n.food = clamp(n.food + (asleep ? -1.5 : -7) * h, 0, 100);
      n.rest = clamp(n.rest + (asleep ? 14 : a.ai.working ? -6 : -4) * h, 0, 100);
      if (asleep) continue;
      const alone = people.length <= 1;
      const say = (key: string, label: string, value: number, line: string, diary: string) => {
        if (this.addThought(a, key, label, value, 70)) {
          if (Math.random() < 0.35) this.say(a, line, { thought: true });
          if (this.simTime - (a.ai.needDiaryAt?.[key] ?? -1e9) > 600) {
            (a.ai.needDiaryAt ??= {})[key] = this.simTime;
            this.log(a, 'diary', diary);
          }
        }
      };
      if (n.social < 30)
        say('need:social', alone ? '말 걸 사람이 아무도 없다' : '요즘 너무 외롭다', -Math.round(4 + (25 - n.social) / 5), alone ? '(이 동네엔… 나 혼자인가.)' : pick(['(누구라도 좋으니 얘기하고 싶다.)', '(오늘 제대로 말한 사람이 하나도 없네.)']), alone ? '이 동네엔 말 걸 사람이 아무도 없다. 누가 이사라도 왔으면.' : '오늘도 제대로 이야기를 나눈 사람이 없다. 조금 외롭다.');
      if (n.fun < 20) say('need:fun', '하루가 너무 지루하다', -3, pick(['(심심해…)', '(뭐 재밌는 일 없나.)']), '할 게 없어서 하루가 길었다.');
      if (n.food < 25) {
        const anyFood = this.places.some((p) => MEAL_LUNCH.includes(p.style));
        if (anyFood) say('need:food', '배가 고프다', -5, '(배고파…)', '배가 고파서 아무것도 손에 안 잡혔다.');
        else say('need:food', '동네에 밥 먹을 데가 없다', -7, '(식당 하나만 있었으면…)', '동네에 밥 먹을 곳이 하나도 없다. 식당이나 빵집 하나만 생겼으면 좋겠다.');
      }
      if (n.rest < 15) say('need:rest', '너무 피곤하다', -5, pick(['(눈꺼풀이 무거워…)', '(조금만 쉬고 싶다.)']), '하루 종일 너무 피곤했다.');
    }
    // wishes, about once a game day per Will: places they'd love that don't exist (yet)
    for (const a of people) {
      if (a.ai.sleeping || Math.random() > (mins / 1440) * 1.5) continue;
      const wish = this.missingWish(a);
      if (!wish) continue;
      if (this.addThought(a, `wish:${wish.key}`, wish.label, -2, 720)) {
        this.say(a, wish.line, { thought: true });
        this.log(a, 'diary', wish.diary);
      }
    }
  }
  /** something a Will likes (or dreams of doing) with no place for it in town */
  missingWish(a: Agent): { key: string; label: string; line: string; diary: string } | null {
    const styles = new Set(this.places.map((p) => p.style));
    for (const t of a.traits) {
      if (traitPolarity(t) <= 0) continue;
      const hint = PLACE_HINT.find(([re]) => re.test(t));
      if (hint && !styles.has(hint[1])) {
        const name = STYLE_LABEL[hint[1]];
        return { key: hint[1], label: `동네에 ${name}${suffix(name, '이/가')} 있으면 좋겠다`, line: `(${name} 하나만 있으면 좋을 텐데…)`, diary: `이 동네엔 ${name}${suffix(name, '이/가')} 없다. 「${t}」 나한테는 그게 꽤 아쉽다.` };
      }
    }
    if (a.job && this.worksAtAll(a) && !/학생/.test(a.job) && !this.places.some((p) => this.dreamFit(a, p) >= 0.5))
      return { key: 'dream', label: `꿈꾸는 ${a.job} 일을 할 곳이 없다`, line: `(언젠가 ${a.job} 일을 해 보고 싶은데…)`, diary: `${a.job} 일을 하고 싶은데, 이 동네엔 그럴 만한 곳이 없다.` };
    return null;
  }

  // ───────────────────────── relationships: clashes, forgetting, gossip ─────────────────────────
  /** how badly two temperaments / values grate (0..1.5): quiet vs loud, sensitive vs short-tempered, loving what the other can't stand */
  clash(x: Agent, y: Agent): number {
    const P = x.persona, Q = y.persona;
    const pos = (v: number) => Math.max(0, v);
    let c = 0;
    c += pos(-P.social) * pos(Q.social) * 1.6; // a quiet soul next to a loud one
    c += pos(P.sensitive) * pos(Q.temper) * 1.8; // sensitive vs short-tempered
    c += pos(P.temper) * pos(Q.temper) * 1.2; // two hot heads
    c += pos(P.cheer) * pos(-Q.cheer) * 0.6 + pos(-P.kind) * pos(Q.social) * 0.5;
    // plain chemistry: some pairs just don't click, whatever their traits (fixed per pair, both ways)
    const chem = (hashString(x.id < y.id ? x.id + '|' + y.id : y.id + '|' + x.id) % 1000) / 1000;
    if (chem < 0.18) c += 1.0;
    else if (chem > 0.85) c -= 0.3; // …and some click unusually well
    const hates = x.traits.map(aversionObject).filter(Boolean) as string[];
    if (hates.length) {
      const loves = y.traits.filter((t) => traitPolarity(t) > 0).map(extractObject).filter(Boolean) as string[];
      if (hates.some((d) => loves.some((l) => this.matcher.similarity(d, l) >= 0.7))) c += 0.8;
    }
    return Math.max(-0.3, Math.min(1.5, c));
  }
  /** feelings fade toward neutral when nothing feeds them (lovers fade slowest); a fading couple may split */
  private decayRelations(mins: number) {
    const hours = mins / 60;
    for (const r of this.relations.values()) {
      const k = Math.pow(r.status === 'lovers' ? 0.998 : 0.994, hours);
      r.ab *= k;
      r.ba *= k;
      r.affinity = (r.ab + r.ba) / 2;
      if (r.status === 'lovers' && (r.ab < 35 || r.ba < 35)) this.breakUp(r);
    }
  }
  // ───────────────────────── reacting to what was just said (대화 문맥) ─────────────────────────
  /** what the last topical line was about (set by topicalLine, read by lineFor) */
  private lastTopical: { obj?: string; pol?: number; dream?: string; muse?: string } | undefined;

  /** how `s` feels about a thing: +1 likes, -1 dislikes, 0 no idea (from their own traits) */
  private stance(s: Agent, obj: string): number {
    let best = 0, pol = 0;
    for (const t of s.traits) {
      const o = extractObject(t);
      const v = o && (o === obj || o.includes(obj) || obj.includes(o)) ? 1 : this.matcher.similarity(t, obj);
      if (v > best) {
        best = v;
        pol = traitPolarity(t);
      }
    }
    return best >= 0.55 ? Math.sign(pol) || 1 : 0;
  }

  /**
   * The answer to the line the listener just said — agreeing, disagreeing, asking back, defending a
   * friend, thanking… Returns null when there's nothing natural to say back (then a new line starts).
   * Every reply also says what it is (`c.pendingAct`) so the other person can answer it in turn.
   */
  private reactTo(c: Conversation, s: Agent, l: Agent): { text: string; icon?: string } | null {
    const act = c.lastAct;
    if (!act || act.by !== l.id) return null;
    const next = (a?: Omit<ConvoAct, 'by'>) => void (c.pendingAct = a);
    const X = act.obj ?? '';
    // "사진 찍는 것" + 요 → "사진 찍는 거요"
    const Xyo = `${X.replace(/것$/, '거')}요`;
    if (X && /^(like|dislike|dream)$/.test(act.kind)) (c.covered ??= []).push(X);
    switch (act.kind) {
      case 'greet': {
        if (act.ask && act.obj === '어디') {
          const p = this.place(s.ai.targetPlaceId);
          return next(), { text: p ? (p.id === s.homeId ? '집에 가는 길이에요.' : `${p.name}에 가는 길이에요. 같이 갈래요?`) : pick(['그냥 산책 중이에요.', '딱히 정한 데는 없어요, 하하.']) };
        }
        if (act.ask && act.obj === '날씨') {
          const wx = { clear: pick(['맑아서 좋네요! 산책하기 딱이에요.', '햇살이 좋아요. 기분까지 좋아지네요.']), rain: pick(['비가 와서 좀 꿉꿉하네요.', '빗소리 듣기엔 좋은 날이에요.']), snow: pick(['눈 와요! 왠지 설레네요.', '춥지만 눈은 예쁘네요.']), storm: pick(['바람이 장난 아니에요. 조심해요!', '오늘은 집에 있고 싶네요.']) }[this.meta.weather];
          return next(), { text: wx };
        }
        if (act.ask) {
          const top = this.thoughtsSorted(s)[0];
          const why = top ? top.label.replace(/[!.]$/, '') : '';
          if (s.mood >= 65) return next(), { text: top && top.value > 0 ? `좋았어요! ${why}… 그래서 그런가 봐요.` : '좋았어요! 그쪽은요?', icon: '😊' };
          if (s.mood >= 40) return next({ kind: 'askBack' }), { text: '그럭저럭요. 그쪽은 어땠어요?' };
          return next({ kind: 'sad' }), { text: top && top.value < 0 ? `솔직히 좀 지쳤어요… ${why}.` : '솔직히 좀 지쳤어요…', icon: '💧' };
        }
        const mine = this.feel(s.id, l.id);
        if (mine <= -30) return next(), { text: pick(['…아, 네.', '네, 뭐.']), icon: '💭' };
        const wx = { clear: '오늘 날씨 좋네요.', rain: '비가 꽤 오네요.', snow: '눈 오니까 기분 좋네요.', storm: '바람이 엄청 부네요.' }[this.meta.weather];
        if (mine >= 40) return next(), { text: pick(['반가워요!', '오, 마침 보고 싶었는데!', `왔어요? ${wx}`]), icon: '😊' };
        return next(), { text: pick([`안녕하세요! ${wx}`, '아, 안녕하세요!', `네, 반가워요. ${wx}`]) };
      }
      case 'askBack':
        return next(), { text: s.mood >= 60 ? pick(['저는 꽤 좋았어요!', '저도 나쁘지 않았어요.']) : pick(['저도 그냥 그랬어요.', '저는 좀 피곤했어요, 하하.']) };
      case 'like': {
        const st = this.stance(s, X);
        if (st > 0) {
          this.addFeel(s.id, l.id, 2);
          this.addFeel(l.id, s.id, 2);
          return next({ kind: 'shared', obj: X }), { text: pick([`저도 ${josa(X, '을/를')} 정말 좋아해요!`, `오, ${X}! 저도 완전 좋아해요.`, `${X} 얘기 나오니까 반갑네요. 저도 좋아하거든요.`]), icon: '❤️' };
        }
        if (st < 0) return next({ kind: 'differ', obj: X }), { text: pick([`아… 저는 ${josa(X, '은/는')} 좀 별로라서요.`, `${Xyo}? 저랑은 잘 안 맞더라고요, 하하.`]), icon: '💭' };
        return next({ kind: 'askWhy', obj: X }), { text: pick([`${Xyo}? 어떤 점이 좋아요?`, `오, ${X}! 어떻게 좋아하게 됐어요?`]), icon: '❓' };
      }
      case 'shared':
        return next(), { text: pick(['역시 통하네요! 다음에 그 얘기 더 해요.', '이렇게 잘 통하는 사람 오랜만이에요.', '우리 취향 진짜 비슷하네요!']), icon: '😊' };
      case 'differ': {
        return next({ kind: 'askLike' }), { text: pick(['그래요? 그럼 뭘 좋아해요?', '아하, 사람마다 다르죠. 그쪽은 뭘 좋아해요?']) };
      }
      case 'askLike': {
        const likes = s.traits.filter((t) => traitPolarity(t) > 0).map(extractObject).filter(Boolean) as string[];
        if (!likes.length) return next(), { text: '음… 저는 아직 딱히 없어요. 찾는 중이에요.' };
        const o = pick(likes);
        return next({ kind: 'like', obj: o }), { text: pick([`저는 ${josa(o, '을/를')} 좋아해요.`, `저요? ${o} 얘기라면 하루 종일도 해요.`]) };
      }
      case 'askWhy':
        return next({ kind: 'explained' }), { text: pick([`그냥 ${josa(X, '을/를')} 생각만 해도 기분이 좋아져요.`, '처음엔 우연이었는데, 어느새 푹 빠졌어요.', '말로 하긴 어려운데… 그냥 마음이 편해져요.']), icon: '😊' };
      case 'explained':
        return next(), { text: pick(['그렇구나, 저도 한번 관심 가져 볼게요.', '듣고 보니 저도 궁금해지네요.', '그런 게 있다는 게 부럽네요.']) };
      case 'dislike': {
        const st = this.stance(s, X);
        if (st < 0) {
          this.addFeel(s.id, l.id, 2);
          return next(), { text: pick([`맞아요, 저도 ${josa(X, '은/는')} 좀…`, '그쵸? 저만 그런 게 아니었네요.']), icon: '😅' };
        }
        if (st > 0) return next(), { text: pick([`에이, ${josa(X, '은/는')} 좋은데요!`, `전 ${X} 좋아하는데… 아쉽네요.`]), icon: '💭' };
        return next({ kind: 'askWhyNot' }), { text: pick([`${X}에 무슨 안 좋은 기억 있어요?`, '왜요, 무슨 일 있었어요?']), icon: '❓' };
      }
      case 'askWhyNot':
        return next(), { text: pick(['예전에 좀 안 좋은 일이 있었거든요.', '그냥… 이유는 잘 모르겠는데 싫어요.', '얘기하자면 길어요, 하하.']) };
      case 'dream': {
        const mine = s.traits.map(extractDream).find(Boolean);
        const same = mine && this.matcher.similarity(mine, X) >= 0.5;
        return next({ kind: 'cheered' }), { text: same ? '저도 비슷한 꿈이 있어요! 우리 같이 힘내요.' : pick(['멋진 꿈이네요. 꼭 이루실 거예요!', '와, 응원할게요!', '그 꿈 이루면 제일 먼저 알려 줘요.']), icon: '✨' };
      }
      case 'cheered':
      case 'comforted':
        return next(), { text: pick(['고마워요, 힘이 나요!', '그렇게 말해 주니까 좋네요.', '헤헤, 고마워요.']), icon: '😊' };
      case 'comfort':
        return next(), { text: pick(['고마워요… 조금 나아졌어요.', '그렇게 말해 주니까 힘이 나요.', '들어 줘서 고마워요.']), icon: '🥲' };
      case 'sad': {
        if (s.persona.kind > 0 || this.feel(s.id, l.id) >= 30) return next({ kind: 'askSad' }), { text: pick(['무슨 일 있어요?', '괜찮아요? 얼굴이 안 좋아 보여요.']), icon: '💭' };
        return null;
      }
      case 'askSad': {
        const low = this.thoughtsSorted(s).find((t) => t.value < 0);
        return next({ kind: 'comfortNeeded' }), { text: low ? `${low.label.replace(/[!.]$/, '')}… 그래서 그래요.` : '그냥 이것저것요. 들어 줘서 고마워요.', icon: '💧' };
      }
      case 'comfortNeeded':
        this.addThought(l, `comfort:${s.id}`, `${josa(s.name, '이/가')} 위로해 줌`, 6, 180);
        return next({ kind: 'comfort' }), { text: pick(['그랬구나… 힘들었겠어요.', '말해 줘서 고마워요. 제가 옆에 있을게요.', '괜찮아질 거예요. 같이 있어 줄게요.']), icon: '❤️' };
      case 'rumor': {
        const about = (act.about ?? []).map((id) => this.agent(id)).filter(Boolean) as Agent[];
        const sent = act.sentiment ?? 0;
        if (about.some((x) => x.id === s.id)) return next(), { text: sent >= 0 ? pick(['에이, 누가 그런 말을 해요… 부끄럽게.', '헉, 벌써 소문났어요?']) : '…그런 얘기가 돈다고요?', icon: '😳' };
        const friend = about.find((x) => this.feel(s.id, x.id) >= 40);
        if (friend && sent < -0.2) {
          this.addFeel(s.id, l.id, -1);
          return next(), { text: `설마요. ${this.referName(s, friend)} 그럴 사람 아니에요.`, icon: '💢' };
        }
        if (sent > 0.2) return next(), { text: pick(['와, 잘됐네요!', '진짜요? 좋은 소식이네요.']), icon: '😊' };
        if (sent < -0.2) return next(), { text: pick(['헐, 진짜요?', '설마… 사실이 아니었으면 좋겠네요.']), icon: '😮' };
        return next(), { text: pick(['그래요? 처음 들어요.', '오, 그런 일이 있었구나.']) };
      }
      case 'secret': {
        const crush = this.agent(act.about?.[0]);
        if (crush && this.feel(s.id, crush.id) >= 62) {
          this.addThought(s, `rival:${crush.id}`, `${l.name}도 ${josa(crush.name, '을/를')} 좋아한다니… 마음이 복잡하다`, -4, 360);
          return next(), { text: pick(['아… 그렇구나. 응원… 할게요.', '그, 그렇군요. 잘되면 좋겠네요.']), icon: '💭' };
        }
        return next(), { text: pick(['헉! 비밀 꼭 지킬게요.', '와, 진짜요? 잘됐으면 좋겠어요!', '어머, 둘이 잘 어울려요!']), icon: '🤫' };
      }
      case 'monologue':
        return next({ kind: 'comforted' }), { text: pick(['얘기해 줘서 고마워요. 언제든 들어 줄게요.', '그런 마음이었구나… 몰랐어요.', '말해 줘서 고마워요. 우리 더 친해진 것 같아요.']), icon: '❤️' };
      case 'treasure':
        return next(), { text: pick(['소중한 거네요. 잘 간직해요.', '와, 사연이 궁금하네요.', '그런 물건 하나쯤 있으면 좋죠.']) };
      case 'gossipGood': {
        const x = this.agent(act.about?.[0]);
        if (!x) return null;
        const f = this.feel(s.id, x.id);
        return next(), { text: f >= 30 ? `맞아요, ${this.referName(s, x)} 진짜 좋은 사람이죠.` : f <= -10 ? '음… 저는 잘 모르겠어요.' : '그래요? 한번 친해져 보고 싶네요.' };
      }
      case 'gossipBad': {
        const x = this.agent(act.about?.[0]);
        if (!x) return null;
        return next(), { text: this.feel(s.id, x.id) <= -10 ? '그쵸? 저도 좀 그렇게 느꼈어요.' : pick(['음… 그래도 사정이 있겠죠.', '그래요? 저는 잘 모르겠어요.']), icon: '💭' };
      }
      case 'recall':
        return next(), { text: pick(['아, 맞다! 그 얘기 저도 계속 생각났어요.', '기억하고 있었어요? 반갑네요.', '그때 얘기 진짜 재밌었죠.']), icon: '😊' };
      case 'muse': {
        // "사실 저… 누군가 우울해 보이면 말을 걸고 싶어 하거든요" → "저도 그래요!" or interest
        const same = s.traits.some((t) => this.matcher.similarity(t, X) >= 0.6);
        if (same) {
          this.addFeel(s.id, l.id, 2);
          this.addFeel(l.id, s.id, 2);
          return next(), { text: pick(['어, 저도 그래요! 신기하네요.', '저도요! 우리 은근히 비슷하네요.']), icon: '😲' };
        }
        return next(), { text: pick(['오, 그렇구나. 처음 알았어요.', '의외네요! 그런 면이 있었구나.', '그거 좋네요. 더 알고 싶어져요.']) };
      }
      case 'birthdayWish':
        this.addFeel(s.id, l.id, 3);
        this.addFeel(l.id, s.id, 1);
        this.addThought(s, `wished-by:${l.id}`, `${givenName(l.name)}에게 생일 축하를 받음`, 3, 600);
        return next(), { text: pick(['고마워요! 기억해 줘서 정말 기뻐요.', '헤헤, 고마워요! 오늘 하루가 더 좋아졌어요.', '와, 알고 있었어요? 고마워요!']), icon: '💖' };
      case 'birthdayNews': {
        (this.wished.get(l.id) ?? this.wished.set(l.id, new Set()).get(l.id)!).add(s.id);
        this.addFeel(l.id, s.id, 3);
        this.addThought(l, `wished-by:${s.id}`, `${givenName(s.name)}에게 생일 축하를 받음`, 3, 600);
        return next({ kind: 'cheered' }), { text: pick(['어머, 진짜요? 생일 축하해요!', '헉, 몰랐어요! 축하해요! 🎉', '생일 축하해요! 오늘은 주인공이네요.']), icon: '🎉' };
      }
      case 'happy':
        if (Math.random() < 0.5) return null;
        return next(), { text: pick(['오늘 기분 좋아 보이네요!', '덩달아 저도 기분 좋아지네요.']), icon: '😊' };
    }
    return null;
  }

  /** Talk about someone who isn't here: badmouthing someone you dislike, or praising someone you love. */
  private gossipLine(c: Conversation, s: Agent, l: Agent): { text: string; icon?: string } | null {
    const absent = this.agents.filter((x) => x.kind === 'person' && x !== s && x !== l && !c.members.includes(x.id));
    const disliked = absent.filter((x) => this.feel(s.id, x.id) <= -10).sort((p, q) => this.feel(s.id, p.id) - this.feel(s.id, q.id))[0];
    const loved = absent.filter((x) => this.feel(s.id, x.id) >= 45).sort((p, q) => this.feel(s.id, q.id) - this.feel(s.id, p.id))[0];
    const bad = disliked && (!loved || Math.random() < 0.5);
    const x = bad ? disliked : loved;
    if (!x) return null;
    const nm = this.referName(s, x);
    if (bad) {
      const why = pick(['좀 이기적인 것 같아요', '말을 너무 함부로 해요', '은근히 사람을 무시해요', '약속을 잘 안 지켜요']);
      this.rumors.add({ text: hearsay(`${josa(x.name, '이/가')} ${why.replace(/요$/, '').replace(/해$/, '한다').replace(/아$/, '다')}`), tag: makeTag('험담', [x.name]), about: [x.id], sentiment: -0.5, knownBy: [s.id, l.id], origin: 'natural', born: this.meta.minutes, kind: 'gossip', heat: 8 });
      if (this.feel(l.id, x.id) >= 40) {
        // defending a friend: the gossip backfires on the one who started it
        this.addFeel(l.id, s.id, -5);
        this.addThought(l, `defend:${x.id}`, `${josa(x.name, '을/를')} 험담하는 걸 들어 불쾌함`, -4, 120);
        c.forced = { speakerId: l.id, toId: s.id, text: `에이, ${this.referName(l, x)} 그런 사람 아니에요.`, icon: '💢' };
        this.log(l, 'diary', `${josa(s.name, '이/가')} ${x.name} 험담을 했다. 친구 욕은 듣기 싫다.`, s.id);
      } else if (l.persona.kind > 0.3) {
        this.addFeel(l.id, s.id, -3);
        this.addThought(l, 'gossip-uneasy', '남 험담을 듣는 게 불편했다', -2, 90);
      } else {
        this.addFeel(l.id, x.id, -4);
        this.addFeel(l.id, s.id, 2); // a shared secret
      }
      if (!c.forced) c.pendingAct = { kind: 'gossipBad', about: [x.id] };
      return { text: `솔직히 ${nm}… ${why}.`, icon: '🤫' };
    }
    const why = pick(['늘 먼저 챙겨 줘요', '같이 있으면 마음이 편해요', '약속은 꼭 지켜요', '진짜 좋은 사람이에요']);
    this.rumors.add({ text: hearsay(`${josa(x.name, '이/가')} 진짜 좋은 사람이다`), tag: makeTag('칭찬', [x.name]), about: [x.id], sentiment: 0.5, knownBy: [s.id, l.id], origin: 'natural', born: this.meta.minutes, kind: 'care', heat: 6 });
    this.addFeel(l.id, x.id, 3);
    c.pendingAct = { kind: 'gossipGood', about: [x.id] };
    return { text: `${nm}… ${why}.`, icon: '😊' };
  }

  /**
   * "A가 B를 좋아한대" reaches A or B. B: flattered (and warmer) or uneasy, depending on how B feels.
   * A: the secret is out — and A knows exactly who they told.
   */
  private secretArrives(l: Agent, r: Rumor, from: Agent) {
    this.rumors.tell(r, l.id, this.meta.minutes);
    const owner = this.agent(r.secretOf);
    const target = this.agent(r.about.find((id) => id !== r.secretOf));
    if (!owner || !target) return;
    if (l === target) {
      if (this.feel(target.id, owner.id) >= 45) {
        this.addThought(target, `liked-by:${owner.id}`, `${josa(owner.name, '이/가')} 나를 좋아한대… 두근거린다`, 6, 720);
        this.addFeel(target.id, owner.id, 8);
        this.log(target, 'diary', `${josa(owner.name, '이/가')} 나를 좋아한다는 얘기를 들었다. 자꾸 생각난다.`, owner.id);
        this.say(target, `(${owner.name}… 정말일까?)`, { thought: true });
      } else {
        this.addThought(target, `liked-by:${owner.id}`, `${josa(owner.name, '이/가')} 나를 좋아한대… 조금 부담스럽다`, -2, 360);
        this.addFeel(target.id, owner.id, -3);
        this.log(target, 'diary', `${josa(owner.name, '이/가')} 나를 좋아한다고 한다. 어떻게 대해야 할지 모르겠다.`, owner.id);
      }
      return;
    }
    // the owner hears their own secret going around
    const confidant = this.agent(r.confidant);
    this.addThought(owner, 'secret-out', '비밀이 새어 나갔다', -7, 600);
    this.say(owner, pick(['(어떻게 그걸…?!)', '(분명히 비밀이라고 했는데…)']), { thought: true });
    if (confidant) {
      this.addFeel(owner.id, confidant.id, -12);
      this.log(owner, 'diary', `${confidant.name}한테만 말했는데… ${from.name}까지 알고 있었다. 다시는 말하나 봐라.`, confidant.id);
      this.relation(owner.id, confidant.id).memories.push({ t: this.meta.minutes, text: `${josa(owner.name, '이/가')} 털어놓은 비밀이 ${confidant.name} 쪽에서 새어 나갔다.` });
    }
  }

  // ───────────────────────── romance ─────────────────────────
  loverOf(a: Agent): Agent | undefined {
    for (const r of this.relations.values()) if (r.status === 'lovers' && (r.a === a.id || r.b === a.id)) return this.agent(r.a === a.id ? r.b : r.a);
    return undefined;
  }
  /** after a warm 1:1 talk, whoever is smitten may confess — and it usually doesn't work out */
  private maybeConfess(p: Agent, q: Agent) {
    const [x, y] = this.feel(p.id, q.id) >= this.feel(q.id, p.id) ? [p, q] : [q, p];
    if (x.kind !== 'person' || y.kind !== 'person') return;
    const r = this.relation(x.id, y.id);
    if (r.status === 'lovers' || this.feel(x.id, y.id) < 75 || this.loverOf(x)) return;
    if (r.confessedAt !== undefined && this.meta.minutes - r.confessedAt < 3 * 1440) return;
    if (Math.random() > 0.3) return;
    r.confessedAt = this.meta.minutes;
    const theirs = this.feel(y.id, x.id);
    const taken = !!this.loverOf(y);
    const p_ = taken ? 0.02 : theirs >= 85 ? 0.75 : theirs >= 70 ? 0.35 : theirs >= 55 ? 0.12 : 0.03;
    this.say(x, `${this.callName(x, y)}, 사실… 좋아해요. 저랑 사귈래요?`, { to: y });
    this.emote(x, '💗');
    if (Math.random() < p_) {
      r.status = 'lovers';
      r.since = this.meta.minutes;
      this.say(y, pick(['…저도요. 좋아요.', '사실 저도 같은 마음이었어요.', '…네. 잘 부탁해요.']), { to: x });
      this.emote(y, '💕');
      this.pushFeed({ kind: 'romance', speakerId: x.id, text: `💘 ${x.name}의 고백을 ${josa(y.name, '이/가')} 받아들였다. 두 사람은 이제 연인이다!` });
      this.addThought(x, 'love', '고백이 받아들여졌다!', 14, 1440);
      this.addThought(y, 'love', '연인이 생겼다', 10, 1440);
      this.addFeel(x.id, y.id, 6);
      this.addFeel(y.id, x.id, 8);
      r.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} 고백했고, ${josa(y.name, '이/가')} 받아들였다. 연인이 되었다.` });
      this.log(x, 'diary', `${y.name}에게 고백했다. …받아 줬다. 오늘을 평생 못 잊을 것 같다.`, y.id);
      this.log(y, 'diary', `${josa(x.name, '이/가')} 고백했다. 심장이 아직도 두근거린다.`, x.id);
      this.naturalRumor(`${josa(x.name, '이랑/랑')} ${y.name}, 사귄대`, [x, y], x, 0.6, 'romance', 16);
    } else {
      this.say(y, pick(['미안해요… 좋은 친구로 지내고 싶어요.', '고마워요. 그런데… 아직은 잘 모르겠어요.', '…미안해요.']), { to: x });
      this.emote(x, '💔');
      this.pushFeed({ kind: 'romance', speakerId: x.id, text: `💔 ${josa(x.name, '이/가')} ${y.name}에게 고백했지만, 마음이 닿지 않았다.` });
      this.addThought(x, 'heartbreak', '고백했다가 차였다', -12, 720);
      this.addThought(y, 'turned-down', '고백을 거절해서 마음이 무겁다', -3, 240);
      this.addFeel(x.id, y.id, -6); // a little awkward now
      this.addFeel(y.id, x.id, -2);
      r.memories.push({ t: this.meta.minutes, text: `${josa(x.name, '이/가')} 고백했지만 ${josa(y.name, '이/가')} 거절했다.` });
      this.log(x, 'diary', `${y.name}에게 고백했다. 안 된대. …괜찮은 척하는 중.`, y.id);
      this.naturalRumor(`${josa(x.name, '이/가')} ${y.name}한테 고백했다가 차였대`, [x, y], x, -0.2, 'gossip', 12);
    }
  }
  /** both head to a place they'd both enjoy */
  private planDate(a: Agent, b: Agent): boolean {
    const spots = this.places.filter((p) => ['cafe', 'cinema', 'restaurant', 'park', 'bar', 'plaza', 'karaoke', 'bakery'].includes(p.style) && this.openAt(p));
    const p = spots.sort((x, y) => this.favor(a, y) + this.favor(b, y) - this.favor(a, x) - this.favor(b, x) + (Math.random() - 0.5) * 0.4)[0];
    if (!p) return false;
    for (const [m, o] of [[a, b], [b, a]] as const) {
      this.addThought(m, 'date-today', `${josa(o.name, '와/과')} 데이트 약속`, 5, 360);
      m.ai.dateWith = o.id;
      this.goVisit(m, p);
    }
    return true;
  }
  private dateMoment(a: Agent, p: Place) {
    const b = this.agent(a.ai.dateWith);
    a.ai.dateWith = undefined;
    if (!b) return;
    const r = this.relation(a.id, b.id);
    const day = Math.floor(this.meta.minutes / 1440);
    if (r.status !== 'lovers' || r.lastDate === day) return;
    r.lastDate = day;
    this.pushFeed({ kind: 'romance', speakerId: a.id, text: `💕 ${josa(a.name, '와/과')} ${josa(b.name, '이/가')} ${p.name}에서 데이트 중` });
    for (const [m, o] of [[a, b], [b, a]] as const) {
      this.addThought(m, 'date', `${josa(o.name, '와/과')} 데이트를 했다`, 8, 480);
      this.addFeel(m.id, o.id, 4);
      this.emote(m, '💕');
    }
    r.memories.push({ t: this.meta.minutes, text: `${p.name}에서 데이트를 했다.` });
    this.log(a, 'diary', `${josa(b.name, '와/과')} ${p.name}에 갔다. 시간이 너무 빨리 갔다.`, b.id);
    this.log(p, 'event', `${josa(a.name, '와/과')} ${josa(b.name, '이/가')} 데이트하러 왔다.`);
    this.naturalRumor(`${josa(a.name, '이랑/랑')} ${josa(b.name, '이/가')} ${p.name}에서 데이트하더래`, [a, b], a, 0.5, 'romance', 10);
  }
  /** someone hears about a couple: a crush turns into jealousy, friends cheer */
  private romanceNews(l: Agent, r: Rumor) {
    const [x, y] = r.about.map((id) => this.agent(id));
    if (!x || !y || l === x || l === y || r.sentiment <= 0) return;
    for (const [m, o] of [[x, y], [y, x]] as const) {
      if (this.feel(l.id, m.id) >= 65 && this.addThought(l, `jealous:${m.id}`, `${josa(m.name, '이/가')} ${o.name}랑… 마음이 복잡하다`, -7, 720)) {
        this.addFeel(l.id, o.id, -8);
        this.log(l, 'diary', `${josa(m.name, '이/가')} ${o.name}랑 사귄다고 한다. …아무렇지 않은 척해야지.`, m.id);
        this.say(l, `(${m.name}… 그렇구나.)`, { thought: true });
        return;
      }
    }
    if ((this.feel(l.id, x.id) >= 35 || this.feel(l.id, y.id) >= 35) && this.addThought(l, `cheer:${x.id}`, '친구의 연애를 응원한다', 3, 360)) {
      this.addFeel(l.id, x.id, 2);
      this.addFeel(l.id, y.id, 2);
    }
  }
  private breakUp(r: Relation) {
    const a = this.agent(r.a), b = this.agent(r.b);
    r.status = 'ex';
    if (!a || !b) return;
    this.pushFeed({ kind: 'romance', speakerId: a.id, text: `💔 ${josa(a.name, '와/과')} ${josa(b.name, '이/가')} 헤어졌다.` });
    for (const [m, o] of [[a, b], [b, a]] as const) {
      this.addThought(m, 'breakup', `${josa(o.name, '와/과')} 헤어졌다`, -10, 1440);
      this.log(m, 'diary', `${josa(o.name, '와/과')} 헤어졌다. 이렇게 끝날 줄은 몰랐다.`, o.id);
    }
    r.memories.push({ t: this.meta.minutes, text: '헤어졌다.' });
    this.naturalRumor(`${josa(a.name, '이랑/랑')} ${b.name}, 헤어졌대`, [a, b], a, -0.3, 'romance', 14);
  }

  // ───────────────────────── groups (그룹) ─────────────────────────
  factionsOf(id: string): Faction[] {
    return this.factions.filter((f) => f.members.includes(id));
  }
  faction(id?: string) {
    return id ? this.factions.find((f) => f.id === id) : undefined;
  }
  sharesGroup(a: string, b: string) {
    return this.factions.some((f) => f.members.includes(a) && f.members.includes(b));
  }
  private mutual(a: string, b: string) {
    return (this.feel(a, b) + this.feel(b, a)) / 2;
  }

  /** Where the members hang out most (sum of visits), used for naming and hangouts. */
  private groupHome(members: string[]): Place | undefined {
    let best: Place | undefined, bv = 0;
    for (const p of this.places) {
      const v = members.reduce((s, m) => s + (p.regulars[m] ?? 0), 0);
      if (v > bv) (bv = v), (best = p);
    }
    return bv >= 2 ? best : undefined;
  }

  /** A keyword for the group name: their hangout, else the most shared liked thing. */
  private groupKeyword(members: Agent[], home?: Place): string {
    if (home) return STYLE_LABEL[home.style];
    const count = new Map<string, number>();
    for (const m of members)
      for (const t of m.traits) {
        const o = traitPolarity(t) > 0 ? extractObject(t) : null;
        if (o && o.length <= 6) count.set(o, (count.get(o) ?? 0) + 1);
      }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 2 ? top[0] : '골목';
  }

  /** Create a group (emergent or by the player). */
  formFaction(memberIds: string[], opts: { name?: string; origin?: Faction['origin'] } = {}): Faction | null {
    const members = memberIds.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.kind === 'person');
    if (members.length < 2) return null;
    const home = this.groupHome(members.map((m) => m.id));
    const h = (this.meta.minutes % 1440) / 60;
    const night = h >= 21 || h < 5 ? '심야_' : '';
    const taken = this.factions.map((f) => f.name);
    let name = opts.name?.trim() || coinName(night + this.groupKeyword(members, home), members.map((m) => m.id).join(), taken);
    if (!name.startsWith('#')) name = '#' + name.replace(/\s+/g, '_');
    const f: Faction = {
      id: uid('g'), name, color: factionColor(name, this.factions.map((x) => x.color)), members: members.map((m) => m.id),
      founded: this.meta.minutes, homePlaceId: home?.id, origin: opts.origin ?? 'emergent', logs: [],
    };
    this.factions.push(f);
    const names = members.map((m) => m.name).join(', ');
    f.logs.push({ t: this.meta.minutes, text: `${names}${suffix(members[members.length - 1].name, '이/가')} 모여 ${f.name}${suffix(f.name.replace(/[^가-힣a-zA-Z0-9]+$/, ''), '을/를')} 결성했다.` });
    this.pushFeed({ kind: 'care', text: `🎉 ${members.length}명의 윌이 모여 ${f.name}${suffix(f.name, '을/를')} 결성했어요!` });
    for (const m of members) {
      this.log(m, 'event', `${f.name}의 멤버가 되었다.`);
      this.addThought(m, `group:${f.id}`, `${f.name}에 소속감을 느낌`, 6, 600);
    }
    if (members[0]) this.naturalRumor(`${names}${suffix(members[members.length - 1].name, '이/가')} ${f.name}${suffix(f.name, '을/를')} 만들었대`, members, members[0], 0.4, 'bond', 20);
    // let the storyteller coin a livelier name (kept only if it looks like a #hashtag)
    if (this.simSpeed < 3) World.storyHook?.({
      world: this, kind: 'groupName', speaker: members[0], draft: f.name, topic: `${home ? home.name + ' 단골' : ''} ${this.groupKeyword(members, home)}`.trim(), important: true,
      listener: undefined,
      apply: (t) => {
        const clean = '#' + t.replace(/^#+/, '').replace(/[\s"“”'.,!?]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        if (!/^#[가-힣A-Za-z0-9_]{2,18}$/.test(clean) || this.factions.some((x) => x !== f && x.name === clean)) return;
        f.logs.push({ t: this.meta.minutes, text: `모임 이름을 ${clean}${suffix(clean, '으로/로')} 정했다.` });
        f.name = clean;
      },
    });
    return f;
  }

  disbandFaction(id: string, why = '해산했다.') {
    const f = this.faction(id);
    if (!f) return;
    this.factions = this.factions.filter((x) => x !== f);
    this.pushFeed({ kind: 'event', text: `💨 ${f.name} — ${why}` });
    for (const m of f.members) {
      const a = this.agent(m);
      if (a) this.log(a, 'event', `${f.name}이(가) 사라졌다. 조금 허전하다.`.replace('이(가)', suffix(f.name, '이/가')));
    }
  }

  renameFaction(id: string, name: string) {
    const f = this.faction(id);
    if (!f) return false;
    const clean = '#' + name.trim().replace(/^#+/, '').replace(/\s+/g, '_');
    f.logs.push({ t: this.meta.minutes, text: `이름이 ${f.name}에서 ${clean}${suffix(clean, '으로/로')} 바뀌었다.` });
    f.name = clean;
    return true;
  }

  /** every 30 game minutes: new groups form, people join/leave, tiny groups dissolve */
  private updateFactions() {
    const alive = new Set(this.agents.filter((a) => a.kind === 'person').map((a) => a.id));
    for (const g of findNewGroups(this.groupHistory, (a, b) => this.mutual(a, b), this.factions, alive)) this.formFaction(g);
    const co = coChatCounts(this.groupHistory);
    const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const f of [...this.factions]) {
      // join: chatted together repeatedly with at least half the members, and warm both ways
      for (const id of alive) {
        if (f.members.includes(id)) continue;
        const withMany = f.members.filter((m) => (co.get(key(id, m)) ?? 0) >= 2).length >= Math.ceil(f.members.length / 2);
        if (!withMany) continue;
        const out = f.members.reduce((s, m) => s + this.feel(id, m), 0) / f.members.length;
        const back = f.members.reduce((s, m) => s + this.feel(m, id), 0) / f.members.length;
        if (out >= 45 && back >= 35) {
          f.members.push(id);
          const a = this.agent(id)!;
          f.logs.push({ t: this.meta.minutes, text: `${josa(a.name, '이/가')} 새로 합류했다.` });
          this.log(a, 'event', `${f.name}에 들어갔다. 이제 나도 이 사람들 중 하나다.`);
          this.pushFeed({ kind: 'care', speakerId: a.id, text: `🤝 ${josa(a.name, '이/가')} ${f.name}에 합류했어요.` });
        }
      }
      // leave: drifted apart
      for (const id of [...f.members]) {
        const others = f.members.filter((m) => m !== id);
        if (!others.length) continue;
        const avg = others.reduce((s, m) => s + this.mutual(id, m), 0) / others.length;
        if (avg < 15) {
          f.members = others;
          const a = this.agent(id);
          if (a) {
            f.logs.push({ t: this.meta.minutes, text: `${josa(a.name, '이/가')} 모임을 떠났다.` });
            this.log(a, 'event', `${f.name}에서 나왔다. 예전 같지 않다.`);
          }
        }
      }
      if (f.members.length < 3) this.disbandFaction(f.id, '모이는 사람이 줄어 자연스럽게 흩어졌다.');
    }
  }

  // ───────────────────────── rumors & monologues ─────────────────────────
  /**
   * A rumor is born only if someone SAW it: awake Wills near `origin` who aren't its subjects.
   * More witnesses → hotter from the start (a crowd can put it straight on the board).
   * `selfTold` news (birthdays, lottery wins…) may also be spread by the subject themselves.
   */
  private naturalRumor(text: string, about: (Agent | Place)[], origin: Agent, sentiment: number, kind: Rumor['kind'], heat?: number, selfTold = false) {
    const subjects = new Set(about.map((e) => e.id));
    const witnesses = this.grid
      .queryRadius(origin.x, origin.y, 170, this.tmp)
      .filter((a) => a.kind === 'person' && !a.ai.sleeping && !subjects.has(a.id))
      .map((a) => a.id);
    const knownBy = witnesses.length ? witnesses : selfTold && origin.kind === 'person' ? [origin.id] : [];
    if (!knownBy.length) return null; // nobody saw it → no rumor
    const r = this.rumors.add({
      text: hearsay(text), tag: makeTag(text, about.filter((e) => e.kind !== 'place' || about.length === 1).map((e) => e.name).slice(0, 2)), about: about.map((e) => e.id),
      sentiment, knownBy, origin: 'natural', born: this.meta.minutes, kind, heat: (heat ?? 6) + witnesses.length * 4, selfTold,
    });
    if (r) this.checkTopRumor();
    return r;
  }

  /** 🌐 global trend board (group-scoped boards arrive with Phase-3 groups). */
  globalTrends(limit = 10): (TrendRow & { reach: number })[] {
    const pop = this.agents.filter((a) => a.kind === 'person').length;
    const spec = scopeSpec('global', (id) => this.factionsOf(id).map((f) => f.id), pop);
    return this.rumors
      .trends(this.meta.minutes, { key: spec.key, filter: spec.filter, score: (r) => r.heat * (0.5 + spec.reach(r)), limit })
      .map((row) => ({ ...row, reach: spec.reach(row.rumor) }));
  }

  /** Trend board inside one group: rumors circulating among its members. */
  groupTrends(fid: string, limit = 10): (TrendRow & { reach: number })[] {
    const f = this.faction(fid);
    if (!f) return [];
    const spec = scopeSpec(f, (id) => this.factionsOf(id).map((x) => x.id), f.members.length);
    return this.rumors
      .trends(this.meta.minutes, { key: spec.key, filter: spec.filter, score: (r) => r.heat * (0.5 + spec.reach(r)), limit })
      .map((row) => ({ ...row, reach: spec.reach(row.rumor) }));
  }

  /** Player-planted rumor ("소문 퍼뜨리기"). */
  plantRumor(text: string, whisperTo: Agent[] = []): Rumor | null {
    const all: (Agent | Place)[] = [...this.agents, ...this.places];
    const about = all.filter((e) => e.name.length >= 2 && text.includes(e.name.replace(/\s*«.*»/, '')));
    let targets = whisperTo.filter((a) => a.kind === 'person');
    if (!targets.length) {
      const people = this.agents.filter((a) => a.kind === 'person' && !about.includes(a));
      targets = people.sort(() => Math.random() - 0.5).slice(0, 2);
    }
    const r = this.rumors.add({
      text: hearsay(text), tag: makeTag(text, about.map((e) => e.name)), about: about.map((e) => e.id), sentiment: guessSentiment(text),
      knownBy: targets.map((a) => a.id), origin: 'player', born: this.meta.minutes, heat: 28, kind: 'event',
    });
    if (r) {
      for (const t of targets) this.log(t, 'event', `어디선가 이런 소문을 들었다: "${r.text}"`);
      this.checkTopRumor();
    }
    return r;
  }

  private hearRumor(l: Agent, r: Rumor, from: Agent) {
    this.rumors.tell(r, l.id, this.meta.minutes);
    // a confided crush reaches one of the two people it's about
    if (r.secretOf && r.about.includes(l.id)) return this.secretArrives(l, r, from);
    for (const id of r.about) {
      if (id === l.id) {
        this.addThought(l, `rumor:${r.id}`, r.sentiment >= 0 ? '내 좋은 소문이 돌고 있다' : '나에 대한 안 좋은 소문을 들음', r.sentiment >= 0 ? 4 : -7, 240);
        this.log(l, 'diary', r.sentiment >= 0 ? `내 소문이 돌고 있단다. "${r.text}" …조금 쑥스럽다.` : `나에 대한 이상한 소문을 들었다. "${r.text}" 누가 퍼뜨린 거지?`);
        continue;
      }
      const subj = this.agent(id);
      if (!subj) continue;
      this.addFeel(l.id, subj.id, r.sentiment * 5); // only the listener's view changes
      // hearing someone is struggling: caring Wills go and check on them
      if (r.kind === 'struggle' && l.persona.kind > 0.2 && subj.kind === 'person' && Math.random() < 0.5) {
        l.ai.meetWith = subj.id;
        l.ai.meetForced = false;
        l.ai.timer = 40;
        this.log(l, 'diary', `${josa(subj.name, '이/가')} 힘들어 보인다는 얘기를 들었다. 한번 가 봐야겠다.`, subj.id);
      }
    }
    // not everyone enjoys bad news about others — and nobody likes the one who brings bad news about them
    if (r.sentiment < 0 && !r.about.includes(l.id) && (l.persona.kind > 0.3 || l.traits.some((t) => /(험담|뒷담|남 얘기)/.test(t)))) {
      this.addFeel(l.id, from.id, -2);
      this.addThought(l, 'gossip-uneasy', '남 얘기를 듣는 게 불편했다', -2, 90);
    }
    if (r.sentiment < 0 && r.about.includes(l.id)) this.addFeel(l.id, from.id, -4);
    if (r.kind === 'romance') this.romanceNews(l, r);
    if (Math.random() < 0.3) this.log(l, 'event', `${from.name}에게서 소문을 들었다: "${r.text}"`, from.id);
    this.checkTopRumor();
  }

  private checkTopRumor() {
    let top: Rumor | undefined;
    for (const r of this.rumors.rumors) if (!top || r.heat > top.heat) top = r;
    if (top && top.id !== this.topRumorId && top.heat >= 25) {
      this.topRumorId = top.id;
      this.pushFeed({ kind: 'rumor', text: `🔥 실시간 트렌드 1위 ${top.tag} — "${top.text}"` });
    }
  }

  /** Several sentences from traits, treasure, dream and current mood. */
  composeMonologue(a: Agent, listener?: Agent): string {
    const out: string[] = [];
    out.push(listener ? pick(['있잖아요, 이건 아무한테나 안 하는 얘긴데요.', '갑자기 이런 얘기 해서 미안한데요…', '요즘 이런저런 생각이 많아요.']) : pick(['가끔은 이런 생각을 한다.', '아무도 없을 때면 꼭 이런 생각이 든다.']));
    const neutral = a.traits.filter((t) => traitPolarity(t) === 0 && !extractDream(t));
    const heavy = neutral.filter((t) => /(요즘|최근|얼마 전|계속|매일|혼자|고향|그리워)/.test(t));
    const backstory = Math.random() < 0.7 && heavy.length ? pick(heavy) : neutral.length ? pick(neutral) : undefined;
    if (backstory) out.push(listener ? `사실 저 ${toGeodeunyo(backstory)}.` : `사실 나는 ${backstory.replace(/다$/, '다.').replace(/\.\.$/, '.')}`);
    if (a.mood <= 30) out.push(listener ? '괜찮은 척하는 것도 요즘은 좀 지쳐요.' : '괜찮은 척하는 것도 이제 좀 지친다.');
    else if (a.mood >= 75) out.push(listener ? '그래도 요즘은 하루하루가 꽤 괜찮아요.' : '그래도 요즘은 하루하루가 꽤 괜찮다.');
    if (a.treasure && Math.random() < 0.7) out.push(listener ? `이 ${josa(a.treasure, '을/를')} 보면 ${pick(['처음 이 동네에 왔을 때가 생각나요', '힘들 때마다 조금은 버틸 수 있었어요', '누군가가 떠올라요'])}.` : `${josa(a.treasure, '을/를')} 만지작거리면 ${pick(['처음 이 동네에 왔을 때가 떠오른다', '조금은 버틸 수 있을 것 같다'])}.`);
    const likes = a.traits.map((t) => (traitPolarity(t) > 0 ? extractObject(t) : null)).filter(Boolean) as string[];
    const like = likes.length ? pick(likes) : null;
    const friend = this.agents
      .filter((o) => o !== a && o.kind === 'person' && this.feel(a.id, o.id) >= 50)
      .sort((x, y) => this.feel(a.id, y.id) - this.feel(a.id, x.id))[0];
    if (friend && friend !== listener && Math.random() < 0.4) out.push(listener ? `${josa(friend.name, '이/가')} 없었으면 어떻게 버텼을까 싶어요.` : `${josa(friend.name, '이/가')} 있어서 다행이다.`);
    else if (friend && friend === listener && Math.random() < 0.6) out.push(`요즘 ${josa(this.referName(a, listener), '이랑/랑')} 얘기하는 시간이 제일 좋아요.`);
    const but = a.mood >= 75 ? '' : '그래도 ';
    if (like && Math.random() < 0.8) out.push(listener ? pick([`${but}${like} 생각을 하면 조금 괜찮아져요.`, `${like}만 있으면 뭐든 버틸 수 있을 것 같아요.`]) : `${but}${like} 생각을 하면 조금 괜찮아진다.`);
    const dream = a.traits.map(extractDream).find(Boolean);
    if (dream) out.push(listener ? `언젠가 ${dream}… 그게 제 꿈이에요.` : `언젠가 ${dream}. 그날까지는 버텨 보자.`);
    const grp = this.factionsOf(a.id)[0];
    if (grp && Math.random() < 0.35) out.push(listener ? `요즘은 ${grp.name} 사람들 덕분에 덜 외로워요.` : `${grp.name} 사람들이 있어서 다행이다.`);
    if (listener) {
      const nm = this.referName(a, listener);
      out.push(pick(['…들어줘서 고마워요.', `이런 얘기, ${nm}${/씨$/.test(nm) ? '라서' : copula(nm).endsWith('이다') ? '이라서' : '라서'} 하는 거예요.`, '우리 앞으로도 잘 지내요.']));
    }
    return out.join(' ');
  }

  // ───────────────────────── god interventions ─────────────────────────
  setWeather(w: Weather) {
    this.meta.weather = w;
    for (const a of this.agents) if (a.kind === 'person') a.thoughts = a.thoughts.filter((t) => t.key !== 'weather');
  }

  setContext(ctx: string) {
    const prev = this.meta.context;
    this.meta.context = ctx;
    for (const a of this.agents) {
      if (a.kind !== 'person') continue;
      this.addThought(a, 'worldshift', '세상이 하루아침에 달라져 어리둥절함', -4, 120);
      this.log(a, 'mutation', `세계가 ${prev}에서 ${josa(ctx, '으로/로')} 바뀌었다.`);
      // queue a reactive mutation; a newer world shift replaces an older pending one
      // nobody "gets it" instantly: sensitive/curious Wills sooner, easy-going ones much later
      const speedUp = 1 - Math.max(0, a.persona.sensitive) * 0.35 - Math.max(0, a.persona.curious) * 0.25 + Math.max(0, -a.persona.energy) * 0.3;
      const delay = (30 + Math.random() * 330) * Math.max(0.4, speedUp);
      const q: (MutationReason & { readyAt: number })[] = (this.mutationQueue.get(a.id) ?? []).filter((r) => r.kind !== 'context');
      q.push({ kind: 'context', from: prev, to: ctx, readyAt: this.meta.minutes + delay });
      this.mutationQueue.set(a.id, q);
    }
  }

  /** queue impact mutations for Wills near a high-impact newcomer (dragon, celebrity, …) */
  private queueImpact(e: Agent) {
    const what = impactOf(e.category, e.appearance, e.name);
    if (!what) return;
    for (const a of this.agents) {
      if (a === e || a.kind !== 'person' || Math.hypot(a.x - e.x, a.y - e.y) > TILE * 12) continue;
      const q = this.mutationQueue.get(a.id) ?? [];
      q.push({ kind: 'impact', byId: e.id, byName: e.name, what, readyAt: this.meta.minutes + 5 + Math.random() * 40 });
      this.mutationQueue.set(a.id, q);
      this.emote(a, '❗');
    }
  }

  /** Lazy processing: only DUE mutations, watched Will first, then Wills inside the camera view; others wait. */
  private processOneMutation() {
    const v = this.viewRect;
    const now = this.meta.minutes;
    const inView = (a: Agent) => !v || (a.x >= v.x0 && a.x <= v.x1 && a.y >= v.y0 && a.y <= v.y1);
    const due = (id: string) => (this.mutationQueue.get(id) ?? []).some((r) => r.readyAt <= now);
    let pickId: string | undefined;
    if (this.watchedId && due(this.watchedId)) pickId = this.watchedId;
    else
      for (const id of this.mutationQueue.keys()) {
        const a = this.agent(id);
        if (!a) {
          this.mutationQueue.delete(id);
          continue;
        }
        if (due(id) && inView(a)) {
          pickId = id;
          break;
        }
      }
    if (!pickId) return;
    const a = this.agent(pickId);
    const q = this.mutationQueue.get(pickId) ?? [];
    const i = q.findIndex((r) => r.readyAt <= now);
    const [reason] = q.splice(i, 1);
    if (q.length) this.mutationQueue.set(pickId, q);
    else this.mutationQueue.delete(pickId);
    if (a && reason) this.applyMutation(a, reason);
  }

  /**
   * Slow drift from lived experience — happens even when nothing in the world changes.
   * Picks one fitting story for this Will (friend influence, a comfortable place, habits from
   * repeated events, a healing wound, group belonging) and queues it with a delay.
   */
  private planDrift(a: Agent) {
    if ((this.mutationQueue.get(a.id) ?? []).some((r) => r.kind === 'drift')) return;
    const options: Extract<MutationReason, { kind: 'drift' }>[] = [];
    // 1) friend's taste rubs off
    const friend = this.agents.filter((o) => o !== a && o.kind === 'person' && this.feel(a.id, o.id) >= 50).sort(() => Math.random() - 0.5)[0];
    if (friend) {
      const theirLike = friend.traits.map((t) => (traitPolarity(t) > 0 ? extractObject(t) : null)).find((o) => o && o.length <= 12 && !a.traits.some((t) => t.includes(o)));
      if (theirLike) options.push({ kind: 'drift', source: 'friend', text: `요즘 ${this.referName(a, friend)} 영향으로 ${theirLike}에 관심이 생겼다`, note: `${friend.name}의 영향으로` });
    }
    // 2) a place becomes a comfort
    const fav = this.places.filter((p) => (p.regulars[a.id] ?? 0) >= 5).sort((x, y) => (y.regulars[a.id] ?? 0) - (x.regulars[a.id] ?? 0))[0];
    if (fav && !a.traits.some((t) => t.includes(fav.name))) options.push({ kind: 'drift', source: 'place', text: `${fav.name}에 가면 마음이 편해진다`, note: `${fav.name}의 단골이 되며` });
    // 3) habits from repeated experience
    const diary = a.logs.slice(-60);
    const fights = diary.filter((l) => /싸웠다|말다툼/.test(l.text)).length;
    const pets = a.thoughts.some((t) => t.key.startsWith('pet:')) || diary.filter((l) => /쓰다듬/.test(l.text)).length >= 2;
    if (fights >= 2) options.push({ kind: 'drift', source: 'experience', text: '말다툼 뒤엔 혼자 걷는 버릇이 생겼다', note: '잦은 다툼 끝에' });
    if (pets) options.push({ kind: 'drift', source: 'experience', text: '길고양이를 보면 저도 모르게 걸음을 멈춘다', note: '동물들과 자주 마주치며' });
    if (a.jobId && diary.filter((l) => /퇴근|일을 마쳤다/.test(l.text)).length >= 2) options.push({ kind: 'drift', source: 'experience', text: '일이 손에 익어 조금 자신감이 붙었다', note: '꾸준히 일하며' });
    if (a.mood <= 30) options.push({ kind: 'drift', source: 'experience', text: '요즘은 사소한 일에도 쉽게 지친다', note: '힘든 날이 이어지며' });
    if (a.mood >= 80) options.push({ kind: 'drift', source: 'experience', text: '요즘은 아침에 눈뜨는 게 즐겁다', note: '좋은 날이 이어지며' });
    // 4) wounds heal: "얼마 전 실연을 당했다" → "…아픔이 조금씩 옅어지고 있다"
    const wound = a.traits.find((t) => /(실연|떨어지고 있다|떨어져|우울하다|잃은 적|그리워한다|힘들다)/.test(t) && !/옅어지고/.test(t));
    if (wound && a.mood >= 50) {
      const missed = wound.match(/^(.+?)(?:을|를)\s*그리워한다/)?.[1];
      const healed = /실연/.test(wound)
        ? '실연의 아픔이 조금씩 옅어지고 있다'
        : /(오디션|떨어)/.test(wound)
          ? '계속 떨어져도 다시 해 볼 용기가 조금씩 생긴다'
          : /우울/.test(wound)
            ? '우울했던 마음이 조금씩 가벼워지고 있다'
            : /잃은 적/.test(wound)
              ? '떠나간 이를 떠올려도 이제는 조금 덜 아프다'
              : missed
                ? `${josa(missed, '을/를')} 그리워하지만, 지금의 삶도 나쁘지 않다고 느낀다`
                : '힘든 시간이 조금씩 지나가고 있다';
      options.push({ kind: 'drift', source: 'heal', replaces: wound, text: healed, note: '시간이 흐르며' });
    }
    // 5) group colours you
    const grp = this.factionsOf(a.id)[0];
    if (grp && !a.traits.some((t) => t.includes(grp.name))) options.push({ kind: 'drift', source: 'group', text: `${grp.name} 사람들과 있으면 웃음이 많아진다`, note: `${grp.name}에 물들며` });
    if (!options.length) return;
    const pickOne = options[Math.floor(Math.random() * options.length)];
    const q = this.mutationQueue.get(a.id) ?? [];
    q.push({ ...pickOne, readyAt: this.meta.minutes + 30 + Math.random() * 240 });
    this.mutationQueue.set(a.id, q);
  }

  private applyMutation(a: Agent, reason: MutationReason) {
    const probe = reason.kind === 'context' ? reason.to : reason.kind === 'impact' ? reason.byName : reason.text;
    if (reason.kind === 'drift' && reason.replaces && !a.traits.includes(reason.replaces)) return;
    const res = mutateTraits(a, reason, (t) => this.matcher.similarity(t, probe));
    if (reason.kind === 'context') {
      this.addThought(a, 'realize', `이제야 실감이 난다… 여긴 정말 「${reason.to}」구나`, -2, 180);
      this.say(a, `(이제야 실감이 난다… 여긴 정말 「${reason.to}」구나.)`, { thought: true, silentFeed: true });
    }
    let traits = [...a.traits];
    if (res.replaced) traits = traits.map((t) => (t === res.replaced!.from ? res.replaced!.to : t));
    if (res.added && !traits.includes(res.added)) traits.push(res.added);
    while (traits.length > 12) {
      const drop = traits.findIndex((t) => traitPolarity(t) === 0);
      traits.splice(drop >= 0 ? drop : 0, 1);
    }
    this.updateAgent(a, { traits });
    this.mutationsDone++;
    if (res.replaced) this.log(a, 'mutation', `마음이 변했다: 「${res.replaced.from}」 → 「${res.replaced.to}」`);
    if (res.added) this.log(a, 'mutation', `새로 생긴 마음: 「${res.added}」`);
    this.emote(a, '💭');
    const why = reason.kind === 'context' ? `「${reason.to}」 세상` : reason.kind === 'impact' ? reason.byName : reason.note;
    this.pushFeed({
      kind: 'event', speakerId: a.id,
      text: reason.kind === 'drift' ? `🌱 ${a.name}, ${why} 마음이 조금 변했다 — 「${res.replaced?.to ?? res.added}」` : `🔄 ${a.name}의 마음이 ${why} 앞에서 조금 달라졌다 — 「${res.replaced?.to ?? res.added}」`,
    });
    // the storyteller may phrase the new trait more naturally (kept only if it still reads like a trait)
    for (const t of [res.replaced?.to, res.added].filter(Boolean) as string[]) {
      if (this.simSpeed < 3) World.storyHook?.({
        world: this, kind: 'mutation', speaker: a, draft: t, topic: `${res.replaced && t === res.replaced.to ? res.replaced.from : ''} | ${why}`, important: a.id === this.watchedId,
        apply: (text) => {
          const clean = text.replace(/[.。]$/, '').trim();
          if (!/다$/.test(clean) || clean.length > 45 || !a.traits.includes(t)) return;
          this.updateAgent(a, { traits: a.traits.map((x) => (x === t ? clean : x)) });
          this.log(a, 'mutation', `(이야기꾼) 「${t}」 → 「${clean}」`);
        },
      });
    }
  }

  // ───────────────────────── staged events (공연 · 축제) ─────────────────────────
  // People who go to a show really go: they stop chatting on the way, stand in a half circle facing
  // the stage, clap, cheer and tip — and stay until it ends.
  shows: { id: string; kind: 'busking' | 'festival'; placeId?: string; starId?: string; stage: { tx: number; ty: number }; until: number; social: boolean; crowd: string[] }[] = [];
  private showOf(a: Agent) {
    const id = a.ai.showId;
    if (!id) return undefined;
    const s = this.shows.find((x) => x.id === id && x.until > this.meta.minutes);
    if (!s) {
      a.ai.showId = undefined;
      a.ai.showSpot = undefined;
      a.ai.showArrived = false;
    }
    return s;
  }
  /** on the way to a show (or watching a performance): no new conversations */
  private showBusy(a: Agent) {
    const s = this.showOf(a);
    return !!s && (!a.ai.showArrived || !s.social);
  }
  private crowdSpot(s: (typeof this.shows)[number], i: number): { tx: number; ty: number } {
    if (s.social) {
      // festival: anywhere around the square
      const ang = i * 2.39996, r = 2 + (i % 4);
      return this.map.nearestWalkable(s.stage.tx + Math.round(Math.cos(ang) * r * 1.4), s.stage.ty + Math.round(Math.sin(ang) * r));
    }
    // performance: a half circle in front of (below) the performer, rows of seven
    const row = Math.floor(i / 7), col = i % 7;
    const ang = Math.PI * (0.12 + 0.76 * (col / 6));
    const r = 2 + row;
    return this.map.nearestWalkable(s.stage.tx + Math.round(Math.cos(ang) * r * 1.5), s.stage.ty + Math.max(1, Math.round(Math.sin(ang) * r)));
  }
  private joinShow(a: Agent, s: (typeof this.shows)[number], spot?: { tx: number; ty: number }) {
    if (a.ai.sleeping || this.showOf(a)) return;
    const c = this.convoOf(a);
    if (c) {
      c.members = c.members.filter((m) => m !== a.id);
      if (c.members.length < 2) this.endConvo(c);
    }
    this.releaseSeat(a);
    a.ai.meetWith = undefined;
    a.ai.working = false;
    a.ai.showId = s.id;
    a.ai.showArrived = false;
    a.ai.showSpot = spot ?? this.crowdSpot(s, s.crowd.length);
    if (a.id !== s.starId) s.crowd.push(a.id);
    a.ai.mode = 'goto';
    a.ai.targetPlaceId = undefined;
    a.ai.timer = 0;
    if (!this.pathTo(a, a.ai.showSpot.tx, a.ai.showSpot.ty)) a.ai.showArrived = true;
  }
  /** called first in decide(): keeps show-goers at their spot, facing the stage. true = handled */
  private showTick(a: Agent): boolean {
    const s = this.showOf(a);
    if (!s || !a.ai.showSpot) return false;
    const t = this.tileOf(a), spot = a.ai.showSpot;
    if (Math.abs(t.tx - spot.tx) + Math.abs(t.ty - spot.ty) > 1) {
      a.ai.mode = 'goto';
      if (this.pathTo(a, spot.tx, spot.ty)) return true;
    }
    a.ai.showArrived = true;
    this.setIdle(a, 3 + Math.random() * 4);
    const dx = s.stage.tx - t.tx, dy = s.stage.ty - t.ty;
    if (a.id !== s.starId) a.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    else a.facing = 'down';
    return true;
  }
  private endShow(id: string) {
    const s = this.shows.find((x) => x.id === id);
    if (!s) return;
    s.until = this.meta.minutes;
    for (const a of this.agents)
      if (a.ai.showId === id) {
        a.ai.showId = undefined;
        a.ai.showSpot = undefined;
        a.ai.showArrived = false;
        if (a.ai.mode === 'idle') a.ai.timer = Math.min(a.ai.timer, 1 + Math.random() * 3);
      }
    this.shows = this.shows.filter((x) => x.until > this.meta.minutes - 60);
  }
  private stageOf(p: Place) {
    return this.map.nearestWalkable(Math.floor(p.tx + p.tw / 2), Math.floor(p.ty + p.th / 2));
  }
  private stagePx(s: { stage: { tx: number; ty: number } }) {
    return { x: (s.stage.tx + 0.5) * TILE, y: (s.stage.ty + 0.5) * TILE };
  }
  /** passers-by within earshot may stop and watch */
  private drawCrowd(s: (typeof this.shows)[number], radiusTiles: number, chance: number) {
    const c = this.stagePx(s);
    for (const a of this.agents) {
      if (a.kind !== 'person' || a.ai.sleeping || a.ai.working || a.ai.showId || a.id === s.starId) continue;
      if (Math.hypot(a.x - c.x, a.y - c.y) > radiusTiles * TILE || Math.random() > chance) continue;
      this.joinShow(a, s);
      this.emote(a, '👀');
    }
  }

  private startBusking(star: Agent, p: Place) {
    const len = 40;
    const s = { id: uid('show'), kind: 'busking' as const, placeId: p.id, starId: star.id, stage: this.stageOf(p), until: this.meta.minutes + len, social: false, crowd: [] as string[] };
    this.shows.push(s);
    this.joinShow(star, s, s.stage);
    this.addThought(star, 'busking', '버스킹을 해서 뿌듯함', 12, 300);
    this.announce(`🎸 ${josa(star.name, '이/가')} ${p.name}에서 버스킹을 시작한다! 사람들이 하나둘 모여든다.`);
    this.say(star, pick(['안녕하세요, 노래 한 곡 들려 드릴게요!', '떨리지만… 시작해 볼게요!', '지나가는 길에 잠깐만 들어 주세요~']));
    const fans = this.awakePeople().filter((a) => a !== star && !a.ai.working && (this.feel(a.id, star.id) >= 25 || a.traits.some((t) => /(노래|음악|공연|기타|밴드)/.test(t) && traitPolarity(t) > 0) || Math.random() < 0.3));
    for (const a of fans) this.joinShow(a, s);
    const px = this.stagePx(s);
    this.effects.push({ kind: 'stage', x: px.x, y: px.y, born: this.simTime, life: len / MIN_PER_SEC });
    const SONG = ['♪ 오늘 하루도 수고했어요~', '♪ 이 거리에 노을이 지면~', '♫ 라라라~ 너에게로~', '♪ 별이 빛나는 밤에~', '♫ 우리 함께 걸어요~', '♪ 괜찮아, 다 잘 될 거야~'];
    const CHEER = ['와, 목소리 좋다!', '최고예요!', '앵콜! 앵콜!', '한 곡 더!', '소름 돋았어요…', '이 노래 뭐예요?'];
    for (let m = 3; m < len; m += 4)
      this.later(m, () => {
        if (!this.shows.includes(s) || s.until <= this.meta.minutes || !this.agents.includes(star) || star.ai.sleeping) return;
        const atStage = Math.hypot(star.x - px.x, star.y - px.y) < TILE * 2;
        if (!atStage) return;
        this.say(star, pick(SONG), { silentFeed: true });
        this.emote(star, '🎵');
        this.effects.push({ kind: 'notes', x: star.x, y: star.y - 20, born: this.simTime, life: 4 });
        for (const id of s.crowd) {
          const a = this.agent(id);
          if (!a || !a.ai.showArrived || a.ai.showId !== s.id) continue;
          const r = Math.random();
          if (r < 0.35) this.emote(a, pick(['👏', '🎶', '😍', '✨']));
          else if (r < 0.45) this.say(a, pick(CHEER), { silentFeed: true });
          else if (r < 0.52 && a.money > 5000) {
            const tip = pick([1000, 2000, 5000]);
            a.money -= tip;
            star.money += tip;
            this.emote(a, '💸');
          }
        }
        this.drawCrowd(s, 9, 0.25);
      });
    this.later(len, () => {
      if (!this.shows.includes(s)) return;
      const crowd = s.crowd.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.ai.showId === s.id && !!a.ai.showArrived);
      if (this.agents.includes(star)) {
        this.say(star, crowd.length ? pick(['들어 주셔서 정말 감사합니다!', '끝까지 들어 줘서 고마워요!', '다음에 또 올게요!']) : '(아무도 없었지만… 그래도 좋았어.)');
        this.emote(star, '🙇');
      }
      this.effects.push({ kind: 'confetti', x: px.x, y: px.y, born: this.simTime, life: 4 });
      for (const a of crowd) {
        this.addThought(a, 'busking-watch', `${givenName(star.name)}의 길거리 공연을 봄`, 7, 240);
        this.addFeel(a.id, star.id, 4);
        this.emote(a, '👏');
      }
      if (crowd.length >= 2) {
        this.log(star, 'diary', `${p.name}에서 노래했다. ${crowd.length}명이 끝까지 들어 줬다. 손이 아직도 떨린다.`);
        this.naturalRumor(`${givenName(star.name)}의 버스킹이 대박이었대!`, [star, p], crowd[0], 0.9, 'event', 22);
        this.announce(`🎸 ${givenName(star.name)}의 버스킹이 끝났다 — ${crowd.length}명이 끝까지 박수를 쳤다.`);
      } else this.log(star, 'diary', `${p.name}에서 노래했다. 듣는 사람은 거의 없었지만 그래도 노래했다.`);
      this.endShow(s.id);
    });
  }

  private startFestival(p: Place) {
    const len = 90;
    const s = { id: uid('show'), kind: 'festival' as const, placeId: p.id, stage: this.stageOf(p), until: this.meta.minutes + len, social: true, crowd: [] as string[] };
    this.shows.push(s);
    const px = this.stagePx(s);
    this.effects.push({ kind: 'confetti', x: px.x, y: px.y, born: this.simTime, life: 6 });
    this.effects.push({ kind: 'stage', x: px.x, y: px.y, born: this.simTime, life: len / MIN_PER_SEC });
    for (const a of this.awakePeople()) {
      this.addThought(a, 'festival', '동네 축제에 들뜸', 10, 360);
      if (!a.ai.working && Math.random() < 0.75) this.joinShow(a, s);
    }
    const LINES = ['축제다~!', '오늘은 다 같이 노는 날!', '저기 솜사탕 판다!', '이런 날이 제일 좋아요.', '사진 찍어요, 사진!', '불꽃놀이도 한대요!'];
    for (let m = 4; m < len; m += 6)
      this.later(m, () => {
        if (!this.shows.includes(s) || s.until <= this.meta.minutes) return;
        const here = s.crowd.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.ai.showId === s.id && !!a.ai.showArrived);
        const spot = here.length ? pick(here) : undefined;
        this.effects.push({ kind: Math.random() < 0.5 ? 'confetti' : 'notes', x: spot ? spot.x : px.x, y: (spot ? spot.y : px.y) - 10, born: this.simTime, life: 4 });
        for (const a of here) {
          const r = Math.random();
          if (r < 0.25) this.emote(a, pick(['🎉', '🎶', '😆', '🍡', '🎈']));
          else if (r < 0.35) this.say(a, pick(LINES), { silentFeed: true });
        }
        this.drawCrowd(s, 12, 0.3);
      });
    this.later(len, () => {
      const here = s.crowd.map((id) => this.agent(id)).filter((a): a is Agent => !!a && a.ai.showId === s.id);
      for (let i = 0; i + 1 < here.length; i += 2) this.addFeel(here[i].id, here[i + 1].id, 3);
      if (here[0]) this.log(here[0], 'diary', `${p.name} 축제에 갔다. 다들 웃고 있었다. 이 동네가 조금 더 좋아졌다.`);
      this.effects.push({ kind: 'confetti', x: px.x, y: px.y, born: this.simTime, life: 6 });
      this.announce(`🎉 ${p.name} 축제가 끝났다. ${here.length}명이 함께했다.`);
      this.endShow(s.id);
    });
  }

  // ───────────────────────── world events (사건) ─────────────────────────
  private awakePeople() {
    return this.agents.filter((a) => a.kind === 'person' && !a.ai.sleeping);
  }
  private skyCenter() {
    const v = this.viewRect;
    return v ? { x: (v.x0 + v.x1) / 2, y: v.y0 + (v.y1 - v.y0) * 0.35 } : { x: (this.map.w * TILE) / 2, y: (this.map.h * TILE) / 3 };
  }
  private later(minutes: number, run: () => void) {
    this.pending.push({ at: this.meta.minutes + minutes, run });
  }
  private announce(text: string) {
    this.pushFeed({ kind: 'event', text });
  }
  private outdoorPlace(): Place | undefined {
    return this.places.find((p) => p.style === 'plaza') ?? this.places.find((p) => p.style === 'park');
  }
  private musicFan(): Agent | undefined {
    const fans = this.awakePeople().filter((a) => a.traits.some((t) => /(노래|기타|음악|가수|밴드|피아노|버스킹|춤|댄스|랩)/.test(t)) || /(가수|음악|밴드|아이돌|음유시인)/.test(a.job));
    return fans.length ? pick(fans) : pick(this.awakePeople());
  }

  /** Natural events roll about once a game day (more on weekends); follow-ups run on schedule. */
  private tickEvents(dm: number) {
    if (this.pending.length) {
      const now = this.meta.minutes;
      const due = this.pending.filter((p) => p.at <= now);
      if (due.length) {
        this.pending = this.pending.filter((p) => p.at > now);
        for (const d of due) d.run();
      }
    }
    if (this.blackoutUntil && this.meta.minutes >= this.blackoutUntil) {
      this.blackoutUntil = 0;
      this.announce('💡 전기가 다시 들어왔다. 여기저기서 환호성이 들린다.');
      for (const a of this.awakePeople()) if (this.hasThought(a, 'blackout')) this.addThought(a, 'blackout', '정전이 끝나서 안심함', 3, 90);
    }
    this.eventAcc += dm;
    if (this.eventAcc < 60) return;
    this.eventAcc = 0;
    if (this.meta.minutes - this.lastEventAt < 360 || this.awakePeople().length < 2) return;
    const weekend = weekdayOf(this.meta.minutes).weekend;
    if (Math.random() > (weekend ? 1 / 14 : 1 / 22)) return;
    const night = this.isNight() || (this.meta.minutes % 1440) / 60 >= 20;
    const options: WorldEventKind[] = night
      ? ['METEOR', 'BLACKOUT', 'LOST_TREASURE']
      : ['BIRTHDAY', 'LOST_TREASURE', 'LOTTERY', 'BUSKING', ...(this.meta.weather === 'clear' ? (['RAINBOW'] as const) : []), ...(weekend ? (['FESTIVAL', 'BUSKING'] as const) : [])];
    const kind = pick(options);
    if (kind === 'LOTTERY' && Math.random() < 0.6) return; // lotteries are rare
    this.happen(kind);
  }

  /** Trigger a world event (player command or natural). */
  happen(kind: WorldEventKind, target?: Agent | Place): { ok: boolean; message: string } {
    const r = this.happenInner(kind, target);
    if (r.ok) this.eventLog.push({ kind, t: this.meta.minutes, target: target?.id });
    if (this.eventLog.length > 60) this.eventLog.shift();
    return r;
  }
  private happenInner(kind: WorldEventKind, target?: Agent | Place): { ok: boolean; message: string } {
    const people = this.awakePeople();
    const person = target && target.kind === 'person' ? target : undefined;
    this.lastEventAt = this.meta.minutes;
    switch (kind) {
      case 'FESTIVAL': {
        const p = target && target.kind === 'place' ? target : this.outdoorPlace() ?? this.places.find((x) => x.style !== 'home');
        if (!p) return { ok: false, message: '축제를 열 장소가 없어요. 광장이나 공원을 먼저 지어 주세요.' };
        this.announce(`🎉 ${p.name}에서 동네 축제가 열렸다! 음악 소리와 맛있는 냄새가 퍼진다.`);
        this.log(p, 'event', '동네 축제가 열렸다. 오늘만큼은 모두의 무대다.');
        this.startFestival(p);
        if (people[0]) this.naturalRumor(`${p.name}에서 축제가 열렸대!`, [p], people[0], 0.8, 'event', 20);
        return { ok: true, message: `🎉 ${p.name}에서 축제가 시작됐어요!` };
      }
      case 'RAINBOW': {
        if (Renderer_dark(this.meta.minutes)) return { ok: false, message: '무지개는 해가 떠 있을 때만 보여요.' };
        const c = this.skyCenter();
        this.effects.push({ kind: 'rainbow', x: c.x, y: c.y, born: this.simTime, life: 70 });
        if (this.meta.weather !== 'clear') this.meta.weather = 'clear';
        this.announce('🌈 하늘에 커다란 무지개가 떴다. 다들 고개를 든다.');
        for (const a of people) {
          if (!this.map.isOutdoor(this.tileOf(a).tx, this.tileOf(a).ty) && Math.random() < 0.5) continue;
          this.addThought(a, 'rainbow', '무지개를 봄', 6, 240);
          this.emote(a, '🌈');
          if (Math.random() < 0.25) this.say(a, pick(['우와, 무지개다!', '(오늘은 좋은 일이 생기려나.)', '사진 찍어야지!', '무지개 끝에 보물이 있대요.']), { silentFeed: true, thought: false });
        }
        return { ok: true, message: '🌈 무지개가 떴어요.' };
      }
      case 'BLACKOUT': {
        this.blackoutUntil = this.meta.minutes + 90;
        this.announce('🔌 동네에 정전이 났다! 가로등도 간판도 꺼졌다.');
        for (const a of this.agents) {
          if (a.ai.sleeping) continue;
          this.emote(a, a.kind === 'animal' ? '❗' : '😮');
          if (a.kind !== 'person') continue;
          const brave = a.persona.sensitive < -0.2 || a.persona.cheer > 0.4 || a.traits.some((t) => /(어둠|밤|별)/.test(t) && !DISLIKE_RE.test(t));
          this.addThought(a, 'blackout', brave ? '정전 덕분에 별이 잘 보임' : '갑자기 정전돼서 당황함', brave ? 4 : -5, 120);
          if (Math.random() < 0.3) this.say(a, brave ? pick(['와, 별이 이렇게 많았나?', '가끔은 이런 것도 좋네요.']) : pick(['어? 불이 나갔어!', '아무것도 안 보여요!', '휴대폰 손전등 어디 있지?']), { silentFeed: true });
        }
        if (people[0]) this.naturalRumor('동네에 정전이 났었대!', [], people[0], -0.2, 'event', 14);
        return { ok: true, message: '🔌 정전이 났어요. 약 1시간 반 뒤에 복구돼요.' };
      }
      case 'BUSKING': {
        const star = person ?? this.musicFan();
        const p = this.outdoorPlace() ?? this.places.find((x) => x.style !== 'home');
        if (!star || !p) return { ok: false, message: '버스킹할 윌이나 장소(광장·공원)가 없어요.' };
        if (this.shows.some((s) => s.starId === star.id && s.until > this.meta.minutes)) return { ok: true, message: `🎸 ${josa(star.name, '은/는')} 지금 공연 중이에요 — 보러 가요!` };
        this.startBusking(star, p);
        return { ok: true, message: `🎸 ${star.name}의 버스킹이 시작됐어요.` };
      }
      case 'METEOR': {
        if (!Renderer_dark(this.meta.minutes)) return { ok: false, message: '유성우는 밤에만 볼 수 있어요 (저녁 8시 이후).' };
        const c = this.skyCenter();
        this.effects.push({ kind: 'meteor', x: c.x, y: c.y, born: this.simTime, life: 45 });
        this.announce('🌠 밤하늘에 유성우가 쏟아진다. 누군가는 소원을 빈다.');
        for (const a of people) {
          const dream = a.traits.map(extractDream).find(Boolean);
          this.addThought(a, 'meteor', '유성우를 보며 소원을 빎', 8, 300);
          this.emote(a, '🌠');
          if (Math.random() < 0.4) this.say(a, dream ? `(${dream}… 꼭 이루어지게 해 주세요.)` : pick(['(소원 빌어야지…!)', '(다들 행복하게 해 주세요.)', '(내일은 좋은 일이 있기를.)']), { thought: true, silentFeed: !dream });
        }
        return { ok: true, message: '🌠 유성우가 쏟아져요.' };
      }
      case 'BIRTHDAY': {
        const who = person ?? pick(people);
        if (!who) return { ok: false, message: '생일을 맞을 윌이 없어요.' };
        this.addThought(who, 'birthday', '생일 축하를 받음', 15, 720);
        this.effects.push({ kind: 'confetti', x: who.x, y: who.y - 10, born: this.simTime, life: 4 });
        this.emote(who, '🎂');
        this.announce(`🎂 오늘은 ${givenName(who.name)}의 생일이다!`);
        const wishedBy = this.wished.get(who.id) ?? new Set<string>();
        this.wished.set(who.id, wishedBy);
        let k = 0;
        this.nearbyReact(who, 7, (b) => {
          this.emote(b, pick(['🎉', '👏', '🥳']));
          // the first one or two say it out loud (the first always does); the rest clap
          if (k < 3 && (k === 0 || Math.random() < 0.6)) {
            k++;
            wishedBy.add(b.id);
            this.say(b, this.speaksCasually(b, who) ? `${this.callName(b, who)}, 생일 축하해!` : `${this.callName(b, who)}, 생일 축하해요!`, { to: who, silentFeed: k > 1 });
            this.addFeel(who.id, b.id, 3);
            this.addThought(b, `wished:${who.id}`, `${givenName(who.name)}의 생일을 축하해 줬다`, 3, 300);
          }
        });
        // friends and acquaintances come over to say it in person; with nobody close yet, the nearest neighbours do
        const others = this.agents.filter((b) => b.kind === 'person' && b !== who && !b.ai.sleeping && !wishedBy.has(b.id));
        let friends = others.filter((b) => this.feel(b.id, who.id) >= 10).sort((x, y) => this.feel(y.id, who.id) - this.feel(x.id, who.id)).slice(0, 4);
        if (!friends.length) friends = others.sort((x, y) => Math.hypot(x.x - who.x, x.y - who.y) - Math.hypot(y.x - who.x, y.y - who.y)).slice(0, 2);
        for (const b of friends) wishedBy.add(b.id);
        friends.forEach((b, i) =>
          this.later(4 + i * 12, () => {
            if (b.ai.sleeping || !this.agents.includes(who) || who.ai.sleeping) return;
            // walk over to say it in person
            if (Math.hypot(b.x - who.x, b.y - who.y) > 3 * TILE) this.meet(b, who);
          }),
        );
        friends.forEach((b, i) =>
          this.later(14 + i * 12, () => {
            if (b.ai.sleeping || !this.agents.includes(who)) return;
            this.effects.push({ kind: 'confetti', x: who.x, y: who.y - 10, born: this.simTime, life: 3 });
            this.say(b, this.speaksCasually(b, who) ? `${this.callName(b, who)}, 생일 축하해! 🎉` : `${this.callName(b, who)}, 생일 축하드려요!`, { to: who });
            this.addFeel(who.id, b.id, 5);
            this.addFeel(b.id, who.id, 2);
            this.emote(who, '💖');
          }),
        );
        this.log(who, 'diary', friends.length ? `생일이었다. ${friends.map((f) => givenName(f.name)).join(', ')}에게 축하를 받았다. 혼자가 아니었다.` : '생일이었다. 조용히 케이크 한 조각을 먹었다.');
        if (!friends.length) this.addThought(who, 'birthday', '조용히 혼자 보낸 생일', 2, 720);
        this.naturalRumor(`오늘이 ${givenName(who.name)} 생일이래!`, [who], who, 0.7, 'bond', 16, true);
        return { ok: true, message: `🎂 ${who.name}의 생일이에요${friends.length ? ` — 친구 ${friends.length}명이 축하하러 와요.` : '.'}` };
      }
      case 'LOTTERY': {
        const who = person ?? pick(people);
        if (!who) return { ok: false, message: '복권을 산 윌이 없어요.' };
        const prize = pick([50000, 300000, 1000000, 5000000]);
        who.money += prize;
        this.addThought(who, 'lottery', '복권에 당첨됨!', prize >= 1000000 ? 20 : 10, 720);
        this.emote(who, '💰');
        this.say(who, prize >= 1000000 ? pick(['에엥?! 당첨이라고?!', '이거 꿈 아니죠?!', '엄마!! 나 당첨됐어!!']) : pick(['오, 소소하게 당첨!', '치킨 값은 벌었다!']));
        this.announce(`🍀 ${josa(givenName(who.name), '이/가')} 복권에 당첨됐다! (${prize.toLocaleString()}원)`);
        this.nearbyReact(who, 6, (b) => {
          const envy = this.feel(b.id, who.id) < 0 || (b.persona.kind < -0.2 && Math.random() < 0.5);
          this.emote(b, envy ? '😒' : pick(['😮', '🎉', '👏']));
          if (Math.random() < 0.5) this.say(b, envy ? pick(['(…부럽다. 나는 왜 안 되지.)', '(좋겠다, 진짜.)']) : this.speaksCasually(b, who) ? pick(['우와, 대박! 한턱 쏴!', '진짜? 축하해!']) : pick(['우와, 축하해요!', '대박이에요! 한턱 쏘세요~']), envy ? { thought: true, silentFeed: true } : { to: who, silentFeed: true });
          if (envy) this.addThought(b, `envy:${who.id}`, `${givenName(who.name)}의 복권 당첨이 부럽다`, -2, 240);
        });
        this.log(who, 'diary', `복권에 당첨됐다. ${prize.toLocaleString()}원. 손이 떨려서 몇 번이나 다시 봤다.`);
        if (prize >= 300000)
          this.later(45, () => {
            const pals = this.agents.filter((b) => b.kind === 'person' && b !== who && this.feel(who.id, b.id) >= 45).slice(0, 3);
            for (const b of pals) {
              this.addThought(b, 'treat', `${givenName(who.name)}에게 한턱 얻어먹음`, 6, 240);
              this.addFeel(b.id, who.id, 5);
            }
            if (pals.length) this.log(who, 'event', `${pals.map((b) => givenName(b.name)).join(', ')}에게 한턱냈다.`);
          });
        this.naturalRumor(`${givenName(who.name)}${josa(givenName(who.name), '이/가').slice(givenName(who.name).length)} 복권에 당첨됐대!`, [who], who, 0.6, 'event', 26, true);
        return { ok: true, message: `🍀 ${who.name}이(가) ${prize.toLocaleString()}원에 당첨됐어요!` };
      }
      case 'LOST_TREASURE': {
        const who = person ?? pick(people.filter((a) => a.treasure && !this.hasThought(a, 'lost-treasure')));
        if (!who || !who.treasure) return { ok: false, message: '애착 물건을 가진 윌이 없어요.' };
        const item = who.treasure;
        this.addThought(who, 'lost-treasure', `${item}을(를) 잃어버림`, -14, 1440);
        this.emote(who, '😢');
        this.say(who, `(${item}… 어디 갔지? 분명 여기 있었는데…)`, { thought: true });
        this.log(who, 'diary', `${item}을(를) 잃어버렸다. 하루 종일 그 생각뿐이다.`);
        this.naturalRumor(`${givenName(who.name)}${josa(givenName(who.name), '이/가').slice(givenName(who.name).length)} 소중한 물건을 잃어버렸대`, [who], who, -0.4, 'struggle', 14, true);
        this.later(60 + Math.random() * 180, () => {
          if (!this.agents.includes(who) || !this.hasThought(who, 'lost-treasure')) return;
          const cands = this.agents.filter((b) => b.kind === 'person' && b !== who && !b.ai.sleeping);
          if (!cands.length) return;
          const finder = cands.sort((x, y) => Math.hypot(x.x - who.x, x.y - who.y) - Math.hypot(y.x - who.x, y.y - who.y))[Math.floor(Math.random() * Math.min(3, cands.length))];
          who.thoughts = who.thoughts.filter((t) => t.key !== 'lost-treasure');
          this.addThought(who, 'found-treasure', `${givenName(finder.name)}이(가) ${item}을(를) 찾아 줌`, 14, 600);
          this.addThought(finder, 'helped', '누군가의 소중한 물건을 찾아 줌', 8, 300);
          this.addFeel(who.id, finder.id, 15);
          this.addFeel(finder.id, who.id, 6);
          this.meet(finder, who);
          this.say(finder, `${this.callName(finder, who)}, 혹시 이거 ${this.speaksCasually(finder, who) ? '네 거야?' : '찾으시던 거예요?'}`, { to: who });
          this.later(8, () => this.say(who, this.speaksCasually(who, finder) ? `${this.callName(who, finder)}, 진짜 고마워! 이거 정말 소중한 거야.` : `${this.callName(who, finder)}, 정말 고마워요! 이거 정말 소중한 거예요.`, { to: finder }));
          this.announce(`🔎 ${josa(givenName(finder.name), '이/가')} ${givenName(who.name)}의 ${josa(item, '을/를')} 찾아 주었다.`);
          this.log(who, 'diary', `${givenName(finder.name)}이(가) ${item}을(를) 찾아 줬다. 이 은혜는 잊지 않을 거다.`);
          this.naturalRumor(`${givenName(finder.name)}이(가) ${givenName(who.name)}의 잃어버린 물건을 찾아 줬대`, [finder, who], finder, 0.8, 'care', 18);
        });
        return { ok: true, message: `😢 ${who.name}이(가) ${josa(item, '을/를')} 잃어버렸어요. 누군가 찾아 줄까요?` };
      }
    }
  }

  lightning(x: number, y: number) {
    this.effects.push({ kind: 'lightning', x, y, born: this.simTime, life: 0.7 });
    const near = this.grid.queryRadius(x, y, 140, this.tmp);
    for (const a of [...near]) {
      const d = Math.hypot(a.x - x, a.y - y);
      this.emote(a, '❗');
      if (d < 40) this.addThought(a, 'lightning', '번개에 맞을 뻔함', -18, 240);
      else this.addThought(a, 'lightning', '눈앞에 번개가 떨어져 혼비백산함', -10, 180);
      this.log(a, 'event', '바로 옆에 번개가 떨어졌다!');
      if (a.ai.mode === 'chat') {
        const c = this.convoOf(a);
        if (c) this.endConvo(c);
      }
      if (a.kind === 'person' && Math.random() < 0.6) this.say(a, pick(['으아악!', '깜짝이야!!', '하늘이 노했나?!']), { silentFeed: true });
      this.wander(a, 7);
    }
    const pid = this.map.placeIdAt(Math.floor(x / TILE), Math.floor(y / TILE));
    const p = this.place(pid ?? undefined);
    if (p) this.log(p, 'event', '번개를 맞았다!');
    const victim = near.find((a) => Math.hypot(a.x - x, a.y - y) < 40);
    const where = p?.name ?? (victim ? `${victim.name} 바로 옆` : '골목');
    if (near[0]) this.naturalRumor(`${where}에 마른하늘에 번개가 떨어졌대!`, p ? [p, ...near.slice(0, 2)] : near.slice(0, 2), near[0], 0, 'event', 18);
  }

  bless(a: Agent) {
    this.addThought(a, 'bless', '알 수 없는 따스한 기운을 느낌', 12, 180);
    this.emote(a, '✨');
    this.effects.push({ kind: 'sparkle', x: a.x, y: a.y - 20, born: this.simTime, life: 1.2 });
    this.log(a, 'diary', '갑자기 마음이 따뜻해졌다. 누군가 지켜봐 주는 것 같다.');
  }

  gift(a: Agent) {
    const like = a.traits.find((t) => LIKE_RE.test(t));
    const what = like ? like.replace(/(을|를)?\s*(정말|매우)?\s*(좋아한다|좋아하는|사랑한다|즐긴다).*$/, '').slice(0, 14) : '작은 선물';
    this.addThought(a, 'gift', `누군가 ${what} 선물을 두고 감`, 10, 240);
    this.emote(a, '🎁');
    this.say(a, '(어? 이게 뭐지… 나한테?)', { thought: true });
    this.log(a, 'diary', `누군가 ${what} 선물을 두고 갔다. 누굴까?`);
  }

  meet(a: Agent, b: Agent) {
    a.ai.meetWith = b.id;
    a.ai.meetForced = true;
    b.ai.meetWith = a.id;
    b.ai.meetForced = true;
    for (const m of [a, b]) {
      if (m.ai.mode === 'chat') {
        const c = this.convoOf(m);
        if (c) this.endConvo(c);
      }
      this.releaseSeat(m);
      m.ai.mode = 'goto';
      m.ai.targetPlaceId = undefined;
      m.ai.timer = 40;
      m.ai.nextThinkAt = this.simTime;
    }
  }

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
