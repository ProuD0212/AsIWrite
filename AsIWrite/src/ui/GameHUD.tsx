import { useEffect, useRef, useState } from 'react';
import type { Game } from '../engine/Game';
import { formatClock } from '../engine/util';
import type { World } from '../engine/World';
import { Inspector } from './Inspector';
import { HelpModal, LoadModal, MeetModal, SettingsModal, WorldModal } from './Modals';
import { SpawnModal } from './SpawnModal';
import { RosterModal } from './RosterModal';
import { GroupsModal } from './GroupsModal';
import { ResearchPanel } from './ResearchPanel';
import { Toolbar, type ToolbarModal } from './Toolbar';
import { TrendPanel } from './TrendPanel';
import { useGameTick } from './useGame';
import { embeddings } from '../ai/embeddings';
import { Storyteller, storyteller } from '../ai/storyteller';
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
        <span className="ml-1" title={embeddings.error || '다국어 MiniLM 임베딩 (의미 비교)'}>· 🧠 {embeddings.state === 'ready' ? `MiniLM 준비됨 (${embeddings.size}개)` : embeddings.state === 'loading' ? `MiniLM 내려받는 중 ${Math.round(embeddings.progress * 100)}%` : embeddings.state === 'error' ? 'MiniLM 실패 → 어휘 모드' : '어휘 모드'}</span>
        <span className="ml-1" title={storyteller.error || 'AI 이야기꾼 (Layer 2 대사 다듬기)'}>· ✨ {storyteller.label()}</span>
        {storyteller.state === 'off' && (
          <button
            className="ml-2 border border-glow/60 bg-glow/15 px-1.5 font-sans text-[10px] text-glow hover:bg-glow/30"
            title="AI 이야기꾼을 켜면 윌들의 말이 성격·관계에 맞게 자연스러워져요 (약 0.5GB, 처음 한 번)"
            onClick={() => {
              Storyteller.setBackendSetting(true);
              storyteller.start();
              game.notify(true);
            }}
          >
            ✨ 이야기꾼 켜기 (권장)
          </button>
        )}
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
        <TimeBtn active={!game.paused && game.speed === 0.5} onClick={() => game.dispatch({ type: 'SYSTEM', action: 'SPEED', value: 0.5 })} label="½" title="느리게 ½배속 (0)" />
        {[1, 2, 3].map((s) => (
          <TimeBtn key={s} active={!game.paused && game.speed === s} onClick={() => game.dispatch({ type: 'SYSTEM', action: 'SPEED', value: s })} label={'▸'.repeat(s)} title={`${s}배속 (${s})`} />
        ))}
      </div>

      <StoryFeed game={game} open={logOpen} setOpen={setLogOpen} />
      <Inspector game={game} nudge={tabNudge} />

      {modal?.type === 'research' && <ResearchPanel game={game} onClose={() => setModal(null)} />}
      {modal?.type === 'groups' && <GroupsModal game={game} onClose={() => setModal(null)} />}
      {modal?.type === 'roster' && <RosterModal game={game} kind={modal.kind} onClose={() => setModal(null)} />}
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

/** clickable name in the story log (top-level so it doesn't remount on every HUD tick) */
function FeedName({ game, id, name, cls = 'text-glow/90' }: { game: Game; id?: string; name?: string; cls?: string }) {
  if (!id || !name) return null;
  return (
    <button className={`font-semibold hover:underline ${cls}`} title="클릭하면 선택" onClick={() => game.focus(id)}>
      {name}
    </button>
  );
}

const FEED_SIZE_KEY = 'asiwrite.feedSize';
function loadFeedSize(): { w: number; h: number } {
  try {
    const v = JSON.parse(localStorage.getItem(FEED_SIZE_KEY) || 'null');
    if (v && v.w > 0 && v.h > 0) return v;
  } catch {
    /* ignore */
  }
  return { w: 380, h: 190 };
}

