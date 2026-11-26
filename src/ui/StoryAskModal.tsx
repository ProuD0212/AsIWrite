import { useEffect, useState } from 'react';
import { Storyteller } from '../ai/storyteller';
import { DEFAULT_MODEL, LOCAL_MODELS, MODEL_KEY_STORAGE, type LocalModelKey } from '../ai/models';
import { listModels } from '../ai/cloud';
import { Btn, Modal } from './Modal';

export const STORY_ASKED_KEY = 'asiwrite.storyAsked';

export function storyAsked(): boolean {
  try {
    return localStorage.getItem(STORY_ASKED_KEY) === '1';
  } catch {
    return true; // no storage → don't nag every time
  }
}
function markAsked() {
  try {
    localStorage.setItem(STORY_ASKED_KEY, '1');
  } catch {
    /* ignore */
  }
}
function put(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** where to get a free key for each provider (opened in a new tab) */
const KEY_PAGES = {
  gemini: { url: 'https://aistudio.google.com/apikey', label: 'Google AI Studio' },
  groq: { url: 'https://console.groq.com/keys', label: 'Groq Console' },
} as const;
type Provider = keyof typeof KEY_PAGES;

/**
 * First entry: how should the storyteller run?
 *  - API (Gemini / Groq, the player's own key): light, natural, nothing to download
 *  - built-in model (Gemma 4 / Qwen3.5 in the browser): no key, a one-time download, needs a GPU
 *  - later: plain template lines
 */
export function StoryAskModal({ onDecide }: { onDecide: (on: boolean) => void }) {
  const [gpu, setGpu] = useState<boolean | null>(null);
  const [pick, setPick] = useState<'api' | 'local'>('api');
  const [provider, setProvider] = useState<Provider>('gemini');
  const [key, setKey] = useState('');
  const [model, setModel] = useState<LocalModelKey>(DEFAULT_MODEL);
  const [test, setTest] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const g = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!g) return setGpu(false);
    g.requestAdapter().then((a) => setGpu(!!a)).catch(() => setGpu(false));
  }, []);

  const later = () => {
    markAsked();
    Storyteller.setBackendSetting(false);
    onDecide(false);
  };
  const startLocal = () => {
    markAsked();
    put('asiwrite.apiProvider', 'none');
    put(MODEL_KEY_STORAGE, model);
    Storyteller.setBackendSetting(true);
    onDecide(true);
  };
  const startApi = async () => {
    const k = key.trim();
    if (!k) return setTest('API 키를 붙여 넣어 주세요.');
    setBusy(true);
    setTest('키를 확인하는 중…');
    try {
      const list = await listModels(provider, k);
      if (!list.length) throw new Error('이 키로 쓸 수 있는 모델이 없어요');
      put('asiwrite.apiProvider', provider);
      put('asiwrite.apiKey', k);
      markAsked();
      Storyteller.setBackendSetting(true);
      onDecide(true); // no model download: the storyteller talks to the API
    } catch (e) {
      setTest(`❌ 연결 실패 — ${String((e as Error)?.message ?? e).slice(0, 80)}. 키를 다시 확인해 주세요.`);
    } finally {
      setBusy(false);
    }
  };

  const card = (id: 'api' | 'local', title: string, sub: string) => (
    <button onClick={() => setPick(id)} className={`grid gap-0.5 border p-2.5 text-left ${pick === id ? 'border-glow/70 bg-glow/10' : 'border-white/10 hover:bg-white/5'}`}>
      <b className="text-sm text-parch">{title}</b>
      <span className="text-[11px] text-parch-dim">{sub}</span>
    </button>
  );

  return (
    <Modal title="✨ AI 이야기꾼을 어떻게 쓸까요?" onClose={later}>
      <div className="grid gap-3 text-sm">
        <p className="leading-relaxed text-parch/90">
          이야기꾼은 윌들의 말을 <b className="text-glow">성격 · 기분 · 서로에 대한 마음</b>에 맞게 자연스럽게 다시 써 줘요. 친한 사이엔 반말로, 서먹한 사이엔 존댓말로.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {card('api', '🌐 API 사용 (권장)', '가볍고 문장이 가장 자연스러워요. 모델을 내려받지 않아요. 무료 키로 시작할 수 있어요.')}
          {card('local', '💻 내장 모델', `키 없이 이 컴퓨터에서 돌려요. 처음 한 번 약 2~3GB 다운로드, GPU 필요.`)}
        </div>

        {pick === 'api' ? (
          <div className="grid gap-2 border border-white/10 bg-black/25 p-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-parch-dim">서비스</span>
              {(['gemini', 'groq'] as Provider[]).map((p) => (
                <button key={p} onClick={() => setProvider(p)} className={`rounded-md border px-2 py-0.5 ${provider === p ? 'border-glow/70 bg-glow/20 text-parch' : 'border-white/10 text-parch-dim hover:bg-white/10'}`}>
                  {p === 'gemini' ? 'Google Gemini' : 'Groq'}
                </button>
              ))}
            </div>
            <ol className="grid list-decimal gap-1 pl-4 text-parch/85">
              <li>
                <button className="text-glow underline-offset-2 hover:underline" onClick={() => window.open(KEY_PAGES[provider].url, '_blank', 'noopener')}>
                  🔑 {KEY_PAGES[provider].label}에서 무료 API 키 발급받기 ↗
                </button>{' '}
                <span className="text-parch-dim">(로그인 후 「API 키 만들기」)</span>
              </li>
              <li>받은 키를 아래에 붙여 넣고 시작하세요.</li>
            </ol>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={provider === 'gemini' ? 'AIza… 로 시작하는 키' : 'gsk_… 로 시작하는 키'} className="rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-parch outline-none focus:border-glow/60" />
            <p className="text-[11px] text-parch-dim">키는 이 브라우저에만 저장되고, 문장을 다듬을 때 {provider === 'gemini' ? 'Google' : 'Groq'}에만 보내져요. 무료 등급은 분당 요청 수 제한이 있어서 대사를 여러 줄씩 묶어 보내요.</p>
            {test && <p className="text-[11px] text-amber-200">{test}</p>}
            <Btn variant="primary" className="!py-2" disabled={busy} onClick={() => void startApi()}>
              {busy ? '확인 중…' : '🌐 이 키로 시작하기'}
            </Btn>
          </div>
        ) : (
          <div className="grid gap-2 border border-white/10 bg-black/25 p-3 text-xs">
            {Object.values(LOCAL_MODELS).map((m) => (
              <label key={m.key} className="flex items-start gap-2">
                <input type="radio" name="first-model" className="mt-0.5" checked={model === m.key} onChange={() => setModel(m.key)} />
                <span>
                  <b className="text-parch">{m.label}</b> <span className="text-parch-dim">· {m.size}</span>
                  <br />
                  <span className="text-parch-dim">{m.note}</span>
                </span>
              </label>
            ))}
            <p className="text-[11px] text-parch-dim">
              {gpu === null ? 'GPU 가속을 확인하는 중…' : gpu ? '이 컴퓨터는 GPU 가속이 가능해요. 👍 내려받는 동안에도 게임은 바로 할 수 있어요.' : '⚠ 이 브라우저는 GPU(WebGPU)를 쓸 수 없어서 내장 모델이 돌아가지 않아요. API 사용을 권해요.'}
            </p>
            <Btn variant="primary" className="!py-2" disabled={gpu === false} onClick={startLocal}>
              💻 내장 모델로 시작하기
            </Btn>
          </div>
        )}
        <button className="justify-self-center text-xs text-parch-dim underline-offset-2 hover:text-parch hover:underline" onClick={later}>
          나중에 할게요 (기본 문장으로 시작 · 설정에서 언제든 바꿀 수 있어요)
        </button>
      </div>
    </Modal>
  );
}
