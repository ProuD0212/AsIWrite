// The ONE command vocabulary of the game.
//
// Every action is a GameCommand. Two producers create them:
//   1) the top chat bar (natural language → JSON: rule parser now, LLM later)
//   2) the GUI (toolbar buttons, map clicks, inspector forms)
// Both go through Game.dispatch(), so anything doable by typing is doable by
// clicking and vice versa.

import type { PlaceStyle, Weather } from '../engine/types';
import type { WorldEventKind } from '../engine/World';

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
  x?: number; // world px
  y?: number;
}

export type EventKind = 'LIGHTNING' | 'MEET' | 'BLESS' | 'GIFT';

export type SystemAction = 'SAVE' | 'LOAD' | 'SETTINGS' | 'QUIT' | 'PAUSE' | 'RESUME' | 'SPEED' | 'FOLLOW' | 'HELP' | 'EXPAND';

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
  | { type: 'SYSTEM'; action: SystemAction; value?: number | string; target?: TargetRef };

export interface CommandResult {
  ok: boolean;
  message: string;
  focusId?: string;
}
