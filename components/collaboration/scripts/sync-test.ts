// Headless checks for the operation-list sync: the room's rules, the replica's fix-ups, and the real thing
// over sockets (conflicts, reconnect, presence, ending a session, the HTTP API for online hosting).
import WebSocket from 'ws'
import { startSessionServer } from '../src/server/sessionServer'
import { Room } from '../src/server/room'
import { Replica } from '../src/client/replica'
import { CollabClient, newId } from '../src/client/collabClient'
import { buildSeedProject } from '../src/shared/seed'
import { diffProjects } from '../src/shared/restore'
import { describeOp, describeDetail } from '../src/shared/describe'
import { USER_COLORS } from '../src/shared/palette'
import { summarize, quality } from '../src/shared/stats'
import { parseServerAddress } from '../src/shared/serverAddress'
import {
  applyOp, createProject, createTrack, projectHash, stamp, PPQ, TRACK_COLORS,
  type Op, type OpBody, type Project,
} from '../src/daw-shared'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await wait(20)
  return cond()
}
const check = (label: string, ok: boolean) => {
  console.log(ok ? 'PASS' : 'FAIL', label)
  if (!ok) process.exitCode = 1
}

const op = (body: OpBody, clientId: string, id = newId()): Op => stamp(body, id, clientId)
const note = (id: string, pitch = 60, startTick = 0) => ({ id, pitch, startTick, durationTicks: PPQ, velocity: 100 })

/** A project with one synth track, one clip and one note n1. */
function baseProject(): Project {
  const p = createProject('p1', 'Test')
  p.tracks['track-1']!.clips['clip-1']!.notes['n1'] = note('n1')
  return p
}
const updateN1 = (changes: object): OpBody => ({ type: 'updateNote', trackId: 'track-1', clipId: 'clip-1', noteId: 'n1', changes } as OpBody)
const noteOf = (p: Project | null) => p?.tracks['track-1']?.clips['clip-1']?.notes['n1']

// ---------------------------------------------------------------- Room (server rules, no sockets)
{
  const room = new Room(baseProject())
  const r1 = room.submit('A', [op({ type: 'setTempo', bpm: 140 }, 'A')])
  check('room: a valid op is accepted with seq 1', r1.ok && r1.entries[0]?.seq === 1 && room.project.tempo === 140)

  const bad = room.submit('A', [op({ type: 'setTempo', bpm: 140 }, 'IMPOSTOR')])
  check('room: an op stamped with another client id is refused', !bad.ok)

  const range = room.submit('A', [op({ type: 'addNote', trackId: 'track-1', clipId: 'clip-1', note: note('x', 200) }, 'A')])
  check('room: out-of-range note is refused by the shared rules', !range.ok && room.seq === 1)

  const dup = op({ type: 'setTempo', bpm: 150 }, 'A', 'same-id')
  room.submit('A', [dup])
  const again = room.submit('A', [dup])
  check('room: the same opId twice is applied once', again.ok && again.entries.length === 0 && again.duplicates.length === 1 && room.seq === 2)

  const batch = room.submit('A', [
    op({ type: 'setTempo', bpm: 100 }, 'A'),
    op({ type: 'deleteNote', trackId: 'track-1', clipId: 'clip-1', noteId: 'nope' }, 'A'),
  ])
  check('room: a batch with one bad op changes nothing', !batch.ok && room.project.tempo === 150)

  let threw = false
  try {
    const m = room.submit('A', [{ type: 'addTrack', opId: 'q1', clientId: 'A' }, null, 7])
    check('room: malformed ops are refused, not crashed on', !m.ok)
  } catch {
    threw = true
  }
  check('room: malformed ops do not throw', !threw)

  check('room: recent() returns the last ops, oldest first', room.recent(2).length === 2 && room.recent(2)[1]!.seq === room.seq && room.recent(2)[0]!.seq === room.seq - 1)
  check('room: catch-up returns only the ops after lastSeq', room.entriesSince(1)?.length === room.seq - 1)
  check('room: a client ahead of the server must take a snapshot', room.entriesSince(999) === null)
}

