// Tier 2½ of command understanding: when the rules and the meaning model can't place a sentence,
// the storyteller model (Gemma 4 in the browser) translates it into a GameCommand as JSON.
// The output is untrusted — commands/validate.ts lets only well-formed, harmless commands through,
// and the player sees what it was understood as.

import type { ChatMsg } from './protocol';
import { storyteller } from './storyteller';
import { hostStatus } from './remote';
import { sanitizeCommand } from '../commands/validate';
import type { GameCommand } from '../commands/schema';
import { givenName, STYLE_LABEL, type World } from '../engine/World';
import type { TargetRef } from '../commands/schema';

const SYSTEM = `너는 한국어 게임 명령을 JSON으로 바꾸는 번역기다. 설명 없이 JSON 객체 하나만 출력한다.
게임: 사람("윌")·동물·건물이 사는 마을 시뮬레이션. 플레이어는 문장으로 세상을 바꾼다.
명령 형식(type별):
- SPAWN_ENTITY {"entity":{"kind":"person|animal|place","name"?,"category"?,"traits"?:["…한다"],"job"?,"style"?(place일 때 필수)},"count"?,"at"?:{"near":{"name"}}}
- MODIFY_ENTITY {"target":{"name"},"changes":{"addTraits"?:[],"removeTraits"?:[],"name"?,"job"?,"mood"?(0~100),"appearance"?}}
- DELETE_ENTITY {"target":{"name"}}
- SET_WEATHER {"weather":"clear|rain|snow|storm"}
- SET_WORLD_CONTEXT {"context":"세계관"}
- SPREAD_RUMOR {"text":"소문 내용"}
- TRIGGER_EVENT {"event":"MEET|BLESS|GIFT|LIGHTNING","targets":[{"name"}…]} (MEET는 두 명)
- WORLD_EVENT {"event":"FESTIVAL|RAINBOW|BLACKOUT|BUSKING|METEOR|BIRTHDAY|LOTTERY|LOST_TREASURE","target"?:{"name"}}
- TALK {"target":{"name"},"text":"플레이어가 하는 말"}
- PAINT_MAP {"brush":"road|sidewalk|dirt|plaza|grass|tree|bush|flower|lamp|bench|erase","area":{"kind":"line","dir"?:"h|v|cross","at"?:"center|top|bottom|left|right"}|{"kind":"border"}|{"kind":"roadside"}|{"kind":"around","target":{"name"}}|{"kind":"path","from"?:{"name"},"to":{"name"}}|{"kind":"region","where":"all|top|bottom|left|right|topleft|topright|bottomleft|bottomright|center"},"width"?,"count"?,"density"?:"few|many","only"?(지우거나 바꿀 대상)}
- RESIZE_MAP {"left"?,"top"?,"right"?,"bottom"?} (칸 수, 줄이면 음수)
- RENAME_WORLD {"name":"세계 이름"}
- SYSTEM {"action":"SAVE|PAUSE|RESUME|SPEED|FOLLOW|SKIP_NIGHT|EDIT_MAP|EXPAND|ADOPT","value"?,"target"?}
건물 style: ${Object.entries(STYLE_LABEL).map(([k, v]) => `${k}=${v}`).join(', ')}
게임 명령이 아니거나 알 수 없으면 {"type":"NONE"}을 출력한다. 혼잣말·감탄·잡담은 NONE이다. 이름은 [이 세계의 이름들]에 있고 문장에 나온 것만 쓴다. 세계관 변경은 문장이 세계·배경·시대를 바꾸라고 할 때만 쓴다.`;

const SHOTS: [string, string][] = [
  ['마을 한복판을 가로지르는 산책길을 내 줘', '{"type":"PAINT_MAP","brush":"dirt","area":{"kind":"line","dir":"h","at":"center"}}'],
  ['비 좀 그치게 해 줄래?', '{"type":"SET_WEATHER","weather":"clear"}'],
  ['책 좋아하는 조용한 대학생 하나 데려와', '{"type":"SPAWN_ENTITY","entity":{"kind":"person","job":"대학생","traits":["책을 좋아한다","조용하다"]}}'],
  ['민수가 요즘 너무 우울해 보여, 기운 좀 북돋아 줘', '{"type":"TRIGGER_EVENT","event":"BLESS","targets":[{"name":"민수"}]}'],
  ['오늘 밤하늘에 별똥별 쏟아지게', '{"type":"WORLD_EVENT","event":"METEOR"}'],
  ['카페 근처에 빵집 하나 차려 줘', '{"type":"SPAWN_ENTITY","entity":{"kind":"place","style":"bakery"},"at":{"near":{"name":"카페"}}}'],
  ['철수한테 오늘 하루 어땠는지 물어봐', '{"type":"TALK","target":{"name":"철수"},"text":"오늘 하루 어땠어요?"}'],
  ['영희를 고양이 좋아하는 사람으로 만들어', '{"type":"MODIFY_ENTITY","target":{"name":"영희"},"changes":{"addTraits":["고양이를 좋아한다"]}}'],
  ['우리 동네를 중세 판타지 왕국처럼 바꿔 줘', '{"type":"SET_WORLD_CONTEXT","context":"중세 판타지 왕국"}'],
  ['시간 좀 천천히 흐르게 해 줘', '{"type":"SYSTEM","action":"SPEED","value":0.5}'],
  ['오늘 저녁 뭐 먹지', '{"type":"NONE"}'],
  ['ㅋㅋㅋ 다들 귀엽네', '{"type":"NONE"}'],
];

