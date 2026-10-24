import { applyOp, MAX_TRACKS, projectHash, stamp, type Note, type OpBody, type Project, type Track } from '@daw/shared'

const TRACK_KEYS = ['name', 'color', 'volume', 'pan', 'mute', 'solo'] as const
const NOTE_KEYS = ['pitch', 'startTick', 'durationTicks', 'velocity'] as const

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** True when two tracks have the same clips (ids, positions, lengths). Notes may differ; clips cannot be edited by ops. */
function sameClipLayout(a: Track, b: Track): boolean {
  const ids = Object.keys(a.clips)
  if (ids.length !== Object.keys(b.clips).length) return false
  return ids.every((id) => {
    const x = a.clips[id]
    const y = b.clips[id]
    return !!y && x!.startTick === y.startTick && x!.lengthTicks === y.lengthTicks
  })
}

/** Ops that change one track (same clips on both sides) from `f` into `t`. */
function trackEdits(f: Track, t: Track): OpBody[] {
  const ops: OpBody[] = []
  const changes: Record<string, unknown> = {}
  for (const k of TRACK_KEYS) if (f[k] !== t[k]) changes[k] = t[k]
  if (Object.keys(changes).length) ops.push({ type: 'updateTrack', trackId: t.id, changes } as OpBody)

  for (const clipId of Object.keys(t.clips)) {
    const fc = f.clips[clipId]!
    const tc = t.clips[clipId]!
    for (const noteId of Object.keys(fc.notes)) {
      if (!tc.notes[noteId]) ops.push({ type: 'deleteNote', trackId: t.id, clipId, noteId })
    }
    for (const [noteId, tn] of Object.entries(tc.notes)) {
      const fn: Note | undefined = fc.notes[noteId]
      if (!fn) {
        ops.push({ type: 'addNote', trackId: t.id, clipId, note: { ...tn } })
        continue
      }
      const ch: Record<string, unknown> = {}
      for (const k of NOTE_KEYS) if (fn[k] !== tn[k]) ch[k] = tn[k]
      if ((fn.muted ?? false) !== (tn.muted ?? false)) ch.muted = tn.muted ?? false
      if (Object.keys(ch).length) ops.push({ type: 'updateNote', trackId: t.id, clipId, noteId, changes: ch } as OpBody)
    }
  }
  return ops
}

/**
 * The ops that turn project `from` into project `to`, using only ops the app already has
 * (tempo, master volume, track and note edits, add/delete track).
 * Returns null if that cannot be done exactly. The result is always checked by replaying it,
 * so a non-null answer is guaranteed to give a project identical to `to`.
 */
export function diffProjects(from: Project, to: Project): OpBody[] | null {
  const ops: OpBody[] = []
  if (from.tempo !== to.tempo) ops.push({ type: 'setTempo', bpm: to.tempo })
  if (from.masterVolume !== to.masterVolume) ops.push({ type: 'setMasterVolume', volume: to.masterVolume })

  const remove: string[] = []
  const add: string[] = []
  for (const id of from.trackOrder) if (!to.tracks[id]) remove.push(id)
  for (const id of to.trackOrder) {
    const f = from.tracks[id]
    const t = to.tracks[id]!
    if (!f) add.push(id)
    else if (!sameClipLayout(f, t)) {
      // The clips differ and no op can change a clip, so the track is replaced.
      remove.push(id)
      add.push(id)
    } else ops.push(...trackEdits(f, t))
  }

  // Delete and add tracks in an order that never breaks the rules (at least 1 track, at most 16).
  let count = from.trackOrder.length
  while (remove.length || add.length) {
    if (remove.length && count > 1) {
      ops.push({ type: 'deleteTrack', trackId: remove.shift()! })
      count--
    } else if (add.length && count < MAX_TRACKS) {
      const id = add.shift()!
      ops.push({ type: 'addTrack', track: clone(to.tracks[id]!), index: to.trackOrder.indexOf(id) })
      count++
    } else return null
  }

  let sim = from
  for (let i = 0; i < ops.length; i++) {
    const r = applyOp(sim, stamp(ops[i]!, `diff-${i}`, 'server'))
    if (!r.ok) return null
    sim = r.project
  }
  return projectHash(sim) === projectHash(to) ? ops : null
}