// ---------------------------------------------------------------- Replica (the app's copy)
{
  // Own edit shows at once, then is confirmed.
  const a = new Replica(baseProject(), 0)
  const mine = op(updateN1({ pitch: 70 }), 'A')
  a.localApply([mine])
  check('replica: own edit shows before the server answers', noteOf(a.view)?.pitch === 70)
  const res = a.receive({ seq: 1, op: mine, at: 0 })
  check('replica: confirmation clears the pending edit', res.status === 'ok' && a.pendingBatches.length === 0 && noteOf(a.view)?.pitch === 70)

  // Both change the same field; the other user's op was ordered first, ours second: ours wins everywhere.
  const a2 = new Replica(baseProject(), 0)
  const ours = op(updateN1({ pitch: 70 }), 'A')
  const theirs = op(updateN1({ pitch: 80 }), 'B')
  a2.localApply([ours])
  a2.receive({ seq: 1, op: theirs, at: 0 })
  check('replica: our unconfirmed edit stays on top of theirs', noteOf(a2.view)?.pitch === 70)
  a2.receive({ seq: 2, op: ours, at: 0 })
  check('replica: after the server order is known both sides agree (last wins)', noteOf(a2.view)?.pitch === 70)

  // They delete the note while our edit is still pending: ours cannot apply any more.
  const a3 = new Replica(baseProject(), 0)
  a3.localApply([op(updateN1({ pitch: 70 }), 'A')])
  const del = a3.receive({ seq: 1, op: op({ type: 'deleteNote', trackId: 'track-1', clipId: 'clip-1', noteId: 'n1' }, 'B'), at: 0 })
  check('replica: our edit to a deleted note is dropped and reported', del.dropped.length === 1 && !noteOf(a3.view) && a3.pendingBatches.length === 0)

  check('replica: a missing op is detected as a gap', new Replica(baseProject(), 0).receive({ seq: 5, op: mine, at: 0 }).status === 'gap')
  check('replica: an old op is ignored', a.receive({ seq: 1, op: mine, at: 0 }).status === 'stale')
}

// ---------------------------------------------------------------- Restore (click a history segment)
{
  const track2 = createTrack('track-2', 'Drums', 'drums', '#ff4d8d', 'clip-2')
  const room = new Room(baseProject())
  const A = 'client-A'
  const B = 'client-B'
  const step = (who: string, body: OpBody) => { const r = room.submit(who, [op(body, who)]); if (!r.ok) throw new Error('setup failed: ' + r.reason) }

  const hashes: string[] = [projectHash(room.project)] // hashes[n] = project after step n
  const record = () => hashes.push(projectHash(room.project))
  step(A, { type: 'addNote', trackId: 'track-1', clipId: 'clip-1', note: note('a1', 62, PPQ) }); record() // 1
  step(B, { type: 'setTempo', bpm: 150 }); record()                                                        // 2
  step(A, updateN1({ pitch: 70, velocity: 40 })); record()                                                 // 3
  step(B, { type: 'addTrack', track: track2 }); record()                                                   // 4
  step(B, { type: 'addNote', trackId: 'track-2', clipId: 'clip-2', note: note('d1', 36) }); record()       // 5
  step(A, { type: 'deleteNote', trackId: 'track-1', clipId: 'clip-1', noteId: 'n1' }); record()            // 6
  step(A, { type: 'updateTrack', trackId: 'track-1', changes: { volume: 20, mute: true } }); record()      // 7
  step(B, { type: 'deleteTrack', trackId: 'track-2' }); record()                                           // 8
  const before = room.seq
  check('restore: setup recorded 8 steps', before === 8 && room.stateAt(8) !== null)

  check('restore: stateAt rebuilds every earlier step exactly', hashes.every((h, n) => projectHash(room.stateAt(n)!) === h))

  // Restore to each earlier step in turn (always from the latest state), checking the project matches that step.
  let allMatch = true
  for (let n = 0; n < before; n++) {
    const latestBefore = room.seq
    const restoreFrom = projectHash(room.project)
    const r = room.restoreTo(B, n)
    if (!r.ok) { allMatch = false; console.log('  restore to', n, 'refused:', r.reason); continue }
    if (projectHash(room.project) !== hashes[n]) { allMatch = false; console.log('  restore to', n, 'gave the wrong project') }
    if (!r.entries.every((e) => e.restore === n && e.op.clientId === B && e.seq > latestBefore)) allMatch = false
    // Undo the restore by restoring to the step just before it.
    const back = room.restoreTo(A, latestBefore)
    if (!back.ok || projectHash(room.project) !== restoreFrom) { allMatch = false; console.log('  restoring forward after', n, 'failed') }
  }
  check('restore: going back to every earlier step gives exactly that project, and restoring forward undoes it', allMatch)
  check('restore: the log only grew; no step was erased', room.seq > before && room.stateAt(5) !== null && projectHash(room.stateAt(5)!) === hashes[5])

  const seqNow = room.seq
  const again = room.restoreTo(A, seqNow)
  check('restore: restoring to the current step is refused as nothing to do', !again.ok)
  check('restore: a step that does not exist is refused', !room.restoreTo(A, 99999).ok && !room.restoreTo(A, -1).ok && !room.restoreTo(A, 1.5).ok)

  const toStart = room.restoreTo(A, 0)
  check('restore: back to the original project works', toStart.ok && projectHash(room.project) === hashes[0])
  check('restore: all restored ops carry the same time and person, so they show as one segment', toStart.ok && new Set(toStart.entries.map((e) => e.at)).size === 1 && toStart.entries.every((e) => e.op.clientId === A))
}

