import { MAX_TRACKS, PPQ, TICKS_PER_BAR, createTrack, dropSampleOps, type Clip, type DroppedSample, type Note, type OpBody, type Project, type Track } from "@daw/shared";
import type { Setup, SongSetup } from "./types";

/**
 * The example song the build-up and drop lessons work on: three lesson tracks (drums, bass, chords) over 24 bars, in
 * 8-bar clips at bars 1, 9 and 17, so a section can be removed by deleting or muting one clip. Setting it up replaces
 * only these three tracks; the learner's own tracks are never changed.
 */
export const SONG = { drums: "lesson-song-drums", bass: "lesson-song-bass", chords: "lesson-song-chords" } as const;
export const SONG_BARS = 24;
const SECTION_BARS = 8;
export const KICK = 36;
export const SNARE = 38;
export const HAT = 42;

/** Tick where a bar starts (bars and beats count from 1). */
export const barTick = (bar: number, beat = 1) => (bar - 1) * TICKS_PER_BAR + (beat - 1) * PPQ;

type Hit = Omit<Note, "id">;

/** One bar of the basic beat: kick on 1 and 3, snare on 2 and 4, closed hat on every 8th. */
function beatBar(at: number): Hit[] {
  const hits: Hit[] = [];
  for (let e = 0; e < 8; e++) hits.push({ pitch: HAT, startTick: at + e * (PPQ / 2), durationTicks: PPQ / 4, velocity: 70 });
  for (const b of [0, 2]) hits.push({ pitch: KICK, startTick: at + b * PPQ, durationTicks: PPQ / 4, velocity: 110 });
  for (const b of [1, 3]) hits.push({ pitch: SNARE, startTick: at + b * PPQ, durationTicks: PPQ / 4, velocity: 100 });
  return hits;
}

/** A snare roll bar: `perBar` evenly spaced hits rising from `from` to `to` velocity, leaving out the last `restBeats`. */
function rollBar(at: number, perBar: number, from: number, to: number, restBeats = 0): Hit[] {
  const step = TICKS_PER_BAR / perBar;
  const end = TICKS_PER_BAR - restBeats * PPQ;
  const hits: Hit[] = [];
  for (let i = 0; i * step < end; i++) {
    const velocity = Math.round(from + ((to - from) * i) / Math.max(1, perBar - 1));
    hits.push({ pitch: SNARE, startTick: at + i * step, durationTicks: Math.min(step, PPQ / 4), velocity });
  }
  return hits;
}

const ROOTS = [36, 43, 45, 41]; // C, G, A, F (one octave below the chords)
const CHORDS = [
  [60, 64, 67],
  [55, 59, 62],
  [57, 60, 64],
  [53, 57, 60],
];

function clipOf(id: string, name: string, bar: number, hits: Hit[]): Clip {
  const notes: Record<string, Note> = {};
  hits.forEach((h, i) => (notes[`${id}-n${i}`] = { id: `${id}-n${i}`, ...h }));
  return { id, name, startTick: barTick(bar), lengthTicks: SECTION_BARS * TICKS_PER_BAR, notes };
}

const drumsClip = (bar: number, kind: "beat" | "roll" | "roll-pause") => {
  const hits: Hit[] = [];
  for (let b = 0; b < SECTION_BARS; b++) {
    const at = b * TICKS_PER_BAR;
    if (kind === "beat" || b < SECTION_BARS - 2) hits.push(...beatBar(at));
    // The last two bars of a build-up: 4 then 16 hits, getting louder. "roll" plays to the very end, "roll-pause" stops a beat early.
    else if (b === SECTION_BARS - 2) hits.push(...rollBar(at, 4, 70, 85));
    else hits.push(...rollBar(at, 16, 88, 124, kind === "roll-pause" ? 1 : 0));
  }
  return clipOf(`${SONG.drums}-bar${bar}`, kind === "beat" ? "Beat" : "Build-up", bar, hits);
};
const bassClip = (bar: number) =>
  clipOf(`${SONG.bass}-bar${bar}`, "Bass", bar, Array.from({ length: SECTION_BARS }, (_, b) => ({ pitch: ROOTS[b % 4]!, startTick: b * TICKS_PER_BAR, durationTicks: TICKS_PER_BAR - PPQ / 8, velocity: 100 })));
const chordsClip = (bar: number) =>
  clipOf(
    `${SONG.chords}-bar${bar}`,
    "Chords",
    bar,
    Array.from({ length: SECTION_BARS }, (_, b) => CHORDS[b % 4]!.map((pitch) => ({ pitch, startTick: b * TICKS_PER_BAR, durationTicks: TICKS_PER_BAR - PPQ / 16, velocity: 80 }))).flat(),
  );

