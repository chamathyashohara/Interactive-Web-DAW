import type { AutoParam, AutoPoint, Clip, ClipAudio, LoopRegion, Marker, MixReference, Note, PluginRef, Track } from "./model";
import type { ProjectKey } from "./theory";

export type NoteFields = Pick<Note, "pitch" | "startTick" | "durationTicks" | "velocity" | "muted">;
export type TrackFields = Pick<Track, "name" | "color" | "volume" | "pan" | "mute" | "solo">;
export type ClipFields = Pick<Clip, "name" | "startTick" | "lengthTicks"> & {
  /** The clip's whole audio settings (replaces the old ones); null or {} removes them. */
  audio: ClipAudio | null;
};

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
/** Sets or clears the VST3 instrument of a plugin track (and its saved state); null leaves the track with no plugin chosen. */
/** Sets the built-in synth preset of a synth track. */
export interface SetSynthPresetOp extends OpBase {
  type: "setSynthPreset";
  trackId: string;
  preset: string;
}
export interface SetPluginOp extends OpBase {
  type: "setPlugin";
  trackId: string;
  plugin: PluginRef | null;
}
/** Replaces one automation curve of a track (the whole list of points); null removes the curve. */
export interface SetAutomationOp extends OpBase {
  type: "setAutomation";
  trackId: string;
  param: AutoParam;
  points: AutoPoint[] | null;
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

/** Sets the mixer assistant's reference levels; null returns to the defaults. */
export interface SetMixReferenceOp extends OpBase {
  type: "setMixReference";
  reference: MixReference | null;
}

export interface SetKeyOp extends OpBase {
  type: "setKey";
  /** null clears the key. */
  key: ProjectKey | null;
}

export interface SetLoopOp extends OpBase {
  type: "setLoop";
  /** null = loop the whole song. */
  loop: LoopRegion | null;
}

export interface SetMarkersOp extends OpBase {
  type: "setMarkers";
  /** The whole list (one undo step per change). */
  markers: Marker[];
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
  | SetPluginOp
  | SetSynthPresetOp
  | SetAutomationOp
  | SetMasterVolumeOp
  | AddClipOp
  | DeleteClipOp
  | UpdateClipOp
  | SetSongLengthOp
  | SetKeyOp
  | SetMixReferenceOp
  | SetLoopOp
  | SetMarkersOp;

type Body<T> = T extends Op ? Omit<T, "opId" | "clientId"> : never;
/** An op before it is stamped with opId/clientId (what the UI sends to the main process). */
export type OpBody = Body<Op>;
