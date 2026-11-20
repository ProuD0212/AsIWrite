import { useCallback, useEffect, useRef, useState } from 'react';
import { sfx } from './audio/sfx';
import { INTENT_LABEL, interpret } from './commands/interpret';
import { josa } from './engine/traits';
import { autoCalibrate } from './ai/calibrate';
import type { CommandResult } from './commands/schema';
import { suggest } from './commands/suggest';
import { COMMAND_EXAMPLES } from './commands/ruleParser';
import { classifyTitle, START_TEMPLATE } from './commands/titleIntent';
import { Game } from './engine/Game';
import { listSlots, serializeWorld, writeSlot } from './engine/save';
import { TILE } from './engine/TileMap';
import { givenName, World } from './engine/World';
import { embeddings } from './ai/embeddings';
import { storyteller } from './ai/storyteller';
import { groupNamePrompt, linePrompt, monologuePrompt, mutationPrompt, profilePrompt, replyPrompt } from './ai/prompts';

// the simulation compares meanings through the shared embedding service (ko-sroberta) (lexical until it is ready)
World.embeddingSource = embeddings;
autoCalibrate(); // measure the model on our anchor sentences once it is ready

// Layer-2 generative rewriting: the world asks, the storyteller answers when it can
World.storyCapacity = () => storyteller.capacity();
World.storyHook = (r) => {
  if (r.kind === 'profile') {
    storyteller.enqueue({
      key: `profile:${r.speaker.id}`, kind: 'bio', messages: profilePrompt(r.draft, r.topic ?? ''), maxTokens: 220, ttl: 600000, priority: 3, onDone: r.apply,
    });
    return;
  }
  if (r.kind === 'mutation') {
    storyteller.enqueue({
      key: `mut:${r.speaker.id}:${r.draft}`, kind: 'rumor', messages: mutationPrompt(r.speaker, r.draft, r.topic ?? ''), maxTokens: 40, ttl: 120000, priority: r.important ? 3 : 1, onDone: r.apply,
    });
    return;
  }
  if (r.kind === 'groupName') {
    const f = r.world.factions.find((x) => x.name === r.draft);
    const members = (f?.members ?? []).map((id) => r.world.agent(id)).filter((a): a is NonNullable<typeof a> => !!a);
    storyteller.enqueue({
      key: `name:${r.draft}`, kind: 'rumor', messages: groupNamePrompt(r.world, members, r.topic ?? '', r.draft), maxTokens: 24, ttl: 120000, priority: 3, onDone: r.apply,
    });
    return;
  }
  if (r.kind === 'reply') {
    const ok = storyteller.enqueue({
      key: `reply:${r.speaker.id}:${r.topic}`, kind: 'monologue', messages: replyPrompt(r.world, r.speaker, r.topic ?? '', r.draft, r.history), maxTokens: 160, ttl: 25000, priority: 6,
      draft: r.draft, register: 'polite', onDone: r.apply, onFail: r.fail,
    });
    if (!ok) r.fail?.();
    return;
  }
  // speech level is decided by the game (마음 60+ → 반말), not left to the model's arithmetic
  const register = r.listener && !r.draft.startsWith('(') ? (r.world.speaksCasually(r.speaker, r.listener) ? 'casual' : 'polite') : undefined;
  const accepted = storyteller.enqueue({
    key: `${r.kind}:${r.speaker.id}:${r.draft}`,
    kind: r.kind,
    messages: r.kind === 'line' ? linePrompt(r.world, r.speaker, r.listener, r.draft, r.topic, register, r.history) : monologuePrompt(r.world, r.speaker, r.listener, r.draft, register),
    maxTokens: r.kind === 'line' ? 60 : 220,
    // the story log keeps the line, so a rewrite that lands a little late is still worth it
    ttl: r.kind === 'line' ? 30000 : 90000,
    priority: (r.important ? 2 : 0) + (r.kind === 'monologue' ? 1 : 0),
    draft: r.draft,
    register,
    names: r.listener ? [r.listener.name, givenName(r.listener.name)] : [],
    onDone: r.apply,
    onFail: r.fail,
  });
  if (!accepted) r.fail?.();
};
import { CommandBar, type CommandBarHandle } from './ui/CommandBar';
import { GameHUD } from './ui/GameHUD';
import { LoadModal, SettingsModal } from './ui/Modals';
import { shouldHoldTime } from './ui/modalState';
import { music } from './audio/music';
import { createTutorialWorld } from './presets/tutorial';
import { PixelScene, PixelSky } from './ui/TitleArt';
import { StoryAskModal, storyAsked } from './ui/StoryAskModal';
import type { ToolbarModal } from './ui/Toolbar';

