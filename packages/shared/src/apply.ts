import {
  ALL_INSTRUMENTS,
  AUTO_PARAMS,
  MAX_AUTO_POINTS,
  MAX_BPM,
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  MAX_PITCH,
  MAX_SONG_BARS,
  MAX_TRACKS,
  MIN_BPM,
  MIN_CLIP_TICKS,
  MIN_PITCH,
  RECENT_OPS_LIMIT,
  TICKS_PER_BAR,
  songTicks,
  type AutoPoint,
  type Clip,
  type ClipAudio,
  type Note,
  type Project,
  type Track,
} from "./model";
import type { ClipFields, Op, OpBody, TrackFields } from "./ops";
import { isValidKey } from "./theory";

export type ApplyResult =
  | { ok: true; project: Project; applied: boolean }
  | { ok: false; reason: string };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateNote(clip: Clip, n: Note): string | null {
  if (!isInt(n.pitch) || n.pitch < MIN_PITCH || n.pitch > MAX_PITCH) return "pitch out of range";
  if (!isInt(n.velocity) || n.velocity < 1 || n.velocity > 127) return "velocity out of range";
  if (!isInt(n.startTick) || n.startTick < 0) return "startTick must be a non-negative integer";
  if (!isInt(n.durationTicks) || n.durationTicks < 1) return "durationTicks must be a positive integer";
  if (n.startTick + n.durationTicks > clip.lengthTicks) return "note exceeds clip length";
  if (n.muted !== undefined && typeof n.muted !== "boolean") return "muted must be boolean";
  return null;
}

/** The furthest note end inside a clip (0 when empty): the clip may not be made shorter than this. */
export function clipContentEnd(clip: Clip): number {
  let end = 0;
  for (const n of Object.values(clip.notes)) end = Math.max(end, n.startTick + n.durationTicks);
  return end;
}

function audioError(audio: ClipAudio, lengthTicks: number): string | null {
  const { gainDb, fadeInTicks, fadeOutTicks, startSec, cut } = audio;
  if (gainDb !== undefined && (typeof gainDb !== "number" || !Number.isFinite(gainDb) || gainDb < MIN_GAIN_DB || gainDb > MAX_GAIN_DB)) return `gain must be ${MIN_GAIN_DB} to ${MAX_GAIN_DB} dB`;
  if (fadeInTicks !== undefined && (!isInt(fadeInTicks) || fadeInTicks < 0)) return "fade in must be a non-negative whole number of ticks";
  if (fadeOutTicks !== undefined && (!isInt(fadeOutTicks) || fadeOutTicks < 0)) return "fade out must be a non-negative whole number of ticks";
  if ((fadeInTicks ?? 0) + (fadeOutTicks ?? 0) > lengthTicks) return "the fades are longer than the clip";
  if (startSec !== undefined && (typeof startSec !== "number" || !Number.isFinite(startSec) || startSec < 0 || startSec > 3600)) return "start point must be 0 to 3600 seconds";
  if (cut !== undefined && typeof cut !== "boolean") return "cut must be boolean";
  return null;
}

/** An audio setting that says nothing (all defaults) is removed, so projects stay small and equal settings compare equal. */
function cleanAudio(audio: ClipAudio | null | undefined): ClipAudio | undefined {
  if (!audio) return undefined;
  const out: ClipAudio = {};
  if (audio.gainDb) out.gainDb = audio.gainDb;
  if (audio.fadeInTicks) out.fadeInTicks = audio.fadeInTicks;
  if (audio.fadeOutTicks) out.fadeOutTicks = audio.fadeOutTicks;
  if (audio.startSec) out.startSec = audio.startSec;
  if (audio.cut) out.cut = true;
  return Object.keys(out).length ? out : undefined;
}

