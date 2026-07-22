# holler — a terrain you can hear

**working title.** "holler" is Appalachian for a small mountain valley, and also a thing you do with your voice. rename freely.

spec v0.1 · 2026-07-22 · authors: ben · intended readers: ben, and any coding agent (codex etc.)

---

## 0. how to read this doc

- **DECIDED** = locked for v1. don't relitigate without asking ben.
- **OPEN** = ben's call, flagged where it matters.
- agents: work the milestones in §14 **in order**. each has acceptance criteria — verify before moving on. do not add dependencies beyond §4. do not build features from §16 unless asked.
- humans: §1–3 is the why, §7–9 is the heart, §14 is the plan.

## 1. pitch

a browser instrument where the landscape is the mixer. you sculpt a low-poly, PS1-era terrain with a brush — raise a peak, carve a valley, flood a basin — and the ambient soundscape changes because the _shape of the land_ is the parameter set. tall peaks open up the reverb. deep valleys darken a drone through a low-pass filter. rough, jagged ground adds grit and detune. water brings shimmer and echo. there are no sliders for sound anywhere in the UI. the terrain is the interface.

**lineage (for the case study):** Panoramical (2015) morphed low-poly landscapes and music together but kept an 18-axis mixer as the control surface; Proteus generated music from a procedural island you could only walk, not shape. wave terrain synthesis (1982 →) literally scans a 3D surface to make sound, but lives in plugins and hardware with mathematical surfaces. this project puts the sculpting _in_ the landscape metaphor, in a browser, with zero install. that combination is the gap.

## 2. goals / non-goals

**goals (v1)**

1. anyone with a laptop trackpad can make a sound they like within 60 seconds, no instructions.
2. every terrain edit is audible within ~250 ms, smoothly (no zipper noise, no clicks).
3. runs at 60 fps on a mid-range laptop while sculpting.
4. a made thing can leave the page: record to an audio file, share a link that restores the exact terrain.
5. it looks like a lost PS1 ambience demo and photographs well (portfolio piece).

**non-goals (v1) — DECIDED**

- **not a DAW.** no timeline, no tracks, no arrangement view, no per-channel mixer. the record button + share link cover "keep what you made." rationale: a DAW reintroduces the sliders this concept exists to delete, and triples scope.
- **no MIDI required.** mouse/touch is the only mandatory input. Web MIDI is Chromium/Firefox-only and requiring hardware guts the audience. (optional Web MIDI _input_ mapped to brush params is a post-v1 flag, §16.)
- no accounts, no backend, no database. fully static deploy.
- no mobile-first design. mobile should _work_ (§3), desktop is primary.
- no VR, no multiplayer.

## 3. audience & platform

- primary: desktop Chrome / Edge / Firefox / Safari, pointer + keyboard.
- secondary: modern iOS/Android browsers — must load, sound, and allow basic sculpting (one finger sculpt, two finger orbit). degraded fps acceptable.
- audio starts only after a user gesture (browser autoplay policy). the landing state is a rendered terrain with a single "press to begin" prompt; first click/tap calls `Tone.start()` and fades audio in over ~2 s.

## 4. tech stack — DECIDED

| thing    | choice                                                   | why                                                                                                  |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| bundler  | Vite                                                     | zero-config, static output                                                                           |
| language | TypeScript, strict                                       | agents and humans both benefit from types on the mapping layer                                       |
| 3D       | three.js (latest)                                        | mature raycasting, BufferGeometry, addons OrbitControls                                              |
| audio    | Tone.js                                                  | transport, synths, effects, signal-rate params; ben knows DSP from JUCE, Tone just saves boilerplate |
| UI       | vanilla DOM + one CSS file                               | the UI is ~10 controls; no framework                                                                 |
| deploy   | static bundle → a path on benbeaver.dev (e.g.`/holler/`) | it's a portfolio piece; it should live on the portfolio                                              |

no other runtime dependencies without asking. dev deps (eslint, prettier, vitest) fine.

## 5. core loop / UX

land → press to begin → sculpt → hear the land change → (optionally) record or share → leave with something.

**pointer scheme — DECIDED**

- left-drag on terrain: apply current brush
- right-drag (or two-finger drag): orbit camera
- wheel / pinch: zoom (clamped)
- mobile: one finger = brush, two fingers = orbit/zoom

