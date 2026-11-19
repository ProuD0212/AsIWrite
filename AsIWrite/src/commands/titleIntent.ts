// Title-screen intent classification ("Semantic Boot Trigger").
// Phase 1: keyword/regex; Phase 2 adds MiniLM nearest-anchor classification so
// paraphrases ("세상을 열어줘", "게임 하자") also work.

import type { Weather } from '../engine/types';
import { parseWeather } from './ruleParser';

export type TitleIntent =
  | { type: 'START_GAME'; context?: string; weather?: Weather; spawns: string[]; secret?: boolean }
  | { type: 'TUTORIAL' }
  | { type: 'SETTINGS' }
  | { type: 'LOAD' }
  | { type: 'QUIT' }
  | { type: 'UNKNOWN' };

const START = /(빛이\s*있으라|시작|start|새로운\s*세상|새\s*게임|새\s*세상|게임\s*하자|play|begin|let there be light|천지창조|세상을\s*(열|만들))/i;
const SETTINGS = /^(설정|옵션|환경\s*설정|settings?|options?)$/i;
const LOAD = /^(불러오기|로드|이어하기|이어서|load|continue)$/i;
const QUIT = /^(종료|끝|나가기|그만|quit|exit|bye)$/i;
const CONTEXT_WORDS = /(현대|판타지|중세|사이버|아포칼립스|좀비|서울|부산|마을|왕국|도시|세계|세상|시대|학교|미래|우주|섬|일상)/;

export function classifyTitle(input: string): TitleIntent {
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t) return { type: 'UNKNOWN' };
  if (/^(튜토리얼|tutorial|연습|배우기|처음이에요)$/i.test(t)) return { type: 'TUTORIAL' };
  if (SETTINGS.test(t)) return { type: 'SETTINGS' };
  if (LOAD.test(t)) return { type: 'LOAD' };
  if (QUIT.test(t)) return { type: 'QUIT' };

  const hasStart = START.test(t);
  if (!hasStart && !CONTEXT_WORDS.test(t)) return { type: 'UNKNOWN' };

  // "비 오는 현대 서울에 고양이 한 마리와 시작"
  let body = t.replace(/\s*(와|과|랑|하고)?\s*(함께\s*)?(시작|start|begin|play).*$/i, '').trim();
  if (/^(빛이\s*있으라|새로운\s*세상|새\s*게임|새\s*세상|let there be light)[!.~ ]*$/i.test(body)) body = '';
  const weather = parseWeather(t) ?? (/(비 ?오는|비 ?내리는|빗속)/.test(t) ? 'rain' : /(눈 ?오는|눈 ?내리는|설원)/.test(t) ? 'snow' : undefined);
  body = body.replace(/(비 ?오는|비 ?내리는|눈 ?오는|눈 ?내리는|폭풍우 ?치는|맑은|화창한)\s*/g, '').trim();

  let context: string | undefined;
  const spawns: string[] = [];
  const split = body.match(/^(.+?)(?:에서|에)\s+(.+)$/);
  if (split) {
    context = split[1].trim();
    spawns.push(split[2].trim());
  } else if (body) {
    if (CONTEXT_WORDS.test(body)) context = body;
    else spawns.push(body);
  }
  const secret = /(빛이\s*있으라|let there be light)/i.test(t);
  return { type: 'START_GAME', context: context || undefined, weather, spawns: spawns.filter(Boolean), secret };
}
