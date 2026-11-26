// Uniform spatial hash grid for O(1) average neighbor queries.

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

export class SpatialGrid<T extends Positioned> {
  private cells = new Map<number, T[]>();
  private where = new Map<string, number>();
  readonly cellSize: number;
  private cols: number;

  /** Cumulative query stats for the telemetry panel. */
  queryCount = 0;
  queryTimeMs = 0;

  constructor(worldW: number, cellSize = 64) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(worldW / cellSize) + 1;
  }

  private key(x: number, y: number): number {
    const cx = Math.max(0, Math.floor(x / this.cellSize));
    const cy = Math.max(0, Math.floor(y / this.cellSize));
    return cy * this.cols + cx;
  }

  insert(item: T) {
    const k = this.key(item.x, item.y);
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = []));
    cell.push(item);
    this.where.set(item.id, k);
  }

  remove(item: T) {
    const k = this.where.get(item.id);
    if (k === undefined) return;
    const cell = this.cells.get(k);
    if (cell) {
      const i = cell.indexOf(item);
      if (i >= 0) cell.splice(i, 1);
    }
    this.where.delete(item.id);
  }

  /** Call after an item moved. Cheap no-op if it stayed in its cell. */
  update(item: T) {
    const k = this.key(item.x, item.y);
    const old = this.where.get(item.id);
    if (old === k) return;
    if (old !== undefined) {
      const cell = this.cells.get(old);
      if (cell) {
        const i = cell.indexOf(item);
        if (i >= 0) cell.splice(i, 1);
      }
    }
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = []));
    cell.push(item);
    this.where.set(item.id, k);
  }

  queryRadius(x: number, y: number, r: number, out: T[] = []): T[] {
    const t0 = performance.now();
    out.length = 0;
    const cs = this.cellSize;
    const x0 = Math.max(0, Math.floor((x - r) / cs));
    const x1 = Math.floor((x + r) / cs);
    const y0 = Math.max(0, Math.floor((y - r) / cs));
    const y1 = Math.floor((y + r) / cs);
    const r2 = r * r;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.cells.get(cy * this.cols + cx);
        if (!cell) continue;
        for (const it of cell) {
          const dx = it.x - x;
          const dy = it.y - y;
          if (dx * dx + dy * dy <= r2) out.push(it);
        }
      }
    }
    this.queryTimeMs += performance.now() - t0;
    this.queryCount++;
    return out;
  }

  clear() {
    this.cells.clear();
    this.where.clear();
  }
}
