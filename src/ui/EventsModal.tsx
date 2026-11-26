import { useState } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import { WORLD_EVENTS, type WorldEventKind } from '../engine/World';
import { Btn, Modal } from './Modal';

/** 🎪 사건 — trigger world events by clicking (same WORLD_EVENT command the chat bar produces). */
export function EventsModal({ game, onClose }: { game: Game; onClose: () => void }) {
  const w = game.world;
  const people = w.agents.filter((a) => a.kind === 'person').sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const places = w.places.filter((p) => p.style !== 'home');
  const sel = game.selectedId ? w.agent(game.selectedId) : undefined;
  const [who, setWho] = useState<string>(sel?.kind === 'person' ? sel.id : '');
  const [where, setWhere] = useState<string>('');

  const fire = (kind: WorldEventKind, target?: 'person' | 'place') => {
    const id = target === 'person' ? who : target === 'place' ? where : '';
    const cmd: GameCommand = { type: 'WORLD_EVENT', event: kind, ...(id ? { target: { id } } : {}) };
    const r = game.dispatch(cmd);
    game.toast(r);
    if (r.ok) onClose();
  };

  return (
    <Modal title="🎪 사건 일으키기" onClose={onClose} wide>
      <p className="mb-3 text-[11px] leading-relaxed text-parch-dim">
        사건은 가만히 둬도 하루에 한 번쯤 저절로 일어나요. 여기서 직접 일으킬 수도 있어요. 채팅창에 「광장에서 축제 열어 줘」, 「민지 생일 축하해 줘」처럼 써도 돼요.
      </p>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <label className="grid gap-1">
          <span className="text-parch-dim">대상 윌 (👤 사건)</span>
          <select className="border border-white/15 bg-black/30 px-2 py-1 text-parch" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">🎲 무작위</option>
            {people.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-parch-dim">장소 (🎉 축제)</span>
          <select className="border border-white/15 bg-black/30 px-2 py-1 text-parch" value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="">광장 · 공원 자동</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {WORLD_EVENTS.map((e) => (
          <li key={e.kind} className="flex items-center gap-2 border border-white/10 bg-white/5 px-3 py-2">
            <span className="text-xl">{e.icon}</span>
            <span className="flex-1">
              <span className="block text-sm text-parch">
                {e.label}
                {e.target === 'person' && <span className="ml-1 text-[10px] text-parch-dim">👤</span>}
              </span>
              <span className="block text-[11px] text-parch-dim">{e.hint}</span>
            </span>
            <Btn className="!px-2 text-xs" onClick={() => fire(e.kind, e.target)}>
              일으키기
            </Btn>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
