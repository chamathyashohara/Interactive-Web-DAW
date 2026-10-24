import type { Note, Track } from "./model";

export type NoteFields = Pick<Note, "pitch" | "startTick" | "durationTicks" | "velocity" | "muted">;
export type TrackFields = Pick<Track, "name" | "color" | "volume" | "pan" | "mute" | "solo">;

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

export type Op = AddNoteOp | DeleteNoteOp | UpdateNoteOp | SetTempoOp | AddTrackOp | DeleteTrackOp | UpdateTrackOp | SetMasterVolumeOp;

type Body<T> = T extends Op ? Omit<T, "opId" | "clientId"> : never;
/** An op before it is stamped with opId/clientId (what the UI sends to the main process). */
export type OpBody = Body<Op>;
