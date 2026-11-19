// The living simulation. Pure TS, no React. Rendering reads from it; the UI
// mutates it only through Game.dispatch(GameCommand).

import { parseAppearance, propFromText, speciesFromText } from './appearance';
import { parseSheet, serializeSheet, type CharacterSheet } from './sheet';
import { bestMatch, DISLIKE_RE, HybridMatcher, LIKE_RE, type EmbeddingSource, type SemanticMatcher } from './semantic';
import { SpatialGrid } from './SpatialGrid';
import { D, PLACE_SIZES, TILE, TileMap } from './TileMap';
import type { Agent, AgentKind, BreakKind, LogEntry, Place, PlaceStyle, Thought, Weather, WorldMeta } from './types';
import { clamp, hashString, pick, uid } from './util';
import {
  AGREE, ANIMAL_SOUNDS, ARGUE, COMFORT, GENERIC_DISLIKE, GENERIC_DREAM, GENERIC_LIKE, GREET, GREET_CLOSE, GREET_COLD, HAPPY, HUM, MUSE,
  SAD, SAD_SONG, SIGH, topicLine,
} from '../presets/banter';
import { allAnchorTexts, computePersona, copula, extractDream, extractObject, josa, suffix, toGeodeunyo, traitPolarity } from './traits';
import { DEFAULT_CHARACTER_SHEETS, DEFAULT_CONTEXT, DEFAULT_PLACES, type PlacePreset } from '../presets/defaultWorld';
import { randomAppearance, randomName, randomPlace, randomTraits, randomTreasure } from '../presets/traitPools';
import { guessSentiment, hearsay, makeTag, RumorMill, type Rumor, type TrendRow } from './rumors';
import { impactOf, mutateTraits, type MutationReason } from './mutation';
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

/** "김민수" → "민수"; short or non-Korean names stay as they are. */
export function givenName(full: string): string {
  const n = full.trim().replace(/\d+$/, '');
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
}

export interface FeedItem {
  t: number; // game minutes
  kind: 'line' | 'event' | 'care' | 'break' | 'system' | 'rumor' | 'monologue';
  speakerId?: string;
  speaker?: string;
  /** who the line was said to (conversation partner) */
  toId?: string;
  to?: string;
  /** inner thought, not said out loud */
  thought?: boolean;
  /** rewritten by the generative storyteller (Layer 2) */
  ai?: boolean;
  text: string;
}

/** A request to the generative storyteller (set by the app; null in Node tests). */
export interface StoryRequest {
  world: World;
  kind: 'line' | 'monologue' | 'groupName' | 'mutation';
  speaker: Agent;
  listener?: Agent;
  draft: string;
  topic?: string;
  important: boolean;
  apply: (text: string) => void;
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
}

export interface Effect {
  kind: 'lightning' | 'sparkle' | 'spawn';
  x: number;
  y: number;
  born: number;
  life: number;
}

export const STYLE_WORDS: Record<PlaceStyle, string> = {
  cafe: '카페 커피 라떼', karaoke: '노래방 노래 열창 음악', park: '공원 산책 벤치 나무', store: '편의점 간식 야식 과자',
  library: '도서관 책 독서 공부', home: '집 휴식', office: '사무실 회사 일 야근', plaza: '광장 분수',
  factory: '공장 기계 생산 일',
};

