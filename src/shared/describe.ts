import type { Op, Project } from '../daw-shared'

/** Short plain-English description of an op, for the activity list. `project` is used only to look up names. */
export function describeOp(op: Op, project?: Project): string {
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
  }
}
