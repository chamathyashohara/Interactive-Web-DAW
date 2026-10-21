import type { Clip, Note, Track } from "./model";
import type { ProjectKey } from "./theory";

export type NoteFields = Pick<Note, "pitch" | "startTick" | "durationTicks" | "velocity" | "muted">;
export type TrackFields = Pick<Track, "name" | "color" | "volume" | "pan" | "mute" | "solo">;
export type ClipFields = Pick<Clip, "name" | "startTick" | "lengthTicks">;

interface OpBase {
  /** Globally unique; the same opId applied twice has the same effect as once. */
  opId: string;
  clientId: string;
}

export interface AddNoteOp extends OpBase {
  type: "addNote";
  trackId: string;
  clipId: string;
  note: Note;
}
export interface DeleteNoteOp extends OpBase {
  type: "deleteNote";
  trackId: string;
  clipId: string;
  noteId: string;
}
export interface UpdateNoteOp extends OpBase {
  type: "updateNote";
  trackId: string;
  clipId: string;
  noteId: string;
  changes: Partial<NoteFields>;
}
/** Changes how a sample track follows the tempo: its original BPM (null = unknown) and whether it is stretched to the project tempo. */
export interface UpdateSampleOp extends OpBase {
  type: "updateSample";
  trackId: string;
  changes: { bpm?: number | null; fit?: boolean };
}
export interface SetTempoOp extends OpBase {
  type: "setTempo";
  bpm: number;
}
/** Adds a complete track (also used to restore a deleted track on undo). */
export interface AddTrackOp extends OpBase {
  type: "addTrack";
  track: Track;
  /** Position in track order; appended when omitted. */
  index?: number;
}
export interface DeleteTrackOp extends OpBase {
  type: "deleteTrack";
  trackId: string;
}
export interface UpdateTrackOp extends OpBase {
  type: "updateTrack";
  trackId: string;
  changes: Partial<TrackFields>;
}
export interface SetMasterVolumeOp extends OpBase {
  type: "setMasterVolume";
  volume: number;
}
/** Adds a complete clip with its notes (also used to restore a deleted clip on undo). */
export interface AddClipOp extends OpBase {
  type: "addClip";
  trackId: string;
  clip: Clip;
}
export interface DeleteClipOp extends OpBase {
  type: "deleteClip";
  trackId: string;
  clipId: string;
}
export interface UpdateClipOp extends OpBase {
  type: "updateClip";
  trackId: string;
  clipId: string;
  changes: Partial<ClipFields>;
}
export interface SetSongLengthOp extends OpBase {
  type: "setSongLength";
  bars: number;
}

export interface SetKeyOp extends OpBase {
  type: "setKey";
  /** null clears the key. */
  key: ProjectKey | null;
}

export type Op =
  | AddNoteOp
  | DeleteNoteOp
  | UpdateNoteOp
  | SetTempoOp
  | AddTrackOp
  | DeleteTrackOp
  | UpdateTrackOp
  | UpdateSampleOp
  | SetMasterVolumeOp
  | AddClipOp
  | DeleteClipOp
  | UpdateClipOp
  | SetSongLengthOp
  | SetKeyOp;

type Body<T> = T extends Op ? Omit<T, "opId" | "clientId"> : never;
/** An op before it is stamped with opId/clientId (what the UI sends to the main process). */
export type OpBody = Body<Op>;
