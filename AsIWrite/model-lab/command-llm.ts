// Sentences the rule parser does NOT understand → Gemma 4 E2B (same weights family, ONNX q4, CPU) with the
// game's real command prompt → extract JSON → the game's real validator. Measures tier 3.
import { World } from '../src/engine/World';
import { Game } from '../src/engine/Game';
import { parseCommand } from '../src/commands/ruleParser';
import { commandPrompt, extractJson, grounded } from '../src/ai/commandLLM';
import { sanitizeCommand } from '../src/commands/validate';

const dyn = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
const { resolve } = await dyn('node:path');
const T = await dyn('@huggingface/transformers');
// run from the app folder (AsIWrite/): the cache is <repo>/../model-cache
T.env.cacheDir = process.env.MODEL_CACHE ?? resolve(process.cwd(), '../../model-cache');
const gen = await T.pipeline('text-generation', process.env.LLM_MODEL ?? 'onnx-community/gemma-4-E2B-it-ONNX', { dtype: process.env.LLM_DTYPE ?? 'q4', device: 'cpu' });

const w = World.createWith({ context: '현대 서울', weather: 'rain', wills: 6, places: 6, animals: 2 });
const g = new Game(w);
const p0 = w.agents.find((a) => a.kind === 'person')!.name;
const p1 = w.agents.filter((a) => a.kind === 'person')[1].name;
const cafe = w.places.find((p) => p.style !== 'home')!;
// each with the type we expect (null = not a command)
const CASES: [string, string | null][] = [
  [`${p0}이 너무 외로워 보이는데 친구 좀 만들어 줘`, 'TRIGGER_EVENT|SPAWN_ENTITY'],
  ['하늘이 너무 우중충해, 해 좀 보고 싶다', 'SET_WEATHER'],
  ['동네에 도서관 같은 조용한 곳이 하나 있었으면', 'SPAWN_ENTITY'],
  [`${p0}이랑 ${p1} 둘이 얘기 좀 해 보게 해`, 'TRIGGER_EVENT'],
  ['오늘 밤에 다 같이 별 구경할 만한 일 좀 만들어 줘', 'WORLD_EVENT'],
  [`${p1}한테 요즘 고민 있냐고 슬쩍 떠봐`, 'TALK'],
  ['마을 위쪽 끝을 따라 가로수 길을 만들어 줘', 'PAINT_MAP'],
  [`${cafe.name} 앞마당을 예쁘게 꽃으로 채워 줘`, 'PAINT_MAP'],
  ['강아지 한 마리 키우고 싶어, 데려와 줘', 'SPAWN_ENTITY'],
  [`${p0}을 좀 더 부지런한 사람으로 바꿔 줘`, 'MODIFY_ENTITY'],
  ['이 동네 분위기 좀 띄워 줘, 축제 같은 거', 'WORLD_EVENT'],
  ['다들 너무 바쁜 것 같아, 시간 좀 천천히 흐르게', 'SYSTEM'],
  ['다들 피곤해 보이는데 오늘은 일찍 재우자, 밤 넘겨', 'SYSTEM'],
  [`${p1}을 동네에서 아예 없애 줘`, 'DELETE_ENTITY'],
  ['여기를 해적들이 사는 항구 마을로 바꿔 줘', 'SET_WORLD_CONTEXT'],
  [`${p0}가 사실 외계인이라는 얘기가 돌게 해`, 'SPREAD_RUMOR'],
  ['배고프다 치킨 시킬까', null],
  ['오늘 진짜 피곤하다', null],
  ['ㅋㅋㅋㅋ 귀엽다', null],
];
let right = 0, valid = 0, safeNone = 0;
for (const [s, want] of CASES) {
  const rule = parseCommand(s);
  const weak = !!rule && rule.type === 'SPAWN_ENTITY' && rule.entity.kind === 'person' && !rule.entity.traits?.length && !rule.entity.job && !rule.entity.name && (rule.entity.appearance ?? '').length > 8;
  const t0 = Date.now();
  let raw = '(rule)';
  let cmd = rule;
  if (!rule || weak) {
    const out = await gen(commandPrompt(s, w, null), { max_new_tokens: 160, do_sample: false });
    raw = out[0].generated_text.at(-1).content as string;
    const c = sanitizeCommand(extractJson(raw));
    cmd = c && grounded(c, s, w) ? c : weak ? rule : null;
  }
  const ok = want === null ? !cmd : !!cmd && new RegExp(`^(${want})$`).test(cmd.type);
  if (cmd) valid++;
  if (want === null && !cmd) safeNone++;
  if (ok) right++;
  let ran = '';
  if (cmd) {
    const r = g.dispatch(cmd);
    ran = ` → ${r.ok ? '✓' : '✗'} ${r.message.slice(0, 70)}`;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} [rule:${rule?.type ?? '—'}] ${s}\n     ${(Date.now() - t0) / 1000}s raw=${raw.replace(/\s+/g, ' ').slice(0, 160)}\n     cmd=${JSON.stringify(cmd)}${ran}`);
}
console.log(`=== ${right}/${CASES.length} understood as expected · ${valid} valid commands · non-commands refused ${safeNone}/3 ===`);
