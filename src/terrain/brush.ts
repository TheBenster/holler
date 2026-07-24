import { Heightmap, WORLD_SIZE, clampHeight } from "./heightmap";

// the user is dragging a brush over the terrain, what is it doing?

export type BrushTool = "raise" | "lower" | "smooth" | "flatten";

export interface BrushSettings {
  tool: BrushTool;
  radius: number; // how wide the brush is, in world units (the terrain is 60x60)
  strength: number; // how fast it edits, in height-units per second
}

export const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
  tool: "raise",
  radius: 6,
  strength: 4,
};

// clamps for the UI sliders / [ ] keys, so a novice can't drag radius to
// something silly like 0 or 500 and break the falloff math below.
export const MIN_RADIUS = 1.5;
export const MAX_RADIUS = 20;
export const RADIUS_STEP = 1;
export const MIN_STRENGTH = 0.5;
export const MAX_STRENGTH = 10;

// While a stroke is running we only want to redraw the tiny patch of mesh
// that actually changed, not the whole ~9000-vertex grid every frame. This
// is just a growable rectangle in grid-cell coordinates (ix/iz), not world
// coordinates — think "which rows and columns of the heightmap did we
// touch," so the caller (TerrainMesh.syncRegion) knows exactly what to redo.
export interface DirtyBounds {
  minIx: number;
  maxIx: number;
  minIz: number;
  maxIz: number;
}

// Start with an "inside-out" rectangle (min = +infinity, max = -infinity)
// so that the very first cell we touch immediately becomes both the min
// and the max. That's a common trick for "empty bounding box" — cheaper
// than a null check on every iteration.
export function emptyBounds(): DirtyBounds {
  return { minIx: Infinity, maxIx: -Infinity, minIz: Infinity, maxIz: -Infinity };
}

function growBounds(b: DirtyBounds, ix: number, iz: number): void {
  if (ix < b.minIx) b.minIx = ix;
  if (ix > b.maxIx) b.maxIx = ix;
  if (iz < b.minIz) b.minIz = iz;
  if (iz > b.maxIz) b.maxIz = iz;
}

// The "smooth" brush works by nudging each height toward the average of
// its 3x3 neighborhood (itself + the 8 cells around it). That average is
// what a "box blur" is — literally just "add up a box of numbers, divide
// by how many you added." Cells at the very edge of the grid have fewer
// than 9 neighbors, so we skip out-of-range ones and divide by however
// many we actually found instead of always dividing by 9.
function boxBlur3x3(heightmap: Heightmap, ix: number, iz: number): number {
  const n = heightmap.n;
  const data = heightmap.data;
  let sum = 0;
  let count = 0;
  // loop over rows
  for (let dz = -1; dz <= 1; dz++) {
    // nz = row index, iz = is current row in iter, dz is difference, so nz = iz + dz is the row we're looking at. If it's out of bounds, skip it.
    const nz = iz + dz;
    // in this case, nz is out of bounds, so we skip, can't find a delta of none
    if (nz < 0 || nz >= n) continue;
    for (let dx = -1; dx <= 1; dx++) {
      // x is column, 
      const nx = ix + dx;
      if (nx < 0 || nx >= n) continue;
      sum += data[nz * n + nx]!;
      count++;
    }
  }
  return sum / count;
}

