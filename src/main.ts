import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Heightmap, GRID_N } from "./terrain/heightmap";
import { TerrainMesh } from "./terrain/mesh";
import {
  DEFAULT_BRUSH_SETTINGS,
  MIN_RADIUS,
  MAX_RADIUS,
  RADIUS_STEP,
  applyBrushStep,
  emptyBounds,
  type BrushSettings,
  type BrushTool,
} from "./terrain/brush";
import type { AudioGraph } from "./audio/graph";
import { initOverlay } from "./ui/overlay";
import "./style.css";

// This is the entry point — the one file that actually wires the pieces
// together. terrain/*.ts and ui/*.ts are all "dumb" building blocks (pure
// math, or DOM elements that don't know about each other); main.ts is
// where they get introduced to one another: the scene, the camera, the
// terrain mesh, the brush, the keyboard, the on-screen controls.
//
// M0 scaffold: scene boot, resize, frame loop. gesture gate (audio start)
// lands in M2 — no audio-touching code belongs in this file yet (§17).

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const fpsEl = document.querySelector<HTMLDivElement>("#fps")!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// devicePixelRatio can be 3+ on some phones; capping it at 2 keeps the
// number of pixels we're actually rendering from exploding on those
// devices, which is a big chunk of the fps budget on weaker hardware.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const fogColor = new THREE.Color("#1a1730");
scene.background = fogColor;
// Fog color matching the background is what makes distant terrain fade
// smoothly into the sky instead of having a visible hard edge where the
// world "stops." near/far are the distances at which fog starts/finishes.
scene.fog = new THREE.Fog(fogColor, 35, 95);

const camera = new THREE.PerspectiveCamera(
  50, // field of view in degrees
  window.innerWidth / window.innerHeight, // aspect ratio — kept in sync in resize() below
  0.1, // near clip plane
  200, // far clip plane
);
camera.position.set(0, 26, 40);
camera.lookAt(0, 0, 0);

// OrbitControls gives us "drag to rotate around a target point, scroll to
// zoom" for free — we're mostly just tuning its defaults and then, further
// down, deciding exactly which mouse button/finger-count triggers it.
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; // adds a bit of inertia so camera movement feels smooth, not snappy/robotic
controls.dampingFactor = 0.08;
controls.minDistance = 8;
controls.maxDistance = 90;
controls.maxPolarAngle = Math.PI * 0.49; // don't let the camera dip below the horizon
controls.target.set(0, 0, 0);

// §5 pointer scheme: left-drag sculpts, right-drag orbits, wheel/pinch
// zooms. OrbitControls defaults to LEFT=rotate, RIGHT=pan though, which is
// backwards for us — so we remap RIGHT to rotate too, and separately (see
// the pointerdown handler below) we turn `controls.enabled` off for the
// duration of a left-drag so OrbitControls' own left-button handling never
// actually fires, even though the mapping above still technically says
// "LEFT: ROTATE." Two-finger touch does the same rotate+zoom combo.
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
// Without this, right-clicking the canvas would pop up the browser's
// native right-click menu instead of orbiting the camera.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// lighting: flat low-poly reads best with one strong key light (casts the
// visible shading on each flat-shaded triangle face) + a soft ambient fill
// so shadowed faces aren't pure black.
const sun = new THREE.DirectionalLight("#fff2e0", 1.6);
sun.position.set(-30, 40, 20);
scene.add(sun);
scene.add(new THREE.AmbientLight("#3a4a6b", 0.9));

const seed = 1;
const heightmap = new Heightmap(GRID_N, seed);
const terrain = new TerrainMesh(heightmap);
scene.add(terrain.mesh);
scene.add(terrain.water);

// --- gesture gate (§3, §17) --------------------------------------------
// Browsers block audio from starting on its own — the AudioContext stays
// suspended until it's resumed from inside a real user gesture (a click,
// a tap), or the browser just silently ignores it. That's why the whole
// audio graph doesn't get built here at module load alongside the scene:
// building it is deferred to this one button's click handler, so there is
// truly nothing audio-touching before the user has pressed something.
//
// Holds the graph once it exists so other code (the mute wiring below)
// has something to reach into. Null until the gate fires.
let audioGraph: AudioGraph | null = null;
let muted = false;

