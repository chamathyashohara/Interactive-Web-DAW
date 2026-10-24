import { CollabClient, newId } from '../client/collabClient'
import { NetStats } from './netstats'
import { describeDetail, describeOp } from '../shared/describe'
import { quality, summarize } from '../shared/stats'
import { parseServerAddress } from '../shared/serverAddress'
import type { HostInfo } from '../shared/types'
import type { LogEntry } from '../shared/protocol'
import type { Op } from '../daw-shared'
import { createProject, createTrack, MAX_TRACKS, PPQ, TRACK_COLORS, type Project, type Track } from '../daw-shared'

declare global {
  interface Window {
    collab: { hostSession(seed: unknown): Promise<HostInfo>; endSession(code: string): Promise<boolean>; copyText(text: string): Promise<boolean> }
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const PITCHES = [72, 71, 70, 69, 68, 67, 66, 65, 64, 63, 62, 61, 60]
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const pitchName = (p: number) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`
const COLUMNS = 16 // one beat each; the default clip is 4 bars = 16 beats

let client: CollabClient | null = null
let net: NetStats | null = null
let currentCode: string | null = null
let isHost = false
// Set only when hosting on a remote (internet) server, so we can end the session there.
let remoteHost: { http: string; hostKey: string } | null = null
let selectedTrackId: string | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null
const presence = new Map<string, { pointer?: { x: number; y: number } | null }>()
const me = { name: 'Host' }

/** The host's starting project: Component 1's model with a few notes so there is something to fight over. */
function demoProject(): Project {
  const p = createProject(newId(), 'Demo beat')
  const synth = p.tracks['track-1']!
  const clip = synth.clips['clip-1']!
  ;[60, 64, 67, 64].forEach((pitch, i) => {
    clip.notes[`n-${i}`] = { id: `n-${i}`, pitch, startTick: i * 4 * PPQ, durationTicks: PPQ, velocity: 100 }
  })
  const drums = createTrack('track-2', 'Drums', 'drums', TRACK_COLORS[1]!, 'clip-2')
  p.tracks[drums.id] = drums
  p.trackOrder.push(drums.id)
  return p
}

function notice(text: string) {
  const el = $('notice')
  el.textContent = text
  el.style.display = 'block'
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (el.style.display = 'none'), 6000)
}

// --- Drawing the project ---
function render() {
  const project = client?.project
  if (!project) return
  if (!selectedTrackId || !project.tracks[selectedTrackId]) selectedTrackId = project.trackOrder[0] ?? null

  const tempo = $<HTMLInputElement>('tempo')
  if (document.activeElement !== tempo) tempo.value = String(project.tempo)
  const master = $<HTMLInputElement>('master')
  if (document.activeElement !== master) master.value = String(project.masterVolume)

  trackNames.clear()
  for (const t of Object.values(project.tracks)) trackNames.set(t.id, t.name)

  const tracksEl = $('tracks')
  tracksEl.innerHTML = ''
  for (const id of project.trackOrder) {
    const t = project.tracks[id]!
    const row = document.createElement('div')
    row.className = 'track' + (id === selectedTrackId ? ' sel' : '')
    row.style.borderLeftColor = t.color
    row.onclick = () => {
      selectedTrackId = id
      render()
    }
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = `${t.name} (${t.instrument})`
    const vol = document.createElement('input')
    vol.type = 'range'
    vol.min = '0'
    vol.max = '100'
    vol.value = String(t.volume)
    vol.title = 'Volume'
    vol.onclick = (e) => e.stopPropagation()
    vol.onchange = () => client?.dispatch({ type: 'updateTrack', trackId: id, changes: { volume: Number(vol.value) } })
    const mute = document.createElement('button')
    mute.textContent = 'M'
    mute.title = 'Mute'
    if (t.mute) mute.className = 'on'
    mute.onclick = (e) => {
      e.stopPropagation()
      client?.dispatch({ type: 'updateTrack', trackId: id, changes: { mute: !t.mute } })
    }
    const del = document.createElement('button')
    del.textContent = 'x'
    del.title = 'Delete track'
    del.disabled = project.trackOrder.length <= 1
    del.onclick = (e) => {
      e.stopPropagation()
      client?.dispatch({ type: 'deleteTrack', trackId: id })
    }
    row.append(name, vol, mute, del)
    tracksEl.appendChild(row)
  }
  ;($('addTrack') as HTMLButtonElement).disabled = project.trackOrder.length >= MAX_TRACKS

  renderGrid(project)
}

function renderGrid(project: Project) {
  const grid = $('grid')
  grid.innerHTML = ''
  const track: Track | undefined = selectedTrackId ? project.tracks[selectedTrackId] : undefined
  const clip = track ? Object.values(track.clips)[0] : undefined
  $('gridTitle').textContent = track ? `Notes: ${track.name}` : 'Notes'
  if (!track || !clip) return

  grid.style.gridTemplateColumns = `34px repeat(${COLUMNS}, 1fr)`
  const byCell = new Map<string, string>()
  for (const n of Object.values(clip.notes)) byCell.set(`${n.pitch}:${n.startTick}`, n.id)

  for (const pitch of PITCHES) {
    const label = document.createElement('div')
    label.className = 'plabel'
    label.textContent = pitchName(pitch)
    grid.appendChild(label)
    for (let col = 0; col < COLUMNS; col++) {
      const startTick = col * PPQ
      const noteId = byCell.get(`${pitch}:${startTick}`)
      const cell = document.createElement('div')
      cell.className = 'cell' + (col % 4 === 0 ? ' beat' : '') + (noteId ? ' on' : '')
      if (noteId) cell.style.background = track.color
      cell.onclick = () => {
        if (noteId) client?.dispatch({ type: 'deleteNote', trackId: track.id, clipId: clip.id, noteId })
        else
          client?.dispatch({
            type: 'addNote',
            trackId: track.id,
            clipId: clip.id,
            note: { id: newId(), pitch, startTick, durationTicks: PPQ, velocity: 100 },
          })
      }
      grid.appendChild(cell)
    }
  }
}

function renderUsers() {
  const el = $('users')
  el.innerHTML = ''
  for (const u of client?.users ?? []) {
    const chip = document.createElement('span')
    chip.style.background = u.color
    chip.textContent = u.id === client?.clientId ? `${u.name} (you)` : u.name
    el.appendChild(chip)
  }
}

// --- History bar: one coloured segment per action (a batch counts as one), each person has their own colour ---
interface Segment {
  seqFrom: number
  seqTo: number
  userId: string
  at: number
  ops: Op[]
  /** Set when this segment is a restore: the step the project was put back to, and how many ops that took. */
  restoreTo?: number
  changes: number
  /** Descriptions are made when the action arrives, so track names are those of that moment. */
  lines: { text: string; detail: string | null }[]
}

const MAX_SEGMENTS = 150
let history: Segment[] = []
let historyTotal = 0
let lastHistorySeq = 0
let freshFrom = Infinity
const trackNames = new Map<string, string>()
/** Name and colour of everyone seen in this session, kept after they leave so their old actions stay coloured. */
const knownUsers = new Map<string, { name: string; color: string }>()

const namesNow = () => ({ tracks: Object.fromEntries([...trackNames].map(([id, name]) => [id, { name }])) })

function addHistory(entries: LogEntry[]) {
  for (const e of entries) {
    if (e.seq <= lastHistorySeq) continue // already shown (e.g. history sent again after a reconnect)
    lastHistorySeq = e.seq
    const last = history[history.length - 1]
    const sameBatch = !!last && last.userId === e.op.clientId && last.at === e.at && last.restoreTo === e.restore
    if (sameBatch && last) {
      // Ops accepted together (one batch, or one restore) share a time and a person: one segment.
      last.seqTo = e.seq
      last.ops.push(e.op)
      last.changes++
      if (e.restore === undefined) last.lines.push({ text: describeOp(e.op, namesNow()), detail: describeDetail(e.op) })
    } else {
      history.push({
        seqFrom: e.seq,
        seqTo: e.seq,
        userId: e.op.clientId,
        at: e.at,
        ops: [e.op],
        restoreTo: e.restore,
        changes: 1,
        lines: [e.restore === undefined
          ? { text: describeOp(e.op, namesNow()), detail: describeDetail(e.op) }
          : { text: e.restore === 0 ? 'restored the original project' : `restored the project to step #${e.restore}`, detail: null }],
      })
      historyTotal++
      freshFrom = Math.min(freshFrom, e.seq)
    }
  }
  if (history.length > MAX_SEGMENTS) history = history.slice(-MAX_SEGMENTS)
  renderHistory()
  fillConfirm()
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The marker at the left end of the bar: the project as it was before anyone did anything. */
const START: Segment = {
  seqFrom: 0, seqTo: 0, userId: '', at: 0, ops: [], changes: 0,
  lines: [{ text: 'The original project, before any action', detail: null }],
}

