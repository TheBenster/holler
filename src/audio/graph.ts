import * as Tone from "tone";

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

const DRONE_NOTE = "A1";
const DRONE_SPREAD_CENTS = 20; // §9 roughness → spread range is 8..45 cents
const DRONE_VOLUME_DB = -14; // raw sawtooth is loud; trim before it hits anything else

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
  readonly droneFilter: Tone.Filter;
  readonly noise: Tone.Noise;
  readonly noiseFilter: Tone.Filter;
  readonly reverb: Tone.Freeverb;
  readonly delay: Tone.FeedbackDelay;
  readonly limiter: Tone.Limiter;
  readonly masterGain: Tone.Gain;

  constructor() {
    // --- drone: droneOsc -> droneFilter -> (reverb send) ---
    this.droneOsc = new Tone.FatOscillator(DRONE_NOTE, "sawtooth", DRONE_SPREAD_CENTS);
    this.droneOsc.volume.value = DRONE_VOLUME_DB;
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
    this.droneOsc.chain(this.droneFilter, this.reverb);
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
    this.droneOsc.start();
    this.noise.start();
    this.masterGain.gain.rampTo(1, FADE_IN_SECONDS);
  }

  /** Ramp to silence (true) or back to full (false) — always a ramp, never
   * a bare assignment, so toggling mute mid-drone never clicks. */
  setMuted(muted: boolean): void {
    this.masterGain.gain.rampTo(muted ? 0 : 1, MUTE_RAMP_SECONDS);
  }

  dispose(): void {
    this.droneOsc.dispose();
    this.droneFilter.dispose();
    this.noise.dispose();
    this.noiseFilter.dispose();
    this.reverb.dispose();
    this.delay.dispose();
    this.limiter.dispose();
    this.masterGain.dispose();
  }
}
