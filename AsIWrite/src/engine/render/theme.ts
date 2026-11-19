// World-context driven palettes. Changing WorldContext re-skins the map
// instantly (no assets), e.g. modern asphalt → medieval cobblestone.

export interface Theme {
  id: 'modern' | 'fantasy' | 'apocalypse' | 'cyber';
  grass: [string, string];
  road: string;
  roadLine: string;
  sidewalk: string;
  plaza: string;
  dirt: string;
  wood: string;
  tile: string;
  carpet: string;
  wall: string;
  wallTop: string;
  tree: [string, string];
  accent: string;
  night: string; // night overlay color
  lampGlow: string;
}

const MODERN: Theme = {
  id: 'modern',
  grass: ['#6e9b5b', '#679354'],
  road: '#4a4d52',
  roadLine: '#d8c873',
  sidewalk: '#b3ada2',
  plaza: '#c7bba4',
  dirt: '#b39470',
  wood: '#b88a5e',
  tile: '#d9d6cf',
  carpet: '#7a4e7e',
  wall: '#5b5049',
  wallTop: '#8a7a6c',
  tree: ['#3f7342', '#56925a'],
  accent: '#ffcf6e',
  night: '#0b1030',
  lampGlow: 'rgba(255,214,140,',
};

const FANTASY: Theme = {
  ...MODERN,
  id: 'fantasy',
  grass: ['#7aa55a', '#729e52'],
  road: '#8a7b66',
  roadLine: '#8a7b66',
  sidewalk: '#a59680',
  plaza: '#b9a888',
  wood: '#9c6f45',
  tile: '#a8a090',
  carpet: '#8a2f3a',
  wall: '#6d6458',
  wallTop: '#a29684',
  tree: ['#2f6634', '#4a8a46'],
  night: '#0d0f2a',
  lampGlow: 'rgba(255,170,90,',
};

const APOCALYPSE: Theme = {
  ...MODERN,
  id: 'apocalypse',
  grass: ['#8a8a5a', '#7f7f52'],
  road: '#3a3936',
  roadLine: '#6b6650',
  sidewalk: '#8f877a',
  plaza: '#9d927f',
  dirt: '#8d7559',
  wood: '#7d6249',
  tile: '#a39c90',
  carpet: '#4f3f3a',
  wall: '#4a4440',
  wallTop: '#6e655d',
  tree: ['#5a5f3a', '#6e7444'],
  accent: '#e06b4a',
  night: '#120c08',
  lampGlow: 'rgba(255,140,80,',
};

const CYBER: Theme = {
  ...MODERN,
  id: 'cyber',
  grass: ['#2a3a3e', '#26363a'],
  road: '#1a1c26',
  roadLine: '#ff3fa4',
  sidewalk: '#3b3f52',
  plaza: '#434863',
  dirt: '#3d3a4a',
  wood: '#4a3f5e',
  tile: '#5d6378',
  carpet: '#2d1f4d',
  wall: '#20232f',
  wallTop: '#00e0ff',
  tree: ['#1f5f5a', '#2a8a7f'],
  accent: '#00e0ff',
  night: '#05031a',
  lampGlow: 'rgba(120,220,255,',
};

export function themeFor(context: string): Theme {
  if (/(판타지|중세|마법|왕국|fantasy)/i.test(context)) return FANTASY;
  if (/(아포칼립스|좀비|멸망|폐허|apocalypse)/i.test(context)) return APOCALYPSE;
  if (/(사이버|네온|미래|cyber)/i.test(context)) return CYBER;
  return MODERN;
}