**brushes:** `raise`, `lower`, `smooth`, `flatten` (flatten pulls toward the height sampled at stroke start). shared params: radius (world units), strength. defaults tuned so ~5 s of raising makes a respectable mountain.

**keyboard:** `1–4` brush select, `[`/`]` radius, `m` mute, `r` randomize (new seed), `backspace` reset to seed, `~` debug overlay (§13).

**UI overlay (bottom edge, small, lowercase labels):** 4 brush buttons, radius + strength sliders, seed/randomize, reset, mute, record (M5), share (M5), `?` help card. these are the _only_ controls in the app. note the rule: sliders may control the _brush_, never the _sound_.

## 6. terrain model

- heightmap: `Float32Array` of `N×N`, **N = 96** (tune 64–128 during M1), world size ~60×60 units, sea level at `h = 0`, height clamped to `[-6, +14]`.
- mesh: one `THREE.PlaneGeometry(60, 60, N-1, N-1)` rotated flat; heights written to the position attribute; `position.needsUpdate = true` per edited frame.
- **normals:** use `flatShading: true` on the material — three.js computes flat normals in-shader from derivatives, so you do NOT need `computeVertexNormals()` per edit. (perf win; verify visually in M1.)
- initial terrain: seeded fBm simplex noise (seed shown in UI, drives randomize/share). implement or vendor a tiny seeded simplex — no large noise lib.
- brush math: for each vertex within radius `r` of the raycast hit (xz distance `d`): `h += strength · exp(−d² / (2·(r/2.5)²)) · dt` (sign by tool). `smooth` = local 3×3 box blur blended by the same falloff. apply per-frame while dragging.
- raycast the terrain mesh directly per pointermove; at N=96 (~18k tris) this is fine. if profiling says otherwise, fall back to intersecting the y=0 plane and using that xz.
- water: a single static translucent plane at y=0 (no simulation). carving below sea level "floods" visually for free.
- vertex colors by elevation band, slight per-vertex value jitter so bands don't read as flat stripes:

| band (h) | role             | placeholder hex |
| -------- | ---------------- | --------------- |
| < −2.5   | deep water floor | `#1b2440`       |
| −2.5 … 0 | shallows         | `#2e4a66`       |
| 0 … 0.6  | shore            | `#8a7f5c`       |
| 0.6 … 5  | field            | `#4e6b45`       |
| 5 … 9    | rock             | `#6b6560`       |
| > 9      | snow/fog cap     | `#c9c6bd`       |

palette is OPEN — ben will tune toward the dusk/PS1 look in M4.

## 7. terrain analysis (`computeStats`)

recomputed at most **15 Hz** while a stroke is active and once on pointer-up. subsample the grid at stride 2 for speed. reuse preallocated arrays — zero allocation in the hot path.

```ts
interface TerrainStats {
  peak: number; // max(h)
  valleyDepth: number; // max(0, −min(h))  — how far below sea the deepest cut goes
  meanElev: number; // mean(h)
  roughness: number; // mean |∇h| via finite differences, normalized 0..1
  waterFrac: number; // fraction of cells with h < 0
}
```

these five numbers are the entire bridge between world and sound.

## 8. audio graph

```
droneOsc (fat saw, 3 voices, base A1)
      └─► droneFilter (lowpass, −24 dB/oct) ─┐
noise (pink) ─► noiseFilter (bandpass) ──────┤
scanner voice (M4, §9) ─────────────────────►├─► reverb (Tone.Freeverb) ─► delay (Tone.FeedbackDelay, ~0.5 wet-controlled) ─► limiter (−1 dB) ─► out
```

- **Freeverb, not `Tone.Reverb`** — DECIDED. `Tone.Reverb.decay` regenerates an impulse response (async, expensive, not smoothly automatable). Freeverb's `roomSize`/`dampening` are signals you can ramp continuously, which is exactly what sculpting needs.
- every mapped parameter changes via ramp (`signal.rampTo(v, rampSeconds)` or `setTargetAtTime`) — **never** a bare `.value =` while audio runs.
- master limiter is mandatory and wired in M2 before any mapping goes live. sculpting must never be able to hurt someone's ears.
- overall loudness target: quiet-ambient. leave headroom; this runs in people's browsers next to their music.

## 9. the mapping layer — the actual product

**data-driven — DECIDED.** mappings live in one config file (`src/audio/mappings.ts`), not scattered in code. tuning the instrument = editing this table. this is also the portfolio artifact: screenshot this table in the case study.

