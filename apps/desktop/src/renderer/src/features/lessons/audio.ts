import { PPQ, type Clip, type InstrumentKind } from "@daw/shared";

/**
 * A small self-contained preview so a lesson can be heard even when the JUCE engine is not running (it is not a
 * replacement for it: the DAW's own Play still goes through the engine). Plain Web Audio, no packages, no network.
 */

export interface PreviewEvent {
  /** Seconds from the start of the preview. */
  time: number;
  duration: number;
  pitch: number;
  /** 0..1 */
  gain: number;
}

/** Pure: the clip's unmuted notes as timed events at `tempo` BPM, in start order. */
export function clipEvents(clip: Clip, tempo: number): PreviewEvent[] {
  const secondsPerTick = 60 / tempo / PPQ;
  return Object.values(clip.notes)
    .filter((n) => !n.muted)
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch)
    .map((n) => ({ time: n.startTick * secondsPerTick, duration: n.durationTicks * secondsPerTick, pitch: n.pitch, gain: n.velocity / 127 }));
}

/** Pure: guide notes (a demonstration or a hint) as timed events. */
export function notesToEvents(notes: { pitch: number; startTick: number; durationTicks: number }[], tempo: number, velocity = 100): PreviewEvent[] {
  const secondsPerTick = 60 / tempo / PPQ;
  return notes.map((n) => ({ time: n.startTick * secondsPerTick, duration: n.durationTicks * secondsPerTick, pitch: n.pitch, gain: velocity / 127 }));
}

export const clipSeconds = (clip: Clip, tempo: number) => (clip.lengthTicks * 60) / tempo / PPQ;
export const pitchToHz = (pitch: number) => 440 * Math.pow(2, (pitch - 69) / 12);

export interface Preview {
  stop(): void;
  /** Called once when the preview ends by itself or is stopped. */
  onEnded(cb: () => void): void;
}

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function context(): AudioContext {
  ctx ??= new AudioContext();
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; // random is fine: this is only a preview
  }
  return ctx;
}

function pitched(c: AudioContext, out: AudioNode, e: PreviewEvent, at: number) {
  const osc = c.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = pitchToHz(e.pitch);
  const env = c.createGain();
  const peak = 0.22 * e.gain;
  const end = at + Math.max(0.05, e.duration);
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(peak, at + 0.008);
  env.gain.setValueAtTime(peak, end);
  env.gain.linearRampToValueAtTime(0, end + 0.08);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(end + 0.1);
}

function thump(c: AudioContext, out: AudioNode, at: number, gain: number, from: number, to: number, length: number) {
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  const env = c.createGain();
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.001, at + length);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

function burst(c: AudioContext, out: AudioNode, at: number, gain: number, length: number, filter: BiquadFilterType, freq: number) {
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  const env = c.createGain();
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.001, at + length);
  src.connect(f).connect(env).connect(out);
  src.start(at);
  src.stop(at + length + 0.02);
}

/** General-MIDI-style drum map, like the engine's kit: 35/36 kick, 37-40 snare/clap, 42/44 closed hat, 46 open hat, toms. */
function drum(c: AudioContext, out: AudioNode, e: PreviewEvent, at: number) {
  const g = e.gain;
  switch (e.pitch) {
    case 35:
    case 36:
      return thump(c, out, at, 0.9 * g, 150, 45, 0.18);
    case 37:
    case 38:
    case 40:
      burst(c, out, at, 0.5 * g, 0.16, "highpass", 1500);
      return thump(c, out, at, 0.35 * g, 220, 120, 0.08);
    case 39:
      return burst(c, out, at, 0.6 * g, 0.12, "bandpass", 1800);
    case 42:
    case 44:
      return burst(c, out, at, 0.28 * g, 0.045, "highpass", 7000);
    case 46:
      return burst(c, out, at, 0.28 * g, 0.25, "highpass", 7000);
    case 41:
    case 43:
    case 45:
    case 47:
      return thump(c, out, at, 0.6 * g, 200 + (e.pitch - 41) * 30, 90 + (e.pitch - 41) * 15, 0.22);
    default:
      return pitched(c, out, { ...e, duration: 0.08 }, at);
  }
}

/** Plays timed events once. Must be called from a user gesture (a click) so the browser allows audio. */
export function playEvents(events: PreviewEvent[], instrument: InstrumentKind, totalSeconds: number): Preview {
  const c = context();
  void c.resume();
  const master = c.createDynamicsCompressor(); // keeps three-note chords from clipping
  const level = c.createGain();
  level.gain.value = 0.9;
  master.connect(level).connect(c.destination);

  const start = c.currentTime + 0.06;
  for (const e of events) (instrument === "drums" ? drum : pitched)(c, master, e, start + e.time);

  let ended = false;
  const listeners: (() => void)[] = [];
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    for (const l of listeners) l();
  };
  const timer = setTimeout(() => {
    master.disconnect();
    finish();
  }, (totalSeconds + 0.5) * 1000);

  return {
    stop() {
      master.disconnect(); // cuts everything scheduled so far
      finish();
    },
    onEnded(cb) {
      if (ended) cb();
      else listeners.push(cb);
    },
  };
}

/** Plays the clip once from the start. */
export function playClip(clip: Clip, instrument: InstrumentKind, tempo: number): Preview {
  return playEvents(clipEvents(clip, tempo), instrument, clipSeconds(clip, tempo));
}
