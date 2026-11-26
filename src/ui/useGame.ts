import { useSyncExternalStore } from 'react';
import type { Game } from '../engine/Game';

/** Re-render on the game's throttled tick (~5 Hz) or on explicit notify. */
export function useGameTick(game: Game | null): number {
  return useSyncExternalStore(
    game ? game.subscribe : noopSub,
    game ? game.getVersion : zero,
  );
}
const noopSub = () => () => {};
const zero = () => 0;
