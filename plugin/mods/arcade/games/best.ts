export type BestTable = Record<string, number>;

// Higher score wins for every arcade game. Returns true when there is no
// stored best yet for that game, or when the new score beats it.
export function isBetter(game: string, score: number, best: BestTable): boolean {
  const prev = best[game];
  if (prev === undefined) return true;
  return score > prev;
}
