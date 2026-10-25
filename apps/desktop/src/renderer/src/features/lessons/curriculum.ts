import { LESSONS, SUB_LESSONS } from "./content";
import { m3RootNote } from "./content/m3-root-note";
import type { Lesson, SubLesson } from "./types";

/**
 * The learning path: modules and their sub-lessons, from the course outline. A sub-lesson is **built** when its
 * content exists in `BUILT`; the others are shown as planned so the learner sees the whole path.
 */

export interface PathItem {
  id: string;
  title: string;
  optional?: boolean;
}
export interface PathModule {
  /** Internal id (m0-m5): part of every sub-lesson id, saved progress and study logs, so it never changes. */
  id: string;
  /** What the learner sees (L1-L6). */
  code: string;
  title: string;
  items: PathItem[];
}

const item = (module: string, slug: string, title: string, optional = false): PathItem => ({ id: `${module}-${slug}`, title, ...(optional ? { optional } : {}) });

export const MODULES: PathModule[] = [
  {
    id: "m0",
    code: "L1",
    title: "Meet the piano roll (training first)",
    items: [
      item("m0", "what-you-see", "What you see"),
      item("m0", "beats-bars", "Beats and bars"),
      item("m0", "play-loop-tempo", "Play, loop, tempo"),
      item("m0", "draw-delete", "Draw and delete"),
      item("m0", "move-resize", "Move and resize"),
      item("m0", "select-copy-undo", "Select, copy, undo"),
      item("m0", "mini-challenge", "Mini challenge (Twinkle Twinkle)"),
    ],
  },
  {
    id: "m1",
    code: "L2",
    title: "Notes",
    items: [
      item("m1", "high-low", "High and low"),
      item("m1", "note-names", "Note names A–G"),
      item("m1", "sharps-flats", "Sharps and flats"),
      item("m1", "octaves", "Octaves and middle C"),
      item("m1", "semitones", "Semitones and whole tones"),
      item("m1", "note-lengths", "Note lengths and beats"),
    ],
  },
  {
    id: "m2",
    code: "L3",
    title: "Scales and keys",
    items: [
      item("m2", "what-is-a-scale", "What a scale is"),
      item("m2", "major-pattern", "Major scale pattern"),
      item("m2", "major-any-note", "Major scale from any note"),
      item("m2", "degrees", "Degrees and the key"),
      item("m2", "natural-minor", "Natural minor"),
      item("m2", "in-key", "In key vs out of key"),
      item("m2", "pentatonic", "Pentatonic", true),
    ],
  },
  {
    id: "m3",
    code: "L4",
    title: "Chords",
    items: [
      item("m3", "what-is-a-chord", "What a chord is"),
      { id: m3RootNote.id, title: "The root note" },
      item("m3", "intervals", "Intervals"),
      item("m3", "major-triad", "Major triad"),
      item("m3", "minor-triad", "Minor triad"),
      item("m3", "chord-names", "Reading chord names"),
      item("m3", "chords-of-a-key", "Chords of a key"),
      item("m3", "inversions", "Inversions", true),
    ],
  },
  {
    id: "m4",
    code: "L5",
    title: "Chord progressions",
    items: [
      item("m4", "chords-in-time", "Chords in time"),
      item("m4", "home-tension", "Home and tension"),
      item("m4", "i-v-vi-iv", "I–V–vi–IV"),
      item("m4", "other-classics", "Other classics"),
      item("m4", "your-own", "Your own progression"),
      item("m4", "rhythm-bass", "Rhythm and a bass note"),
      { id: "M31.3", title: "Repeat and transpose the progression" },
      { id: "M31.4", title: "Layer the chords on pads" },
    ],
  },
  {
    id: "m5",
    code: "L6",
    title: "Melody",
    items: [
      item("m5", "from-a-scale", "Melody from a scale"),
      item("m5", "chord-tones", "Chord tones"),
      item("m5", "melody-rhythm", "Melody rhythm"),
      item("m5", "motif", "Motif and repetition"),
      item("m5", "project", "Project: melody over your progression"),
      { id: "M38.2", title: "Melody theory: phrase, cadence, call and response" },
      { id: "M38.3", title: "The four melody patterns" },
    ],
  },
  {
    id: "m6",
    code: "L7",
    title: "Bass and arp",
    items: [
      { id: "M35.1", title: "Bass from the root notes" },
      { id: "M35.2", title: "Chop the bass with the chopper" },
      { id: "M36.1", title: "Add an arp preset" },
    ],
  },
];

/** Sub-lessons with content, by id. */
export const BUILT: Record<string, SubLesson> = Object.fromEntries(SUB_LESSONS.map((s) => [s.id, s]));

export const isBuilt = (id: string) => id in BUILT;

/**
 * Piano path lessons that use the arrangement workspace (the song-making lessons, L5-L7). They live with the other
 * workspace lessons (studio/pianoExtras.ts) and open in the same Learn view; the path lists them by id.
 */
export const PIANO_STUDIO_IDS = ["M31.3", "M31.4", "M38.2", "M38.3", "M35.1", "M35.2", "M36.1"];
/** Can this path item be opened: a written sub-lesson or one of the workspace lessons? */
export const isReady = (id: string) => isBuilt(id) || PIANO_STUDIO_IDS.includes(id);

/** Lessons from before the module path existed. They stay available until they are folded into modules. */
export const EARLIER_LESSONS: Lesson[] = LESSONS;

export interface PathHit {
  kind: "sub" | "earlier";
  id: string;
  title: string;
  where: string;
  built: boolean;
}

/** Search across the whole path (built or planned) and the earlier lessons. Every word must match. */
export function searchPath(query: string): PathHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: PathHit[] = [];
  for (const m of MODULES) {
    for (const it of m.items) {
      const text = `${it.title} ${m.title} ${m.code}`.toLowerCase();
      if (words.every((w) => text.includes(w))) hits.push({ kind: "sub", id: it.id, title: it.title, where: `${m.code} ${m.title}`, built: isReady(it.id) });
    }
  }
  for (const l of EARLIER_LESSONS) {
    const text = [l.title, l.summary, ...l.recap].join(" ").toLowerCase();
    if (words.every((w) => text.includes(w))) hits.push({ kind: "earlier", id: l.id, title: l.title, where: "Earlier lessons", built: true });
  }
  return hits.sort((a, b) => Number(b.built) - Number(a.built));
}

export function moduleProgress(m: PathModule, isDone: (id: string) => boolean, ready: (id: string) => boolean = isReady) {
  const built = m.items.filter((i) => ready(i.id));
  return { built: built.length, done: built.filter((i) => isDone(i.id)).length, total: m.items.length };
}

/** The next sub-lesson after `id` in path order that has content, or null. */
export function nextBuilt(id: string): { id: string; title: string } | null {
  const flat = MODULES.flatMap((m) => m.items);
  const i = flat.findIndex((it) => it.id === id);
  return flat.slice(i + 1).find((it) => isReady(it.id)) ?? null;
}
