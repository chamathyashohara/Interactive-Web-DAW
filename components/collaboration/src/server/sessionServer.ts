import http from 'node:http'
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { Room } from './room'
import { buildSeedProject } from '../shared/seed'
import { SESSION_ENDED } from '../shared/types'
import { USER_COLORS } from '../shared/palette'
import type { ClientMsg, ServerMsg, UserInfo } from '../shared/protocol'

export { SESSION_ENDED }

export interface ServerOptions {
  /** If set, creating a session over HTTP needs "Authorization: Bearer <token>". Joining stays code-only. */
  authToken?: string
  /** Failed join attempts allowed per IP per minute before it is blocked for the rest of that minute. */
  maxFailedJoinsPerMinute?: number
}

export interface SessionServer {
  port: number
  /** Creates a session. `seed` is the host's project; it is validated, and an invalid one throws. */
  createSession(seed?: unknown): string
  /** Disconnects everyone in the session and forgets it. Returns false if it did not exist. */
  endSession(code: string): boolean
  /** The room behind a code, for tests and diagnostics. */
  roomFor(code: string): Room | undefined
  close(): Promise<void>
}

interface Conn {
  ws: WebSocket
  id: string
  name: string
  color: string
  joined: boolean
}

interface Session {
  room: Room
  /** Secret only the creator over HTTP knows; needed to end the session remotely. Empty for local sessions. */
  hostKey: string
  conns: Set<Conn>
  /** Colour given to each person (by client id) the first time they join; kept if they reconnect. */
  colors: Map<string, string>
}