// diffProjects directly
{
  const p0 = baseProject()
  const withNotes = baseProject()
  withNotes.tracks['track-1']!.clips['clip-1']!.notes['n2'] = note('n2', 65, PPQ * 4)
  withNotes.tempo = 90
  const d = diffProjects(p0, withNotes)
  check('diff: tempo and a new note are found', !!d && d.some((o) => o.type === 'setTempo') && d.some((o) => o.type === 'addNote'))
  check('diff: equal projects need no ops', diffProjects(p0, baseProject())?.length === 0)

  // All 16 tracks replaced by 16 different ones: needs delete/add in a rule-respecting order.
  const many = (prefix: string) => {
    const p = createProject('p', 'many')
    p.trackOrder = []
    p.tracks = {}
    for (let i = 0; i < 16; i++) {
      const t = createTrack(`${prefix}${i}`, `${prefix}${i}`, 'synth', '#ffffff', `c-${prefix}${i}`)
      p.tracks[t.id] = t
      p.trackOrder.push(t.id)
    }
    return p
  }
  const swap = diffProjects(many('a'), many('b'))
  let ok = false
  if (swap) {
    let sim = many('a')
    ok = swap.every((body, i) => { const r = applyOp(sim, stamp(body, `s${i}`, 'x')); if (r.ok) sim = r.project; return r.ok }) && projectHash(sim) === projectHash(many('b'))
  }
  check('diff: swapping 16 tracks for 16 different ones respects the 1 to 16 track rule', !!swap && ok)

  // Same track id but different clips: cannot be edited by ops, so the track is replaced.
  const replaced = baseProject()
  replaced.tracks['track-1']!.clips = { 'clip-9': { id: 'clip-9', startTick: 0, lengthTicks: 4 * 3840, notes: {} } }
  const base2 = baseProject()
  base2.tracks['track-2'] = createTrack('track-2', 'T2', 'synth', '#ffffff', 'c2')
  base2.trackOrder.push('track-2')
  const rep = base2 && diffProjects(base2, { ...replaced, tracks: { ...replaced.tracks, 'track-2': base2.tracks['track-2']! }, trackOrder: ['track-1', 'track-2'] })
  check('diff: a track whose clips changed is replaced, not edited', !!rep && rep.some((o) => o.type === 'deleteTrack') && rep.some((o) => o.type === 'addTrack'))
}

