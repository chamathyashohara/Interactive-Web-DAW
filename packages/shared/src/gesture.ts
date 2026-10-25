import { MAX_BEND_POINTS, MAX_BEND_SEMITONES, type BendPoint } from "./model";
import { isInKey, type ProjectKey } from "./theory";

/**
 * Playing notes with a hand in front of the webcam, with help that fades as the learner improves. Pure logic only (no camera, no
 * browser): it turns hand landmarks into note events, decides how much the scale helps, and decides when that help should be reduced.
 * The camera and the hand-tracking model live in the app; this file is what is unit-tested and what the evaluation measures.
 */

// ------------------------------------------------------------------------------------------------ assistance levels

/**
 * How much the project's key helps:
 *   full  = only notes of the scale can be played (the hand snaps to the nearest scale note),
 *   soft  = the scale pulls the hand toward its notes, but other notes are possible with care,
 *   guide = nothing is changed; notes outside the scale are shown in red (as in the piano roll),
 *   free  = nothing is changed and nothing is shown.
 */
export type AssistLevel = "full" | "soft" | "guide" | "free";
export const ASSIST_LEVELS: readonly AssistLevel[] = ["full", "soft", "guide", "free"];
export const ASSIST_LABEL: Record<AssistLevel, string> = { full: "Full help", soft: "Soft help", guide: "Guide only", free: "No help" };
export const ASSIST_DESCRIPTION: Record<AssistLevel, string> = {
  full: "Only notes of the scale can be played: your hand snaps to the nearest one.",
  soft: "The scale pulls your hand toward its notes. Other notes are possible, but need care.",
  guide: "Nothing is changed. Notes outside the scale show in red.",
  free: "Nothing is changed and nothing is shown.",
};
/** How far (in semitones) a scale note pulls the hand toward itself at "soft". Under half a semitone, so a note between two scale notes can still be reached. */
export const SOFT_CAPTURE_SEMITONES = 0.35;

/** The pitch range the hand's height covers (MIDI note numbers). Hand up = high. */
export interface PitchRange { low: number; high: number }
export const DEFAULT_PITCH_RANGE: PitchRange = { low: 60, high: 84 }; // C4 to C6: two octaves
/** The part of the picture's height the hand can use; the rest (top and bottom edges) is where tracking is least reliable. */
export const ACTIVE_ZONE = { top: 0.12, bottom: 0.88 } as const;

/** Hand height in the picture (0 = top, 1 = bottom) to a continuous pitch. Clamped to the range. */
export function heightToPitch(y: number, range: PitchRange = DEFAULT_PITCH_RANGE): number {
  const t = (ACTIVE_ZONE.bottom - y) / (ACTIVE_ZONE.bottom - ACTIVE_ZONE.top); // 1 at the top of the zone, 0 at the bottom
  return range.low + Math.min(1, Math.max(0, t)) * (range.high - range.low);
}

