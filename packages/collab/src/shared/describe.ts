import { PPQ, type Op } from '@daw/shared'

/** Anything that can say what a track is called (a Project does). */
export interface NameSource {
  tracks: Record<string, { name: string }>;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
const beat = (tick: number) => Math.round((tick / PPQ + 1) * 100) / 100;

/** Short plain-English description of an op, for the activity list. `project` is used only to look up names. */
export function describeOp(op: Op, project?: NameSource): string {
  const trackName = (id: string) => project?.tracks[id]?.name ?? 'a track';
  switch (op.type) {
    case 'addNote':
      return `added a note on ${trackName(op.trackId)}`;
    case 'deleteNote':
      return `deleted a note on ${trackName(op.trackId)}`;
    case 'updateNote': {
      const keys = Object.keys(op.changes);
      const what = keys.includes('startTick') || keys.includes('pitch') ? 'moved' : keys.includes('durationTicks') ? 'resized' : keys.includes('velocity') ? 'changed the velocity of' : keys.includes('muted') ? 'muted/unmuted' : 'edited';
      return `${what} a note on ${trackName(op.trackId)}`;
    }
    case 'setTempo':
      return `set the tempo to ${op.bpm}`;
    case 'setMasterVolume':
      return `set the master volume to ${op.volume}`;
    case 'addTrack':
      return `added track "${op.track.name}"`;
    case 'deleteTrack':
      return `deleted ${trackName(op.trackId)}`;
    case 'updateTrack': {
      const keys = Object.keys(op.changes);
      return `changed ${keys.join(', ')} on ${trackName(op.trackId)}`;
    }
    case 'setKey':
      return op.key ? 'set the key' : 'cleared the key';
    case 'setSongLength':
      return `set the song to ${op.bars} bars`;
    case 'addClip':
      return `added a clip on ${trackName(op.trackId)}`;
    case 'deleteClip':
      return `deleted a clip on ${trackName(op.trackId)}`;
    case 'updateClip':
      return `edited a clip on ${trackName(op.trackId)}`;
    case 'setAutomation':
      return `edited the ${op.param} automation on ${trackName(op.trackId)}`;
    case 'updateSample':
      return `changed the sound on ${trackName(op.trackId)}`;
    case 'setPlugin':
      return `changed the plugin on ${trackName(op.trackId)}`;
    case 'setLoop':
      return op.loop ? 'set the loop region' : 'cleared the loop region';
    case 'setMarkers':
      return 'edited the section markers';
    default:
      return 'made an edit';
  }
}

/** The values an op sets, e.g. "pitch 64, velocity 50". Null when there is nothing more to say. */
export function describeDetail(op: Op): string | null {
  switch (op.type) {
    case 'addNote':
      return `${pitchName(op.note.pitch)} at beat ${beat(op.note.startTick)}`;
    case 'updateNote': {
      const parts: string[] = [];
      const c = op.changes;
      if (c.pitch !== undefined) parts.push(`pitch ${pitchName(c.pitch)}`);
      if (c.startTick !== undefined) parts.push(`beat ${beat(c.startTick)}`);
      if (c.durationTicks !== undefined) parts.push(`length ${Math.round((c.durationTicks / PPQ) * 100) / 100} beats`);
      if (c.velocity !== undefined) parts.push(`velocity ${c.velocity}`);
      if (c.muted !== undefined) parts.push(c.muted ? 'muted' : 'unmuted');
      return parts.join(', ') || null;
    }
    case 'setTempo':
      return `${op.bpm} bpm`;
    case 'setMasterVolume':
      return `volume ${op.volume}`;
    case 'updateTrack':
      return Object.entries(op.changes).map(([k, v]) => `${k} ${String(v)}`).join(', ') || null;
    case 'addTrack':
      return `${op.track.instrument}`;
    case 'deleteNote':
    case 'deleteTrack':
      return null;
    default:
      return null;
  }
}
