import * as THREE from "three";
import { Heightmap, WORLD_SIZE } from "./heightmap";
import type { DirtyBounds } from "./brush";

// This file's job: take the plain-number heightmap (just a flat array of
// heights) and turn it into an actual three.js mesh you can look at — the
// geometry (where the vertices are), the colors (what they look like), and
// a couple of helpers to keep both in sync whenever the heightmap changes.

// §6 elevation color bands: which color a vertex gets depends on how high
// it is. Read top to bottom as "if height is below this number, use this
// color." The exact hex values are a placeholder — OPEN in the spec, meant
// to be tuned by eye later, not something to treat as final.
const BANDS: { max: number; color: THREE.Color }[] = [
  { max: -2.5, color: new THREE.Color("#1b2440") }, // deep water floor
  { max: 0, color: new THREE.Color("#2e4a66") }, // shallows
  { max: 0.6, color: new THREE.Color("#8a7f5c") }, // shore
  { max: 5, color: new THREE.Color("#4e6b45") }, // field
  { max: 9, color: new THREE.Color("#6b6560") }, // rock
  { max: Infinity, color: new THREE.Color("#c9c6bd") }, // snow/fog cap
];

// Reused across every call to colorForHeight instead of creating a new
// THREE.Color each time — same "don't allocate in a hot loop" reasoning as
// brush.ts. This function can get called thousands of times per stroke.
const tmpColor = new THREE.Color();

function colorForHeight(h: number, jitter: number): THREE.Color {
  let band = BANDS[BANDS.length - 1]!;
  for (const b of BANDS) {
    if (h < b.max) {
      band = b;
      break;
    }
  }
  // Without this, every vertex in the same band would be the exact same
  // color, and the terrain would read as flat colored stripes instead of
  // natural-looking ground. `jitter` is a random 0..1 value assigned once
  // per vertex (see below) that very slightly brightens/darkens the color,
  // just enough to break up the flatness without looking noisy.
  const j = 1 + (jitter - 0.5) * 0.12;
  tmpColor.copy(band.color);
  tmpColor.r = Math.min(1, tmpColor.r * j);
  tmpColor.g = Math.min(1, tmpColor.g * j);
  tmpColor.b = Math.min(1, tmpColor.b * j);
  return tmpColor;
}

export class TerrainMesh {
  readonly geometry: THREE.PlaneGeometry;
  readonly material: THREE.MeshStandardMaterial;
  readonly mesh: THREE.Mesh;
  readonly water: THREE.Mesh;

  private jitter: Float32Array;