/** The scale note nearest to a continuous pitch (the lower one on an exact tie). */
export function nearestScalePitch(pitch: number, key: ProjectKey): number {
  const centre = Math.round(pitch);
  let best = centre;
  let bestDistance = Infinity;
  for (let d = -7; d <= 7; d++) {
    const p = centre + d;
    if (!isInKey(p, key)) continue;
    const distance = Math.abs(p - pitch);
    if (distance < bestDistance - 1e-9) {
      best = p;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * How much of the way between two scale notes the pitch just rests on the notes, per level (the rest of the way it glides). At full
 * help the pitch sits on a scale note for the outer 30% either side and slides across the middle 40%; at soft help only 12% sticks.
 */
export const GLIDE_PLATEAU: Record<AssistLevel, number> = { full: 0.3, soft: 0.12, guide: 0, free: 0 };

/**
 * The pitch to sound while a held note follows the hand (pitch bend). With no key, or at guide and no help, it is exactly the hand's
 * pitch. With help, the pitch is drawn to the scale notes: it rests on a note and slides quickly to the next, so a glide between two
 * scale notes passes through the notes in between but never settles on them.
 */
export function glidePitch(pitch: number, key: ProjectKey | null, level: AssistLevel): number {
  const w = GLIDE_PLATEAU[level];
  if (key === null || w <= 0) return pitch;
  let lo = Math.floor(pitch);
  while (!isInKey(lo, key) && lo > pitch - 13) lo--;
  if (!isInKey(lo, key)) return pitch; // no scale note below within an octave (cannot happen for a real scale)
  if (pitch - lo < 1e-9) return lo;
  let hi = lo + 1;
  while (!isInKey(hi, key) && hi < lo + 13) hi++;
  const x = (pitch - lo) / (hi - lo);
  const s = x <= w ? 0 : x >= 1 - w ? 1 : (() => { const t = (x - w) / (1 - 2 * w); return t * t * (3 - 2 * t); })();
  return lo + (hi - lo) * s;
}

export interface AssistResult {
  /** The note that is played. */
  pitch: number;
  /** The note the hand was actually on, with no help (rounded). */
  rawPitch: number;
  /** Whether that unassisted note is in the key; null when the project has no key (nothing to measure against). */
  rawInKey: boolean | null;
  playedInKey: boolean | null;
  /** True when the help moved the note. */
  snapped: boolean;
}

/** Applies the assistance level to a continuous hand pitch. Without a key there is nothing to help with, whatever the level. */
export function assist(pitch: number, key: ProjectKey | null, level: AssistLevel): AssistResult {
  const rawPitch = Math.round(pitch);
  if (key === null) return { pitch: rawPitch, rawPitch, rawInKey: null, playedInKey: null, snapped: false };
  const rawInKey = isInKey(rawPitch, key);
  let played = rawPitch;
  if (level === "full") played = nearestScalePitch(pitch, key);
  else if (level === "soft") {
    const near = nearestScalePitch(pitch, key);
    if (Math.abs(near - pitch) <= SOFT_CAPTURE_SEMITONES) played = near;
  }
  return { pitch: played, rawPitch, rawInKey, playedInKey: isInKey(played, key), snapped: played !== rawPitch };
}

// ------------------------------------------------------------------------------------------------ reading a hand

export interface Landmark { x: number; y: number; z?: number }
/** One camera frame's hand: the 21 landmarks (MediaPipe order), x and y as fractions of the picture, plus when it was captured. */
export interface HandFrame { t: number; landmarks: readonly Landmark[] }

const dist = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);
export const LANDMARK = { wrist: 0, thumbTip: 4, indexMcp: 5, indexTip: 8, middleMcp: 9, ringMcp: 13, pinkyMcp: 17 } as const;

/** The middle of the palm. It hardly moves when the fingers pinch, so closing the hand does not change the pitch. */
export function palmCentre(l: readonly Landmark[]): Landmark {
  const ids: number[] = [LANDMARK.wrist, LANDMARK.indexMcp, LANDMARK.middleMcp, LANDMARK.ringMcp, LANDMARK.pinkyMcp];
  return { x: ids.reduce((s, i) => s + l[i]!.x, 0) / ids.length, y: ids.reduce((s, i) => s + l[i]!.y, 0) / ids.length };
}

/** Thumb-to-index distance divided by the hand's size, so it does not depend on how far the hand is from the camera. Small = pinched. */
export function pinchRatio(l: readonly Landmark[]): number {
  const size = dist(l[LANDMARK.wrist]!, l[LANDMARK.middleMcp]!);
  return size < 1e-6 ? Infinity : dist(l[LANDMARK.thumbTip]!, l[LANDMARK.indexTip]!) / size;
}
export const PINCH_DOWN = 0.28;
export const PINCH_UP = 0.45; // above PINCH_DOWN so a hovering value does not flicker

// ------------------------------------------------------------------------------------------------ notes from a hand

export type GestureNoteEvent =
  | { type: "on"; t: number; pitch: number; rawPitch: number; rawInKey: boolean | null; playedInKey: boolean | null; level: AssistLevel; snapped: boolean }
  /** While a note is held with glide on: how far (semitones) the pitch is from the note's own pitch right now. */
  | { type: "bend"; t: number; semis: number }
  | { type: "off"; t: number; pitch: number };

export interface GestureDisplay {
  hand: boolean;
  pinched: boolean;
  /** The continuous pitch under the hand (before any help) and what would be played now. */
  pitchFloat: number | null;
  result: AssistResult | null;
  /** The pitch bend of the held note, in semitones (null when nothing is held or glide is off). */
  bend: number | null;
}

export interface NoteMachineOptions {
  range?: PitchRange;
  key: () => ProjectKey | null;
  level: () => AssistLevel;
  /** When true, a held note follows the hand's height smoothly (pitch bend) instead of staying on its first pitch. */
  glide?: () => boolean;
}
/** A bend smaller than this change is not worth sending. */
export const BEND_STEP = 0.02;
export const SMOOTHING_MS = 70;      // the picture is jittery; this much smoothing of the height costs this much delay
export const HAND_LOST_MS = 180;     // a held note stops this long after the hand disappears

/**
 * Turns frames into notes. A pinch plays the note at the hand's height (taken from a moment before the pinch started) and holds it until
 * the fingers open or the hand is lost. Feed it every camera frame, including frames with no hand (null).
 */
export class GestureNoteMachine {
  private smoothed: number | null = null;
  private lastT: number | null = null;
  private history: number[] = [];
  private held: { pitch: number; g0: number; lastBend: number } | null = null;
  private pinched = false;
  private lastSeen = 0;
  private readonly range: PitchRange;

  constructor(private readonly opts: NoteMachineOptions) {
    this.range = opts.range ?? DEFAULT_PITCH_RANGE;
  }

  get holding(): boolean {
    return this.held !== null;
  }

  update(frame: HandFrame | null, now: number): { events: GestureNoteEvent[]; display: GestureDisplay } {
    const events: GestureNoteEvent[] = [];
    if (frame === null || frame.landmarks.length < 21) {
      if (this.held && now - this.lastSeen > HAND_LOST_MS) {
        events.push({ type: "off", t: now, pitch: this.held.pitch });
        this.held = null;
        this.pinched = false;
      }
      return { events, display: { hand: false, pinched: this.pinched, pitchFloat: this.smoothed, result: null, bend: this.held ? this.held.lastBend : null } };
    }

    this.lastSeen = now;
    const raw = heightToPitch(palmCentre(frame.landmarks).y, this.range);
    const dt = this.lastT === null ? SMOOTHING_MS : Math.max(1, frame.t - this.lastT);
    this.lastT = frame.t;
    const a = 1 - Math.exp(-dt / SMOOTHING_MS);
    this.smoothed = this.smoothed === null ? raw : this.smoothed + (raw - this.smoothed) * a;
    this.history.push(this.smoothed);
    if (this.history.length > 8) this.history.shift();

    const ratio = pinchRatio(frame.landmarks);
    const key = this.opts.key();
    const level = this.opts.level();
    const result = assist(this.smoothed, key, level);

    if (!this.pinched && ratio < PINCH_DOWN) {
      this.pinched = true;
      // the pitch from a few frames back: the hand was still while the fingers closed
      const earlier = this.history[Math.max(0, this.history.length - 4)]!;
      const at = assist(earlier, key, level);
      this.held = { pitch: at.pitch, g0: glidePitch(earlier, key, level), lastBend: 0 };
      events.push({ type: "on", t: now, pitch: at.pitch, rawPitch: at.rawPitch, rawInKey: at.rawInKey, playedInKey: at.playedInKey, level, snapped: at.snapped });
    } else if (this.pinched && ratio > PINCH_UP) {
      this.pinched = false;
      if (this.held) events.push({ type: "off", t: now, pitch: this.held.pitch });
      this.held = null;
    }
    // glide: the held note follows the hand, measured from where the note started
    if (this.held && this.opts.glide?.()) {
      const semis = Math.max(-MAX_BEND_SEMITONES, Math.min(MAX_BEND_SEMITONES, glidePitch(this.smoothed, key, level) - this.held.g0));
      if (Math.abs(semis - this.held.lastBend) >= BEND_STEP) {
        this.held.lastBend = semis;
        events.push({ type: "bend", t: now, semis });
      }
    }
    return { events, display: { hand: true, pinched: this.pinched, pitchFloat: this.smoothed, result, bend: this.held && this.opts.glide?.() ? this.held.lastBend : null } };
  }

  /** Stops a held note (the panel was closed, recording stopped...). */
  release(now: number): GestureNoteEvent[] {
    if (!this.held) return [];
    const e: GestureNoteEvent = { type: "off", t: now, pitch: this.held.pitch };
    this.held = null;
    this.pinched = false;
    return [e];
  }
}

// ------------------------------------------------------------------------------------------------ fading the help

export const ADAPT_WINDOW = 12;        // notes looked at
export const ADAPT_FADE_AT = 0.85;     // this share of the recent notes were in the key with no help: reduce the help
export const ADAPT_RESTORE_AT = 0.5;   // this share or less: give some help back
export interface LevelChange { from: AssistLevel; to: AssistLevel; rate: number; notes: number }

/**
 * Decides how much help to give. It judges the learner by whether the note their hand was on (with no help) was in the key, so full
 * help, which makes every played note correct, does not hide how they are doing. After each change it waits for a whole new window of
 * notes before changing again. Fixed mode (for a study condition) never changes the level.
 */
export class AssistController {
  private recent: boolean[] = [];
  private sinceChange = 0;

  constructor(public level: AssistLevel = "full", public auto = true) {}

  setLevel(level: AssistLevel, auto: boolean): void {
    this.level = level;
    this.auto = auto;
    this.recent = [];
    this.sinceChange = 0;
  }

  /** The share of the recent notes that were in the key without help (null before there are any). */
  get rate(): number | null {
    return this.recent.length === 0 ? null : this.recent.filter(Boolean).length / this.recent.length;
  }

  /** Reports one played note; returns the change if the level moved. `rawInKey` null (no key) is ignored. */
  record(rawInKey: boolean | null): LevelChange | null {
    if (rawInKey === null) return null;
    this.recent.push(rawInKey);
    if (this.recent.length > ADAPT_WINDOW) this.recent.shift();
    this.sinceChange++;
    if (!this.auto || this.recent.length < ADAPT_WINDOW || this.sinceChange < ADAPT_WINDOW) return null;
    const rate = this.rate!;
    const i = ASSIST_LEVELS.indexOf(this.level);
    let next = i;
    if (rate >= ADAPT_FADE_AT && i < ASSIST_LEVELS.length - 1) next = i + 1;
    else if (rate <= ADAPT_RESTORE_AT && i > 0) next = i - 1;
    if (next === i) return null;
    const change: LevelChange = { from: this.level, to: ASSIST_LEVELS[next]!, rate, notes: this.recent.length };
    this.level = change.to;
    this.recent = [];
    this.sinceChange = 0;
    return change;
  }
}

// ------------------------------------------------------------------------------------------------ the bend curve of a note

/** The bend (semitones) of a curve at `tick`: straight lines between points, the first value before it and the last value after it. */
export function bendAt(bend: readonly BendPoint[], tick: number): number {
  if (bend.length === 0) return 0;
  if (tick <= bend[0]!.tick) return bend[0]!.semis;
  const last = bend[bend.length - 1]!;
  if (tick >= last.tick) return last.semis;
  let i = 1;
  while (bend[i]!.tick < tick) i++;
  const a = bend[i - 1]!, b = bend[i]!;
  return a.semis + ((b.semis - a.semis) * (tick - a.tick)) / (b.tick - a.tick);
}

const roundSemis = (v: number) => Math.round(v * 100) / 100;

/** Ramer-Douglas-Peucker on the vertical distance only (time and pitch have different units): keeps the shape with far fewer points. */
function simplify(points: BendPoint[], epsilon: number): BendPoint[] {
  if (points.length < 3) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    const a = points[lo]!, b = points[hi]!;
    let worst = -1, at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i]!;
      const expected = a.semis + ((b.semis - a.semis) * (p.tick - a.tick)) / (b.tick - a.tick);
      const d = Math.abs(p.semis - expected);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > epsilon && at > 0) {
      keep[at] = true;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Moves a curve later (positive) or earlier by `deltaTicks`; what falls before the start is cut off, keeping the value the curve had there. */
export function shiftBend(bend: readonly BendPoint[], deltaTicks: number): BendPoint[] {
  const shifted = bend.map((p) => ({ tick: Math.round(p.tick + deltaTicks), semis: p.semis }));
  if (shifted[0]!.tick >= 0) return shifted;
  const atZero = bendAt(shifted, 0);
  return [{ tick: 0, semis: atZero }, ...shifted.filter((p) => p.tick > 0)];
}

/** The part of a note's curve that belongs to a piece of that note (from `from` to `to` ticks into it), re-timed to start at 0. */
export function sliceBend(bend: readonly BendPoint[] | undefined, from: number, to: number): BendPoint[] | undefined {
  if (!bend || bend.length === 0 || to <= from) return undefined;
  const inside = bend.filter((p) => p.tick > from && p.tick < to).map((p) => ({ tick: p.tick - from, semis: p.semis }));
  const out: BendPoint[] = [{ tick: 0, semis: roundSemis(bendAt(bend, from)) }, ...inside];
  const end = roundSemis(bendAt(bend, to));
  if (to - from > (out[out.length - 1]!.tick) && Math.abs(end - out[out.length - 1]!.semis) > 1e-6) out.push({ tick: to - from, semis: end });
  return out.length === 1 && Math.abs(out[0]!.semis) < 0.005 ? undefined : out;
}

/**
 * Collects the bend of a held note as it happens (time in ms since the note started) and turns it into the few points a note stores.
 * A bend that never moved noticeably gives nothing (the note stays plain).
 */
export class BendRecorder {
  private pts: { ms: number; semis: number }[] = [{ ms: 0, semis: 0 }];

  add(ms: number, semis: number): void {
    this.pts.push({ ms: Math.max(ms, this.pts[this.pts.length - 1]!.ms), semis });
  }

  /** The curve in ticks, or undefined when the pitch did not really move. `endMs` is when the note ended: the curve is closed there. */
  finish(endMs: number, tempo: number, ppq: number): BendPoint[] | undefined {
    const ticksPerMs = (tempo * ppq) / 60000;
    const all = [...this.pts, { ms: Math.max(endMs, this.pts[this.pts.length - 1]!.ms), semis: this.pts[this.pts.length - 1]!.semis }];
    const byTick = new Map<number, number>();
    for (const p of all) byTick.set(Math.round(p.ms * ticksPerMs), roundSemis(Math.max(-MAX_BEND_SEMITONES, Math.min(MAX_BEND_SEMITONES, p.semis))));
    let points: BendPoint[] = [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, semis]) => ({ tick, semis }));
    if (points.every((p) => Math.abs(p.semis) < 0.05)) return undefined;
    let epsilon = 0.05;
    points = simplify(points, epsilon);
    while (points.length > MAX_BEND_POINTS) points = simplify(points, (epsilon *= 1.6));
    return points;
  }
}