/** Checks a clip's own shape and its place among its track's other clips. */
function clipError(clips: Record<string, Clip>, clip: Clip, songLen: number, sampleTrack = false): string | null {
  if (!clip.id || typeof clip.id !== "string") return "clip id required";
  if (clip.name !== undefined && (typeof clip.name !== "string" || clip.name.length < 1 || clip.name.length > 40)) return "clip name must be 1-40 characters";
  if (!isInt(clip.startTick) || clip.startTick < 0) return "clip start must be a non-negative integer";
  if (!isInt(clip.lengthTicks) || clip.lengthTicks < MIN_CLIP_TICKS) return "clip must be at least one beat long";
  if (clip.startTick + clip.lengthTicks > songLen) return "clip extends past the end of the song";
  if (clipContentEnd(clip) > clip.lengthTicks) return "clip is shorter than its notes";
  if (clip.audio !== undefined) {
    if (!sampleTrack) return "only clips on sample tracks have audio settings";
    const err = audioError(clip.audio, clip.lengthTicks);
    if (err) return err;
  }
  for (const other of Object.values(clips)) {
    if (other.id === clip.id) continue;
    if (clip.startTick < other.startTick + other.lengthTicks && other.startTick < clip.startTick + clip.lengthTicks) return "clips on a track cannot overlap";
  }
  for (const n of Object.values(clip.notes)) {
    const err = validateNote(clip, n);
    if (err) return err;
  }
  return null;
}

/** Points must be in time order (strictly), inside the song, with values from 0 to 1. */
function autoError(points: AutoPoint[], songLen: number): string | null {
  if (!Array.isArray(points) || points.length > MAX_AUTO_POINTS) return `an automation curve has at most ${MAX_AUTO_POINTS} points`;
  let prev = -1;
  for (const p of points) {
    if (!p || !isInt(p.tick) || p.tick < 0 || p.tick > songLen) return "automation points must lie inside the song";
    if (typeof p.value !== "number" || !Number.isFinite(p.value) || p.value < 0 || p.value > 1) return "automation values must be 0 to 1";
    if (p.tick <= prev) return "automation points must be in time order, one per moment";
    prev = p.tick;
  }
  return null;
}

function validateTrackFields(t: Partial<TrackFields>): string | null {
  if (t.name !== undefined && (typeof t.name !== "string" || t.name.trim().length < 1 || t.name.length > 40)) return "track name must be 1-40 characters";
  if (t.color !== undefined && (typeof t.color !== "string" || !COLOR_RE.test(t.color))) return "color must be #rrggbb";
  if (t.volume !== undefined && (!isInt(t.volume) || t.volume < 0 || t.volume > 100)) return "volume must be an integer 0-100";
  if (t.pan !== undefined && (!isInt(t.pan) || t.pan < -100 || t.pan > 100)) return "pan must be an integer -100..100";
  if (t.mute !== undefined && typeof t.mute !== "boolean") return "mute must be boolean";
  if (t.solo !== undefined && typeof t.solo !== "boolean") return "solo must be boolean";
  return null;
}

function validateTrack(t: Track, songLen: number): string | null {
  if (!t.id || typeof t.id !== "string") return "track id required";
  if (!ALL_INSTRUMENTS.includes(t.instrument)) return "unknown instrument";
  if (t.instrument === "sample") {
    if (!t.sample || typeof t.sample.id !== "string" || t.sample.id.length < 1 || t.sample.id.length > 200) return "a sample track needs a sample";
    if (typeof t.sample.name !== "string" || typeof t.sample.gate !== "boolean") return "invalid sample reference";
  } else if (t.sample !== undefined) return "only sample tracks have a sample";
  const fieldErr = validateTrackFields(t);
  if (fieldErr) return fieldErr;
  if (t.name === undefined || t.color === undefined || t.volume === undefined || t.pan === undefined || t.mute === undefined || t.solo === undefined) {
    return "track is missing fields";
  }
  for (const [param, pts] of Object.entries(t.automation ?? {})) {
    if (!AUTO_PARAMS.includes(param as never)) return "unknown automation parameter";
    const err = autoError(pts as AutoPoint[], songLen);
    if (err) return err;
  }
  const placed: Record<string, Clip> = {};
  for (const clip of Object.values(t.clips ?? {})) {
    const err = clipError(placed, clip, songLen, t.instrument === "sample");
    if (err) return err;
    placed[clip.id] = clip;
  }
  return null;
}

function withTrack(project: Project, trackId: string, track: Track): Project {
  return { ...project, tracks: { ...project.tracks, [trackId]: track } };
}

