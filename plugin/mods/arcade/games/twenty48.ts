// Pure 2048 logic for the arcade demo board. No engine imports so plain
// vitest runs it. The board components under plugin/hooks/boards/ own the
// surface wiring (state, keys, pointer, score posts) and import from here.

export interface SeenDone {
  current: number;
}

// Banner helper: pauses once per new done value. The caller keeps `seen`
// across renders; when `done` changes we record it and pause a single time.
export function banner(done: number, seen: SeenDone, pause: () => void): string | null {
  if (done === seen.current) return null;
  seen.current = done;
  pause();
  return `Round ${done} finished - board paused. Press any key to resume.`;
}

export type Direction = "up" | "down" | "left" | "right";

export interface Twenty48State {
  grid: number[];
  score: number;
  over: boolean;
  won: boolean;
  posted: boolean;
  paused: boolean;
  seenDone: number;
}

export function emptyGrid(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

export function spawnTile(grid: number[], pick: () => number): number[] {
  const open: number[] = [];
  for (let idx = 0; idx < 16; idx += 1) {
    if (grid[idx] === 0) open.push(idx);
  }
  if (open.length === 0) return grid;
  const slot = open[pick() % open.length];
  const next = grid.slice();
  next[slot] = pick() % 10 === 0 ? 4 : 2;
  return next;
}

export function slideRow(row: number[]): { row: number[]; gained: number } {
  const tiles = row.filter((cell) => cell !== 0);
  const out: number[] = [];
  let gained = 0;
  let idx = 0;
  while (idx < tiles.length) {
    if (idx + 1 < tiles.length && tiles[idx] === tiles[idx + 1]) {
      const merged = tiles[idx] * 2;
      out.push(merged);
      gained += merged;
      idx += 2;
    } else {
      out.push(tiles[idx]);
      idx += 1;
    }
  }
  while (out.length < 4) out.push(0);
  return { row: out, gained };
}

export function moveGrid(grid: number[], direction: Direction): { grid: number[]; gained: number; moved: boolean } {
  const next = grid.slice();
  let gained = 0;
  let moved = false;
  const setRow = (rowIdx: number, row: number[]) => {
    for (let col = 0; col < 4; col += 1) {
      const at = rowIdx * 4 + col;
      if (next[at] !== row[col]) moved = true;
      next[at] = row[col];
    }
  };
  const getRow = (rowIdx: number): number[] => {
    const row: number[] = [];
    for (let col = 0; col < 4; col += 1) row.push(grid[rowIdx * 4 + col]);
    return row;
  };
  const getCol = (colIdx: number): number[] => {
    const col: number[] = [];
    for (let rowIdx = 0; rowIdx < 4; rowIdx += 1) col.push(grid[rowIdx * 4 + colIdx]);
    return col;
  };
  const setCol = (colIdx: number, col: number[]) => {
    for (let rowIdx = 0; rowIdx < 4; rowIdx += 1) {
      const at = rowIdx * 4 + colIdx;
      if (next[at] !== col[rowIdx]) moved = true;
      next[at] = col[rowIdx];
    }
  };
  if (direction === "left" || direction === "right") {
    for (let rowIdx = 0; rowIdx < 4; rowIdx += 1) {
      let row = getRow(rowIdx);
      if (direction === "right") row = row.reverse();
      const slid = slideRow(row);
      gained += slid.gained;
      const placed = direction === "right" ? slid.row.reverse() : slid.row;
      setRow(rowIdx, placed);
    }
  } else {
    for (let colIdx = 0; colIdx < 4; colIdx += 1) {
      let col = getCol(colIdx);
      if (direction === "down") col = col.reverse();
      const slid = slideRow(col);
      gained += slid.gained;
      const placed = direction === "down" ? slid.row.reverse() : slid.row;
      setCol(colIdx, placed);
    }
  }
  return { grid: next, gained, moved };
}

export function isFinished(grid: number[]): boolean {
  if (grid.some((cell) => cell === 0)) return false;
  const probe: Direction[] = ["up", "down", "left", "right"];
  for (const direction of probe) {
    if (moveGrid(grid, direction).moved) return false;
  }
  return true;
}

export function initialTwenty48State(pick: () => number = () => Math.floor(Math.random() * 16)): Twenty48State {
  const seeded = spawnTile(spawnTile(emptyGrid(), pick), pick);
  return { grid: seeded, score: 0, over: false, won: false, posted: false, paused: false, seenDone: 0 };
}

export function directionForKey(name: string): Direction | null {
  if (name === "up" || name === "w") return "up";
  if (name === "down" || name === "s") return "down";
  if (name === "left" || name === "a") return "left";
  if (name === "right" || name === "d") return "right";
  return null;
}
