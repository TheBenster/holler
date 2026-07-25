import { Heightmap } from "./heightmap";

// §7: the entire bridge between the terrain and the sound. Nothing outside
// this file should read heightmap.data directly for audio purposes — the
// mapping engine (audio/mappings.ts) only ever sees these five numbers,
// not the raw grid. That's the whole point of the design: the terrain
// could change shape entirely (different N, different noise function) and
// as long as it still produces a TerrainStats, nothing downstream notices.
export interface TerrainStats {
  peak: number; // max(h)
  valleyDepth: number; // max(0, -min(h)) — how far below sea the deepest cut goes
  meanElev: number; // mean(h)
  roughness: number; // mean |gradient|, normalized to roughly 0..1
  waterFrac: number; // fraction of sampled cells with h < 0
  /** Average elevation above sea level: broad raised land, not spike height. */
  landMass: number;
  /** Positive land mass in NW, NE, SW, SE; reused in the hot path. */
  regionMass: Float32Array;
}

/** A zeroed stats object to mutate in place — see computeStats() for why. */
export function createStats(): TerrainStats {
  return {
    peak: 0,
    valleyDepth: 0,
    meanElev: 0,
    roughness: 0,
    waterFrac: 0,
    landMass: 0,
    regionMass: new Float32Array(4),
  };
}

// Every other cell, in both directions — a quarter of the full N*N grid.
// §7 explicitly allows this ("subsample the grid at stride 2 for speed")
// because computeStats can run up to 15 times a second while dragging;
// walking all ~9200 cells that often is unnecessary work for five numbers
// that are, by nature, coarse summaries anyway.
const STRIDE = 2;

// How much height difference between two STRIDE-apart samples counts as
// "fully rough" (roughness = 1). Picked by eye against the terrain's own
// clamp range [-6, 14] and cell spacing — like the color bands in mesh.ts,
// this is a placeholder worth tuning once you can actually hear roughness
// change something (the debug overlay, added later in M3, is what makes
// that tuning possible at all).
const ROUGHNESS_NORMALIZE = 2.5;
const REGION_COUNTS = new Uint16Array(4);

/**
 * Walks the heightmap once, at stride 2, and fills in `out` with all five
 * §7 stats. Takes a preallocated `out` to mutate instead of returning a
 * new object — same reasoning as brush.ts's DirtyBounds: this can run up
 * to 15 times a second while the user drags a brush, and allocating a
 * fresh object on every one of those calls is exactly the kind of
 * per-frame garbage that causes GC hitches (§17).
 */
export function computeStats(heightmap: Heightmap, out: TerrainStats): void {
  const n = heightmap.n;
  const data = heightmap.data;

  let peak = -Infinity;
  let minH = Infinity;
  let sum = 0;
  let sampleCount = 0;
  let underwaterCount = 0;
  let landMass = 0;
  const regionSums = out.regionMass;
  regionSums.fill(0);
  REGION_COUNTS.fill(0);
  let gradSum = 0;
  let gradCount = 0;

  for (let iz = 0; iz < n; iz += STRIDE) {
    for (let ix = 0; ix < n; ix += STRIDE) {
      const idx = iz * n + ix;
      const h = data[idx]!;

      if (h > peak) peak = h;
      if (h < minH) minH = h;
      sum += h;
      if (h < 0) underwaterCount++;
      const positiveHeight = Math.max(0, h);
      landMass += positiveHeight;
      const region = (iz >= n / 2 ? 2 : 0) + (ix >= n / 2 ? 1 : 0);
      regionSums[region]! += positiveHeight;
      REGION_COUNTS[region]!++;
      sampleCount++;

      // Roughness: how much height changes from one sample to the next,
      // averaged over both grid axes. Only look "forward" (+STRIDE) so
      // each pair of neighbors is measured exactly once, not twice.
      if (ix + STRIDE < n) {
        gradSum += Math.abs(data[idx + STRIDE]! - h);
        gradCount++;
      }
      if (iz + STRIDE < n) {
        gradSum += Math.abs(data[idx + STRIDE * n]! - h);
        gradCount++;
      }
    }
  }

  out.peak = peak;
  out.valleyDepth = Math.max(0, -minH);
  out.meanElev = sum / sampleCount;
  out.roughness = Math.min(1, gradSum / gradCount / ROUGHNESS_NORMALIZE);
  out.waterFrac = underwaterCount / sampleCount;
  out.landMass = landMass / sampleCount;
  for (let i = 0; i < regionSums.length; i++) {
    regionSums[i] = regionSums[i]! / REGION_COUNTS[i]!;
  }
}
