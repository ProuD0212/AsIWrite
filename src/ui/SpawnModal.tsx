import { useState } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import { parseSheet, serializeSheet, type CharacterSheet } from '../engine/sheet';
import type { Gender, PlaceStyle } from '../engine/types';
import { GENDER_LABEL, randomGender } from '../presets/people';
import { parseAppearance, speciesFromText } from '../engine/appearance';
import { STYLE_LABEL } from '../engine/World';
import {
  ANIMAL_KINDS, animalNamePool, randomAnimalKind, randomAppearance, randomName, randomPlace, randomPlaceTrait, randomRole, randomTraits, randomTreasure,
} from '../presets/traitPools';
import { Btn, Modal } from './Modal';
import { SpritePreview } from './SpritePreview';

export type SpawnKind = 'person' | 'animal' | 'place';

const seed = () => Math.floor(Math.random() * 1e9);
const STYLES: PlaceStyle[] = ['cafe', 'restaurant', 'bakery', 'karaoke', 'cinema', 'bar', 'park', 'store', 'flower', 'library', 'school', 'gym', 'hospital', 'office', 'factory', 'home', 'plaza'];
function animalNames(category: string) {
  return animalNamePool(speciesFromText(category) ?? 'cat');
}

function randomSheet(game: Game, kind: 'person' | 'animal'): CharacterSheet {
  const ctx = game.world.meta.context;
  const s = seed();
  if (kind === 'animal') {
    const cat = randomAnimalKind(ctx, s);
    const names = animalNames(cat);
    return { name: names[s % names.length], category: cat, appearance: randomAppearance(ctx, 'animal', cat, s), traits: randomTraits(ctx, 'animal', 3, s), mood: 60 + (s % 25), treasure: randomTreasure(ctx, 'animal', s) };
  }
  const taken = new Set(game.world.agents.map((a) => a.name));
  const gender = randomGender(s);
  return {
    name: randomName(ctx, s, taken, gender), category: '윌', gender, appearance: randomAppearance(ctx, 'person', '윌', s, gender), job: randomRole(ctx, s + 1),
    treasure: randomTreasure(ctx, 'person', s + 2), traits: randomTraits(ctx, 'person', 7, s + 3), mood: 40 + (s % 45),
  };
}

const inputCls = 'min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-parch outline-none focus:border-glow/50';

function Dice({ onClick, title = '무작위' }: { onClick: () => void; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} className="shrink-0 rounded-md border border-white/10 bg-white/8 px-2 text-sm hover:bg-white/15">
      🎲
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs text-parch-dim">
      {label}
      <div className="flex gap-1.5">{children}</div>
    </label>
  );
}

/**
 * GUI path for SPAWN_ENTITY. Produces exactly the same GameCommand the chat
 * bar would, then either drops it at the screen center or arms a placement
 * tool so the next map click decides the position.
 */