function names(world: World): string {
  const ps = world.agents.filter((a) => a.kind === 'person').slice(0, 24).map((a) => a.name);
  const an = world.agents.filter((a) => a.kind === 'animal').slice(0, 10).map((a) => `${a.name}(${a.category})`);
  const pl = world.places.slice(0, 20).map((p) => `${p.name}(${STYLE_LABEL[p.style]})`);
  return `윌: ${ps.join(', ') || '없음'} / 동물: ${an.join(', ') || '없음'} / 건물: ${pl.join(', ') || '없음'}`;
}

export function commandPrompt(text: string, world: World, selectedId: string | null): ChatMsg[] {
  const sel = world.agent(selectedId ?? undefined) ?? world.place(selectedId ?? undefined);
  const msgs: ChatMsg[] = [{ role: 'system', content: SYSTEM }];
  for (const [q, a] of SHOTS) msgs.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  msgs.push({ role: 'user', content: `[이 세계의 이름들] ${names(world)}${sel ? `\n[선택된 대상] ${sel.name}` : ''}\n[문장] ${text}` });
  return msgs;
}

/** first balanced {...} in the text (models sometimes add a word or a code fence around it) */
export function extractJson(raw: string): unknown {
  const s = raw.replace(/```(?:json)?/g, '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(i, k + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The model's command must be grounded in the sentence: every name it targets has to be in the
 * text (or be the selected one / a building called by its kind), and sweeping actions need their
 * words. Otherwise it's a guess → rejected.
 */
export function grounded(c: GameCommand, text: string, world: World): boolean {
  const t = text.replace(/\s+/g, ' ');
  const words = t.split(/[\s,.!?]+/).map((w) => w.replace(/(에게|한테|에서|까지|으로|로|이랑|랑|하고|와|과|을|를|이|가|은|는|의|도|만|아|야)$/, '')).filter((w) => w.length >= 2);
  const inText = (r?: TargetRef) => {
    if (!r || r.selected || r.id) return true;
    const n = r.name ?? '';
    if (!n) return false;
    if (t.includes(n) || (n.length >= 3 && t.includes(givenName(n)))) return true;
    const p = world.places.find((x) => x.name === n);
    if (p && t.includes(STYLE_LABEL[p.style])) return true;
    return words.some((w) => n.includes(w) && w.length >= 2 && !/^(좀|그냥|오늘|요즘|다들)$/.test(w));
  };
  switch (c.type) {
    case 'MODIFY_ENTITY':
    case 'TALK':
      return inText(c.target);
    case 'DELETE_ENTITY':
      return inText(c.target) && /(지워|지우|없애|삭제|사라지|치워|내보내|빼)/.test(t);
    case 'TRIGGER_EVENT':
      return c.targets.every(inText);
    case 'WORLD_EVENT':
      return !c.target || inText(c.target);
    case 'SET_WORLD_CONTEXT':
      return /(세계|배경|시대|세상|월드|무대|테마|여기를|이곳을|동네를|마을을)/.test(t) && c.context.length <= 20 && c.context !== t.trim();
    case 'SPREAD_RUMOR':
      return /(소문|퍼뜨|돌게|말이 돌|얘기가 돌)/.test(t);
    case 'RENAME_WORLD':
      return /이름/.test(t);
    case 'PAINT_MAP':
      return c.area.kind === 'around' ? inText(c.area.target) : c.area.kind === 'path' ? inText(c.area.to) && inText(c.area.from) : true;
    case 'SPAWN_ENTITY':
      return !c.at?.near || inText(c.at.near);
    case 'GROUP':
      return (c.members ?? []).every(inText);
    case 'SYSTEM':
      return !c.target || inText(c.target);
    default:
      return true;
  }
}

/** can the model be asked right now? (local model loaded or a cloud key set) */
export function llmAvailable() {
  const b = storyteller.backend();
  return storyteller.state === 'ready' && b !== 'off' && (b !== 'host' || hostStatus.story);
}

/** ask the model; resolves to a validated command, or null (not a command / not understood / timed out) */
export function llmInterpret(text: string, world: World, selectedId: string | null, timeoutMs = 20000): Promise<GameCommand | null> {
  if (!llmAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: GameCommand | null) => {
      if (done) return;
      done = true;
      resolve(c);
    };
    const ok = storyteller.enqueue({
      key: `cmd:${text}`,
      kind: 'command',
      messages: commandPrompt(text, world, selectedId),
      maxTokens: 200,
      ttl: timeoutMs,
      priority: 10,
      onDone: (raw) => {
        const c = sanitizeCommand(extractJson(raw));
        finish(c && grounded(c, text, world) ? c : null);
      },
      onFail: () => finish(null),
    });
    if (!ok) finish(null);
    setTimeout(() => finish(null), timeoutMs + 2000);
  });
}
