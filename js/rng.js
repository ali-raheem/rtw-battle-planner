// Seeded PRNG (mulberry32). Every battle is fully determined by its 32-bit seed,
// so a seed in the URL replays the same armies and the same fight.

export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // Roughly normal, mean 0, sd ~0.5.
    gauss: () => next() + next() + next() - 1.5,
    // entries: [[item, weight], ...]
    weighted(entries) {
      let total = 0;
      for (const [, w] of entries) total += w;
      let r = next() * total;
      for (const [item, w] of entries) if ((r -= w) < 0) return item;
      return entries[entries.length - 1][0];
    },
  };
}

export function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (Math.random() * 2 ** 32) >>> 0;
}
