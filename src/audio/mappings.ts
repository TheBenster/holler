import type { AudioGraph } from "./graph";
import type { TerrainStats } from "../terrain/stats";

type ScalarTerrainStat = Exclude<keyof TerrainStats, "regionMass">;

// §9: "the mapping layer — the actual product." Everything else in this
// app exists to feed this table or to be driven by it. Tuning the
// instrument means editing MAPPINGS below, not touching graph.ts or
// stats.ts — that's the whole reason this table is data instead of code
// scattered across the audio graph.

export type Curve = "lin" | "exp" | "log";

export interface Mapping {
  stat: ScalarTerrainStat;
  param: string; // dot-path into the audio graph, e.g. "droneFilter.frequency"
  in: [number, number]; // expected stat range, clamped before use
  out: [number, number]; // parameter range
  curve: Curve;
  ramp: number; // seconds
}

// §9 v1 mapping table — initial values, meant to be tuned by ear once the
// debug overlay (added later in M3) makes the live numbers visible. `in`
// ranges are calibrated against this project's actual terrain constants
// (heightmap.ts: height clamped to [-6, 14], fresh terrain peaks around
// 3-6 before any sculpting) rather than guessed from nothing.
export const MAPPINGS: Mapping[] = [
  { stat: "peak", param: "reverb.roomSize", in: [2, 9], out: [0.42, 0.88], curve: "lin", ramp: 0.8 },
  { stat: "peak", param: "reverb.wet", in: [2, 9], out: [0.22, 0.46], curve: "lin", ramp: 0.8 },
  // A shallow valley should already sound meaningfully darker. The old
  // 0..6 exponential mapping kept nearly all of the audible range until
  // the terrain was an unusually deep pit, which made the drone feel flat.
  { stat: "valleyDepth", param: "droneFilter.frequency", in: [0, 3.5], out: [3000, 420], curve: "log", ramp: 0.6 },
  // Roughness is seasoning, not a punishment. It leaves the noise bed
  // almost subliminal, then adds a small amount of ensemble width and
  // resonance instead of turning a quick sketch into abrasive hiss.
  { stat: "roughness", param: "noise.volume", in: [0, 0.65], out: [-60, -48], curve: "log", ramp: 0.45 },
  { stat: "roughness", param: "droneFilter.Q", in: [0, 0.65], out: [0.25, 0.85], curve: "lin", ramp: 0.5 },
  { stat: "waterFrac", param: "delay.feedback", in: [0, 0.7], out: [0.05, 0.34], curve: "lin", ramp: 1.0 },
  { stat: "waterFrac", param: "delay.wet", in: [0, 0.7], out: [0, 0.26], curve: "lin", ramp: 1.0 },
  { stat: "meanElev", param: "noiseFilter.frequency", in: [-2, 6], out: [400, 2400], curve: "exp", ramp: 0.9 },
];

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Shapes t (0..1, "how far across the input range are we") before it gets
// lerped into the output range. "exp" front-loads the low end of the
// input range onto a small slice of the output, so most of the output
// range only opens up once the stat is already fairly high — that reads
// as more natural for frequency/pitch-feeling params than a straight
// line. "log" is the mirror of that. Plain "lin" is a straight lerp.
function applyCurve(t: number, curve: Curve): number {
  switch (curve) {
    case "lin":
      return t;
    case "exp":
      return t * t;
    case "log":
      return Math.sqrt(t);
  }
}

function evaluate(mapping: Mapping, statValue: number): number {
  const [inLo, inHi] = mapping.in;
  const [outLo, outHi] = mapping.out;
  const t = clamp01((statValue - inLo) / (inHi - inLo));
  return outLo + applyCurve(t, mapping.curve) * (outHi - outLo);
}

// The minimal shape every resolved mapping target needs: something whose
// current value is readable, and that can be told to head toward a new
// value over time. Every Tone.js Signal/Param already looks like this
// (that's what makes the generic resolver below possible instead of a
// hand-written switch statement per mapping row); SoftRamp below exists
// to give the one param that *isn't* natively like this the same shape.
interface RampTarget {
  readonly value: number;
  rampTo(value: number, rampTime?: number): unknown;
}