```ts
type Curve = "lin" | "exp" | "log";
interface Mapping {
  stat: keyof TerrainStats;
  param: string; // dot-path into the audio graph, e.g. "droneFilter.frequency"
  in: [number, number]; // expected stat range (clamped)
  out: [number, number]; // parameter range
  curve: Curve;
  ramp: number; // seconds
}
```

**v1 mapping table** (initial values; tune by ear in M3 via the debug overlay):

| terrain stat  | → audio parameter          | out range        | curve | ramp | feel                               |
| ------------- | -------------------------- | ---------------- | ----- | ---- | ---------------------------------- |
| `peak`        | `reverb.roomSize`          | 0.35 → 0.92      | lin   | 0.8  | taller world, bigger air           |
| `peak`        | `reverb.wet`               | 0.15 → 0.55      | lin   | 0.8  |                                    |
| `valleyDepth` | `droneFilter.frequency`    | 3500 Hz → 160 Hz | exp   | 0.6  | digging darkens the drone          |
| `roughness`   | `noise gain`               | −60 dB → −22 dB  | exp   | 0.4  | jagged ground hisses/grits         |
| `roughness`   | `droneOsc.spread` (detune) | 8 → 45 cents     | lin   | 0.4  |                                    |
| `waterFrac`   | `delay.feedback`           | 0.05 → 0.55      | lin   | 1.0  | more water, longer echoes          |
| `waterFrac`   | `delay.wet`                | 0.0 → 0.4        | lin   | 1.0  |                                    |
| `meanElev`    | `noiseFilter.frequency`    | 400 Hz → 2400 Hz | exp   | 0.9  | high country brightens the texture |

rules: one stat may drive several params; keep total mappings ≤ 10 in v1 or nothing reads as causal. every mapping must pass the "blindfold test": an observer watching someone sculpt should be able to guess which gesture caused which change.

## 10. the scanner — terrain as sequencer (M4)

this is the answer to "should it be a tiny DAW": **the terrain is the score.** a visible point of light orbits the map center (radius ≈ 0.6 × half-width, one revolution ≈ 24 s, synced to `Tone.Transport`). at each 8th note it samples the terrain height under itself and plays a note on a soft synth voice:

- height → pitch, quantized to **A minor pentatonic** across ~2.5 octaves (scale/root OPEN — ben's a math-rock guy, he may want something stranger; keep the scale a one-line constant).
- height above sea → velocity/brightness; over water → the voice ducks (rests). ridges under the orbit become melodies; water gaps become phrasing.
- render the scanner as a small glowing sprite + faint trail so causality is visible.

this is wave terrain synthesis's orbit-over-surface idea operating at note rate instead of audio rate — cite that lineage in the case study. it turns sculpting into _composing_ without a single timeline UI element. if the transport tempo needs exposing, it maps to nothing in v1 — resist adding a BPM slider.

## 11. visual style (M4 pass)

- flat-shaded low poly, vertex colors, no textures.
- `THREE.Fog` matched to a dusk-gradient background; fog near/far tuned so map edges dissolve.
- **PS1 resolution trick — DECIDED (v1 approach):** render the canvas at low internal resolution (~480×270-ish; expose a constant) and upscale with CSS `image-rendering: pixelated`. one toggle key in debug to compare. (a render-target + nearest-upscale + dither shader is the fancier alternative — §16.)
- slow idle: when no input for 20 s, drift the camera orbit very slowly (respect `prefers-reduced-motion`: no drift).
- title/UI type: small, lowercase, monospace or pixel font, high contrast against the bottom edge.

## 12. state: share & record (M5)

- **share — DECIDED encoding:** quantize heightmap to `Int8Array` (map clamp range to −127..127) + seed + version byte → `CompressionStream('deflate-raw')` → base64url → `location.hash`. smooth terrains compress hard; expect low single-digit KB. if the encoded string exceeds ~8000 chars, offer "download .holler.json" instead of a link. loading a hash restores terrain exactly and re-runs `computeStats`.
- **record:** `Tone.Recorder` on the limiter output → `.webm` download named `holler-<seed>.webm`. record button shows elapsed time; second press stops + downloads. (WAV via offline render = §16.)
- **undo:** snapshot the heightmap at each stroke start into a ring buffer (cap 20 ≈ 20 × 36 KB, trivial). `ctrl/cmd+z`. cheap because the data model is one flat array — do it in M5.

## 13. debug overlay (`~`)

dev-critical and demo-gold: fps, all five `TerrainStats` live, and every mapping's current output value next to its parameter name. building this in **M3 before tuning** is mandatory — you cannot tune mappings you can't see. it also makes the "how it works" section of the demo video.

## 14. milestones & acceptance criteria

**M0 — scaffold.** Vite + TS + three.js scene: seeded fBm terrain rendered flat-shaded with fog, orbit camera, fps meter.
✓ loads in <2 s locally, 60 fps idle, `npm run build` outputs a working static bundle.

**M1 — sculpting.** all four brushes, radius/strength sliders, keyboard shortcuts, vertex color bands updating live, water plane.
✓ sustained 60 fps while dragging a max-radius brush; no geometry reallocation (verify via devtools memory timeline); flatten and smooth behave as described in §6.

**M2 — static audio.** full §8 graph at fixed park values behind "press to begin"; mute; limiter verified.
✓ no clicks/pops on start, mute, or unmute; drone + noise sit at comfortable ambient level; page audible on Chrome, Firefox, Safari.

**M3 — mappings live.** `computeStats` at 15 Hz, mapping engine reads `mappings.ts`, debug overlay done.
✓ each table row demonstrably works in isolation (set others' gains to zero to verify); audible response ≤ 250 ms after an edit; zero zipper noise; raising one huge peak vs. digging one deep pit produce obviously different worlds with eyes closed.

**M4 — scanner + look.** §10 scanner voice + visible orbit; §11 aesthetic pass (palette, fog, low-res mode, idle drift).
✓ a ridge sculpted under the orbit path produces a repeating melodic figure; over-water rests work; low-res toggle visibly "PS1s" the image; still 60 fps.

**M5 — keep what you made.** record, share links, undo, reset/randomize polish, help card, favicon/OG image, deploy.
✓ a share link pasted in a fresh incognito window reproduces the terrain byte-exact; recorded webm plays back matching what was heard; deployed at the public URL; Lighthouse perf ≥ 90 on desktop.

## 15. file structure

```
src/
  main.ts            // boot, resize, frame loop, gesture gate
  terrain/
    heightmap.ts     // Float32Array model, seed/fBm, clamps
    brush.ts         // tools, falloff, stroke lifecycle
    mesh.ts          // geometry sync, vertex colors, water plane
    stats.ts         // computeStats (§7)
  audio/
    graph.ts         // nodes & wiring (§8), start/mute
    mappings.ts      // the table (§9) + apply engine
    scanner.ts       // §10
  ui/
    overlay.ts       // controls (§5)
    debug.ts         // §13
  state/
    share.ts         // §12 encode/decode
    undo.ts          // ring buffer
  style.css
```

## 16. explicitly out of scope for v1 (parking lot)

Web MIDI input for brush params (flag-gated) · multiple regional voices/biomes · dither/affine-warp post shader · WAV export via `OfflineAudioContext` · preset gallery · custom scan paths (draw your own orbit) · erosion brushes.

## 17. risks & gotchas

- **autoplay:** nothing audio-touching before the first gesture; iOS also needs the context resumed inside the tap handler.
- **iOS:** hardware mute switch silences Web Audio; sample rate may be 48k — never hardcode 44.1k.
- **reverb:** the `Tone.Reverb` decay-regeneration trap (§8) — this is why Freeverb is DECIDED; agents, do not "upgrade" it.
- **GC hitches:** stats + brush loops must not allocate per frame. typed arrays, preallocated, reused.
- **Safari:** test early (M2), it's always Safari.
- **scope:** the DAW temptation will reappear dressed as "just a small loop recorder." the answer is still no.

## 18. portfolio / case-study notes (the getting-paid part)

capture along the way: a 60–90 s screen recording with audio (sculpt a peak → hear reverb bloom, dig → hear it darken, ridge under the scanner → melody); the mapping table as an image; the debug overlay running; before/after of the low-res PS1 toggle; fps + bundle-size numbers. write-up beats: the "no sound sliders" rule, the data-driven mapping layer as a systems-design decision, the lineage paragraph (Panoramical / Proteus / wave terrain synthesis), and the no-DAW/no-MIDI scoping calls with their reasoning. that's a hiring-manager-shaped story: constraint → system → craft.

## 19. open questions for ben

1. name: keep "holler"?
2. scale/root for the scanner (§10)?
3. final palette + background gradient (§6/§11)?
4. deploy path on benbeaver.dev?
