import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { sfx } from '../audio/sfx';
import type { Suggestion } from '../commands/suggest';

export interface CommandBarHandle {
  focus: () => void;
  setText: (s: string) => void;
  shake: () => void;
}

interface Props {
  docked: boolean;
  busy?: boolean;
  placeholder: string;
  onSubmit: (text: string) => void;
  /** context suggestions (world or selected object); omitted on the title screen */
  getSuggestions?: () => { title: string; items: Suggestion[] };
  /** the example sentence currently shown as placeholder — offered first in the suggestion list */
  featured?: string;
  /** title screen: a revolver-cylinder menu (↑/↓ or drag vertically to rotate) */
  menu?: { items: string[]; index: number; onIndex: (i: number) => void };
}

/**
 * The single glowing input. Lives on the title screen, survives the
 * blackout, then docks at the top as the omnipotent command HUD.
 */
export const CommandBar = forwardRef<CommandBarHandle, Props>(function CommandBar({ docked, busy, placeholder, onSubmit, getSuggestions, menu, featured }, ref) {
  const [text, setText] = useState(menu ? menu.items[menu.index] ?? '' : '');
  const rowRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; acc: number; moved: boolean } | null>(null);
  const menuOn = !!menu && !docked;
  const itemsKey = menu?.items.join('|');

  // keep the input in sync with the cylinder position
  useEffect(() => {
    if (menu && !docked) setText(menu.items[menu.index] ?? '');
  }, [menu?.index, itemsKey, docked]); // eslint-disable-line react-hooks/exhaustive-deps
  // docking: let the player's opening sentence travel up and stay until the world is revealed
  // (dock 650ms + reveal 850ms in App.beginTransition), then clear the box for commands
  useEffect(() => {
    if (!docked) return;
    const t = setTimeout(() => setText(''), 1500);
    return () => clearTimeout(t);
  }, [docked]);

  /** rotate the cylinder by one chamber (only while showing a menu item or empty) */
  const rotate = (dir: 1 | -1) => {
    if (!menu) return false;
    const onItem = text === '' || menu.items.includes(text);
    if (!onItem) return false;
    const n = menu.items.length;
    const cur = Math.max(0, menu.items.indexOf(text));
    menu.onIndex((cur + dir + n) % n);
    // replay the roll without remounting the input (keeps focus)
    rowRef.current?.animate(
      [
        { transform: `translateY(${dir > 0 ? 70 : -70}%) rotateX(${dir > 0 ? -75 : 75}deg)`, opacity: 0.15 },
        { transform: 'translateY(0) rotateX(0)', opacity: 1 },
      ],
      { duration: 190, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' },
    );
    sfx.tick();
    return true;
  };
  const [shaking, setShaking] = useState(false);
  const [open, setOpen] = useState(false);
  const [sugg, setSugg] = useState<{ title: string; items: Suggestion[] } | null>(null);
  const [hi, setHi] = useState(-1);
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => {
    if (!getSuggestions) return;
    const s = getSuggestions();
    // the example the bar was just showing (placeholder) comes first, so clicking it is possible
    if (featured && !s.items.some((it) => it.text === featured)) s.items = [{ text: featured, icon: '💡', why: '채팅창에 보이던 예시' }, ...s.items].slice(0, 6);
    setSugg(s);
    setHi(-1);
  };

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    setText: (s: string) => {
      setText(s);
      input.current?.focus();
    },
    shake: () => {
      setShaking(true);
      sfx.error();
      setTimeout(() => setShaking(false), 380);
    },
  }));

  const run = (t: string) => {
    const v = t.trim();
    if (!v || busy) return;
    setHistory((h) => [v, ...h.filter((x) => x !== v)].slice(0, 30));
    setHIdx(-1);
    // title cylinder: keep what was typed — it rides up with the docking animation (and stays
    // editable if it wasn't understood); resetting to the chamber here flashed the default sentence
    if (!menuOn) setText('');
    onSubmit(v);
    // fresh ideas for the next command
    setTimeout(refresh, 250);
  };

  const showSugg = open && !text && !!sugg && sugg.items.length > 0;

  return (
    <div className={`relative w-full ${shaking ? 'animate-shake' : ''}`} style={menuOn ? { perspective: 520 } : undefined}>
      {menuOn && <CylinderGhost items={menu!.items} index={menu!.items.indexOf(text)} side="prev" onPick={() => rotate(-1)} />}
      <div
        ref={rowRef}
        onPointerDown={(e) => {
          if (!menuOn) return;
          drag.current = { y: e.clientY, acc: 0, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !menuOn) return;
          const dy = e.clientY - d.y;
          d.y = e.clientY;
          d.acc += dy;
          if (Math.abs(d.acc) > 4 && !d.moved) {
            d.moved = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }
          // dragging up brings the next chamber in from below, like spinning a cylinder
          while (Math.abs(d.acc) >= 26) {
            rotate(d.acc < 0 ? 1 : -1);
            d.acc += d.acc < 0 ? 26 : -26;
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) {
            e.preventDefault();
            input.current?.focus();
          }
        }}
        className={`flex items-center gap-2 px-4 transition-colors duration-500 ${menuOn ? 'cursor-ns-resize touch-none select-none' : ''} ${docked ? 'input-glow rounded-xl bg-ink-2/90 py-2' : 'input-light border-[3px] border-[#3d3f78] bg-[#fffaf0] py-3'}`}
      >
        <span className={`select-none ${docked ? 'text-glow/80' : 'text-[#ff7fae]'}`}>✎</span>
        <input
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHi(-1);
            if (Math.random() < 0.5) sfx.type();
          }}
          onFocus={(e) => {
            if (menuOn && menu!.items.includes(text)) setTimeout(() => e.target.select(), 0);
            setOpen(true);
            refresh();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            const items = sugg?.items ?? [];
            if (menuOn && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && rotate(e.key === 'ArrowDown' ? 1 : -1)) {
              e.preventDefault();
              return;
            }
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              if (!text && hi >= 0 && items[hi]) run(items[hi].text);
              else run(text);
            } else if (e.key === 'ArrowDown' && showSugg) {
              e.preventDefault();
              setHi((h) => (h + 1) % items.length);
            } else if (e.key === 'ArrowUp' && showSugg && hi >= 0) {
              e.preventDefault();
              setHi((h) => h - 1);
            } else if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = Math.min(history.length - 1, hIdx + 1);
              setHIdx(i);
              setText(history[i]);
            } else if (e.key === 'ArrowDown' && hIdx >= 0) {
              e.preventDefault();
              const i = hIdx - 1;
              setHIdx(Math.max(-1, i));
              setText(i < 0 ? '' : history[i]);
            } else if (e.key === 'Tab' && showSugg) {
              e.preventDefault();
              setText(items[Math.max(0, hi)].text);
            } else if (e.key === 'Escape') {
              input.current?.blur();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={`min-w-0 flex-1 bg-transparent outline-none ${docked ? 'text-[15px] text-parch placeholder:text-parch-dim/50' : 'text-lg text-[#3d3f78] placeholder:text-[#9a9cc8]'}`}
        />
        {busy && <span className="animate-pulse text-xs text-parch-dim">해석 중…</span>}
        {menuOn && (
          <span className="flex select-none flex-col text-[9px] leading-[9px] text-[#9a9cc8]" aria-hidden>
            <span>▲</span>
            <span>▼</span>
          </span>
        )}
        <button onClick={() => run(text)} className="rounded-md px-2 py-0.5 text-sm text-parch-dim transition hover:bg-white/10 hover:text-parch" aria-label="실행">
          ↵
        </button>
      </div>
      {menuOn && <CylinderGhost items={menu!.items} index={menu!.items.indexOf(text)} side="next" onPick={() => rotate(1)} />}
      {showSugg && (
        <div className="panel scroll-thin absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[calc(100dvh-120px)] overflow-y-auto rounded-xl p-1.5" onMouseDown={(e) => e.preventDefault()}>
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-[11px] text-parch-dim">💡 {sugg!.title}</span>
            <button className="rounded px-1.5 text-xs text-parch-dim hover:bg-white/10 hover:text-parch" title="다른 추천 보기" onClick={refresh}>
              🎲 다른 추천
            </button>
          </div>
          {sugg!.items.map((s, i) => (
            <button
              key={s.text}
              onMouseEnter={() => setHi(i)}
              onClick={() => run(s.text)}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${hi === i ? 'bg-white/12' : 'hover:bg-white/8'}`}
            >
              <span className="w-5 shrink-0 text-center">{s.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-parch">{s.text}</span>
                {s.why && <span className="block text-[11px] text-parch-dim">{s.why}</span>}
              </span>
              {hi === i && <span className="self-center text-[10px] text-parch-dim">Enter</span>}
            </button>
          ))}
          <div className="px-2 pt-1 text-[10px] text-parch-dim/70">클릭/Enter 바로 실행 · ↓ 고르기 · Tab 문장 고쳐 쓰기 · ↑ 이전 명령</div>
        </div>
      )}
    </div>
  );
});

/** The neighbouring chambers of the cylinder, tilted away above / below the input. */
function CylinderGhost({ items, index, side, onPick }: { items: string[]; index: number; side: 'prev' | 'next'; onPick: () => void }) {
  if (index < 0 || items.length < 2) return null;
  const n = items.length;
  const label = items[(index + (side === 'prev' ? -1 : 1) + n) % n];
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className="cyl-ghost absolute left-[10%] w-[80%] select-none truncate text-center text-[16px] leading-5 text-[#7b7fb6] opacity-55 hover:opacity-90"
      style={{
        [side === 'prev' ? 'bottom' : 'top']: '100%',
        transform: `rotateX(${side === 'prev' ? 38 : -38}deg)`,
        transformOrigin: side === 'prev' ? 'bottom center' : 'top center',
        margin: '3px 0',
      }}
    >
      {label}
    </button>
  );
}
