import { createProject, PPQ, stamp, applyOp, type OpBody, type Project } from '../daw-shared'

export type SeedResult = { ok: true; project: Project } | { ok: false; reason: string }

/**
 * Builds the starting project of a session from whatever the host sent.
 * The host's project is never trusted as-is: it is rebuilt by replaying addTrack/setTempo/setMasterVolume
 * through the same `applyOp` rules every later edit goes through (note ranges, 16 track limit, colours...).
 * No seed means a fresh default project.
 */
export function buildSeedProject(seed: unknown, projectId: string): SeedResult {
  if (seed === undefined || seed === null) return { ok: true, project: createProject(projectId) };
  if (typeof seed !== 'object') return { ok: false, reason: 'project must be an object' };

  const s = seed as Partial<Project>;
  if (!s.tracks || typeof s.tracks !== 'object' || !Array.isArray(s.trackOrder)) return { ok: false, reason: 'project has no tracks' };
  if (s.trackOrder.length < 1) return { ok: false, reason: 'project needs at least one track' };
  if (s.ppq !== undefined && s.ppq !== PPQ) return { ok: false, reason: `ppq must be ${PPQ}` };

  let project: Project = {
    id: projectId,
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 60) : 'Untitled',
    tempo: 120,
    ppq: PPQ,
    masterVolume: 80,
    tracks: {},
    trackOrder: [],
    recentOps: [],
  };

  const bodies: OpBody[] = [];
  for (const id of s.trackOrder) {
    const track = s.tracks[id as string];
    if (!track) return { ok: false, reason: `trackOrder lists unknown track ${String(id)}` };
    bodies.push({ type: 'addTrack', track });
  }
  if (s.tempo !== undefined) bodies.push({ type: 'setTempo', bpm: s.tempo });
  if (s.masterVolume !== undefined) bodies.push({ type: 'setMasterVolume', volume: s.masterVolume });

  for (let i = 0; i < bodies.length; i++) {
    let result;
    try {
      result = applyOp(project, stamp(bodies[i]!, `seed-${i}`, 'server'));
    } catch {
      return { ok: false, reason: 'malformed project' };
    }
    if (!result.ok) return { ok: false, reason: result.reason };
    project = result.project;
  }
  return { ok: true, project: { ...project, recentOps: [] } };
}
