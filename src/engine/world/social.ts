// World · 필요 · 관계(맞지 않음, 잊기, 뒷말)
// These are methods of the World class kept in their own file. They are installed on
// World.prototype at the end of World.ts, so callers keep writing world.someMethod() as before.

import { PLACE_HINT } from '../../presets/placeHints';
import { aversionObject, extractObject, suffix, traitPolarity } from '../traits';
import { type Agent } from '../types';
import { clamp, hashString, pick } from '../util';
import { MEAL_LUNCH, STYLE_LABEL, World } from '../World';

export const socialMethods = {
  // ───────────────────────── needs (필요) ─────────────────────────
  needsOf(this: World, a: Agent) {
    return (a.needs ??= { social: 70, fun: 70, food: 80, rest: 90 });
  },
  /** every ~10 game minutes: needs drift, and what's missing gets said out loud (thoughts, diary, wishes) */
  tickNeeds(this: World, mins: number) {
    const h = mins / 60;
    const people = this.agents.filter((a) => a.kind === 'person');
    for (const a of people) {
      const n = this.needsOf(a);
      const asleep = !!a.ai.sleeping;
      const nobody = people.length <= 1;
      n.social = clamp(n.social + (a.ai.mode === 'chat' ? 10 : asleep ? -0.5 : -6 * (1 + Math.max(0, a.persona.social) * 0.6) * (nobody ? 2.5 : 1)) * h, 0, 100);
      n.fun = clamp(n.fun + (asleep ? 0 : -4) * h, 0, 100);
      n.food = clamp(n.food + (asleep ? -1.5 : -7) * h, 0, 100);
      n.rest = clamp(n.rest + (asleep ? 14 : a.ai.working ? -6 : -4) * h, 0, 100);
      if (asleep) continue;
      const alone = people.length <= 1;
      const say = (key: string, label: string, value: number, line: string, diary: string) => {
        if (this.addThought(a, key, label, value, 70)) {
          if (Math.random() < 0.35) this.say(a, line, { thought: true });
          if (this.simTime - (a.ai.needDiaryAt?.[key] ?? -1e9) > 600) {
            (a.ai.needDiaryAt ??= {})[key] = this.simTime;
            this.log(a, 'diary', diary);
          }
        }
      };
      if (n.social < 30)
        say('need:social', alone ? '말 걸 사람이 아무도 없다' : '요즘 너무 외롭다', -Math.round(4 + (25 - n.social) / 5), alone ? '(이 동네엔… 나 혼자인가.)' : pick(['(누구라도 좋으니 얘기하고 싶다.)', '(오늘 제대로 말한 사람이 하나도 없네.)']), alone ? '이 동네엔 말 걸 사람이 아무도 없다. 누가 이사라도 왔으면.' : '오늘도 제대로 이야기를 나눈 사람이 없다. 조금 외롭다.');
      if (n.fun < 20) say('need:fun', '하루가 너무 지루하다', -3, pick(['(심심해…)', '(뭐 재밌는 일 없나.)']), '할 게 없어서 하루가 길었다.');
      if (n.food < 25) {
        const anyFood = this.places.some((p) => MEAL_LUNCH.includes(p.style));
        if (anyFood) say('need:food', '배가 고프다', -5, '(배고파…)', '배가 고파서 아무것도 손에 안 잡혔다.');
        else say('need:food', '동네에 밥 먹을 데가 없다', -7, '(식당 하나만 있었으면…)', '동네에 밥 먹을 곳이 하나도 없다. 식당이나 빵집 하나만 생겼으면 좋겠다.');
      }
      if (n.rest < 15) say('need:rest', '너무 피곤하다', -5, pick(['(눈꺼풀이 무거워…)', '(조금만 쉬고 싶다.)']), '하루 종일 너무 피곤했다.');
    }
    // wishes, about once a game day per Will: places they'd love that don't exist (yet)
    for (const a of people) {
      if (a.ai.sleeping || Math.random() > (mins / 1440) * 1.5) continue;
      const wish = this.missingWish(a);
      if (!wish) continue;
      if (this.addThought(a, `wish:${wish.key}`, wish.label, -2, 720)) {
        this.say(a, wish.line, { thought: true });
        this.log(a, 'diary', wish.diary);
      }
    }
  },
  /** something a Will likes (or dreams of doing) with no place for it in town */
  missingWish(this: World, a: Agent): { key: string; label: string; line: string; diary: string } | null {
    const styles = new Set(this.places.map((p) => p.style));
    for (const t of a.traits) {
      if (traitPolarity(t) <= 0) continue;
      const hint = PLACE_HINT.find(([re]) => re.test(t));
      if (hint && !styles.has(hint[1])) {
        const name = STYLE_LABEL[hint[1]];
        return { key: hint[1], label: `동네에 ${name}${suffix(name, '이/가')} 있으면 좋겠다`, line: `(${name} 하나만 있으면 좋을 텐데…)`, diary: `이 동네엔 ${name}${suffix(name, '이/가')} 없다. 「${t}」 나한테는 그게 꽤 아쉽다.` };
      }
    }
    if (a.job && this.worksAtAll(a) && !/학생/.test(a.job) && !this.places.some((p) => this.dreamFit(a, p) >= 0.5))
      return { key: 'dream', label: `꿈꾸는 ${a.job} 일을 할 곳이 없다`, line: `(언젠가 ${a.job} 일을 해 보고 싶은데…)`, diary: `${a.job} 일을 하고 싶은데, 이 동네엔 그럴 만한 곳이 없다.` };
    return null;
  },
  // ───────────────────────── relationships: clashes, forgetting, gossip ─────────────────────────
  /** how badly two temperaments / values grate (0..1.5): quiet vs loud, sensitive vs short-tempered, loving what the other can't stand */
  clash(this: World, x: Agent, y: Agent): number {
    const P = x.persona, Q = y.persona;
    const pos = (v: number) => Math.max(0, v);
    let c = 0;
    c += pos(-P.social) * pos(Q.social) * 1.6; // a quiet soul next to a loud one
    c += pos(P.sensitive) * pos(Q.temper) * 1.8; // sensitive vs short-tempered
    c += pos(P.temper) * pos(Q.temper) * 1.2; // two hot heads
    c += pos(P.cheer) * pos(-Q.cheer) * 0.6 + pos(-P.kind) * pos(Q.social) * 0.5;
    // plain chemistry: some pairs just don't click, whatever their traits (fixed per pair, both ways)
    const chem = (hashString(x.id < y.id ? x.id + '|' + y.id : y.id + '|' + x.id) % 1000) / 1000;
    if (chem < 0.18) c += 1.0;
    else if (chem > 0.85) c -= 0.3; // …and some click unusually well
    const hates = x.traits.map(aversionObject).filter(Boolean) as string[];
    if (hates.length) {
      const loves = y.traits.filter((t) => traitPolarity(t) > 0).map(extractObject).filter(Boolean) as string[];
      if (hates.some((d) => loves.some((l) => this.matcher.similarity(d, l) >= 0.7))) c += 0.8;
    }
    return Math.max(-0.3, Math.min(1.5, c));
  },
  /** feelings fade toward neutral when nothing feeds them (lovers fade slowest); a fading couple may split */
  decayRelations(this: World, mins: number) {
    const hours = mins / 60;
    for (const r of this.relations.values()) {
      const k = Math.pow(r.status === 'lovers' ? 0.998 : 0.994, hours);
      r.ab *= k;
      r.ba *= k;
      r.affinity = (r.ab + r.ba) / 2;
      if (r.status === 'lovers' && (r.ab < 35 || r.ba < 35)) this.breakUp(r);
    }
  },
};
