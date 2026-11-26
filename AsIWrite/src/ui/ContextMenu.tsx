import { useEffect, useRef, useState } from 'react';
import type { Game } from '../engine/Game';
import type { Agent, Place } from '../engine/types';
import { josa } from '../engine/traits';

type Item = { icon: string; label: string; run: () => void; danger?: boolean };

/**
 * Right-click menu on a Will, an animal or a building. Everything here also exists elsewhere
 * (toolbar, inspector, chat) — this is just the quickest way to reach it.
 */
export function ContextMenu({ game, targetId, x, y, onClose, onOpenTab }: { game: Game; targetId: string; x: number; y: number; onClose: () => void; onOpenTab: (tab: 'status' | 'talk' | 'traits' | 'relations' | 'sheet') => void }) {
  const w = game.world;
  const e: Agent | Place | undefined = w.agent(targetId) ?? w.place(targetId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(e?.name ?? '');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => game.noteUi('contextmenu'), [game]);
  useEffect(() => {
    const away = (ev: PointerEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  if (!e) return null;
  const act = (f: () => void) => () => {
    f();
    onClose();
  };
  const run = (cmd: Parameters<Game['dispatch']>[0]) => game.toast(game.dispatch(cmd));
  const pickThen = (label: string, done: (other: Agent | Place) => void, accept: (o: Agent | Place) => boolean) => {
    game.tool = {
      label,
      build: () => null,
      run: (px, py) => {
        const hit = w.agentsAt(px, py, 20) ?? w.placeAt(px, py);
        if (!hit || !accept(hit)) return { ok: false, message: '그 대상은 고를 수 없어요. 다시 클릭하거나 Esc로 취소하세요.' };
        done(hit);
        return { ok: true, message: '' };
      },
    };
    game.notify(true);
  };

  const items: Item[] = [];
  if (e.kind === 'place') {
    items.push(
      { icon: '✋', label: '옮기기', run: act(() => game.startMove(e)) },
      { icon: '✏️', label: '이름 바꾸기', run: () => setRenaming(true) },
      { icon: '📋', label: '정보 · 기록 보기', run: act(() => onOpenTab('status')) },
    );
    if (e.style === 'home') {
      const residents = w.residentsOf(e);
      items.push({ icon: '🏠', label: residents.length ? `사는 윌: ${residents.map((r) => r.name).join(', ')}` : '아직 사는 윌이 없어요', run: act(() => residents[0] && game.focus(residents[0].id)) });
    }
    items.push(
      { icon: '🎪', label: '여기서 축제 열기', run: act(() => run({ type: 'WORLD_EVENT', event: 'FESTIVAL', target: { id: e.id } })) },
      { icon: '⚡', label: '번개 내리기', run: act(() => run({ type: 'TRIGGER_EVENT', event: 'LIGHTNING', targets: [{ id: e.id }] })) },
      { icon: '🗑', label: '지우기 (Ctrl+Z로 되돌릴 수 있어요)', danger: true, run: act(() => run({ type: 'DELETE_ENTITY', target: { id: e.id } })) },
    );
  } else {
    items.push({ icon: '🎥', label: '따라가기', run: act(() => run({ type: 'SYSTEM', action: 'FOLLOW', target: { id: e.id } })) }, { icon: '✋', label: '옮기기', run: act(() => game.startMove(e)) });
    if (e.kind === 'person') {
      items.push(
        { icon: '💬', label: '말 걸기', run: act(() => onOpenTab('talk')) },
        { icon: '📝', label: '특성 고치기', run: act(() => onOpenTab('traits')) },
        { icon: '🕸', label: '관계 보기', run: act(() => onOpenTab('relations')) },
        {
          icon: '👣',
          label: '다른 윌과 만나게 하기…',
          run: act(() =>
            pickThen(`👣 ${josa(e.name, '이/가')} 만날 윌을 클릭하세요 (Esc 취소)`, (o) => run({ type: 'TRIGGER_EVENT', event: 'MEET', targets: [{ id: e.id }, { id: o.id }] }), (o) => o.kind === 'person' && o.id !== e.id),
          ),
        },
        {
          icon: '🏠',
          label: '살 집 정하기…',
          run: act(() =>
            pickThen(
              `🏠 ${josa(e.name, '이/가')} 살 집을 클릭하세요 (Esc 취소)`,
              (o) => {
                const prev = w.place(e.homeId);
                w.setHome(e, o as Place);
                game.pushUndo({ label: `${e.name} 이사`, undo: () => void (e.homeId = prev?.id) });
                game.toast({ ok: true, message: `🏠 ${josa(e.name, '이/가')} ${o.name}에 살게 됐어요.` });
              },
              (o) => o.kind === 'place' && o.style === 'home',
            ),
          ),
        },
        { icon: '✨', label: '축복', run: act(() => run({ type: 'TRIGGER_EVENT', event: 'BLESS', targets: [{ id: e.id }] })) },
        { icon: '🎁', label: '선물 두기', run: act(() => run({ type: 'TRIGGER_EVENT', event: 'GIFT', targets: [{ id: e.id }] })) },
      );
    } else {
      items.push({ icon: '✏️', label: '이름 바꾸기', run: () => setRenaming(true) });
      const owner = w.agent(e.ownerId);
      if (owner) items.push({ icon: '🏠', label: `${owner.name}의 가족`, run: act(() => game.focus(owner.id)) });
      else
        items.push({
          icon: '🐾',
          label: '입양 보내기… (윌 클릭)',
          run: act(() =>
            pickThen(`🐾 ${josa(e.name, '을/를')} 키울 윌을 클릭하세요 (Esc 취소)`, (o) => run({ type: 'SYSTEM', action: 'ADOPT', value: e.id, target: { id: o.id } }), (o) => o.kind === 'person'),
          ),
        });
    }
    items.push({ icon: '🗑', label: '지우기 (Ctrl+Z로 되돌릴 수 있어요)', danger: true, run: act(() => run({ type: 'DELETE_ENTITY', target: { id: e.id } })) });
  }

  // stay inside the window; a long menu scrolls instead of running off the edge
  const left = Math.max(8, Math.min(x, window.innerWidth - 250)), top = Math.max(8, Math.min(y, window.innerHeight - (items.length * 30 + 60)));
  return (
    <div ref={ref} className="panel scroll-thin pointer-events-auto fixed z-[60] w-60 overflow-y-auto rounded-lg py-1 text-xs shadow-2xl" style={{ left, top, maxHeight: window.innerHeight - top - 8 }} onContextMenu={(ev) => ev.preventDefault()}>
      <div className="truncate border-b border-white/10 px-3 py-1.5 font-serif text-[13px] text-parch">{e.name}</div>
      {renaming ? (
        <form
          className="flex gap-1 p-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (name.trim()) run({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { name: name.trim() } });
            onClose();
          }}
        >
          <input autoFocus value={name} onChange={(ev) => setName(ev.target.value)} className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-parch outline-none focus:border-glow/50" />
          <button className="rounded bg-glow/90 px-2 font-semibold text-ink">확인</button>
        </form>
      ) : (
        items.map((it, i) => (
          <button key={i} onClick={it.run} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10 ${it.danger ? 'text-rose-300' : 'text-parch'}`}>
            <span className="w-4 text-center">{it.icon}</span>
            <span className="truncate">{it.label}</span>
          </button>
        ))
      )}
    </div>
  );
}
