import * as THREE from "three";
import { Heightmap, WORLD_SIZE } from "./heightmap";
import type { DirtyBounds } from "./brush";

// turning array of heights into mesh, helper functions for syncing user input
// changing the mesh

// come back to with eye, potential texture
const BANDS: { max: number; color: THREE.Color }[] = [
  { max: -2.5, color: new THREE.Color("#1b2440") }, // deep water floor
  { max: 0, color: new THREE.Color("#2e4a66") }, // shallows
  { max: 0.6, color: new THREE.Color("#8a7f5c") }, // shore
  { max: 5, color: new THREE.Color("#4e6b45") }, // field
  { max: 9, color: new THREE.Color("#6b6560") }, // rock
  { max: Infinity, color: new THREE.Color("#c9c6bd") }, // snow/fog cap
];

// gets called multiple times, used to avoid instantiating a new Color each time
const tmpColor = new THREE.Color();

function colorForHeight(h: number, jitter: number): THREE.Color {
  let band = BANDS[BANDS.length - 1]!;
  for (const b of BANDS) {
    if (h < b.max) {
      band = b;
      break;
    }
  }
  //very slight color jitter so colors in the same band aren't flat
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
    // PlaneGeometry starts out flat (all vertices at y=0) with n-1 by
    // n-1 grid squares — we'll push each vertex up/down to match the
    // heightmap in syncAll() below. It's built lying in the XY plane by
    // default, so rotateX turns it to lie flat on the XZ plane instead
    // Y is "up".
    this.geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, n - 1, n - 1);
    this.geometry.rotateX(-Math.PI / 2);

    this.geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Float32Array(n * n * 3), 3),
    );

    // each vertex gets a jittered color once, and stays, so color isn't generated every frame
    this.jitter = new Float32Array(n * n);
    for (let i = 0; i < this.jitter.length; i++) this.jitter[i] = Math.random();

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      // flatShading: low poly
      flatShading: true,
      roughness: 1,
      metalness: 0,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.matrixAutoUpdate = false; // this mesh never moves/rotates/scales, so let updateMatrix() be manual and skip the per-frame recompute

    // frustum culling causes an object to not be rendered if it's outside
    // of a camera's view, with angles upwards of camera view, 
    // objects may be incorrectly omitted.
    // https://threejs.org/docs/#Object3D.frustumCulled
    this.mesh.frustumCulled = false;

    // water is flat, auto generates at y=0, no waves yet.
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

// developed for performance, only syncs the mesh to the heightmap data, no new objects are created, and no new memory is allocated.
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
    // setting a vertex's position/color in JS doesn't touch the GPU by
    // itself three.js only re-uploads a buffer when you flip its
    // needsUpdate flag
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.updateMatrix();
  }

  /**
   * Same idea as syncAll(), but only for the rectangle of cells a single
   * brush step actually touched (see brush.ts's DirtyBounds). Dragging a
   * brush fires syncRegion on every pointermove event.
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
