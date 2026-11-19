import { useState } from 'react';
import type { Game } from '../engine/Game';
import { activityOf, moodLabel } from './describe';
import { Modal } from './Modal';

/** 윌 목록 / 동물 목록 — every resident at a glance; click to jump to them. */
export function RosterModal({ game, kind, onClose }: { game: Game; kind: 'person' | 'animal'; onClose: () => void }) {
  const w = game.world;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'name' | 'moodLow' | 'moodHigh'>('name');
  const list = w.agents
    .filter((a) => a.kind === kind)
    .filter((a) => !q.trim() || (a.name + a.job + a.category + a.appearance + a.traits.join(' ')).includes(q.trim()))
    .sort((x, y) => (sort === 'name' ? x.name.localeCompare(y.name, 'ko') : sort === 'moodLow' ? x.mood - y.mood : y.mood - x.mood));
  const total = w.agents.filter((a) => a.kind === kind).length;
  return (
    <Modal title={`${kind === 'person' ? '👥 윌 목록' : '🐾 동물 목록'} (${total})`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap gap-2">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 · 직업 · 특성으로 찾기" className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-parch outline-none focus:border-glow/50" />
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="rounded-md border border-white/10 bg-black/40 px-2 text-sm text-parch">
          <option value="name">이름순</option>
          <option value="moodLow">무드 낮은 순 (돌봄이 필요한 윌)</option>
          <option value="moodHigh">무드 높은 순</option>
        </select>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-parch-dim">{total === 0 ? (kind === 'person' ? '아직 윌이 없어요. N 키나 👤 버튼으로 소환해 보세요.' : '아직 동물이 없어요. Shift N 키나 🐈 버튼으로 소환해 보세요.') : '찾는 조건에 맞는 이가 없어요.'}</p>
      ) : (
        <ul className="scroll-thin grid max-h-[60vh] gap-1 overflow-y-auto pr-1">
          {list.map((a) => {
            const ml = moodLabel(a.mood);
            return (
              <li key={a.id}>
                <button
                  onClick={() => {
                    game.focus(a.id);
                    onClose();
                  }}
                  className={`grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-white/10 ${a.id === game.selectedId ? 'bg-glow/15' : 'bg-white/5'}`}
                >
                  <span className="min-w-0 truncate text-sm text-parch">
                    {a.name} <span className="text-xs text-parch-dim">· {kind === 'person' ? a.job || '직업 없음' : a.category}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs">
                    <span className="h-1.5 w-20 bg-white/10">
                      <span className="block h-full" style={{ width: `${a.mood}%`, background: ml.color }} />
                    </span>
                    <span className="w-[4.5rem] whitespace-nowrap text-right" style={{ color: ml.color }}>
                      {Math.round(a.mood)} {ml.text}
                    </span>
                  </span>
                  <span className="truncate text-[11px] text-parch-dim">{activityOf(w, a)}</span>
                  {kind === 'person' && <span className="text-right font-mono text-[11px] text-parch-dim">{Math.floor(a.money).toLocaleString('ko-KR')}원</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
