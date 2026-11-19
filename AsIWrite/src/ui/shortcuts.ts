// One keymap for both the handler and the on-screen cheat sheet.
// Uses KeyboardEvent.code (physical key) so shortcuts work regardless of the
// Korean/English IME state, and maps "Mod" to ⌘ on macOS / Ctrl on Windows.

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
export const ALT = IS_MAC ? '⌥' : 'Alt';

export type ShortcutId =
  | 'chat' | 'pause' | 'speedHalf' | 'speed1' | 'speed2' | 'speed3' | 'speed4'
  | 'rosterWill' | 'rosterAnimal' | 'groups' | 'events' | 'nextWill' | 'prevWill' | 'follow' | 'home' | 'tabPrev' | 'tabNext' | 'delete'
  | 'spawnWill' | 'spawnAnimal' | 'build' | 'weather' | 'world' | 'lightning' | 'meet' | 'bless' | 'gift' | 'rumor'
  | 'trends' | 'log' | 'research' | 'names' | 'help' | 'save' | 'load' | 'escape';

export interface Shortcut {
  id: ShortcutId;
  keys: string[]; // display
  label: string;
  group: '기본' | '카메라 · 선택' | '창조 · 개입' | '창 · 시스템';
  match: (e: KeyboardEvent) => boolean;
}