/** "대화는 진짜로 출력되어야 함" — every spoken line and event, as a story log. */
function StoryFeed({ game, open, setOpen }: { game: Game; open: boolean; setOpen: (f: (v: boolean) => boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(loadFeedSize);
  const [max, setMax] = useState(false);
  const [stick, setStick] = useState(true); // follow new lines only while the reader is at the bottom
  const [seen, setSeen] = useState(0);
  const all = game.world.feed;
  const items = all.slice(-250);
  const lastT = all.length ? all[all.length - 1].t + ':' + all.length : '';
  const unseen = stick ? 0 : Math.max(0, all.length - seen);

  useEffect(() => {
    const el = ref.current;
    if (el && stick) {
      el.scrollTop = el.scrollHeight;
      setSeen(all.length);
    }
  }, [lastT, stick, open, max]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 6;
    if (atBottom !== stick) setStick(atBottom);
    if (atBottom) setSeen(all.length);
  };

  /** drag the top edge (height), right edge (width) or the corner (both) */
  const startResize = (e: React.PointerEvent, dir: 'h' | 'w' | 'both') => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, s0 = size;
    const move = (ev: PointerEvent) => {
      const w = dir === 'h' ? s0.w : Math.max(280, Math.min(window.innerWidth - 100, s0.w + (ev.clientX - x0)));
      const h = dir === 'w' ? s0.h : Math.max(90, Math.min(window.innerHeight - 140, s0.h - (ev.clientY - y0)));
      setSize({ w, h });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSize((cur) => {
        try {
          localStorage.setItem(FEED_SIZE_KEY, JSON.stringify(cur));
        } catch {
          /* ignore */
        }
        return cur;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const w = max ? Math.min(760, window.innerWidth - 100) : size.w;
  const h = max ? window.innerHeight - 170 : size.h;

  return (
    <div className="panel pointer-events-auto absolute bottom-3 left-[68px] flex flex-col overflow-hidden text-xs" style={{ width: w, maxWidth: 'calc(100vw - 90px)' }}>
      {open && !max && (
        <>
          <div className="absolute left-0 right-3 top-0 z-10 h-1.5 cursor-ns-resize hover:bg-glow/30" onPointerDown={(e) => startResize(e, 'h')} title="위아래로 끌어서 크기 조절" />
          <div className="absolute bottom-0 right-0 top-3 z-10 w-1.5 cursor-ew-resize hover:bg-glow/30" onPointerDown={(e) => startResize(e, 'w')} />
          <div className="absolute right-0 top-0 z-10 h-3 w-3 cursor-nesw-resize hover:bg-glow/40" onPointerDown={(e) => startResize(e, 'both')} />
        </>
      )}
      <div className="flex items-center justify-between px-3 py-1.5 text-parch-dim">
        <button className="font-serif text-[13px] text-parch hover:text-glow" onClick={() => setOpen((v) => !v)}>
          📜 이야기 {open ? '▾' : '▴'}
        </button>
        {open && (
          <button className="rounded px-1.5 hover:bg-white/10 hover:text-parch" onClick={() => setMax((v) => !v)} title="크게 보기 / 원래대로">
            {max ? '🗗 원래대로' : '🗖 크게'}
          </button>
        )}
      </div>
      {open && (
        <div className="relative">
          <div ref={ref} onScroll={onScroll} className="scroll-thin overflow-y-auto px-3 pb-2" style={{ height: h }}>
            {items.length === 0 && <div className="py-2 text-parch-dim/70">아직 아무 일도 일어나지 않았어요.</div>}
            {items.map((f, i) => (
              <div key={all.length - items.length + i} className="py-0.5 leading-relaxed">
                <span className="mr-1.5 text-parch-dim/70">{formatClock(f.t).split(' ')[1]}</span>
                {f.kind === 'monologue' && f.speaker ? (
                  <div className="my-1 border-l-2 border-glow/50 bg-white/5 px-2 py-1">
                    <FeedName game={game} id={f.speakerId} name={f.speaker} />
                    {f.to && (
                      <>
                        <span className="mx-1 text-parch-dim">→</span>
                        <FeedName game={game} id={f.toId} name={f.to} cls="text-sky-200" />
                      </>
                    )}
                    <span className="ml-1 text-[10px] text-parch-dim">{f.text.startsWith('(') ? '속마음' : '긴 이야기'}{f.ai ? ' · ✨ AI가 다듬음' : ''}</span>
                    <p className="font-serif text-[12.5px] leading-relaxed text-parch/90">{f.text}</p>
                  </div>
                ) : f.kind === 'line' && f.speaker ? (
                  f.thought ? (
                    <>
                      <FeedName game={game} id={f.speakerId} name={f.speaker} cls="text-glow/70" />
                      <span className="ml-1 text-[10px] text-parch-dim">속마음</span>
                      <span className="ml-1 italic text-parch/60">{f.text}</span>
                    </>
                  ) : (
                    <>
                      <FeedName game={game} id={f.speakerId} name={f.speaker} />
                      {f.to && (
                        <>
                          <span className="mx-1 text-parch-dim">→</span>
                          <FeedName game={game} id={f.toId} name={f.to} cls="text-sky-200" />
                        </>
                      )}
                      <span className="text-parch/90">: “{f.text}”</span>
                      {f.ai && <span className="ml-1 text-[10px] text-glow/70" title="AI 이야기꾼이 다듬은 문장">✨</span>}
                    </>
                  )
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
          {!stick && (
            <button
              className="absolute bottom-2 right-4 border border-glow/50 bg-ink-2/95 px-2 py-0.5 text-[11px] text-glow shadow-lg hover:bg-ink"
              onClick={() => {
                setStick(true);
                const el = ref.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              ↓ 최신 이야기로{unseen ? ` (${unseen})` : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
