import { useRef, useState } from 'react';
import { getVolume, isMuted, setMuted, setVolume } from '../audio/sfx';
import { COMMAND_EXAMPLES } from '../commands/ruleParser';
import { SHORTCUTS } from './shortcuts';
import type { Game } from '../engine/Game';
import { deleteSlot, deserializeWorld, downloadSave, listSlots, readSlot, serializeWorld, type SaveFile } from '../engine/save';
import type { World } from '../engine/World';
import { formatClock } from '../engine/util';
import { Btn, Modal } from './Modal';
import { EmbeddingService, embeddings } from '../ai/embeddings';
import { Storyteller, storyteller } from '../ai/storyteller';
import { LOCAL_MODELS, type LocalModelKey } from '../ai/models';
import { pauseOnModalSetting, setPauseOnModal } from './modalState';
import { music } from '../audio/music';
import { SharePanel } from './SharePanel';
import { aiWhere, isRemotePage, setAiWhere } from '../ai/remote';

const WORLD_PRESETS = ['현대 서울', '중세 판타지', '좀비 아포칼립스', '사이버펑크 도시', '고등학교', '해적 항구', '우주 정거장', '조선 한양', '비 오는 레트로 서울'];

export function WorldModal({ game, onClose }: { game: Game; onClose: () => void }) {
  const [text, setText] = useState(game.world.meta.context);
  const apply = (ctx: string) => {
    game.toast(game.dispatch({ type: 'SET_WORLD_CONTEXT', context: ctx }));
    onClose();
  };
  return (
    <Modal title="🌍 세계관" onClose={onClose}>
      <p className="mb-3 text-xs leading-relaxed text-parch-dim">세계관을 바꾸면 거리의 모습과, 앞으로 태어날 존재들의 특성·외형이 그 세계에 맞게 정해져요.</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {WORLD_PRESETS.map((p) => (
          <button key={p} onClick={() => apply(p)} className={`rounded-full px-3 py-1 text-sm ${game.world.meta.context === p ? 'bg-glow text-ink' : 'bg-white/8 text-parch hover:bg-white/15'}`}>
            {p}
          </button>
        ))}
      </div>
      <label className="text-xs text-parch-dim">
        직접 쓰기
        <div className="mt-1 flex gap-1.5">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply(text)} className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-parch outline-none focus:border-glow/50" />
          <Btn variant="primary" onClick={() => apply(text)}>
            적용
          </Btn>
        </div>
      </label>
    </Modal>
  );
}

