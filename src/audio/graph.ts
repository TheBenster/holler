import * as Tone from "tone";
import type { TerrainStats } from "../terrain/stats";

// Builds the §8 signal chain and holds every node the mapping engine (M3)
// will eventually ramp based on computeStats. For M2 the graph exists,
// makes sound, and is provably safe to listen to — every value below is a
// fixed "park" setting, not yet driven by the terrain. Nothing in this
// file touches the DOM or knows what a "gesture" is; main.ts's gesture
// gate is responsible for calling Tone.start() before any of this runs,
// and for calling start()/setMuted() in response to user input.
//
// park values are picked to sit inside (or near) each param's §9 mapping
// range, so flipping M3's mapping engine on later doesn't produce a jump —
// it just starts modulating around wherever the terrain naturally sits.

// Not part of the §9 mapping table — waveform is a discrete character
// choice, not something terrain shape drives, so it's a small deliberate
// exception to the graph's "everything is either fixed or terrain-driven"
// rule, the same way mute is. Cycled with `w` / an overlay button; see
// AudioGraph.cycleDroneType() below.
export type DroneWaveform = "sawtooth" | "sine" | "triangle" | "square";
const DRONE_WAVEFORMS: DroneWaveform[] = ["sawtooth", "sine", "triangle", "square"];

const PAD_SPREAD_CENTS = 14;
const PAD_VOICE_VOLUME_DB = -25;

// One open, consonant A-minor-7 voicing. The terrain raises or lowers its
// register in octaves, while the map's four quadrants mix these four tones.
const PAD_NOTES = ["A1", "E2", "G2", "C3"] as const;
const REGISTER_OFFSETS = [-12, 0, 12, 24] as const;

const DRONE_FILTER_FREQ = 1200; // §9 valleyDepth → frequency range is 160..3500 Hz
const DRONE_FILTER_ROLLOFF = -24; // §8: -24 dB/oct, fixed, not a mapped param

const NOISE_FILTER_FREQ = 900;
const NOISE_VOLUME_DB = -46; // §9 roughness → noise gain range is -60..-22 dB; quiet by default

const REVERB_ROOM_SIZE = 0.5; // §9 peak → roomSize range is 0.35..0.92
const REVERB_DAMPENING = 3000; // not in the v1 mapping table — fixed for now
const REVERB_WET = 0.3; // §9 peak → wet range is 0.15..0.55

const DELAY_TIME = 0.5; // §8: "~0.5, wet-controlled"
const DELAY_FEEDBACK = 0.15; // §9 waterFrac → feedback range is 0.05..0.55
const DELAY_WET = 0.1; // §9 waterFrac → wet range is 0..0.4

const LIMITER_THRESHOLD_DB = -1; // §8: mandatory safety ceiling, exact value given

const FADE_IN_SECONDS = 2; // §3: "fades audio in over ~2s" after the gesture
const MUTE_RAMP_SECONDS = 0.15; // long enough to not click, short enough to feel immediate

export class AudioGraph {
  readonly droneOsc: Tone.FatOscillator;
  readonly padVoices: readonly Tone.FatOscillator[];
  readonly padPanners: readonly Tone.Panner[];
  readonly droneFilter: Tone.Filter;
  readonly noise: Tone.Noise;
  readonly noiseFilter: Tone.Filter;
  readonly reverb: Tone.Freeverb;
  readonly delay: Tone.FeedbackDelay;
  readonly limiter: Tone.Limiter;
  readonly masterGain: Tone.Gain;
  private registerIndex = -1;

  constructor() {
    // --- terrain pad: four related oscillators -> droneFilter ---
    // `droneOsc` remains the first voice for the existing waveform UI;
    // together these voices are a chord pad rather than a single fixed A1.
      this.droneOsc = new Tone.FatOscillator(
      PAD_NOTES[0],
      DRONE_WAVEFORMS[0],
      PAD_SPREAD_CENTS,
    );
    this.padVoices = [
      this.droneOsc,
      ...PAD_NOTES.slice(1).map(
        (note) => new Tone.FatOscillator(note, DRONE_WAVEFORMS[0], PAD_SPREAD_CENTS),
      ),
    ];
    for (const voice of this.padVoices) voice.volume.value = PAD_VOICE_VOLUME_DB;
    this.padPanners = [-0.45, 0.45, -0.25, 0.25].map((pan) => new Tone.Panner(pan));
    this.droneFilter = new Tone.Filter(DRONE_FILTER_FREQ, "lowpass", DRONE_FILTER_ROLLOFF);

    // --- noise bed: noise -> noiseFilter -> (reverb send) ---
    this.noise = new Tone.Noise("pink");
    this.noise.volume.value = NOISE_VOLUME_DB; // this *is* §9's "roughness → noise gain" target
    this.noiseFilter = new Tone.Filter(NOISE_FILTER_FREQ, "bandpass");

    // --- shared tail: reverb -> delay -> limiter -> out ---
    this.reverb = new Tone.Freeverb(REVERB_ROOM_SIZE, REVERB_DAMPENING);
    // setting .value directly (not .rampTo) is fine here — this runs once
    // at construction, before any sound has played, so there's no prior
    // audio level for a jump to click against. the "always ramp" rule in
    // §8 is about changes made *while* the graph is live (that's M3's job).
    this.reverb.wet.value = REVERB_WET;

    this.delay = new Tone.FeedbackDelay(DELAY_TIME, DELAY_FEEDBACK);
    this.delay.wet.value = DELAY_WET;

    this.limiter = new Tone.Limiter(LIMITER_THRESHOLD_DB);

    // starts silent (0 gain) regardless of the park values above — nothing
    // should be audible until start() fades this in, even though the
    // oscillator/noise sources themselves are already running by then.
    // this is also what setMuted() ramps to reach a click-free mute.
    this.masterGain = new Tone.Gain(0);

    // Two independent source chains connect into the same node (`reverb`)
    // below — in Web Audio, multiple things connected to one input just
    // sum together, so this *is* the merge point in the §8 diagram, no
    // separate mixer node required.
    for (let i = 0; i < this.padVoices.length; i++) {
      this.padVoices[i]!.chain(this.padPanners[i]!, this.droneFilter);
    }
    this.droneFilter.connect(this.reverb);
    this.noise.chain(this.noiseFilter, this.reverb);
    this.reverb.chain(this.delay, this.limiter, this.masterGain);
    this.masterGain.toDestination();
  }