/** words that map a free-text job onto a workplace style */
export const JOB_WORDS: Partial<Record<PlaceStyle, string>> = {
  cafe: '바리스타 카페 점원 알바 커피',
  karaoke: '노래방 알바 점원 사장',
  store: '편의점 알바 알바생 점원 캐셔 계산원 마트 상점 가게',
  library: '사서 도서관 책',
  office: '회사원 직장인 사무직 샐러리맨 개발자 디자이너 프리랜서 기획자 회사',
  factory: '공장 생산직 노동자 기술자 정비공 엔지니어 대장장이 기계',
};
const DEFAULT_ROLE: Partial<Record<PlaceStyle, string>> = {
  cafe: '카페 점원', karaoke: '노래방 알바생', store: '편의점 알바생', library: '사서', office: '회사원', factory: '공장 기술자',
};
const WORK_LINES: Partial<Record<PlaceStyle, string[]>> = {
  cafe: ['주문하신 라떼 나왔습니다~', '어서 오세요!', '오늘의 원두는 에티오피아예요.'],
  karaoke: ['3번 방 시간 연장하실래요?', '어서 오세요, 몇 분이세요?'],
  store: ['어서오세요~', '봉투 필요하세요?', '2+1 행사 중이에요!'],
  library: ['도서관에서는 조용히 해 주세요.', '반납 기한이 지났어요~'],
  office: ['이 보고서 언제 끝나지…', '회의만 세 번째다…', '오늘은 칼퇴할 수 있을까?'],
  factory: ['오늘 할당량 거의 다 채웠다!', '기계 소리가 오늘따라 경쾌하네.', '안전제일!'],
};
/** price of leisure per visit (원). Always far below income. */
const PRICE: Record<PlaceStyle, number> = { cafe: 4500, karaoke: 8000, store: 3000, library: 0, home: 0, office: 0, park: 0, plaza: 0, factory: 0 };
/** 원 per game minute */
export const WAGE = 160;
export const ALLOWANCE = 60;
const SHIFT_LEN_H = 6;
export const STYLE_LABEL: Record<PlaceStyle, string> = {
  cafe: '카페', karaoke: '노래방', park: '공원', store: '상점', library: '도서관', home: '집', office: '사무실', plaza: '광장', factory: '공장',
};
const STYLE_EMOTE: Record<PlaceStyle, string> = {
  cafe: '☕', karaoke: '🎵', park: '🌳', store: '🛒', library: '📖', home: '🏠', office: '💻', plaza: '⛲', factory: '🔧',
};

