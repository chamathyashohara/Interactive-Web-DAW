/**
 * Built-in synth presets. The engine's synth is a generic saw + detuned-saw + sub-sine voice with an envelope and a
 * one-pole tone filter; a preset is just a set of those parameters, defined here once and sent to the engine per track.
 * "keys" reproduces the original synth sound exactly, so a track with no preset is unchanged.
 */
export interface SynthParams {
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
}

export interface SynthPreset {
  id: string;
  name: string;
  params: SynthParams;
}

export const SYNTH_PRESETS: readonly SynthPreset[] = [
  { id: "keys", name: "Keys", params: { attackSec: 0.004, releaseSec: 0.18, sawLevel: 0.7, osc2Level: 0, detuneCents: 0, subLevel: 0.3, toneHz: 20000, gain: 0.16 } },
  { id: "pad", name: "Pad", params: { attackSec: 0.45, releaseSec: 1.3, sawLevel: 0.5, osc2Level: 0.5, detuneCents: 12, subLevel: 0.3, toneHz: 2600, gain: 0.15 } },
  { id: "strings", name: "Strings", params: { attackSec: 0.18, releaseSec: 0.9, sawLevel: 0.55, osc2Level: 0.55, detuneCents: 9, subLevel: 0.15, toneHz: 5200, gain: 0.15 } },
  { id: "pluck", name: "Pluck", params: { attackSec: 0.002, releaseSec: 0.12, sawLevel: 0.7, osc2Level: 0, detuneCents: 0, subLevel: 0.2, toneHz: 9000, gain: 0.18 } },
  { id: "lead", name: "Lead", params: { attackSec: 0.006, releaseSec: 0.25, sawLevel: 0.8, osc2Level: 0.4, detuneCents: 6, subLevel: 0.15, toneHz: 12000, gain: 0.16 } },
  { id: "bass", name: "Bass", params: { attackSec: 0.004, releaseSec: 0.14, sawLevel: 0.5, osc2Level: 0, detuneCents: 0, subLevel: 0.6, toneHz: 1800, gain: 0.18 } },
] as const;

export const DEFAULT_SYNTH_PRESET = "keys";
export const isSynthPreset = (id: unknown): id is string => typeof id === "string" && SYNTH_PRESETS.some((p) => p.id === id);
/** The parameters for a preset id (the default "keys" sound when the id is missing or unknown). */
export const synthParamsFor = (id?: string): SynthParams => (SYNTH_PRESETS.find((p) => p.id === id) ?? SYNTH_PRESETS[0]!).params;
