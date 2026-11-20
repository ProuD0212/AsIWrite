import { useEffect, useRef, useState } from 'react';
import type { GameCommand } from '../commands/schema';
import type { Game } from '../engine/Game';
import { parseSheet } from '../engine/sheet';
import { agentBio, placeBio } from '../engine/bio';
import { storyteller } from '../ai/storyteller';
import { bioPrompt } from '../ai/prompts';
import { personaSummary } from '../engine/traits';
import type { Agent, Place } from '../engine/types';
import { formatClock } from '../engine/util';
import { STYLE_LABEL } from '../engine/World';
import { activityOf, moodLabel, relationLabel } from './describe';
import { Btn } from './Modal';
import { SpritePreview } from './SpritePreview';

export type Tab = 'status' | 'talk' | 'traits' | 'relations' | 'diary' | 'sheet';

/** AI-rewritten bios, keyed by entity id + the template draft (so edits invalidate them) */
const aiBios = new Map<string, string>();

/** Template bio + optional ✨ rewrite by the storyteller (on request, cached). */
function BioText({ id, name, draft }: { id: string; name: string; draft: string }) {
  const [, force] = useState(0);
  const [showAi, setShowAi] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const key = `${id}:${draft}`;
  const ai = aiBios.get(key);
  const ask = () => {
    setWaiting(true);
    const ok = storyteller.enqueue({
      key: `bio:${key}`,
      kind: 'bio',
      messages: bioPrompt(draft, name),
      maxTokens: 200,
      ttl: 180000,
      priority: 4,
      draft,
      onDone: (text) => {
        aiBios.set(key, text);
        setWaiting(false);
        setShowAi(true);
        force((n) => n + 1);
      },
      onFail: () => setWaiting(false),
    });
    if (!ok) setWaiting(false);
  };
  const ready = storyteller.state === 'ready';
  return (
    <div className="grid gap-1">
      <p className="font-serif text-[13px] leading-relaxed text-parch/90">{ai && showAi ? ai : draft}</p>
      <div className="flex items-center gap-2 text-[11px]">
        {ai ? (
          <button className="text-glow/80 hover:text-glow" onClick={() => setShowAi((v) => !v)}>
            {showAi ? '✨ AI가 다듬은 소개 · 원본 보기' : '원본 · ✨ 다듬은 소개 보기'}
          </button>
        ) : ready ? (
          <button className="text-glow/80 hover:text-glow disabled:opacity-50" disabled={waiting} onClick={ask}>
            {waiting ? '✨ 이야기꾼이 쓰는 중…' : '✨ 이야기꾼에게 다시 쓰게 하기'}
          </button>
        ) : (
          <span className="text-parch-dim/60">✨ 이야기꾼: {storyteller.label()}</span>
        )}
      </div>
    </div>
  );
}