function withClip(project: Project, trackId: string, clipId: string, clip: Clip): Project {
  const track = project.tracks[trackId]!;
  return withTrack(project, trackId, { ...track, clips: { ...track.clips, [clipId]: clip } });
}

function remember(project: Project, opId: string): Project {
  const recentOps = [...project.recentOps, opId];
  if (recentOps.length > RECENT_OPS_LIMIT) recentOps.splice(0, recentOps.length - RECENT_OPS_LIMIT);
  return { ...project, recentOps };
}

const done = (project: Project, opId: string): ApplyResult => ({ ok: true, applied: true, project: remember(project, opId) });

/** End of the last clip on any track (0 when there are none). */
export function lastClipEnd(project: Project): number {
  let end = 0;
  for (const t of Object.values(project.tracks)) for (const c of Object.values(t.clips)) end = Math.max(end, c.startTick + c.lengthTicks);
  return end;
}

/**
 * Pure, deterministic reducer shared by the desktop client and (later) the collaboration server.
 * Re-applying an already applied opId is a no-op (`applied: false`).
 */
export function applyOp(project: Project, op: Op): ApplyResult {
  if (!op.opId || !op.clientId) return { ok: false, reason: "missing opId/clientId" };
  if (project.recentOps.includes(op.opId)) return { ok: true, project, applied: false };

  switch (op.type) {
    case "setTempo": {
      if (typeof op.bpm !== "number" || !Number.isFinite(op.bpm) || op.bpm < MIN_BPM || op.bpm > MAX_BPM) {
        return { ok: false, reason: "tempo out of range" };
      }
      return done({ ...project, tempo: op.bpm }, op.opId);
    }
    case "setKey": {
      if (op.key !== null && !isValidKey(op.key)) return { ok: false, reason: "key must be a tonic 0-11 and major or minor" };
      return done({ ...project, key: op.key === null ? null : { tonic: op.key.tonic, mode: op.key.mode } }, op.opId);
    }
    case "setMasterVolume": {
      if (!isInt(op.volume) || op.volume < 0 || op.volume > 100) return { ok: false, reason: "volume must be an integer 0-100" };
      return done({ ...project, masterVolume: op.volume }, op.opId);
    }
    case "setSongLength": {
      if (!isInt(op.bars) || op.bars < 1 || op.bars > MAX_SONG_BARS) return { ok: false, reason: `song length must be 1-${MAX_SONG_BARS} bars` };
      if (op.bars * TICKS_PER_BAR < lastClipEnd(project)) return { ok: false, reason: "song would end before the last clip" };
      return done({ ...project, songBars: op.bars }, op.opId);
    }
    case "addTrack": {
      if (project.tracks[op.track.id]) return { ok: false, reason: "track id already exists" };
      if (project.trackOrder.length >= MAX_TRACKS) return { ok: false, reason: `at most ${MAX_TRACKS} tracks` };
      const err = validateTrack(op.track, songTicks(project));
      if (err) return { ok: false, reason: err };
      const order = [...project.trackOrder];
      const index = op.index === undefined ? order.length : Math.max(0, Math.min(order.length, op.index));
      order.splice(index, 0, op.track.id);
      return done({ ...project, tracks: { ...project.tracks, [op.track.id]: clone(op.track) }, trackOrder: order }, op.opId);
    }
    case "deleteTrack": {
      if (!project.tracks[op.trackId]) return { ok: false, reason: "unknown track" };
      if (project.trackOrder.length <= 1) return { ok: false, reason: "cannot delete the last track" };
      const { [op.trackId]: _removed, ...rest } = project.tracks;
      return done({ ...project, tracks: rest, trackOrder: project.trackOrder.filter((id) => id !== op.trackId) }, op.opId);
    }
    case "updateTrack": {
      const track = project.tracks[op.trackId];
      if (!track) return { ok: false, reason: "unknown track" };
      const err = validateTrackFields(op.changes);
      if (err) return { ok: false, reason: err };
      return done(withTrack(project, op.trackId, { ...track, ...op.changes }), op.opId);
    }
    case "updateSample": {
      const track = project.tracks[op.trackId];
      if (!track || track.instrument !== "sample" || !track.sample) return { ok: false, reason: "not a sample track" };
      const { bpm, fit } = op.changes;
      if (bpm !== undefined && bpm !== null && (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM)) return { ok: false, reason: "original tempo out of range" };
      if (fit !== undefined && typeof fit !== "boolean") return { ok: false, reason: "fit must be boolean" };
      const sample = { ...track.sample };
      if (bpm === null) delete sample.bpm;
      else if (bpm !== undefined) sample.bpm = bpm;
      if (fit !== undefined) sample.fit = fit;
      return done(withTrack(project, op.trackId, { ...track, sample }), op.opId);
    }
    case "setAutomation": {
      const track = project.tracks[op.trackId];
      if (!track) return { ok: false, reason: "unknown track" };
      if (!AUTO_PARAMS.includes(op.param)) return { ok: false, reason: "unknown automation parameter" };
      if (op.points !== null) {
        const err = autoError(op.points, songTicks(project));
        if (err) return { ok: false, reason: err };
      }
      const automation = { ...track.automation };
      if (op.points === null || op.points.length === 0) delete automation[op.param];
      else automation[op.param] = op.points.map((p) => ({ tick: p.tick, value: p.value }));
      const next: Track = { ...track, automation };
      if (Object.keys(automation).length === 0) delete next.automation;
      return done(withTrack(project, op.trackId, next), op.opId);
    }
    case "addClip": {
      const track = project.tracks[op.trackId];
      if (!track) return { ok: false, reason: "unknown track" };
      if (track.clips[op.clip.id]) return { ok: false, reason: "clip id already exists" };
      const err = clipError(track.clips, op.clip, songTicks(project), track.instrument === "sample");
      if (err) return { ok: false, reason: err };
      return done(withClip(project, op.trackId, op.clip.id, clone(op.clip)), op.opId);
    }
    case "deleteClip": {
      const track = project.tracks[op.trackId];
      if (!track?.clips[op.clipId]) return { ok: false, reason: "unknown track or clip" };
      const { [op.clipId]: _removed, ...rest } = track.clips;
      return done(withTrack(project, op.trackId, { ...track, clips: rest }), op.opId);
    }
    case "updateClip": {
      const clip = project.tracks[op.trackId]?.clips[op.clipId];
      if (!clip) return { ok: false, reason: "unknown track or clip" };
      const { audio: audioChange, ...rest } = op.changes;
      const updated: Clip = { ...clip, ...rest };
      if (audioChange !== undefined) {
        const cleaned = cleanAudio(audioChange);
        if (cleaned) updated.audio = cleaned;
        else delete updated.audio;
      }
      const err = clipError(project.tracks[op.trackId]!.clips, updated, songTicks(project), project.tracks[op.trackId]!.instrument === "sample");
      if (err) return { ok: false, reason: err };
      return done(withClip(project, op.trackId, op.clipId, updated), op.opId);
    }
    case "addNote":
    case "deleteNote":
    case "updateNote": {
      const clip = project.tracks[op.trackId]?.clips[op.clipId];
      if (!clip) return { ok: false, reason: "unknown track or clip" };

      if (op.type === "addNote") {
        if (clip.notes[op.note.id]) return { ok: false, reason: "note id already exists" };
        const err = validateNote(clip, op.note);
        if (err) return { ok: false, reason: err };
        const added: Note = { ...op.note };
        if (added.muted === false) delete added.muted; // canonical form: absent means not muted
        const next = { ...clip, notes: { ...clip.notes, [op.note.id]: added } };
        return done(withClip(project, op.trackId, op.clipId, next), op.opId);
      }

      const existing = clip.notes[op.noteId];
      if (!existing) return { ok: false, reason: "unknown note" };

      if (op.type === "deleteNote") {
        const { [op.noteId]: _removed, ...rest } = clip.notes;
        return done(withClip(project, op.trackId, op.clipId, { ...clip, notes: rest }), op.opId);
      }

      const updated: Note = { ...existing, ...op.changes };
      if (updated.muted === false) delete updated.muted;
      const err = validateNote(clip, updated);
      if (err) return { ok: false, reason: err };
      const next = { ...clip, notes: { ...clip.notes, [op.noteId]: updated } };
      return done(withClip(project, op.trackId, op.clipId, next), op.opId);
    }
  }
}