function showTip(seg: Segment, anchor: HTMLElement) {
  const who = knownUsers.get(seg.userId) ?? { name: 'Someone', color: '#888' }
  const tip = $('tip')
  tip.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'who'
  if (seg.userId !== '') {
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.background = who.color
    const name = document.createElement('span')
    name.textContent = seg.userId === client?.clientId ? `${who.name} (you)` : who.name
    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = `${clock(seg.at)} · #${seg.seqFrom}${seg.seqTo !== seg.seqFrom ? '-' + seg.seqTo : ''}`
    head.append(dot, name, when)
  } else {
    head.textContent = 'Start'
  }
  tip.appendChild(head)

  const shown = seg.lines.slice(0, 5)
  if (seg.lines.length > 1 && seg.restoreTo === undefined) {
    const n = document.createElement('div')
    n.textContent = `${seg.lines.length} changes at once:`
    tip.appendChild(n)
  }
  for (const l of shown) {
    const row = document.createElement('div')
    row.textContent = l.text
    const detail = seg.restoreTo !== undefined ? `${seg.changes} change${seg.changes === 1 ? '' : 's'} applied` : l.detail
    if (detail) {
      const d = document.createElement('span')
      d.className = 'detail'
      d.textContent = ` (${detail})`
      row.appendChild(d)
    }
    tip.appendChild(row)
  }
  if (seg.lines.length > shown.length) {
    const more = document.createElement('div')
    more.className = 'detail'
    more.textContent = `and ${seg.lines.length - shown.length} more`
    tip.appendChild(more)
  }
  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = seg.seqTo >= lastHistorySeq ? 'This is the current state' : 'Click to put the project back to this point'
  tip.appendChild(hint)

  tip.style.visibility = 'hidden'
  tip.style.display = 'block'
  const r = anchor.getBoundingClientRect()
  const w = tip.offsetWidth
  tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`
  tip.style.top = `${r.bottom + 8}px`
  tip.style.visibility = 'visible'
}

// --- Restoring: clicking a segment puts the project back to just after that action (after a confirmation popup) ---
let pendingSeg: Segment | null = null

function hideConfirm() {
  pendingSeg = null
  $('confirm').style.display = 'none'
}

/** Fills the popup from the chosen segment. Called again if more actions arrive while it is open, so the count stays right. */
function fillConfirm() {
  const seg = pendingSeg
  if (!seg) return
  const later = lastHistorySeq - seg.seqTo
  $('confirmTitle').textContent = seg.seqTo === 0 ? 'Go back to the original project?' : `Go back to step #${seg.seqTo}?`

  const who = $('confirmWho')
  who.innerHTML = ''
  if (seg.userId === '') {
    who.textContent = 'The project as it was before anyone did anything.'
  } else {
    const u = knownUsers.get(seg.userId) ?? { name: 'Someone', color: '#888' }
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.background = u.color
    const text = document.createElement('span')
    text.textContent = `The project just after ${u.name} ${seg.lines[0]?.text ?? 'acted'}${seg.lines.length > 1 ? ` (and ${seg.lines.length - 1} more)` : ''}.`
    who.append(dot, text)
  }
  $('confirmText').textContent = `This undoes ${later} later change${later === 1 ? '' : 's'}, made by everyone in the session.`
}

