// Human-readable status strings for the UI.

import { josa } from '../engine/traits';
import type { Agent } from '../engine/types';
import type { World } from '../engine/World';

export function activityOf(w: World, a: Agent): string {
  const ai = a.ai;
  switch (ai.mode) {
    case 'chat': {
      const c = w.convoOf(a);
      const others = c ? c.members.filter((m) => m !== a.id).map((m) => w.agent(m)?.name).filter(Boolean) : [];
      const names = others.join(', ');
      if (c?.argue) return `${josa(names, '와/과')} 말다툼 중`;
      return others.length ? `${josa(names, '와/과')} 이야기 중` : '이야기 중';
    }
    case 'visit': {
      const p = w.place(ai.targetPlaceId);
      return p ? `${p.name}에서 시간을 보내는 중` : '쉬는 중';
    }
    case 'goto': {
      const p = w.place(ai.targetPlaceId);
      if (p) return `${josa(p.name, '으로/로')} 가는 중`;
      const b = w.agent(ai.meetWith);
      return b ? `${b.name}에게 가는 중` : '어딘가로 가는 중';
    }
    case 'wander':
      return a.kind === 'animal' ? '어슬렁거리는 중' : '산책 중';
    case 'break':
      return { sigh: '😞 벤치에 주저앉아 한숨 쉬는 중', sadSong: '😢 혼자 슬픈 노래를 부르는 중', grumble: '😠 괜히 시비 걸 사람을 찾는 중' }[ai.breakKind ?? 'sigh'];
    default:
      if (a.kind === 'animal' && a.emote?.icon === '💤') return '낮잠 자는 중';
      return a.mood >= 80 ? '콧노래를 흥얼거리는 중' : '멍하니 서 있는 중';
  }
}

export function moodLabel(m: number): { text: string; color: string } {
  if (m >= 80) return { text: '행복함', color: '#7ccf7a' };
  if (m >= 60) return { text: '좋음', color: '#a6d35a' };
  if (m >= 40) return { text: '보통', color: '#e8c45a' };
  if (m >= 20) return { text: '우울함', color: '#ec8a3a' };
  return { text: '한계', color: '#d0443e' };
}

export function affinityLabel(v: number): string {
  if (v >= 75) return '절친';
  if (v >= 50) return '친한 사이';
  if (v >= 25) return '호감';
  if (v > -25) return '아는 사이';
  if (v > -50) return '불편한 사이';
  return '앙숙';
}