// Shared by the `m` key and the overlay's mute button — see overlay.ts's
// mute button comment for why a no-op before the graph exists is fine.
function toggleMute(): void {
  if (!audioGraph) return;
  muted = !muted;
  audioGraph.setMuted(muted); // always a ramp under the hood (graph.ts) — never an instant, clicky jump
}

const gestureGate = document.querySelector<HTMLButtonElement>("#gesture-gate")!;
gestureGate.addEventListener(
  "click",
  async () => {
    gestureGate.disabled = true;
    // Tone.js is ~700KB minified — dynamically importing it here instead
    // of statically at the top of the file means it isn't even downloaded
    // until the user presses this button, so the terrain is interactive
    // sooner on first load. It also reinforces the same rule the import's
    // *placement* is already enforcing: literally nothing audio-related
    // is fetched, let alone touched, before the gesture.
    const [Tone, { AudioGraph }] = await Promise.all([
      import("tone"),
      import("./audio/graph"),
    ]);
    // Tone.start() resumes (or creates) the AudioContext — on iOS this
    // has to happen synchronously-ish inside the gesture handler itself,
    // not after some later await, or the resume can silently fail (§17).
    await Tone.start();
    audioGraph = new AudioGraph();
    audioGraph.start(); // fades in over ~2s (see graph.ts) — no click at the start
    gestureGate.remove();
  },
  { once: true }, // this is a one-time "wake up the audio" button, not a toggle
);

// --- sculpting -------------------------------------------------------
// This whole section is "raycast the terrain under the cursor every
// frame while dragging, and feed that world position into applyBrushStep
// from brush.ts." brush.ts doesn't know anything about the mouse or
// three.js; this is the glue that turns pointer events into world
// coordinates it can understand.

// The actual mutable brush state — which tool is selected, what radius,
// what strength. It gets shared by reference with the keyboard shortcuts
// below and the UI overlay, so changing it from any one of those three
// places is instantly reflected everywhere else (there's only one object).
const brushSettings: BrushSettings = { ...DEFAULT_BRUSH_SETTINGS };

// Raycaster is three.js's "which 3D object is under this 2D screen point"
// tool. We reuse the same Raycaster and Vector2 instance on every call
// instead of constructing new ones — this runs on every pointermove while
// dragging, so, same as brush.ts, no allocations in that loop.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
// Tracks which touch fingers are currently down, so we can tell "one
// finger = sculpt" from "two fingers = orbit/zoom" apart.
const touchPointers = new Set<number>();

// "Stroke" = one continuous drag, from pointerdown to pointerup. These
// track the drag currently in progress (or null if there isn't one).
let strokePointerId: number | null = null;
let strokeLastAt = 0;
let strokeFlattenTarget = 0;
const stepBounds = emptyBounds();

// Raycasting needs coordinates in "normalized device coordinates" — both
// axes running -1 to 1 across the canvas, with +y pointing up — rather
// than raw pixel coordinates, which is what pointer events actually give
// us. This is that pixel-to-NDC conversion.
function pointerToNdc(event: PointerEvent): THREE.Vector2 {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return ndc;
}

// Fires a ray from the camera, through the cursor position, and returns
// where it hits the terrain mesh in world space — or null if the cursor
// isn't over the terrain at all (e.g. dragged off into the sky/background).
function raycastTerrain(event: PointerEvent): THREE.Vector3 | null {
  raycaster.setFromCamera(pointerToNdc(event), camera);
  const hit = raycaster.intersectObject(terrain.mesh, false)[0];
  return hit ? hit.point : null;
}

// Called once, right when the user presses down to start a brush stroke.
function beginStroke(event: PointerEvent): void {
  const point = raycastTerrain(event);
  if (!point) return; // pressed down somewhere that isn't the terrain — do nothing

  strokePointerId = event.pointerId;
  strokeLastAt = performance.now();
  // Turning controls off here is what actually stops OrbitControls from
  // rotating the camera during a left-drag — see the big comment on
  // controls.mouseButtons above for why this is safe even though LEFT is
  // still nominally mapped to ROTATE.
  controls.enabled = false;
  // Pointer capture means we keep receiving pointermove/pointerup events
  // for this exact pointer even if the cursor moves outside the canvas
  // mid-drag (e.g. user drags fast and overshoots the window edge).
  // Without it, dragging past the canvas boundary would silently drop the
  // stroke.
  canvas.setPointerCapture(event.pointerId);

  // The "flatten" brush pulls terrain toward whatever height was under
  // the cursor the moment the drag started (§5) — so we sample and
  // remember that height right here, once, before any editing happens.
  const cell = heightmap.worldToCell(point.x, point.z);
  strokeFlattenTarget = cell ? heightmap.get(cell.ix, cell.iz) : 0;

  stepStroke(event, point);
}

