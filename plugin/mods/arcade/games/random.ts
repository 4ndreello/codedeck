// Game randomness backed by the platform CSPRNG instead of Math.random.
// Tile spawns and game picks are not secrets, but a predictable generator is
// one confused refactor away from mattering, and Sonar flags Math.random
// (typescript:S2245) wherever it appears.
export function randomInt(bound: number): number {
  if (!Number.isInteger(bound) || bound <= 0) {
    throw new RangeError(`randomInt needs a positive integer bound, got ${bound}`);
  }
  const sample = new Uint32Array(1);
  globalThis.crypto.getRandomValues(sample);
  return sample[0] % bound;
}
