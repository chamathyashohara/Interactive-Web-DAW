/**
 * Built-in synth presets. The engine's synth has three voice models and a handful of parameters; a preset is a set of
 * them, defined here once and sent to the engine per track.
 *
 *  - model 0 "classic": subtractive (saw, detuned saw, sine, sub, tone filter, optional saturation).
 *  - model 1 "piano":   additive and struck: many partials that each decay at their own rate, string inharmonicity, a hammer click.
 *  - model 2 "strings": a bowed ensemble: detuned saws, delayed vibrato, bow noise and body resonances.
 *
 * "classic" reproduces the original synth sound exactly and is the default, so a track with no preset is unchanged.
 */
export interface SynthParams {
  /** 0 = classic, 1 = piano, 2 = strings. */
  model: number;
  /** Envelope attack and release, in seconds. */
  attackSec: number;
  releaseSec: number;
  /** Oscillator mix (0..1 each): main saw, a second saw detuned by `detuneCents`, and a sub sine an octave down. */
  sawLevel: number;
  osc2Level: number;
  detuneCents: number;
  subLevel: number;
  /** One-pole low-pass tone cutoff (Hz); 20000 is effectively open (bright). */
  toneHz: number;
  /** Base output gain before velocity. */
  gain: number;
  /** classic: a plain sine at the played pitch (the weight of a bass), and soft saturation (0 = off). */
  sineLevel: number;
  drive: number;
  /** piano: how long the lowest partial of a middle note rings, in seconds. */
  decaySec: number;
  /** strings: vibrato (rate Hz, depth cents, delay before it starts, seconds) and bow noise. */
  vibratoHz: number;
  vibratoCents: number;
  vibratoDelaySec: number;
  noiseLevel: number;
}

export interface SynthPreset {
  id: string;
  name: string;
  params: SynthParams;
}

/** All the fields at their "off" values, so a preset only lists what it uses. */
const base: SynthParams = {
  model: 0, attackSec: 0.004, releaseSec: 0.18, sawLevel: 0.7, osc2Level: 0, detuneCents: 0, subLevel: 0.3, toneHz: 20000, gain: 0.16,
  sineLevel: 0, drive: 0, decaySec: 5, vibratoHz: 0, vibratoCents: 0, vibratoDelaySec: 0, noiseLevel: 0,
};
const preset = (id: string, name: string, over: Partial<SynthParams>): SynthPreset => ({ id, name, params: { ...base, ...over } });

export const SYNTH_PRESETS: readonly SynthPreset[] = [
  // the original synth sound
  preset("classic", "Classic", {}),
  // a struck piano
  preset("keys", "Piano", { model: 1, attackSec: 0.002, releaseSec: 0.28, gain: 0.22, decaySec: 5 }),
  // a swelling analog pad
  preset("pad", "Pad", { attackSec: 0.45, releaseSec: 1.3, sawLevel: 0.5, osc2Level: 0.5, detuneCents: 12, subLevel: 0.3, toneHz: 2600, gain: 0.15 }),
  // a violin section: detuned bowed saws, delayed vibrato, bow noise, body resonance
  preset("strings", "Violin", { model: 2, attackSec: 0.14, releaseSec: 0.55, sawLevel: 0.5, osc2Level: 0.5, detuneCents: 8, toneHz: 7000, gain: 0.17, vibratoHz: 5.4, vibratoCents: 16, vibratoDelaySec: 0.25, noiseLevel: 0.05 }),
  // a short plucked note
  preset("pluck", "Pluck", { attackSec: 0.002, releaseSec: 0.12, sawLevel: 0.7, subLevel: 0.2, toneHz: 9000, gain: 0.18 }),
  // a bright lead
  preset("lead", "Lead", { attackSec: 0.006, releaseSec: 0.25, sawLevel: 0.8, osc2Level: 0.4, detuneCents: 6, subLevel: 0.15, toneHz: 12000, gain: 0.16 }),
  // a heavy bass: a full-strength fundamental and an equally strong sub-octave under a dark, quiet saw, with soft saturation so it speaks on small speakers
  preset("bass", "Bass", { attackSec: 0.004, releaseSec: 0.14, sawLevel: 0.18, sineLevel: 1.0, subLevel: 1.0, toneHz: 520, drive: 2.6, gain: 0.5 }),
] as const;

export const DEFAULT_SYNTH_PRESET = "classic";
export const isSynthPreset = (id: unknown): id is string => typeof id === "string" && SYNTH_PRESETS.some((p) => p.id === id);
/** The parameters for a preset id (the original "classic" sound when the id is missing or unknown). */
export const synthParamsFor = (id?: string): SynthParams => (SYNTH_PRESETS.find((p) => p.id === id) ?? SYNTH_PRESETS[0]!).params;
