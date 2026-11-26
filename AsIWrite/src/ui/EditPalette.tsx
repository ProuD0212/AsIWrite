import type { Game } from '../engine/Game';
import type { MapBrush } from '../engine/TileMap';

const BRUSHES: { id: MapBrush; icon: string; label: string; hint: string }[] = [
  { id: 'road', icon: '🛣️', label: '차도', hint: '주변 잔디에 인도가 자동으로 깔려요' },
  { id: 'sidewalk', icon: '🚶', label: '인도', hint: '보행자 길' },
  { id: 'dirt', icon: '🟫', label: '흙길', hint: '공원 산책로 같은 오솔길' },
  { id: 'plaza', icon: '⬜', label: '광장 바닥', hint: '돌을 깐 넓은 바닥' },
  { id: 'grass', icon: '🌱', label: '잔디', hint: '길을 걷어 내고 잔디로 되돌려요' },
  { id: 'tree', icon: '🌳', label: '나무', hint: '지나갈 수 없어요' },
  { id: 'bush', icon: '🌿', label: '덤불', hint: '지나갈 수 없어요' },
  { id: 'flower', icon: '🌷', label: '꽃', hint: '지나갈 수 없어요' },
  { id: 'lamp', icon: '💡', label: '가로등', hint: '밤에 불이 켜져요' },
  { id: 'bench', icon: '🪑', label: '벤치', hint: '장식' },
  { id: 'erase', icon: '🧹', label: '장식 지우기', hint: '나무·꽃·가로등·벤치를 치워요 (바닥은 그대로)' },
];

/** Map-edit mode toolbar: brush, brush size, map size, and how to resize. Shown only while editing. */
export function EditPalette({ game }: { game: Game }) {
  const cur = BRUSHES.find((b) => b.id === game.brush);
  return (
    <div className="panel scroll-thin pointer-events-auto absolute bottom-3 left-1/2 z-30 flex max-h-[calc(100dvh-140px)] w-[min(760px,calc(100vw-160px))] -translate-x-1/2 flex-col gap-2 overflow-y-auto rounded-xl p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-serif text-[13px] text-parch">🛠️ 맵 편집</span>
        <span className="truncate text-parch-dim">
          세계 {game.world.map.w}×{game.world.map.h}칸 · 왼쪽 드래그 = 칠하기 · 오른쪽 드래그·WASD = 화면 이동 · <b className="text-glow/90">노란 테두리·모서리를 끌면 크기 조절</b>
        </span>
        <button className="shrink-0 rounded-md bg-glow/90 px-2.5 py-1 font-semibold text-ink hover:bg-glow" onClick={() => game.dispatch({ type: 'SYSTEM', action: 'EDIT_MAP', value: 0 })} title="편집 끝내기 (X 또는 Esc)">
          완료
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {BRUSHES.map((b) => (
          <button
            key={b.id}
            title={b.hint}
            onClick={() => {
              game.brush = b.id;
              game.notify(true);
            }}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 ${game.brush === b.id ? 'border-glow/70 bg-glow/20 text-parch' : 'border-white/10 text-parch-dim hover:bg-white/10 hover:text-parch'}`}
          >
            <span>{b.icon}</span>
            {b.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-parch-dim">
        <span>칠하기</span>
        {(['line', 'free'] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              game.paintMode = m;
              game.notify(true);
            }}
            title={m === 'line' ? '끌어서 곧은 길 (가로·세로로 맞춰짐, Shift를 누르면 비스듬히)' : '마우스가 지나간 자리를 그대로 칠하기'}
            className={`rounded-md border px-2 py-0.5 ${game.paintMode === m ? 'border-glow/70 bg-glow/20 text-parch' : 'border-white/10 hover:bg-white/10'}`}
          >
            {m === 'line' ? '📏 직선' : '✏️ 자유'}
          </button>
        ))}
        <span className="ml-1">붓 크기</span>
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            onClick={() => {
              game.brushSize = n;
              game.notify(true);
            }}
            className={`min-w-8 rounded-md border px-2 py-0.5 ${game.brushSize === n ? 'border-glow/70 bg-glow/20 text-parch' : 'border-white/10 hover:bg-white/10'}`}
          >
            {n}×{n}
          </button>
        ))}
        <button className="ml-auto rounded-md border border-white/10 px-2 py-0.5 hover:bg-white/10" title="방금 한 일 되돌리기 (Ctrl/⌘ Z)" disabled={!game.undoStack.length} onClick={() => game.toast(game.undo())}>
          ↩️ 되돌리기{game.undoStack.length ? ` (${game.undoStack.length})` : ''}
        </button>
        <button className="rounded-md border border-white/10 px-2 py-0.5 hover:bg-white/10" title="지도 전체가 화면에 들어오게" onClick={() => game.fitView()}>
          🔍 전체 보기
        </button>
      </div>
      <div className="truncate text-parch-dim/80">
        {cur && <span>{cur.icon} {cur.hint} · 건물 안은 칠해지지 않아요</span>}
      </div>
    </div>
  );
}
