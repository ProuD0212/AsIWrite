import { worldTheme, type WorldTheme } from '../worldTheme';

// World-context driven palettes. Changing WorldContext re-skins the map
// instantly (no assets), e.g. modern asphalt → medieval cobblestone.

export interface Theme {
  id: 'modern' | 'fantasy' | 'apocalypse' | 'cyber' | 'school' | 'pirate' | 'space' | 'joseon';
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
  grass: ['#76b25c', '#86c068'],
  road: '#51545c',
  roadLine: '#e8d77a',
  sidewalk: '#c9c0ae',
  plaza: '#d4c7aa',
  dirt: '#c49e70',
  wood: '#b88a5e',
  tile: '#d9d6cf',
  carpet: '#7a4e7e',
  wall: '#5b5049',
  wallTop: '#8a7a6c',
  tree: ['#3f8a46', '#5cad58'],
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

const SCHOOL: Theme = { ...MODERN, id: 'school', grass: ['#7cbf6a', '#74b663'], road: '#5b5f66', sidewalk: '#c9c3b8', plaza: '#d8cdb8', wood: '#c69a6a', tile: '#e3e0d8', carpet: '#5a7fb8', wall: '#8a6a58', wallTop: '#b98f73', accent: '#7cc8ff' };
const PIRATE: Theme = { ...MODERN, id: 'pirate', grass: ['#d9c38a', '#d1ba80'], road: '#8a7a5a', roadLine: '#8a7a5a', sidewalk: '#c2a878', plaza: '#cdb688', dirt: '#b89a68', wood: '#8a5a36', tile: '#a8916a', carpet: '#7a2f2f', wall: '#5e3f2a', wallTop: '#8c6646', tree: ['#3f8a4a', '#5aa85e'], accent: '#ffcf6e', night: '#071a2e', lampGlow: 'rgba(255,190,110,' };
const SPACE: Theme = { ...MODERN, id: 'space', grass: ['#3a3d4a', '#363946'], road: '#22252f', roadLine: '#58c8ff', sidewalk: '#4b4f60', plaza: '#555a6e', dirt: '#6a5a5a', wood: '#5d6275', tile: '#8a90a3', carpet: '#2b3a5c', wall: '#2a2d38', wallTop: '#9aa8c8', tree: ['#2f6f6a', '#3f9a8f'], accent: '#58c8ff', night: '#02030f', lampGlow: 'rgba(120,200,255,' };
const JOSEON: Theme = { ...MODERN, id: 'joseon', grass: ['#8aa860', '#82a058'], road: '#a08a68', roadLine: '#a08a68', sidewalk: '#b8a07a', plaza: '#c4ad86', dirt: '#a88c62', wood: '#9a7048', tile: '#c9b998', carpet: '#7a5a3a', wall: '#6b5a4a', wallTop: '#3d3a40', tree: ['#3f6a3a', '#5a8a4a'], accent: '#e06b6b', night: '#0c0d22', lampGlow: 'rgba(255,170,90,' };

const BY_THEME: Partial<Record<WorldTheme, Theme>> = { modern: MODERN, fantasy: FANTASY, apocalypse: APOCALYPSE, cyber: CYBER, school: SCHOOL, pirate: PIRATE, space: SPACE, joseon: JOSEON };

export function themeFor(context: string): Theme {
  return BY_THEME[worldTheme(context)] ?? MODERN;
}
