import { isInKey, type OpBody, type Project } from "@daw/shared";

export type EventData = Record<string, string | number | boolean | null>;
export interface NamedEvent {
  t: string;
  data: EventData;
}

/** Remembers which out-of-key (red) notes the learner has placed and when, so the time to fix each one can be measured. */
export class RedNoteTracker {
  private readonly bad = new Map<string, number>();
  add(noteId: string, at: number) {
    this.bad.set(noteId, at);
  }
  take(noteId: string): number | undefined {
    const at = this.bad.get(noteId);
    this.bad.delete(noteId);
    return at;
  }
  has(noteId: string) {
    return this.bad.has(noteId);
  }
  clear() {
    this.bad.clear();
  }
}

/**
 * Turns edits into research events: what kind of edit, how big, and for notes only whether they were in the key.
 * Never the pitches, positions, names or any other content of the song. `before` is the project before the edit;
 * `viaFix` says the edit came from the Fix button (it moves red notes into the key).
 */
export function opEvents(before: Project, bodies: OpBody[], tracker: RedNoteTracker, now: number, viaFix = false): NamedEvent[] {
  const out: NamedEvent[] = [];
  const batch = bodies.length > 1;
  const counts = new Map<string, { n: number; extra: EventData }>();
  const count = (op: string, extra: EventData = {}) => {
    const key = op + JSON.stringify(extra);
    const c = counts.get(key) ?? { n: 0, extra: { op, ...extra } };
    c.n++;
    counts.set(key, c);
  };

  for (const b of bodies) {
    switch (b.type) {
      case "addNote": {
        const track = before.tracks[b.trackId];
        const kind = track?.instrument ?? "unknown";
        const judged = kind === "synth" && before.key !== null;
        const inKey = judged ? isInKey(b.note.pitch, before.key!) : null;
        out.push({ t: "note.added", data: { inKey, kind } });
        if (inKey === false) tracker.add(b.note.id, now);
        count("addNote");
        break;
      }
      case "updateNote": {
        if (b.changes.pitch !== undefined && tracker.has(b.noteId)) {
          const track = before.tracks[b.trackId];
          if (before.key && track?.instrument === "synth" && isInKey(b.changes.pitch, before.key)) {
            const at = tracker.take(b.noteId)!;
            out.push({ t: "note.corrected", data: { ms: now - at, via: viaFix ? "fix" : "manual" } });
          }
        }
        count("updateNote", { fields: Object.keys(b.changes).sort().join("+") });
        break;
      }
      case "deleteNote": {
        const at = tracker.take(b.noteId);
        if (at !== undefined) out.push({ t: "note.corrected", data: { ms: now - at, via: "removed" } });
        count("deleteNote");
        break;
      }
      case "addTrack":
        count("addTrack", { kind: b.track.instrument });
        break;
      case "updateTrack":
        count("updateTrack", { fields: Object.keys(b.changes).sort().join("+") });
        break;
      default:
        count(b.type);
    }
  }
  for (const { n, extra } of counts.values()) out.push({ t: "edit", data: { ...extra, n, batch } });
  return out;
}

/** The shape of the song at one moment (counts only). */
export function projectSummary(project: Project): EventData {
  let clips = 0, notes = 0, outOfKey = 0;
  for (const t of Object.values(project.tracks)) {
    for (const c of Object.values(t.clips)) {
      clips++;
      for (const n of Object.values(c.notes)) {
        notes++;
        if (project.key && t.instrument === "synth" && !n.muted && !isInKey(n.pitch, project.key)) outOfKey++;
      }
    }
  }
  return { tracks: project.trackOrder.length, clips, notes, bars: project.songBars, tempo: project.tempo, keyed: project.key !== null, outOfKey };
}