function askRestore(seg: Segment) {
  if (!client || client.status !== 'connected') return
  if (seg.seqTo >= lastHistorySeq) {
    notice('That is already the current state.')
    return
  }
  pendingSeg = seg
  fillConfirm()
  $('confirm').style.display = 'flex'
  $('confirmNo').focus() // the safe choice is the default
}

$('confirmYes').onclick = () => {
  if (pendingSeg) client?.restore(pendingSeg.seqTo)
  hideConfirm()
}
$('confirmNo').onclick = hideConfirm
$('confirm').onclick = (e) => {
  if (e.target === $('confirm')) hideConfirm() // a click on the dimmed background
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pendingSeg) hideConfirm()
})

function renderHistory() {
  const bar = $('historyBar')
  bar.innerHTML = ''
  $('tip').style.display = 'none'
  $('historyCount').textContent = historyTotal ? `${historyTotal} action${historyTotal === 1 ? '' : 's'}` : ''
  if (history.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No actions yet. Everything anyone does in this session will appear here.'
    bar.appendChild(empty)
    return
  }
  const addSeg = (seg: Segment, cls: string, colour: string, user: string) => {
    const el = document.createElement('div')
    el.className = 'seg ' + cls
    el.style.backgroundColor = colour // not `background`, which would wipe the stripes of restore segments
    el.dataset.user = user
    el.dataset.seq = String(seg.seqTo)
    el.onmouseenter = () => showTip(seg, el)
    el.onmouseleave = () => ($('tip').style.display = 'none')
    el.onclick = () => askRestore(seg)
    bar.appendChild(el)
  }
  addSeg(START, 'start', '#5b5b66', '')
  for (const seg of history) {
    const u = knownUsers.get(seg.userId)
    addSeg(
      seg,
      [seg.seqFrom >= freshFrom ? 'fresh' : '', seg.restoreTo !== undefined ? 'restore' : '', seg.seqTo >= lastHistorySeq ? 'current' : ''].join(' ').trim(),
      u?.color ?? '#888',
      u?.name ?? '',
    )
  }
  freshFrom = Infinity
}

