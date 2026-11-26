// Names, gender, looks and personality (items 2 & 3 of the 2026-11-26 requests).
import { World } from '../src/engine/World';
import { parseAppearance } from '../src/engine/appearance';
import { explainPersona, personaSentence } from '../src/engine/traits';
import { LexicalMatcher } from '../src/engine/semantic';
import { randomName } from '../src/presets/traitPools';
import { genderFromText } from '../src/presets/people';
import { fillTokens, topicLine } from '../src/presets/banter';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? pass++ : fail++, console.log(c ? 'PASS' : 'FAIL', m));

// names: a big town never needs "김지훈54"
const taken = new Set<string>();
for (let i = 0; i < 400; i++) taken.add(randomName('현대 서울', 1000 + i, taken, i % 2 ? 'female' : 'male'));
ok(taken.size === 400 && [...taken].every((n) => !/\d/.test(n)), `400 unique names, no digits (e.g. ${[...taken].slice(0, 6).join(', ')})`);
const fantasy = randomName('중세 판타지 왕국', 7, new Set(), 'female');
ok(/^[가-힣]+ [가-힣]+$/.test(fantasy), `fantasy names are "이름 성": ${fantasy}`);

// gender words
ok(genderFromText('여자 대학생') === 'female' && genderFromText('할아버지') === 'male' && genderFromText('바리스타') === null, 'gender from words');

// looks follow gender (mostly) unless written
const longF = Array.from({ length: 200 }, (_, i) => parseAppearance('노란 후드티', 'person', `f${i}`, '윌', 'female'));
const longM = Array.from({ length: 200 }, (_, i) => parseAppearance('노란 후드티', 'person', `m${i}`, '윌', 'male'));
const longish = (h: string) => ['long', 'wavy', 'braid', 'bob', 'ponytail', 'bun', 'twintails'].includes(h);
const fl = longF.filter((l) => longish(l.hairShape)).length, ml = longM.filter((l) => longish(l.hairShape)).length;
ok(fl > 140 && ml < 50, `women mostly long hair (${fl}/200), men mostly short (${ml}/200 long)`);
const fs = longF.filter((l) => l.bottom === 'skirt' || l.bottom === 'longSkirt').length, ms = longM.filter((l) => l.bottom === 'skirt' || l.bottom === 'longSkirt').length;
ok(fs > 90 && ms === 0, `skirts: women ${fs}/200, men ${ms}/200`);
const written = parseAppearance('짧게 민 머리, 체크 치마', 'person', 'x', '윌', 'male');
ok(written.hairShape === 'buzz' && written.bottom === 'skirt', 'what the player writes wins over the defaults');
ok(parseAppearance('양갈래 땋은 머리', 'person', 'y', '윌').hairShape === 'braid' && parseAppearance('똥머리', 'person', 'z', '윌').hairShape === 'bun' && parseAppearance('갈색 가르마 머리', 'person', 'w', '윌').hairShape === 'sidePart', 'new hairstyles parse');

// personality: 12 axes, with the sentences that caused them
const m = new LexicalMatcher();
const ex = explainPersona(['농담을 잘한다', '늘 지각한다', '소심하다', '별을 보는 걸 좋아한다', '정이 많다'], m);
ok(ex.persona.humor > 0.25 && ex.persona.diligence < -0.25 && ex.persona.confidence < -0.25 && ex.persona.romance > 0.2 && ex.persona.kind > 0.25, `new axes read from traits: ${JSON.stringify(Object.fromEntries(Object.entries(ex.persona).map(([k, v]) => [k, +v.toFixed(2)])))}`);
ok(ex.why.humor.some((x) => x.trait === '농담을 잘한다'), 'the evidence names the trait');
const s = personaSentence(ex.persona, 3);
ok(!!s && /편이다\.$/.test(s), `summary sentence: ${s}`);

// topic lines never invent places/animals the town doesn't have
ok(fillTokens('{cafe} 라떼 마셔 봤어요?', {}) === null && fillTokens('{cat}{이/가} 귀여워요', { cat: '치즈' }) === '치즈가 귀여워요', 'tokens: missing → skipped, josa follows the name');
const line = topicLine('카페 라떼를 좋아한다', {});
ok(!!line && !/\{/.test(line) && !/물방울/.test(line), `no invented café: ${line}`);

// a town full of Wills: everyone has a gender, nobody numbered
const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 40, places: 8, animals: 6 });
const ps = w.agents.filter((a) => a.kind === 'person');
ok(ps.every((a) => a.gender) && ps.every((a) => !/\d/.test(a.name)), `40 Wills: all have a gender, no numbered names (${ps.filter((a) => a.gender === 'female').length} women)`);
ok(w.sheetOf(ps[0]).includes('[성별]'), 'gender is saved in the sheet');
for (let i = 0; i < 20 * 60; i++) w.update(0.05);
ok(true, 'an hour of play with the new looks and lines runs');

console.log(`=== ${pass} passed, ${fail} failed ===`);