  /**
   * Starts the sound sources and fades the master gain in from silence.
   * Must only be called after `Tone.start()` has already resolved inside
   * a user-gesture handler (§3, §17) — that part is main.ts's gesture
   * gate's job, not this module's; this class doesn't touch `Tone.start`
   * at all, so it stays testable without a fake DOM event.
   */
  start(): void {
    for (const voice of this.padVoices) voice.start();
    this.noise.start();
    this.masterGain.gain.rampTo(1, FADE_IN_SECONDS);
  }

  /** Ramp to silence (true) or back to full (false) — always a ramp, never
   * a bare assignment, so toggling mute mid-drone never clicks. */
  setMuted(muted: boolean): void {
    this.masterGain.gain.rampTo(muted ? 0 : 1, MUTE_RAMP_SECONDS);
  }

  /**
   * Advances the drone to the next waveform in DRONE_WAVEFORMS and returns
   * it. Unlike every ramped param elsewhere in this file, there's no
   * "smooth" way to morph a sawtooth into a sine — waveform is categorical,
   * not continuous, so switching it is an audible, instant timbre change
   * by nature (real synths' waveform selectors work the same way). That's
   * expected here, not a violation of §8's "always ramp" rule — that rule
   * is about numeric params that *can* zipper, and this isn't one.
   */
  cyclePadVoiceType(index: number): DroneWaveform {
    const voice = this.padVoices[index];
    if (!voice) throw new Error(`No pad voice exists for quadrant ${index}`);
    const current = voice.type as DroneWaveform;
    const next = DRONE_WAVEFORMS[(DRONE_WAVEFORMS.indexOf(current) + 1) % DRONE_WAVEFORMS.length]!;
    voice.type = next;
    return next;
  }

  /** The waveform assigned to one terrain quadrant. */
  getPadVoiceType(index: number): DroneWaveform {
    const voice = this.padVoices[index];
    if (!voice) throw new Error(`No pad voice exists for quadrant ${index}`);
    return voice.type as DroneWaveform;
  }

  /**
   * Broad raised land moves the whole pad in octave-sized register steps.
   * Each quadrant controls the prominence of one chord tone, making the
   * visible distribution of land into a literal chord voicing.
   */
  updateTerrainHarmony(stats: TerrainStats): void {
    const nextRegister = stats.landMass < 0.45 ? 0 : stats.landMass < 1.1 ? 1 : stats.landMass < 2 ? 2 : 3;
    if (nextRegister !== this.registerIndex) {
      this.registerIndex = nextRegister;
      const offset = REGISTER_OFFSETS[nextRegister]!;
      for (let i = 0; i < this.padVoices.length; i++) {
        const frequency = Tone.Frequency(PAD_NOTES[i]!).transpose(offset).toFrequency();
        this.padVoices[i]!.frequency.rampTo(frequency, 1.2);
      }
    }

    for (let i = 0; i < this.padVoices.length; i++) {
      // The quiet floor preserves an ambient bed; building broad terrain in
      // a quadrant brings its chord tone forward without a hard on/off edge.
      const amount = Math.max(0, Math.min(1, stats.regionMass[i]! / 1.5));
      this.padVoices[i]!.volume.rampTo(-36 + amount * 13, 0.7);
    }
  }

  dispose(): void {
    for (const voice of this.padVoices) voice.dispose();
    for (const panner of this.padPanners) panner.dispose();
    this.droneFilter.dispose();
    this.noise.dispose();
    this.noiseFilter.dispose();
    this.reverb.dispose();
    this.delay.dispose();
    this.limiter.dispose();
    this.masterGain.dispose();
  }
}