function resetHistory() {
  history = []
  historyTotal = 0
  lastHistorySeq = 0
  freshFrom = Infinity
  trackNames.clear()
  knownUsers.clear()
  $('tip').style.display = 'none'
  $('historyCount').textContent = ''
  hideConfirm()
}

function renderCursors() {
  const layer = $('cursors')
  layer.innerHTML = ''
  const origin = $('workspace').getBoundingClientRect()
  for (const u of client?.users ?? []) {
    if (u.id === client?.clientId) continue
    const p = presence.get(u.id)?.pointer
    if (!p) continue
    const el = document.createElement('div')
    el.className = 'cursor'
    el.style.transform = `translate(${origin.left + p.x}px, ${origin.top + p.y}px)`
    el.innerHTML =
      `<svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" ` +
      `fill="${u.color}" stroke="#111" stroke-width="1"/></svg><span style="background:${u.color}"></span>`
    el.querySelector('span')!.textContent = u.name
    layer.appendChild(el)
  }
}

let lastPointerSend = 0
document.addEventListener('pointermove', (e) => {
  if (!client || client.status !== 'connected') return
  const now = performance.now()
  if (now - lastPointerSend < 33) return
  lastPointerSend = now
  const origin = $('workspace').getBoundingClientRect()
  client.setPresence({ pointer: { x: e.clientX - origin.left, y: e.clientY - origin.top } })
})
document.documentElement.addEventListener('pointerleave', () => client?.setPresence({ pointer: null }))

