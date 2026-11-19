import { useEffect, useState } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import { parseSheet } from '../engine/sheet';
import { agentBio, placeBio } from '../engine/bio';
import { personaSummary } from '../engine/traits';
import type { Agent, Place } from '../engine/types';
import { formatClock } from '../engine/util';
import { STYLE_LABEL } from '../engine/World';
import { activityOf, affinityLabel, moodLabel } from './describe';
import { Btn } from './Modal';
import { SpritePreview } from './SpritePreview';

type Tab = 'status' | 'traits' | 'relations' | 'diary' | 'sheet';

export function Inspector({ game, nudge }: { game: Game; nudge?: { id: number; dir: number } }) {
  const w = game.world;
  const id = game.selectedId;
  const e: Agent | Place | undefined = w.agent(id ?? undefined) ?? w.place(id ?? undefined);
  const [tab, setTab] = useState<Tab>('status');
  // keyboard [ ] cycles tabs
  useEffect(() => {
    if (!nudge || !nudge.id || !e) return;
    const order: Tab[] = e.kind === 'place' ? ['status', 'traits', 'diary'] : ['status', 'traits', 'relations', 'diary', 'sheet'];
    setTab((t) => order[(order.indexOf(t) + nudge.dir + order.length) % order.length]);
  }, [nudge?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (e?.kind === 'place' && (tab === 'relations' || tab === 'sheet')) setTab('status');
  }, [e?.kind, tab]);
  if (!e) return null;

  const run = (cmd: GameCommand) => game.toast(game.dispatch(cmd));
  const tabs: [Tab, string][] = e.kind === 'place' ? [['status', '정보'], ['traits', '특성'], ['diary', '기록']] : [['status', '상태'], ['traits', '특성'], ['relations', '관계'], ['diary', '일기'], ['sheet', '텍스트 양식']];

  return (
    <div className="panel pointer-events-auto absolute right-3 top-20 bottom-3 z-30 flex w-[340px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl text-sm shadow-2xl">
      <div className="flex items-start gap-3 border-b border-white/10 p-3">
        {e.kind !== 'place' && (
          <div className="shrink-0 overflow-hidden rounded-lg" style={{ width: 56, height: 56 }}>
            <div style={{ width: 224, transform: 'translateX(0)' }}>
              <SpritePreview appearance={e.appearance} kind={e.kind} name={e.name} category={e.category} mood={e.mood} size={56} raining={w.meta.weather === 'rain' || w.meta.weather === 'storm'} />
            </div>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-base font-semibold text-parch">{e.name}</div>
          <div className="text-xs text-parch-dim">{e.kind === 'place' ? STYLE_LABEL[e.style] : e.category}</div>
          {e.kind !== 'place' && <div className="mt-0.5 truncate text-xs text-parch/80">{activityOf(w, e)}</div>}
        </div>
        <button className="text-parch-dim hover:text-parch" onClick={() => game.select(null)} aria-label="닫기">
          ✕
        </button>
      </div>

      <div className="flex gap-0.5 border-b border-white/10 px-2 pt-1.5">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-t-md px-2.5 py-1 text-xs ${tab === k ? 'bg-white/10 text-parch' : 'text-parch-dim hover:text-parch'}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto p-3">
        {tab === 'status' && (e.kind === 'place' ? <PlaceStatus game={game} p={e} /> : <AgentStatus game={game} a={e} />)}
        {tab === 'traits' && <TraitEditor game={game} e={e} />}
        {tab === 'relations' && e.kind !== 'place' && <Relations game={game} a={e} />}
        {tab === 'diary' && <Diary e={e} />}
        {tab === 'sheet' && e.kind !== 'place' && <SheetEditor game={game} a={e} />}
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-white/10 p-2.5">
        <Btn className="!px-2 text-xs" onClick={() => run({ type: 'SYSTEM', action: 'FOLLOW', target: { id: e.id } })}>
          🎥 추적
        </Btn>
        {e.kind !== 'place' && (
          <>
            <Btn className="!px-2 text-xs" title="직접 무드를 조금 올려 줍니다" onClick={() => run({ type: 'TRIGGER_EVENT', event: 'BLESS', targets: [{ id: e.id }] })}>
              ✨ 축복
            </Btn>
            <Btn className="!px-2 text-xs" title="좋아하는 것을 선물로 몰래 둡니다" onClick={() => run({ type: 'TRIGGER_EVENT', event: 'GIFT', targets: [{ id: e.id }] })}>
              🎁 선물
            </Btn>
          </>
        )}
        <Btn className="!px-2 text-xs" onClick={() => run({ type: 'TRIGGER_EVENT', event: 'LIGHTNING', targets: [{ id: e.id }] })}>
          ⚡ 번개
        </Btn>
        <Btn variant="danger" className="ml-auto !px-2 text-xs" onClick={() => confirm(`${e.name}을(를) 세상에서 지울까요?`) && run({ type: 'DELETE_ENTITY', target: { id: e.id } })}>
          🗑 삭제
        </Btn>
      </div>
    </div>
  );
}

function AgentStatus({ game, a }: { game: Game; a: Agent }) {
  const w = game.world;
  const ml = moodLabel(a.mood);
  const target = w.moodTarget(a);
  const thoughts = w.thoughtsSorted(a);
  const persona = personaSummary(a.persona);
  return (
    <div className="grid gap-3">
      <p className="font-serif text-[13px] leading-relaxed text-parch/90">{agentBio(w, a)}</p>
      <div>
        <div className="mb-1 flex justify-between text-xs">
          <span className="text-parch-dim">무드</span>
          <span style={{ color: ml.color }}>
            {Math.round(a.mood)} · {ml.text} {target > a.mood + 2 ? '▲' : target < a.mood - 2 ? '▼' : ''}
          </span>
        </div>
        <div className="relative h-2.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full transition-all" style={{ width: `${a.mood}%`, background: ml.color }} />
          <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: '20%' }} title="한계 (20)" />
          <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: '80%' }} title="행복 (80)" />
        </div>
      </div>
      {persona.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {persona.map((p) => (
            <span key={p} className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-parch/90">
              {p}
            </span>
          ))}
        </div>
      )}
      <div>
        <div className="mb-1 text-xs text-parch-dim">지금 드는 생각</div>
        {thoughts.length === 0 ? (
          <div className="text-xs text-parch-dim/70">특별한 생각은 없어요.</div>
        ) : (
          <ul className="grid gap-1">
            {thoughts.map((t) => (
              <li key={t.key} className="flex items-center justify-between gap-2 rounded bg-white/5 px-2 py-1 text-xs">
                <span className="text-parch/90">{t.label}</span>
                <span className={t.value >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                  {t.value > 0 ? '+' : ''}
                  {t.value}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {a.kind === 'person' && <JobRow game={game} a={a} />}
      {a.treasure && (
        <div>
          <div className="mb-1 text-xs text-parch-dim">💝 애착 물건</div>
          <div className="font-serif text-[13px] text-parch/90">{a.treasure}</div>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs text-parch-dim">외형</div>
        <div className="text-xs text-parch/85">{a.appearance || '—'}</div>
      </div>
      {a.mood < 40 && (
        <div className="rounded-md border border-glow/20 bg-glow/5 p-2 text-[11px] leading-relaxed text-parch/80">
          💡 {a.name}의 특성을 살펴보고, 좋아할 만한 것을 근처에 만들어 주면 스스로 발견하고 기운을 차릴지도 몰라요.
        </div>
      )}
    </div>
  );
}

function JobRow({ game, a }: { game: Game; a: Agent }) {
  const w = game.world;
  const workplaces = w.places.filter((p) => p.workSpots.length > 0);
  const work = w.place(a.jobId);
  return (
    <div className="grid gap-1.5 rounded-md bg-white/5 p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-parch-dim">💰 가진 돈</span>
        <span className="font-mono text-parch">{Math.floor(a.money).toLocaleString('ko-KR')}원</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-parch-dim">💼 {a.job || '직업 없음'}</span>
        <select
          value={work?.id ?? ''}
          onChange={(ev) => game.toast(game.dispatch({ type: 'MODIFY_ENTITY', target: { id: a.id }, changes: { workplace: ev.target.value ? { id: ev.target.value } : null } }))}
          className="min-w-0 max-w-[170px] truncate rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs text-parch"
        >
          <option value="">— 일 안 함 —</option>
          {workplaces.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {work && (
        <div className="text-[11px] text-parch-dim">
          근무 {game.world.shiftStart(a)}:00 ~ {game.world.shiftStart(a) + 6}:00 {a.ai.working ? '· 지금 일하는 중' : ''}
        </div>
      )}
    </div>
  );
}

function PlaceStatus({ game, p }: { game: Game; p: Place }) {
  const visitors = game.world.agents.filter((a) => a.ai.targetPlaceId === p.id);
  const workers = game.world.agents.filter((a) => a.jobId === p.id);
  return (
    <div className="grid gap-3 text-xs">
      <p className="font-serif text-[13px] leading-relaxed text-parch/90">{placeBio(game.world, p)}</p>
      {workers.length > 0 && (
        <div>
          <div className="mb-1 text-parch-dim">일하는 윌 ({workers.length}/{p.workSpots.length})</div>
          <div className="flex flex-wrap gap-1">
            {workers.map((v) => (
              <button key={v.id} className="rounded-full bg-white/8 px-2 py-0.5 text-parch hover:bg-white/15" onClick={() => game.focus(v.id)}>
                {v.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 text-parch-dim">외형 / 분위기</div>
        <div className="text-parch/85">{p.appearance || '—'}</div>
      </div>
      <div>
        <div className="mb-1 text-parch-dim">지금 있는 윌 ({visitors.length})</div>
        <div className="flex flex-wrap gap-1">
          {visitors.length === 0 && <span className="text-parch-dim/70">아무도 없어요.</span>}
          {visitors.map((v) => (
            <button key={v.id} className="rounded-full bg-white/8 px-2 py-0.5 text-parch hover:bg-white/15" onClick={() => game.focus(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TraitEditor({ game, e }: { game: Game; e: Agent | Place }) {
  const [draft, setDraft] = useState('');
  const [look, setLook] = useState(e.appearance);
  const [treasure, setTreasure] = useState(e.kind === 'place' ? '' : e.treasure);
  useEffect(() => setLook(e.appearance), [e.id, e.appearance]);
  useEffect(() => setTreasure(e.kind === 'place' ? '' : e.treasure), [e.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (cmd: GameCommand) => game.toast(game.dispatch(cmd));
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    run({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { addTraits: [t] } });
    setDraft('');
  };
  return (
    <div className="grid gap-3">
      <ul className="grid gap-1">
        {e.traits.map((t, i) => (
          <li key={i + t} className="group flex items-start gap-2 rounded bg-white/5 px-2 py-1.5 text-xs text-parch/90">
            <span className="flex-1">{t}</span>
            <button className="text-parch-dim opacity-0 hover:text-rose-300 group-hover:opacity-100" onClick={() => run({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { removeTraits: [t] } })} aria-label="특성 삭제">
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-1.5">
        <input value={draft} onChange={(ev) => setDraft(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && add()} placeholder="새 특성 (어떤 문장이든)" className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-parch outline-none focus:border-glow/50" />
        <Btn className="!px-2 text-xs" onClick={add}>
          추가
        </Btn>
      </div>
      {e.kind !== 'place' && (
        <div>
          <div className="mb-1 text-xs text-parch-dim">💝 애착 물건</div>
          <div className="flex gap-1.5">
            <input value={treasure} onChange={(ev) => setTreasure(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && run({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { treasure } })} placeholder="예: 할머니가 떠 주신 목도리" className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-parch outline-none focus:border-glow/50" />
            <Btn className="!px-2 text-xs" onClick={() => run({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { treasure } })}>
              적용
            </Btn>
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs text-parch-dim">외형 (바꾸면 모습이 바로 바뀌어요)</div>
        <div className="flex gap-1.5">
          <input value={look} onChange={(ev) => setLook(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && run({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { appearance: look } })} className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-parch outline-none focus:border-glow/50" />
          <Btn className="!px-2 text-xs" onClick={() => run({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { appearance: look } })}>
            적용
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Relations({ game, a }: { game: Game; a: Agent }) {
  const w = game.world;
  const [open, setOpen] = useState<string | null>(null);
  const rels = [...w.relations.values()]
    .filter((r) => r.a === a.id || r.b === a.id)
    .map((r) => ({ r, other: w.agent(r.a === a.id ? r.b : r.a) }))
    .filter((x) => x.other)
    .sort((x, y) => Math.abs(y.r.affinity) - Math.abs(x.r.affinity));
  if (!rels.length) return <div className="text-xs text-parch-dim/80">아직 아는 이가 없어요. 시간이 지나면 관계가 생겨요.</div>;
  return (
    <ul className="grid gap-1.5">
      {rels.map(({ r, other }) => {
        const v = r.affinity;
        const col = v >= 0 ? '#7ccf7a' : '#e06b6b';
        return (
          <li key={other!.id} className="rounded-md bg-white/5 p-2 text-xs">
            <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === other!.id ? null : other!.id)}>
              <span className="flex-1 text-parch">{other!.name}</span>
              <span className="text-parch-dim">{affinityLabel(v)}</span>
              <span style={{ color: col }}>
                {v > 0 ? '+' : ''}
                {Math.round(v)}
              </span>
            </button>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full" style={{ width: `${Math.abs(v)}%`, background: col, marginLeft: v < 0 ? 'auto' : undefined }} />
            </div>
            {open === other!.id && (
              <div className="mt-2 grid gap-1 border-l border-white/15 pl-2">
                {r.memories.length === 0 && <span className="text-parch-dim/70">기억할 만한 일은 아직 없어요.</span>}
                {r.memories.map((m, i) => (
                  <div key={i} className="text-parch/80">
                    <span className="mr-1 text-parch-dim">{formatClock(m.t).split(' ')[0]}</span>
                    {m.text}
                  </div>
                ))}
                <button className="mt-1 self-start text-glow/90 hover:text-glow" onClick={() => game.focus(other!.id)}>
                  추적하기 →
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Diary({ e }: { e: Agent | Place }) {
  const logs = [...e.logs].reverse();
  if (!logs.length) return <div className="text-xs text-parch-dim/80">아직 기록이 없어요.</div>;
  return (
    <ul className="grid gap-1.5">
      {logs.map((l, i) => (
        <li key={i} className="text-xs leading-relaxed">
          <span className="mr-1.5 text-parch-dim">{formatClock(l.t)}</span>
          <span className={l.kind === 'diary' ? 'font-serif text-parch' : l.kind === 'mutation' ? 'text-sky-200/90' : 'text-parch/75'}>{l.kind === 'diary' ? `“${l.text}”` : l.text}</span>
        </li>
      ))}
    </ul>
  );
}

function SheetEditor({ game, a }: { game: Game; a: Agent }) {
  const [text, setText] = useState(() => game.world.sheetOf(a));
  useEffect(() => setText(game.world.sheetOf(a)), [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = parseSheet(text);
  return (
    <div className="grid gap-2">
      <p className="text-[11px] leading-relaxed text-parch-dim">이 양식을 그대로 복사해서 다른 곳에 붙여 넣거나, 다른 작품의 캐릭터 양식을 붙여 넣고 적용할 수 있어요.</p>
      <textarea value={text} onChange={(ev) => setText(ev.target.value)} spellCheck={false} className="scroll-thin h-60 w-full resize-y rounded-lg border border-white/10 bg-black/30 p-2.5 font-mono text-[12px] leading-relaxed text-parch outline-none focus:border-glow/50" />
      {parsed.warnings.length > 0 && <p className="text-xs text-amber-300/90">⚠ {parsed.warnings.join(' · ')}</p>}
      <SpritePreview appearance={parsed.sheet.appearance} kind={parsed.kind} name={parsed.sheet.name} category={parsed.sheet.category} mood={parsed.sheet.mood} size={52} />
      <div className="flex gap-1.5">
        <Btn variant="primary" className="text-xs" onClick={() => game.toast(game.dispatch({ type: 'MODIFY_ENTITY', target: { id: a.id }, changes: { sheet: text } }))}>
          적용
        </Btn>
        <Btn className="text-xs" onClick={() => navigator.clipboard?.writeText(text)}>
          복사
        </Btn>
        <Btn variant="ghost" className="text-xs" onClick={() => setText(game.world.sheetOf(a))}>
          되돌리기
        </Btn>
      </div>
    </div>
  );
}
