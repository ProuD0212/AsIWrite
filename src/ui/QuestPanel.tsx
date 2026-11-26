import type { Game } from '../engine/Game';
import type { Quest } from '../engine/quests';
import { FloatingPanel } from './FloatingPanel';

const KIND_LABEL: Record<Quest['kind'], string> = { request: '의뢰', goal: '동네 목표', moment: '작은 사건' };

function left(game: Game, q: Quest) {
  const m = Math.max(0, q.expiresAt - game.world.meta.minutes);
  return m >= 1440 ? `${Math.floor(m / 1440)}일 남음` : m >= 60 ? `${Math.floor(m / 60)}시간 남음` : `${Math.ceil(m)}분 남음`;
}

/**
 * 📮 의뢰 · 목표 — what Wills ask for (accept / decline), the current town goal and small moments.
 * Every item is achievable from where the town is; shortcuts dispatch ordinary game commands.
 */
export function QuestPanel({ game, open, setOpen }: { game: Game; open: boolean; setOpen: (f: (v: boolean) => boolean) => void }) {
  const w = game.world;
  const offered = w.quests.filter((q) => q.status === 'offered');
  const active = w.quests.filter((q) => q.status === 'active').sort((x, y) => ['request', 'moment', 'goal'].indexOf(x.kind) - ['request', 'moment', 'goal'].indexOf(y.kind));
  const finished = w.quests.filter((q) => q.status === 'done' || q.status === 'failed').slice(-3).reverse();
  const run = (q: Quest) => q.action && game.toast(game.dispatch(q.action.cmd));
  const who = (id?: string) => {
    const a = w.agent(id);
    return a ? (
      <button className="font-semibold text-glow/90 hover:underline" onClick={() => game.focus(a.id)}>
        {a.name}
      </button>
    ) : null;
  };

  return (
    <FloatingPanel
      id="quests"
      title={
        <span>
          📮 의뢰 · 목표
          {offered.length > 0 && <span className="ml-1.5 animate-pulse rounded-full bg-rose-400/90 px-1.5 text-[10px] font-bold text-ink">새 의뢰 {offered.length}</span>}
          {!open && active.length > 0 && <span className="ml-1.5 text-[11px] text-parch-dim">진행 중 {active.length}</span>}
        </span>
      }
      collapsed={!open}
      onCollapse={() => setOpen((v) => !v)}
      defaultRect={() => ({ x: Math.max(68, Math.min(window.innerWidth - 700, 430)), y: 12, w: 340, h: 240 })}
      minW={260}
      minH={120}
      headerExtra={open && <span className="text-[10px] text-parch-dim">완료 {w.questsDone}</span>}
    >
      <div className="scroll-thin absolute inset-0 space-y-1.5 overflow-y-auto px-2.5 py-2 text-[12px]">
        {offered.map((q) => (
          <div key={q.id} className="border border-rose-300/40 bg-rose-300/10 px-2 py-1.5">
            <div className="flex items-center gap-1">
              <span>{q.icon}</span>
              <b className="flex-1 text-parch">{q.title}</b>
              <span className="text-[10px] text-parch-dim">{left(game, q)}</span>
            </div>
            <p className="my-1 font-serif leading-snug text-parch/85">
              {who(q.from)}: “{q.text}”
            </p>
            <div className="flex gap-1">
              <button className="flex-1 bg-emerald-400/25 py-0.5 text-emerald-100 hover:bg-emerald-400/40" onClick={() => (w.acceptQuest(q.id), game.notify(true))}>
                ✅ 수락
              </button>
              <button className="flex-1 bg-white/8 py-0.5 text-parch-dim hover:bg-white/15" onClick={() => (w.declineQuest(q.id), game.notify(true))}>
                거절
              </button>
            </div>
          </div>
        ))}
        {active.map((q) => {
          const p = w.questProgress(q);
          return (
            <div key={q.id} className={`border px-2 py-1.5 ${q.kind === 'goal' ? 'border-glow/30 bg-glow/5' : q.kind === 'moment' ? 'border-sky-300/30 bg-sky-300/5' : 'border-white/10 bg-white/5'}`}>
              <div className="flex items-center gap-1">
                <span>{q.icon}</span>
                <b className="flex-1 text-parch">{q.title}</b>
                <span className="text-[10px] text-parch-dim">{KIND_LABEL[q.kind]} · {left(game, q)}</span>
              </div>
              <p className="mt-0.5 leading-snug text-parch-dim">
                {q.from && q.kind === 'request' && <>{who(q.from)}의 부탁 — </>}
                {q.kind === 'request' ? q.text.replace(/\s*$/, '') : q.text}
              </p>
              {p !== null && (
                <div className="mt-1 h-1.5 bg-white/10">
                  <div className="h-full bg-glow/70 transition-all" style={{ width: `${Math.round(p * 100)}%` }} />
                </div>
              )}
              {q.action && (
                <button className="mt-1 w-full bg-white/10 py-0.5 text-parch hover:bg-white/20" onClick={() => run(q)}>
                  {q.action.label}
                </button>
              )}
            </div>
          );
        })}
        {!offered.length && !active.length && <div className="py-2 text-parch-dim/70">지금은 부탁도 목표도 없어요. 시간이 조금 지나면 윌들이 찾아올 거예요.</div>}
        {finished.length > 0 && (
          <div className="border-t border-white/10 pt-1 text-[11px] text-parch-dim">
            {finished.map((q) => (
              <div key={q.id} className="truncate">
                {q.status === 'done' ? '✔️' : '⌛'} {q.title}
              </div>
            ))}
          </div>
        )}
      </div>
    </FloatingPanel>
  );
}