// --- Connecting ---
function setConnectedUi(connected: boolean) {
  for (const id of ['host', 'hostOnline', 'join']) $(id).style.display = connected ? 'none' : ''
  $('end').style.display = connected && isHost ? '' : 'none'
  $('leave').style.display = connected && !isHost ? '' : 'none'
  $('workspace').style.display = connected ? 'flex' : 'none'
  if (!connected) $('info').style.display = 'none'
}

/** Copies text to the clipboard through the app's main process; falls back to the browser's own methods. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (await window.collab.copyText(text)) return true
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const box = document.createElement('textarea')
    box.value = text
    box.style.position = 'fixed'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    const ok = document.execCommand('copy')
    box.remove()
    return ok
  }
}

let copyTimer: ReturnType<typeof setTimeout> | null = null
$('copyCode').onclick = async () => {
  if (!currentCode) return
  const ok = await copyText(currentCode)
  const btn = $('copyCode')
  btn.textContent = ok ? 'Copied!' : 'Copy failed'
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (btn.textContent = 'Copy code'), 1500)
}

/** Puts every part of the window back to how it looks at launch. Server address and token are kept for convenience. */
function resetScreen() {
  resetHistory()
  for (const id of ['tracks', 'grid', 'users', 'historyBar', 'cursors', 'infoText']) $(id).innerHTML = ''
  $('gridTitle').textContent = 'Notes'
  $<HTMLInputElement>('tempo').value = ''
  $<HTMLInputElement>('master').value = '50'
  $<HTMLInputElement>('code').value = ''
  $('notice').style.display = 'none'
  $('copyCode').textContent = 'Copy code'
  for (const id of ['netConn', 'netUsers', 'netPing', 'netMinMax', 'netJitter', 'netLoss', 'netSync', 'netSync95', 'netRate', 'netReconn']) $(id).textContent = '-'
  $('netQuality').textContent = 'no data'
  $('netQuality').className = 'q-unknown'
  const spark = $<HTMLCanvasElement>('netSpark')
  spark.getContext('2d')!.clearRect(0, 0, spark.width, spark.height)
  lastRx = 0
  lastTx = 0
  $('status').textContent = 'Not connected'
}

/** Drops the connection and returns the window to its start screen. `reason` is shown briefly in the notice bar. */
function disconnect(reason?: string) {
  net?.stop()
  net = null
  client?.close()
  client = null
  currentCode = null
  remoteHost = null
  isHost = false
  presence.clear()
  selectedTrackId = null
  setConnectedUi(false)
  resetScreen()
  if (reason) notice(reason)
}

