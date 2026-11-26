import { Children, Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import type { Weather } from '../engine/types';
import type { SpawnKind } from './SpawnModal';
import { MOD } from './shortcuts';

export type ToolbarModal = { type: 'research' } | { type: 'groups' } | { type: 'events' } | { type: 'roster'; kind: 'person' | 'animal' } | { type: 'spawn'; kind: SpawnKind } | { type: 'world' } | { type: 'meet' } | { type: 'settings' } | { type: 'load' } | { type: 'help' };

const WEATHERS: [Weather, string, string][] = [
  ['clear', '☀️', '맑음'],
  ['rain', '🌧️', '비'],
  ['snow', '❄️', '눈'],
  ['storm', '⛈️', '폭풍'],
];

// Top-level components: defining them inside Toolbar would remount every HUD tick (≈5×/s),
// which restarted the hover transition and made the hover highlight flicker.
function Item({ icon, label, onClick, active }: { icon: string; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} className={`group relative flex h-9 w-9 items-center justify-center rounded-lg text-base ${active ? 'bg-glow/25' : 'hover:bg-white/12'}`}>
      <span>{icon}</span>
      <span className="pointer-events-none absolute left-11 z-50 hidden whitespace-nowrap rounded bg-black/90 px-2 py-1 text-xs text-parch group-hover:block">{label}</span>
    </button>
  );
}
function Sep() {
  return <div className="mx-2 my-1 h-px bg-white/10" />;
}

const ITEM_H = 36, SEP_H = 9, PAD = 8, MAX_COLS = 3;
/**
 * The toolbar fits any window: buttons flow into as many columns as the height allows (groups stay
 * together when they can), and if even three columns don't fit, it becomes one column you can scroll
 * with the wheel or by dragging.
 */
