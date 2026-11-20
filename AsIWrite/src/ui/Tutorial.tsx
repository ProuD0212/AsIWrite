import { useEffect, useRef, useState } from 'react';
import type { Game } from '../engine/Game';
import type { Agent, Place } from '../engine/types';
import { TUTORIAL_WILL } from '../presets/tutorial';
import { sfx } from '../audio/sfx';
import { FloatingPanel } from './FloatingPanel';
import { MOD } from './shortcuts';

interface StepCtx {
  persons: number;
  camX: number;
  camY: number;
  zoom: number;
}
interface Mission {
  title: string;
  body: string;
  /** a button that helps (fills the chat bar, jumps to someone…) */
  help?: { label: string; run: (g: Game, fill: (s: string) => void) => void };
  /** runs once when the mission starts */
  start?: (g: Game) => void;
  done: (g: Game, ctx: StepCtx) => boolean;
}

const han = (g: Game): Agent | undefined => g.world.agents.find((a) => a.name === TUTORIAL_WILL);
const karaoke = (g: Game): Place | undefined => g.world.places.find((p) => p.style === 'karaoke');
const sel = (g: Game) => g.world.agent(g.selectedId ?? undefined) ?? g.world.place(g.selectedId ?? undefined);

const MISSIONS: Mission[] = [
  {
    title: '윌을 불러 보세요',
    body: '이 세계는 쓰는 대로 열려요. 위쪽 채팅창에 「고양이를 좋아하는 샐러리맨 소환」이라고 쓰고 Enter를 눌러 보세요. (왼쪽 도구 막대 👤 버튼으로도 돼요)',
    help: { label: '✎ 예시 문장 넣기', run: (_g, fill) => fill('고양이를 좋아하는 샐러리맨 소환') },
    done: (g, c) => g.world.agents.filter((a) => a.kind === 'person').length > c.persons,
  },
  {
    title: '마을을 둘러보세요',
    body: '화면을 끌거나 W·A·S·D(방향키)로 움직이고, 마우스 휠로 확대·축소해 보세요. Shift를 누른 채 휠을 돌리면 아주 천천히 확대돼요.',
    done: (g, c) => Math.hypot(g.camera.x - c.camX, g.camera.y - c.camY) > 160 || g.camera.zoom !== c.zoom,
  },
  {
    title: '윌을 클릭해 보세요',
    body: '아무 윌이나 클릭하면 오른쪽에 그 윌의 이야기가 열려요. 소개글, 무드, 지금 드는 생각, 필요가 보여요.',
    done: (g) => sel(g)?.kind === 'person',
  },
  {
    title: '특성을 확인해 보세요',
    body: '오른쪽 창의 「특성」 탭을 눌러 보세요. 특성 문장을 클릭하면 바로 고칠 수 있고, 어떤 문장이든 새로 써 넣을 수 있어요.',
    done: (g) => g.uiSeen.has('tab:traits'),
  },
  {
    title: '관계를 살펴보세요',
    body: '「관계」 탭에는 이 윌이 누구를 어떻게 생각하는지, 상대는 어떻게 생각하는지가 따로 나와요. 🕸 버튼을 누르면 마인드맵으로도 볼 수 있어요.',
    done: (g) => g.uiSeen.has('tab:relations'),
  },
  {
    title: '건물이나 동물도 눌러 보세요',
    body: '건물과 동물에게도 각자의 이야기가 있어요. 건물을 누르면 누가 일하고, 누가 자주 오고, 무슨 일이 있었는지 볼 수 있어요.',
    done: (g) => {
      const s = sel(g);
      return !!s && (s.kind === 'place' || s.kind === 'animal');
    },
  },
  {
    title: `${TUTORIAL_WILL}의 마음을 들여다보세요`,
    body: `${TUTORIAL_WILL}을(를) 찾아 클릭하고 「상태」 탭의 「필요」를 보세요. 막대가 빨갛다면 부족한 거예요. 그 아래 🙏 바람에 무엇이 필요한지 적혀 있어요.`,
    help: { label: `🎥 ${TUTORIAL_WILL}에게 가기`, run: (g) => han(g) && g.focus(han(g)!.id) },
    done: (g) => g.selectedId === han(g)?.id,
  },
  {
    title: '바람을 이루어 주세요',
    body: `${TUTORIAL_WILL}은(는) 노래를 정말 좋아하는데, 이 동네엔 노래방이 없어요. 채팅창에 「노래방 지어 줘」라고 쓰거나, 왼쪽 🏠 버튼으로 지어 주세요. (📍 지도에서 위치 고르기를 누르면 지을 자리가 반투명하게 보여요)`,
    help: { label: '✎ 「노래방 지어 줘」 넣기', run: (_g, fill) => fill('노래방 지어 줘') },
    done: (g) => !!karaoke(g),
  },
  {
    title: '기뻐하는 모습을 지켜보세요',
    body: `${TUTORIAL_WILL}이(가) 새 노래방을 발견하고 찾아갈 거예요. 오른쪽 아래에서 속도를 ▸▸로 올려도 좋아요. 아래 📜 이야기에 속마음이 기록돼요.`,
    start: (g) => {
      const h = han(g), k = karaoke(g);
      if (!h || !k) return;
      g.world.visitNow(h, k);
      g.focus(h.id);
    },
    done: (g) => {
      const h = han(g), k = karaoke(g);
      return !!h && !!k && (g.world.hasThought(h, `place:${k.id}`) || (h.ai.targetPlaceId === k.id && h.ai.mode === 'visit'));
    },
  },
  {
    title: '이제 마음대로 써 보세요',
    body: `마지막으로 기억해 두면 좋은 것: 윌·건물을 **우클릭**하면 옮기기·이름 바꾸기·만나게 하기 메뉴가 나오고, 실수하면 ${MOD}+Z로 되돌릴 수 있어요. X를 누르면 길을 깔고 지도를 넓힐 수 있고, ?를 누르면 단축키 표가 열려요. 채팅창을 누르면 지금 상황에 맞는 추천 문장이 나와요.`,
    done: () => false,
  },
];