export function SpawnModal({ game, kind, onClose }: { game: Game; kind: SpawnKind; onClose: () => void }) {
  const ctx = game.world.meta.context;
  const [sheet, setSheet] = useState<CharacterSheet>(() => (kind === 'place' ? { name: '', category: '', appearance: '', traits: [], mood: 60 } : randomSheet(game, kind)));
  const [tab, setTab] = useState<'form' | 'text'>('form');
  const [text, setText] = useState('');
  const [style, setStyle] = useState<PlaceStyle>('cafe');
  const [place, setPlace] = useState(() => randomPlace('cafe', seed(), ctx));

  const set = (patch: Partial<CharacterSheet>) => setSheet((s) => ({ ...s, ...patch }));
  const isAnimal = kind === 'animal' || (kind === 'person' && parseSheet(serializeSheet(sheet)).kind === 'animal');

  const switchTab = (t: 'form' | 'text') => {
    if (t === 'text') setText(serializeSheet(sheet));
    else setSheet(parseSheet(text).sheet); // text → form
    setTab(t);
  };
  const current = (): CharacterSheet => (tab === 'text' ? parseSheet(text).sheet : sheet);

  const buildCmd = (x?: number, y?: number): GameCommand => {
    const at = x !== undefined && y !== undefined ? { x, y } : undefined;
    if (kind === 'place')
      return { type: 'SPAWN_ENTITY', entity: { kind: 'place', style, name: place.name.trim() || undefined, appearance: place.appearance, traits: place.traits.filter(Boolean) }, at };
    const sh = current();
    const parsed = parseSheet(serializeSheet(sh));
    return { type: 'SPAWN_ENTITY', entity: { kind: parsed.kind, sheet: serializeSheet(sh) }, at };
  };

  const placeOnMap = () => {
    const sh = current();
    const agentKind = parseSheet(serializeSheet(sh)).kind;
    game.tool = {
      label: kind === 'place' ? '건물을 지을 곳을 클릭하세요 (초록 = 지을 수 있음)' : '소환할 곳을 클릭하세요',
      build: (x, y) => buildCmd(x, y),
      ghost:
        kind === 'place'
          ? { kind: 'place', style, name: place.name.trim() || `새 ${STYLE_LABEL[style]}` }
          : { kind: 'agent', layers: parseAppearance(sh.appearance, agentKind, sh.name, sh.category, sh.gender ?? 'other'), person: agentKind === 'person' },
    };
    game.notify(true);
    onClose();
  };
  const spawnNow = () => {
    game.toast(game.dispatch(buildCmd()));
    onClose();
  };

  const title = kind === 'person' ? '👤 윌 소환' : kind === 'animal' ? '🐈 동물 소환' : '🏠 건물 배치';
  const preview = current();
  const warnings = tab === 'text' ? parseSheet(text).warnings : [];

  return (
    <Modal title={title} onClose={onClose} wide>
      {kind !== 'place' ? (
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-1">
              {(['form', 'text'] as const).map((t) => (
                <button key={t} onClick={() => switchTab(t)} className={`rounded-md px-2.5 py-1 text-xs ${tab === t ? 'bg-white/12 text-parch' : 'text-parch-dim hover:text-parch'}`}>
                  {t === 'form' ? '항목별 편집' : '텍스트 양식'}
                </button>
              ))}
              <Btn variant="ghost" className="ml-auto !px-2 !py-0.5 text-xs" onClick={() => (tab === 'text' ? setText(serializeSheet(randomSheet(game, kind))) : setSheet(randomSheet(game, kind)))}>
                🎲 전부 무작위
              </Btn>
            </div>

            {tab === 'form' ? (
              <div className="grid gap-2.5">
                <Field label="이름">
                  <input className={inputCls} value={sheet.name} onChange={(e) => set({ name: e.target.value })} />
                  <Dice onClick={() => set({ name: isAnimal ? animalNames(sheet.category)[seed() % animalNames(sheet.category).length] : randomName(ctx, seed(), new Set(game.world.agents.map((a) => a.name)), sheet.gender) })} />
                </Field>
                <Field label="분류">
                  {kind === 'animal' ? (
                    <select className={inputCls} value={sheet.category} onChange={(e) => set({ category: e.target.value })}>
                      {[...new Set([sheet.category, ...ANIMAL_KINDS])].filter(Boolean).map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  ) : (
                    <input className={inputCls} value={sheet.category} onChange={(e) => set({ category: e.target.value })} />
                  )}
                </Field>
                {!isAnimal && (
                  <Field label="성별 (머리 모양·옷·이름의 기본값에 영향 — 외형에 직접 쓰면 그게 우선)">
                    <select className={inputCls} value={sheet.gender ?? ''} onChange={(e) => set({ gender: (e.target.value || undefined) as Gender | undefined })}>
                      <option value="">정하지 않음 (무작위)</option>
                      {(['female', 'male', 'other'] as const).map((g) => (
                        <option key={g} value={g}>
                          {GENDER_LABEL[g]}
                        </option>
                      ))}
                    </select>
                    <Dice
                      title="성별에 맞춰 이름·외형도 다시"
                      onClick={() => {
                        const g = randomGender(seed());
                        set({ gender: g, name: randomName(ctx, seed(), new Set(game.world.agents.map((a) => a.name)), g), appearance: randomAppearance(ctx, 'person', sheet.category, seed(), g) });
                      }}
                    />
                  </Field>
                )}
                <Field label="외형 (쉼표로 구분 — 바꾸면 미리보기가 바로 바뀌어요)">
                  <input className={inputCls} value={sheet.appearance} onChange={(e) => set({ appearance: e.target.value })} />
                  <Dice onClick={() => set({ appearance: randomAppearance(ctx, isAnimal ? 'animal' : 'person', sheet.category, seed(), sheet.gender) })} />
                </Field>
                {!isAnimal && (
                  <Field label="직업 (비우면 무직 · 빈 일자리에 배정될 수 있어요)">
                    <input className={inputCls} value={sheet.job ?? ''} onChange={(e) => set({ job: e.target.value })} />
                    <Dice onClick={() => set({ job: randomRole(ctx, seed()) })} />
                  </Field>
                )}
                <Field label="💝 애착 물건">
                  <input className={inputCls} value={sheet.treasure ?? ''} onChange={(e) => set({ treasure: e.target.value })} />
                  <Dice onClick={() => set({ treasure: randomTreasure(ctx, isAnimal ? 'animal' : 'person', seed()) })} />
                </Field>
                <div className="grid gap-1 text-xs text-parch-dim">
                  <div className="flex items-center justify-between">
                    <span>성향 및 특성 — 어떤 문장이든 괜찮아요</span>
                    <span className="flex gap-1">
                      <Btn variant="ghost" className="!px-1.5 !py-0.5 text-[11px]" onClick={() => set({ traits: [...sheet.traits, ''] })}>
                        + 직접 쓰기
                      </Btn>
                      <Btn variant="ghost" className="!px-1.5 !py-0.5 text-[11px]" onClick={() => set({ traits: [...sheet.traits, ...randomTraits(ctx, isAnimal ? 'animal' : 'person', 1, seed(), sheet.traits)] })}>
                        🎲 하나 추가
                      </Btn>
                      <Btn variant="ghost" className="!px-1.5 !py-0.5 text-[11px]" onClick={() => set({ traits: randomTraits(ctx, isAnimal ? 'animal' : 'person', isAnimal ? 3 : 7, seed()) })}>
                        🎲 다시 뽑기
                      </Btn>
                    </span>
                  </div>
                  <ul className="scroll-thin grid max-h-52 gap-1 overflow-y-auto pr-1">
                    {sheet.traits.map((t, i) => (
                      <li key={i} className="flex gap-1">
                        <input
                          className={inputCls}
                          value={t}
                          placeholder="예: 비 오는 날이면 옛날 노래를 흥얼거린다"
                          onChange={(e) => set({ traits: sheet.traits.map((x, j) => (j === i ? e.target.value : x)) })}
                        />
                        <Dice title="이 특성만 다시 뽑기" onClick={() => set({ traits: sheet.traits.map((x, j) => (j === i ? randomTraits(ctx, isAnimal ? 'animal' : 'person', 1, seed(), sheet.traits)[0] ?? x : x)) })} />
                        <button className="shrink-0 rounded-md px-2 text-parch-dim hover:bg-rose-500/20 hover:text-rose-200" title="지우기" onClick={() => set({ traits: sheet.traits.filter((_, j) => j !== i) })}>
                          ✕
                        </button>
                      </li>
                    ))}
                    {sheet.traits.length === 0 && <li className="text-parch-dim/70">특성이 없으면 세계관(「{ctx}」)에 맞게 무작위로 붙어요.</li>}
                  </ul>
                </div>
                <label className="grid gap-1 text-xs text-parch-dim">
                  초기 무드 {sheet.mood}
                  <input type="range" min={0} max={100} value={sheet.mood} onChange={(e) => set({ mood: +e.target.value })} />
                </label>
              </div>
            ) : (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  spellCheck={false}
                  className="scroll-thin h-72 w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[13px] leading-relaxed text-parch outline-none focus:border-glow/50"
                />
                <p className="mt-1 text-[11px] text-parch-dim">다른 작품의 캐릭터 양식도 그대로 붙여 넣을 수 있어요. 「항목별 편집」으로 돌아가면 내용이 옮겨져요.</p>
                {warnings.length > 0 && <p className="mt-1 text-xs text-amber-300/90">⚠ {warnings.join(' · ')}</p>}
              </>
            )}
          </div>
          <div className="flex flex-col items-center gap-2">
            <span className="text-xs text-parch-dim">미리보기</span>
            <SpritePreview appearance={preview.appearance} kind={isAnimal ? 'animal' : 'person'} name={preview.name} category={preview.category} gender={preview.gender} mood={preview.mood} size={64} />
            <span className="text-sm text-parch">{preview.name || '이름 없음'}</span>
            <span className="text-xs text-parch-dim">
              {isAnimal ? preview.category || '동물' : `윌${preview.job ? ` · ${preview.job}` : ''}`} · 무드 {preview.mood}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-parch-dim">종류</span>
            <Btn variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => setPlace(randomPlace(style, seed(), ctx))}>
              🎲 전부 무작위
            </Btn>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STYLES.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setStyle(s);
                  setPlace(randomPlace(s, seed(), ctx));
                }}
                className={`rounded-md px-2.5 py-1 text-sm ${style === s ? 'bg-glow text-ink' : 'bg-white/8 text-parch hover:bg-white/14'}`}
              >
                {STYLE_LABEL[s]}
              </button>
            ))}
          </div>
          <Field label="이름">
            <input className={inputCls} value={place.name} onChange={(e) => setPlace({ ...place, name: e.target.value })} />
            <Dice onClick={() => setPlace({ ...place, name: randomPlace(style, seed(), ctx).name })} />
          </Field>
          <Field label="외형 / 분위기">
            <input className={inputCls} value={place.appearance} onChange={(e) => setPlace({ ...place, appearance: e.target.value })} />
            <Dice onClick={() => setPlace({ ...place, appearance: randomPlace(style, seed(), ctx).appearance })} />
          </Field>
          <div className="grid gap-1 text-xs text-parch-dim">
            <div className="flex items-center justify-between">
              <span>특성</span>
              <span className="flex gap-1">
                <Btn variant="ghost" className="!px-1.5 !py-0.5 text-[11px]" onClick={() => setPlace({ ...place, traits: [...place.traits, ''] })}>
                  + 직접 쓰기
                </Btn>
                <Btn variant="ghost" className="!px-1.5 !py-0.5 text-[11px]" onClick={() => setPlace({ ...place, traits: [...place.traits, randomPlaceTrait(style, seed(), place.traits)] })}>
                  🎲 하나 추가
                </Btn>
              </span>
            </div>
            <ul className="grid gap-1">
              {place.traits.map((t, i) => (
                <li key={i} className="flex gap-1">
                  <input className={inputCls} value={t} onChange={(e) => setPlace({ ...place, traits: place.traits.map((x, j) => (j === i ? e.target.value : x)) })} />
                  <Dice title="이 특성만 다시 뽑기" onClick={() => setPlace({ ...place, traits: place.traits.map((x, j) => (j === i ? randomPlaceTrait(style, seed(), place.traits) : x)) })} />
                  <button className="shrink-0 rounded-md px-2 text-parch-dim hover:bg-rose-500/20 hover:text-rose-200" onClick={() => setPlace({ ...place, traits: place.traits.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>
          취소
        </Btn>
        <Btn onClick={spawnNow}>화면 중앙에 {kind === 'place' ? '배치' : '소환'}</Btn>
        <Btn variant="primary" onClick={placeOnMap}>
          📍 지도에서 위치 고르기
        </Btn>
      </div>
    </Modal>
  );
}
