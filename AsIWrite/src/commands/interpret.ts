// Natural language → GameCommand entry point used by the chat bar.
// Async on purpose: Phase 2 inserts the embedding/LLM parser here, with the
// rule parser as the always-available fallback.

import { parseCommand } from './ruleParser';
import type { GameCommand } from './schema';

export interface Interpretation {
  cmd: GameCommand | null;
  source: 'rule' | 'llm' | 'none';
}

export async function interpret(text: string, selectedId: string | null): Promise<Interpretation> {
  const cmd = parseCommand(text, selectedId);
  return { cmd, source: cmd ? 'rule' : 'none' };
}
