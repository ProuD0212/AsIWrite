import type { Persona } from './traits';

// Core data model. Everything persisted is TEXT (see save.ts); derived data
// (appearance layers, future embeddings) is recomputed at runtime.

export type Facing = 'down' | 'up' | 'left' | 'right';
export type AgentKind = 'person' | 'animal';
export type Weather = 'clear' | 'rain' | 'snow' | 'storm';

export type HairShape = 'short' | 'bob' | 'long' | 'ponytail' | 'twintails' | 'messy' | 'bald';
export type Headgear = 'none' | 'beret' | 'crown' | 'hood' | 'catEars' | 'helmet' | 'starPin' | 'cap' | 'ribbon';
export type OutfitStyle = 'casual' | 'suit' | 'uniform' | 'cloak' | 'armor' | 'raincoat' | 'hoodie' | 'dress' | 'apron';
export type FaceAcc = 'none' | 'glasses' | 'sunglasses' | 'eyepatch' | 'blush' | 'beard';
export type Prop = 'none' | 'guitarCase' | 'greatsword' | 'backpack' | 'umbrella' | 'book' | 'staff' | 'briefcase';
export type Gait = 'bouncy' | 'normal' | 'slouch';
export type Species = 'cat' | 'dog' | 'bird' | 'creature';

/** The 6 procedural top-down layers (+ skin / species helpers). */
export interface AppearanceLayers {
  hairShape: HairShape;
  hairColor: string;
  headgear: Headgear;
  headgearColor: string;
  outfitStyle: OutfitStyle;
  outfitColor: string;
  faceAcc: FaceAcc;
  prop: Prop;
  propColor: string;
  bodyScale: number;
  gait: Gait;
  skinColor: string;
  species: Species;
  furColor: string;
  furPattern: 'solid' | 'tabby' | 'calico' | 'tuxedo';
}

export interface Thought {
  key: string; // dedupe key (same key refreshes instead of stacking)
  label: string;
  value: number;
  expiresAt: number; // game minutes
}

export interface LogEntry {
  t: number; // game minutes
  kind: 'diary' | 'event' | 'chat' | 'mutation' | 'system';
  text: string;
  withId?: string;
}

export type AgentMode = 'idle' | 'wander' | 'goto' | 'visit' | 'chat' | 'break';
export type BreakKind = 'sigh' | 'sadSong' | 'grumble';

export interface AgentAI {
  mode: AgentMode;
  path: { x: number; y: number }[];
  pathIndex: number;
  timer: number; // seconds left in current mode
  targetPlaceId?: string;
  partnerId?: string;
  breakKind?: BreakKind;
  nextThinkAt: number; // real seconds (sim clock)
  lastChatAt: Record<string, number>;
  meetWith?: string; // walking toward this agent to talk
  meetForced?: boolean; // ignore chat cooldown (MEET event / grumble)
  lastBreakAt?: number;
  working?: boolean; // current visit is a work shift
  lastMonologueAt?: number;
  shiftEarned?: number;
}

export interface Emote {
  icon: string;
  born: number; // sim seconds
  life: number;
}

export interface Bubble {
  text: string;
  born: number;
  life: number;
  thought?: boolean; // inner thought (cloud style)
}

export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  category: string; // [분류] free text, e.g. "사람", "길고양이"
  appearance: string; // free text
  traits: string[]; // ~10 sentence traits
  persona: Persona; // derived from traits at runtime (never saved)
  layers: AppearanceLayers;
  x: number;
  y: number;
  facing: Facing;
  speed: number; // px / sec
  moving: boolean;
  animPhase: number;
  money: number; // 원, deliberately simplified economy (income > spending)
  job: string; // free-text role, e.g. "바리스타" ('' = none)
  treasure: string; // 애착 물건, one cherished item ('' = none)
  jobId?: string; // workplace place id
  mood: number; // 0..100
  baseMood: number;
  thoughts: Thought[];
  ai: AgentAI;
  emote?: Emote;
  bubble?: Bubble;
  logs: LogEntry[];
}

export type PlaceStyle = 'cafe' | 'park' | 'karaoke' | 'store' | 'library' | 'home' | 'plaza' | 'office' | 'factory';

export interface Place {
  id: string;
  kind: 'place';
  name: string;
  category: string;
  appearance: string;
  traits: string[];
  style: PlaceStyle;
  // tile rect
  tx: number;
  ty: number;
  tw: number;
  th: number;
  door: { tx: number; ty: number };
  seats: { tx: number; ty: number }[];
  workSpots: { tx: number; ty: number }[];
  regulars: Record<string, number>; // agentId → visit count (단골)
  logs: LogEntry[];
}

export interface WorldMeta {
  context: string; // WorldContext free text, default "현대 한국 일상"
  weather: Weather;
  minutes: number; // game clock in minutes since day 1 00:00
}
