import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Heightmap, GRID_N } from "./terrain/heightmap";
import { TerrainMesh } from "./terrain/mesh";
import "./style.css";

// M0 scaffold: scene boot, resize, frame loop. gesture gate (audio start)
// lands in M2 — no audio-touching code belongs in this file yet (§17).

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const fpsEl = document.querySelector<HTMLDivElement>("#fps")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const fogColor = new THREE.Color("#1a1730");
scene.background = fogColor;
scene.fog = new THREE.Fog(fogColor, 35, 95);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  200,
);
camera.position.set(0, 26, 40);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 8;
controls.maxDistance = 90;
controls.maxPolarAngle = Math.PI * 0.49; // don't let the camera dip below the horizon
controls.target.set(0, 0, 0);

// lighting: flat low-poly reads best with one strong key + soft ambient fill
const sun = new THREE.DirectionalLight("#fff2e0", 1.6);
sun.position.set(-30, 40, 20);
scene.add(sun);
scene.add(new THREE.AmbientLight("#3a4a6b", 0.9));

const seed = 1;
const heightmap = new Heightmap(GRID_N, seed);
const terrain = new TerrainMesh(heightmap);
scene.add(terrain.mesh);
scene.add(terrain.water);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener("resize", resize);
resize();

// idle camera drift after 20s of no input (§11), respecting reduced motion.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let lastInputAt = performance.now();
let userInteracting = false;
controls.addEventListener("start", () => {
  userInteracting = true;
  lastInputAt = performance.now();
});
controls.addEventListener("end", () => {
  userInteracting = false;
  lastInputAt = performance.now();
});

// lightweight fps meter, no dependency — updates ~4x/sec so the number is
// readable rather than flickering every frame.
let frames = 0;
let lastFpsAt = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);

  if (!reduceMotion && !userInteracting && now - lastInputAt > 20_000) {
    const t = now * 0.00003;
    const radius = 40;
    camera.position.x = Math.sin(t) * radius;
    camera.position.z = Math.cos(t) * radius;
    camera.lookAt(controls.target);
  }

  controls.update();
  renderer.render(scene, camera);

  frames++;
  if (now - lastFpsAt >= 250) {
    const fps = Math.round((frames * 1000) / (now - lastFpsAt));
    fpsEl.textContent = `${fps} fps · seed ${heightmap.seed} · n${heightmap.n}`;
    frames = 0;
    lastFpsAt = now;
  }
}
requestAnimationFrame(frame);
