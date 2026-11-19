import { useCallback, useEffect, useRef, useState } from 'react';
import { sfx } from './audio/sfx';
import { interpret } from './commands/interpret';
import type { CommandResult } from './commands/schema';
import { suggest } from './commands/suggest';
import { classifyTitle } from './commands/titleIntent';
import { Game } from './engine/Game';
import { listSlots, serializeWorld, writeSlot } from './engine/save';
import { TILE } from './engine/TileMap';
import { World } from './engine/World';
import { CommandBar, type CommandBarHandle } from './ui/CommandBar';
import { GameHUD } from './ui/GameHUD';
import { LoadModal, SettingsModal } from './ui/Modals';
import { PixelScene, PixelSky } from './ui/TitleArt';
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
  const items = ['튜토리얼', '시작', ...(hasSave ? ['불러오기'] : []), '설정', '종료'];
  const pickFirst = !readVisited() ? '튜토리얼' : hasSave ? '불러오기' : '시작';
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
  const [vh, setVh] = useState(window.innerHeight);
  const bar = useRef<CommandBarHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toastId = useRef(0);

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
    game.onUIRequest = (r) => {
      if (r === 'quit') quitToTitle();
      else if (r === 'settings') setGameModal({ type: 'settings' });
      else if (r === 'load') setGameModal({ type: 'load' });
      else if (r === 'help') setGameModal({ type: 'help' });
    };
    return () => game.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

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
    setMenu(titleMenu());
    setStage('title');
  };

  const onTitleSubmit = (text: string) => {
    const intent = classifyTitle(text);
    switch (intent.type) {
      case 'START_GAME': {
        const world = World.createDefault(intent.context, intent.weather ?? 'clear');
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
        sfx.submit();
        markVisited();
        pushToast({ ok: true, message: '📖 튜토리얼은 곧 만나요! 지금은 「시작」으로 바로 세상을 열어 보세요.' });
        const items = titleMenu().items;
        setMenu({ items, index: items.indexOf('시작') });
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
      const { cmd } = await interpret(text, game.selectedId);
      if (!cmd) {
        bar.current?.shake();
        pushToast({ ok: false, message: '무슨 뜻인지 아직 이해하지 못했어요. ❓ 도움말의 예시를 참고해 주세요.' });
        return;
      }
      sfx.submit();
      const r = game.dispatch(cmd);
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
            placeholder={docked ? '무엇이든 써 보세요 — 예: 고양이를 좋아하는 샐러리맨 소환' : '여기에 쓰는 대로 세상이 열립니다'}
            onSubmit={(t) => (stage === 'game' ? onGameSubmit(t) : stage === 'title' ? onTitleSubmit(t) : undefined)}
            getSuggestions={stage === 'game' && game ? () => suggest(game.world, game.selectedId) : undefined}
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