// ---------------------------------------------------------------- Seed projects
{
  check('seed: no project gives a default one', buildSeedProject(undefined, 'x').ok)
  const s = baseProject()
  const built = buildSeedProject(s, 'x')
  check('seed: a valid project is accepted and keeps its notes', built.ok && !!built.project.tracks['track-1']?.clips['clip-1']?.notes['n1'])
  const evil = baseProject()
  evil.tracks['track-1']!.clips['clip-1']!.notes['n1']!.pitch = 999
  check('seed: a project with an invalid note is refused', !buildSeedProject(evil, 'x').ok)
  check('seed: garbage is refused', !buildSeedProject({ tracks: 5 }, 'x').ok && !buildSeedProject('hi', 'x').ok)
}

// ---------------------------------------------------------------- Over real sockets
const PORT = 4100
const server = await startSessionServer(PORT)
const base = `ws://127.0.0.1:${PORT}`

/** Many tracks so the 16-track limit can be raced. */
function projectWithTracks(n: number): Project {
  const p = baseProject()
  for (let i = 2; i <= n; i++) {
    p.tracks[`track-${i}`] = createTrack(`track-${i}`, `T${i}`, 'synth', TRACK_COLORS[i % TRACK_COLORS.length]!, `clip-${i}`)
    p.trackOrder.push(`track-${i}`)
  }
  return p
}

async function join(code: string, name: string) {
  const c = new CollabClient({ baseUrl: base, code, name, color: '#4cc9f0' })
  c.connect()
  await until(() => c.status === 'connected' && c.project !== null)
  return c
}
const settled = (cs: CollabClient[], code: string) => {
  const room = server.roomFor(code)!
  return until(() => cs.every((c) => c.pendingCount === 0 && c.seq === room.seq && projectHash(c.project!) === projectHash(room.project)), 4000)
}

{
  const code = server.createSession(baseProject())
  const [a, b] = [await join(code, 'Ana'), await join(code, 'Ben')]
  check('join: both apps receive the host project', !!noteOf(a.project) && !!noteOf(b.project))
  check('join: both see two people in the session', await until(() => a.users.length === 2 && b.users.length === 2))
  const colours = a.users.map((u) => u.color)
  check('colours: the server gives each person a different colour', new Set(colours).size === 2 && colours.every((c) => USER_COLORS.includes(c)))
  check('colours: both apps see the same colour for the same person', JSON.stringify([...a.users].sort((x, y) => x.id.localeCompare(y.id))) === JSON.stringify([...b.users].sort((x, y) => x.id.localeCompare(y.id))))

  // 1. Same field at the same time.
  a.dispatch(updateN1({ pitch: 65 }))
  b.dispatch(updateN1({ pitch: 67 }))
  check('same note, same field: both apps end identical to the server', await settled([a, b], code))
  const winner = noteOf(server.roomFor(code)!.project)!.pitch
  check(`same note, same field: one value wins for everyone (${winner})`, [65, 67].includes(winner) && noteOf(a.project)!.pitch === winner && noteOf(b.project)!.pitch === winner)

  // 2. Different fields at the same time.
  a.dispatch(updateN1({ velocity: 50 }))
  b.dispatch(updateN1({ startTick: PPQ * 2 }))
  await settled([a, b], code)
  const merged = noteOf(server.roomFor(code)!.project)!
  check('same note, different fields: both changes survive', merged.velocity === 50 && merged.startTick === PPQ * 2)

  // 3. One deletes while the other edits.
  let droppedForB = 0
  b.on('dropped', (d) => (droppedForB += d.length))
  a.dispatch({ type: 'deleteNote', trackId: 'track-1', clipId: 'clip-1', noteId: 'n1' })
  b.dispatch(updateN1({ pitch: 72 }))
  check('delete vs edit: everyone ends identical', await settled([a, b], code))
  check('delete vs edit: the note is gone for everyone', !noteOf(a.project) && !noteOf(b.project) && !noteOf(server.roomFor(code)!.project))

  // 4. Undo-style stale edit: a second delete of the same note is refused cleanly.
  const stale = b.dispatch({ type: 'deleteNote', trackId: 'track-1', clipId: 'clip-1', noteId: 'n1' })
  check('deleting a note that is already gone is refused locally', !stale.ok)

  // 4b. Someone who joins late is shown what was already done, and gets a colour of their own.
  const late = new CollabClient({ baseUrl: base, code, name: 'Late', color: '#ffffff' })
  const lateSeen: number[] = []
  late.on('history', (es) => lateSeen.push(...es.map((e) => e.seq)))
  late.connect()
  await until(() => late.status === 'connected' && lateSeen.length > 0)
  const room = server.roomFor(code)!
  check('history: a late joiner receives the earlier actions', lateSeen.length > 0 && lateSeen.length === room.seq && lateSeen[0] === 1)
  check('colours: three people have three different colours', await until(() => new Set(late.users.map((u) => u.color)).size === 3))
  late.close()

  // 5. Presence and probes relay to the others only.
  let seen: unknown = null
  b.on('presence', (p) => { if (p.id === a.clientId) seen = p.state })
  a.setPresence({ pointer: { x: 12, y: 34 } })
  check('presence: the other user receives the pointer', await until(() => JSON.stringify(seen) === JSON.stringify({ pointer: { x: 12, y: 34 } })))

  // 6. Wire-level safety: a forged client id is refused.
  const rawRefused = await new Promise<string>((res) => {
    const ws = new WebSocket(`${base}/ops/${code}`)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', clientId: 'raw-client-1', name: 'Raw', color: '#ffffff', lastSeq: null })))
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'ops', ops: [op({ type: 'setTempo', bpm: 99 }, 'somebody-else')] }))
      if (m.t === 'reject') res(m.reason)
    })
    setTimeout(() => res('timeout'), 3000)
  })
  check('forged client id is rejected by the server', rawRefused === 'op is stamped with another client id')
  check('forged op changed nothing', server.roomFor(code)!.project.tempo === 120)

  a.close()
  b.close()
}

