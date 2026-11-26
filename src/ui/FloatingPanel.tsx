import { useEffect, useRef, useState, type ReactNode } from 'react';

type Rect = { x: number; y: number; w: number; h: number };
type Edge = { l?: boolean; r?: boolean; t?: boolean; b?: boolean };

function load(key: string): Rect | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v && v.w > 0 && v.h > 0) return v;
  } catch {
    /* ignore */
  }
  return null;
}
function save(key: string, r: Rect) {
  try {
    localStorage.setItem(key, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}
function keepOnScreen(r: Rect, minW: number, minH: number): Rect {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.max(minW, Math.min(r.w, vw - 16)), h = Math.max(minH, Math.min(r.h, vh - 16));
  return { w, h, x: Math.max(8, Math.min(r.x, vw - w - 8)), y: Math.max(8, Math.min(r.y, vh - h - 8)) };
}

/**
 * A window the player can drag anywhere (by its header) and resize from any edge or corner.
 * Position and size are remembered per panel; "⟲" puts it back where it started.
 */
export function FloatingPanel({
  id, title, defaultRect, minW = 220, minH = 90, headerExtra, children, collapsed, onCollapse,
}: {
  id: string;
  title: ReactNode;
  /** computed from the current window size, used until the player moves the panel */
  defaultRect: () => Rect;
  minW?: number;
  minH?: number;
  headerExtra?: ReactNode;
  children: ReactNode;
  /** collapsed = header only */
  collapsed?: boolean;
  onCollapse?: () => void;
}) {
  const key = `asiwrite.panel.${id}`;
  const [rect, setRect] = useState<Rect>(() => keepOnScreen(load(key) ?? defaultRect(), minW, minH));
  const [active, setActive] = useState(false);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  // stay on screen when the browser window shrinks
  useEffect(() => {
    const onResize = () => setRect((r) => keepOnScreen(r, minW, minH));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minW, minH]);

  const start = (e: React.PointerEvent, edge: Edge | 'move') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, r0 = rectRef.current;
    setActive(true);
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      let { x, y, w, h } = r0;
      if (edge === 'move') {
        x += dx;
        y += dy;
      } else {
        if (edge.l) (w = Math.max(minW, r0.w - dx)), (x = r0.x + r0.w - w);
        if (edge.r) w = Math.max(minW, r0.w + dx);
        if (edge.t) (h = Math.max(minH, r0.h - dy)), (y = r0.y + r0.h - h);
        if (edge.b) h = Math.max(minH, r0.h + dy);
      }
      setRect(keepOnScreen({ x, y, w, h }, minW, minH));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = prevSelect;
      setActive(false);
      save(key, rectRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const reset = () => {
    const r = keepOnScreen(defaultRect(), minW, minH);
    setRect(r);
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  };

  const grip = 'absolute z-10 hover:bg-glow/30';
  return (
    <div
      className={`panel pointer-events-auto fixed z-30 flex flex-col overflow-hidden rounded-xl text-xs shadow-xl ${active ? 'ring-1 ring-glow/50' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: collapsed ? undefined : rect.h }}
    >
      <div className="flex cursor-move items-center gap-2 border-b border-white/10 px-3 py-1.5" onPointerDown={(e) => start(e, 'move')} onDoubleClick={onCollapse} title="끌어서 옮기기 · 더블클릭으로 접기/펴기">
        <span className="min-w-0 truncate font-serif text-[13px] text-parch">{title}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          {headerExtra}
          <button className="rounded px-1 text-parch-dim hover:bg-white/10 hover:text-parch" title="처음 위치·크기로" onClick={reset}>
            ⟲
          </button>
          {onCollapse && (
            <button className="rounded px-1 text-parch-dim hover:bg-white/10 hover:text-parch" title={collapsed ? '펴기' : '접기'} onClick={onCollapse}>
              {collapsed ? '▾' : '▴'}
            </button>
          )}
        </div>
      </div>
      {!collapsed && <div className="relative min-h-0 flex-1">{children}</div>}
      {!collapsed && (
        <>
          {/* edges */}
          <div className={`${grip} left-0 right-0 top-0 h-1.5 cursor-ns-resize`} onPointerDown={(e) => start(e, { t: true })} />
          <div className={`${grip} bottom-0 left-0 right-0 h-1.5 cursor-ns-resize`} onPointerDown={(e) => start(e, { b: true })} />
          <div className={`${grip} bottom-0 left-0 top-0 w-1.5 cursor-ew-resize`} onPointerDown={(e) => start(e, { l: true })} />
          <div className={`${grip} bottom-0 right-0 top-0 w-1.5 cursor-ew-resize`} onPointerDown={(e) => start(e, { r: true })} />
          {/* corners */}
          <div className={`${grip} left-0 top-0 h-3 w-3 cursor-nwse-resize`} onPointerDown={(e) => start(e, { l: true, t: true })} />
          <div className={`${grip} right-0 top-0 h-3 w-3 cursor-nesw-resize`} onPointerDown={(e) => start(e, { r: true, t: true })} />
          <div className={`${grip} bottom-0 left-0 h-3 w-3 cursor-nesw-resize`} onPointerDown={(e) => start(e, { l: true, b: true })} />
          <div className={`${grip} bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize`} onPointerDown={(e) => start(e, { r: true, b: true })}>
            <svg viewBox="0 0 8 8" className="h-full w-full text-parch-dim/60" shapeRendering="crispEdges">
              <path d="M7 2v5h-5v-1h4v-4z" fill="currentColor" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
