import { useEffect, useRef, useState } from 'react';
import type { Game } from '../engine/Game';
import { formatClock, weekdayOf } from '../engine/util';
import type { FeedItem, World } from '../engine/World';
import { Inspector, type Tab as InspectorTab } from './Inspector';
import { HelpModal, LoadModal, MeetModal, SettingsModal, WorldModal } from './Modals';
import { SpawnModal } from './SpawnModal';
import { RosterModal } from './RosterModal';
import { GroupsModal } from './GroupsModal';
import { EventsModal } from './EventsModal';
import { ResearchPanel } from './ResearchPanel';
import { Toolbar, type ToolbarModal } from './Toolbar';
import { TrendPanel } from './TrendPanel';
import { useGameTick } from './useGame';
import { embeddings } from '../ai/embeddings';
import { Storyteller, storyteller } from '../ai/storyteller';
import { useShortcuts } from './useShortcuts';
import { EditPalette } from './EditPalette';
import { FloatingPanel } from './FloatingPanel';
import { ContextMenu } from './ContextMenu';
import { Tutorial } from './Tutorial';
import { QuestPanel } from './QuestPanel';

const WEATHER_ICON = { clear: '☀️', rain: '🌧️', snow: '❄️', storm: '⛈️' } as const;

export function GameHUD({ game, onQuit, onLoadWorld, modal, setModal, onExample, onFocusChat, tutorial, onTutorialEnd }: { tutorial?: boolean; onTutorialEnd?: () => void; game: Game; onQuit: () => void; onLoadWorld: (w: World) => void; modal: ToolbarModal | null; setModal: (m: ToolbarModal | null) => void; onExample: (s: string) => void; onFocusChat: () => void }) {
  useGameTick(game);
  const [trendOpen, setTrendOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  const [questOpen, setQuestOpen] = useState(true);
  const [tabNudge, setTabNudge] = useState({ id: 0, dir: 1 });
  const [openTab, setOpenTab] = useState<{ id: number; tab: InspectorTab }>({ id: 0, tab: 'status' });
  // right-click menu on a Will / animal / building
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    game.onContextMenu = (t, at) => setMenu({ id: t.id, x: at.x, y: at.y });
    return () => {
      game.onContextMenu = () => {};
    };
  }, [game]);
  const [rumorFocus, setRumorFocus] = useState(0);
  useShortcuts(game, { setModal, onFocusChat, setTrendOpen, setLogOpen, setQuestOpen, setTabNudge, setRumorFocus, modalOpen: !!modal });
  const w = game.world;
  const hour = (w.meta.minutes % 1440) / 60;
  const dayIcon = hour >= 6 && hour < 18 ? '🌤' : '🌙';

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      {/* top-left: clock / weather / world */}
      <div className="panel pointer-events-auto absolute left-3 top-3 flex items-center gap-3 rounded-xl px-3 py-2 text-sm">
        <span title="게임 시각">
          {dayIcon} {formatClock(w.meta.minutes)} ({weekdayOf(w.meta.minutes).label}){weekdayOf(w.meta.minutes).weekend ? ' 🎈' : ''}
        </span>
        <span title="날씨">{WEATHER_ICON[w.meta.weather]}</span>
        <button className="max-w-[160px] truncate rounded-md bg-white/8 px-2 py-0.5 text-xs text-parch hover:bg-white/15" title="세계관 바꾸기" onClick={() => setModal({ type: 'world' })}>
          🌍 {w.meta.context}
        </button>
        <WorldName game={game} />
      </div>

      {/* top-right: perf (telemetry seed) */}
      <div className="pointer-events-auto absolute right-3 top-3 hidden rounded-lg bg-black/40 px-2 py-1 font-mono text-[10px] text-parch-dim md:block">
        {Math.round(game.fps)} fps · 존재 {w.agents.length} · 대화 {w.convos.length} · AI {w.stats.thinkMs.toFixed(2)}ms
        <span className="ml-1" title={embeddings.error || '한국어 문장 임베딩 ko-sroberta (의미 비교)'}>· 🧠 {embeddings.state === 'ready' ? `의미 모델 준비됨 (${embeddings.size}개)` : embeddings.state === 'loading' ? `의미 모델 내려받는 중 ${Math.round(embeddings.progress * 100)}%` : embeddings.state === 'error' ? '의미 모델 실패 → 글자 비교' : '글자 비교'}</span>
        <span className="ml-1" title={storyteller.error || 'AI 이야기꾼 (Layer 2 대사 다듬기)'}>· ✨ {storyteller.label()}</span>
        {storyteller.state === 'off' && (
          <button
            className="ml-2 border border-glow/60 bg-glow/15 px-1.5 font-sans text-[10px] text-glow hover:bg-glow/30"
            title="AI 이야기꾼을 켜면 윌들의 말이 성격·관계에 맞게 자연스러워져요 (약 2~3GB, 처음 한 번)"
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

      <Toolbar game={game} open={setModal} onQuit={onQuit} onQuests={() => setQuestOpen((v) => !v)} questsOpen={questOpen} />
      {!tutorial && <QuestPanel game={game} open={questOpen} setOpen={setQuestOpen} />}
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
        {game.skipTo !== null ? (
          // fast-forwarding through the night: one clear state instead of the speed buttons
          <button className="rounded-lg bg-indigo-400/20 px-2 py-1 text-xs text-indigo-100 hover:bg-indigo-400/30" title="멈추고 원래 속도로 (Space 또는 숫자 키)" onClick={() => game.dispatch({ type: 'SYSTEM', action: 'SPEED', value: game.speed })}>
            🌙 아침까지 빨리 감는 중… ✕
          </button>
        ) : (
          <>
            <TimeBtn active={!game.paused && game.speed === 0.5} onClick={() => game.dispatch({ type: 'SYSTEM', action: 'SPEED', value: 0.5 })} label="½" title="느리게 ½배속 (0)" />
            {[1, 2, 3, 5, 10].map((s, i) => (
              <TimeBtn key={s} active={!game.paused && game.speed === s} onClick={() => game.dispatch({ type: 'SYSTEM', action: 'SPEED', value: s })} label={s <= 3 ? '▸'.repeat(s) : `${s}×`} title={`${s}배속 (${i + 1})`} />
            ))}
            {(hour >= 18 || hour < 6.5) && <TimeBtn active={false} onClick={() => game.dispatch({ type: 'SYSTEM', action: 'SKIP_NIGHT' })} label="🌙⏭" title="밤 건너뛰기 — 아침 6:30까지 빨리 감기 (J)" />}
          </>
        )}
      </div>

      {/* editing the map: the brush palette takes the bottom of the screen instead of the story log */}
      {game.editMode ? <EditPalette game={game} /> : <StoryFeed game={game} open={logOpen} setOpen={setLogOpen} />}
      {tutorial && <Tutorial game={game} onExample={onExample} onDone={() => onTutorialEnd?.()} />}
      <Inspector game={game} nudge={tabNudge} openTab={openTab} />
      {menu && (
        <ContextMenu
          game={game}
          targetId={menu.id}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onOpenTab={(tab) => {
            game.select(menu.id);
            setOpenTab((o) => ({ id: o.id + 1, tab }));
          }}
        />
      )}

      {modal?.type === 'research' && <ResearchPanel game={game} onClose={() => setModal(null)} />}
      {modal?.type === 'groups' && <GroupsModal game={game} onClose={() => setModal(null)} />}
      {modal?.type === 'events' && <EventsModal game={game} onClose={() => setModal(null)} />}
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

/** 📛 the world's name (click to rename; saves go under it) */
function WorldName({ game }: { game: Game }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState('');
  const name = game.world.meta.name;
  if (edit)
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) game.toast(game.dispatch({ type: 'RENAME_WORLD', name: v.trim() }));
          setEdit(false);
        }}
      >
        <input autoFocus value={v} maxLength={30} onChange={(e) => setV(e.target.value)} onBlur={() => setEdit(false)} placeholder="세계 이름" className="w-32 rounded-md border border-glow/50 bg-black/40 px-2 py-0.5 text-xs text-parch outline-none" />
      </form>
    );
  return (
    <button
      className={`max-w-[150px] truncate rounded-md px-2 py-0.5 text-xs hover:bg-white/15 ${name ? 'bg-white/8 text-parch' : 'text-parch-dim'}`}
      title="세계 이름 — 클릭해서 바꾸기 (저장도 이 이름으로 따로 돼요)"
      onClick={() => {
        setV(name ?? '');
        setEdit(true);
      }}
    >
      📛 {name ?? '이름 짓기'}
    </button>
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

type FeedFilter = 'all' | 'talk' | 'thought' | 'event';
const FEED_FILTER_KEY = 'asiwrite.feedFilter';
const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'talk', label: '대화' },
  { id: 'thought', label: '속마음' },
  { id: 'event', label: '사건' },
];
function feedClass(f: FeedItem): Exclude<FeedFilter, 'all'> {
  if (f.kind === 'line' && f.speaker) return f.thought ? 'thought' : 'talk';
  if (f.kind === 'monologue') return f.text.startsWith('(') ? 'thought' : 'talk';
  return 'event';
}

