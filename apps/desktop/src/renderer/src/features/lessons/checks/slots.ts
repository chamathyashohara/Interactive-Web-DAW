import type { Clip, Note } from "@daw/shared";
import { pitchLabel } from "../../../pianoRoll/geometry";
import { pitchClass, pitchClassOf, positionLabel } from "../theory";
import type { CheckResult, Slot } from "../types";

/** Does `note` satisfy every constraint that `slot` sets? */
export function fitsSlot(note: Note, slot: Slot): boolean {
  if (slot.pitchClasses && !slot.pitchClasses.some((name) => pitchClassOf(name) === pitchClass(note.pitch))) return false;
  if (slot.pitchMin !== undefined && note.pitch < slot.pitchMin) return false;
  if (slot.pitchMax !== undefined && note.pitch > slot.pitchMax) return false;
  if (slot.startMin !== undefined && note.startTick < slot.startMin) return false;
  if (slot.startMax !== undefined && note.startTick > slot.startMax) return false;
  if (slot.durationMin !== undefined && note.durationTicks < slot.durationMin) return false;
  if (slot.durationMax !== undefined && note.durationTicks > slot.durationMax) return false;
  return true;
}

/** Assigns each slot a different note when possible (augmenting paths, so an early choice cannot steal a later slot's only note). */
export function matchSlots(notes: Note[], slots: Slot[]): (Note | null)[] {
  const slotOf = new Map<Note, number>();
  const tryAssign = (si: number, seen: Set<Note>): boolean => {
    for (const n of notes) {
      if (seen.has(n) || !fitsSlot(n, slots[si]!)) continue;
      seen.add(n);
      const current = slotOf.get(n);
      if (current === undefined || tryAssign(current, seen)) {
        slotOf.set(n, si);
        return true;
      }
    }
    return false;
  };
  slots.forEach((_, si) => tryAssign(si, new Set()));
  const result: (Note | null)[] = slots.map(() => null);
  for (const [n, si] of slotOf) result[si] = n;
  return result;
}

/**
 * Every slot needs a different note that fits it. With `extra: "fail"`, a note that fills no slot is a mistake (so
 * "place exactly these notes" is checked). Score = filled slots / (slots + extra notes).
 */
export function checkSlots(clip: Clip, slots: Slot[], extra: "fail" | "allow"): CheckResult {
  const notes = Object.values(clip.notes)
    .filter((n) => !n.muted)
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  const matched = matchSlots(notes, slots);
  const used = new Set(matched.filter((n): n is Note => n !== null));
  const extras = extra === "fail" ? notes.filter((n) => !used.has(n)) : [];

  const items: CheckResult["items"] = slots.map((s, i) => ({ label: s.label, ok: matched[i] !== null }));
  if (extra === "fail") items.push({ label: "No extra notes", ok: extras.length === 0 });

  const missing = slots.find((_, i) => matched[i] === null);
  const stray = extras[0];
  const filled = matched.filter(Boolean).length;
  const pass = !missing && extras.length === 0;
  return {
    pass,
    score: slots.length + extras.length ? filled / (slots.length + extras.length) : 0,
    feedback: pass
      ? "Every note is in the right place."
      : missing
        ? `Not there yet: ${missing.label}.`
        : `The ${pitchLabel(stray!.pitch)} at ${positionLabel(stray!.startTick)} is an extra note. Delete it.`,
    items,
  };
}
