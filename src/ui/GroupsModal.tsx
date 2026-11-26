import { useState } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import { formatClock } from '../engine/util';
import { Btn, Modal } from './Modal';

/** 🎌 그룹 — every group, its members and history; create / rename / add / remove / disband. */
export function GroupsModal({ game, onClose }: { game: Game; onClose: () => void }) {
  const w = game.world;
  const run = (cmd: GameCommand) => game.toast(game.dispatch(cmd));
  const [open, setOpen] = useState<string | null>(w.factions[0]?.id ?? null);
  const [rename, setRename] = useState('');
  const [creating, setCreating] = useState(w.factions.length === 0);
  const [newName, setNewName] = useState('');
  const [picked, setPicked] = useState<string[]>(game.selectedId && w.agent(game.selectedId)?.kind === 'person' ? [game.selectedId] : []);
  const people = w.agents.filter((a) => a.kind === 'person').sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  return (
    <Modal title={`🎌 그룹 (${w.factions.length})`} onClose={onClose} wide>
      <p className="mb-3 text-[11px] leading-relaxed text-parch-dim">
        윌 4명 이상이 여러 번 함께 어울리고 서로 아끼면 스스로 그룹을 만들어요. 한 윌이 여러 그룹에 들어갈 수 있고, 윌을 선택하면 같은 그룹 멤버들 발밑에 그룹 색 원이 보여요.
      </p>
      {w.factions.length === 0 && !creating && <p className="mb-3 text-sm text-parch-dim">아직 그룹이 없어요. 시간이 지나면 생겨나요.</p>}
      <ul className="mb-3 grid gap-1.5">
        {w.factions.map((f) => {
          const home = w.place(f.homePlaceId);
          const isOpen = open === f.id;
          return (
            <li key={f.id} className="border border-white/10 bg-white/5">
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(isOpen ? null : f.id)}>
                <span className="h-3 w-3 shrink-0" style={{ background: f.color }} />
                <span className="flex-1 text-sm text-parch">{f.name}</span>
                <span className="text-xs text-parch-dim">
                  {f.members.length}명 · {f.origin === 'player' ? '직접 만듦' : '자연 결성'}
                  {home ? ` · 아지트: ${home.name}` : ''}
                </span>
              </button>
              {isOpen && (
                <div className="grid gap-2 border-t border-white/10 px-3 py-2 text-xs">
                  <div className="flex flex-wrap gap-1">
                    {f.members.map((id) => {
                      const a = w.agent(id);
                      return a ? (
                        <span key={id} className="flex items-center gap-1 bg-white/8 px-2 py-0.5">
                          <button className="text-parch hover:underline" onClick={() => game.focus(id)}>
                            {a.name}
                          </button>
                          <button className="text-parch-dim hover:text-rose-300" title="그룹에서 빼기" onClick={() => run({ type: 'GROUP', action: 'REMOVE', group: f.id, members: [{ id }] })}>
                            ✕
                          </button>
                        </span>
                      ) : null;
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <select
                      value=""
                      onChange={(e) => e.target.value && run({ type: 'GROUP', action: 'ADD', group: f.id, members: [{ id: e.target.value }] })}
                      className="border border-white/10 bg-black/40 px-2 py-1 text-xs text-parch"
                    >
                      <option value="">＋ 멤버 추가…</option>
                      {people.filter((p) => !f.members.includes(p.id)).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input value={rename} onChange={(e) => setRename(e.target.value)} placeholder="새 이름 (#…)" className="min-w-0 flex-1 border border-white/10 bg-black/30 px-2 py-1 text-xs text-parch outline-none" />
                    <Btn className="!px-2 !py-1 text-xs" disabled={!rename.trim()} onClick={() => (run({ type: 'GROUP', action: 'RENAME', group: f.id, name: rename }), setRename(''))}>
                      이름 바꾸기
                    </Btn>
                    <Btn variant="danger" className="!px-2 !py-1 text-xs" onClick={() => confirm(`${f.name}을(를) 해산할까요?`) && run({ type: 'GROUP', action: 'DISBAND', group: f.id })}>
                      해산
                    </Btn>
                  </div>
                  <div className="scroll-thin grid max-h-32 gap-0.5 overflow-y-auto">
                    {[...f.logs].reverse().map((l, i) => (
                      <div key={i} className="text-parch/75">
                        <span className="mr-1 text-parch-dim">{formatClock(l.t)}</span>
                        {l.text}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {creating ? (
        <div className="grid gap-2 border border-glow/30 p-3 text-xs">
          <div className="text-sm text-parch">새 그룹 만들기</div>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="이름 (비우면 자동으로 지어요) 예: #야근_동지회" className="border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-parch outline-none" />
          <div className="flex flex-wrap gap-1">
            {people.map((p) => (
              <label key={p.id} className={`flex cursor-pointer items-center gap-1 px-2 py-0.5 ${picked.includes(p.id) ? 'bg-glow/25 text-parch' : 'bg-white/8 text-parch-dim'}`}>
                <input type="checkbox" className="hidden" checked={picked.includes(p.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
                {p.name}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setCreating(false)}>
              취소
            </Btn>
            <Btn
              variant="primary"
              disabled={picked.length < 2}
              onClick={() => {
                run({ type: 'GROUP', action: 'FORM', name: newName.trim() || undefined, members: picked.map((id) => ({ id })) });
                setCreating(false);
                setNewName('');
                setPicked([]);
              }}
            >
              🎌 결성 ({picked.length}명)
            </Btn>
          </div>
        </div>
      ) : (
        <Btn onClick={() => setCreating(true)}>＋ 새 그룹 만들기</Btn>
      )}
    </Modal>
  );
}
