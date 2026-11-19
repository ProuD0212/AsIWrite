import { useEffect, useRef, useState } from 'react';
import type { Game } from '../engine/Game';
import { formatClock } from '../engine/util';
import type { World } from '../engine/World';
import { Inspector } from './Inspector';
import { HelpModal, LoadModal, MeetModal, SettingsModal, WorldModal } from './Modals';
import { SpawnModal } from './SpawnModal';
import { Toolbar, type ToolbarModal } from './Toolbar';
import { TrendPanel } from './TrendPanel';
import { useGameTick } from './useGame';
import { useShortcuts } from './useShortcuts';

const WEATHER_ICON = { clear: '☀️', rain: '🌧️', snow: '❄️', storm: '⛈️' } as const;

export function GameHUD({ game, onQuit, onLoadWorld, modal, setModal, onExample, onFocusChat }: { game: Game; onQuit: () => void; onLoadWorld: (w: World) => void; modal: ToolbarModal | null; setModal: (m: ToolbarModal | null) => void; onExample: (s: string) => void; onFocusChat: () => void }) {
  useGameTick(game);
  const [trendOpen, setTrendOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  const [tabNudge, setTabNudge] = useState({ id: 0, dir: 1 });
  const [rumorFocus, setRumorFocus] = useState(0);
  useShortcuts(game, { setModal, onFocusChat, setTrendOpen, setLogOpen, setTabNudge, setRumorFocus, modalOpen: !!modal });
  const w = game.world;
  const hour = (w.meta.minutes % 1440) / 60;
  const dayIcon = hour >= 6 && hour < 18 ? '🌤' : '🌙';

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      {/* top-left: clock / weather / world */}
      <div className="panel pointer-events-auto absolute left-3 top-3 flex items-center gap-3 rounded-xl px-3 py-2 text-sm">
        <span title="게임 시각">
          {dayIcon} {formatClock(w.meta.minutes)}
        </span>
        <span title="날씨">{WEATHER_ICON[w.meta.weather]}</span>
        <button className="max-w-[160px] truncate rounded-md bg-white/8 px-2 py-0.5 text-xs text-parch hover:bg-white/15" title="세계관 바꾸기" onClick={() => setModal({ type: 'world' })}>
          🌍 {w.meta.context}
        </button>
      </div>

      {/* top-right: perf (telemetry seed) */}
      <div className="pointer-events-auto absolute right-3 top-3 hidden rounded-lg bg-black/40 px-2 py-1 font-mono text-[10px] text-parch-dim md:block">
        {Math.round(game.fps)} fps · 존재 {w.agents.length} · 대화 {w.convos.length} · AI {w.stats.thinkMs.toFixed(2)}ms
      </div>

      <Toolbar game={game} open={setModal} onQuit={onQuit} />
      <TrendPanel game={game} shifted={!!game.selectedId} open={trendOpen} setOpen={setTrendOpen} focusSignal={rumorFocus} />

      {/* tool banner */}
      {game.tool && (
        <div className="pointer-events-auto absolute left-1/2 top-20 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-glow/90 px-4 py-1.5 text-sm font-medium text-ink shadow-lg">
          {game.tool.label}
          <button
            className="rounded-full bg-black/15 px-2 text-xs"
            onClick={() => {
              game.tool = null;
              game.notify(true);
            }}
          >
            취소 (Esc)
          </button>
        </div>
      )}

      {/* bottom-right: time controls */}
      <div className={`panel pointer-events-auto absolute bottom-3 flex items-center gap-1 rounded-xl p-1 ${game.selectedId ? 'right-[356px] max-md:hidden' : 'right-3'}`}>
        <TimeBtn active={game.paused} onClick={() => game.dispatch({ type: 'SYSTEM', action: game.paused ? 'RESUME' : 'PAUSE' })} label={game.paused ? '▶' : '⏸'} title="일시정지 (Space)" />
        {[1, 2, 3].map((s) => (
          <TimeBtn key={s} active={!game.paused && game.speed === s} onClick={() => game.dispatch({ type: 'SYSTEM', action: 'SPEED', value: s })} label={'▸'.repeat(s)} title={`${s}배속 (${s})`} />
        ))}
      </div>

      <StoryFeed game={game} open={logOpen} setOpen={setLogOpen} />
      <Inspector game={game} nudge={tabNudge} />

      {modal?.type === 'spawn' && <SpawnModal game={game} kind={modal.kind} onClose={() => setModal(null)} />}
      {modal?.type === 'world' && <WorldModal game={game} onClose={() => setModal(null)} />}
      {modal?.type === 'meet' && <MeetModal game={game} onClose={() => setModal(null)} />}
      {modal?.type === 'settings' && <SettingsModal game={game} onClose={() => setModal(null)} />}
      {modal?.type === 'load' && <LoadModal game={game} onLoad={onLoadWorld} onClose={() => setModal(null)} />}
      {modal?.type === 'help' && (
        <HelpModal
          onClose={() => setModal(null)}
          onExample={(s) => {
            setModal(null);
            onExample(s);
          }}
        />
      )}
    </div>
  );
}