type Listener = (item: FeedItem) => void;

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
  private placeDoorSide = new Map<string, 'top' | 'bottom'>();

  /** Shared embedding source (set once by the app; absent in Node tests → lexical only). */
  /** generative Layer-2 rewriting hook (see ai/storyteller.ts) */
  static storyHook: ((req: StoryRequest) => void) | null = null;
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
    const modern = !/(판타지|중세|마법|왕국|아포칼립스|좀비|사이버|네온|미래)/.test(w.meta.context);
    const styles: PlaceStyle[] = ['cafe', 'karaoke', 'park', 'store', 'library', 'factory', 'office', 'home', 'plaza'];
    for (let i = 0; i < nP; i++) {
      if (i < DEFAULT_PLACES.length && modern) w.addPlace(DEFAULT_PLACES[i]);
      else {
        const style = styles[i % styles.length];
        w.addPlace({ style, ...randomPlace(style, hashString(w.meta.context + i)) });
      }
    }
    w.map.scatterNature(11);
    for (let i = 0; i < nW; i++) {
      if (i < presetPeople.length && modern) w.addAgentFromSheet(presetPeople[i]);
      else w.spawnRandomized({ kind: 'person' });
    }
    for (let i = 0; i < nA; i++) {
      if (i < presetAnimals.length && modern) w.addAgentFromSheet(presetAnimals[i]);
      else w.spawnRandomized({ kind: 'animal', category: Math.random() < 0.75 ? '길고양이' : '강아지' });
    }
    w.rumors.rumors = []; // the founding moments shouldn't start as gossip
    return w;
  }

  /** Enlarge the world (no hard size limit). Re-indexes the spatial grid. */
  growMap(addW = 24, addH = 16) {
    this.map.grow(addW, addH, hashString('grow' + this.map.w));
    const g = new SpatialGrid<Agent>(this.map.w * TILE, 64);
    for (const a of this.agents) g.insert(a);
    this.grid = g;
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
      all.find((e) => n.length >= 2 && e.name.length >= 3 && n.includes(e.name.slice(1)))
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
    if (e.kind === 'animal') base.push({ cat: '고양이 길고양이', dog: '강아지 개', bird: '새', creature: '생물' }[e.layers.species]);
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
          ? [target.category, ...target.appearance.split(/[,，]/), { cat: '고양이', dog: '강아지 개', bird: '새', creature: '생물' }[target.layers.species]]
          : this.facets(target);
    for (const t of a.traits) if (DISLIKE_RE.test(t)) best = Math.max(best, bestMatch(this.matcher, t, facets));
    return best;
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

  stampPlace(p: Place, doorSide: 'top' | 'bottom'): Place {
    const { seats, door, workSpots } = this.map.buildPlace(p, doorSide, hashString(p.name));
    p.seats = seats;
    p.workSpots = workSpots;
    p.door = door;
    p.regulars ??= {};
    this.places.push(p);
    this.warmSemantics(p);
    // people whose job fits this new workplace start working here
    for (const a of this.agents) if (a.kind === 'person' && a.job && !a.jobId) this.assignJob(a, false);
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
  doorSideOf(p: Place) {
    return this.placeDoorSide.get(p.id) ?? 'bottom';
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
        const sp = speciesFromText(category + appearance) ?? 'creature';
        name = pick(sp === 'cat' ? ['나비', '모모', '두부', '보리', '호떡', '루루', '콩이'] : sp === 'dog' ? ['초코', '해피', '뭉치', '바둑이', '코코'] : ['삐약이', '짹짹이', '구름이'], (seed % 97) / 97);
        if (taken.has(name)) name += (seed % 9) + 1;
      } else name = randomName(this.meta.context, seed, taken);
    }
    const treasure = spec.treasure?.trim() || randomTreasure(this.meta.context, kind, seed);
    return this.addAgent({ name, category, appearance, traits, mood: spec.mood ?? 50 + (seed % 30), job: spec.job, treasure }, kind, x, y);
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
        if (ag.jobId === id) {
          ag.jobId = undefined;
          ag.ai.working = false;
          this.log(ag, 'event', `일하던 ${josa(p.name, '이/가')} 사라져 버렸다.`);
          this.addThought(ag, 'jobloss', '일터가 사라져 막막함', -10, 300);
        }
      }
      this.invalidateFavor(id);
      return true;
    }
    return false;
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
      this.setJob(a, undefined);
      if (a.kind === 'person' && a.job) this.assignJob(a, false);
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
    if (opts.silentFeed) return undefined;
    this.pushFeed({ kind: opts.kind ?? 'line', speakerId: a.id, speaker: a.name, text, thought: opts.thought, toId: opts.to?.id, to: opts.to?.name });
    return this.feed[this.feed.length - 1];
  }

  /** Ask the storyteller to restyle a line; swap it in when (if) it comes back. */
  private polish(kind: 'line' | 'monologue', a: Agent, fi: FeedItem | undefined, draft: string, listener: Agent | undefined, topic: string | undefined, important: boolean) {
    const hook = World.storyHook;
    if (!hook || !fi) return;
    hook({
      world: this, kind, speaker: a, listener, draft, topic, important,
      apply: (text) => {
        const wrapped = draft.startsWith('(') && !text.startsWith('(') ? `(${text})` : text;
        fi.text = wrapped;
        fi.ai = true;
        if (a.bubble && a.bubble.text === draft) {
          a.bubble.text = wrapped;
          const age = this.simTime - a.bubble.born;
          a.bubble.life = Math.max(a.bubble.life, age + Math.min(kind === 'monologue' ? 10 : 5, 1.5 + wrapped.length * 0.06));
        }
      },
    });
  }

  /**
   * How `speaker` addresses `target`. Lines are written in polite 해요체, so the
   * vocative stays polite too: close → "철수 씨", otherwise "박철수 씨"; animals → "치즈야".
   * (Casual speech between close friends is left to the Phase-2b LLM rewrite.)
   */
  callName(speaker: Agent, target: Agent): string {
    if (target.kind === 'animal') return josa(givenName(target.name), '아/야');
    return this.referName(speaker, target);
  }
  /** Name used inside a sentence: "철수 씨" (close) or "박철수 씨". */
  referName(speaker: Agent, target: Agent): string {
    if (target.kind === 'animal') return givenName(target.name);
    return this.feel(speaker.id, target.id) >= 45 ? `${givenName(target.name)} 씨` : `${target.name} 씨`;
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
    this.tickConvos();
    this.effects = this.effects.filter((e) => this.simTime - e.born < e.life);
    this.rumors.tick(dt * MIN_PER_SEC, this.meta.minutes);
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
    if (a.kind === 'person' && ai.mode !== 'break') {
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
          this.startConvo([a, b], false);
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
    const near = this.grid.queryRadius(a.x, a.y, 80, this.tmp);
    for (const b of near) {
      if (b === a) continue;
      if (a.kind === 'person' && b.kind === 'animal') this.meetAnimal(a, b);
      if (a.kind === 'person') {
        const av = this.aversion(a, b);
        if (av >= (b.kind === 'person' ? 0.7 : 0.5) && !this.hasThought(a, `fear:${b.id}`)) {
          this.addThought(a, `fear:${b.id}`, `${b.name} 때문에 깜짝 놀람`, -8, 90);
          this.emote(a, '❗');
          if (b.kind === 'animal') this.say(a, '으악, 저리 가!');
          else this.say(a, `(${b.name}… 왠지 좀 불편해.)`, { thought: true });
          this.log(a, 'diary', `${josa(b.name, '을/를')} 마주쳤다. 솔직히 좀 무서웠다.`, b.id);
          if (a.ai.mode !== 'chat') this.wander(a, 8);
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
    this.releaseSeat(a);
    a.ai.targetPlaceId = undefined;
    if (a.kind === 'animal') return this.decideAnimal(a);
    if (a.ai.working) this.endShiftIfOver(a);
    if (a.mood <= 20 && Math.random() < 0.4 && this.simTime - (a.ai.lastBreakAt ?? -999) > 90) return this.startBreak(a);
    const work = this.place(a.jobId);
    if (work && this.onShift(a) && Math.random() < 0.92) return this.goWork(a, work);

    // group hangout: members drift to their group's usual spot now and then
    const hang = this.factionsOf(a.id).map((f) => this.place(f.homePlaceId)).find(Boolean);
    if (hang && Math.random() < 0.18) return this.goVisit(a, hang);

    const raining = this.meta.weather === 'rain' || this.meta.weather === 'storm';
    // favourite place scoring
    let bestPlace: Place | undefined;
    let bestScore = -1;
    for (const p of this.places) {
      let s = this.favor(a, p) + Math.random() * 0.35;
      if (raining && p.style !== 'park' && p.style !== 'plaza') s += 0.25;
      if (this.aversion(a, p) > 0.5) s -= 0.6;
      if (s > bestScore) {
        bestScore = s;
        bestPlace = p;
      }
    }
    const wVisit = bestPlace ? 0.9 + bestScore * 2.5 : 0;
    const wWander = raining ? 0.4 : 1;
    const wIdle = 0.5;
    const wSocial = (a.mood >= 80 ? 1.6 : a.mood <= 30 ? 0.2 : 0.5) * (1 + a.persona.social * 0.6);
    const total = wVisit + wWander + wIdle + wSocial;
    let r = Math.random() * total;
    if ((r -= wVisit) < 0 && bestPlace) return this.goVisit(a, bestPlace);
    if ((r -= wWander) < 0) return this.wander(a, Math.round(10 + a.persona.curious * 5));
    if ((r -= wIdle) < 0) {
      this.setIdle(a, 2 + Math.random() * 5);
      return;
    }
    const friend = this.bestFriend(a);
    if (friend && this.canChat(a, friend)) {
      a.ai.meetWith = friend.id;
      a.ai.meetForced = false;
      a.ai.mode = 'goto';
      a.ai.timer = 30;
      const ft = this.tileOf(friend);
      this.pathTo(a, ft.tx, ft.ty);
      return;
    }
    this.wander(a, 10);
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

  private goVisit(a: Agent, p: Place) {
    a.ai.working = false;
    let seat = p.seats.find((s) => !this.seatTaken.has(`${s.tx},${s.ty}`));
    if (!seat) seat = this.map.randomWalkable(Math.random, { tx: p.door.tx, ty: p.door.ty + (this.doorSideOf(p) === 'bottom' ? -2 : 2), r: 1 });
    this.seatTaken.set(`${seat.tx},${seat.ty}`, a.id);
    a.ai.mode = 'goto';
    a.ai.targetPlaceId = p.id;
    a.ai.timer = 0;
    if (!this.pathTo(a, seat.tx, seat.ty)) this.wander(a, 6);
  }

  private enterVisit(a: Agent, p: Place) {
    a.ai.mode = 'visit';
    a.ai.timer = 14 + Math.random() * 22;
    a.facing = this.doorSideOf(p) === 'bottom' ? 'up' : 'down';
    if (a.ai.working) return this.startWork(a, p);
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
  }

  private visitTick(a: Agent) {
    const p = this.place(a.ai.targetPlaceId);
    if (!p || Math.random() > 0.08) return;
    if (a.ai.working) {
      const lines = WORK_LINES[p.style];
      if (lines && Math.random() < 0.5) this.say(a, pick(lines), { silentFeed: Math.random() < 0.7 });
      else this.emote(a, STYLE_EMOTE[p.style]);
      return;
    }
    if (Math.random() < 0.25) return this.innerMonologue(a);
    if (Math.random() < 0.04 && this.favor(a, p) >= 0.4 && a.kind === 'person' && this.simTime - (a.ai.lastMonologueAt ?? -1e9) > 240) {
      a.ai.lastMonologueAt = this.simTime;
      const text = this.composeMonologue(a);
      const fi = this.say(a, `(${text})`, { thought: true, kind: 'monologue' });
      this.polish('monologue', a, fi, `(${text})`, undefined, undefined, a.id === this.watchedId);
      return;
    }
    if (p.style === 'karaoke') {
      this.emote(a, '🎵');
      this.say(a, a.mood > 40 ? pick(HUM) : pick(SAD_SONG), { silentFeed: Math.random() < 0.6 });
    } else this.emote(a, STYLE_EMOTE[p.style]);
  }

  // ───────────────────────── work ─────────────────────────
  /** Map free-text job → best workplace (or a random open one if allowed). */
  assignJob(a: Agent, allowRandom: boolean) {
    const workplaces = this.places.filter((p) => JOB_WORDS[p.style] && p.workSpots.length > 0);
    const workersAt = (p: Place) => this.agents.filter((x) => x.jobId === p.id).length;
    const open = workplaces.filter((p) => workersAt(p) < p.workSpots.length);
    if (a.job) {
      if (/(학생|은퇴|백수|무직|여행자|방랑|퇴직|주부)/.test(a.job)) return;
      let best: Place | undefined;
      let bs = 0.18;
      for (const p of open) {
        const s = Math.max(this.matcher.similarity(a.job, JOB_WORDS[p.style]!), this.matcher.similarity(a.job, p.name));
        if (s > bs) {
          bs = s;
          best = p;
        }
      }
      if (best) this.setJob(a, best);
      return;
    }
    if (allowRandom && open.length && Math.random() < 0.65) {
      const p = pick(open);
      a.job = DEFAULT_ROLE[p.style] ?? '직원';
      this.setJob(a, p);
    }
  }

  setJob(a: Agent, p: Place | undefined) {
    const prev = this.place(a.jobId);
    a.jobId = p?.id;
    if (p) {
      if (!a.job) a.job = DEFAULT_ROLE[p.style] ?? '직원';
      if (prev !== p) {
        this.log(a, 'event', `${p.name}에서 ${josa(a.job, '으로/로')} 일하게 되었다.`, p.id);
        this.log(p, 'event', `${josa(a.name, '이/가')} 이곳에서 일하기 시작했다.`, a.id);
      }
    } else if (prev) this.log(a, 'event', `${prev.name} 일을 그만두었다.`, prev.id);
  }

  /** Each worker has a 6h shift; start hour spread by id so the town never empties. */
  shiftStart(a: Agent) {
    return [8, 10, 13, 15][hashString(a.id) % 4];
  }
  onShift(a: Agent) {
    const h = (this.meta.minutes % 1440) / 60;
    const s = this.shiftStart(a);
    return h >= s && h < s + SHIFT_LEN_H;
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
      const f = Math.max(this.favor(a, p), this.matcher.similarity(a.job, JOB_WORDS[p.style] ?? ''));
      if (f >= 0.4 || a.persona.energy > 0.3) this.addThought(a, 'work', '일하는 게 꽤 즐겁다', 4, 240);
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
    if (top && r < 0.4) text = top.value >= 0 ? `(${top.label}… 좋다.)` : `(${top.label}… 하아.)`;
    else {
      const t = pick(a.traits.length ? a.traits : ['오늘은 무슨 일이 있을까']);
      const obj = extractObject(t);
      const dream = extractDream(t);
      if (a.treasure && Math.random() < 0.25) text = pick([`(${a.treasure}… 오늘도 함께야.)`, `(${josa(a.treasure, '을/를')} 보면 마음이 놓여.)`, `(${a.treasure}, 잃어버리면 안 돼.)`]);
      else if (dream) text = `(언젠가는 꼭… ${dream}.)`;
      else if (obj && traitPolarity(t) > 0) text = pick([`(${obj} 생각나네…)`, `(아, ${obj}…)`, `(오늘은 ${obj}${josa(obj, '이랑/랑').slice(obj.length)} 함께하고 싶다.)`]);
      else if (a.money < 15000) text = '(이번 달 좀 빠듯한데…)';
      else if (a.mood < 35) text = pick(['(다들 행복해 보이네…)', '(나만 이런 걸까.)', '(누가 말 좀 걸어줬으면.)']);
      else if (a.mood > 75) text = pick(['(오늘 기분 최고야!)', '(세상이 반짝반짝해 보여.)']);
    }
    if (text) this.say(a, text, { thought: true, silentFeed: true });
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
      if (ms.length < 2) {
        this.endConvo(c);
        continue;
      }
      if (this.simTime < c.nextAt) continue;
      const choices = ms.filter((m) => m.id !== c.lastSpeaker);
      const speaker = pick(choices.length ? choices : ms);
      const others = ms.filter((m) => m !== speaker);
      const listener = pick(others);
      const line = this.lineFor(c, speaker, listener) as { text: string; icon?: string; long?: boolean; named?: boolean };
      const { text, icon } = line;
      // address the listener by name now and then so it's clear who is talking to whom
      const vocChance = c.lines === 0 ? 0.75 : c.members.length > 2 ? 0.6 : 0.3;
      const spoken = !line.long && !text.startsWith('(') && !line.named && Math.random() < vocChance ? `${this.callName(speaker, listener)}, ${text}` : text;
      const fi = this.say(speaker, spoken, { kind: line.long ? 'monologue' : 'line', to: listener });
      // Layer 2: long talks always, the watched Will's talks often, the rest now and then
      const watched = !!this.watchedId && (speaker.id === this.watchedId || listener.id === this.watchedId);
      const chance = line.long ? 1 : c.lines === 0 || c.argue ? 0 : watched ? 0.8 : 0.2;
      if (Math.random() < chance) this.polish(line.long ? 'monologue' : 'line', speaker, fi, spoken, listener, c.topic, line.long || watched);
      if (icon) this.emote(speaker, icon);
      c.lastSpeaker = speaker.id;
      c.lines++;
      // a calmer pace so lines can actually be read (and slower game speeds stretch it further)
      c.nextAt = this.simTime + 3.4 + Math.random() * 1.8;
      if (c.lines >= c.maxLines) this.endConvo(c);
    }
  }

  private lineFor(c: Conversation, s: Agent, l: Agent): { text: string; icon?: string } {
    const rel = this.relation(s.id, l.id);
    if (c.argue) return { text: pick(ARGUE), icon: '💢' };
    if (c.lines === 0) {
      const mine = this.feel(s.id, l.id);
      if (mine >= 40) return { text: pick(GREET_CLOSE), icon: '❤️' };
      if (mine <= -30) return { text: pick(GREET_COLD), icon: '💭' };
      return { text: pick(GREET), icon: Math.random() < 0.4 ? '👋' : undefined };
    }
    const caring = s.persona.kind > 0.3 || s.traits.some((t) => /(우울해 보이|위로|웃게|정이 많)/.test(t));
    if (l.mood <= 30 && (caring || s.mood >= 70) && Math.random() < 0.55) {
      if (this.addThought(l, `comfort:${s.id}`, `${josa(s.name, '이/가')} 위로해 줌`, 8, 180)) {
        this.addFeel(l.id, s.id, 6); // the comforted one remembers it
        this.log(l, 'diary', `${josa(s.name, '이/가')} 내 얘기를 들어줬다. 조금 힘이 났다.`, s.id);
        rel.memories.push({ t: this.meta.minutes, text: `${josa(s.name, '이/가')} 우울해하던 ${josa(l.name, '을/를')} 위로했다.` });
      }
      return { text: pick(COMFORT), icon: '❤️' };
    }
    if (s.mood <= 25 && Math.random() < 0.5) return { text: pick(SAD), icon: '💧' };
    // agreeing with the previous speaker when the topic is shared
    if (c.topicSim >= 0.45 && c.lines === 2 && Math.random() < 0.6) return { text: pick(AGREE), icon: '❤️' };
    // gossip: pass on a rumor the listener hasn't heard
    if (c.lines >= 1 && Math.random() < 0.22) {
      const r = this.rumors.pickToTell(s.id, l.id);
      if (r) {
        const aboutListener = r.about.includes(l.id);
        const text = aboutListener ? `${this.callName(s, l)}, 혹시 알아요? 요즘 이런 얘기가 돌던데… "${r.text}"` : pick([`그거 들었어요? ${r.text}.`, `있잖아요, ${r.text}.`, `소문 들었어요? ${r.text}!`]);
        this.hearRumor(l, r, s);
        return { text, icon: '💬', named: aboutListener } as { text: string; icon?: string };
      }
    }
    // a rare long-form heart-to-heart
    if (!c.monologued && this.simTime - (s.ai.lastMonologueAt ?? -1e9) > 240 && c.members.length === 2 && c.lines >= 2 && (this.feel(s.id, l.id) >= 45 || (s.mood <= 28 && l.persona.kind > 0.2)) && Math.random() < 0.2) {
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
      return { text, icon: '💭', long: true } as { text: string; icon?: string };
    }
    if (s.treasure && c.lines >= 2 && this.feel(s.id, l.id) >= 20 && Math.random() < 0.12) {
      return { text: pick([`이거요? ${copula(s.treasure).replace(/이다$/, '이에요').replace(/다$/, '예요')}. 저한테는 보물이에요.`, `제 ${josa(s.treasure, '은/는')} 절대 못 버려요.`, `${s.treasure} 얘기 해 드릴까요? 사연이 좀 있어요.`]), icon: '💭' };
    }
    const topical = Math.random() < 0.75 ? this.topicalLine(s, c.topic) : null;
    if (topical) {
      const icon = /노래|♪|음악|기타/.test(topical + c.topic) ? '🎵' : this.feel(s.id, l.id) >= 50 ? '❤️' : Math.random() < 0.3 ? '💬' : undefined;
      return { text: topical, icon };
    }
    if (s.mood >= 60) return { text: pick(HAPPY), icon: Math.random() < 0.4 ? '😊' : undefined };
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
    if (curated && Math.random() < 0.6) return curated;
    const obj = extractObject(src);
    if (obj) return traitPolarity(src) < 0 ? pick(GENERIC_DISLIKE)(obj) : pick(GENERIC_LIKE)(obj);
    const dream = extractDream(src);
    if (dream) return pick(GENERIC_DREAM)(dream);
    if (/다$/.test(src) && src.length <= 28 && Math.random() < 0.5) return pick(MUSE)(src);
    return curated;
  }

  private endConvo(c: Conversation) {
    this.convos = this.convos.filter((x) => x !== c);
    const ms = c.members.map((id) => this.agent(id)).filter(Boolean) as Agent[];
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
        const warm = (x: Agent) => 3 + Math.random() * 4 + c.topicSim * 8 + (x.mood - 50) / 25 + x.persona.social * 1.5;
        const hurt = (x: Agent) => -(c.initiator === x.id ? 3 + Math.random() * 3 : 7 + Math.random() * 6 + Math.max(0, x.persona.sensitive) * 4);
        this.addFeel(a.id, b.id, c.argue ? hurt(a) : warm(a));
        this.addFeel(b.id, a.id, c.argue ? hurt(b) : warm(b));
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
    for (const m of ms) {
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
    World.storyHook?.({
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
  /** Witnesses = people near `origin` (plus subjects). */
  private naturalRumor(text: string, about: (Agent | Place)[], origin: Agent, sentiment: number, kind: Rumor['kind'], heat?: number) {
    const near = this.grid.queryRadius(origin.x, origin.y, 160, this.tmp).filter((a) => a.kind === 'person').map((a) => a.id);
    const knownBy = [...new Set([...near, ...about.filter((e) => e.kind === 'person').map((e) => e.id)])];
    const r = this.rumors.add({
      text: hearsay(text), tag: makeTag(text, about.filter((e) => e.kind !== 'place' || about.length === 1).map((e) => e.name).slice(0, 2)), about: about.map((e) => e.id),
      sentiment, knownBy, origin: 'natural', born: this.meta.minutes, kind, heat,
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
      if (theirLike) options.push({ kind: 'drift', source: 'friend', text: `요즘 ${this.referName(a, friend)} 영향으로 ${theirLike}에 관심이 생겼다`, note: `${friend.name}의 영향` });
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
      World.storyHook?.({
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
