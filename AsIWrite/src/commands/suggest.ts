import { SPECIES_LABEL } from '../engine/appearance';
// Context-aware command suggestions for the chat bar.
//
// For players who'd rather watch than write: clicking the chat box offers 3–5
// sentences that fit the current world (or the selected Will / place / animal).
// Every suggestion is a natural sentence that the parser actually understands
// (verified with parseCommand before it is shown).

import { STYLE_LABEL, type World } from '../engine/World';
import { extractObject, josa, traitPolarity } from '../engine/traits';
import type { Agent, Place } from '../engine/types';
import { pick } from '../engine/util';
import { poolFor } from '../presets/traitPools';
import { parseCommand } from './ruleParser';
import { PLACE_HINT } from '../presets/placeHints';

export interface Suggestion {
  text: string;
  icon: string;
  why?: string; // short reason shown under the sentence
}

const PLACE_ADJ = ['아늑한', '작은', '조용한', '반짝이는', '오래된'];
const RUMOR_GOOD = ['사실 몰래 시를 쓴다', '어제 길고양이를 구해 줬다', '복권에 당첨됐다', '오디션에 합격했다', '동네에서 제일 요리를 잘한다'];
const RUMOR_SPICY = ['누군가를 짝사랑하고 있다', '사실 엄청난 부자다', '밤마다 공원에서 춤 연습을 한다', '비밀 일기를 쓰고 있다'];
const PLACE_RUMOR = ['유명 연예인이 다녀갔다', '곧 문을 닫는다', '숨겨진 메뉴가 있다', '밤이 되면 이상한 소리가 난다'];
const ANIMAL_RUMOR = ['사실 동네 고양이들의 대장이다', '사람 말을 알아듣는다', '매일 같은 시간에 누군가를 기다린다'];
const SPICE_TRAITS = ['남몰래 탐정 소설을 쓰고 있다', '비 오는 날이면 옛사랑을 떠올린다', '길고양이에게 이름을 붙여 주는 게 취미다', '언젠가 작은 빵집을 여는 것이 꿈이다', '사람들 앞에서 노래하는 것이 무섭다'];

/** "치즈가 대장이다" → "…대장이라는 소문 퍼뜨려", "…당첨됐다" → "…당첨됐다는 소문 퍼뜨려" */
function rumorCmd(subject: string, fact: string): string {
  const body = `${josa(subject, '이/가')} ${fact}`;
  return body.endsWith('이다') ? `${body.slice(0, -2)}이라는 소문 퍼뜨려` : `${body}는 소문 퍼뜨려`;
}

function likeObjects(a: Agent): string[] {
  return a.traits.filter((t) => traitPolarity(t) > 0).map(extractObject).filter(Boolean) as string[];
}

/** A spawn sentence that would delight `a` (animal → pet, place-ish → venue, else a kindred Will). */
function careSpawn(w: World, a: Agent): Suggestion | null {
  for (const obj of likeObjects(a)) {
    if (/고양이|냥/.test(obj)) return { text: `${a.name} 옆에 작고 노란 길고양이 소환`, icon: '🐈', why: `${josa(a.name, '은/는')} ${josa(obj, '을/를')} 좋아해요` };
    if (/강아지|개/.test(obj)) return { text: `${a.name} 옆에 하얀 강아지 소환`, icon: '🐕', why: `${obj} 덕후예요` };
    for (const [re, style] of PLACE_HINT) {
      if (re.test(obj) && !w.places.some((p) => p.style === style && Math.hypot((p.tx + p.tw / 2) * 32 - a.x, (p.ty + p.th / 2) * 32 - a.y) < 400))
        return { text: `${a.name} 근처에 ${pick(PLACE_ADJ)} ${STYLE_LABEL[style]} 배치`, icon: '🏠', why: `${josa(obj, '을/를')} 좋아하는데 근처에 없어요` };
    }
    if (obj.length <= 10) return { text: `${josa(obj, '을/를')} 좋아하는 대학생 소환`, icon: '👤', why: `${josa(a.name, '와/과')} 말이 통할 윌` };
  }
  return null;
}

function relationsOf(w: World, a: Agent) {
  return [...w.relations.values()]
    .filter((r) => r.a === a.id || r.b === a.id)
    .map((r) => ({ r, o: w.agent(r.a === a.id ? r.b : r.a) }))
    .filter((x): x is { r: (typeof x)['r']; o: Agent } => !!x.o && x.o.kind === 'person');
}

