// The tutorial town: small, friendly, and missing one thing on purpose (a karaoke) so the player
// can discover a Will's wish and make it come true.

import { World } from '../engine/World';

export const TUTORIAL_WILL = '윤한별';

const HANBYEOL = `[이름] ${TUTORIAL_WILL}
[분류] 윌
[외형] 분홍색 단발머리, 노란 후드티, 별 머리핀, 반짝이는 눈
[직업] 가수 지망생
[애착 물건] 처음 산 낡은 마이크
[성향 및 특성]
- 노래방에서 목청껏 노래하는 걸 정말 좋아한다
- 밝고 수다스럽다
- 요즘 노래할 곳이 없어 조금 시무룩하다
- 언젠가 무대에 서는 것이 꿈이다
[초기 무드] 45`;

export function createTutorialWorld(): World {
  const w = World.createWith({ context: '현대 서울', weather: 'clear', wills: 3, places: 5, animals: 1 });
  // no karaoke yet — that's the wish to fulfil
  for (const p of w.places.filter((x) => x.style === 'karaoke')) w.removeEntity(p.id);
  const home = w.places.find((p) => p.style === 'home');
  const spot = home ? { x: (home.door.tx + 1.5) * 32, y: (home.door.ty + 2) * 32 } : { x: w.map.w * 16, y: w.map.h * 16 };
  const han = w.addAgentFromSheet(HANBYEOL, spot.x, spot.y);
  w.ensureHome(han);
  w.needsOf(han).fun = 22; // bored: the wish shows up right away
  w.rumors.rumors = [];
  w.questsPaused = true;
  w.feed = [];
  w.pushFeed({ kind: 'system', text: '📖 튜토리얼 마을에 오신 걸 환영해요. 왼쪽 위 미션을 따라가 보세요.' });
  return w;
}