export function stamp(body: OpBody, opId: string, clientId: string): Op {
  return { ...body, opId, clientId } as Op;
}

type UpdateNoteChanges = Extract<Op, { type: "updateNote" }>["changes"];

/**
 * Builds the op that undoes `op`, given the project state *before* `op` was applied.
 * Returns null if the op has no effect to undo.
 */
export function invertOp(before: Project, op: Op, newOpId: string): Op | null {
  const base = { opId: newOpId, clientId: op.clientId };
  switch (op.type) {
    case "setTempo":
      return { ...base, type: "setTempo", bpm: before.tempo };
    case "setMasterVolume":
      return { ...base, type: "setMasterVolume", volume: before.masterVolume };
    case "setSongLength":
      return { ...base, type: "setSongLength", bars: before.songBars };
    case "setKey":
      return { ...base, type: "setKey", key: before.key };
    case "addTrack":
      return { ...base, type: "deleteTrack", trackId: op.track.id };
    case "deleteTrack": {
      const track = before.tracks[op.trackId];
      return track ? { ...base, type: "addTrack", track: clone(track), index: before.trackOrder.indexOf(op.trackId) } : null;
    }
    case "updateTrack": {
      const track = before.tracks[op.trackId];
      if (!track) return null;
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(op.changes) as (keyof TrackFields)[]) changes[key] = track[key];
      return { ...base, type: "updateTrack", trackId: op.trackId, changes: changes as Partial<TrackFields> };
    }
    case "updateSample": {
      const sample = before.tracks[op.trackId]?.sample;
      if (!sample) return null;
      const changes: { bpm?: number | null; fit?: boolean } = {};
      if (op.changes.bpm !== undefined) changes.bpm = sample.bpm ?? null;
      if (op.changes.fit !== undefined) changes.fit = sample.fit ?? false;
      return { ...base, type: "updateSample", trackId: op.trackId, changes };
    }
    case "setAutomation": {
      const track = before.tracks[op.trackId];
      if (!track) return null;
      return { ...base, type: "setAutomation", trackId: op.trackId, param: op.param, points: track.automation?.[op.param]?.map((p) => ({ ...p })) ?? null };
    }
    case "addClip":
      return { ...base, type: "deleteClip", trackId: op.trackId, clipId: op.clip.id };
    case "deleteClip": {
      const clip = before.tracks[op.trackId]?.clips[op.clipId];
      return clip ? { ...base, type: "addClip", trackId: op.trackId, clip: clone(clip) } : null;
    }
    case "updateClip": {
      const clip = before.tracks[op.trackId]?.clips[op.clipId];
      if (!clip) return null;
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(op.changes) as (keyof ClipFields)[]) changes[key] = key === "audio" ? (clip.audio ?? null) : clip[key];
      return { ...base, type: "updateClip", trackId: op.trackId, clipId: op.clipId, changes: changes as Partial<ClipFields> };
    }
    case "addNote":
      return { ...base, type: "deleteNote", trackId: op.trackId, clipId: op.clipId, noteId: op.note.id };
    case "deleteNote": {
      const note = before.tracks[op.trackId]?.clips[op.clipId]?.notes[op.noteId];
      return note ? { ...base, type: "addNote", trackId: op.trackId, clipId: op.clipId, note: { ...note } } : null;
    }
    case "updateNote": {
      const note = before.tracks[op.trackId]?.clips[op.clipId]?.notes[op.noteId];
      if (!note) return null;
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(op.changes) as (keyof Note)[]) changes[key] = key === "muted" ? (note.muted ?? false) : note[key];
      return { ...base, type: "updateNote", trackId: op.trackId, clipId: op.clipId, noteId: op.noteId, changes: changes as UpdateNoteChanges };
    }
  }
}

/** Stable hash of the project content (ignores recentOps) for divergence checks in later phases. */
export function projectHash(project: Project): string {
  const canonical = JSON.stringify(project, (key, value) => {
    if (key === "recentOps") return undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return value;
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