/** Small missions in a movable window; each checks itself off when the player does it. */
export function Tutorial({ game, onExample, onDone }: { game: Game; onExample: (s: string) => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [cleared, setCleared] = useState(false);
  const ctx = useRef<StepCtx>({ persons: 0, camX: 0, camY: 0, zoom: 1 });
  const m = MISSIONS[step];

  // snapshot the world when a mission starts
  useEffect(() => {
    ctx.current = { persons: game.world.agents.filter((a) => a.kind === 'person').length, camX: game.camera.x, camY: game.camera.y, zoom: game.camera.zoom };
    if (step === 3) game.uiSeen.delete('tab:traits');
    if (step === 4) game.uiSeen.delete('tab:relations');
    m.start?.(game);
    setCleared(false);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // check the mission on every HUD tick
  useEffect(() => {
    if (cleared || !m.done(game, ctx.current)) return;
    setCleared(true);
    sfx.care();
    const t = setTimeout(() => setStep((s) => Math.min(MISSIONS.length - 1, s + 1)), 1300);
    return () => clearTimeout(t);
  });

  const last = step === MISSIONS.length - 1;
  return (
    <FloatingPanel id="tutorial" title={`📖 튜토리얼 ${step + 1}/${MISSIONS.length}`} defaultRect={() => ({ x: 68, y: 64, w: 360, h: 250 })} minW={280} minH={180}>
      <div className="absolute inset-0 flex flex-col gap-2 overflow-y-auto p-3 text-xs">
        <div className="flex gap-1">
          {MISSIONS.map((_, i) => (
            <span key={i} className={`h-1.5 flex-1 rounded-full ${i < step || (i === step && cleared) ? 'bg-emerald-400/80' : i === step ? 'bg-glow/70' : 'bg-white/10'}`} />
          ))}
        </div>
        <div className="font-serif text-[14px] text-parch">
          {cleared && !last ? '✅ ' : '🎯 '}
          {m.title}
        </div>
        <p className="leading-relaxed text-parch/85" dangerouslySetInnerHTML={{ __html: m.body.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/「(.+?)」/g, '<b class="text-glow">「$1」</b>') }} />
        {cleared && !last && <div className="text-emerald-300">잘했어요! 다음 미션으로 넘어가요…</div>}
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {m.help && !cleared && (
            <button className="rounded-md border border-glow/50 bg-glow/15 px-2 py-1 text-parch hover:bg-glow/25" onClick={() => m.help!.run(game, onExample)}>
              {m.help.label}
            </button>
          )}
          {last ? (
            <button className="rounded-md bg-glow/90 px-3 py-1 font-semibold text-ink hover:bg-glow" onClick={onDone}>
              튜토리얼 마치기 — 이 마을에서 계속
            </button>
          ) : (
            <button className="ml-auto text-parch-dim hover:text-parch" onClick={() => setStep((s) => s + 1)} title="이 미션 건너뛰기">
              건너뛰기 ▶
            </button>
          )}
          {!last && (
            <button className="text-parch-dim/70 hover:text-parch" onClick={onDone} title="튜토리얼을 끝내고 자유롭게">
              그만하기
            </button>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}
