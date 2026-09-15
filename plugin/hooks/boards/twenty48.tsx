/** @jsx h */
import type { ClientElements, ClientSurface } from "claude-code";

import {
  banner,
  directionForKey,
  initialTwenty48State,
  isFinished,
  moveGrid,
  spawnTile,
  type SeenDone,
  type Twenty48State,
} from "../../mods/arcade/games/twenty48.js";
import { randomInt } from "../../mods/arcade/games/random.js";

export interface Twenty48Props {
  done: number;
  colorblind: boolean;
  best: number;
}

export const BOARD_PATH = "hooks/boards/twenty48.tsx";

export default function Twenty48Board(props: Twenty48Props, surface: ClientSurface): ClientElements {
  const current = (surface.state ?? null) as Twenty48State | null;
  const state: Twenty48State = current ?? initialTwenty48State();
  if (current === null) surface.setState(state);
  const seen: SeenDone = { current: state.seenDone };
  // banner() owns the transition: it pauses exactly once per new done value.
  banner(props.done, seen, () => {
    surface.setState({ ...state, paused: true, seenDone: seen.current });
  });
  // The notice is driven by paused state, not by banner()'s transient return,
  // so it stays visible until the user resumes and no keypress is eaten blind.
  const paused = state.paused || seen.current !== state.seenDone;

  const finish = (final: Twenty48State) => {
    if (!final.posted) {
      surface.post({ kind: "arcade-score", game: "twenty48", score: final.score, done: props.done });
      surface.setState({ ...final, posted: true });
    } else {
      surface.setState(final);
    }
  };

  surface.onKey((key) => {
    if (paused) {
      surface.setState({ ...state, paused: false, seenDone: seen.current });
      return;
    }
    if (state.over) return;
    const direction = directionForKey(key.name);
    if (direction === null) return;
    const stepped = moveGrid(state.grid, direction);
    if (!stepped.moved) return;
    const grid = spawnTile(stepped.grid, () => randomInt(16));
    const score = state.score + stepped.gained;
    const won = state.won || grid.some((cell) => cell >= 2048);
    const over = isFinished(grid);
    const final: Twenty48State = { ...state, grid, score, won, over };
    if (over || won) finish(final);
    else surface.setState(final);
  });

  surface.onPointer((point) => {
    void point;
    if (paused) {
      surface.setState({ ...state, paused: false, seenDone: seen.current });
      return;
    }
    if (state.over && !state.posted) {
      surface.post({ kind: "arcade-score", game: "twenty48", score: state.score, done: props.done });
      surface.setState({ ...state, posted: true });
    }
  });

  const palette = props.colorblind ? "high-contrast" : "standard";
  const rows: string[] = [];
  for (let rowIdx = 0; rowIdx < 4; rowIdx += 1) {
    const cells: string[] = [];
    for (let col = 0; col < 4; col += 1) {
      const cell = state.grid[rowIdx * 4 + col];
      cells.push(cell === 0 ? "    ." : String(cell).padStart(5, " "));
    }
    rows.push(cells.join(" "));
  }
  const status = state.over ? "game over" : state.won ? "you win" : `${palette} - best ${props.best}`;
  const line = paused
    ? `Round ${seen.current} finished - board paused. Press any key to resume.`
    : `2048 score ${state.score} (${status})\n${rows.join("\n")}`;
  return (
    <box>
      <text>{line}</text>
    </box>
  ) as unknown as ClientElements;
}