/** "대화는 진짜로 출력되어야 함" — every spoken line, inner voice and event, as a story log. */
function StoryFeed({ game, open, setOpen }: { game: Game; open: boolean; setOpen: (f: (v: boolean) => boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true); // follow new lines only while the reader is at the bottom
  const [seen, setSeen] = useState(0);
  const [filter, setFilterState] = useState<FeedFilter>(() => {
    try {
      return (localStorage.getItem(FEED_FILTER_KEY) as FeedFilter) || 'all';
    } catch {
      return 'all';
    }
  });
  const setFilter = (f: FeedFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FEED_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };
  const all = game.world.feed;
  const shown = filter === 'all' ? all : all.filter((f) => feedClass(f) === filter);
  const items = shown.slice(-250);
  const lastT = all.length ? all[all.length - 1].t + ':' + all.length : '';
  const unseen = stick ? 0 : Math.max(0, all.length - seen);

  useEffect(() => {
    const el = ref.current;
    if (el && stick) {
      el.scrollTop = el.scrollHeight;
      setSeen(all.length);
    }
  }, [lastT, stick, open, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 6;
    if (atBottom !== stick) setStick(atBottom);
    if (atBottom) setSeen(all.length);
  };

  return (
    <FloatingPanel
      id="story"
      title="📜 이야기"
      collapsed={!open}
      onCollapse={() => setOpen((v) => !v)}
      defaultRect={() => ({ x: 68, y: window.innerHeight - 250, w: 400, h: 238 })}
      minW={260}
      minH={110}
      headerExtra={
        open && (
          <div className="flex gap-0.5">
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} className={`rounded px-1.5 py-0.5 text-[10px] ${filter === f.id ? 'bg-white/15 text-parch' : 'text-parch-dim hover:text-parch'}`}>
                {f.label}
              </button>
            ))}
          </div>
        )
      }
    >
      <div ref={ref} onScroll={onScroll} className="scroll-thin absolute inset-0 overflow-y-auto px-3 py-1.5">
        {items.length === 0 && <div className="py-2 text-parch-dim/70">{filter === 'all' ? '아직 아무 일도 일어나지 않았어요.' : '아직 이런 이야기는 없어요.'}</div>}
        {items.map((f, i) => (
          <div key={shown.length - items.length + i} className="py-0.5 leading-relaxed">
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
                <span className="ml-1 text-[10px] text-parch-dim">
                  {f.text.startsWith('(') ? '속마음' : '긴 이야기'}
                  {f.ai ? ' · ✨ AI가 다듬음' : ''}
                </span>
                <p className="font-serif text-[12.5px] leading-relaxed text-parch/90">{f.text}</p>
              </div>
            ) : f.kind === 'line' && f.speaker ? (
              f.thought ? (
                <>
                  <FeedName game={game} id={f.speakerId} name={f.speaker} cls="text-glow/70" />
                  <span className="ml-1 text-[10px] text-parch-dim">속마음</span>
                  <span className="ml-1 italic text-parch/60">{f.text}</span>
                  {f.ai && <span className="ml-1 text-[10px] text-glow/70" title="AI 이야기꾼이 다듬은 문장">✨</span>}
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
                  {f.learned && <span className="ml-1 text-[10px] text-sky-200/70" title="예전에 이야기꾼이 다듬은 문장을 배워 두었다가 쓴 것">📚</span>}
                </>
              )
            ) : (
              <span className={f.kind === 'care' ? 'text-emerald-300' : f.kind === 'break' ? 'text-rose-300' : f.kind === 'rumor' ? 'text-amber-200' : f.kind === 'romance' ? 'text-pink-300' : 'text-sky-200/80'}>
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
    </FloatingPanel>
  );
}