// Not everything on the audio graph is a Tone Signal. FatOscillator's
// `spread` (droneOsc.spread in the table above) is a plain number
// property with no built-in automation — setting it directly would be
// the "bare .value =" the spec explicitly rules out (§8), since it'd
// snap instead of glide. SoftRamp gives it the same rampTo()-shaped
// interface as a real Signal, but does the interpolation itself: each
// call to `tick(dt)` nudges `value` a fraction of the way toward
// `target`, using the same exponential-approach shape Tone's own
// `setTargetAtTime` uses under the hood. mappingEngine.tick() (called
// from main.ts's render loop) is what actually advances it — unlike a
// real Signal, nothing here runs on the audio clock, so it has to be
// driven from somewhere that runs continuously.
class SoftRamp implements RampTarget {
  value: number;
  private target: number;
  private timeConstant = 0.4;

  constructor(private readonly write: (v: number) => void) {
    this.value = 0;
    this.target = 0;
  }

  seed(initial: number): void {
    this.value = initial;
    this.target = initial;
  }

  rampTo(value: number, rampTime = 0.4): unknown {
    this.target = value;
    this.timeConstant = Math.max(rampTime, 0.001);
    return this;
  }

  tick(dt: number): void {
    if (this.value === this.target || dt <= 0) return;
    const rate = 1 - Math.exp(-dt / this.timeConstant);
    this.value += (this.target - this.value) * rate;
    this.write(this.value);
  }
}

interface ResolvedMapping {
  mapping: Mapping;
  target: RampTarget;
  soft: SoftRamp | null; // present only for params that needed a SoftRamp
}

// Walks a "nodeName.paramName" path (e.g. "droneFilter.frequency") down
// the graph object to find the actual thing to ramp. This is what lets
// MAPPINGS stay pure data — a plain array of strings and numbers, safe to
// screenshot for the case study — instead of an array of functions.
function resolveMapping(graph: AudioGraph, mapping: Mapping): ResolvedMapping {
  const [nodeName, paramName] = mapping.param.split(".") as [string, string];
  const node = (graph as unknown as Record<string, unknown>)[nodeName];
  if (!node || typeof node !== "object") {
    throw new Error(`mappings.ts: no node "${nodeName}" on AudioGraph (from "${mapping.param}")`);
  }
  const raw = (node as Record<string, unknown>)[paramName];

  if (raw && typeof raw === "object" && "rampTo" in raw && "value" in raw) {
    return { mapping, target: raw as RampTarget, soft: null };
  }
  if (typeof raw === "number") {
    const soft = new SoftRamp((v) => {
      (node as Record<string, number>)[paramName] = v;
    });
    soft.seed(raw);
    return { mapping, target: soft, soft };
  }
  throw new Error(
    `mappings.ts: "${mapping.param}" isn't a rampable Signal or a plain number — can't map it`,
  );
}

export class MappingEngine {
  private readonly resolved: ResolvedMapping[];
  private readonly softRamps: SoftRamp[];

  constructor(graph: AudioGraph) {
    this.resolved = MAPPINGS.map((mapping) => resolveMapping(graph, mapping));
    this.softRamps = this.resolved.flatMap((r) => (r.soft ? [r.soft] : []));
  }

  /** Evaluate every mapping row against the current stats and ramp each
   * resolved target toward the result. Call this after computeStats() —
   * main.ts is the only intended caller. */
  apply(stats: TerrainStats): void {
    for (const { mapping, target } of this.resolved) {
      target.rampTo(evaluate(mapping, stats[mapping.stat]), mapping.ramp);
    }
  }

  /** Advances any SoftRamp-backed mappings by `dt` seconds. Real Tone
   * Signals ramp on the audio clock and don't need this — only called for
   * completeness from main.ts's render loop, and a no-op once there are
   * no SoftRamp mappings left. */
  tick(dt: number): void {
    for (const soft of this.softRamps) soft.tick(dt);
  }

  /** For the debug overlay (§13): every mapping's live current value next
   * to its parameter name, read directly off the resolved target. */
  readCurrentValues(): { stat: ScalarTerrainStat; param: string; value: number }[] {
    return this.resolved.map(({ mapping, target }) => ({
      stat: mapping.stat,
      param: mapping.param,
      value: target.value,
    }));
  }
}