function TimeBtn({ label, onClick, active, title }: { label: string; onClick: () => void; active: boolean; title: string }) {
  return (
    <button title={title} onClick={onClick} className={`min-w-9 rounded-lg px-2 py-1 text-sm ${active ? 'bg-glow/25 text-parch' : 'text-parch-dim hover:bg-white/10 hover:text-parch'}`}>
      {label}
    </button>
  );
}

/** "대화는 진짜로 출력되어야 함" — every spoken line and event, as a story log. */
function StoryFeed({ game, open, setOpen }: { game: Game; open: boolean; setOpen: (f: (v: boolean) => boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = game.world.feed.slice(-60);
  const last = items[items.length - 1];
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [last]);
  return (
    <div className="panel pointer-events-auto absolute bottom-3 left-[68px] flex w-[360px] max-w-[calc(100vw-90px)] flex-col overflow-hidden rounded-xl text-xs">
      <button className="flex items-center justify-between px-3 py-1.5 text-parch-dim hover:text-parch" onClick={() => setOpen((v) => !v)}>
        <span className="font-serif text-[13px] text-parch">📜 이야기</span>
        <span>{open ? '접기 ▾' : '펼치기 ▴'}</span>
      </button>
      {open && (
        <div ref={ref} className="scroll-thin h-44 overflow-y-auto px-3 pb-2">
          {items.length === 0 && <div className="py-2 text-parch-dim/70">아직 아무 일도 일어나지 않았어요.</div>}
          {items.map((f, i) => (
            <div key={i} className="py-0.5 leading-relaxed">
              <span className="mr-1.5 text-parch-dim/70">{formatClock(f.t).split(' ')[1]}</span>
              {f.kind === 'monologue' && f.speaker ? (
                <div className="my-1 rounded-md border-l-2 border-glow/50 bg-white/5 px-2 py-1">
                  <button className="font-semibold text-glow/90 hover:underline" onClick={() => f.speakerId && game.focus(f.speakerId)}>
                    {f.speaker}
                  </button>
                  <span className="ml-1 text-[10px] text-parch-dim">{f.text.startsWith('(') ? '속마음' : '긴 이야기'}</span>
                  <p className="font-serif text-[12.5px] leading-relaxed text-parch/90">{f.text}</p>
                </div>
              ) : f.kind === 'line' && f.speaker ? (
                <>
                  <button className="font-semibold text-glow/90 hover:underline" onClick={() => f.speakerId && game.focus(f.speakerId)}>
                    {f.speaker}
                  </button>
                  <span className="text-parch/90">: “{f.text}”</span>
                </>
              ) : (
                <span className={f.kind === 'care' ? 'text-emerald-300' : f.kind === 'break' ? 'text-rose-300' : f.kind === 'rumor' ? 'text-amber-200' : 'text-sky-200/80'}>
                  {f.speakerId ? (
                    <button className="hover:underline" onClick={() => game.focus(f.speakerId!)}>
                      {f.text}
                    </button>
                  ) : (
                    f.text
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
