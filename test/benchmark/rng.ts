import { createHash } from "node:crypto";

/** A small seeded generator (mulberry32). The same seed always yields the same sequence, on every platform. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** Uniform integer in [lo, hi]. */
    int: (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

/** A per-case seed that depends only on the benchmark seed, the family and the index: cases can be rebuilt one by one. */
export function deriveSeed(seed: number, family: string, index: number): number {
  const digest = createHash("sha256").update(`${seed}:${family}:${index}`).digest();
  return digest.readUInt32BE(0);
}