// 6b. Restore over sockets: one person puts the project back, everyone follows, it shows as the person's action.
{
  const code = server.createSession(baseProject())
  const [a, b] = [await join(code, 'Ana'), await join(code, 'Ben')]
  a.dispatch({ type: 'addNote', trackId: 'track-1', clipId: 'clip-1', note: note('x1', 61, PPQ) })    // step 1
  await settled([a, b], code)
  b.dispatch({ type: 'setTempo', bpm: 160 })                                                          // step 2
  await settled([a, b], code)
  a.dispatch({ type: 'addNote', trackId: 'track-1', clipId: 'clip-1', note: note('x2', 63, PPQ * 2) }) // step 3
  await settled([a, b], code)

  const seenOnA: { seq: number; restore?: number; by: string }[] = []
  a.on('entries', (es) => seenOnA.push(...es.map((e) => ({ seq: e.seq, restore: e.restore, by: e.op.clientId }))))
  b.restore(1) // Ben puts everything back to just after step 1
  await until(() => a.project!.tempo === 120 && b.project!.tempo === 120)
  check('restore over sockets: everyone ends identical', await settled([a, b], code))
  check('restore over sockets: tempo and the later note are undone, the earlier note stays', a.project!.tempo === 120 && b.project!.tempo === 120 && !a.project!.tracks['track-1']!.clips['clip-1']!.notes['x2'] && !!a.project!.tracks['track-1']!.clips['clip-1']!.notes['x1'])
  check('restore over sockets: the other person sees it as Ben\'s restore of step 1', seenOnA.length > 0 && seenOnA.every((e) => e.restore === 1 && e.by === b.clientId))

  a.restore(3) // Ana restores forward to step 3: this undoes Ben's restore
  await until(() => a.project!.tempo === 160 && b.project!.tempo === 160)
  await settled([a, b], code)
  check('restore over sockets: restoring forward brings everything back', b.project!.tempo === 160 && !!b.project!.tracks['track-1']!.clips['clip-1']!.notes['x2'])

  let refusal = ''
  a.on('refused', (r) => (refusal = r.reason))
  a.restore(9999)
  check('restore over sockets: a nonsense step is refused with a reason', await until(() => refusal.length > 0))
  a.close()
  b.close()
}

