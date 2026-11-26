// Whatever a language model proposes is untrusted: only well-formed GameCommands get through.
// Unknown types, bad enums and wrong shapes are dropped (→ null), extra fields are stripped.

import { PLACE_SIZES, type MapBrush } from '../engine/TileMap';
import type { PlaceStyle, Weather } from '../engine/types';
import type { WorldEventKind } from '../engine/World';
import type { EventKind, GameCommand, MapAreaSpec, MapRegion, SpawnSpec, SystemAction, TargetRef } from './schema';

const STYLES = new Set(Object.keys(PLACE_SIZES) as PlaceStyle[]);
const WEATHERS = new Set<Weather>(['clear', 'rain', 'snow', 'storm']);
const WORLD_EVENTS = new Set<WorldEventKind>(['FESTIVAL', 'RAINBOW', 'BLACKOUT', 'BUSKING', 'METEOR', 'BIRTHDAY', 'LOTTERY', 'LOST_TREASURE']);
const EVENTS = new Set<EventKind>(['LIGHTNING', 'MEET', 'BLESS', 'GIFT']);
const BRUSHES = new Set<MapBrush>(['road', 'sidewalk', 'dirt', 'plaza', 'grass', 'tree', 'bush', 'flower', 'lamp', 'bench', 'erase']);
const REGIONS = new Set<MapRegion>(['all', 'top', 'bottom', 'left', 'right', 'topleft', 'topright', 'bottomleft', 'bottomright', 'center']);
// the model may only use harmless system actions (no quitting the game, no loading over the world)
const SYSTEM_OK = new Set<SystemAction>(['SAVE', 'PAUSE', 'RESUME', 'SPEED', 'FOLLOW', 'HELP', 'EXPAND', 'SKIP_NIGHT', 'EDIT_MAP', 'ADOPT']);

type O = Record<string, unknown>;
const obj = (v: unknown): O | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : null);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : undefined);
const strs = (v: unknown, n = 8): string[] | undefined => (Array.isArray(v) ? (v.map((x) => str(x, 80)).filter(Boolean) as string[]).slice(0, n) : undefined);

function target(v: unknown): TargetRef | null {
  if (typeof v === 'string') return v.trim() ? { name: v.trim().slice(0, 40) } : null;
  const o = obj(v);
  if (!o) return null;
  if (o.selected === true) return { selected: true };
  const name = str(o.name, 40);
  return name ? { name } : null;
}
function area(v: unknown): MapAreaSpec | null {
  const o = obj(v);
  if (!o) return null;
  switch (o.kind) {
    case 'line': {
      const dir = o.dir === 'h' || o.dir === 'v' || o.dir === 'cross' ? o.dir : undefined;
      const at = ['center', 'top', 'bottom', 'left', 'right'].includes(o.at as string) ? (o.at as 'center') : undefined;
      return { kind: 'line', ...(dir ? { dir } : {}), ...(at ? { at } : {}) };
    }
    case 'border':
    case 'roadside':
      return { kind: o.kind };
    case 'around': {
      const t = target(o.target);
      return t ? { kind: 'around', target: t, ...(num(o.radius, 1, 8) ? { radius: num(o.radius, 1, 8) } : {}) } : null;
    }
    case 'path': {
      const to = target(o.to);
      const from = o.from === undefined ? undefined : target(o.from);
      return to ? { kind: 'path', to, ...(from ? { from } : {}) } : null;
    }
    case 'region':
      return REGIONS.has(o.where as MapRegion) ? { kind: 'region', where: o.where as MapRegion } : { kind: 'region', where: 'all' };
  }
  return null;
}