// Called on every pointermove while a stroke is active — this is the
// per-frame "actually edit the terrain" step.
function stepStroke(event: PointerEvent, knownPoint?: THREE.Vector3): void {
  // Ignore movement from any pointer that isn't the one currently
  // dragging (matters once a second touch finger shows up mid-stroke).
  if (event.pointerId !== strokePointerId) return;
  const point = knownPoint ?? raycastTerrain(event);
  if (!point) return; // cursor drifted off the terrain mid-drag — skip this frame, stroke stays active

  const now = performance.now();
  // applyBrushStep scales its edit by elapsed time (dt) so the brush
  // effect is frame-rate independent — same drag speed produces the same
  // amount of sculpting whether the browser is running at 30fps or
  // 144fps. Clamping dt to 0.1s guards against a huge, terrain-breaking
  // jump if the tab was backgrounded or the browser hiccuped between
  // frames.
  const dt = Math.min((now - strokeLastAt) / 1000, 0.1);
  strokeLastAt = now;

  // Reset the shared bounds object in place rather than creating a new
  // one — see brush.ts's emptyBounds() for what "reset" means here, and
  // §17 in the spec for why per-frame allocation is worth avoiding.
  stepBounds.minIx = Infinity;
  stepBounds.maxIx = -Infinity;
  stepBounds.minIz = Infinity;
  stepBounds.maxIz = -Infinity;
  applyBrushStep(
    heightmap,
    brushSettings,
    point.x,
    point.z,
    dt,
    strokeFlattenTarget,
    stepBounds,
  );
  // applyBrushStep only touched the heightmap's numbers; syncRegion is
  // what actually pushes those numbers into the visible mesh.
  terrain.syncRegion(stepBounds);
}

// Called on pointerup/pointercancel to formally end the stroke and hand
// camera control back to OrbitControls.
function endStroke(event: PointerEvent): void {
  if (event.pointerId !== strokePointerId) return;
  strokePointerId = null;
  controls.enabled = true;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch") {
    touchPointers.add(event.pointerId);
    if (touchPointers.size > 1) {
      // a second finger arrived — this is an orbit/zoom gesture, not a
      // brush stroke. hand back to OrbitControls (mobile is degraded-
      // acceptable per §3; a finger arriving mid-stroke is the one rough
      // edge here, not worth extra bookkeeping to fully smooth over).
      if (strokePointerId !== null) endStroke(event);
      return;
    }
  } else if (event.button !== 0) {
    return; // right/middle mouse: let OrbitControls handle it
  }
  beginStroke(event);
});

canvas.addEventListener("pointermove", (event) => {
  stepStroke(event);
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch") touchPointers.delete(event.pointerId);
  endStroke(event);
});
canvas.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch") touchPointers.delete(event.pointerId);
  endStroke(event);
});

// --- keyboard shortcuts (§5) ------------------------------------------
// 1-4 brush select, [ ] radius, r reseed, backspace reset to seed, m mute.
// `~` debug overlay is M3.
const BRUSH_KEYS: Record<string, BrushTool> = {
  "1": "raise",
  "2": "lower",
  "3": "smooth",
  "4": "flatten",
};

// Picks a brand new random seed and regenerates the whole terrain from
// scratch — this is "give me a different world."
function randomizeSeed(): void {
  const newSeed = Math.floor(Math.random() * 1_000_000_000);
  heightmap.generate(newSeed);
  terrain.syncAll();
}

// Regenerates the terrain using the seed it already has — this is "undo
// all my sculpting, but keep the same starting world," not "give me a
// new one." That distinction (reset vs. randomize) is why this is a
// separate function from randomizeSeed() even though the body looks
// almost identical.
function resetToSeed(): void {
  heightmap.generate(heightmap.seed);
  terrain.syncAll();
}

