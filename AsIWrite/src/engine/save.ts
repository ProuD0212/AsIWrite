// Text-only save format. No vectors, no derived render data: appearance
// layers (and Phase-2 embeddings) are recomputed from the text on load.

import type { Rumor } from './rumors';
import type { Faction } from './factions';
import { PLACE_SIZES } from './TileMap';
import type { LogEntry, Place, PlaceStyle, Thought, Weather } from './types';
import { STYLE_LABEL, World, type FeedItem, type Relation } from './World';

export interface SaveFile {
  format: 'asiwrite-save';
  version: 1;
  savedAt: string;
  meta: { context: string; weather: Weather; minutes: number };
  /** tiles: outdoor ground/decoration as run-length text (player-drawn roads etc.); rows/cols: the main crossroads */
  map?: { w: number; h: number; roads: boolean; rows?: [number, number]; cols?: [number, number]; tiles?: { ground: string; deco: string } };
  places: { name: string; style: PlaceStyle; appearance: string; traits: string[]; tx: number; ty: number; doorSide: 'top' | 'bottom'; logs: LogEntry[]; id: string; regulars?: Record<string, number> }[];
  agents: { id: string; sheet: string; x: number; y: number; mood: number; money?: number; jobId?: string; homeId?: string; workPin?: string; needs?: { social: number; fun: number; food: number; rest: number }; thoughts: Thought[]; logs: LogEntry[] }[];
  relations: Relation[];
  feed: FeedItem[];
  rumors?: Rumor[];
  factions?: Faction[];
  /** an ongoing blackout (game minute it ends) — follow-up scenes of other events are not saved */
  blackoutUntil?: number;
}

export function serializeWorld(w: World): SaveFile {
  return {
    format: 'asiwrite-save',
    version: 1,
    savedAt: new Date().toISOString(),
    meta: { ...w.meta },
    map: { w: w.map.w, h: w.map.h, roads: w.map.roads, rows: w.map.roadRows, cols: w.map.roadCols, tiles: w.map.encodeTiles() },
    places: w.places.map((p) => ({
      id: p.id, name: p.name, style: p.style, appearance: p.appearance, traits: p.traits, tx: p.tx, ty: p.ty, doorSide: w.doorSideOf(p), logs: p.logs, regulars: p.regulars,
    })),
    agents: w.agents.map((a) => ({
      id: a.id, sheet: w.sheetOf(a), x: Math.round(a.x), y: Math.round(a.y), mood: Math.round(a.mood), money: Math.round(a.money), jobId: a.jobId, homeId: a.homeId, workPin: a.workPin, needs: a.needs, thoughts: a.thoughts, logs: a.logs,
    })),
    relations: [...w.relations.values()],
    feed: w.feed.slice(-120),
    rumors: w.rumors.rumors,
    factions: w.factions,
    blackoutUntil: w.blackoutUntil || undefined,
  };
}

export function deserializeWorld(s: SaveFile): World {
  if (s?.format !== 'asiwrite-save') throw new Error('세이브 파일 형식이 아니에요.');
  const w = new World(s.meta.context, s.meta.weather, { empty: s.map ? !s.map.roads : false });
  if (s.map) {
    w.resizeMap(0, 0, s.map.w - w.map.w, s.map.h - w.map.h); // grows or shrinks (no buildings yet)
    if (s.map.rows) w.map.roadRows = s.map.rows;
    if (s.map.cols) w.map.roadCols = s.map.cols;
  }
  w.meta.minutes = s.meta.minutes;
  for (const p of s.places) {
    const [tw, th] = PLACE_SIZES[p.style];
    const place: Place = {
      id: p.id, kind: 'place', name: p.name, category: STYLE_LABEL[p.style], appearance: p.appearance, traits: p.traits, style: p.style,
      tx: p.tx, ty: p.ty, tw, th, door: { tx: 0, ty: 0 }, seats: [], workSpots: [], regulars: p.regulars ?? {}, logs: [],
    };
    w.stampPlace(place, p.doorSide);
    place.logs = p.logs ?? [];
  }
  // the saved outdoor tiles (incl. roads the player drew); older saves just re-scatter nature
  if (!(s.map?.tiles && w.map.applyTiles(s.map.tiles))) w.map.scatterNature(11);
  for (const a of s.agents) {
    const ag = w.addAgentFromSheet(a.sheet, a.x, a.y);
    w.grid.remove(ag);
    ag.id = a.id; // stable ids keep relations intact
    w.grid.insert(ag);
    ag.mood = a.mood;
    if (a.money !== undefined) ag.money = a.money;
    if (a.money !== undefined) ag.jobId = a.jobId && w.place(a.jobId) ? a.jobId : undefined;
    ag.homeId = a.homeId && w.place(a.homeId) ? a.homeId : undefined;
    ag.workPin = a.workPin === 'none' || (a.workPin && w.place(a.workPin)) ? a.workPin : undefined;
    if (a.needs) ag.needs = a.needs;
    ag.thoughts = a.thoughts ?? [];
    ag.logs = a.logs ?? [];
  }
  w.effects = [];
  for (const r of s.relations ?? []) {
    if (r.ab === undefined || r.ba === undefined) r.ab = r.ba = r.affinity ?? 0; // older saves were symmetric
    w.relations.set(`${r.a}|${r.b}`, r);
  }
  w.feed = s.feed ?? [];
  w.rumors.rumors = s.rumors ?? [];
  w.blackoutUntil = s.blackoutUntil && s.blackoutUntil > w.meta.minutes ? s.blackoutUntil : 0;
  w.factions = (s.factions ?? []).map((f) => ({ ...f, members: f.members.filter((m) => w.agent(m)) })).filter((f) => f.members.length >= 2);
  return w;
}

const SLOT_KEY = 'asiwrite.saves.v1';

export interface SlotInfo {
  slot: string;
  savedAt: string;
  context: string;
  agents: number;
  minutes: number;
}

export function listSlots(): SlotInfo[] {
  try {
    const raw = localStorage.getItem(SLOT_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, SaveFile>;
    return Object.entries(all)
      .map(([slot, s]) => ({ slot, savedAt: s.savedAt, context: s.meta.context, agents: s.agents.length, minutes: s.meta.minutes }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}

export function writeSlot(slot: string, s: SaveFile): boolean {
  try {
    const raw = localStorage.getItem(SLOT_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, SaveFile>) : {};
    all[slot] = s;
    localStorage.setItem(SLOT_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function readSlot(slot: string): SaveFile | null {
  try {
    const raw = localStorage.getItem(SLOT_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as Record<string, SaveFile>)[slot] ?? null;
  } catch {
    return null;
  }
}

export function deleteSlot(slot: string) {
  try {
    const raw = localStorage.getItem(SLOT_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, SaveFile>;
    delete all[slot];
    localStorage.setItem(SLOT_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export function downloadSave(s: SaveFile) {
  const blob = new Blob([JSON.stringify(s, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `asiwrite-${s.savedAt.slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
