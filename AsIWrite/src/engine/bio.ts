// Narrative introductions for EVERY entity — people, animals and places — so
// each one reads like the protagonist of its own story. Phase 1 stitches the
// text sheet into prose with Korean particles; Phase 2 lets the LLM rewrite it
// (this stays as the zero-model fallback).

import { copula, extractDream, extractObject, josa, personaSummary, suffix, traitPolarity } from './traits';
import type { Agent, Place } from './types';
import { hashString, makeRng, pick } from './util';
import { STYLE_LABEL, type World } from './World';

const ADJ: Record<string, string> = {
  내향적: '내향적인', 사교적: '사교적인', 무심함: '무심한', 다정함: '다정한', 온화함: '온화한', 다혈질: '욱하는', 비관적: '비관적인',
  낙천적: '낙천적인', 신중함: '신중한', 호기심: '호기심 많은', 느긋함: '느긋한', 활발함: '활발한', 무던함: '무던한', 예민함: '예민한',
};

/** "고양이를 좋아한다" → "고양이를 좋아하고" (for chaining) */
function connective(t: string): string {
  return t
    .replace(/한다$/, '하고')
    .replace(/있다$/, '있고')
    .replace(/없다$/, '없고')
    .replace(/이다$/, '이고')
    .replace(/는다$/, '고')
    .replace(/다$/, '고');
}

function sentence(t: string) {
  const s = t.trim();
  return /[.!?…]$/.test(s) ? s : s + '.';
}

export function agentBio(w: World, a: Agent): string {
  const rng = makeRng(hashString(a.id + a.traits.join('')));
  const parts: string[] = [];
  const look = a.appearance.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const subject = josa(a.name, '은/는');

  if (a.kind === 'animal') {
    parts.push(`${subject} ${copula(a.category || '동물')}.`);
    if (look.length) parts.push(`생김새는 ${look.slice(0, 3).join(', ')}.`);
    if (a.traits[0]) parts.push(sentence(a.traits[0]));
    if (a.traits[1]) parts.push(`그리고 ${sentence(a.traits[1])}`);
    if (a.treasure) parts.push(`가장 아끼는 것은 ${copula(a.treasure)}.`);
    const fans = w.agents.filter((p) => p.kind === 'person' && w.feel(p.id, a.id) > 10).map((p) => p.name);
    if (fans.length) parts.push(`요즘은 ${fans.slice(0, 3).join(', ')}의 손길을 기억한다.`);
    return parts.join(' ');
  }

  const role = a.job || '';
  const work = w.place(a.jobId);
  const lookStr = look.length ? `${look.slice(0, 2).join(', ')} 차림의 ` : '';
  parts.push(`${subject} ${lookStr}${copula(role || '이 동네의 윌')}.`);
  if (work) parts.push(`${work.name}에서 일한다.`);
  const home = w.place(a.homeId);
  parts.push(home ? `${home.name}에 산다.` : '아직 집이 없다.');

  const likes = a.traits.filter((t) => traitPolarity(t) > 0);
  const dislikes = a.traits.filter((t) => traitPolarity(t) < 0);
  const others = a.traits.filter((t) => traitPolarity(t) === 0 && !extractDream(t));
  const dream = a.traits.map(extractDream).find(Boolean);

  const persona = personaSummary(a.persona, 2);
  if (persona.length) parts.push(`성격은 ${persona.map((p) => ADJ[p] ?? p).join(', ')} 편이다.`);
  if (others.length) parts.push(others.length > 1 ? `${connective(others[0])}, ${sentence(others[1])}` : sentence(others[0]));
  if (likes.length) {
    const objs = likes.map(extractObject).filter(Boolean) as string[];
    if (objs.length >= 2) parts.push(`${objs.slice(0, 3).join(', ')} 같은 것들을 좋아한다.`);
    else parts.push(sentence(likes[0]));
  }
  if (dislikes.length) parts.push(`반면 ${sentence(dislikes[0])}`);
  const groups = w.factionsOf(a.id);
  if (groups.length) parts.push(`요즘은 ${groups.map((g) => g.name).join(', ')} 사람들과 어울린다.`);
  if (a.treasure) parts.push(`늘 ${josa(a.treasure, '을/를')} 소중히 여긴다.`);
  if (dream) parts.push(pick([`남몰래 품은 꿈은 ${dream}.`, `언젠가 ${dream} — 그것이 꿈이다.`], rng()));
  if (others.length > 2) parts.push(sentence(others[2]));

  // living part: current relationships & mood
  const closest = w.agents
    .filter((o) => o !== a && o.kind === 'person' && w.feel(a.id, o.id) >= 40)
    .sort((x, y) => w.feel(a.id, y.id) - w.feel(a.id, x.id))[0];
  if (closest) {
    const back = w.feel(closest.id, a.id);
    parts.push(back >= 40 ? `요즘 가장 가까운 존재는 ${copula(closest.name)}.` : `요즘 ${closest.name}에게 자꾸 마음이 가지만, 상대는 아직 잘 모르는 것 같다.`);
  }
  if (a.mood <= 25) parts.push('요즘 많이 지쳐 보인다.');
  else if (a.mood >= 80) parts.push('요즘 표정이 유난히 밝다.');
  return parts.join(' ');
}

export function placeBio(w: World, p: Place): string {
  const parts: string[] = [];
  const look = p.appearance.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  parts.push(`${josa(p.name, '은/는')} 이 동네의 ${copula(STYLE_LABEL[p.style])}.`);
  if (look.length) {
    const shown = look.slice(0, 3);
    parts.push(`${shown.join(', ')}${suffix(shown[shown.length - 1], '이/가')} 눈에 띈다.`);
  }
  for (const t of p.traits.slice(0, 3)) parts.push(sentence(t));
  const workers = w.agents.filter((a) => a.jobId === p.id).map((a) => a.name);
  if (workers.length) parts.push(`${workers.join(', ')}${suffix(workers[workers.length - 1], '이/가')} 이곳에서 일한다.`);
  const regulars = Object.entries(p.regulars)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => w.agent(id)?.name)
    .filter(Boolean) as string[];
  if (regulars.length) parts.push(`단골손님은 ${regulars.slice(0, 3).join(', ')}.`);
  return parts.join(' ');
}
