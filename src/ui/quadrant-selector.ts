import * as THREE from "three";
import { WORLD_SIZE } from "../terrain/heightmap";

const QUADRANT_SIZE = WORLD_SIZE / 2;
const OVERLAY_HEIGHT = 15.2;

/** A lightweight in-world overlay for selecting one of the four pad voices. */
export class QuadrantSelector {
  readonly group = new THREE.Group();
  private readonly tiles: THREE.Mesh[] = [];

  constructor() {
    const geometry = new THREE.PlaneGeometry(QUADRANT_SIZE, QUADRANT_SIZE);
    const edges = new THREE.EdgesGeometry(geometry);
    const centers: [number, number][] = [
      [-QUADRANT_SIZE / 2, -QUADRANT_SIZE / 2], // NW
      [QUADRANT_SIZE / 2, -QUADRANT_SIZE / 2], // NE
      [-QUADRANT_SIZE / 2, QUADRANT_SIZE / 2], // SW
      [QUADRANT_SIZE / 2, QUADRANT_SIZE / 2], // SE
    ];

    for (const [x, z] of centers) {
      const material = new THREE.MeshBasicMaterial({
        color: "#ffd78a",
        transparent: true,
        opacity: 0.035,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const tile = new THREE.Mesh(geometry, material);
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(x, OVERLAY_HEIGHT, z);
      this.tiles.push(tile);
      this.group.add(tile);

      const border = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: "#ffe5a8", transparent: true, opacity: 0.34 }),
      );
      border.rotation.x = -Math.PI / 2;
      border.position.copy(tile.position);
      this.group.add(border);
    }
    this.group.visible = false;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (!visible) this.setHovered(null);
  }

  setHovered(index: number | null): void {
    for (let i = 0; i < this.tiles.length; i++) {
      const material = this.tiles[i]!.material as THREE.MeshBasicMaterial;
      material.opacity = i === index ? 0.2 : 0.035;
      material.color.set(i === index ? "#fff1bf" : "#ffd78a");
    }
  }

  dispose(): void {
    for (const child of this.group.children) {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }
}