function connect(baseUrl: string, code: string, asHost: boolean) {
  disconnect()
  $('status').textContent = 'Connecting...'
  isHost = asHost
  currentCode = code
  setConnectedUi(true)
  me.name = asHost ? 'Host' : 'Guest ' + Math.floor(Math.random() * 90 + 10)
  renderHistory()

  // The colour is chosen by the server (so no two people match); the one sent here is ignored.
  const c = new CollabClient({ baseUrl, code, name: me.name, color: '#ffffff' })
  client = c
  c.on('change', render)
  c.on('users', (users) => {
    for (const u of users) knownUsers.set(u.id, { name: u.name, color: u.color })
    renderHistory() // segments may have been waiting for a colour
    renderUsers()
    renderCursors()
  })
  c.on('presence', ({ id, state }) => {
    presence.set(id, { pointer: (state as { pointer?: { x: number; y: number } | null } | null)?.pointer ?? null })
    renderCursors()
  })
  c.on('history', (entries: LogEntry[]) => {
    for (const u of c.users) knownUsers.set(u.id, { name: u.name, color: u.color })
    addHistory(entries)
  })
  c.on('entries', (entries: LogEntry[]) => {
    for (const u of c.users) knownUsers.set(u.id, { name: u.name, color: u.color })
    // Tell people when someone else has put the project back, since a lot can change at once.
    const restore = entries.find((e) => e.restore !== undefined && e.op.clientId !== c.clientId && e.seq > lastHistorySeq)
    if (restore) {
      const who = knownUsers.get(restore.op.clientId)?.name ?? 'Someone'
      notice(restore.restore === 0 ? `${who} put the project back to the original.` : `${who} put the project back to just after step #${restore.restore}.`)
    }
    addHistory(entries)
  })
  c.on('refused', ({ reason }) => notice(`Could not restore: ${reason}.`))
  c.on('dropped', (dropped) => {
    const first = dropped[0]!
    const why = first.reason === 'unknown note' || first.reason === 'unknown track or clip' ? 'someone changed it first' : first.reason
    notice(`Your change was not kept (${describeOp(first.op, c.project ?? undefined)}): ${why}.`)
  })
  c.on('status', (s) => {
    $('status').textContent = `${s} · session ${code}`
  })
  c.on('ended', ({ reason }) =>
    disconnect(reason === 'host-ended' ? (asHost ? 'Session ended' : 'The host ended the session') : 'Could not join. Check the address and the code.'),
  )
  c.connect()
  net = new NetStats(baseUrl, c)
}

$('host').onclick = async () => {
  remoteHost = null
  try {
    const info = await window.collab.hostSession(demoProject())
    connect(`ws://127.0.0.1:${info.port}`, info.code, true) // resets the screen first, so fill the info bar after it
    $('info').style.display = 'flex'
    $('infoText').innerHTML = `Session code: <b>${info.code}</b><br>Host address: <b>${info.ip}:${info.port}</b><br>Others join with this IP and code`
  } catch (err) {
    $('status').textContent = `Could not host: ${err instanceof Error ? err.message : err}`
  }
}