function PeopleSelect({ people, v, set }: { people: { id: string; name: string }[]; v: string; set: (s: string) => void }) {
  return (
    <select value={v} onChange={(e) => set(e.target.value)} className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-2 text-sm text-parch outline-none">
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function MeetModal({ game, onClose }: { game: Game; onClose: () => void }) {
  const people = game.world.agents.filter((a) => a.kind === 'person');
  const [a, setA] = useState(game.selectedId && people.some((p) => p.id === game.selectedId) ? game.selectedId : people[0]?.id ?? '');
  const [b, setB] = useState(people.find((p) => p.id !== a)?.id ?? '');
  return (
    <Modal title="👣 두 윌 마주치게 하기" onClose={onClose}>
      {people.length < 2 ? (
        <p className="text-sm text-parch-dim">윌이 둘 이상 있어야 해요.</p>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <PeopleSelect people={people} v={a} set={setA} />
            <span className="text-parch-dim">와(과)</span>
            <PeopleSelect people={people} v={b} set={setB} />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={onClose}>
              취소
            </Btn>
            <Btn
              variant="primary"
              disabled={a === b}
              onClick={() => {
                game.toast(game.dispatch({ type: 'TRIGGER_EVENT', event: 'MEET', targets: [{ id: a }, { id: b }] }));
                onClose();
              }}
            >
              마주치게 하기
            </Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

export const API_KEY_STORAGE = 'asiwrite.apiKey';
export const API_PROVIDER_STORAGE = 'asiwrite.apiProvider';

export function SettingsModal({ game, onClose }: { game: Game | null; onClose: () => void }) {
  const [vol, setVol] = useState(getVolume());
  const [mute, setMute] = useState(isMuted());
  const [names, setNames] = useState(game?.renderer?.showNames ?? true);
  const read = (k: string) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  };
  const [provider, setProvider] = useState(read(API_PROVIDER_STORAGE) || 'none');
  const [key, setKey] = useState(read(API_KEY_STORAGE));
  const [embedOn, setEmbedOn] = useState(EmbeddingService.enabledSetting());
  const [storyOn, setStoryOn] = useState(storyteller.backend() !== 'off');
  const [model, setModel] = useState<LocalModelKey>(storyteller.modelKey());
  const [aiLoad, setAiLoad] = useState(Storyteller.loadSetting());
  const [where, setWhere] = useState(aiWhere());
  const [autoSkip, setAutoSkip] = useState(game?.autoSkipNight ?? true);
  const [migration, setMigration] = useState(game?.world.migration ?? true);
  const [holdOnModal, setHoldOnModal] = useState(pauseOnModalSetting());
  const [musicOn, setMusicOn] = useState(music.enabled);
  const [musicVol, setMusicVol] = useState(music.volume);
  const save = () => {
    game?.setAutoSkip(autoSkip);
    if (game) game.world.migration = migration;
    setPauseOnModal(holdOnModal);
    const modelChanged = model !== storyteller.modelKey();
    Storyteller.setModelSetting(model);
    try {
      localStorage.setItem(API_PROVIDER_STORAGE, provider);
      if (key) localStorage.setItem(API_KEY_STORAGE, key);
      else localStorage.removeItem(API_KEY_STORAGE);
    } catch {
      /* ignore */
    }
    EmbeddingService.setEnabledSetting(embedOn);
    if (!embedOn) embeddings.stop();
    else if (embeddings.state === 'off' || embeddings.state === 'idle') {
      embeddings.state = 'idle';
      embeddings.start();
    }
    Storyteller.setBackendSetting(storyOn);
    Storyteller.setLoadSetting(aiLoad);
    if (isRemotePage() && where !== aiWhere()) {
      setAiWhere(where);
      setTimeout(() => location.reload(), 200); // the AI services start over in the chosen place
    }
    if (game) {
      if (modelChanged && storyOn) storyteller.restart(); // load the newly chosen local model
      else storyteller.start(); // re-evaluates the backend (off / local / cloud)
    }
    onClose();
  };
  return (
    <Modal title="⚙️ 설정" onClose={onClose}>
      <div className="grid gap-4 text-sm">
        <label className="grid gap-1">
          <span className="text-xs text-parch-dim">효과음 크기</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={vol}
            onChange={(e) => {
              setVol(+e.target.value);
              setVolume(+e.target.value);
            }}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={mute}
            onChange={(e) => {
              setMute(e.target.checked);
              setMuted(e.target.checked);
              if (e.target.checked) music.stop();
              else if (game) music.start();
            }}
          />
          음소거
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={musicOn}
            onChange={(e) => {
              setMusicOn(e.target.checked);
              music.setEnabled(e.target.checked);
              if (e.target.checked && game) music.start();
            }}
          />
          🎵 배경 음악 (세계관·시간·날씨·동네 분위기에 따라 바뀌어요)
        </label>
        {musicOn && (
          <label className="grid gap-1">
            <span className="text-xs text-parch-dim">배경 음악 크기</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={musicVol}
              onChange={(e) => {
                setMusicVol(+e.target.value);
                music.setVolume(+e.target.value);
              }}
            />
          </label>
        )}
        {game && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={names}
              onChange={(e) => {
                setNames(e.target.checked);
                if (game.renderer) game.renderer.showNames = e.target.checked;
              }}
            />
            이름표 보이기
          </label>
        )}
        {game && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoSkip} onChange={(e) => setAutoSkip(e.target.checked)} />
            🌙 모두 잠들면 아침까지 자동으로 빨리 감기
          </label>
        )}
        {game && (
          <label className="flex items-center gap-2" title="동네 분위기가 좋으면 새 윌이 이사 오고, 이틀 넘게 몹시 힘들어한 윌은 떠나요 (떠나기 전날 알려 줘요)">
            <input type="checkbox" checked={migration} onChange={(e) => setMigration(e.target.checked)} />
            🧳 이사 오고 떠나기 (이 세계에 저장돼요)
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={holdOnModal} onChange={(e) => setHoldOnModal(e.target.checked)} />
          ⏸ 창(설정·소환·목록 등)이 떠 있는 동안 시간 멈추기
        </label>
        <div className="grid gap-2 rounded-lg border border-white/10 p-3">
          <div className="text-xs font-semibold text-parch">🧠 의미 모델 (한국어 문장 임베딩 ko-sroberta)</div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={embedOn} onChange={(e) => setEmbedOn(e.target.checked)} />
            사용하기 — 특성·취향을 <b>뜻</b>으로 비교해요 (처음 한 번 약 440MB 다운로드, 이후 브라우저에 저장)
          </label>
          <p className="text-[11px] text-parch-dim">상태: {embeddings.state === 'ready' ? `준비됨 (${embeddings.size}개 문장)` : embeddings.state === 'loading' ? `내려받는 중 ${Math.round(embeddings.progress * 100)}%` : embeddings.state === 'error' ? `실패 — 어휘 비교로 동작 중 (${embeddings.error.slice(0, 60)})` : embeddings.state === 'off' ? '꺼짐 — 어휘 비교로 동작 중' : '대기'}</p>
        </div>
        <SharePanel />
        {isRemotePage() && (
          <div className="grid gap-1.5 rounded-lg border border-white/10 p-3 text-xs">
            <div className="font-semibold text-parch">🖥 AI를 어디서 돌릴까요? (다른 PC에서 접속 중)</div>
            <label className="flex items-start gap-2">
              <input type="radio" name="ai-where" className="mt-0.5" checked={where === 'host'} onChange={() => setWhere('host')} />
              <span>
                <b className="text-parch">서버 PC에서</b> <span className="text-parch-dim">(기본) — 이야기꾼·의미 모델을 서버 PC가 계산해요. 이 PC는 내려받을 것도, GPU 부하도 없어요. 서버 PC에서 게임 탭이 열려 있어야 해요.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="ai-where" className="mt-0.5" checked={where === 'mine'} onChange={() => setWhere('mine')} />
              <span>
                <b className="text-parch">내 브라우저에서</b> <span className="text-parch-dim">— 이 PC가 모델을 내려받아 직접 계산해요(수 GB). 보안 연결이 아니라 GPU가 막히면 작은 모델·CPU로 돌아요.</span>
              </span>
            </label>
            <p className="text-[11px] text-parch-dim">바꾸면 확인을 누를 때 페이지를 새로 불러와요. 마을 시뮬레이션과 화면 그리기는 항상 이 PC에서 돌아가요(가벼워요).</p>
          </div>
        )}
        <div className="grid gap-2 rounded-lg border border-white/10 p-3">
          <div className="text-xs font-semibold text-parch">✨ AI 이야기꾼 (대사·장문·소개글 다듬기)</div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={storyOn} onChange={(e) => setStoryOn(e.target.checked)} />
            사용하기 — 윌들의 말을 성격·기분·관계에 맞게 자연스럽게 다시 써요
          </label>
          <div className="flex gap-1.5">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!storyOn} className="rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-parch disabled:opacity-40">
              <option value="none">브라우저 안 모델 (무료 · 키 불필요)</option>
              <option value="gemini">Gemini (내 API 키)</option>
              <option value="groq">Groq (내 API 키)</option>
            </select>
            {provider !== 'none' && storyOn && (
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API 키" className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-parch outline-none" />
            )}
          </div>
          {provider === 'none' && storyOn && (
            <div className="flex flex-wrap items-center gap-1 text-xs" title="문장을 만드는 동안 GPU를 얼마나 쓸지. 낮출수록 GPU 사용률 봉우리가 낮고 넓게 퍼지고(팬 소음·발열↓), 대신 다듬은 문장이 조금 늦게 나와요.">
              <span className="text-parch-dim">GPU 부하</span>
              {([['eco', '🌿 절약 (약 30%)'], ['balanced', '⚖️ 보통 (약 55%)'], ['max', '🚀 최대 (빠름)']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setAiLoad(k)} className={`rounded-md border px-2 py-0.5 ${aiLoad === k ? 'border-glow/70 bg-glow/20 text-parch' : 'border-white/10 text-parch-dim hover:bg-white/10'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {provider === 'none' && storyOn && (
            <div className="grid gap-1">
              {Object.values(LOCAL_MODELS).map((m) => (
                <label key={m.key} className="flex items-start gap-2 text-xs">
                  <input type="radio" name="story-model" className="mt-0.5" checked={model === m.key} onChange={() => setModel(m.key)} />
                  <span>
                    <b className="text-parch">{m.label}</b> <span className="text-parch-dim">· {m.size}</span>
                    <br />
                    <span className="text-[11px] text-parch-dim">{m.note}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-parch-dim">
            브라우저 안 모델은 처음 한 번만 내려받고 이후엔 브라우저에 저장돼요(GPU가 없으면 느려요). 켤 때 시험 문장을 하나 써 보고, GPU 계산이 깨지면 자동으로 CPU로 다시 불러와요. API 키는 이 브라우저에만 저장돼요. 이야기꾼이 꺼져 있거나 준비 중이어도 게임은 기본 문장으로 그대로 진행돼요.
          </p>
          <p className="text-[11px] text-parch-dim">
            상태: {storyteller.label()} · 다듬은 문장 {storyteller.stats.done}개 · 걸러진 문장 {storyteller.stats.rejected}개 · 지금 다듬는 비율(자동) {Math.round(storyteller.capacity() * 100)}%
            {storyteller.selfCheck && <> · 시험 문장: “{storyteller.selfCheck.sample}”</>}
          </p>
          {storyteller.failures.length > 0 && (
            <div className="grid gap-0.5 border-l-2 border-red-300/40 pl-2 text-[11px] text-red-200/80">
              <div className="text-parch-dim">이 컴퓨터에서 시도했다가 안 된 방법 {storyteller.state === 'error' ? '(확인을 누르면 다시 시도해요)' : '(다음 방법으로 넘어갔어요)'}</div>
              {storyteller.failures.map((f, i) => (
                <div key={i} className="break-all font-mono">
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Btn variant="primary" onClick={save}>
          확인
        </Btn>
      </div>
    </Modal>
  );
}

export function LoadModal({ game, onLoad, onClose }: { game: Game | null; onLoad: (w: World) => void; onClose: () => void }) {
  const [slots, setSlots] = useState(listSlots());
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const load = (s: SaveFile | null) => {
    if (!s) return setErr('세이브를 읽지 못했어요.');
    try {
      onLoad(deserializeWorld(s));
      onClose();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };
  const [saveName, setSaveName] = useState(game?.world.meta.name ?? '');
  return (
    <Modal title="📂 불러오기 · 저장" onClose={onClose}>
      {game && (
        <form
          className="mb-3 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const n = saveName.trim();
            game.toast(n && n !== game.world.meta.name ? game.dispatch({ type: 'RENAME_WORLD', name: n }) : game.dispatch({ type: 'SYSTEM', action: 'SAVE' }));
            setSlots(listSlots());
          }}
        >
          <input value={saveName} maxLength={30} onChange={(e) => setSaveName(e.target.value)} placeholder="세계 이름 (비우면 빠른 저장)" className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-parch outline-none focus:border-glow/50" />
          <Btn variant="primary" className="!px-3 text-xs">💾 이 이름으로 저장</Btn>
        </form>
      )}
      {slots.length === 0 ? (
        <p className="mb-3 text-sm text-parch-dim">저장된 세계가 없어요.</p>
      ) : (
        <ul className="mb-3 grid gap-1.5">
          {slots.map((s) => (
            <li key={s.slot} className="flex items-center gap-2 rounded-md bg-white/5 p-2 text-xs">
              <div className="flex-1">
                <div className="text-sm text-parch">
                  {s.name ? <b>📛 {s.name}</b> : s.slot === 'quick' ? '빠른 저장' : s.slot === 'auto' ? '자동 저장' : s.slot}
                  {s.name && s.slot === 'auto' ? ' (자동 저장)' : ''} · {s.context}
                </div>
                <div className="text-parch-dim">
                  {new Date(s.savedAt).toLocaleString('ko-KR')} · {formatClock(s.minutes)} · 존재 {s.agents}
                </div>
              </div>
              <Btn variant="primary" className="!px-2 text-xs" onClick={() => load(readSlot(s.slot))}>
                불러오기
              </Btn>
              <Btn
                variant="ghost"
                className="!px-2 text-xs"
                onClick={() => {
                  deleteSlot(s.slot);
                  setSlots(listSlots());
                }}
              >
                ✕
              </Btn>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Btn onClick={() => fileRef.current?.click()}>파일에서 불러오기</Btn>
        {game && <Btn onClick={() => downloadSave(serializeWorld(game.world))}>현재 세계 파일로 내보내기</Btn>}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              load(JSON.parse(await f.text()) as SaveFile);
            } catch {
              setErr('JSON 파일을 읽지 못했어요.');
            }
          }}
        />
      </div>
      {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
    </Modal>
  );
}

export function HelpModal({ onClose, onExample }: { onClose: () => void; onExample?: (s: string) => void }) {
  const groups = ['기본', '카메라 · 선택', '창조 · 개입', '창 · 시스템'] as const;
  const Key = ({ k }: { k: string }) => (
    <kbd className="rounded border border-white/20 bg-white/8 px-1.5 py-0.5 font-sans text-[11px] text-parch shadow-[0_1px_0_rgba(255,255,255,0.15)]">{k}</kbd>
  );
  return (
    <Modal title="❓ 단축키 · 도움말" onClose={onClose} wide>
      <div className="grid gap-5 text-sm md:grid-cols-2">
        {groups.map((g) => (
          <div key={g}>
            <h3 className="mb-2 text-xs font-semibold text-glow">{g}</h3>
            <ul className="grid gap-1">
              {g === '카메라 · 선택' && (
                <li className="flex items-center justify-between gap-2 text-xs text-parch/85">
                  <span>화면 이동 (Shift: 빠르게)</span>
                  <span className="flex flex-wrap justify-end gap-1">
                    <Key k="W A S D" />
                    <Key k="↑ ↓ ← →" />
                    <Key k="드래그" />
                  </span>
                </li>
              )}
              {g === '카메라 · 선택' && (
                <li className="flex items-center justify-between gap-2 text-xs text-parch/85">
                  <span>확대 · 축소</span>
                  <span className="flex flex-wrap justify-end gap-1">
                    <Key k="휠" />
                    <Key k="+ −" />
                    <Key k="PgUp PgDn" />
                  </span>
                </li>
              )}
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-xs text-parch/85">
                  <span>{s.label}</span>
                  <span className="flex flex-wrap justify-end gap-1">
                    {s.keys.map((k) => (
                      <Key key={k} k={k} />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <h3 className="mb-2 text-xs font-semibold text-glow">채팅창 안에서</h3>
          <ul className="grid gap-1 text-xs text-parch/85">
            <li className="flex justify-between gap-2"><span>추천 문장 고르기 / 바로 실행</span><span className="flex gap-1"><Key k="↓" /><Key k="Enter" /></span></li>
            <li className="flex justify-between gap-2"><span>추천 문장을 입력창에 채워 고쳐 쓰기</span><Key k="Tab" /></li>
            <li className="flex justify-between gap-2"><span>이전에 쓴 명령</span><Key k="↑" /></li>
            <li className="flex justify-between gap-2"><span>채팅창에서 빠져나오기</span><Key k="Esc" /></li>
          </ul>
          <p className="mt-2 text-[11px] text-parch-dim">단축키는 한/영 상태와 상관없이 같은 자리의 키로 동작해요. 대상을 선택한 뒤 채팅창을 열면 그 대상에 맞춘 추천이 나와요.</p>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold text-glow">이렇게 써 볼 수 있어요</h3>
          <ul className="grid gap-1">
            {COMMAND_EXAMPLES.slice(0, 8).map((c) => (
              <li key={c}>
                <button className="w-full rounded bg-white/5 px-2 py-1 text-left text-xs text-parch/90 hover:bg-white/12" onClick={() => onExample?.(c)}>
                  {c}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-parch-dim">「[이름] …」 텍스트 양식을 통째로 붙여 넣어도 소환돼요.</p>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold text-glow">무드 올려주기</h3>
          <p className="text-xs leading-relaxed text-parch/85">
            우울한 윌의 특성을 살펴보고, 좋아할 만한 존재나 장소를 근처에 만들어 주세요. 윌이 스스로 발견하면 크게 기뻐하고 일기에 남겨요. (축복으로 직접 올려줄 수도 있지만, 효과는 작아요.)
          </p>
        </div>
      </div>
    </Modal>
  );
}