/**
 * apply one frame of a brush stroke centered at world position (cx, cz).
 *
 * how the falloff works (this is the "brush feels soft, not like a hard
 * cookie-cutter circle" part): for every grid cell within `radius` of the
 * cursor, we compute a 0..1 weight using a gaussian bell curve based on
 * distance — cells right under the cursor get weight ~1, cells near the
 * edge of the brush fade toward 0. `sigma` (r/2.5) just controls how
 * quickly that fade happens; it was picked by eye so the visible edge of
 * the brush circle roughly lines up with where the falloff has faded out,
 * rather than the brush looking like it stops short or overshoots its
 * drawn radius.
 *
 * each tool then uses that same falloff weight differently:
 *  - raise/lower: push the height up or down, faster where the weight is
 *    higher (so the center of the brush moves more than the edges).
 *  - smooth: blend the height toward the local 3x3 average — the more
 *    weight, the more it snaps toward "flat like its neighbors."
 *  - flatten: blend the height toward `flattenTarget`, which is whatever
 *    height was under the cursor the moment the stroke started. So
 *    dragging flatten around carves everything toward that one starting
 *    elevation, like a levelling tool.
 *
 * Everything here mutates `heightmap.data` directly and reuses the
 * `bounds` object the caller passed in. no `new` anywhere in this
 * function. That matters because this runs on every pointermove while
 * you're dragging; allocating objects in a loop like that is exactly what
 * causes those little stutters/hitches you sometimes feel in laggy web
 * apps (the browser's garbage collector has to stop and clean up after
 * you). Reusing the same objects avoids that entirely.
 */
export function applyBrushStep(
  heightmap: Heightmap,
  settings: BrushSettings,
  cx: number,
  cz: number,
  dt: number,
  flattenTarget: number,
  bounds: DirtyBounds,
): void {
  const n = heightmap.n;
  const data = heightmap.data;
  const r = settings.radius;
  const sigma = r / 2.5;
  const twoSigmaSq = 2 * sigma * sigma;
  const r2 = r * r; // compare against squared distance so we can skip a sqrt() per cell

  // The heightmap is stored as a flat grid (ix, iz), but the brush position
  // (cx, cz) comes in as world coordinates (e.g. -30..30). This block
  // converts "where in the world is the cursor" into "which grid cell is
  // that," then works out a bounding box of cells worth even checking —
  // no point scanning the whole 96x96 grid when the brush might only
  // cover a 10x10 patch of it.
  const cellSize = WORLD_SIZE / (n - 1);
  const half = WORLD_SIZE / 2;
  const centerU = (cx + half) / cellSize;
  const centerV = (cz + half) / cellSize;
  const gridRadius = Math.ceil(r / cellSize) + 1; // +1 pads for rounding, so we don't clip the brush edge

  const ixLo = Math.max(0, Math.floor(centerU - gridRadius));
  const ixHi = Math.min(n - 1, Math.ceil(centerU + gridRadius));
  const izLo = Math.max(0, Math.floor(centerV - gridRadius));
  const izHi = Math.min(n - 1, Math.ceil(centerV + gridRadius));

  for (let iz = izLo; iz <= izHi; iz++) {
    for (let ix = ixLo; ix <= ixHi; ix++) {
      // convert this cell back to world space so we can measure its
      // actual distance from the cursor (grid distance and world distance
      // aren't the same thing unless cellSize happens to be 1).
      const x = ix * cellSize - half;
      const z = iz * cellSize - half;
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue; // outside the circle entirely, skip it

      const falloff = Math.exp(-d2 / twoSigmaSq); // 1.0 at the cursor, fading toward 0 at the edge
      const idx = iz * n + ix;
      const h = data[idx]!;
      let next: number;

      switch (settings.tool) {
        case "raise":
          next = h + settings.strength * falloff * dt;
          break;
        case "lower":
          next = h - settings.strength * falloff * dt;
          break;
        case "smooth": {
          // blend toward the neighborhood average instead of setting it
          // outright — that's what makes repeated smoothing gradually
          // relax bumpy terrain instead of instantly flattening it.
          const avg = boxBlur3x3(heightmap, ix, iz);
          const amt = Math.min(1, falloff * settings.strength * 0.25 * dt);
          next = h + (avg - h) * amt;
          break;
        }
        case "flatten": {
          // same blend-toward-a-target idea as smooth, but the target is
          // the fixed height captured at stroke start, not a moving
          // neighborhood average.
          const amt = Math.min(1, falloff * settings.strength * 0.5 * dt);
          next = h + (flattenTarget - h) * amt;
          break;
        }
      }

      data[idx] = clampHeight(next); // keep height inside [-6, 14] no matter what
      growBounds(bounds, ix, iz); // remember we touched this cell, for the caller's partial redraw
    }
  }
}