// Host on a remote (internet) server: the server address field says where, the token field authorises it.
$('hostOnline').onclick = async () => {
  const addr = parseServerAddress($<HTMLInputElement>('addr').value)
  const token = $<HTMLInputElement>('token').value.trim()
  $('status').textContent = 'Creating online session...'
  try {
    const res = await fetch(`${addr.http}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ project: demoProject() }),
    })
    if (res.status === 401) throw new Error('Wrong access token')
    if (!res.ok) throw new Error(`Server replied ${res.status}`)
    const { code, hostKey } = (await res.json()) as { code: string; hostKey: string }
    connect(addr.ws, code, true)
    remoteHost = { http: addr.http, hostKey }
    $('info').style.display = 'flex'
    $('infoText').innerHTML = `Session code: <b>${code}</b><br>Server: <b>${addr.http}</b><br>Others join with this server address and code`
  } catch (err) {
    const unreachable = err instanceof TypeError // fetch throws TypeError when it cannot connect at all
    $('status').textContent = unreachable
      ? `Cannot reach ${addr.http}. Is the server running, and is the address right?`
      : `Could not create session: ${err instanceof Error ? err.message : err}`
  }
}

$('join').onclick = () => {
  const addr = parseServerAddress($<HTMLInputElement>('addr').value)
  const code = $<HTMLInputElement>('code').value.trim()
  if (!/^\d{6}$/.test(code)) {
    $('status').textContent = 'Enter the 6-digit code'
    return
  }
  connect(addr.ws, code, false)
}

$('end').onclick = async () => {
  if (remoteHost && currentCode) {
    await fetch(`${remoteHost.http}/sessions/${currentCode}`, {
      method: 'DELETE',
      headers: { 'X-Host-Key': remoteHost.hostKey },
    }).catch(() => {})
  } else if (currentCode) {
    await window.collab.endSession(currentCode)
  }
  disconnect('Session ended')
}

$('leave').onclick = () => disconnect('You left the session')

// --- Project controls ---
$('tempo').onchange = () => client?.dispatch({ type: 'setTempo', bpm: Number($<HTMLInputElement>('tempo').value) })
$('master').onchange = () => client?.dispatch({ type: 'setMasterVolume', volume: Number($<HTMLInputElement>('master').value) })
$('addTrack').onclick = () => {
  const project = client?.project
  if (!project) return
  const n = project.trackOrder.length
  const track = createTrack(newId(), `Track ${n + 1}`, 'synth', TRACK_COLORS[n % TRACK_COLORS.length]!, newId())
  client?.dispatch({ type: 'addTrack', track })
}

// --- Network panel ---
const fmtMs = (v: number | undefined) => (v === undefined ? '-' : `${v.toFixed(0)} ms`)
const fmtRate = (bytesPerSec: number) =>
  bytesPerSec >= 1024 ? `${(bytesPerSec / 1024).toFixed(1)} KB/s` : `${bytesPerSec.toFixed(0)} B/s`
let lastRx = 0
let lastTx = 0

function updateNetPanel() {
  if ($('net').style.display !== 'block') return
  if (!net) {
    $('netQuality').textContent = 'no data'
    $('netQuality').className = 'q-unknown'
    return
  }
  const ping = summarize(net.pings)
  const sync = summarize(net.syncs)
  const lastPing = net.pings.at(-1) ?? null
  const q = quality(lastPing)
  $('netQuality').textContent = q === 'unknown' ? 'measuring...' : q
  $('netQuality').className = `q-${q}`
  $('netConn').textContent = net.status
  $('netUsers').textContent = String(net.otherUsers + 1)
  $('netPing').textContent = ping ? `${fmtMs(lastPing ?? undefined)} / ${fmtMs(ping.avg)}` : '-'
  $('netMinMax').textContent = ping ? `${fmtMs(ping.min)} / ${fmtMs(ping.max)}` : '-'
  $('netJitter').textContent = ping ? fmtMs(ping.jitter) : '-'
  $('netLoss').textContent = `${net.pingsLost} of ${net.pingsSent} (${net.lossPercent.toFixed(0)}%)`
  $('netSync').textContent = sync ? `${fmtMs(net.syncs.at(-1))} / ${fmtMs(sync.avg)}` : net.otherUsers ? 'measuring...' : 'needs another user'
  $('netSync95').textContent = sync ? fmtMs(sync.p95) : '-'
  $('netRate').textContent = `${fmtRate(net.rx - lastRx)} / ${fmtRate(net.tx - lastTx)}`
  lastRx = net.rx
  lastTx = net.tx
  $('netReconn').textContent = String(net.reconnects)

  const c = $<HTMLCanvasElement>('netSpark')
  const g = c.getContext('2d')!
  g.clearRect(0, 0, c.width, c.height)
  const pts = net.pings.slice(-40)
  if (pts.length > 1) {
    const max = Math.max(...pts, 1)
    g.strokeStyle = '#4cc9f0'
    g.beginPath()
    pts.forEach((v, i) => {
      const x = (i / 39) * c.width
      const y = c.height - 2 - (v / max) * (c.height - 4)
      i ? g.lineTo(x, y) : g.moveTo(x, y)
    })
    g.stroke()
  }
}
setInterval(updateNetPanel, 1000)

$('netBtn').onclick = () => {
  const open = $('net').style.display === 'block'
  $('net').style.display = open ? 'none' : 'block'
  updateNetPanel()
}

$('netExport').onclick = () => {
  if (!net) return
  const url = URL.createObjectURL(new Blob([net.toCsv()], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `network-${currentCode ?? 'session'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