type Stage = 'title' | 'blackout' | 'dock' | 'reveal' | 'game' | 'farewell';
interface Toast {
  id: number;
  ok: boolean;
  text: string;
}

const VISITED_KEY = 'asiwrite.visited';
const readVisited = () => {
  try {
    return localStorage.getItem(VISITED_KEY) === '1';
  } catch {
    return false;
  }
};
const markVisited = () => {
  try {
    localStorage.setItem(VISITED_KEY, '1');
  } catch {
    /* storage unavailable */
  }
};

/** Title cylinder: 튜토리얼 · 시작 · (불러오기) · 설정 · 종료, default chamber depends on history. */
function titleMenu(): { items: string[]; index: number } {
  const hasSave = listSlots().length > 0;
  const items = ['튜토리얼', START_TEMPLATE, ...(hasSave ? ['불러오기'] : []), '설정', '종료'];
  const pickFirst = !readVisited() ? '튜토리얼' : hasSave ? '불러오기' : START_TEMPLATE;
  return { items, index: items.indexOf(pickFirst) };
}

export default function App() {
  const [stage, setStage] = useState<Stage>('title');
  const [game, setGame] = useState<Game | null>(null);
  const [titleModal, setTitleModal] = useState<'settings' | 'load' | null>(null);
  const [gameModal, setGameModal] = useState<ToolbarModal | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(titleMenu);
  const [serverGone, setServerGone] = useState(false);
  const [tutorial, setTutorial] = useState(false);
  // the chat bar's example sentence rotates: something that fits the town (or the selected Will) right now
  const [hint, setHint] = useState('고양이를 좋아하는 샐러리맨 소환');
  const gameRef = useRef<Game | null>(null);
  gameRef.current = game;
  const [vh, setVh] = useState(window.innerHeight);
  const bar = useRef<CommandBarHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toastId = useRef(0);

  // focus the title input so Enter starts right away (also when coming back to the title)
  useEffect(() => {
    if (stage === 'title') setTimeout(() => bar.current?.focus(), 80);
  }, [stage]);

  // the launcher's terminal was closed → the dev server is gone; say so instead of looking frozen
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const gone = () => {
      setServerGone(true);
      if (gameRef.current) writeSlot('auto', serializeWorld(gameRef.current.world));
    };
    const back = () => setServerGone(false);
    hot.on('vite:ws:disconnect', gone);
    hot.on('vite:ws:connect', back);
    return () => {
      hot.off('vite:ws:disconnect', gone);
      hot.off('vite:ws:connect', back);
    };
  }, []);

  // the storyteller model is big (~2–3 GB): ask once on first entry (strongly recommended), then remember
  const [askStory, setAskStory] = useState(false);
  useEffect(() => {
    if (stage !== 'game') return;
    if (!storyAsked()) setAskStory(true);
    else storyteller.start();
  }, [stage]);

  // start downloading the meaning model on the title screen (cached by the browser afterwards)
  useEffect(() => embeddings.start(), []);

  useEffect(() => {
    const r = () => setVh(window.innerHeight);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  const pushToast = useCallback((r: CommandResult) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, ok: r.ok, text: r.message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), r.ok ? 3200 : 5000);
  }, []);

  // attach engine to canvas once the game exists & canvas is mounted
  useEffect(() => {
    if (!game || !canvasRef.current) return;
    game.attach(canvasRef.current);
    game.toast = pushToast;
    game.holdTime = shouldHoldTime;
    game.onUIRequest = (r) => {
      if (r === 'quit') quitToTitle();
      else if (r === 'settings') setGameModal({ type: 'settings' });
      else if (r === 'load') setGameModal({ type: 'load' });
      else if (r === 'help') setGameModal({ type: 'help' });
    };
    return () => game.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  useEffect(() => {
    if (!game || stage !== 'game') return;
    const roll = () => {
      const pool = [...suggest(game.world, game.selectedId).items.map((s) => s.text), ...COMMAND_EXAMPLES];
      setHint((cur) => {
        const next = pool.filter((t) => t !== cur);
        return next.length ? next[Math.floor(Math.random() * next.length)] : cur;
      });
    };
    roll();
    const t = setInterval(roll, 9000);
    return () => clearInterval(t);
  }, [game, stage]);

  // background music follows the world (time of day, weather, how happy the town is)
  useEffect(() => {
    if (!game || stage !== 'game') return;
    music.start();
    const feed = () => {
      const w = game.world;
      const people = w.agents.filter((a) => a.kind === 'person');
      music.update({ context: w.meta.context, hour: (w.meta.minutes % 1440) / 60, weather: w.meta.weather, happiness: people.length ? people.reduce((s, a) => s + a.mood, 0) / people.length : 60 });
    };
    feed();
    const t = setInterval(feed, 2000);
    return () => {
      clearInterval(t);
      music.stop();
    };
  }, [game, stage]);

  // autosave every 60s of real time while playing
  useEffect(() => {
    if (!game || stage !== 'game') return;
    const t = setInterval(() => writeSlot('auto', serializeWorld(game.world)), 60000);
    return () => clearInterval(t);
  }, [game, stage]);

  /** Title → blackout (500ms) → dock (600ms, spec easing) → reveal (800ms). */
  const beginTransition = (world: World) => {
    markVisited();
    sfx.genesis();
    setGame(new Game(world));
    setStage('blackout');
    setTimeout(() => {
      sfx.whoosh();
      setStage('dock');
    }, 520);
    setTimeout(() => setStage('reveal'), 520 + 650);
    setTimeout(() => {
      setStage('game');
      bar.current?.focus();
    }, 520 + 650 + 850);
  };

  const quitToTitle = () => {
    setGame((g) => {
      if (g) writeSlot('auto', serializeWorld(g.world));
      return null;
    });
    setGameModal(null);
    setTutorial(false);
    setMenu(titleMenu());
    setStage('title');
  };

  const onTitleSubmit = (text: string) => {
    const intent = classifyTitle(text);
    switch (intent.type) {
      case 'START_GAME': {
        const world = World.createWith({ context: intent.context, weather: intent.weather ?? 'clear', wills: intent.wills, places: intent.places, animals: intent.animals, empty: intent.empty });
        // initial entities from the prompt, e.g. "고양이 한 마리와 시작"
        const cx = (world.map.roadCols[0] + 1) * TILE;
        const cy = (world.map.roadRows[0] + 1) * TILE;
        for (const sp of intent.spawns) world.spawnRandomized(guessSpawn(sp), cx + 30 + Math.random() * 40, cy - 40);
        world.pushFeed({ kind: 'system', text: `「${world.meta.context}」 세계에 빛이 들었다.` });
        if (intent.secret) {
          world.pushFeed({ kind: 'care', text: '✨ 숨겨진 문장을 찾았다 — 이 세계의 첫날은 유난히 눈부시다.' });
          for (const a of world.agents) if (a.kind === 'person') world.addThought(a, 'genesis', '오늘따라 햇살이 유난히 눈부시다', 6, 360);
          pushToast({ ok: true, message: '✨ 숨겨진 문장을 찾았어요!' });
        }
        beginTransition(world);
        return;
      }
      case 'TUTORIAL': {
        // a small practice town with missions (see ui/Tutorial.tsx)
        setTutorial(true);
        beginTransition(createTutorialWorld());
        return;
      }
      case 'SETTINGS':
        sfx.submit();
        setTitleModal('settings');
        return;
      case 'LOAD':
        sfx.submit();
        setTitleModal('load');
        return;
      case 'QUIT':
        sfx.whoosh();
        setStage('farewell');
        return;
      default:
        bar.current?.shake();
        pushToast({ ok: false, message: '세상을 열려면 「시작」을 고르거나, 원하는 세상을 문장으로 써 보세요.' });
    }
  };

  const onGameSubmit = async (text: string) => {
    if (!game) return;
    setBusy(true);
    try {
      const it = await interpret(text, game.selectedId, game.world);
      const cmd = it.cmd;
      if (!cmd) {
        bar.current?.shake();
        if (it.suggestion) {
          // tier 3: offer the closest known sentence — Enter runs it, or edit it first
          bar.current?.setText(it.suggestion);
          pushToast({ ok: false, message: `혹시 「${it.suggestion}」 이런 뜻인가요? 맞으면 Enter, 아니면 고쳐 써 주세요.` });
        } else pushToast({ ok: false, message: '무슨 뜻인지 아직 이해하지 못했어요. 채팅창을 누르면 나오는 추천 문장을 참고해 주세요.' });
        return;
      }
      sfx.submit();
      const r = game.dispatch(cmd);
      if (it.source === 'embedding' && it.intent) r.message = `🧠 「${INTENT_LABEL[it.intent]}」${josa(INTENT_LABEL[it.intent], '으로/로').slice(INTENT_LABEL[it.intent].length)} 이해했어요 (확신 ${Math.round((it.confidence ?? 0) * 100)}%) · ${r.message}`;
      pushToast(r);
      if (!r.ok) sfx.error();
    } finally {
      setBusy(false);
    }
  };

  const inGame = stage === 'game' || stage === 'reveal';
  const docked = stage === 'dock' || stage === 'reveal' || stage === 'game';
  // title layout (pixel scene on top, title, then the input)
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const artPx = Math.max(2, Math.min(5, Math.floor(Math.min(vw * 0.82, 1000) / 200), Math.floor((vh * 0.44) / 110)));
  const sceneTop = Math.max(8, vh * 0.05);
  const titleTop = sceneTop + 110 * artPx + 4;
  const titleY = Math.min(vh - 110, titleTop + 104); // input center on title
  const dockY = 14;

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* living world underneath */}
      {game && (
        <div className="absolute inset-0">
          <canvas ref={canvasRef} className="block h-full w-full" />
        </div>
      )}
      {game && stage === 'game' && (
        <GameHUD
          game={game}
          onQuit={() => game.dispatch({ type: 'SYSTEM', action: 'QUIT' })}
          onLoadWorld={(w) => game.setWorld(w)}
          modal={gameModal}
          setModal={setGameModal}
          onExample={(s) => bar.current?.setText(s)}
          onFocusChat={() => bar.current?.focus()}
          tutorial={tutorial}
          onTutorialEnd={() => {
            setTutorial(false);
            if (game) game.world.questsPaused = false;
            pushToast({ ok: true, message: '📖 튜토리얼 끝! 이제 이 마을은 당신의 것이에요. 쓰는 대로 열어 보세요.' });
          }}
        />
      )}

      {/* title layer — bright, cute, pixel art */}
      {!inGame && stage !== 'farewell' && (
        <div className={`absolute inset-0 z-30 overflow-hidden transition-opacity duration-500 ${stage === 'title' ? 'opacity-100' : 'opacity-0'}`}>
          <PixelSky />
          <div className="absolute left-1/2 -translate-x-1/2" style={{ top: sceneTop }}>
            <PixelScene px={artPx} />
          </div>
          <h1 className="cute-title absolute left-1/2 w-full -translate-x-1/2 text-center tracking-[0.06em]" style={{ top: titleTop, fontSize: artPx >= 4 ? 55 : 44 }}>
            {'내가 쓰는 대로'.split('').map((ch, i) => (
              <span key={i} className="title-letter" style={{ animationDelay: `${300 + i * 70}ms, ${1300 + i * 120}ms` }}>
                {ch === ' ' ? '\u00a0' : ch}
              </span>
            ))}
          </h1>
          <div className="pointer-events-none absolute left-1/2 w-full -translate-x-1/2 select-none text-center text-[12px] text-[#8a8dbd]" style={{ top: titleY + 66 }}>
            ▲▼ 돌리거나 위아래로 끌어서 고르기 · Enter · 원하는 세상을 문장으로 써도 돼요
          </div>
        </div>
      )}

      {/* blackout veil (everything except the input) */}
      <div
        className="pointer-events-none absolute inset-0 z-40 bg-black"
        style={{ opacity: stage === 'blackout' || stage === 'dock' ? 1 : 0, transition: `opacity ${stage === 'reveal' ? 850 : 500}ms ease` }}
      />

      {/* the one input: title center → docked top HUD */}
      {stage !== 'farewell' && (
        <div
          className="ease-dock absolute left-1/2 top-0 z-50 w-[min(600px,calc(100vw-32px))]"
          style={{
            transform: `translate(-50%, ${docked ? dockY : titleY - 26}px) scale(${docked ? 0.94 : 1})`,
            transformOrigin: 'top center',
            transition: 'transform 600ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <CommandBar
            ref={bar}
            docked={docked}
            busy={busy}
            placeholder={docked ? `무엇이든 써 보세요 — 예: ${hint}` : '여기에 쓰는 대로 세상이 열립니다'}
            onSubmit={(t) => (stage === 'game' ? onGameSubmit(t) : stage === 'title' ? onTitleSubmit(t) : undefined)}
            getSuggestions={stage === 'game' && game ? () => suggest(game.world, game.selectedId) : undefined}
            featured={stage === 'game' ? hint : undefined}
            menu={stage === 'title' ? { items: menu.items, index: menu.index, onIndex: (i) => setMenu((m) => ({ ...m, index: i })) } : undefined}
          />
          {/* toasts under the bar */}
          <div className="pointer-events-none mt-2 flex flex-col items-center gap-1.5">
            {toasts.map((t) => (
              <div key={t.id} className={`pointer-events-auto rounded-lg px-3 py-1.5 text-sm shadow-lg ${t.ok ? 'bg-ink-2/95 text-parch' : 'bg-rose-950/90 text-rose-100'}`}>
                {t.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {stage === 'farewell' && (
        <button className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black text-parch-dim" onClick={() => setStage('title')}>
          <span className="font-serif text-2xl text-parch/80">세상이 잠들었습니다.</span>
          <span className="text-xs">탭을 닫아도 좋아요 · 클릭하면 처음으로</span>
        </button>
      )}

      {askStory && stage === 'game' && (
        <StoryAskModal
          onDecide={(on) => {
            setAskStory(false);
            storyteller.start(); // starts the local model, or stays off
            pushToast({ ok: true, message: on ? '✨ 이야기꾼을 부르는 중이에요. 준비되면 윌들의 말이 더 자연스러워져요.' : '기본 문장으로 시작해요. 오른쪽 위 「✨ 이야기꾼 켜기」로 언제든 켤 수 있어요.' });
          }}
        />
      )}
      {serverGone && (
        <div className="fixed inset-x-0 top-0 z-[90] flex justify-center p-3">
          <div className="panel max-w-xl px-4 py-3 text-sm text-parch shadow-2xl">
            <b className="text-glow">⚠ 게임 서버가 꺼졌어요.</b> 실행 창(터미널)을 닫으면 서버도 함께 꺼져요. 지금 화면은 잠시 더 보이지만 곧 멈추니,{' '}
            <b>이 탭을 닫아 주세요.</b> 방금 상태는 자동 저장했어요. 다시 하려면 실행 파일을 더블클릭하세요.
          </div>
        </div>
      )}
      {titleModal === 'settings' && <SettingsModal game={null} onClose={() => setTitleModal(null)} />}
      {titleModal === 'load' && (
        <LoadModal
          game={null}
          onClose={() => setTitleModal(null)}
          onLoad={(w) => {
            setTitleModal(null);
            beginTransition(w);
          }}
        />
      )}
    </div>
  );
}

/** "고양이 한 마리" → spawn spec */
function guessSpawn(s: string): { kind: 'person' | 'animal'; category?: string; appearance?: string } {
  const body = s.replace(/\s*(한|두|세)\s*(마리|명)/, '').trim();
  const sp = body.match(/(고양이|강아지|개|새)/)?.[0];
  if (sp) return { kind: 'animal', category: sp === '고양이' ? '길고양이' : sp, appearance: body };
  return { kind: 'person', appearance: body || undefined };
}
