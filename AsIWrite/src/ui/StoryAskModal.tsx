import { useEffect, useState } from 'react';
import { Storyteller } from '../ai/storyteller';
import { DEFAULT_MODEL, LOCAL_MODELS } from '../ai/models';
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

/**
 * First-entry prompt for the AI storyteller. Strongly recommended (it is what
 * makes the Wills' words feel alive), but it is a ~2–3 GB one-time download,
 * so the player decides.
 */
export function StoryAskModal({ onDecide }: { onDecide: (on: boolean) => void }) {
  const [gpu, setGpu] = useState<boolean | null>(null);
  useEffect(() => {
    const g = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!g) return setGpu(false);
    g.requestAdapter().then((a) => setGpu(!!a)).catch(() => setGpu(false));
  }, []);

  const decide = (on: boolean) => {
    markAsked();
    Storyteller.setBackendSetting(on);
    onDecide(on);
  };

  return (
    <Modal title="✨ AI 이야기꾼을 켤까요?" onClose={() => decide(false)}>
      <div className="grid gap-3 text-sm">
        <p className="leading-relaxed text-parch/90">
          이야기꾼은 윌들의 말을 <b className="text-glow">성격 · 기분 · 서로에 대한 마음</b>에 맞게 자연스럽게 다시 써 줘요. 친한 사이엔 반말로, 서먹한 사이엔 존댓말로 — 윌들이 훨씬 살아 있는 것처럼 느껴져요.
        </p>
        <div className="grid gap-1.5 border border-white/10 bg-black/25 p-3 text-xs">
          <div className="text-[10px] text-parch-dim">예시 (이해를 돕기 위한 샘플)</div>
          <div className="text-parch-dim">
            기본 문장: <span className="text-parch/80">“하늘 씨, 이따 노래방 갈래요?”</span>
          </div>
          <div className="text-parch-dim">
            이야기꾼: <span className="text-glow">“하늘아, 이따 노래방 가자! 오늘 고음 제대로 뽑을 거야.”</span> ✨
          </div>
        </div>
        <ul className="grid gap-1 text-xs text-parch/80">
          <li>
            · 처음 한 번 언어 모델(<b>{LOCAL_MODELS[DEFAULT_MODEL].label}</b>, 약 2~3GB)을 내려받아요. 이후엔 브라우저에 저장되고, 키나 회원가입은 필요 없어요. 이 컴퓨터에서 안 돌아가면 더 작은 모델로 자동으로 바꿔요.
          </li>
          <li>
            ·{' '}
            {gpu === null
              ? 'GPU 가속을 확인하는 중…'
              : gpu
                ? '이 컴퓨터는 GPU 가속이 가능해서 빠르게 동작해요. 👍'
                : 'GPU 가속이 없어 조금 느릴 수 있지만, 게임은 멈추지 않고 다듬어진 문장이 조금 늦게 나타나요.'}
          </li>
          <li>· 내려받는 동안에도 게임은 바로 할 수 있고, 설정에서 언제든 끄거나 Gemini/Groq 키로 바꿀 수 있어요.</li>
        </ul>
        <Btn variant="primary" className="!py-2.5 text-base" onClick={() => decide(true)}>
          ✨ 이야기꾼 켜기 (권장)
        </Btn>
        <button className="justify-self-center text-xs text-parch-dim underline-offset-2 hover:text-parch hover:underline" onClick={() => decide(false)}>
          나중에 할게요 (기본 문장으로 시작)
        </button>
      </div>
    </Modal>
  );
}
