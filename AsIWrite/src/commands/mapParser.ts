// 맵 꾸미기 문장 해석 — compositional, not sentence-by-sentence:
//   무엇(도로·인도·흙길·돌바닥·잔디 / 나무·꽃·덤불·가로등·벤치)
// × 어디(가운데·위·아래·왼쪽·오른쪽 · 가로/세로/십자 · 테두리 · 길가 · ○○ 주변 · ○○에서 ○○까지 · 구역)
// × 얼마나(○칸 폭 · 넓게/좁게 · ○그루 · 많이/조금)
// × 어떻게(깔기·심기·세우기 / 없애기 / ○○를 △△로 바꾸기)
// Any combination of the slots works, so sentences nobody wrote down in advance still parse.

import type { MapBrush } from '../engine/TileMap';
import type { GameCommand, MapAreaSpec, MapRegion, TargetRef } from './schema';

const BRUSH_WORDS: [RegExp, MapBrush][] = [
  [/(가로등|조명등?|전등|등불|랜턴|가스등|횃불)/, 'lamp'],
  [/(벤치|긴 ?의자|쉼터 ?의자|평상)/, 'bench'],
  [/(꽃(?!집|가게|다발)|화단|화초|튤립|장미|해바라기)/, 'flower'],
  [/(덤불|수풀|관목|풀숲|생울타리|울타리|화살나무)/, 'bush'],
  [/(나무|가로수|소나무|벚나무|은행나무|단풍나무|수목|야자수)/, 'tree'],
  [/(돌바닥|돌길|석판|포장 ?도로|보도블[록럭]|광장 ?바닥|타일 ?바닥|자갈|벽돌 ?길|돌 ?포장)/, 'plaza'],
  [/(산책로|오솔길|흙길|흙바닥|시골길|흙|모래 ?길|비포장|둘레길|숲길)/, 'dirt'],
  [/(인도|보도(?!블)|보행로|보행자 ?(?:길|도로)|사람 ?(?:다니는|걷는) ?길|산책길|걷는 ?길)/, 'sidewalk'],
  [/(잔디|풀밭|초원|들판|풀(?!숲))/, 'grass'],
  [/(도로|차도|찻길|큰길|대로|아스팔트|자동차 ?길|길(?!가)|거리)/, 'road'],
];
export function brushOf(s: string): MapBrush | null {
  for (const [re, b] of BRUSH_WORDS) if (re.test(s)) return b;
  return null;
}
const GROUND = new Set<MapBrush>(['road', 'sidewalk', 'dirt', 'plaza', 'grass']);

const PAINT_VERB = /(깔|까|만들|내 ?줘|내줘|내 ?주|놓|놔|그려|그리|닦|심|세워|세우|설치|둬|두어|두면|배치|꾸며|꾸미|채워|채우|덮|칠해|칠하|바꿔|바꾸|이어|연결|잇|포장|조성|가꿔|늘어놓|줄지어|박아|달아)/;
const ERASE_VERB = /(없애|없에|치워|치우|베어|베 ?줘|뽑아|뽑|지워|지우|제거|걷어|밀어|철거|정리해)/;

const NUM_KO: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 스무: 20, 서른: 30 };
function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return +s;
  return NUM_KO[s];
}
const NUM_PAT = '(\\d+|한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열|스무|서른)';

function atOf(t: string): 'center' | 'top' | 'bottom' | 'left' | 'right' | undefined {
  if (/(중앙|가운데|한가운데|한복판|중심|정중앙)/.test(t)) return 'center';
  if (/(위쪽|윗쪽|위에|위로|상단|북쪽|맨 ?위|윗부분|북부)/.test(t)) return 'top';
  if (/(아래쪽|아랫쪽|아래에|아래로|하단|남쪽|맨 ?아래|아랫부분|남부)/.test(t)) return 'bottom';
  if (/(왼쪽|왼편|좌측|서쪽|서부)/.test(t)) return 'left';
  if (/(오른쪽|오른편|우측|동쪽|동부)/.test(t)) return 'right';
  return undefined;
}
function dirOf(t: string): 'h' | 'v' | 'cross' | undefined {
  if (/(십자|열십자|가로 ?세로|사거리|교차로|양방향)/.test(t)) return 'cross';
  if (/(가로(?!등|수)|동서|좌우로|옆으로|수평|가로질러)/.test(t)) return 'h';
  if (/(세로|남북|위아래|아래위|수직|위에서 ?아래)/.test(t)) return 'v';
  return undefined;
}
function quadrantOf(t: string): MapRegion | undefined {
  if (/((왼쪽|좌측|서쪽) ?(위|상단|윗)|북서|좌상단)/.test(t)) return 'topleft';
  if (/((오른쪽|우측|동쪽) ?(위|상단|윗)|북동|우상단)/.test(t)) return 'topright';
  if (/((왼쪽|좌측|서쪽) ?(아래|하단|아랫)|남서|좌하단)/.test(t)) return 'bottomleft';
  if (/((오른쪽|우측|동쪽) ?(아래|하단|아랫)|남동|우하단)/.test(t)) return 'bottomright';
  return undefined;
}
const ALL_RE = /(전체|전부|모두 다|다 ?(?:없애|치워|베어|뽑|지워)|온 ?(?:동네|마을|맵|세상)|모든 ?곳|곳곳|여기저기|사방|빈 ?땅|빈 ?곳|군데군데|마을에|동네에|맵에)/;
const LOC_WORD = /^(가운데|중앙|한가운데|위쪽|아래쪽|왼쪽|오른쪽|맵|지도|마을|동네|길|도로|여기저기|곳곳|전체|빈 ?땅)$/;

