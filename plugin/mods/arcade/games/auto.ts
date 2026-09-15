import { randomInt } from "./random.js";

export interface AutoInput {
  lastTurnMs?: number;
  idle?: boolean;
}

// One minute (60000 ms) separates quick turns from deep turns.
export const TURN_THRESHOLD_MS = 60_000;

export const DEEP_GAMES = ["twenty48"];
export const QUICK_GAMES = ["twenty48"];
export const DROPIN_GAMES = ["twenty48"];

export type AutoPool = "deep" | "quick" | "dropin";

// Pure pool picker: turns over one minute suggest deep games,
// turns under one minute suggest quick games, idle suggests drop-in games.
export function pickPool(input: AutoInput = {}): AutoPool {
  if (input.idle) return "dropin";
  if (typeof input.lastTurnMs === "number" && input.lastTurnMs > TURN_THRESHOLD_MS) {
    return "deep";
  }
  return "quick";
}

// Turn duration heuristic: maps the picked pool to a board.
export function pickAuto(input: AutoInput = {}): string {
  const pool = pickPool(input);
  if (pool === "deep") return DEEP_GAMES[0];
  if (pool === "dropin") return DROPIN_GAMES[0];
  return QUICK_GAMES[0];
}

export function pickRandom(games: string[] = DROPIN_GAMES): string {
  if (games.length === 0) return DROPIN_GAMES[0];
  const index = randomInt(games.length);
  return games[index];
}
