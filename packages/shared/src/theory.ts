import { MAX_PITCH, MIN_PITCH } from "./model";

/** Pure music-theory helpers shared by the piano roll (key help), the lessons and the checkers. Pitch is a MIDI number (C4 = 60). */

export type KeyMode = "major" | "minor";
export interface ProjectKey {
  /** Pitch class of the root: C = 0, C# = 1 ... B = 11. */
  tonic: number;
  mode: KeyMode;
}

export const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11] as const;
export const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10] as const; // natural minor

const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
/** Keys conventionally written with flats (their scale is spelled with flats). */
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1]); // F, B♭, E♭, A♭, D♭
const FLAT_MINOR_TONICS = new Set([2, 7, 0, 5, 10, 3]); // D, G, C, F, B♭, E♭

export const pitchClass = (pitch: number): number => ((pitch % 12) + 12) % 12;
export const octaveOf = (pitch: number): number => Math.floor(pitch / 12) - 1;

export function isValidKey(key: unknown): key is ProjectKey {
  const k = key as ProjectKey | null;
  return !!k && Number.isInteger(k.tonic) && k.tonic >= 0 && k.tonic <= 11 && (k.mode === "major" || k.mode === "minor");
}

export const usesFlats = (key: ProjectKey | null): boolean =>
  !!key && (key.mode === "major" ? FLAT_MAJOR_TONICS.has(key.tonic) : FLAT_MINOR_TONICS.has(key.tonic));

/** Note name without octave, spelled to suit the key: "F♯" in G major, "G♭" in D♭ major. */
export function noteName(pitch: number, key: ProjectKey | null = null): string {
  return (usesFlats(key) ? FLAT_NAMES : SHARP_NAMES)[pitchClass(pitch)]!;
}

/** "C major", "E♭ major", "A minor". */
export function keyLabel(key: ProjectKey): string {
  return `${noteName(key.tonic, key)} ${key.mode}`;
}

/** The 7 pitch classes of the key's scale, starting at the tonic. */
export function scalePitchClasses(key: ProjectKey): number[] {
  return (key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS).map((s) => (key.tonic + s) % 12);
}

export function isInKey(pitch: number, key: ProjectKey | null): boolean {
  return key === null || scalePitchClasses(key).includes(pitchClass(pitch));
}

export const isTonic = (pitch: number, key: ProjectKey | null): boolean => key !== null && pitchClass(pitch) === key.tonic;

/** Nearest in-key pitch (the pitch itself if it is already in key). On a tie the lower pitch wins. Stays inside 0-127. */
export function nearestInKey(pitch: number, key: ProjectKey): number {
  for (let d = 0; d <= 6; d++) {
    for (const candidate of [pitch - d, pitch + d]) {
      if (candidate >= MIN_PITCH && candidate <= MAX_PITCH && isInKey(candidate, key)) return candidate;
    }
  }
  return pitch;
}

/** The closest in-key pitch below and above (for hints). Either may be null at the edges of the range. */
export function neighboursInKey(pitch: number, key: ProjectKey): { below: number | null; above: number | null } {
  let below: number | null = null;
  let above: number | null = null;
  for (let p = pitch - 1; p >= MIN_PITCH && p >= pitch - 12; p--) if (isInKey(p, key)) { below = p; break; }
  for (let p = pitch + 1; p <= MAX_PITCH && p <= pitch + 12; p++) if (isInKey(p, key)) { above = p; break; }
  return { below, above };
}

/** Plain-English reason shown to the learner: "F♯ is not in G minor. Try F or G." */
export function outOfKeyMessage(pitch: number, key: ProjectKey): string {
  const { below, above } = neighboursInKey(pitch, key);
  const tries = [below, above].filter((p): p is number => p !== null).map((p) => noteName(p, key));
  return `${noteName(pitch, key)} is not in ${keyLabel(key)}.${tries.length ? ` Try ${tries.join(" or ")}.` : ""}`;
}

/** All 24 selectable keys in a sensible order (C major, C minor, C♯ major, ...). */
export const ALL_KEYS: ProjectKey[] = Array.from({ length: 12 }, (_, tonic) => [{ tonic, mode: "major" as const }, { tonic, mode: "minor" as const }]).flat();
