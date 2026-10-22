/**
 * Feature registry for the beginner-friendly DAW: which parts of the DAW are available, and which lesson unlocks them.
 * Progress is per user (not part of a project, never synced to collaborators).
 *
 * Lesson ids follow docs/lessons/CURRICULUM.md ("M2.6" = module 2, sub-lesson 6). The lessons only report
 * `completeLesson(id)`; everything about what that unlocks lives here.
 */

export type FeatureGroup = "Piano roll" | "Tracks" | "Arrangement" | "Mixing" | "Output";

export interface FeatureDef {
  id: string;
  label: string;
  group: FeatureGroup;
  /** Lesson that unlocks it; null = always available (the starter set). */
  unlockedBy: string | null;
}

export const FEATURES = [
  // starter set: enough to place and hear notes
  { id: "transport.basic", label: "Play, stop and tempo", group: "Piano roll", unlockedBy: null },
  { id: "tool.draw", label: "Draw tool", group: "Piano roll", unlockedBy: null },
  { id: "tool.delete", label: "Delete tool", group: "Piano roll", unlockedBy: null },
  { id: "history.undo", label: "Undo and redo", group: "Piano roll", unlockedBy: null },
  // piano roll
  { id: "tool.select", label: "Select, move and resize notes", group: "Piano roll", unlockedBy: "M0.4" },
  { id: "snap.grid", label: "Snap and grid size", group: "Piano roll", unlockedBy: "M0.4" },
  { id: "edit.clipboard", label: "Copy, paste and duplicate", group: "Piano roll", unlockedBy: "M0.5" },
  { id: "key.help", label: "Key and scale help (highlight and red notes)", group: "Piano roll", unlockedBy: "M2.6" },
  { id: "tool.paint", label: "Paint tool", group: "Piano roll", unlockedBy: "M6.4" },
  { id: "edit.quantize", label: "Quantize", group: "Piano roll", unlockedBy: "M6.4" },
  { id: "tool.mute", label: "Mute-note tool", group: "Piano roll", unlockedBy: "M7.4" },
  { id: "tool.slice", label: "Slice tool", group: "Piano roll", unlockedBy: "M8.4" },
  { id: "velocity.ramp", label: "Velocity ramp (fade notes in or out)", group: "Piano roll", unlockedBy: "M7.4" },
  // tracks
  { id: "tracks.multiple", label: "More than one track", group: "Tracks", unlockedBy: "M4.6" },
  { id: "tracks.drums", label: "Drum tracks", group: "Tracks", unlockedBy: "M6.2" },
  { id: "seq.steps", label: "Drum step sequencer", group: "Tracks", unlockedBy: "M6.2" },
  { id: "browser.samples", label: "Sample browser (Starter sounds, your own packs)", group: "Tracks", unlockedBy: "M6.2" },
  // arrangement
  { id: "arrangement.clips", label: "Edit clips and song length", group: "Arrangement", unlockedBy: "M8.2" },
  { id: "arrangement.loop", label: "Loop region", group: "Arrangement", unlockedBy: "M8.2" },
  { id: "arrangement.markers", label: "Section markers", group: "Arrangement", unlockedBy: "M13.1" },
  { id: "automation.lanes", label: "Automation: volume and filter curves", group: "Mixing", unlockedBy: "M13.3" },
  { id: "clips.audio", label: "Trim, fade and set the level of sound clips", group: "Arrangement", unlockedBy: "M13.3" },
  // mixing
  { id: "mixer.panel", label: "Mixer, volume and pan", group: "Mixing", unlockedBy: "M9.2" },
  { id: "mixer.muteSolo", label: "Mute and solo tracks", group: "Mixing", unlockedBy: "M9.4" },
  // output
  { id: "export.wav", label: "Export WAV", group: "Output", unlockedBy: "M10.3" },
] as const satisfies readonly FeatureDef[];

export type FeatureId = (typeof FEATURES)[number]["id"];

/** The registry with plain (non-literal) field types, convenient for lists in the UI. */
export const FEATURE_LIST: readonly (FeatureDef & { id: FeatureId })[] = FEATURES;

/** Titles shown in lock messages ("Unlocked by M6.4: Variations and off-beats"). Unknown lessons fall back to the id. */
export const LESSON_TITLES: Record<string, string> = {
  "M0.4": "Move and resize",
  "M0.5": "Select, copy, paste, undo",
  "M2.6": "In key or out of key",
  "M4.6": "Make chords move: rhythm and a bass note",
  "M6.2": "Meet the drum kit",
  "M6.4": "Variations and off-beats",
  "M7.4": "Velocity: soft and loud notes",
  "M8.2": "Clips: create and move",
  "M8.4": "Split a clip to make a variation",
  "M9.2": "Volume faders",
  "M9.4": "Mute and solo to hear one part",
  "M10.3": "Export a WAV",
  "M13.1": "Energy curve: how a song moves",
  "M13.3": "Buildup tension tools",
};

export type ProgressMode = "beginner" | "all";

export interface Progress {
  /** "beginner": locked features stay locked until their lesson is done. "all": everything is available. */
  mode: ProgressMode;
  completedLessons: string[];
}

export const defaultProgress = (): Progress => ({ mode: "all", completedLessons: [] });

const LESSON_ID = /^M\d{1,2}\.\d{1,2}$/;
export const isLessonId = (id: unknown): id is string => typeof id === "string" && LESSON_ID.test(id);

export function featureDef(id: FeatureId): FeatureDef {
  return FEATURES.find((f) => f.id === id)!;
}

export function isUnlocked(progress: Progress, id: FeatureId): boolean {
  if (progress.mode === "all") return true;
  const def = featureDef(id);
  return def.unlockedBy === null || progress.completedLessons.includes(def.unlockedBy);
}

/** Why a feature is locked, for a tooltip; null when it is available. */
export function lockReason(progress: Progress, id: FeatureId): string | null {
  if (isUnlocked(progress, id)) return null;
  const lesson = featureDef(id).unlockedBy!;
  return `Locked. Unlocked by lesson ${lesson}${LESSON_TITLES[lesson] ? `: ${LESSON_TITLES[lesson]}` : ""}.`;
}

/** Features that completing `lessonId` newly unlocks (for a "You unlocked ..." message). */
export function unlockedByLesson(lessonId: string): FeatureDef[] {
  return FEATURES.filter((f) => f.unlockedBy === lessonId);
}
