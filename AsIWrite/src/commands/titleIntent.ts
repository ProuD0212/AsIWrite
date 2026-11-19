// Title-screen intent classification ("Semantic Boot Trigger").
// Phase 1: keyword/regex; Phase 2 adds MiniLM nearest-anchor classification so
// paraphrases ("세상을 열어줘", "게임 하자") also work.

import type { Weather } from '../engine/types';
import { parseWeather } from './ruleParser';

export type TitleIntent =
  | { type: 'START_GAME'; context?: string; weather?: Weather; spawns: string[]; secret?: boolean; empty?: boolean; wills?: number; places?: number; animals?: number }
  | { type: 'TUTORIAL' }
  | { type: 'SETTINGS' }
  | { type: 'LOAD' }
  | { type: 'QUIT' }
  | { type: 'UNKNOWN' };

const START = /(빛이\s*있으라|시작|생성|만들어|만들기|start|새로운\s*세상|새\s*게임|새\s*세상|게임\s*하자|play|begin|let there be light|천지창조|세상을\s*(열|만들))/i;
const SETTINGS = /^(설정|옵션|환경\s*설정|settings?|options?)$/i;
const LOAD = /^(불러오기|로드|이어하기|이어서|load|continue)$/i;
const QUIT = /^(종료|끝|나가기|그만|quit|exit|bye)$/i;
const CONTEXT_WORDS = /(현대|판타지|중세|사이버|아포칼립스|좀비|서울|부산|마을|왕국|도시|세계|세상|시대|학교|미래|우주|섬|일상)/;

/** The sentence shown in the title cylinder — users tend to copy and tweak this shape. */
export const START_TEMPLATE = '현대 서울에서 윌 8명, 건물 7채, 동물 2마리로 시작';

const KNUM: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 없: 0 };
const num = (v: string | undefined) => (v === undefined ? undefined : /^\d+$/.test(v) ? parseInt(v, 10) : KNUM[v]);
const N = '(\\d+|한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)';

/** "윌 8명, 건물 7채, 동물 2마리" (any order, digits or Korean numerals) */
export function parseCounts(t: string): { wills?: number; places?: number; animals?: number } {
  const r = (re: string) => t.match(new RegExp(re))?.[1];
  const wills = num(r(`(?:윌|사람|주민|캐릭터)\\s*${N}\\s*명`) ?? r(`${N}\\s*명의?\\s*(?:윌|사람|주민)`));
  const places = num(r(`(?:건물|시설|가게)\\s*${N}\\s*(?:채|개|곳|동)`) ?? r(`${N}\\s*(?:채|곳)의?\\s*(?:건물|시설)`));
  const animals = num(r(`(?:동물|고양이|강아지|길고양이)\\s*${N}\\s*마리`) ?? r(`${N}\\s*마리의?\\s*(?:동물|고양이)`));
  return { wills, places, animals };
}

export function classifyTitle(input: string): TitleIntent {
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t) return { type: 'UNKNOWN' };
  if (/^(튜토리얼|tutorial|연습|배우기|처음이에요)$/i.test(t)) return { type: 'TUTORIAL' };
  if (SETTINGS.test(t)) return { type: 'SETTINGS' };
  if (LOAD.test(t)) return { type: 'LOAD' };
  if (QUIT.test(t)) return { type: 'QUIT' };

  // "빈 세계 생성, 배경은 현대 서울" → an empty world whose setting is 현대 서울
  const EMPTY = /(빈|텅\s*빈|아무것도\s*없는|비어\s*있는|empty)\s*(세계|세상|월드|맵|땅|마을)?/i;
  if (EMPTY.test(t) && /(세계|세상|월드|맵|땅|마을|생성|만들|시작|empty)/i.test(t)) {
    const weather0 = parseWeather(t) ?? (/(비 ?오는|비 ?내리는)/.test(t) ? 'rain' : /(눈 ?오는|눈 ?내리는)/.test(t) ? 'snow' : undefined);
    const bg =
      t.match(/(?:배경|세계관|무대|설정)(?:은|는|이|가|을|를)?\s*[:：]?\s*([^,.]+?)\s*(?:으로|로|이야|야|입니다|이다)?\s*(?:[,.]|$)/)?.[1] ??
      t.match(/([^,]+?)\s*배경(?:의|인|으로)/)?.[1];
    const context = bg?.replace(/(비 ?오는|눈 ?오는)\s*/g, '').replace(/(생성|만들어|시작).*$/, '').trim();
    return { type: 'START_GAME', context: context || undefined, weather: weather0, spawns: [], empty: true, ...parseCounts(t) };
  }

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
  const counts = parseCounts(t);
  const hasCounts = counts.wills !== undefined || counts.places !== undefined || counts.animals !== undefined;
  // with counts, the "…로 시작" tail is a recipe, not an entity to spawn
  return { type: 'START_GAME', context: context || undefined, weather, spawns: hasCounts ? [] : spawns.filter(Boolean), secret, ...counts };
}
