import { useEffect, useRef, useState } from 'react';
import { embeddings } from '../ai/embeddings';
import { storyteller } from '../ai/storyteller';
import { agentBio } from '../engine/bio';
import type { Game } from '../engine/Game';
import { bestMatch, HybridMatcher, semanticCalib } from '../engine/semantic';
import { TILE } from '../engine/TileMap';
import type { Agent, Place } from '../engine/types';
import { formatClock } from '../engine/util';
import { relationLabel } from './describe';
import { Modal } from './Modal';

type Tab = 'heat' | 'perf' | 'export';
type Mode = 'hybrid' | 'lexical' | 'embedding';

/** 📊 연구 · 분석 메트릭 — numbers and exports for the final report. */
export function ResearchPanel({ game, onClose }: { game: Game; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('heat');
  return (
    <Modal title="📊 연구 · 분석 메트릭" onClose={onClose} wide>
      <div className="mb-3 flex gap-1 text-xs">
        {(
          [
            ['heat', '🔥 유사도 히트맵'],
            ['perf', '⚡ 성능'],
            ['export', '📤 서사 내보내기'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-2.5 py-1 ${tab === k ? 'bg-white/12 text-parch' : 'text-parch-dim hover:text-parch'}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'heat' && <Heatmap game={game} />}
      {tab === 'perf' && <Perf game={game} />}
      {tab === 'export' && <Export game={game} />}
    </Modal>
  );
}

function cellColor(v: number | null) {
  if (v === null) return 'rgba(255,255,255,0.04)';
  const h = 220 - v * 200; // blue → amber
  return `hsl(${h} 70% ${18 + v * 32}%)`;
}

function Heatmap({ game }: { game: Game }) {
  const w = game.world;
  const [mode, setMode] = useState<Mode>('hybrid');
  const a = w.agent(game.selectedId ?? undefined);
  if (!a || a.kind !== 'person') return <p className="text-sm text-parch-dim">윌을 하나 선택하고 열면, 그 윌의 특성과 주변 존재 사이의 유사도를 보여 줘요.</p>;
  const near: (Agent | Place)[] = [
    ...w.agents.filter((b) => b !== a && Math.hypot(b.x - a.x, b.y - a.y) < TILE * 10).sort((x, y) => Math.hypot(x.x - a.x, x.y - a.y) - Math.hypot(y.x - a.x, y.y - a.y)).slice(0, 4),
    ...w.places.slice().sort((p, q) => Math.hypot((p.tx + p.tw / 2) * TILE - a.x, (p.ty + p.th / 2) * TILE - a.y) - Math.hypot((q.tx + q.tw / 2) * TILE - a.x, (q.ty + q.th / 2) * TILE - a.y)).slice(0, 3),
  ];
  const m = w.matcher as HybridMatcher;
  const score = (trait: string, e: Agent | Place): number | null => {
    const facets = w.facets(e);
    if (mode === 'hybrid') return bestMatch(m, trait, facets);
    if (mode === 'lexical') return bestMatch(m.lex, trait, facets);
    let best: number | null = null;
    for (const f of facets) {
      const v = m.embeddingSimilarity(trait, f);
      if (v !== null && (best === null || v > best)) best = v;
    }
    return best;
  };
  return (
    <div className="grid gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-parch-dim">값:</span>
        {(
          [
            ['hybrid', '게임이 쓰는 값 (어휘 ∪ 임베딩)'],
            ['lexical', '어휘만'],
            ['embedding', '임베딩만 (MiniLM)'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)} className={`px-2 py-0.5 ${mode === k ? 'bg-glow/25 text-parch' : 'bg-white/8 text-parch-dim hover:text-parch'}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="scroll-thin overflow-x-auto">
        <table className="border-separate border-spacing-0.5">
          <thead>
            <tr>
              <th className="min-w-40 text-left font-normal text-parch-dim">{a.name}의 특성 ↓ / 주변 →</th>
              {near.map((e) => (
                <th key={e.id} className="max-w-20 truncate px-1 font-normal text-parch" title={e.name}>
                  {e.kind === 'place' ? '🏠' : e.kind === 'animal' ? '🐾' : ''}
                  {e.name.length > 6 ? e.name.slice(0, 6) + '…' : e.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.traits.map((t) => (
              <tr key={t}>
                <td className="max-w-52 truncate pr-2 text-parch/85" title={t}>
                  {t}
                </td>
                {near.map((e) => {
                  const v = score(t, e);
                  return (
                    <td key={e.id} className="h-6 w-14 text-center font-mono text-[10px] text-white/90" style={{ background: cellColor(v) }}>
                      {v === null ? '–' : v.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-parch-dim">
        보정 {semanticCalib.calibrated ? '(측정값: 같은 뜻 쌍 중앙값 / 다른 뜻 쌍 90% 지점)' : '(모델 준비 전 — 글자 비교만 사용)'} · 명령: {semanticCalib.posMedian.toFixed(3)} / {semanticCalib.negP90.toFixed(3)} · 짧은 구절: {semanticCalib.phrase.posMedian.toFixed(3)} / {semanticCalib.phrase.negP90.toFixed(3)}{semanticCalib.calibrated && !semanticCalib.phrase.ok ? ' (구분 못 함 → 안 씀)' : ''} · 문장: {semanticCalib.sentence.posMedian.toFixed(3)} / {semanticCalib.sentence.negP90.toFixed(3)}{semanticCalib.calibrated && !semanticCalib.sentence.ok ? ' (구분 못 함 → 안 씀)' : ''} · 임베딩
        모델: {embeddings.state} · 「–」는 아직 벡터가 없는 칸
      </p>
    </div>
  );
}

function Perf({ game }: { game: Game }) {
  const w = game.world;
  const [, tick] = useState(0);
  const hist = useRef<number[]>([]);
  useEffect(() => {
    const t = setInterval(() => {
      hist.current = [...hist.current, Math.round(game.fps)].slice(-60);
      tick((n) => n + 1);
    }, 500);
    return () => clearInterval(t);
  }, [game]);
  const g = w.grid;
  const es = embeddings.stats;
  const ss = storyteller.stats;
  const hits = es.cacheHits + es.cacheMisses;
  const rows: [string, string][] = [
    ['FPS (평균)', `${Math.round(game.fps)} · 프레임 처리 ${game.frameMs.toFixed(2)} ms`],
    ['존재 수', `윌 ${w.agents.filter((a) => a.kind === 'person').length} · 동물 ${w.agents.filter((a) => a.kind === 'animal').length} · 시설 ${w.places.length} · 그룹 ${w.factions.length}`],
    ['지도', `${w.map.w}×${w.map.h}칸`],
    ['공간 격자 조회', `${g.queryCount.toLocaleString()}회 · 평균 ${g.queryCount ? ((g.queryTimeMs / g.queryCount) * 1000).toFixed(2) : '0'} µs`],
    ['AI 판단 (프레임당)', `${w.stats.thinkMs.toFixed(3)} ms · 경로 탐색 ${w.stats.pathMs.toFixed(3)} ms`],
    ['임베딩 (MiniLM)', `${embeddings.state} · 캐시 ${embeddings.size}개 · 적중률 ${hits ? Math.round((es.cacheHits / hits) * 100) : 0}% · 배치 ${es.batches}회 평균 ${es.avgBatchMs.toFixed(0)} ms · 대기 ${embeddings.queued}`],
    ['이야기꾼 (LLM)', `${storyteller.label()} · 완료 ${ss.done} · 거절 ${ss.rejected} · 버림 ${ss.dropped} · 평균 ${ss.avgMs.toFixed(0)} ms · 대기 ${storyteller.queued} · 다듬는 비율(자동) ${Math.round(storyteller.capacity() * 100)}%`],
    ['특성 변이', `완료 ${w.mutationsDone} · 화면 밖 대기 ${w.mutationQueue.size}명`],
    ['소문', `${w.rumors.rumors.length}개 · 이야기 기록 ${w.feed.length}줄`],
  ];
  const h = hist.current;
  const max = Math.max(60, ...h);
  return (
    <div className="grid gap-3 text-xs">
      <svg viewBox="0 0 240 50" className="h-16 w-full bg-black/25">
        <polyline fill="none" stroke="#ffcf6e" strokeWidth="1.5" points={h.map((v, i) => `${(i / 59) * 240},${50 - (v / max) * 46}`).join(' ')} />
        <text x="4" y="10" fontSize="8" fill="#a8987a">
          FPS (최근 30초)
        </text>
      </svg>
      <table className="w-full">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-white/5">
              <td className="w-36 py-1 text-parch-dim">{k}</td>
              <td className="py-1 font-mono text-[11px] text-parch">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {storyteller.rejects.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-parch-dim">이야기꾼이 거절당한 최근 출력 {storyteller.rejects.length}개 (검사에 걸려 원래 문장을 그대로 씀)</summary>
          <ul className="mt-1 grid gap-1">
            {storyteller.rejects.map((r, i) => (
              <li key={i} className="border-l-2 border-white/10 pl-2">
                <div className="text-parch-dim">초안: {r.draft || '—'}</div>
                <div className="break-all font-mono text-red-300/80">출력: {r.raw}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const el = document.createElement('a');
  el.href = url;
  el.download = name;
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function willMarkdown(game: Game, a: Agent): string {
  const w = game.world;
  const L: string[] = [`# ${a.name} (${a.kind === 'person' ? a.job || '윌' : a.category})`, '', agentBio(w, a), ''];
  L.push('## 특성', ...a.traits.map((t) => `- ${t}`), '');
  const muts = a.logs.filter((l) => l.kind === 'mutation');
  if (muts.length) L.push('## 변이 기록', ...muts.map((l) => `- ${formatClock(l.t)} ${l.text}`), '');
  const groups = w.factionsOf(a.id);
  if (groups.length) L.push('## 그룹', ...groups.map((f) => `- ${f.name} (${f.members.map((m) => w.agent(m)?.name).filter(Boolean).join(', ')})`), '');
  const rels = w.agents.filter((o) => o !== a && w.peekRelation(a.id, o.id));
  if (rels.length) {
    L.push('## 관계 (양방향)');
    for (const o of rels) {
      const mine = w.feel(a.id, o.id), theirs = w.feel(o.id, a.id);
      L.push(`- ${o.name}: ${relationLabel(mine, theirs, o.name)} (${a.name}→${o.name} ${Math.round(mine)}, ${o.name}→${a.name} ${Math.round(theirs)})`);
      for (const m of w.peekRelation(a.id, o.id)!.memories) L.push(`  - ${formatClock(m.t)} ${m.text}`);
    }
    L.push('');
  }
  L.push('## 일기 · 기록', ...a.logs.map((l) => `- ${formatClock(l.t)} [${l.kind}] ${l.text}`), '');
  return L.join('\n');
}

function Export({ game }: { game: Game }) {
  const w = game.world;
  const a = w.agent(game.selectedId ?? undefined);
  const stamp = formatClock(w.meta.minutes).replace(/\s/g, '_');
  return (
    <div className="grid gap-3 text-sm">
      <div className="grid gap-1.5 border border-white/10 p-3">
        <div className="text-xs text-parch-dim">선택한 윌{a ? `: ${a.name}` : ' (먼저 윌을 선택하세요)'}</div>
        <div className="flex flex-wrap gap-2">
          <button disabled={!a} className="bg-white/8 px-3 py-1.5 text-parch hover:bg-white/15 disabled:opacity-40" onClick={() => a && download(`${a.name}_${stamp}.md`, willMarkdown(game, a), 'text/markdown')}>
            일기·변이·관계 (Markdown)
          </button>
          <button
            disabled={!a}
            className="bg-white/8 px-3 py-1.5 text-parch hover:bg-white/15 disabled:opacity-40"
            onClick={() =>
              a &&
              download(
                `${a.name}_${stamp}.json`,
                JSON.stringify({ name: a.name, sheet: w.sheetOf(a), mood: a.mood, logs: a.logs, groups: w.factionsOf(a.id).map((f) => f.name), relations: w.agents.filter((o) => w.peekRelation(a.id, o.id)).map((o) => ({ with: o.name, mine: w.feel(a.id, o.id), theirs: w.feel(o.id, a.id), memories: w.peekRelation(a.id, o.id)!.memories })) }, null, 1),
                'application/json',
              )
            }
          >
            같은 내용 (JSON)
          </button>
        </div>
      </div>
      <div className="grid gap-1.5 border border-white/10 p-3">
        <div className="text-xs text-parch-dim">세계 전체</div>
        <button
          className="justify-self-start bg-white/8 px-3 py-1.5 text-parch hover:bg-white/15"
          onClick={() => {
            const parts = [
              `# 「${w.meta.context}」 — ${formatClock(w.meta.minutes)}`,
              '',
              '## 그룹',
              ...(w.factions.length ? w.factions.map((f) => `- ${f.name}: ${f.members.map((m) => w.agent(m)?.name).join(', ')}\n${f.logs.map((l) => `  - ${formatClock(l.t)} ${l.text}`).join('\n')}`) : ['- (없음)']),
              '',
              '## 지금의 트렌드',
              ...w.globalTrends(10).map((r) => `- ${r.rank}. ${r.rumor.tag} — ${r.rumor.text} (${r.rumor.knownBy.length}명)`),
              '',
              '## 이야기 기록',
              ...w.feed.map((f) => `- ${formatClock(f.t)} ${f.speaker ? `${f.speaker}${f.to ? ` → ${f.to}` : ''}: ` : ''}${f.text}${f.ai ? ' ✨' : ''}`),
              '',
              ...w.agents.filter((x) => x.kind === 'person').map((x) => willMarkdown(game, x)),
            ];
            download(`세계_서사_${stamp}.md`, parts.join('\n'), 'text/markdown');
          }}
        >
          세계 전체 서사 (Markdown)
        </button>
      </div>
      <p className="text-[11px] text-parch-dim">✨ 표시는 AI 이야기꾼이 다듬은 문장이에요. 보고서에서 템플릿 문장과 구분할 때 쓰세요.</p>
    </div>
  );
}
