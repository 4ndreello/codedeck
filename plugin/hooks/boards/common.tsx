/** @jsx h */
import type { ClientElements, ClientSurface } from "claude-code";

import { banner, type SeenDone } from "../../mods/arcade/games/twenty48.js";

export interface ArcadeBoardProps {
  done: number;
  colorblind: boolean;
  best: number;
}

export interface CommonState {
  paused: boolean;
  seenDone: number;
}

export function initialCommonState(): CommonState {
  return { paused: false, seenDone: 0 };
}

export function reportScore(surface: ClientSurface, game: string, score: number, done: number): void {
  surface.post({ kind: "arcade-score", game, score, done });
}

export default function CommonBoard(props: ArcadeBoardProps, surface: ClientSurface): ClientElements {
  const current = (surface.state ?? null) as CommonState | null;
  const state: CommonState = current ?? initialCommonState();
  if (current === null) surface.setState(state);
  const seen: SeenDone = { current: state.seenDone };
  // banner() owns the transition: it pauses exactly once per new done value.
  banner(props.done, seen, () => {
    surface.setState({ ...state, paused: true, seenDone: seen.current });
  });
  // The notice is driven by paused state, not by banner()'s transient return,
  // so it stays visible until the user resumes.
  const paused = state.paused || seen.current !== state.seenDone;
  surface.onKey((key) => {
    void key;
    if (paused) surface.setState({ ...state, paused: false, seenDone: seen.current });
  });
  surface.onPointer((point) => {
    void point;
    if (paused) surface.setState({ ...state, paused: false, seenDone: seen.current });
  });
  const palette = props.colorblind ? "high-contrast" : "standard";
  const line = paused
    ? `Round ${seen.current} finished - board paused. Press any key to resume.`
    : `Arcade ready (${palette}) - best ${props.best}`;
  return (
    <box>
      <text>{line}</text>
    </box>
  ) as unknown as ClientElements;
}