export function Inspector({ game, nudge, openTab }: { game: Game; nudge?: { id: number; dir: number }; openTab?: { id: number; tab: Tab } }) {
  const w = game.world;
  const id = game.selectedId;
  const e: Agent | Place | undefined = w.agent(id ?? undefined) ?? w.place(id ?? undefined);
  const [tab, setTab] = useState<Tab>('status');
  useEffect(() => {
    if (game.selectedId) game.noteUi(`tab:${tab}`);
  }, [tab, game.selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  // keyboard [ ] cycles tabs
  useEffect(() => {
    if (!nudge || !nudge.id || !e) return;
    const order: Tab[] = e.kind === 'place' ? ['status', 'traits', 'diary'] : e.kind === 'person' ? ['status', 'talk', 'traits', 'relations', 'diary', 'sheet'] : ['status', 'traits', 'relations', 'diary', 'sheet'];
    setTab((t) => order[(order.indexOf(t) + nudge.dir + order.length) % order.length]);
  }, [nudge?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // opened from the right-click menu on a specific tab
  useEffect(() => {
    if (game.requestTab && e) {
      setTab(game.requestTab as Tab);
      game.requestTab = null;
    }
  });
  useEffect(() => {
    if (openTab?.id) setTab(openTab.tab);
  }, [openTab?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ((e?.kind === 'place' && (tab === 'relations' || tab === 'sheet')) || (e && e.kind !== 'person' && tab === 'talk')) setTab('status');
  }, [e?.kind, tab]);
  if (!e) return null;

  const run = (cmd: GameCommand) => game.toast(game.dispatch(cmd));
  const tabs: [Tab, string][] = e.kind === 'place' ? [['status', '정보'], ['traits', '특성'], ['diary', '기록']] : [['status', '상태'], ...(e.kind === 'person' ? ([['talk', '💬 대화']] as [Tab, string][]) : []), ['traits', '특성'], ['relations', '관계'], ['diary', '일기'], ['sheet', '양식']];

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
        {tab === 'talk' && e.kind === 'person' && <TalkView game={game} a={e} />}
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
      <BioText id={a.id} name={a.name} draft={agentBio(w, a)} />
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
      {a.kind === 'person' && <NeedsView game={game} a={a} />}
      <PetRow game={game} a={a} />
      {a.kind === 'person' && <div className="text-xs text-parch-dim">🎂 생일 {game.world.isBirthday(a) || game.world.birthdayIn(a) === 0 ? <b className="text-pink-300">오늘!</b> : `${game.world.birthdayIn(a)}일 뒤`}</div>}
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
      {a.kind === 'person' && w.factionsOf(a.id).length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span className="text-parch-dim">🎌 소속</span>
          {w.factionsOf(a.id).map((f) => (
            <span key={f.id} className="flex items-center gap-1 bg-white/8 px-1.5 py-0.5 text-parch" title={f.members.map((m) => w.agent(m)?.name).filter(Boolean).join(', ')}>
              <span className="h-2 w-2" style={{ background: f.color }} />
              {f.name}
            </span>
          ))}
        </div>
      )}
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

/** 필요: company, fun, food, rest — and wishes for places the town doesn't have yet */
function NeedsView({ game, a }: { game: Game; a: Agent }) {
  const n = game.world.needsOf(a);
  const rows: [string, string, number][] = [
    ['👥', '사람', n.social],
    ['🎈', '재미', n.fun],
    ['🍙', '배부름', n.food],
    ['🛏️', '기운', n.rest],
  ];
  const wish = game.world.missingWish(a);
  return (
    <div className="grid gap-1">
      <div className="text-xs text-parch-dim">필요</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map(([icon, label, v]) => (
          <div key={label} className="flex items-center gap-1.5 text-[11px]" title={`${label} ${Math.round(v)}`}>
            <span className="w-4">{icon}</span>
            <span className="w-9 text-parch-dim">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full" style={{ width: `${v}%`, background: v < 25 ? '#f87171' : v < 50 ? '#fbbf24' : '#6ee7b7' }} />
            </div>
          </div>
        ))}
      </div>
      {wish && <div className="text-[11px] text-amber-200/90">🙏 {wish.label} — 지어 주면 좋아할 거예요.</div>}
    </div>
  );
}

/** person: their pets · animal: the family it lives with (or 입양 보내기) */
function PetRow({ game, a }: { game: Game; a: Agent }) {
  const w = game.world;
  const [picking, setPicking] = useState(false);
  if (a.kind === 'person') {
    const pets = w.agents.filter((x) => x.ownerId === a.id);
    if (!pets.length) return null;
    return (
      <div className="text-xs text-parch-dim">
        🐾 반려동물{' '}
        {pets.map((p) => (
          <button key={p.id} className="mr-1 text-glow/90 hover:underline" onClick={() => game.focus(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
    );
  }
  const owner = w.agent(a.ownerId);
  if (owner)
    return (
      <div className="text-xs text-parch-dim">
        🏠{' '}
        <button className="text-glow/90 hover:underline" onClick={() => game.focus(owner.id)}>
          {owner.name}
        </button>
        의 가족
      </div>
    );
  const people = w.agents.filter((x) => x.kind === 'person' && x.homeId).sort((x, y) => w.feel(y.id, a.id) - w.feel(x.id, a.id));
  if (!people.length) return null;
  return picking ? (
    <select
      autoFocus
      defaultValue=""
      onBlur={() => setPicking(false)}
      onChange={(ev) => {
        setPicking(false);
        if (ev.target.value) game.toast(game.dispatch({ type: 'SYSTEM', action: 'ADOPT', value: a.id, target: { id: ev.target.value } }));
      }}
      className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs text-parch"
    >
      <option value="">누구네 가족이 될까요?</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} (마음 {Math.round(w.feel(p.id, a.id))})
        </option>
      ))}
    </select>
  ) : (
    <button className="justify-self-start text-xs text-glow/80 hover:text-glow" onClick={() => setPicking(true)}>
      🐾 입양 보내기…
    </button>
  );
}

/** 💬 the player talks to a Will; they answer in character (✨ when the storyteller wrote it) */
function TalkView({ game, a }: { game: Game; a: Agent }) {
  const w = game.world;
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const log = w.talks.get(a.id) ?? [];
  const waiting = log.length > 0 && log[log.length - 1].who === 'me';
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log.length]);
  const send = (t = text) => {
    const s = t.trim();
    if (!s || waiting) return;
    game.toast(game.dispatch({ type: 'TALK', target: { id: a.id }, text: s }));
    setText('');
  };
  const ideas = ['요즘 기분 어때요?', '뭘 좋아해요?', '제일 친한 사람이 누구예요?', '꿈이 뭐예요?', '필요한 거 있어요?', '오늘도 힘내요!'];
  return (
    <div className="grid gap-2">
      <div ref={box} className="scroll-thin grid max-h-[260px] gap-1.5 overflow-y-auto">
        {log.length === 0 && <div className="text-xs text-parch-dim/80">{a.name}에게 말을 걸어 보세요. 성격·기분·관계·바람에 맞게 대답해요. 들어 주는 것만으로도 기분이 조금 좋아져요.</div>}
        {log.map((m, i) => (
          <div key={i} className={`max-w-[85%] px-2 py-1 text-[12.5px] leading-snug ${m.who === 'me' ? 'justify-self-end bg-glow/20 text-parch' : 'justify-self-start bg-white/8 font-serif text-parch/90'}`}>
            {m.text}
            {m.ai && <span className="ml-1 text-[10px] text-glow/70" title="AI 이야기꾼이 쓴 대답">✨</span>}
          </div>
        ))}
        {waiting && <div className="justify-self-start bg-white/8 px-2 py-1 text-[12.5px] text-parch-dim">…</div>}
      </div>
      <div className="flex flex-wrap gap-1">
        {ideas.map((s) => (
          <button key={s} disabled={waiting} className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-parch-dim hover:bg-white/15 hover:text-parch disabled:opacity-40" onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="flex gap-1"
        onSubmit={(ev) => {
          ev.preventDefault();
          send();
        }}
      >
        <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder={waiting ? '대답을 기다리는 중…' : `${a.name}에게 할 말`} maxLength={120} className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-parch outline-none focus:border-glow/60" />
        <Btn className="!px-2 text-xs" disabled={waiting || !text.trim()}>
          보내기
        </Btn>
      </form>
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
        <button className="shrink-0 text-parch-dim hover:text-parch" title="집으로 카메라 이동" onClick={() => a.homeId && game.focus(a.homeId)}>
          🏠 사는 곳
        </button>
        <select
          value={a.homeId ?? ''}
          onChange={(ev) => {
            const prev = a.homeId;
            const p = w.place(ev.target.value || undefined);
            w.setHome(a, p);
            game.pushUndo({ label: `${a.name} 이사`, undo: () => void (a.homeId = prev) });
            game.toast({ ok: true, message: p ? `🏠 ${a.name} → ${p.name}` : `${a.name}의 집을 비웠어요.` });
          }}
          className="min-w-0 max-w-[170px] truncate rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs text-parch"
        >
          <option value="">— 집 없음 —</option>
          {w.places
            .filter((p) => p.style === 'home')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({w.residentsOf(p).length}명)
              </option>
            ))}
        </select>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-parch-dim">🛏️ 생활 리듬</span>
        <span className="text-parch" title="특성 문장(밤·새벽·별·아침형 등)으로 정해지고, 단서가 없으면 무작위예요">
          {(() => {
            const [s, e] = w.sleepWindow(a);
            const t = (x: number) => `${Math.floor(x)}:${x % 1 ? '30' : '00'}`;
            const kind = w.nightShift(a) ? '🌃 야간 근무' : { lark: '🐓 아침형', normal: '보통', owl: '🦉 올빼미형' }[w.chronotype(a)];
            return `${kind} · ${t(s)}~${t(e)} 잠`;
          })()}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-parch-dim" title="태어날 때 정해진 직업은 '되고 싶은 일'이에요. 실제로는 그날그날 비어 있는 일터에서 일하고, 꿈에 가까운 곳을 더 좋아해요.">
          💭 {/학생/.test(a.job) ? a.job : `장래희망: ${a.job || '아직 없음'}`}
        </span>
        <select
          value={a.workPin === 'none' ? 'none' : a.workPin ?? 'free'}
          onChange={(ev) => {
            const v = ev.target.value;
            game.toast(game.dispatch({ type: 'MODIFY_ENTITY', target: { id: a.id }, changes: { workplace: v === 'none' ? null : { id: v } } }));
          }}
          className="min-w-0 max-w-[170px] truncate rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs text-parch"
          title="일하는 방식"
        >
          <option value="free">🔀 자유롭게 (그날그날)</option>
          <option value="none">💤 일 쉬기</option>
          {workplaces.map((p) => (
            <option key={p.id} value={p.id}>
              📌 {p.name}에서만
            </option>
          ))}
        </select>
      </div>
      <div className="text-[11px] text-parch-dim">
        {!game.world.worksAtAll(a)
          ? '일은 하지 않아요.'
          : `근무 ${game.world.shiftStart(a)}:00 ~ ${(game.world.shiftStart(a) + 6) % 24}:00${a.ai.working && work ? ` · 지금 ${work.name}에서 일하는 중` : work ? ` · 최근 일터: ${work.name}` : ''}${work && game.world.dreamFit(a, work) >= 0.5 ? ' · 꿈에 가까운 일 ✨' : ''}`}
      </div>
    </div>
  );
}

function PlaceStatus({ game, p }: { game: Game; p: Place }) {
  const visitors = game.world.agents.filter((a) => a.ai.targetPlaceId === p.id);
  const workers = game.world.agents.filter((a) => a.jobId === p.id);
  return (
    <div className="grid gap-3 text-xs">
      <BioText id={p.id} name={p.name} draft={placeBio(game.world, p)} />
      {p.style === 'home' && (
        <div>
          <div className="mb-1 text-parch-dim">🏠 사는 윌 ({game.world.residentsOf(p).length})</div>
          <div className="flex flex-wrap gap-1">
            {game.world.residentsOf(p).length === 0 && <span className="text-parch-dim/70">아직 아무도 살지 않아요. 윌을 우클릭 → 「살 집 정하기」로 이사시킬 수 있어요.</span>}
            {game.world.residentsOf(p).map((v) => (
              <button key={v.id} className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-parch hover:bg-emerald-400/25" onClick={() => game.focus(v.id)}>
                🏠 {v.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {workers.length > 0 && (
        <div>
          <div className="mb-1 text-parch-dim">요즘 일하는 윌 ({workers.length}/{p.workSpots.length})</div>
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
  // click-to-edit: tweak a few words of an existing trait without deleting and retyping it
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  useEffect(() => setEditing(null), [e.id]);
  const saveEdit = (i: number) => {
    const before = e.traits[i];
    const after = editText.trim();
    setEditing(null);
    if (before === undefined || !after || after === before) return;
    const traits = e.traits.map((t, k) => (k === i ? after : t));
    game.toast(game.dispatch({ type: 'MODIFY_ENTITY', target: { id: e.id }, changes: { traits } }));
  };
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
            {editing === i ? (
              <input
                autoFocus
                value={editText}
                onChange={(ev) => setEditText(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.nativeEvent.isComposing) return;
                  if (ev.key === 'Enter') saveEdit(i);
                  if (ev.key === 'Escape') setEditing(null);
                }}
                onBlur={() => saveEdit(i)}
                className="min-w-0 flex-1 rounded border border-glow/50 bg-black/40 px-1.5 py-0.5 text-xs text-parch outline-none"
              />
            ) : (
              <button className="flex-1 cursor-text text-left hover:text-parch" title="클릭해서 바로 고치기" onClick={() => (setEditing(i), setEditText(t))}>
                {t}
              </button>
            )}
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

function FeelBar({ label, v }: { label: string; v: number }) {
  const col = v >= 0 ? '#7ccf7a' : '#e06b6b';
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-[11px] text-parch-dim">{label}</span>
      <div className="relative h-1.5 flex-1 bg-white/10">
        <div className="absolute top-0 h-full w-px bg-white/30" style={{ left: '50%' }} />
        <div className="absolute top-0 h-full" style={{ background: col, left: v >= 0 ? '50%' : `${50 + v / 2}%`, width: `${Math.abs(v) / 2}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[11px]" style={{ color: col }}>
        {v > 0 ? '+' : ''}
        {Math.round(v)}
      </span>
    </div>
  );
}

function Relations({ game, a }: { game: Game; a: Agent }) {
  const [view, setView] = useState<'list' | 'map'>('list');
  return (
    <div className="grid gap-2">
      <div className="flex gap-1 text-xs">
        {(['list', 'map'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 ${view === v ? 'bg-white/12 text-parch' : 'text-parch-dim hover:text-parch'}`}>
            {v === 'list' ? '☰ 목록' : '🕸 마인드맵'}
          </button>
        ))}
      </div>
      {view === 'list' ? <RelationList game={game} a={a} /> : <RelationMap game={game} a={a} />}
    </div>
  );
}

/** Radial mind map: centre = selected Will; both directions drawn as separate arrows. */
function RelationMap({ game, a }: { game: Game; a: Agent }) {
  const w = game.world;
  const [edge, setEdge] = useState<string | null>(null);
  const W = 310, H = 300, cx = W / 2, cy = H / 2;
  const others = [...w.relations.values()]
    .filter((r) => r.a === a.id || r.b === a.id)
    .map((r) => {
      const o = w.agent(r.a === a.id ? r.b : r.a);
      return o ? { r, o, mine: w.feel(a.id, o.id), theirs: w.feel(o.id, a.id) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((x, y) => Math.max(Math.abs(y.mine), Math.abs(y.theirs)) - Math.max(Math.abs(x.mine), Math.abs(x.theirs)))
    .slice(0, 12);
  // favourite places (regulars) as square nodes
  const places = w.places
    .map((p) => ({ p, n: p.regulars[a.id] ?? 0, work: a.jobId === p.id }))
    .filter((x) => x.n >= 2 || x.work)
    .sort((x, y) => y.n - x.n)
    .slice(0, 3);
  const total = others.length + places.length;
  if (!total) return <div className="text-xs text-parch-dim/80">아직 아는 이가 없어요. 시간이 지나면 관계가 생겨요.</div>;
  const col = (v: number) => (v >= 50 ? '#7ccf7a' : v >= 15 ? '#b6d97a' : v > -15 ? '#a8987a' : v > -50 ? '#ec8a3a' : '#e06b6b');
  const nodes = [
    ...others.map((x, i) => {
      const ang = -Math.PI / 2 + (i / total) * Math.PI * 2;
      const closeness = Math.max(Math.abs(x.mine), Math.abs(x.theirs)) / 100;
      const R = 125 - closeness * 45;
      return { kind: 'agent' as const, ...x, x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R * 0.86 };
    }),
  ];
  const placeNodes = places.map((x, i) => {
    const ang = -Math.PI / 2 + ((others.length + i) / total) * Math.PI * 2;
    return { ...x, x: cx + Math.cos(ang) * 128, y: cy + Math.sin(ang) * 128 * 0.86 };
  });
  const sel = nodes.find((n) => n.o.id === edge);
  return (
    <div className="grid gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none rounded-md bg-black/25">
        <defs>
          {['#7ccf7a', '#b6d97a', '#a8987a', '#ec8a3a', '#e06b6b'].map((c) => (
            <marker key={c} id={`arr${c.slice(1)}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill={c} />
            </marker>
          ))}
        </defs>
        {placeNodes.map(({ p, x, y, n, work }) => (
          <g key={p.id} className="cursor-pointer" onClick={() => game.focus(p.id)}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="#8a8dbd" strokeWidth={1.2} strokeDasharray="3 3" />
            <rect x={x - 7} y={y - 7} width={14} height={14} fill="#2a2219" stroke="#8a8dbd" />
            <text x={x} y={y + 18} textAnchor="middle" fontSize="9" fill="#a8acd8">
              {p.name.length > 8 ? p.name.slice(0, 8) + '…' : p.name}
            </text>
            <text x={x} y={y + 28} textAnchor="middle" fontSize="8" fill="#8a8dbd">
              {work ? '일터' : `단골 ${n}회`}
            </text>
          </g>
        ))}
        {nodes.map((n) => {
          const dx = n.x - cx, dy = n.y - cy, len = Math.hypot(dx, dy) || 1;
          const ox = (-dy / len) * 3.5, oy = (dx / len) * 3.5; // parallel offset for the two directions
          const r0 = 15, r1 = 12;
          const sx = cx + (dx / len) * r0, sy = cy + (dy / len) * r0, ex = n.x - (dx / len) * r1, ey = n.y - (dy / len) * r1;
          const cm = col(n.mine), ct = col(n.theirs);
          return (
            <g key={n.o.id} className="cursor-pointer" onClick={() => setEdge(edge === n.o.id ? null : n.o.id)}>
              <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="transparent" strokeWidth={14} />
              <line x1={sx + ox} y1={sy + oy} x2={ex + ox} y2={ey + oy} stroke={cm} strokeWidth={1 + Math.abs(n.mine) / 28} markerEnd={`url(#arr${cm.slice(1)})`} opacity={edge && edge !== n.o.id ? 0.35 : 1} />
              <line x1={ex - ox} y1={ey - oy} x2={sx - ox} y2={sy - oy} stroke={ct} strokeWidth={1 + Math.abs(n.theirs) / 28} markerEnd={`url(#arr${ct.slice(1)})`} opacity={edge && edge !== n.o.id ? 0.35 : 1} />
            </g>
          );
        })}
        {nodes.map((n) => (
          <g key={n.o.id + 'n'} className="cursor-pointer" onClick={() => game.focus(n.o.id)}>
            <circle cx={n.x} cy={n.y} r={12} fill={n.o.kind === 'animal' ? '#1f4f4a' : '#3a3020'} stroke={edge === n.o.id ? '#ffcf6e' : '#e9d8b4'} strokeWidth={edge === n.o.id ? 2 : 1} />
            <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize="10" fill="#f3e6c8">
              {n.o.kind === 'animal' ? '🐾' : n.o.name.slice(-2, -1) === '' ? n.o.name : n.o.name.slice(1, 2)}
            </text>
            <text x={n.x} y={n.y + 25} textAnchor="middle" fontSize="10" fill="#f3e6c8">
              {n.o.name}
            </text>
            <text x={n.x} y={n.y + 36} textAnchor="middle" fontSize="8" fill="#a8987a">
              {relationLabel(n.mine, n.theirs, n.o.name, game.world.peekRelation(a.id, n.o.id)?.status).replace(/의 일방적 호감$/, '→ 호감')}
            </text>
          </g>
        ))}
        <circle cx={cx} cy={cy} r={15} fill="#ffcf6e" stroke="#14110d" strokeWidth={2} />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fill="#14110d" fontWeight="bold">
          {a.name.length === 3 ? a.name.slice(1, 2) : a.name.slice(0, 1)}
        </text>
        <text x={cx} y={cy + 29} textAnchor="middle" fontSize="10" fill="#ffcf6e">
          {a.name}
        </text>
      </svg>
      <p className="text-[10px] leading-relaxed text-parch-dim">동그라미 = 선택 · 선 = 함께한 기억 · 바깥쪽 화살표 = {a.name}의 마음, 안쪽 화살표 = 상대의 마음 · 점선 네모 = 단골 장소/일터</p>
      {sel && (
        <div className="grid gap-1 border-l border-white/15 pl-2 text-xs">
          <div className="text-parch">
            {a.name} ↔ {sel.o.name} <span className="text-parch-dim">· {relationLabel(sel.mine, sel.theirs, sel.o.name, game.world.peekRelation(a.id, sel.o.id)?.status)}</span>
          </div>
          <FeelBar label={`${a.name} → ${sel.o.name}`} v={sel.mine} />
          <FeelBar label={`${sel.o.name} → ${a.name}`} v={sel.theirs} />
          {sel.r.memories.length === 0 && <span className="text-parch-dim/70">기억할 만한 일은 아직 없어요.</span>}
          {sel.r.memories.map((m, i) => (
            <div key={i} className="text-parch/80">
              <span className="mr-1 text-parch-dim">{formatClock(m.t).split(' ')[0]}</span>
              {m.text}
            </div>
          ))}
          <button className="mt-1 self-start text-glow/90 hover:text-glow" onClick={() => game.focus(sel.o.id)}>
            추적하기 →
          </button>
        </div>
      )}
    </div>
  );
}

function RelationList({ game, a }: { game: Game; a: Agent }) {
  const w = game.world;
  const [open, setOpen] = useState<string | null>(null);
  const rels = [...w.relations.values()]
    .filter((r) => r.a === a.id || r.b === a.id)
    .map((r) => {
      const other = w.agent(r.a === a.id ? r.b : r.a);
      return { r, other, mine: other ? w.feel(a.id, other.id) : 0, theirs: other ? w.feel(other.id, a.id) : 0 };
    })
    .filter((x) => x.other)
    .sort((x, y) => Math.max(Math.abs(y.mine), Math.abs(y.theirs)) - Math.max(Math.abs(x.mine), Math.abs(x.theirs)));
  if (!rels.length) return <div className="text-xs text-parch-dim/80">아직 아는 이가 없어요. 시간이 지나면 관계가 생겨요.</div>;
  return (
    <ul className="grid gap-1.5">
      {rels.map(({ r, other, mine, theirs }) => (
        <li key={other!.id} className="rounded-md bg-white/5 p-2 text-xs">
          <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === other!.id ? null : other!.id)}>
            <span className="flex-1 text-parch">{other!.name}</span>
            <span className="text-parch-dim">{relationLabel(mine, theirs, other!.name, r.status)}</span>
          </button>
          {/* both directions — feelings are not always mutual */}
          <div className="mt-1.5 grid gap-1">
            <FeelBar label={`${a.name} → ${other!.name}`} v={mine} />
            <FeelBar label={`${other!.name} → ${a.name}`} v={theirs} />
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
      ))}
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