window.addEventListener("keydown", (event) => {
  // don't steal keys while the user is typing into a future UI control
  // (there isn't a text input anywhere yet, but the sliders below are
  // <input> elements too, so this guard is already relevant)
  if (event.target instanceof HTMLInputElement) return;

  const tool = BRUSH_KEYS[event.key];
  if (tool) {
    brushSettings.tool = tool;
    return;
  }

  switch (event.key) {
    case "[":
      brushSettings.radius = Math.max(
        MIN_RADIUS,
        brushSettings.radius - RADIUS_STEP,
      );
      break;
    case "]":
      brushSettings.radius = Math.min(
        MAX_RADIUS,
        brushSettings.radius + RADIUS_STEP,
      );
      break;
    case "r":
      randomizeSeed();
      break;
    case "Backspace":
      event.preventDefault(); // don't let the browser navigate back
      resetToSeed();
      break;
    case "m":
      toggleMute();
      break;
  }
  // Whatever just happened above (or didn't), tell the UI overlay to
  // re-read brushSettings/seed and update its buttons/sliders. Calling
  // this unconditionally even when no case matched is harmless and much
  // simpler than threading a "did anything actually change" flag through
  // the switch.
  overlay.refresh();
});

// --- UI overlay (§5) ---------------------------------------------------
// brush buttons, radius/strength sliders, seed, randomize, reset, mute.
// record/share/help are M5, not built yet.
//
// Notice overlay.ts never imports anything from this file — instead we
// hand it everything it needs as a small object (brushSettings itself,
// plus a couple of callback functions). That keeps overlay.ts a "leaf"
// module that doesn't need to know main.ts exists, which makes it easier
// to reason about and reuse.
const overlayEl = document.querySelector<HTMLDivElement>("#overlay")!;
const overlay = initOverlay(overlayEl, {
  brushSettings,
  getSeed: () => heightmap.seed,
  onRandomize: randomizeSeed,
  onReset: resetToSeed,
  isMuted: () => muted,
  onToggleMute: toggleMute,
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix(); // required after changing aspect — it doesn't take effect on its own
  renderer.setSize(w, h);
}
window.addEventListener("resize", resize);
resize(); // run once immediately so the very first frame is already sized correctly

// idle camera drift after 20s of no input (§11): if nobody's touched
// anything for a while, slowly orbit the camera on its own so a paused
// page still looks alive (handy for the portfolio screenshot too).
// prefers-reduced-motion is a browser/OS setting some users turn on
// specifically because motion like this bothers them — respecting it here
// means just never starting the drift at all for those users.
const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
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

// lightweight fps meter, no dependency — updates ~4x/sec (every 250ms)
// rather than every single frame, because a number that changes 60 times
// a second is unreadable; averaging over a quarter-second window makes it
// a stable, glanceable readout instead.
let frames = 0;
let lastFpsAt = performance.now();

// The main render loop. requestAnimationFrame schedules this to run again
// right before the browser's next repaint — calling it again as the very
// first line (rather than the last) is a common pattern that keeps the
// loop going even if something below throws, though in practice the
// bigger reason is just readability: "reschedule myself" is the first
// thing this function does, structurally.
function frame(now: number): void {
  requestAnimationFrame(frame);

  if (!reduceMotion && !userInteracting && now - lastInputAt > 20_000) {
    const t = now * 0.00003; // slow angular speed — this is meant to be barely perceptible, ambient motion
    const radius = 40;
    camera.position.x = Math.sin(t) * radius;
    camera.position.z = Math.cos(t) * radius;
    camera.lookAt(controls.target);
  }

  controls.update(); // required every frame when damping is enabled, or the inertia/momentum won't advance
  renderer.render(scene, camera);

  frames++;
  if (now - lastFpsAt >= 250) {
    const fps = Math.round((frames * 1000) / (now - lastFpsAt));
    fpsEl.textContent = `${fps} fps · seed ${heightmap.seed} · n${heightmap.n}`;
    frames = 0;
    lastFpsAt = now;
  }
}
requestAnimationFrame(frame); // kick the loop off
