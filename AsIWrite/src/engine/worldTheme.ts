// One place that decides which kind of world a free-text WorldContext is.
// Used by trait/appearance generation, map palettes, trait mutation and world creation.
// Contexts that match none of these are 'other' — the AI storyteller then
// re-imagines new Wills for that world (see World.reimagine).

export type WorldTheme = 'modern' | 'fantasy' | 'apocalypse' | 'cyber' | 'school' | 'pirate' | 'space' | 'joseon' | 'other';

const RULES: [RegExp, WorldTheme][] = [
  [/(아포칼립스|좀비|멸망|폐허|apocalypse|zombie)/i, 'apocalypse'],
  [/(조선|사극|한양|궁궐|한옥|양반|고려|삼국)/i, 'joseon'],
  [/(해적|항구|선원|바다 마을|무인도|섬마을|pirate)/i, 'pirate'],
  [/(우주|화성|달 기지|정거장|은하|우주선|행성|sf|space)/i, 'space'],
  [/(판타지|중세|마법|왕국|엘프|드워프|기사단|fantasy)/i, 'fantasy'],
  [/(사이버|네온|미래 도시|디스토피아|cyber)/i, 'cyber'],
  [/(학교|학원|교실|기숙사|캠퍼스|고등학교|중학교|대학|school)/i, 'school'],
  [/(현대|서울|부산|인천|대구|광주|일상|도시|한국|동네|회사|modern)/i, 'modern'],
];

export function worldTheme(context: string): WorldTheme {
  for (const [re, t] of RULES) if (re.test(context)) return t;
  return 'other';
}

/** themes with curated presets (everything except 'other') */
export const CURATED: WorldTheme[] = ['modern', 'fantasy', 'apocalypse', 'cyber', 'school', 'pirate', 'space', 'joseon'];