function forWill(w: World, a: Agent): Suggestion[] {
  const out: Suggestion[] = [];
  const rels = relationsOf(w, a);
  const mine = (o: Agent) => w.feel(a.id, o.id);
  const friend = [...rels].sort((x, y) => mine(y.o) - mine(x.o))[0];
  const enemy = rels.filter((x) => Math.min(mine(x.o), w.feel(x.o.id, a.id)) <= -15).sort((x, y) => x.r.affinity - y.r.affinity)[0];
  const care = careSpawn(w, a);
  if (a.mood < 45 && care) out.push(care);
  if (a.mood < 35) out.push({ text: `${a.name}에게 축복`, icon: '✨', why: '무드가 낮아요' });
  if (enemy) out.push({ text: `${josa(a.name, '와/과')} ${josa(enemy.o.name, '이/가')} 마주치게 해줘`, icon: '⚔️', why: '사이가 좋지 않아요 — 화해할까요, 싸울까요?' });
  else if (friend && mine(friend.o) >= 30) out.push({ text: `${josa(a.name, '와/과')} ${josa(friend.o.name, '이/가')} 마주치게 해줘`, icon: '👣', why: '가장 가까운 사이예요' });
  else {
    // someone with a shared interest they haven't really met
    const stranger = w.agents.find((b) => b.kind === 'person' && b !== a && !w.peekRelation(a.id, b.id) && b.traits.some((t) => a.traits.some((u) => w.matcher.similarity(t, u) > 0.45)));
    if (stranger) out.push({ text: `${josa(a.name, '와/과')} ${josa(stranger.name, '이/가')} 마주치게 해줘`, icon: '👣', why: '취향이 비슷한데 아직 모르는 사이' });
  }
  if (!a.jobId) {
    const work = w.places.filter((p) => p.workSpots.length > w.agents.filter((x) => x.jobId === p.id).length);
    if (work.length) {
      const p = pick(work);
      out.push({ text: `${josa(a.name, '을/를')} ${p.name}에서 일하게 해줘`, icon: '💼', why: '아직 일자리가 없어요' });
    }
  }
  out.push({ text: rumorCmd(a.name, pick(Math.random() < 0.6 ? RUMOR_GOOD : RUMOR_SPICY)), icon: '🤫', why: '소문은 대화를 타고 퍼져요' });
  out.push({ text: `${a.name}에게 "${pick(SPICE_TRAITS)}" 특성 추가`, icon: '📝', why: '새로운 면모 쓰기' });
  if (a.mood >= 45 && care) out.push(care);
  out.push({ text: `${a.name}에게 선물`, icon: '🎁', why: '좋아하는 것을 몰래 두고 와요' });
  if (a.traits.some((t) => /(노래|기타|음악|가수|밴드|피아노|춤)/.test(t)) && Math.random() < 0.6) out.push({ text: `${a.name} 버스킹 시켜 줘`, icon: '🎸', why: '음악을 좋아해요 — 사람들이 모일까요?' });
  else if (Math.random() < 0.35) out.push({ text: `${a.name} 생일 축하해 줘`, icon: '🎂', why: '친구들이 축하하러 와요' });
  out.push({ text: `${a.name} 따라가`, icon: '🎥' });
  return out;
}

function forAnimal(w: World, b: Agent): Suggestion[] {
  const sp = SPECIES_LABEL[b.layers.species];
  const fan = w.agents.filter((a) => a.kind === 'person' && w.favor(a, b) >= 0.45 && a.mood < 50)[0];
  const out: Suggestion[] = [];
  if (fan) out.push({ text: `${josa(fan.name, '와/과')} ${josa(b.name, '이/가')} 마주치게 해줘`, icon: '💞', why: `${josa(fan.name, '은/는')} ${josa(sp, '을/를')} 좋아하는데 기운이 없어요` });
  out.push({ text: `${b.name} 옆에 ${josa(sp, '을/를')} 좋아하는 학생 소환`, icon: '👤', why: `${b.name}의 새 친구` });
  out.push({ text: rumorCmd(b.name, pick(ANIMAL_RUMOR)), icon: '🤫' });
  out.push({ text: `${b.name} 옆에 ${pick(['검은', '하얀', '삼색', '회색'])} ${sp} 소환`, icon: '🐾', why: '친구를 만들어 줘요' });
  out.push({ text: `${b.name} 따라가`, icon: '🎥' });
  return out;
}