// ------------------------------------------------------------------------------------------------ recording into the song

/** Snaps a tick to a grid (the hand cannot be as exact in time as a mouse click). */
export const quantizeTick = (tick: number, grid: number): number => (grid <= 0 ? Math.round(tick) : Math.round(tick / grid) * grid);

/**
 * The playhead position estimated between two status updates wraps at the end of the loop (or the song) the way the real playhead does,
 * so a note played just before the loop point is not placed past the end of the clip.
 */
export function wrapPlayhead(tick: number, loop: { startTick: number; endTick: number } | undefined, songTicks: number): number {
  if (loop && loop.endTick > loop.startTick && tick >= loop.endTick) return loop.startTick + ((tick - loop.startTick) % (loop.endTick - loop.startTick));
  return songTicks > 0 && tick >= songTicks ? tick % songTicks : tick;
}

/** Where a note that was played at `startTick` and held for `heldMs` lands in the song. Never shorter than one grid step. */
export function placeNote(startTick: number, heldMs: number, tempo: number, ppq: number, grid: number): { startTick: number; durationTicks: number } {
  const ticksPerMs = (tempo * ppq) / 60000;
  const start = Math.max(0, quantizeTick(startTick, grid));
  const end = quantizeTick(startTick + heldMs * ticksPerMs, grid);
  return { startTick: start, durationTicks: Math.max(grid > 0 ? grid : 1, end - start) };
}
