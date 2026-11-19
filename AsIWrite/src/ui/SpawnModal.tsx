import { useMemo, useState } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import { parseSheet, serializeSheet } from '../engine/sheet';
import type { PlaceStyle } from '../engine/types';
import { STYLE_LABEL } from '../engine/World';
import { randomAppearance, randomName, randomTraits } from '../presets/traitPools';
import { Btn, Modal } from './Modal';
import { SpritePreview } from './SpritePreview';

export type SpawnKind = 'person' | 'animal' | 'place';

function randomSheet(game: Game, kind: 'person' | 'animal'): string {
  const ctx = game.world.meta.context;
  const seed = Math.floor(Math.random() * 1e9);
  const taken = new Set(game.world.agents.map((a) => a.name));
  if (kind === 'animal') {
    const cat = Math.random() < 0.75 ? '길고양이' : '강아지';
    const names = cat === '길고양이' ? ['나비', '모모', '두부', '보리', '호떡', '루루', '콩이'] : ['초코', '해피', '뭉치', '코코'];
    return serializeSheet({ name: names[seed % names.length], category: cat, appearance: randomAppearance(ctx, 'animal', cat, seed), traits: randomTraits(ctx, 'animal', 3, seed), mood: 60 + (seed % 25) });
  }
  return serializeSheet({ name: randomName(ctx, seed, taken), category: '윌', appearance: randomAppearance(ctx, 'person', '윌', seed), traits: randomTraits(ctx, 'person', 7, seed), mood: 40 + (seed % 45) });
}

const STYLES: PlaceStyle[] = ['cafe', 'karaoke', 'park', 'store', 'library', 'office', 'home', 'plaza'];

/**
 * GUI path for SPAWN_ENTITY. Produces exactly the same GameCommand the chat
 * bar would, then either drops it at the screen center or arms a placement
 * tool so the next map click decides the position.
 */
export function SpawnModal({ game, kind, onClose }: { game: Game; kind: SpawnKind; onClose: () => void }) {
  const [sheet, setSheet] = useState(() => (kind === 'place' ? '' : randomSheet(game, kind)));
  const [placeName, setPlaceName] = useState('');
  const [style, setStyle] = useState<PlaceStyle>('cafe');
  const [placeLook, setPlaceLook] = useState('');
  const [placeTraits, setPlaceTraits] = useState('');

  const parsed = useMemo(() => (kind === 'place' ? null : parseSheet(sheet)), [sheet, kind]);

  const buildCmd = (x?: number, y?: number): GameCommand => {
    const at = x !== undefined && y !== undefined ? { x, y } : undefined;
    if (kind === 'place')
      return {
        type: 'SPAWN_ENTITY',
        entity: { kind: 'place', style, name: placeName.trim() || undefined, appearance: placeLook, traits: placeTraits.split('\n').map((s) => s.replace(/^[-•]\s*/, '').trim()).filter(Boolean) },
        at,
      };
    return { type: 'SPAWN_ENTITY', entity: { kind: parsed!.kind, sheet }, at };
  };

  const placeOnMap = () => {
    game.tool = { label: kind === 'place' ? '건물을 지을 곳을 클릭하세요' : '소환할 곳을 클릭하세요', build: (x, y) => buildCmd(x, y) };
    game.notify(true);
    onClose();
  };
  const spawnNow = () => {
    const r = game.dispatch(buildCmd());
    game.toast(r);
    onClose();
  };

  const title = kind === 'person' ? '👤 윌 소환' : kind === 'animal' ? '🐈 동물 소환' : '🏠 건물 배치';

  return (
    <Modal title={title} onClose={onClose} wide>
      {kind !== 'place' && parsed ? (
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs text-parch-dim">텍스트 양식 — 다른 작품의 캐릭터도 그대로 붙여 넣을 수 있어요</label>
              <Btn variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => setSheet(randomSheet(game, kind))}>
                🎲 무작위
              </Btn>
            </div>
            <textarea
              value={sheet}
              onChange={(e) => setSheet(e.target.value)}
              spellCheck={false}
              className="scroll-thin h-64 w-full resize-y rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[13px] leading-relaxed text-parch outline-none focus:border-glow/50"
            />
            <p className="mt-1 text-[11px] text-parch-dim">
              특성을 비워 두면 세계관(「{game.world.meta.context}」)에 맞는 특성이 무작위로 붙어요. 특성은 어떤 문장이든 괜찮아요.
            </p>
            {parsed.warnings.length > 0 && <p className="mt-1 text-xs text-amber-300/90">⚠ {parsed.warnings.join(' · ')}</p>}
          </div>
          <div className="flex flex-col items-center gap-2">
            <span className="text-xs text-parch-dim">미리보기</span>
            <SpritePreview appearance={parsed.sheet.appearance} kind={parsed.kind} name={parsed.sheet.name} category={parsed.sheet.category} mood={parsed.sheet.mood} size={64} />
            <span className="text-sm text-parch">{parsed.sheet.name}</span>
            <span className="text-xs text-parch-dim">{parsed.kind === 'person' ? '윌' : '동물'} · 무드 {parsed.sheet.mood}</span>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <label className="text-xs text-parch-dim">
            종류
            <div className="mt-1 flex flex-wrap gap-1.5">
              {STYLES.map((s) => (
                <button key={s} onClick={() => setStyle(s)} className={`rounded-md px-2.5 py-1 text-sm ${style === s ? 'bg-glow text-ink' : 'bg-white/8 text-parch hover:bg-white/14'}`}>
                  {STYLE_LABEL[s]}
                </button>
              ))}
            </div>
          </label>
          <label className="text-xs text-parch-dim">
            이름
            <input value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder={`예: 아늑한 ${STYLE_LABEL[style]}`} className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-parch outline-none focus:border-glow/50" />
          </label>
          <label className="text-xs text-parch-dim">
            외형 / 분위기
            <input value={placeLook} onChange={(e) => setPlaceLook(e.target.value)} placeholder="예: 네온사인 간판, 푹신한 소파" className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-parch outline-none focus:border-glow/50" />
          </label>
          <label className="text-xs text-parch-dim">
            특성 (한 줄에 하나)
            <textarea value={placeTraits} onChange={(e) => setPlaceTraits(e.target.value)} placeholder={'예: 함께 열창하면 금방 친해진다\n비 오는 날이면 창가 자리가 인기다'} className="mt-1 h-24 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-parch outline-none focus:border-glow/50" />
          </label>
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