// 7. The 16th track race: only one of two simultaneous "add track" can win.
{
  const code = server.createSession(projectWithTracks(15))
  const [a, b] = [await join(code, 'Ana'), await join(code, 'Ben')]
  const drops: number[] = [0, 0]
  a.on('dropped', (d) => (drops[0] += d.length))
  b.on('dropped', (d) => (drops[1] += d.length))
  a.dispatch({ type: 'addTrack', track: createTrack('new-a', 'A', 'synth', '#ffffff', 'ca') })
  b.dispatch({ type: 'addTrack', track: createTrack('new-b', 'B', 'synth', '#000000', 'cb') })
  check('16th track race: everyone ends identical', await settled([a, b], code))
  check('16th track race: exactly 16 tracks, never 17', Object.keys(server.roomFor(code)!.project.tracks).length === 16 && a.project!.trackOrder.length === 16)
  check('16th track race: exactly one person is told their track was not kept', await until(() => drops[0] + drops[1] === 1))
  a.close()
  b.close()
}

// 8. Reconnect: a client that loses its connection catches up on what it missed, and its own offline edit goes through.
{
  const code = server.createSession(baseProject())
  const [a, c] = [await join(code, 'Ana'), await join(code, 'Cleo')]
  const colourBefore = c.users.find((u) => u.id === c.clientId)?.color
  ;(c as unknown as { ws: WebSocket }).ws.close() // simulate the connection dropping
  await until(() => c.status === 'disconnected')
  a.dispatch({ type: 'setTempo', bpm: 133 })
  a.dispatch({ type: 'addNote', trackId: 'track-1', clipId: 'clip-1', note: note('n2', 62, PPQ * 3) })
  c.dispatch({ type: 'setMasterVolume', volume: 40 }) // edit while offline, kept as pending
  check('reconnect: the client comes back by itself', await until(() => c.status === 'connected', 6000))
  check('reconnect: it catches up and everyone is identical', await settled([a, c], code))
  check('reconnect: missed edits and its own offline edit are both there', c.project!.tempo === 133 && c.project!.masterVolume === 40 && !!c.project!.tracks['track-1']!.clips['clip-1']!.notes['n2'])
  check('reconnect: counted once', c.reconnects === 1)
  check('reconnect: the person keeps the same colour', c.users.find((u) => u.id === c.clientId)?.color === colourBefore && !!colourBefore)
  a.close()
  c.close()
}

// 9. Ending a session, and joining something that does not exist.
{
  const code = server.createSession(baseProject())
  const g = await join(code, 'Gus')
  let ended = ''
  g.on('ended', (e) => (ended = e.reason))
  check('end session: reports success', server.endSession(code) === true)
  check('end session: the guest is told the host ended it', await until(() => ended === 'host-ended'))
  const refused = await new Promise<boolean>((res) => {
    const ws = new WebSocket(`${base}/ops/${code}`)
    ws.on('open', () => res(false))
    ws.on('error', () => res(true))
    ws.on('close', () => res(true))
  })
  check('end session: the code cannot be used again', refused)

  const lost = new CollabClient({ baseUrl: base, code: '999999', name: 'Nobody', color: '#ffffff' })
  let lostReason = ''
  lost.on('ended', (e) => (lostReason = e.reason))
  lost.connect()
  check('wrong code: the app gives up with "cannot join"', await until(() => lostReason === 'cannot-join', 9000))
  lost.close()
}

