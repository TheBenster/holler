import * as THREE from "three";
import { Heightmap, WORLD_SIZE } from "./heightmap";

// §6 elevation color bands. placeholder palette — OPEN, tune in M4.
const BANDS: { max: number; color: THREE.Color }[] = [
  { max: -2.5, color: new THREE.Color("#1b2440") }, // deep water floor
  { max: 0, color: new THREE.Color("#2e4a66") }, // shallows
  { max: 0.6, color: new THREE.Color("#8a7f5c") }, // shore
  { max: 5, color: new THREE.Color("#4e6b45") }, // field
  { max: 9, color: new THREE.Color("#6b6560") }, // rock
  { max: Infinity, color: new THREE.Color("#c9c6bd") }, // snow/fog cap
];

const tmpColor = new THREE.Color();

function colorForHeight(h: number, jitter: number): THREE.Color {
  let band = BANDS[BANDS.length - 1]!;
  for (const b of BANDS) {
    if (h < b.max) {
      band = b;
      break;
    }
  }
  // slight per-vertex value jitter so bands don't read as flat stripes (§6)
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
    this.geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, n - 1, n - 1);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Float32Array(n * n * 3), 3),
    );

    // stable per-vertex jitter seed, independent of height, so it doesn't
    // shift every time the terrain is edited.
    this.jitter = new Float32Array(n * n);
    for (let i = 0; i < this.jitter.length; i++) this.jitter[i] = Math.random();

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true, // §6: flat-shaded, no per-edit computeVertexNormals needed
      roughness: 1,
      metalness: 0,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.matrixAutoUpdate = false;

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

  /** rebuild every vertex's height + color from the heightmap. call once at
   * init and after a full regenerate; brush strokes should use syncRegion
   * (added in M1) instead to avoid touching the whole buffer. */
  syncAll(): void {
    const n = this.heightmap.n;
    const pos = this.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.geometry.attributes.color as THREE.BufferAttribute;

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const idx = iz * n + ix;
        const h = this.heightmap.data[idx]!;
        pos.setY(idx, h);
        const c = colorForHeight(h, this.jitter[idx]!);
        col.setXYZ(idx, c.r, c.g, c.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.mesh.updateMatrix();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
  }
}