/** Which clips each task starts with. */
function layout(setup: SongSetup): { drums: Clip[]; bass: Clip[]; chords: Clip[] } {
  const chords = [chordsClip(1), chordsClip(9), chordsClip(17)];
  switch (setup) {
    case "full":
    case "final":
      return { drums: [drumsClip(1, "beat"), drumsClip(9, "beat"), drumsClip(17, "beat")], bass: [bassClip(1), bassClip(9), bassClip(17)], chords };
    case "buildup":
      return { drums: [drumsClip(1, "beat"), drumsClip(17, "beat")], bass: [bassClip(1), bassClip(17)], chords };
    case "pause":
      return { drums: [drumsClip(1, "beat"), drumsClip(9, "roll"), drumsClip(17, "beat")], bass: [bassClip(1), bassClip(17)], chords };
    case "drop":
      return { drums: [drumsClip(1, "beat"), drumsClip(9, "roll-pause")], bass: [bassClip(1)], chords };
  }
}

function songTrack(id: string, name: string, instrument: "drums" | "synth", color: string, clips: Clip[]): Track {
  const t = createTrack(id, name, instrument, color, "unused");
  return { ...t, clips: Object.fromEntries(clips.map((c) => [c.id, c])) };
}

/** Ops (one undo step) that put the example song in the project for this task, replacing an earlier copy of it. */
export function songSetupOps(project: Project, setup: SongSetup): { ok: true; ops: OpBody[] } | { ok: false; reason: string } {
  const l = layout(setup);
  const tracks = [
    songTrack(SONG.drums, "Song: Drums", "drums", "#f472b6", l.drums),
    songTrack(SONG.bass, "Song: Bass", "synth", "#fb923c", l.bass),
    songTrack(SONG.chords, "Song: Chords", "synth", "#22d3ee", l.chords),
  ];
  const existing = tracks.filter((t) => project.tracks[t.id]).length;
  if (project.trackOrder.length - existing + tracks.length > MAX_TRACKS) return { ok: false, reason: `The example song needs ${tracks.length - existing} free tracks (a song can have at most ${MAX_TRACKS}). Delete a track and try again.` };
  const ops: OpBody[] = [];
  if (project.songBars < SONG_BARS) ops.push({ type: "setSongLength", bars: SONG_BARS });
  for (const t of tracks) {
    // Replace one track at a time, so the project never runs out of tracks in between.
    if (project.tracks[t.id]) ops.push({ type: "deleteTrack", trackId: t.id });
    ops.push({ type: "addTrack", track: t });
  }
  return { ok: true, ops };
}

export const hasSong = (project: Project) => Boolean(project.tracks[SONG.drums] && project.tracks[SONG.bass] && project.tracks[SONG.chords]);

const isWorkspaceTrack = (id: string) => id.startsWith("lesson-k-");
const MIN_BARS = 8;

/**
 * Ops (one undo step) that prepare a Try or Practice stage: the lesson's dropped sounds are cleared, then the example
 * song, a single 90 BPM loop (Fit off, song at 120 BPM) or nothing is put in. Only lesson tracks are touched.
 * `loop` is the library sound to use for "loop".
 */
export function stageSetupOps(project: Project, setup: Setup, newId: () => string, loop?: DroppedSample): { ok: true; ops: OpBody[] } | { ok: false; reason: string } {
  const song = setup !== "clear" && setup !== "loop";
  const remove = project.trackOrder.filter((id) => isWorkspaceTrack(id) || (!song && Object.values(SONG).includes(id as never)));
  // The project must keep at least one track: never delete the last one.
  const removable = remove.length >= project.trackOrder.length ? remove.slice(0, project.trackOrder.length - 1) : remove;
  const ops: OpBody[] = removable.map((trackId) => ({ type: "deleteTrack", trackId }));
  const after: Project = { ...project, trackOrder: project.trackOrder.filter((id) => !removable.includes(id)) };
  if (song) {
    const r = songSetupOps(after, setup);
    if (!r.ok) return r;
    return { ok: true, ops: [...ops, ...r.ops] };
  }
  if (project.songBars < MIN_BARS) ops.push({ type: "setSongLength", bars: MIN_BARS });
  if (setup === "loop") {
    if (!loop) return { ok: false, reason: "The sound library is still loading. Try again in a moment." };
    ops.push({ type: "setTempo", bpm: 120 });
    const r = dropSampleOps({ ...after, songBars: Math.max(after.songBars, MIN_BARS), tempo: 120 }, loop, 0, null, { trackId: `lesson-k-${newId()}`, clipId: newId(), noteId: newId() }, "#a78bfa");
    if (!r.ok) return r;
    for (const op of r.ops) if (op.type === "addTrack" && op.track.sample) op.track.sample.fit = false; // the learner turns Fit on
    ops.push(...r.ops);
  }
  return { ok: true, ops };
}