function forPlace(w: World, p: Place): Suggestion[] {
  const out: Suggestion[] = [];
  const pool = poolFor(w.meta.context);
  const like = pick(pool.likes);
  const role = pick(pool.roles);
  const jobless = w.agents.filter((a) => a.kind === 'person' && !a.jobId);
  if (p.workSpots.length > w.agents.filter((a) => a.jobId === p.id).length && jobless.length)
    out.push({ text: `${josa(pick(jobless).name, '을/를')} ${p.name}에서 일하게 해줘`, icon: '💼', why: '일손이 비어 있어요' });
  out.push({ text: `${p.name} 옆에 ${josa(like, '을/를')} 좋아하는 ${role} 소환`, icon: '👤', why: '새 손님' });
  out.push({ text: rumorCmd(p.name, pick(PLACE_RUMOR)), icon: '🤫' });
  out.push({ text: `${p.name}에 번개 내리기`, icon: '⚡', why: '사건이 필요할 때' });
  out.push({ text: `${p.name} 옆에 작은 길고양이 소환`, icon: '🐈' });
  return out;
}

function forWorld(w: World): Suggestion[] {
  const out: Suggestion[] = [];
  const people = w.agents.filter((a) => a.kind === 'person');
  const saddest = [...people].sort((x, y) => x.mood - y.mood)[0];
  if (saddest && saddest.mood < 40) {
    const c = careSpawn(w, saddest);
    if (c) out.push({ ...c, why: `${saddest.name}의 무드가 ${Math.round(saddest.mood)}이에요` });
  }
  // tension pair
  const tense = [...w.relations.values()].filter((r) => r.affinity <= -15).sort((x, y) => x.affinity - y.affinity)[0];
  if (tense) {
    const A = w.agent(tense.a), B = w.agent(tense.b);
    if (A && B) out.push({ text: `${josa(A.name, '와/과')} ${josa(B.name, '이/가')} 마주치게 해줘`, icon: '⚔️', why: '앙금이 남은 두 윌' });
  }
  const trend = w.globalTrends(1)[0];
  if (trend) {
    const subj = trend.rumor.about.map((id) => w.agent(id)).find((a) => a?.kind === 'person');
    if (subj) out.push({ text: `${subj.name} 따라가`, icon: '🔥', why: `지금 1위 ${trend.rumor.tag}의 주인공` });
  }
  const weather = w.meta.weather;
  out.push(
    weather === 'clear'
      ? { text: pick(['갑자기 소나기가 내리게 해줘', '눈 내리게 해줘']), icon: '🌧️', why: '비를 좋아하는 윌, 싫어하는 윌' }
      : { text: '비 그치게 해줘', icon: '☀️', why: '하늘을 개게' },
  );
  const pool = poolFor(w.meta.context);
  const like = pick(pool.likes);
  out.push({ text: `${josa(like, '을/를')} 좋아하는 ${pick(pool.roles)} 소환`, icon: '👤', why: '새로운 윌' });
  if (people.length >= 2) {
    const [a, b] = [...people].sort(() => Math.random() - 0.5);
    out.push({ text: rumorCmd(a.name, pick(RUMOR_SPICY)), icon: '🤫', why: `${b.name}도 곧 듣게 될지도` });
  }
  const h = (w.meta.minutes % 1440) / 60;
  const night = h >= 19.5 || h < 5;
  out.push(
    night
      ? pick([{ text: '유성우 내려 줘', icon: '🌠', why: '모두가 소원을 빌어요' }, { text: '정전 일으켜', icon: '🔌', why: '어둠 속에서 누군가는 별을 봐요' }])
      : pick([{ text: '동네 축제 열어 줘', icon: '🎉', why: '다 같이 모여 노는 날' }, { text: '하늘에 무지개 띄워 줘', icon: '🌈', why: '모두 고개를 들어요' }]),
  );
  if (Math.random() < 0.35) out.push({ text: `세계관을 ${pick(['중세 판타지', '좀비 아포칼립스', '사이버펑크 도시'].filter((c) => c !== w.meta.context))}로 변경`, icon: '🌍', why: '세상을 통째로 바꾸기' });
  return out;
}

export function suggest(w: World, selectedId: string | null, max = 5): { title: string; items: Suggestion[] } {
  const a = w.agent(selectedId ?? undefined);
  const p = a ? undefined : w.place(selectedId ?? undefined);
  const raw = a ? (a.kind === 'person' ? forWill(w, a) : forAnimal(w, a)) : p ? forPlace(w, p) : forWorld(w);
  const title = a ? `${a.name}에게 해 줄 수 있는 일` : p ? `${p.name}에 일으킬 수 있는 일` : '지금 이 세계에 써 볼 만한 문장';
  // keep only sentences the parser understands; de-dupe; first items are the most situational
  const seen = new Set<string>();
  const items: Suggestion[] = [];
  for (const s of raw) {
    if (seen.has(s.text) || !parseCommand(s.text, selectedId)) continue;
    seen.add(s.text);
    items.push(s);
    if (items.length >= max) break;
  }
  return { title, items };
}