function FitColumns({ groups }: { groups: ReactNode[][] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(10000);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientHeight));
    ro.observe(el);
    setAvail(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const limit = Math.max(ITEM_H, avail - PAD);
  const cols: ReactNode[][] = [[]];
  let h = 0;
  groups.forEach((g, gi) => {
    const gh = g.length * ITEM_H;
    // a group that doesn't fit the rest of this column (but fits a fresh one) starts a new column
    if (h > 0 && h + SEP_H + gh > limit && gh <= limit) {
      cols.push([]);
      h = 0;
    } else if (h > 0) {
      cols[cols.length - 1].push(<Sep key={`s${gi}`} />);
      h += SEP_H;
    }
    for (const item of g) {
      if (h + ITEM_H > limit && h > 0) {
        cols.push([]);
        h = 0;
      }
      cols[cols.length - 1].push(item);
      h += ITEM_H;
    }
  });
  const scroll = cols.length > MAX_COLS;
  // drag to scroll (only when it has to scroll); a drag doesn't count as a click
  const drag = useRef<{ y: number; top: number; moved: boolean } | null>(null);
  const flat = groups.flatMap((g, gi) => (gi ? [<Sep key={`s${gi}`} />, ...g] : g));
  return (
    <div ref={wrap} className="pointer-events-none absolute bottom-3 left-3 top-16 z-30 flex items-center">
      <div
        ref={panel}
        className={`panel pointer-events-auto flex rounded-xl p-1 shadow-xl ${scroll ? 'scroll-thin max-h-full flex-col overflow-y-auto' : 'flex-row gap-0.5'}`}
        onPointerDown={(e) => {
          if (scroll && panel.current) drag.current = { y: e.clientY, top: panel.current.scrollTop, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !panel.current) return;
          if (Math.abs(e.clientY - d.y) > 4) d.moved = true;
          if (d.moved) panel.current.scrollTop = d.top - (e.clientY - d.y);
        }}
        onPointerUp={() => setTimeout(() => (drag.current = null), 0)}
        onPointerLeave={() => (drag.current = null)}
        onClickCapture={(e) => {
          if (drag.current?.moved) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
      >
        {scroll
          ? flat
          : cols.map((c, i) => (
              <div key={i} className={`flex flex-col ${i ? 'border-l border-white/10 pl-0.5' : ''}`}>
                {c}
              </div>
            ))}
      </div>
    </div>
  );
}

/**
 * Click-only access to every command (the chat bar is optional).
 * Each button either dispatches a GameCommand directly, opens a form that
 * builds one, or arms a map-click tool that builds one.
 */
export function Toolbar({ game, open, onQuit, onQuests, questsOpen }: { game: Game; open: (m: ToolbarModal) => void; onQuit: () => void; onQuests?: () => void; questsOpen?: boolean }) {
  const [weatherOpen, setWeatherOpen] = useState(false);
  const run = (cmd: GameCommand) => game.toast(game.dispatch(cmd));
  const armTarget = (label: string, make: (id: string) => GameCommand, personOnly = false) => {
    game.tool = {
      label,
      build: (_x, _y, hit) => {
        if (!hit || (personOnly && hit.kind !== 'person')) {
          game.toast({ ok: false, message: personOnly ? '윌을 클릭해 주세요.' : '대상을 클릭해 주세요.' });
          return null;
        }
        return make(hit.id);
      },
    };
    game.notify(true);
  };

  const groups: ReactNode[] = [
      <Fragment key="g0">
<Item icon="👥" label="윌 목록 (P)" onClick={() => open({ type: 'roster', kind: 'person' })} />
      <Item icon="🐾" label="동물 목록 (Shift P)" onClick={() => open({ type: 'roster', kind: 'animal' })} />
      <Item icon="🎌" label="그룹 (U)" onClick={() => open({ type: 'groups' })} />
      {onQuests && <Item icon="📮" label="의뢰 · 목표 (O)" active={questsOpen} onClick={onQuests} />}
      </Fragment>,
      <Fragment key="g1">
<Item icon="👤" label="윌 소환 (N)" onClick={() => open({ type: 'spawn', kind: 'person' })} />
      <Item icon="🐈" label="동물 소환 (Shift N)" onClick={() => open({ type: 'spawn', kind: 'animal' })} />
      <Item icon="🏠" label="건물 배치 (B)" onClick={() => open({ type: 'spawn', kind: 'place' })} />
      </Fragment>,
      <Fragment key="g2">
<div className="relative">
        <Item icon={WEATHERS.find((x) => x[0] === game.world.meta.weather)?.[1] ?? '☀️'} label="날씨 바꾸기 (C)" onClick={() => setWeatherOpen((v) => !v)} active={weatherOpen} />
        {weatherOpen && (
          <div className="panel absolute left-12 top-0 z-50 flex gap-1 rounded-lg p-1">
            {WEATHERS.map(([w, icon, label]) => (
              <button
                key={w}
                onClick={() => {
                  run({ type: 'SET_WEATHER', weather: w });
                  setWeatherOpen(false);
                }}
                className={`flex flex-col items-center rounded-md px-2 py-1 text-xs ${game.world.meta.weather === w ? 'bg-glow/25 text-parch' : 'text-parch-dim hover:bg-white/10 hover:text-parch'}`}
              >
                <span className="text-lg">{icon}</span>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <Item icon="🌍" label="세계관 바꾸기 (G)" onClick={() => open({ type: 'world' })} />
      <Item icon="🗺️" label="세계 넓히기" onClick={() => run({ type: 'SYSTEM', action: 'EXPAND' })} />
      <Item icon="🛠️" label="맵 편집 — 길 깔기·나무 심기·크기 조절 (X)" active={game.editMode} onClick={() => run({ type: 'SYSTEM', action: 'EDIT_MAP' })} />
      </Fragment>,
      <Fragment key="g3">
<Item icon="⚡" label="번개 내리기 (Z)" active={game.tool?.label.startsWith('⚡')} onClick={() => armTarget('⚡ 번개를 내릴 대상을 클릭하세요', (id) => ({ type: 'TRIGGER_EVENT', event: 'LIGHTNING', targets: [{ id }] }))} />
      <Item icon="👣" label="두 윌 마주치게 하기 (M)" onClick={() => open({ type: 'meet' })} />
      <Item icon="🎪" label="사건 일으키기 (K)" onClick={() => open({ type: 'events' })} />
      <Item icon="✨" label="축복 (Q · 윌 클릭)" active={game.tool?.label.startsWith('✨')} onClick={() => armTarget('✨ 축복할 윌을 클릭하세요', (id) => ({ type: 'TRIGGER_EVENT', event: 'BLESS', targets: [{ id }] }), true)} />
      <Item icon="🎁" label="선물 두기 (E · 윌 클릭)" active={game.tool?.label.startsWith('🎁')} onClick={() => armTarget('🎁 선물을 둘 윌을 클릭하세요', (id) => ({ type: 'TRIGGER_EVENT', event: 'GIFT', targets: [{ id }] }), true)} />
      <Item icon="🗑" label="지우기 (Delete · 대상 클릭)" active={game.tool?.label.startsWith('🗑')} onClick={() => armTarget('🗑 지울 대상을 클릭하세요', (id) => ({ type: 'DELETE_ENTITY', target: { id } }))} />
      </Fragment>,
      <Fragment key="g4">
<Item icon="💾" label={`저장 (${MOD} S)`} onClick={() => run({ type: 'SYSTEM', action: 'SAVE' })} />
      <Item icon="📂" label={`불러오기 / 내보내기 (${MOD} O)`} onClick={() => open({ type: 'load' })} />
      <Item icon="📊" label="연구 · 분석 메트릭 (I)" onClick={() => open({ type: 'research' })} />
      <Item icon="⚙️" label="설정 (Esc)" onClick={() => open({ type: 'settings' })} />
      <Item icon="❓" label="단축키 · 도움말 (?)" onClick={() => open({ type: 'help' })} />
      <Item icon="🚪" label="타이틀로" onClick={onQuit} />
      </Fragment>,
  ];
  return <FitColumns groups={groups.map((g) => Children.toArray((g as { props: { children: ReactNode } }).props.children))} />;
}