// ---------------------------------------------------------------- Online mode: HTTP API with an access token
{
  const online = await startSessionServer(4101, { authToken: 'secret', maxFailedJoinsPerMinute: 3 })
  const api = 'http://127.0.0.1:4101'
  const post = (body: unknown, token?: string) =>
    fetch(`${api}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

  check('health endpoint answers', (await (await fetch(`${api}/health`)).json()).ok === true)
  check('creating a session without a token is refused (401)', (await post({})).status === 401)
  check('wrong token is refused (401)', (await post({}, 'nope')).status === 401)
  const created = await post({ project: baseProject() }, 'secret')
  const { code, hostKey } = (await created.json()) as { code: string; hostKey: string }
  check('correct token creates a session from the host project', created.status === 201 && /^\d{6}$/.test(code) && !!noteOf(online.roomFor(code)?.project ?? null))
  check('a project with an invalid note is refused (400)', (await post({ project: { ...baseProject(), tempo: 5000 } }, 'secret')).status === 400)
  check('ending with a wrong host key is refused (403)', (await fetch(`${api}/sessions/${code}`, { method: 'DELETE', headers: { 'X-Host-Key': 'bad' } })).status === 403)
  check('ending with the host key works', (await fetch(`${api}/sessions/${code}`, { method: 'DELETE', headers: { 'X-Host-Key': hostKey } })).status === 200)
  check('ended online session no longer exists', (await fetch(`${api}/sessions/${code}`)).status === 404)

  const live = (await (await post({}, 'secret')).json()) as { code: string }
  const tryJoin = (c: string) =>
    new Promise<boolean>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:4101/ops/${c}`)
      ws.on('open', () => { ws.close(); res(true) })
      ws.on('error', () => res(false))
      ws.on('close', () => res(false))
    })
  for (const guess of ['111111', '222222', '333333']) await tryJoin(guess)
  check('guessing codes gets an IP blocked', (await tryJoin(live.code)) === false)
  await online.close()
}

// ---------------------------------------------------------------- Ping endpoint, statistics, helpers
{
  const pingReply = await new Promise<{ id: number; t: number; s: number } | null>((res) => {
    const ws = new WebSocket(`${base}/ping`)
    ws.on('open', () => ws.send(JSON.stringify({ id: 7, t: 123 })))
    ws.on('message', (d) => { res(JSON.parse(String(d))); ws.close() })
    ws.on('error', () => res(null))
    setTimeout(() => res(null), 2000)
  })
  check('ping endpoint echoes the message with the server clock', pingReply?.id === 7 && pingReply.t === 123 && Math.abs(pingReply.s - Date.now()) < 2000)
  const sm = summarize([10, 20, 30, 40, 100])
  check('summary: avg, min, max, p95, jitter', sm?.avg === 40 && sm.min === 10 && sm.max === 100 && sm.p95 === 100 && sm.jitter === 22.5)
  check('summary of nothing is null', summarize([]) === null)
  check('quality ratings', quality(20) === 'good' && quality(100) === 'fair' && quality(300) === 'poor' && quality(null) === 'unknown')

  const same = (a: string, ws: string) => parseServerAddress(a).ws === ws
  check('address: bare IP uses ws and the default port', same('192.168.1.5', 'ws://192.168.1.5:4000'))
  check('address: blank means this PC', same('', 'ws://127.0.0.1:4000'))
  check('address: https URL becomes wss', same('https://abc.trycloudflare.com/', 'wss://abc.trycloudflare.com'))
  check('address: bare domain is secure', same('collab.example.com', 'wss://collab.example.com'))
  check('address: explicit port stays plain ws', same('host.local:5000', 'ws://host.local:5000'))

  const p = baseProject()
  check('describe: ops read as plain English', describeOp(op(updateN1({ pitch: 1 }), 'A'), p) === 'moved a note on Synth' && describeOp(op({ type: 'setTempo', bpm: 90 }, 'A')) === 'set the tempo to 90')
  const r = applyOp(p, op(updateN1({ pitch: 61 }), 'A'))
  check('vendored shared model works as in Component 1', r.ok)
  check('detail: a new note says which note and where', describeDetail(op({ type: 'addNote', trackId: 'track-1', clipId: 'clip-1', note: note('z', 64, PPQ * 2) }, 'A')) === 'E4 at beat 3')
  check('detail: an edit lists the values it set', describeDetail(op(updateN1({ pitch: 65, velocity: 50 }), 'A')) === 'pitch F4, velocity 50')
  check('detail: tempo and deletes', describeDetail(op({ type: 'setTempo', bpm: 90 }, 'A')) === '90 bpm' && describeDetail(op({ type: 'deleteTrack', trackId: 't' }, 'A')) === null)
}

await server.close()
process.exit(process.exitCode ?? 0)
