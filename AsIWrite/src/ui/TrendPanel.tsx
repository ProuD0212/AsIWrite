import { useEffect, useRef, useState } from 'react';
import type { Game } from '../engine/Game';
import { formatClock } from '../engine/util';

/**
 * 🔥 실시간 트렌드. Collapsed: a one-line ticker of #1. Expanded: ranked board.
 * Scope tabs are built so Phase-3 groups can add their own boards next to 🌐 전체.
 */
export function TrendPanel({ game, shifted, open, setOpen, focusSignal }: { game: Game; shifted: boolean; open: boolean; setOpen: (v: boolean) => void; focusSignal: number }) {
  const w = game.world;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal) setTimeout(() => inputRef.current?.focus(), 30);
  }, [focusSignal]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [whisper, setWhisper] = useState<'random' | 'selected'>('random');
  const [scope, setScope] = useState<string>('global');
  const mine = new Set(w.factionsOf(game.selectedId ?? '').map((f) => f.id));
  const groups = [...w.factions].sort((x, y) => Number(mine.has(y.id)) - Number(mine.has(x.id)));
  const validScope = scope === 'global' || w.faction(scope) ? scope : 'global';
  const rows = validScope === 'global' ? w.globalTrends(10) : w.groupTrends(validScope, 10);
  const sel = w.agent(game.selectedId ?? undefined);
  const canWhisper = sel?.kind === 'person';

  const spread = () => {
    const t = text.trim();
    if (!t) return;
    game.toast(game.dispatch({ type: 'SPREAD_RUMOR', text: t, whisperTo: whisper === 'selected' && canWhisper ? [{ id: sel!.id }] : undefined }));
    setText('');
  };

  const pos = shifted ? 'right-[356px] max-lg:hidden' : 'right-3';
  if (!open) {
    const top = rows[0];
    return (
      <button onClick={() => setOpen(true)} className={`panel pointer-events-auto absolute top-12 ${pos} flex max-w-[300px] items-center gap-2 rounded-xl px-3 py-1.5 text-left text-xs`}>
        <span>🔥</span>
        {top ? (
          <span className="truncate text-parch">
            <b className="text-glow">1위</b> {top.rumor.tag}
          </span>
        ) : (
          <span className="text-parch-dim">실시간 트렌드</span>
        )}
        <span className="ml-auto text-parch-dim">▾</span>
      </button>
    );
  }

  return (
    <div className={`panel pointer-events-auto absolute top-12 ${pos} z-30 flex w-[320px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl text-xs shadow-xl`}>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="font-serif text-[13px] text-parch">🔥 실시간 트렌드</span>
        <div className="scroll-thin ml-2 flex min-w-0 gap-1 overflow-x-auto">
          <button onClick={() => setScope('global')} className={`shrink-0 px-2 py-0.5 ${validScope === 'global' ? 'bg-white/12 text-parch' : 'text-parch-dim hover:text-parch'}`}>
            🌐 전체
          </button>
          {groups.length === 0 && (
            <span className="shrink-0 px-2 py-0.5 text-parch-dim/60" title="윌들이 그룹을 이루면 그룹별 트렌드가 생겨요">
              그룹별
            </span>
          )}
          {groups.map((f) => (
            <button key={f.id} onClick={() => setScope(f.id)} title={mine.has(f.id) ? '선택한 윌의 그룹' : ''} className={`flex shrink-0 items-center gap-1 px-2 py-0.5 ${validScope === f.id ? 'bg-white/12 text-parch' : 'text-parch-dim hover:text-parch'}`}>
              <span className="h-2 w-2" style={{ background: f.color }} />
              {f.name}
            </button>
          ))}
        </div>
        <button className="ml-auto text-parch-dim hover:text-parch" onClick={() => setOpen(false)}>
          ▴
        </button>
      </div>
      <ol className="scroll-thin max-h-[46vh] overflow-y-auto px-1 py-1">
        {rows.length === 0 && <li className="px-2 py-3 text-parch-dim/80">{validScope === 'global' ? '아직 동네 전체에 퍼진 소문은 없어요. 윌들이 이야기를 나누다 보면 생겨나요.' : '이 그룹 안에서 도는 소문은 아직 없어요.'}</li>}
        {rows.map(({ rumor: r, rank, delta, reach }) => (
          <li key={r.id} className="rounded-md hover:bg-white/5">
            <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
              <span className={`w-4 text-right font-mono ${rank <= 3 ? 'text-glow' : 'text-parch-dim'}`}>{rank}</span>
              <span className="w-8 text-center font-mono text-[10px]">
                {delta === 'new' ? <span className="text-rose-300">NEW</span> : delta > 0 ? <span className="text-emerald-300">▲{delta}</span> : delta < 0 ? <span className="text-sky-300">▼{-delta}</span> : <span className="text-parch-dim/60">–</span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-parch">{r.tag}</span>
              {r.origin === 'player' && <span title="내가 퍼뜨린 소문">🤫</span>}
              <span className="text-parch-dim">{r.knownBy.length}명</span>
            </button>
            <div className="mx-2 mb-1 h-0.5 overflow-hidden rounded-full bg-white/8">
              <div className="h-full bg-glow/70" style={{ width: `${Math.min(100, reach * 100)}%` }} />
            </div>
            {expanded === r.id && (
              <div className="mx-2 mb-2 rounded bg-black/25 p-2 leading-relaxed">
                <p className="font-serif text-[13px] text-parch/90">“{r.text}”</p>
                <div className="mt-1 text-[11px] text-parch-dim">
                  {formatClock(r.born)} 시작 · {r.origin === 'player' ? '누군가 몰래 퍼뜨림' : '자연 발생'} · 동네의 {Math.round(reach * 100)}%가 알고 있음
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {r.about.map((id) => {
                    const e = w.agent(id) ?? w.place(id);
                    return e ? (
                      <button key={id} className="rounded-full bg-white/8 px-2 py-0.5 text-parch hover:bg-white/15" onClick={() => game.focus(id)}>
                        {e.name}
                      </button>
                    ) : null;
                  })}
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="border-t border-white/10 p-2">
        <div className="flex gap-1.5">
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && spread()} placeholder="소문 퍼뜨리기 — 예: 김민수가 복권에 당첨됐다" className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-parch outline-none focus:border-glow/50" />
          <button onClick={spread} className="rounded-md bg-white/10 px-2 text-parch hover:bg-white/18">
            🤫
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-parch-dim">
          누구에게?
          <label className="flex items-center gap-1">
            <input type="radio" checked={whisper === 'random'} onChange={() => setWhisper('random')} /> 아무에게나
          </label>
          <label className={`flex items-center gap-1 ${canWhisper ? '' : 'opacity-40'}`}>
            <input type="radio" disabled={!canWhisper} checked={whisper === 'selected' && canWhisper} onChange={() => setWhisper('selected')} /> {canWhisper ? sel!.name : '선택한 윌'}
          </label>
        </div>
      </div>
    </div>
  );
}
