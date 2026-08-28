export type TrackKind = "drums" | "bass" | "chords" | "lead" | "vocal" | "fx";

export type BrowserTab = "sounds" | "instruments" | "user";

export type EditorTab = "piano" | "score" | "steps" | "automation";

export type ProjectPanelTab = "project" | "notes" | "files";

export type SaveStatus = "saved" | "unsaved";

export interface DawTrack {
  id: string;
  number: number;
  name: string;
  kind: TrackKind;
  color: string;
  muted: boolean;
  solo: boolean;
  volume: number;
}

export interface ArrangementClip {
  id: string;
  trackId: string;
  name: string;
  startBar: number;
  lengthBars: number;
}

export interface MidiNote {
  id: string;
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
}

export interface BrowserItem {
  id: string;
  name: string;
  category: string;
  duration: string;
  tab: BrowserTab;
}

export interface EffectSlot {
  id: string;
  name: string;
  detail: string;
  enabled: boolean;
}

export interface ProjectInfo {
  name: string;
  bpm: number;
  key: string;
  timeSignature: string;
  swing: number;
  saveStatus: SaveStatus;
  position: string;
  masterVolume: number;
  masterDb: string;
  author: string;
}

export interface DawMockState {
  project: ProjectInfo;
  tracks: DawTrack[];
  clips: ArrangementClip[];
  notes: MidiNote[];
  browserItems: BrowserItem[];
  effects: EffectSlot[];
  totalBars: number;
  playheadBar: number;
}