const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey;
const mod = (e: KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey;
const code = (c: string, shift = false) => (e: KeyboardEvent) => plain(e) && e.code === c && e.shiftKey === shift;

export const SHORTCUTS: Shortcut[] = [
  { id: 'chat', keys: ['Enter', '/', `${MOD} K`], label: '채팅창에 쓰기 (추천 문장 보기)', group: '기본', match: (e) => (plain(e) && !e.shiftKey && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Slash')) || (mod(e) && e.code === 'KeyK') },
  { id: 'escape', keys: ['Esc'], label: '취소 · 선택 해제 · (아무것도 없으면) 설정 메뉴', group: '기본', match: (e) => e.code === 'Escape' },
  { id: 'pause', keys: ['Space'], label: '일시정지 / 재개', group: '기본', match: code('Space') },
  { id: 'speedHalf', keys: ['0'], label: '느리게 (½배속)', group: '기본', match: (e) => plain(e) && (e.code === 'Digit0' || e.code === 'Numpad0') },
  { id: 'speed1', keys: ['1'], label: '보통 속도', group: '기본', match: (e) => plain(e) && (e.code === 'Digit1' || e.code === 'Numpad1') },
  { id: 'speed2', keys: ['2'], label: '2배속', group: '기본', match: (e) => plain(e) && (e.code === 'Digit2' || e.code === 'Numpad2') },
  { id: 'speed3', keys: ['3'], label: '3배속', group: '기본', match: (e) => plain(e) && (e.code === 'Digit3' || e.code === 'Numpad3') },
  { id: 'speed4', keys: ['4'], label: '4배속', group: '기본', match: (e) => plain(e) && (e.code === 'Digit4' || e.code === 'Numpad4') },

  { id: 'rosterWill', keys: ['P'], label: '윌 목록', group: '카메라 · 선택', match: code('KeyP') },
  { id: 'rosterAnimal', keys: ['Shift P'], label: '동물 목록', group: '카메라 · 선택', match: code('KeyP', true) },
  { id: 'groups', keys: ['U'], label: '그룹 목록', group: '카메라 · 선택', match: code('KeyU') },
  { id: 'nextWill', keys: ['Tab'], label: '다음 윌 선택하고 따라가기', group: '카메라 · 선택', match: code('Tab') },
  { id: 'prevWill', keys: ['Shift Tab'], label: '이전 윌', group: '카메라 · 선택', match: code('Tab', true) },
  { id: 'follow', keys: ['F'], label: '선택 대상 추적 켜기/끄기', group: '카메라 · 선택', match: code('KeyF') },
  { id: 'home', keys: ['Home', 'H'], label: '마을 중심으로', group: '카메라 · 선택', match: (e) => plain(e) && (e.code === 'Home' || (e.code === 'KeyH' && !e.shiftKey)) },
  { id: 'tabPrev', keys: ['['], label: '인스펙터 이전 탭', group: '카메라 · 선택', match: code('BracketLeft') },
  { id: 'tabNext', keys: [']'], label: '인스펙터 다음 탭', group: '카메라 · 선택', match: code('BracketRight') },
  { id: 'delete', keys: ['Delete', IS_MAC ? '⌫' : 'Backspace'], label: '선택 대상 지우기', group: '카메라 · 선택', match: (e) => plain(e) && (e.code === 'Delete' || e.code === 'Backspace') },

  { id: 'spawnWill', keys: ['N'], label: '윌 소환', group: '창조 · 개입', match: code('KeyN') },
  { id: 'spawnAnimal', keys: ['Shift N'], label: '동물 소환', group: '창조 · 개입', match: code('KeyN', true) },
  { id: 'build', keys: ['B'], label: '건물 배치', group: '창조 · 개입', match: code('KeyB') },
  { id: 'weather', keys: ['C'], label: '날씨 바꾸기 (맑음→비→눈→폭풍)', group: '창조 · 개입', match: code('KeyC') },
  { id: 'world', keys: ['G'], label: '세계관 바꾸기', group: '창조 · 개입', match: code('KeyG') },
  { id: 'lightning', keys: ['Z'], label: '번개 (다음 클릭한 대상, 선택돼 있으면 바로)', group: '창조 · 개입', match: code('KeyZ') },
  { id: 'meet', keys: ['M'], label: '두 윌 마주치게 하기', group: '창조 · 개입', match: code('KeyM') },
  { id: 'bless', keys: ['Q'], label: '축복 (선택한 윌)', group: '창조 · 개입', match: code('KeyQ') },
  { id: 'gift', keys: ['E'], label: '선물 (선택한 윌)', group: '창조 · 개입', match: code('KeyE') },
  { id: 'events', keys: ['K'], label: '🎪 사건 일으키기 (축제·생일·유성우…)', group: '창조 · 개입', match: code('KeyK') },
  { id: 'rumor', keys: ['R'], label: '소문 퍼뜨리기', group: '창조 · 개입', match: code('KeyR') },

  { id: 'trends', keys: ['T'], label: '🔥 실시간 트렌드 열기/닫기', group: '창 · 시스템', match: code('KeyT') },
  { id: 'log', keys: ['L'], label: '📜 이야기 로그 열기/닫기', group: '창 · 시스템', match: code('KeyL') },
  { id: 'research', keys: ['I'], label: '📊 연구 · 분석 메트릭', group: '창 · 시스템', match: code('KeyI') },
  { id: 'names', keys: ['V'], label: '이름표 보이기/숨기기', group: '창 · 시스템', match: code('KeyV') },
  { id: 'help', keys: ['?', 'F1'], label: '단축키 · 도움말', group: '창 · 시스템', match: (e) => (plain(e) && e.code === 'Slash' && e.shiftKey) || e.code === 'F1' },
  { id: 'save', keys: [`${MOD} S`], label: '빠른 저장', group: '창 · 시스템', match: (e) => mod(e) && e.code === 'KeyS' },
  { id: 'load', keys: [`${MOD} O`], label: '불러오기', group: '창 · 시스템', match: (e) => mod(e) && e.code === 'KeyO' },
];

/** Camera panning is handled continuously inside the engine (W A S D / arrows, Shift = fast). */
export const CAMERA_KEYS = ['W', 'A', 'S', 'D', '↑', '↓', '←', '→'];

export function findShortcut(e: KeyboardEvent): Shortcut | undefined {
  // "?" (Shift+/) must win over "/" (chat)
  if (e.code === 'Slash' && e.shiftKey) return SHORTCUTS.find((s) => s.id === 'help');
  return SHORTCUTS.find((s) => s.match(e));
}

export function keyHint(id: ShortcutId): string {
  return SHORTCUTS.find((s) => s.id === id)?.keys[0] ?? '';
}
