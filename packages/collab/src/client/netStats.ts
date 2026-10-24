import type { CollabClient } from './collabClient'
import { quality, summarize } from '../shared/stats'

export interface Sample {
  at: number // epoch ms
  kind: 'ping' | 'sync'
  ms: number
}

const MAX_KEPT = 300
const PING_EVERY_MS = 2000
const PING_TIMEOUT_MS = 5000

/**
 * Collects network measurements for one session:
 *  - ping: round trip to the server over a separate small WebSocket (/ping)
 *  - sync delay: how long a marker sent by another user takes to arrive (one way, via the server),
 *    using a clock offset worked out from the ping replies so two computers' clocks can be compared
 *  - bytes sent / received on the session connection, reconnect count (read from the client)
 */
export class NetStats {
  pings: number[] = []
  syncs: number[] = []
  samples: Sample[] = []
  pingsSent = 0
  pingsLost = 0

  private offset: number | null = null // server clock minus local clock, ms
  private bestRtt = Infinity
  private pingWs: InstanceType<typeof WebSocket> | null = null
  private pending = new Map<number, number>()
  private seq = 0
  private probeSeq = 0
  private lastSeen = new Map<string, number>()
  private timers: ReturnType<typeof setInterval>[] = []
  private running = true
  private unsubscribe: () => void

  /**
   * @param baseUrl server base such as ws://host:4000 (no path)
   * @param WS the WebSocket class for the ping connection (the app's main process passes the `ws` package)
   */
  constructor(
    private baseUrl: string,
    private client: CollabClient,
    private WS: typeof WebSocket = globalThis.WebSocket,
  ) {
    this.openPing()
    this.timers.push(setInterval(() => this.tick(), PING_EVERY_MS))
    this.unsubscribe = client.on('probe', (p) => this.onProbe(p.id, p.seq, p.at))
  }

  get status(): string {
    return this.client.status
  }
  get rx(): number {
    return this.client.bytesIn
  }
  get tx(): number {
    return this.client.bytesOut
  }
  get reconnects(): number {
    return this.client.reconnects
  }
  get otherUsers(): number {
    return Math.max(0, this.client.users.length - 1)
  }
  get lossPercent(): number {
    return this.pingsSent === 0 ? 0 : (this.pingsLost / this.pingsSent) * 100
  }

  /** Server time as best we know it, or null before the first ping reply. */
  private serverNow(): number | null {
    return this.offset === null ? null : Date.now() + this.offset
  }

  private openPing() {
    if (!this.running) return
    const ws = new this.WS(`${this.baseUrl}/ping`)
    this.pingWs = ws
    ws.onmessage = (e) => {
      const r = JSON.parse(String(e.data)) as { id: number; t: number; s: number }
      if (!this.pending.has(r.id)) return
      this.pending.delete(r.id)
      const rtt = performance.now() - r.t
      this.record('ping', rtt)
      // The reply with the shortest trip gives the most trustworthy clock offset.
      if (rtt < this.bestRtt) {
        this.bestRtt = rtt
        this.offset = r.s + rtt / 2 - Date.now()
      }
    }
    ws.onclose = () => {
      if (this.pingWs === ws) this.pingWs = null
      if (this.running) setTimeout(() => this.openPing(), PING_EVERY_MS)
    }
  }

  private tick() {
    const now = performance.now()
    for (const [id, sentAt] of this.pending) {
      if (now - sentAt > PING_TIMEOUT_MS) {
        this.pending.delete(id)
        this.pingsLost++
      }
    }
    if (this.pingWs?.readyState === 1 /* OPEN */) {
      const id = ++this.seq
      this.pending.set(id, now)
      this.pingsSent++
      this.pingWs.send(JSON.stringify({ id, t: now }))
    }
    // Marker for other users: they compare its server-time stamp with their own arrival time.
    const t = this.serverNow()
    if (t !== null) this.client.sendProbe(++this.probeSeq, t)
  }

  private onProbe(from: string, seq: number, at: number) {
    const now = this.serverNow()
    if (now === null || this.lastSeen.get(from) === seq) return
    this.lastSeen.set(from, seq)
    const ms = now - at
    if (Math.abs(ms) < 60_000) this.record('sync', ms)
  }

  private record(kind: Sample['kind'], ms: number) {
    const list = kind === 'ping' ? this.pings : this.syncs
    list.push(ms)
    if (list.length > MAX_KEPT) list.shift()
    this.samples.push({ at: Date.now(), kind, ms })
  }

  toCsv(): string {
    const rows = this.samples.map((s) => `${new Date(s.at).toISOString()},${s.kind},${s.ms.toFixed(2)}`)
    return ['time,kind,ms', ...rows].join('\n') + '\n'
  }

  /** Everything the Network panel shows, taken at one moment. */
  snapshot() {
    const ping = summarize(this.pings)
    const sync = summarize(this.syncs)
    const lastPing = this.pings.at(-1) ?? null
    return {
      at: Date.now(),
      status: this.status,
      users: this.otherUsers + 1,
      quality: quality(lastPing),
      pingLast: lastPing,
      ping,
      sync,
      syncLast: this.syncs.at(-1) ?? null,
      pingsSent: this.pingsSent,
      pingsLost: this.pingsLost,
      lossPercent: this.lossPercent,
      rx: this.rx,
      tx: this.tx,
      reconnects: this.reconnects,
      recentPings: this.pings.slice(-40),
    }
  }

  stop() {
    this.running = false
    this.timers.forEach(clearInterval)
    this.unsubscribe()
    this.pingWs?.close()
  }
}