function cleanName(s: string): string {
  return s
    .replace(/^(그리고|또|그럼|좀|저기|그|이제)\s+/, '')
    .replace(/(에서|에게|한테|까지|으로|로|에|을|를|이|가|은|는|의|와|과|랑|이랑|하고)$/, '')
    .trim();
}

/**
 * Map-decorating sentence → PAINT_MAP / RESIZE_MAP, or null if it isn't one.
 * `target` turns a name into a TargetRef (shared with the main parser).
 */
export function mapCommandOf(t: string, selectedId: string | null | undefined, target: (s: string, sel?: string | null) => TargetRef): GameCommand | null {
  // ── resizing: "맵을 오른쪽으로 20칸 넓혀 줘", "세로로 늘려", "맵 좀 줄여" ──
  if (/(맵|지도|세계|월드|땅|마을|동네)/.test(t) && /(넓혀|넓히|넓게|확장|키워|키우|늘려|늘리|줄여|줄이|좁혀|좁히|축소|작게)/.test(t) && !brushOf(t.replace(/(맵|지도|세계|월드|땅|마을|동네)/g, ''))) {
    const shrink = /(줄여|줄이|좁혀|좁히|축소|작게)/.test(t);
    const n = num(t.match(new RegExp(`${NUM_PAT}\\s*칸`))?.[1]);
    const sides: { left?: number; top?: number; right?: number; bottom?: number } = {};
    const s = shrink ? -1 : 1;
    if (/(오른쪽|우측|동쪽)/.test(t)) sides.right = s * (n ?? 12);
    if (/(왼쪽|좌측|서쪽)/.test(t)) sides.left = s * (n ?? 12);
    if (/(위쪽|위로|위를|윗|북쪽|상단)/.test(t)) sides.top = s * (n ?? 8);
    if (/(아래쪽|아래로|아래를|아랫|남쪽|하단)/.test(t)) sides.bottom = s * (n ?? 8);
    if (/(가로|좌우|양옆)/.test(t) && !/(세로|위아래)/.test(t)) {
      const k = n ?? 24;
      sides.left = s * Math.floor(k / 2);
      sides.right = s * Math.ceil(k / 2);
    }
    if (/(세로|위아래|상하)/.test(t)) {
      const k = n ?? 16;
      sides.top = s * Math.floor(k / 2);
      sides.bottom = s * Math.ceil(k / 2);
    }
    if (!Object.keys(sides).length) {
      if (!shrink && n === undefined) return { type: 'SYSTEM', action: 'EXPAND' };
      const k = n ?? 12;
      sides.right = s * k;
      sides.bottom = s * Math.round((k * 2) / 3);
    }
    return { type: 'RESIZE_MAP', ...sides };
  }

  // ── not a map sentence ──
  if (/(소문|특성|성격|성향|일기|에게 ["“']|한테 ["“']|축제|생일|버스킹|소환|불러|데려와|태어나)/.test(t)) return null;
  const replaceM = t.match(/^(.+?)(?:을|를)\s*(?:전부|다|모두)?\s*(.+?)(?:으로|로)\s*(?:바꿔|바꾸|덮|갈아|교체|만들|채워|꾸며)/);
  let brush = brushOf(replaceM ? replaceM[2] : t);
  let only: MapBrush | undefined;
  if (replaceM) {
    const from = brushOf(replaceM[1]);
    if (from && brush && from !== brush) only = from;
    if (!brush) brush = brushOf(t);
  }
  if (!brush) return null;
  const erase = ERASE_VERB.test(t) && !replaceM;
  if (!erase && !PAINT_VERB.test(t)) return null;
  // "벤치 있는 공원 만들어 줘", "꽃 좋아하는 할머니 만들어 줘": a building or a person is the object
  const obj = t.match(/(\S+?)(?:을|를|이|가)?\s*(?:하나|한 ?채|한 ?개|한 ?명|한 ?마리)?\s*(?:만들|지어|세워|배치|생성)/)?.[1] ?? '';
  if (/(공원|카페|식당|집|학교|도서관|편의점|노래방|사무실|공장|병원|빵집|꽃집|헬스장|술집|영화관|광장|분수대|정원|건물|가게)$/.test(cleanName(obj)) && !brushOf(cleanName(obj))) return null;
  if (/(윌|사람|주민|캐릭터|할머니|할아버지|아이|소녀|소년|남자|여자|학생|고양이|강아지|동물)(?:을|를|이|가|\s|$)/.test(t) && !/(주변|근처|앞|옆|까지)/.test(t)) return null;

  if (erase) {
    if (GROUND.has(brush)) {
      only = brush;
      brush = 'grass';
    } else {
      only = brush;
      brush = 'erase';
    }
  }

  // ── how much ──
  const wM = t.match(new RegExp(`(?:폭|너비|넓이|두께)\\s*(?:을|를|이|가|은|는)?\\s*${NUM_PAT}`)) ?? t.match(new RegExp(`${NUM_PAT}\\s*칸\\s*(?:짜리|폭|너비|넓이|두께)?`));
  let width = num(wM?.[1]);
  if (width === undefined && /(넓게|넓은|큼직|큰 ?(?:길|도로)|대로|널찍)/.test(t)) width = brush === 'road' ? 3 : brush === 'plaza' ? 4 : 3;
  if (width === undefined && /(좁게|좁은|얇게|얇은|가늘|작은 ?길|한 ?줄)/.test(t)) width = 1;
  const cM = t.match(new RegExp(`${NUM_PAT}\\s*(?:그루|개|송이|포기|군데|곳|대|그루씩|개씩)`));
  const count = num(cM?.[1]) ?? num(t.match(/(?:^|\s)(하나|둘|셋|넷|다섯)(?=\s|만|씩|를|을|$)/)?.[1]);
  const density: 'few' | 'many' | undefined = /(많이|가득|잔뜩|빽빽|우거지|울창|수북|듬뿍|풍성)/.test(t) ? 'many' : /(조금|살짝|몇 ?(?:그루|개|송이)|드문드문|띄엄띄엄)/.test(t) ? 'few' : undefined;

  // ── where ──
  let area: MapAreaSpec | undefined;
  const pathFT = t.match(/(?:^|\s)(\S+(?:\s\S+)?)에서\s+(\S+(?:\s\S+)?)까지/);
  const pathLink = t.match(/(?:^|\s)(\S+)(?:와|과|랑|이랑|하고)\s+(\S+?)(?:을|를|사이를?)?\s*(?:\S+?(?:으로|로)\s*)?(?:잇|이어|연결)/);
  const pathTo = t.match(/(?:^|\s)(\S+(?:\s\S+)?)(?:까지|으로 가는|로 가는|에 가는|가는)\s/);
  if (pathFT && !LOC_WORD.test(cleanName(pathFT[2]))) area = { kind: 'path', from: target(cleanName(pathFT[1]), selectedId), to: target(cleanName(pathFT[2]), selectedId) };
  else if (pathLink) area = { kind: 'path', from: target(cleanName(pathLink[1]), selectedId), to: target(cleanName(pathLink[2]), selectedId) };
  else if (pathTo && !LOC_WORD.test(cleanName(pathTo[1])) && !brushOf(cleanName(pathTo[1]))) area = { kind: 'path', to: target(cleanName(pathTo[1]), selectedId) };
  else if (/(길가|길 ?옆|길 ?양옆|길 ?따라|길을 ?따라|도로 ?(?:변|옆|가|양옆|따라)|도로를 ?따라|양옆|가로수|인도(?:에|를 ?따라|마다)|길마다|거리마다)/.test(t)) area = { kind: 'roadside' };
  else if (/(테두리|가장자리|외곽|변두리|맵 ?(?:끝|둘레)|마을 ?(?:둘레|외곽|끝)|동네 ?(?:둘레|외곽)|빙 ?둘러)/.test(t)) area = { kind: 'border' };
  else {
    const near = t.match(/(?:^|\s)(\S+(?:\s\S+)?)\s*(?:주변|주위|근처|앞|옆|뒤|둘레|앞마당|입구)/);
    const nm = near && cleanName(near[1]);
    if (nm && !LOC_WORD.test(nm) && !brushOf(nm)) area = { kind: 'around', target: target(nm, selectedId), radius: /(넓게|크게)/.test(t) ? 5 : undefined };
    else if (/^(여기|이 ?곳|이 ?근처|선택한)/.test(t) && selectedId) area = { kind: 'around', target: { selected: true } };
  }
  if (!area) {
    const q = quadrantOf(t);
    const at = atOf(t);
    const dir = dirOf(t);
    const lineish = !!dir || /(쭉|줄|길게|라인|일자|한 ?줄|일렬|줄지어|관통|가로질러|끝에서 ?끝)/.test(t);
    const fill = /(바꿔|바꾸|덮|채워|채우|칠해|칠하|꾸며|꾸미|전부|가득)/.test(t);
    if (q) area = { kind: 'region', where: q };
    else if (erase || only) area = { kind: 'region', where: at ? (at === 'center' ? 'center' : at) : 'all' };
    else if (GROUND.has(brush)) {
      if (ALL_RE.test(t) && !lineish) area = { kind: 'region', where: 'all' };
      else if (fill && at && !lineish) area = { kind: 'region', where: at };
      else area = { kind: 'line', dir, at };
    } else {
      if (lineish) area = { kind: 'line', dir, at };
      else if (at) area = { kind: 'region', where: at };
      else area = { kind: 'region', where: 'all' };
    }
  }
  return { type: 'PAINT_MAP', brush, area, ...(width ? { width } : {}), ...(count ? { count } : {}), ...(density ? { density } : {}), ...(only ? { only } : {}) };
}
