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
  const save = () => {
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
    if (game) storyteller.start(); // re-evaluates the backend (off / local / cloud)
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
            }}
          />
          음소거
        </label>
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
        <div className="grid gap-2 rounded-lg border border-white/10 p-3">
          <div className="text-xs font-semibold text-parch">🧠 의미 모델 (MiniLM 임베딩)</div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={embedOn} onChange={(e) => setEmbedOn(e.target.checked)} />
            사용하기 — 특성·취향을 <b>뜻</b>으로 비교해요 (처음 한 번 약 118MB 다운로드, 이후 브라우저에 저장)
          </label>
          <p className="text-[11px] text-parch-dim">상태: {embeddings.state === 'ready' ? `준비됨 (${embeddings.size}개 문장)` : embeddings.state === 'loading' ? `내려받는 중 ${Math.round(embeddings.progress * 100)}%` : embeddings.state === 'error' ? `실패 — 어휘 비교로 동작 중 (${embeddings.error.slice(0, 60)})` : embeddings.state === 'off' ? '꺼짐 — 어휘 비교로 동작 중' : '대기'}</p>
        </div>
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
          <p className="text-[11px] leading-relaxed text-parch-dim">
            브라우저 안 모델은 Qwen2.5-0.5B (처음 한 번 약 0.5GB 다운로드, GPU가 없으면 느려요). API 키는 이 브라우저에만 저장돼요. 이야기꾼이 꺼져 있거나 준비 중이어도 게임은 기본 문장으로 그대로 진행돼요.
          </p>
          <p className="text-[11px] text-parch-dim">상태: {storyteller.label()} · 다듬은 문장 {storyteller.stats.done}개</p>
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
  return (
    <Modal title="📂 불러오기" onClose={onClose}>
      {slots.length === 0 ? (
        <p className="mb-3 text-sm text-parch-dim">저장된 세계가 없어요.</p>
      ) : (
        <ul className="mb-3 grid gap-1.5">
          {slots.map((s) => (
            <li key={s.slot} className="flex items-center gap-2 rounded-md bg-white/5 p-2 text-xs">
              <div className="flex-1">
                <div className="text-sm text-parch">
                  {s.slot === 'quick' ? '빠른 저장' : s.slot === 'auto' ? '자동 저장' : s.slot} · {s.context}
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
