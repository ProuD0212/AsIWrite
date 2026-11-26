// 목표 · 의뢰 · 작은 사건 — small, achievable things to do, so the player always has a reason to act.
//  - request (의뢰): a Will asks for something; the player accepts or declines
//  - goal (동네 목표): a town-wide aim, always optional, rotates when done
//  - moment (작은 사건): a short-lived prompt with a one-click response
// Everything here is plain data so it can be saved; World evaluates the checks.

import type { GameCommand } from '../commands/schema';
import type { PlaceStyle } from './types';

export type QuestCheck =
  | { type: 'placeStyle'; style: PlaceStyle }
  | { type: 'feelBoth'; a: string; b: string; value: number }
  | { type: 'confessOrLovers'; a: string; b: string; since: number }
  | { type: 'friend'; a: string; value: number }
  | { type: 'ownsPet'; a: string }
  | { type: 'mood'; a: string; value: number }
  | { type: 'avgMoodHold'; value: number; minutes: number; heldSince?: number }
  | { type: 'groups'; n: number }
  | { type: 'lovers'; n: number }
  | { type: 'population'; n: number }
  | { type: 'event'; event: string; since: number; target?: string }
  | { type: 'weather'; weather: string };

export interface Quest {
  id: string;
  kind: 'request' | 'goal' | 'moment';
  status: 'offered' | 'active' | 'done' | 'failed' | 'declined';
  /** the Will who asked (requests) or is concerned (moments) */
  from?: string;
  icon: string;
  title: string;
  /** what the Will says / what's going on, first person for requests */
  text: string;
  check: QuestCheck;
  /** one-click response for moments (and helpful shortcuts) */
  action?: { label: string; cmd: GameCommand };
  createdAt: number;
  expiresAt: number;
  /** a reason key so the same request isn't made twice in a row */
  key: string;
}

let n = 0;
export const questId = () => `q${Date.now().toString(36)}${(n++).toString(36)}`;
