// The ONE command vocabulary of the game.
//
// Every action is a GameCommand. Two producers create them:
//   1) the top chat bar (natural language → JSON: rule parser now, LLM later)
//   2) the GUI (toolbar buttons, map clicks, inspector forms)
// Both go through Game.dispatch(), so anything doable by typing is doable by
// clicking and vice versa.

import type { DoorSide, PlaceStyle, Weather } from '../engine/types';
import type { WorldEventKind } from '../engine/World';
import type { MapBrush } from '../engine/TileMap';

export type MapRegion = 'all' | 'top' | 'bottom' | 'left' | 'right' | 'topleft' | 'topright' | 'bottomleft' | 'bottomright' | 'center';
/** where to paint: a line across the map, the border, along roads, around something, a route, or a region */
export type MapAreaSpec =
  | { kind: 'line'; dir?: 'h' | 'v' | 'cross'; at?: 'center' | 'top' | 'bottom' | 'left' | 'right' }
  | { kind: 'border' }
  | { kind: 'roadside' }
  | { kind: 'around'; target: TargetRef; radius?: number }
  | { kind: 'path'; from?: TargetRef; to: TargetRef }
  | { kind: 'region'; where: MapRegion };

export interface TargetRef {
  id?: string;
  name?: string;
  selected?: boolean;
}

export interface SpawnSpec {
  kind: 'person' | 'animal' | 'place';
  name?: string;
  category?: string;
  appearance?: string;
  traits?: string[];
  mood?: number;
  style?: PlaceStyle;
  sheet?: string; // full structured text sheet (overrides the fields above)
  job?: string;
}

export interface Placement {
  near?: TargetRef;
  /** buildings: which wall the door goes in (R turns the placement ghost) */
  door?: DoorSide;
  x?: number; // world px
  y?: number;
}

export type EventKind = 'LIGHTNING' | 'MEET' | 'BLESS' | 'GIFT';

export type SystemAction = 'SAVE' | 'LOAD' | 'SETTINGS' | 'QUIT' | 'PAUSE' | 'RESUME' | 'SPEED' | 'FOLLOW' | 'HELP' | 'EXPAND' | 'SKIP_NIGHT' | 'EDIT_MAP' | 'ADOPT';

export type GameCommand =
  | { type: 'SPAWN_ENTITY'; entity: SpawnSpec; at?: Placement; count?: number }
  | {
      type: 'MODIFY_ENTITY';
      target: TargetRef;
      changes: {
        name?: string;
        category?: string;
        appearance?: string;
        traits?: string[];
        addTraits?: string[];
        removeTraits?: string[];
        mood?: number;
        sheet?: string; // full structured sheet text
        job?: string; // free-text role
        treasure?: string; // 애착 물건
        workplace?: TargetRef | null; // null = quit job
      };
    }
  | { type: 'DELETE_ENTITY'; target: TargetRef }
  | { type: 'SET_WORLD_CONTEXT'; context: string }
  | { type: 'SET_WEATHER'; weather: Weather }
  | { type: 'SPREAD_RUMOR'; text: string; whisperTo?: TargetRef[] }
  | { type: 'GROUP'; action: 'FORM' | 'DISBAND' | 'RENAME' | 'ADD' | 'REMOVE'; group?: string; name?: string; members?: TargetRef[] }
  | { type: 'TRIGGER_EVENT'; event: EventKind; targets: TargetRef[] }
  /** world events (사건): festival, rainbow, blackout, busking, meteor shower, birthday, lottery, lost treasure */
  | { type: 'WORLD_EVENT'; event: WorldEventKind; target?: TargetRef }
  | { type: 'SYSTEM'; action: SystemAction; value?: number | string; target?: TargetRef }
  /** the player speaks to a Will (they answer in character) */
  | { type: 'TALK'; target: TargetRef; text: string }
  /** paint the map from a sentence: ground (road, sidewalk…) or decorations (trees, lamps…); `only` = replace/erase just that */
  | { type: 'PAINT_MAP'; brush: MapBrush; area: MapAreaSpec; width?: number; count?: number; density?: 'few' | 'many'; only?: MapBrush }
  /** grow (+) or shrink (−) the map on each side, in tiles */
  | { type: 'RESIZE_MAP'; left?: number; top?: number; right?: number; bottom?: number }
  /** name the world (its save slot follows the name) */
  | { type: 'RENAME_WORLD'; name: string };

export interface CommandResult {
  ok: boolean;
  message: string;
  focusId?: string;
}
