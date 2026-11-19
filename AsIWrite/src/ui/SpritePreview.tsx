import { useEffect, useRef } from 'react';
import { parseAppearance } from '../engine/appearance';
import { drawAgent } from '../engine/render/drawAgent';
import type { Agent, AgentKind, Facing } from '../engine/types';

/** Live canvas preview of the 6-layer sprite for a given appearance text. */
export function SpritePreview({ appearance, kind, name, category, mood = 60, size = 96, raining = false }: { appearance: string; kind: AgentKind; name: string; category: string; mood?: number; size?: number; raining?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // pixel-art preview: 40×40 virtual pixels per facing, enlarged with nearest-neighbour
    const CELL = 40;
    c.width = CELL * 4;
    c.height = CELL;
    const ctx = c.getContext('2d')!;
    const layers = parseAppearance(appearance, kind, name || 'preview', category);
    const facings: Facing[] = ['down', 'left', 'up', 'right'];
    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const t = (now - start) / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, CELL * 4, CELL);
      facings.forEach((f, i) => {
        const fake = {
          kind, layers, x: 0, y: 0, facing: f, moving: true, animPhase: t * 7, mood,
          ai: { mode: 'wander' }, emote: undefined,
        } as unknown as Agent;
        ctx.save();
        ctx.translate(CELL * i + CELL / 2, CELL - 5);
        const k = kind === 'animal' ? 1.3 : 0.92;
        ctx.scale(k, k);
        drawAgent(ctx, fake, { t, seated: false, raining, selected: false, hovered: false });
        ctx.restore();
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [appearance, kind, name, category, mood, size, raining]);
  return <canvas ref={ref} style={{ width: size * 4, height: size, maxWidth: '100%' }} className="pixelated rounded-lg bg-[#6e9b5b]/40" />;
}
