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

/** Human position of a tick inside a clip, e.g. "bar 2, beat 3". */
export function positionLabel(tick: number): string {
  const bar = Math.floor(tick / TICKS_PER_BAR) + 1;
  const beat = Math.floor((tick % TICKS_PER_BAR) / PPQ) + 1;
  return `bar ${bar}, beat ${beat}`;
}