export function sanitizeCommand(raw: unknown): GameCommand | null {
  const c = obj(raw);
  if (!c) return null;
  switch (c.type) {
    case 'SPAWN_ENTITY': {
      const e = obj(c.entity);
      if (!e || !['person', 'animal', 'place'].includes(e.kind as string)) return null;
      const entity: SpawnSpec = { kind: e.kind as SpawnSpec['kind'] };
      if (str(e.name, 30)) entity.name = str(e.name, 30);
      if (str(e.category, 30)) entity.category = str(e.category, 30);
      if (str(e.appearance, 120)) entity.appearance = str(e.appearance, 120);
      if (strs(e.traits)) entity.traits = strs(e.traits);
      if (str(e.job, 30)) entity.job = str(e.job, 30);
      if (num(e.mood, 0, 100) !== undefined) entity.mood = num(e.mood, 0, 100);
      if (entity.kind === 'place') {
        if (!STYLES.has(e.style as PlaceStyle)) return null;
        entity.style = e.style as PlaceStyle;
      }
      const near = obj(c.at) ? target(obj(c.at)!.near) : null;
      return { type: 'SPAWN_ENTITY', entity, ...(near ? { at: { near } } : {}), ...(num(c.count, 1, 10) && num(c.count, 1, 10)! > 1 ? { count: num(c.count, 1, 10) } : {}) };
    }
    case 'MODIFY_ENTITY': {
      const t = target(c.target), ch = obj(c.changes);
      if (!t || !ch) return null;
      const changes: Extract<GameCommand, { type: 'MODIFY_ENTITY' }>['changes'] = {};
      if (str(ch.name, 30)) changes.name = str(ch.name, 30);
      if (str(ch.appearance, 120)) changes.appearance = str(ch.appearance, 120);
      if (strs(ch.addTraits)) changes.addTraits = strs(ch.addTraits);
      if (strs(ch.removeTraits)) changes.removeTraits = strs(ch.removeTraits);
      if (num(ch.mood, 0, 100) !== undefined) changes.mood = num(ch.mood, 0, 100);
      if (str(ch.job, 30)) changes.job = str(ch.job, 30);
      if (str(ch.treasure, 40)) changes.treasure = str(ch.treasure, 40);
      return Object.keys(changes).length ? { type: 'MODIFY_ENTITY', target: t, changes } : null;
    }
    case 'DELETE_ENTITY': {
      const t = target(c.target);
      return t ? { type: 'DELETE_ENTITY', target: t } : null;
    }
    case 'SET_WORLD_CONTEXT':
      return str(c.context, 40) ? { type: 'SET_WORLD_CONTEXT', context: str(c.context, 40)! } : null;
    case 'SET_WEATHER':
      return WEATHERS.has(c.weather as Weather) ? { type: 'SET_WEATHER', weather: c.weather as Weather } : null;
    case 'SPREAD_RUMOR':
      return str(c.text, 120) ? { type: 'SPREAD_RUMOR', text: str(c.text, 120)! } : null;
    case 'TRIGGER_EVENT': {
      if (!EVENTS.has(c.event as EventKind)) return null;
      const ts = (Array.isArray(c.targets) ? c.targets : [c.target]).map(target).filter(Boolean) as TargetRef[];
      const need = c.event === 'MEET' ? 2 : 1;
      return ts.length >= need ? { type: 'TRIGGER_EVENT', event: c.event as EventKind, targets: ts.slice(0, need) } : null;
    }
    case 'WORLD_EVENT': {
      // near-miss names from a model ("STAR_GATHERING", "METEOR_SHOWER") → the closest real event
      if (!WORLD_EVENTS.has(c.event as WorldEventKind) && typeof c.event === 'string') {
        const e = c.event.toUpperCase();
        const near: [RegExp, WorldEventKind][] = [[/STAR|METEOR|SHOOT|COMET/, 'METEOR'], [/FEST|PARTY|CARNIVAL|PARADE/, 'FESTIVAL'], [/BUSK|CONCERT|MUSIC|SING|PERFORM/, 'BUSKING'], [/RAINBOW/, 'RAINBOW'], [/BIRTH/, 'BIRTHDAY'], [/LOTT|JACKPOT/, 'LOTTERY'], [/BLACK|POWER|OUTAGE/, 'BLACKOUT'], [/LOST|TREASURE/, 'LOST_TREASURE']];
        const hit = near.find(([re]) => re.test(e));
        if (hit) c.event = hit[1];
      }
      if (!WORLD_EVENTS.has(c.event as WorldEventKind)) return null;
      const t = c.target === undefined ? null : target(c.target);
      return { type: 'WORLD_EVENT', event: c.event as WorldEventKind, ...(t ? { target: t } : {}) };
    }
    case 'TALK': {
      const t = target(c.target), text = str(c.text, 120);
      return t && text ? { type: 'TALK', target: t, text } : null;
    }
    case 'PAINT_MAP': {
      if (!BRUSHES.has(c.brush as MapBrush)) return null;
      const a = area(c.area) ?? { kind: 'region', where: 'all' };
      const only = BRUSHES.has(c.only as MapBrush) ? (c.only as MapBrush) : undefined;
      if (c.brush === 'erase' && !only && a.kind === 'region' && a.where === 'all') return null; // too sweeping without a target
      return { type: 'PAINT_MAP', brush: c.brush as MapBrush, area: a, ...(num(c.width, 1, 6) ? { width: num(c.width, 1, 6) } : {}), ...(num(c.count, 1, 60) ? { count: num(c.count, 1, 60) } : {}), ...(c.density === 'few' || c.density === 'many' ? { density: c.density } : {}), ...(only ? { only } : {}) };
    }
    case 'RESIZE_MAP': {
      const s = (v: unknown) => num(v, -60, 60);
      const r = { left: s(c.left), top: s(c.top), right: s(c.right), bottom: s(c.bottom) };
      if (!Object.values(r).some((x) => x)) return null;
      return { type: 'RESIZE_MAP', ...Object.fromEntries(Object.entries(r).filter(([, v]) => v)) };
    }
    case 'RENAME_WORLD':
      return str(c.name, 30) ? { type: 'RENAME_WORLD', name: str(c.name, 30)! } : null;
    case 'GROUP': {
      const action = ['FORM', 'DISBAND', 'RENAME', 'ADD', 'REMOVE'].includes(c.action as string) ? (c.action as 'FORM') : null;
      if (!action) return null;
      const members = Array.isArray(c.members) ? (c.members.map(target).filter(Boolean) as TargetRef[]) : undefined;
      return { type: 'GROUP', action, ...(str(c.group, 30) ? { group: str(c.group, 30) } : {}), ...(str(c.name, 30) ? { name: str(c.name, 30) } : {}), ...(members?.length ? { members } : {}) };
    }
    case 'SYSTEM': {
      if (!SYSTEM_OK.has(c.action as SystemAction)) return null;
      const t = c.target === undefined ? null : target(c.target);
      // speeds snap to the game's steps (0.5 must not round up to 1)
      const SPEEDS = [0.5, 1, 2, 3, 5, 10];
      const value = typeof c.value === 'number' ? (c.action === 'SPEED' ? SPEEDS.reduce((a, b) => (Math.abs(b - (c.value as number)) < Math.abs(a - (c.value as number)) ? b : a)) : num(c.value, 0, 10)) : typeof c.value === 'string' ? str(c.value, 40) : undefined;
      if (c.action === 'SPEED' && typeof value !== 'number') return null;
      return { type: 'SYSTEM', action: c.action as SystemAction, ...(value !== undefined ? { value } : {}), ...(t ? { target: t } : {}) };
    }
  }
  return null;
}
