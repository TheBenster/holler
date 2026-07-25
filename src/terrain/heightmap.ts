import { SeededSimplex2D } from "./noise";

// §6: N=96 (tune 64-128 in M1), world size ~60x60, height clamped [-6, 14].
export const GRID_N = 96;
export const WORLD_SIZE = 60;
export const HEIGHT_MIN = -6;
export const HEIGHT_MAX = 14;

export function clampHeight(h: number): number {
  if (h < HEIGHT_MIN) return HEIGHT_MIN;
  if (h > HEIGHT_MAX) return HEIGHT_MAX;
  return h;
}

/**
 * flat Float32Array heightmap model, row-major, N x N.
 * this is the entire "document" — undo (§12) and share-links (§12) snapshot
 * or encode nothing but this array plus the seed.
 */
export class Heightmap {
  readonly n: number;
  readonly data: Float32Array;
  seed: number;

  constructor(n: number = GRID_N, seed: number = 1) {
    this.n = n;
    this.data = new Float32Array(n * n);
    this.seed = seed;
    this.generate(seed);
  }

  index(ix: number, iz: number): number {
    return iz * this.n + ix;
  }

  get(ix: number, iz: number): number {
    return this.data[this.index(ix, iz)] ?? 0;
  }

  set(ix: number, iz: number, h: number): void {
    this.data[this.index(ix, iz)] = clampHeight(h);
  }

  /** regenerate the whole grid from a seeded fBm field. deterministic. */
  generate(seed: number): void {
    this.seed = seed;
    const noise = new SeededSimplex2D(seed);
    // spatial frequency tuned so the 60x60-unit world reads as a handful of
    // rolling features, not high-frequency static.
    const freq = 1 / 22;
    const amplitude = 5.5;
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) {
        const x = ix * freq;
        const z = iz * freq;
        const h = noise.fbm2D(x, z, 4, 2.0, 0.5) * amplitude;
        this.data[this.index(ix, iz)] = clampHeight(h);
      }
    }
  }

  /** world-space xz -> nearest grid cell, or null if outside the terrain. */
  worldToCell(x: number, z: number): { ix: number; iz: number } | null {
    const half = WORLD_SIZE / 2;
    const u = (x + half) / WORLD_SIZE; // 0..1
    const v = (z + half) / WORLD_SIZE; // 0..1
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const ix = Math.round(u * (this.n - 1));
    const iz = Math.round(v * (this.n - 1));
    return { ix, iz };
  }

  cellToWorld(ix: number, iz: number): { x: number; z: number } {
    const half = WORLD_SIZE / 2;
    const x = (ix / (this.n - 1)) * WORLD_SIZE - half;
    const z = (iz / (this.n - 1)) * WORLD_SIZE - half;
    return { x, z };
  }

  /**
   * Bilinearly sample the surface at a world-space point. The scanner uses
   * this rather than snapping to a vertex, so its note stream follows the
   * sculpted slopes smoothly as it travels around the orbit.
   */
  sampleWorld(x: number, z: number): number {
    const half = WORLD_SIZE / 2;
    const u = Math.max(0, Math.min(this.n - 1, ((x + half) / WORLD_SIZE) * (this.n - 1)));
    const v = Math.max(0, Math.min(this.n - 1, ((z + half) / WORLD_SIZE) * (this.n - 1)));
    const x0 = Math.floor(u);
    const z0 = Math.floor(v);
    const x1 = Math.min(this.n - 1, x0 + 1);
    const z1 = Math.min(this.n - 1, z0 + 1);
    const tx = u - x0;
    const tz = v - z0;
    const top = this.get(x0, z0) + (this.get(x1, z0) - this.get(x0, z0)) * tx;
    const bottom = this.get(x0, z1) + (this.get(x1, z1) - this.get(x0, z1)) * tx;
    return top + (bottom - top) * tz;
  }
}
