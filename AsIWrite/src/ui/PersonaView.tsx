import { useMemo, useState } from 'react';
import type { Game } from '../engine/Game';
import { AXIS_INFO, AXIS_LABEL, axisLevel, explainPersona, josa, PERSONA_AXES, personaSentence, type Axis } from '../engine/traits';
import type { Agent } from '../engine/types';
import { GENDER_LABEL } from '../presets/people';

const GROUPS = ['관계', '감정', '행동', '마음가짐'] as const;

/**
 * 🧭 성격 — the 12 personality axes read from the Will's own trait sentences, with the sentences
 * that caused each one (hover / tap a bar). Strong axes first; the rest fold away as "보통".
 */
export function PersonaView({ game, a }: { game: Game; a: Agent }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Axis | null>(null);
  const key = a.traits.join('\n');
  const matcher = game.world.matcher;
  // re-read only when the traits change (the projection compares every trait with ~90 anchor sentences)
  const { persona, why } = useMemo(() => explainPersona(key ? key.split('\n') : [], matcher), [key, matcher]);
  const sentence = personaSentence(persona, 3);
  const strong = (ax: Axis) => Math.abs(persona[ax]) >= 0.25;
  const shown = PERSONA_AXES.filter((ax) => all || strong(ax));
  const hidden = PERSONA_AXES.length - PERSONA_AXES.filter(strong).length;

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-parch-dim">🧭 성격{a.kind === 'person' && a.gender ? ` · ${GENDER_LABEL[a.gender]}` : ''}</span>
        <button className="text-[10px] text-parch-dim underline-offset-2 hover:text-parch hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? '뚜렷한 것만' : `모든 축 보기${hidden ? ` (+${hidden})` : ''}`}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-parch/90">{sentence ? `${josa(a.name, '은/는')} ${sentence}` : '아직 뚜렷한 성격이 드러나지 않았어요. 특성을 더 써 주면 성격이 보여요.'}</p>
      {GROUPS.map((g) => {
        const axes = shown.filter((ax) => AXIS_INFO[ax].group === g);
        if (!axes.length) return null;
        return (
          <div key={g} className="grid gap-1">
            <div className="text-[10px] text-parch-dim/70">{g}</div>
            {axes.map((ax) => {
              const v = persona[ax];
              const [lo, hi] = AXIS_LABEL[ax];
              const lvl = axisLevel(v);
              const isOpen = open === ax;
              return (
                <div key={ax} className="grid gap-0.5">
                  <button
                    className="grid grid-cols-[4.6rem_1fr_4.6rem] items-center gap-1.5 text-[10px]"
                    title={`${AXIS_INFO[ax].effect}${why[ax].length ? `\n\n이렇게 보는 이유:\n${why[ax].slice(0, 3).map((x) => `「${x.trait}」 → ${AXIS_LABEL[ax][x.d > 0 ? 1 : 0]}`).join('\n')}` : ''}`}
                    onClick={() => setOpen(isOpen ? null : ax)}
                  >
                    <span className={`truncate text-right ${v <= -0.25 ? 'text-parch' : 'text-parch-dim/70'}`}>{lo}</span>
                    <span className="relative h-2 rounded-full bg-white/10">
                      <span className="absolute left-1/2 top-0 h-full w-px bg-white/25" />
                      <span
                        className="absolute top-0 h-full rounded-full"
                        style={{ left: v >= 0 ? '50%' : `${50 + v * 50}%`, width: `${Math.abs(v) * 50}%`, background: v >= 0 ? '#7cc8ff' : '#f2a0bf' }}
                      />
                    </span>
                    <span className={`truncate text-left ${v >= 0.25 ? 'text-parch' : 'text-parch-dim/70'}`}>
                      {hi}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="ml-[4.9rem] mr-[4.9rem] rounded bg-white/5 px-2 py-1 text-[10px] leading-relaxed text-parch-dim">
                      <div className="text-parch/90">{lvl ? `${lvl} ${AXIS_LABEL[ax][v > 0 ? 1 : 0]}` : '보통'}</div>
                      <div>{AXIS_INFO[ax].effect}</div>
                      {why[ax].length > 0 && (
                        <ul className="mt-0.5">
                          {why[ax].slice(0, 3).map((x) => (
                            <li key={x.trait}>
                              「{x.trait}」 → {AXIS_LABEL[ax][x.d > 0 ? 1 : 0]}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
