import { PPQ, TICKS_PER_BAR } from "@daw/shared";
import { NOTE_NAMES } from "../../pianoRoll/geometry";

const FLATS: Record<string, string> = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#" };

/** 0..11 for any MIDI pitch. */
export const pitchClass = (pitch: number) => ((pitch % 12) + 12) % 12;

/** "C", "F#", "Bb" -> 0..11; null for anything else. */
export function pitchClassOf(name: string): number | null {
  const i = NOTE_NAMES.indexOf(FLATS[name] ?? name);
  return i < 0 ? null : i;
}

export const pitchClassName = (pc: number) => NOTE_NAMES[pitchClass(pc)]!;

/** "a, b and c" */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

/** The seven pitch classes of the major scale on `rootPc`. */
export const majorScale = (rootPc: number): Set<number> => new Set(MAJOR_STEPS.map((i) => (rootPc + i) % 12));

/** Names of the nearest in-scale pitch classes below and above `pc`, for "try F or G" style hints. */
export function inKeyNeighbours(pc: number, scale: Set<number>): [string, string] {
  let down = pitchClass(pc);
  let up = down;
  do down = (down + 11) % 12;
  while (!scale.has(down));
  do up = (up + 1) % 12;
  while (!scale.has(up));
  return [pitchClassName(down), pitchClassName(up)];
}

/** Where a tick falls in a bar, in beginner words: "beat 3", or `the "and" of beat 2` for an eighth-note offbeat. */
export function rhythmPosition(tick: number, withBar = false): string {
  const inBar = ((tick % TICKS_PER_BAR) + TICKS_PER_BAR) % TICKS_PER_BAR;
  const beat = Math.floor(inBar / PPQ) + 1;
  const rem = inBar % PPQ;
  const where = rem === 0 ? `beat ${beat}` : rem === PPQ / 2 ? `the "and" of beat ${beat}` : `beat ${beat} (+${rem} ticks)`;
  return withBar ? `bar ${Math.floor(tick / TICKS_PER_BAR) + 1}, ${where}` : where;
}

/** Human position of a tick inside a clip, e.g. "bar 2, beat 3". */
export function positionLabel(tick: number): string {
  const bar = Math.floor(tick / TICKS_PER_BAR) + 1;
  const beat = Math.floor((tick % TICKS_PER_BAR) / PPQ) + 1;
  return `bar ${bar}, beat ${beat}`;
}