  constructor(private heightmap: Heightmap) {
    const n = heightmap.n;
    // A PlaneGeometry starts out flat (all vertices at y=0) with n-1 by
    // n-1 grid squares — we'll push each vertex up/down to match the
    // heightmap in syncAll() below. It's built lying in the XY plane by
    // default, so rotateX turns it to lie flat on the XZ plane instead
    // (three.js convention: Y is "up").
    this.geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, n - 1, n - 1);
    this.geometry.rotateX(-Math.PI / 2);
    // vertex colors aren't part of a plain PlaneGeometry by default — we
    // have to add our own color buffer, one RGB triplet per vertex.
    this.geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Float32Array(n * n * 3), 3),
    );

    // One random "jitter" value per vertex, generated once and kept
    // forever. If we regenerated this every time the terrain redrew, the
    // speckled texture would flicker/shimmer during sculpting — picking it
    // once and reusing it keeps each vertex's jitter stable no matter how
    // its height (and therefore its color band) changes later.
    this.jitter = new Float32Array(n * n);
    for (let i = 0; i < this.jitter.length; i++) this.jitter[i] = Math.random();

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // flatShading gives the low-poly "each triangle is one flat facet"
      // look this project wants, and — bonus — three.js computes those
      // flat normals for free from the geometry itself. Without it we'd
      // need to call geometry.computeVertexNormals() every single time we
      // edit the terrain, which is exactly the kind of per-edit cost
      // worth avoiding.
      flatShading: true,
      roughness: 1,
      metalness: 0,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.matrixAutoUpdate = false; // this mesh never moves/rotates/scales, so let updateMatrix() be manual and skip the per-frame recompute
    // Three.js normally skips drawing an object if its bounding sphere is
    // outside the camera's view (this is "frustum culling," a common perf
    // trick). That sphere gets computed once from the geometry's vertex
    // positions. But sculpting keeps moving vertices — e.g. raising a peak
    // pushes a vertex toward the +14 height clamp — so that original
    // sphere goes stale, and a tall peak could get incorrectly culled
    // (invisible) from certain camera angles if we don't either recompute
    // the sphere on every edit (real cost, unnecessary for one mesh) or
    // just tell three.js not to bother culling this object at all, which
    // is what we do here. Totally fine for a single ~18k-triangle mesh.
    this.mesh.frustumCulled = false;

    // The water is just a second, flat, translucent plane sitting exactly
    // at sea level (y=0). There's no wave simulation or anything fancy —
    // any part of the terrain the user carves below y=0 will simply poke
    // up through this plane and look "flooded" for free, no extra logic
    // needed on the terrain side at all.
    const waterGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#2e4a66"),
      transparent: true,
      opacity: 0.55,
      roughness: 0.2,
      metalness: 0.1,
    });
    this.water = new THREE.Mesh(waterGeo, waterMat);
    this.water.position.y = 0;
    this.water.matrixAutoUpdate = false;
    this.water.updateMatrix();

    this.syncAll();
  }

  /**
   * Push every height + color from the heightmap into the geometry's
   * buffers. This walks all n*n vertices, so call it for the "whole
   * terrain changed at once" cases — first load, or after hitting
   * randomize/reset. While the user is actively dragging a brush, use
   * syncRegion() instead so we're not redoing 9000+ vertices to update the
   * dozen or so a small brush actually touched.
   */
  syncAll(): void {
    const n = this.heightmap.n;
    const pos = this.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.geometry.attributes.color as THREE.BufferAttribute;

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const idx = iz * n + ix;
        const h = this.heightmap.data[idx]!;
        pos.setY(idx, h); // only Y moves — X/Z stay put, this is a heightmap, not a general mesh deform
        const c = colorForHeight(h, this.jitter[idx]!);
        col.setXYZ(idx, c.r, c.g, c.b);
      }
    }
    // Setting a vertex's position/color in JS doesn't touch the GPU by
    // itself — three.js only re-uploads a buffer when you flip its
    // needsUpdate flag. Forgetting this line is a classic "I changed the
    // data but nothing on screen moved" bug.
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.updateMatrix();
  }

  /**
   * Same idea as syncAll(), but only for the rectangle of cells a single
   * brush step actually touched (see brush.ts's DirtyBounds). Dragging a
   * brush fires this on basically every pointermove event, so keeping it
   * cheap matters a lot more here than it does for syncAll(), which only
   * runs on big one-off actions like loading or randomizing.
   *
   * One thing this does NOT do: a partial GPU upload. three.js does have
   * an API for that (BufferAttribute.addUpdateRange), which lets you tell
   * the GPU "only re-upload these specific bytes." We skip it here because
   * at this grid size (96x96) the entire position+color buffer is only
   * about 220KB — trivially fast to re-upload in full every frame — so the
   * CPU-side savings (not recomputing colors for thousands of untouched
   * vertices) is the win that actually matters, and reaching for the GPU
   * partial-upload API on top of that would just be extra bookkeeping for
   * no measurable benefit at this scale.
   */
  syncRegion(bounds: DirtyBounds): void {
    // If nothing was actually touched (min > max means the bounds were
    // never grown), bail out instead of running a backwards loop.
    if (bounds.minIx > bounds.maxIx || bounds.minIz > bounds.maxIz) return;
    const n = this.heightmap.n;
    const pos = this.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.geometry.attributes.color as THREE.BufferAttribute;

    for (let iz = bounds.minIz; iz <= bounds.maxIz; iz++) {
      for (let ix = bounds.minIx; ix <= bounds.maxIx; ix++) {
        const idx = iz * n + ix;
        const h = this.heightmap.data[idx]!;
        pos.setY(idx, h);
        const c = colorForHeight(h, this.jitter[idx]!);
        col.setXYZ(idx, c.r, c.g, c.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
  }
}
