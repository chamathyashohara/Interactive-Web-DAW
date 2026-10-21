import { CollabClient, newId } from '../client/collabClient'
import { NetStats } from './netstats'
import { describeOp } from '../shared/describe'
import { quality, summarize } from '../shared/stats'
import { parseServerAddress } from '../shared/serverAddress'
import type { HostInfo } from '../shared/types'
import type { LogEntry, UserInfo } from '../shared/protocol'
import { createProject, createTrack, MAX_TRACKS, PPQ, TRACK_COLORS, type Project, type Track } from '../daw-shared'

declare global {
  interface Window {
    collab: { hostSession(seed: unknown): Promise<HostInfo>; endSession(code: string): Promise<boolean>; copyText(text: string): Promise<boolean> }
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const GUEST_COLORS = ['#4cc9f0', '#b5179e', '#80ed99', '#ff6b6b', '#c77dff']
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
let activity: { seq: number; user: UserInfo | null; text: string }[] = []
let noticeTimer: ReturnType<typeof setTimeout> | null = null
const presence = new Map<string, { pointer?: { x: number; y: number } | null }>()
const me = { name: 'Host', color: '#ff4d8d' }

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

function renderActivity() {
  const el = $('activity')
  el.innerHTML = ''
  for (const a of activity.slice(0, 14)) {
    const row = document.createElement('div')
    row.style.borderLeftColor = a.user?.color ?? '#888'
    row.innerHTML = `<b></b> <span></span> <small>#${a.seq}</small>`
    row.querySelector('b')!.textContent = a.user?.name ?? 'Someone'
    row.querySelector('span')!.textContent = a.text
    el.appendChild(row)
  }
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
  for (const id of ['tracks', 'grid', 'users', 'activity', 'cursors', 'infoText']) $(id).innerHTML = ''
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
  activity = []
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
  Object.assign(me, asHost
    ? { name: 'Host', color: '#ff4d8d' }
    : { name: 'Guest ' + Math.floor(Math.random() * 90 + 10), color: GUEST_COLORS[Math.floor(Math.random() * GUEST_COLORS.length)]! })

  const c = new CollabClient({ baseUrl, code, name: me.name, color: me.color })
  client = c
  c.on('change', render)
  c.on('users', () => {
    renderUsers()
    renderCursors()
  })
  c.on('presence', ({ id, state }) => {
    presence.set(id, { pointer: (state as { pointer?: { x: number; y: number } | null } | null)?.pointer ?? null })
    renderCursors()
  })
  c.on('entries', (entries: LogEntry[]) => {
    for (const e of entries) {
      activity.unshift({ seq: e.seq, user: c.users.find((u) => u.id === e.op.clientId) ?? null, text: describeOp(e.op, c.project ?? undefined) })
    }
    activity = activity.slice(0, 50)
    renderActivity()
  })
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