const MAX_BODY = 1 << 20

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function startSessionServer(port: number, opts: ServerOptions = {}): Promise<SessionServer> {
  const maxFailed = opts.maxFailedJoinsPerMinute ?? 20
  const sessions = new Map<string, Session>()
  const failedJoins = new Map<string, { count: number; resetAt: number }>()

  const createSession = (seed?: unknown, hostKey = '') => {
    let code: string
    do code = String(randomInt(100000, 1000000))
    while (sessions.has(code))
    const built = buildSeedProject(seed, randomUUID())
    if (!built.ok) throw new Error(built.reason)
    sessions.set(code, { room: new Room(built.project), hostKey, conns: new Set(), colors: new Map() })
    return code
  }

  const send = (c: Conn, msg: ServerMsg) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg))
  }
  const broadcast = (s: Session, msg: ServerMsg, except?: Conn) => {
    const text = JSON.stringify(msg)
    for (const c of s.conns) if (c.joined && c !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(text)
  }
  const usersOf = (s: Session): UserInfo[] => [...s.conns].filter((c) => c.joined).map(({ id, name, color }) => ({ id, name, color }))

  const endSession = (code: string) => {
    const s = sessions.get(code)
    if (!s) return false
    sessions.delete(code)
    s.conns.forEach((c) => c.ws.close(SESSION_ENDED, 'session-ended'))
    return true
  }

  const isBlocked = (ip: string) => {
    const f = failedJoins.get(ip)
    return !!f && Date.now() < f.resetAt && f.count >= maxFailed
  }
  const recordFailure = (ip: string) => {
    const now = Date.now()
    const f = failedJoins.get(ip)
    if (!f || now >= f.resetAt) failedJoins.set(ip, { count: 1, resetAt: now + 60_000 })
    else f.count++
  }

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  const readJson = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) {
          reject(new Error('body too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('body is not valid JSON'))
        }
      })
      req.on('error', reject)
    })

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Host-Key')
    if (req.method === 'OPTIONS') return json(res, 204, {})

    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, sessions: sessions.size })

    if (req.method === 'POST' && url === '/sessions') {
      if (opts.authToken) {
        const given = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        if (!safeEqual(given, opts.authToken)) return json(res, 401, { error: 'unauthorized' })
      }
      readJson(req)
        .then((body) => {
          const hostKey = randomBytes(16).toString('hex')
          let code: string
          try {
            code = createSession((body as { project?: unknown }).project, hostKey)
          } catch (err) {
            return json(res, 400, { error: err instanceof Error ? err.message : 'invalid project' })
          }
          json(res, 201, { code, hostKey })
        })
        .catch((err: Error) => json(res, 400, { error: err.message }))
      return
    }

    const m = url.match(/^\/sessions\/(\d{6})$/)
    if (m && req.method === 'GET') return json(res, sessions.has(m[1]) ? 200 : 404, { exists: sessions.has(m[1]) })
    if (m && req.method === 'DELETE') {
      const s = sessions.get(m[1])
      if (!s) return json(res, 404, { error: 'no such session' })
      const given = String(req.headers['x-host-key'] ?? '')
      if (!s.hostKey || !safeEqual(given, s.hostKey)) return json(res, 403, { error: 'forbidden' })
      endSession(m[1])
      return json(res, 200, { ended: true })
    }

    json(res, 404, { error: 'not found' })
  })

  // /ops/<code>: the live session connection.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })
  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, code: string) => {
    const s = sessions.get(code)
    if (!s) return ws.close(SESSION_ENDED, 'session-ended')
    const conn: Conn = { ws, id: '', name: 'Guest', color: '#4cc9f0', joined: false }
    s.conns.add(conn)

    ws.on('message', (data) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(data)) as ClientMsg
      } catch {
        return
      }
      if (!msg || typeof msg.t !== 'string') return

      if (msg.t === 'hello') {
        if (conn.joined) return
        if (typeof msg.clientId !== 'string' || msg.clientId.length < 8 || msg.clientId.length > 64) return ws.close(1008, 'bad client id')
        // A reconnecting client may arrive before its old socket is noticed as dead.
        for (const other of s.conns) if (other !== conn && other.id === msg.clientId) other.ws.terminate()
        conn.id = msg.clientId
        conn.name = String(msg.name ?? 'Guest').trim().slice(0, 24) || 'Guest'
        // The server picks the colour so two people never look alike (the colour in `hello` is ignored).
        if (!s.colors.has(conn.id)) s.colors.set(conn.id, USER_COLORS[s.colors.size % USER_COLORS.length]!)
        conn.color = s.colors.get(conn.id)!
        conn.joined = true

        const entries = s.room.entriesSince(msg.lastSeq)
        send(conn, {
          t: 'welcome',
          seq: s.room.seq,
          ...(entries ? { entries } : { project: s.room.project, history: s.room.recent() }),
          users: usersOf(s),
        })
        broadcast(s, { t: 'users', users: usersOf(s) }, conn)
        return
      }

      if (!conn.joined) return

      if (msg.t === 'ops') {
        const result = s.room.submit(conn.id, msg.ops)
        if (!result.ok) return send(conn, { t: 'reject', opIds: result.opIds, reason: result.reason })
        if (result.duplicates.length) send(conn, { t: 'reject', opIds: result.duplicates, reason: 'duplicate' })
        if (result.entries.length) broadcast(s, { t: 'entries', entries: result.entries })
      } else if (msg.t === 'restore') {
        const result = s.room.restoreTo(conn.id, msg.toSeq)
        if (!result.ok) return send(conn, { t: 'refused', reason: result.reason })
        broadcast(s, { t: 'entries', entries: result.entries })
      } else if (msg.t === 'presence') {
        if (JSON.stringify(msg.state ?? null).length > 512) return
        broadcast(s, { t: 'presence', id: conn.id, state: msg.state ?? null }, conn)
      } else if (msg.t === 'probe') {
        if (typeof msg.seq !== 'number' || typeof msg.at !== 'number') return
        broadcast(s, { t: 'probe', id: conn.id, seq: msg.seq, at: msg.at }, conn)
      }
    })

    ws.on('close', () => {
      s.conns.delete(conn)
      if (conn.joined && sessions.get(code) === s) {
        broadcast(s, { t: 'presence', id: conn.id, state: null })
        broadcast(s, { t: 'users', users: usersOf(s) })
      }
    })
  })

  // /ping: answers each small JSON message with the server's clock, so apps can measure round-trip time.
  const pingWss = new WebSocketServer({ noServer: true, maxPayload: 256 })
  pingWss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(String(data)) as { id: number; t: number }
        ws.send(JSON.stringify({ id: m.id, t: m.t, s: Date.now() }))
      } catch {
        /* ignore malformed pings */
      }
    })
  })

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ping') {
      pingWss.handleUpgrade(req, socket, head, (ws) => pingWss.emit('connection', ws))
      return
    }
    // Behind a proxy (Caddy, Cloudflare, ...) the real client IP is in a header.
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    const ip = fwd || req.socket.remoteAddress || 'unknown'
    const m = req.url?.match(/^\/ops\/(\d{6})$/)
    if (isBlocked(ip) || !m || !sessions.has(m[1])) {
      if (!isBlocked(ip)) recordFailure(ip)
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, m[1]))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      resolve({
        port,
        createSession: (seed) => createSession(seed),
        endSession,
        roomFor: (code) => sessions.get(code)?.room,
        close: () =>
          new Promise<void>((r) => {
            wss.clients.forEach((c) => c.terminate())
            pingWss.clients.forEach((c) => c.terminate())
            server.close(() => r())
          }),
      })
    })
  })
}
