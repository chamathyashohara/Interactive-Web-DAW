import { stamp, type OpBody, type Project } from '../daw-shared'
import { SESSION_ENDED } from '../shared/types'
import type { ClientMsg, LogEntry, ServerMsg, UserInfo } from '../shared/protocol'
import { Replica, type Dropped } from './replica'

export type ClientStatus = 'connecting' | 'connected' | 'disconnected' | 'ended';
export type DispatchResult = { ok: true } | { ok: false; reason: string };

export interface ProbeMsg {
  id: string;
  seq: number;
  at: number;
}

interface Events {
  /** The project the user sees changed (their own edit, or someone else's). */
  change: Project;
  status: ClientStatus;
  users: UserInfo[];
  /** Accepted ops, in the server's order, as they happen. */
  entries: LogEntry[];
  /** Actions that happened before this app joined, sent once on joining. */
  history: LogEntry[];
  /** A request such as a restore was refused by the server. */
  refused: { reason: string };
  /** Edits of this user that did not survive (rejected by the server, or overridden by someone else's). */
  dropped: Dropped[];
  presence: { id: string; state: Record<string, unknown> | null };
  probe: ProbeMsg;
  /** The session ended (host closed it) or could not be joined. */
  ended: { reason: 'host-ended' | 'cannot-join' };
}

type Handler<K extends keyof Events> = (value: Events[K]) => void;

export interface ClientOptions {
  /** Server base, e.g. ws://192.168.1.5:4000 or wss://name.trycloudflare.com (no path). */
  baseUrl: string;
  code: string;
  name: string;
  color: string;
  clientId?: string;
  /** Override for tests; defaults to the global WebSocket (browser and Node 22+). */
  WebSocketImpl?: typeof WebSocket;
}

const MAX_FIRST_TRIES = 3;

export const newId = (): string => {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/**
 * Live connection to one session. Owns the socket, reconnects automatically, and keeps a `Replica`
 * so the user's own edits show at once while the server decides the final order.
 */
export class CollabClient {
  readonly clientId: string;
  status: ClientStatus = 'connecting';
  users: UserInfo[] = [];
  reconnects = 0;
  bytesIn = 0;
  bytesOut = 0;

  private replica: Replica | null = null;
  private ws: WebSocket | null = null;
  private listeners: { [K in keyof Events]?: Handler<K>[] } = {};
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private everConnected = false;
  private stopped = false;
  /** Set after falling out of step: the next hello asks for a full snapshot instead of a catch-up. */
  private forceSnapshot = false;
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: ClientOptions) {
    this.clientId = opts.clientId ?? newId();
    this.WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  }

  on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
    ((this.listeners[event] ??= []) as Handler<K>[]).push(handler);
    return () => {
      this.listeners[event] = (this.listeners[event] as Handler<K>[]).filter((h) => h !== handler) as never;
    };
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]) {
    for (const h of (this.listeners[event] ?? []) as Handler<K>[]) h(value);
  }

  /** The project as this user sees it (confirmed edits plus their own unconfirmed ones). */
  get project(): Project | null {
    return this.replica?.view ?? null;
  }
  /** How many ops of the server's order this app has applied. */
  get seq(): number {
    return this.replica?.seq ?? 0;
  }
  get pendingCount(): number {
    return this.replica?.pendingBatches.reduce((n, b) => n + b.length, 0) ?? 0;
  }

  connect() {
    this.stopped = false;
    this.setStatus('connecting');
    const ws = new this.WS(`${this.opts.baseUrl}/ops/${this.opts.code}`);
    this.ws = ws;

    ws.onopen = () =>
      this.send({
        t: 'hello',
        clientId: this.clientId,
        name: this.opts.name,
        color: this.opts.color,
        lastSeq: this.replica && !this.forceSnapshot ? this.replica.seq : null,
      });
    ws.onmessage = (e) => {
      const text = String(e.data);
      this.bytesIn += text.length;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(text) as ServerMsg;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === SESSION_ENDED) {
        this.stopped = true;
        this.setStatus('ended');
        this.emit('ended', { reason: 'host-ended' });
        return;
      }
      if (this.stopped) return;
      this.setStatus('disconnected');
      if (!this.everConnected && ++this.attempts >= MAX_FIRST_TRIES) {
        this.stopped = true;
        this.setStatus('ended');
        this.emit('ended', { reason: 'cannot-join' });
        return;
      }
      this.retryTimer = setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** Math.min(this.attempts, 4)));
    };
    ws.onerror = () => {
      /* onclose follows and handles it */
    };
  }

  close() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus('ended');
  }

  dispatch(body: OpBody): DispatchResult {
    return this.dispatchBatch([body]);
  }

  /** Applies a group of edits as one all-or-nothing step. Shows at once; the server confirms or refuses. */
  dispatchBatch(bodies: OpBody[]): DispatchResult {
    if (!this.replica) return { ok: false, reason: 'not connected to the session yet' };
    if (bodies.length === 0) return { ok: true };
    const ops = bodies.map((b) => stamp(b, newId(), this.clientId));
    const r = this.replica.localApply(ops);
    if (!r.ok) return r;
    this.emit('change', this.replica.view);
    this.send({ t: 'ops', ops });
    return { ok: true };
  }

  setPresence(state: Record<string, unknown> | null) {
    this.send({ t: 'presence', state });
  }

  /** Asks the server to put the project back to how it was just after step `toSeq` (0 = the original). */
  restore(toSeq: number) {
    this.send({ t: 'restore', toSeq });
  }

  sendProbe(seq: number, at: number) {
    this.send({ t: 'probe', seq, at });
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState !== 1) return;
    const text = JSON.stringify(msg);
    this.bytesOut += text.length;
    this.ws.send(text);
  }

  private setStatus(s: ClientStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  private handle(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome': {
        if (this.everConnected) this.reconnects++;
        this.everConnected = true;
        this.attempts = 0;
        this.forceSnapshot = false;
        this.users = msg.users;
        let dropped: Dropped[] = [];
        if (msg.project) {
          if (this.replica) dropped = this.replica.resetTo(msg.project, msg.seq);
          else this.replica = new Replica(msg.project, msg.seq);
        } else if (this.replica) {
          for (const entry of msg.entries ?? []) {
            const r = this.replica.receive(entry);
            dropped.push(...r.dropped);
            if (r.status === 'gap' || r.status === 'diverged') return this.resync();
          }
          if (msg.entries?.length) this.emit('entries', msg.entries);
        }
        this.setStatus('connected');
        this.emit('users', this.users);
        if (dropped.length) this.emit('dropped', dropped);
        if (this.replica) {
          this.emit('change', this.replica.view);
          if (msg.history?.length) this.emit('history', msg.history);
          // Anything not confirmed before the connection dropped is sent again; the server skips repeats.
          for (const ops of this.replica.pendingBatches) this.send({ t: 'ops', ops });
        }
        return;
      }
      case 'entries': {
        if (!this.replica) return;
        const dropped: Dropped[] = [];
        for (const entry of msg.entries) {
          const r = this.replica.receive(entry);
          dropped.push(...r.dropped);
          if (r.status === 'gap' || r.status === 'diverged') return this.resync();
        }
        this.emit('entries', msg.entries);
        this.emit('change', this.replica.view);
        if (dropped.length) this.emit('dropped', dropped);
        return;
      }
      case 'reject': {
        if (!this.replica) return;
        const dropped = this.replica.reject(msg.opIds, msg.reason);
        if (msg.reason !== 'duplicate' || dropped.length) this.emit('change', this.replica.view);
        if (dropped.length && msg.reason !== 'duplicate') this.emit('dropped', dropped);
        return;
      }
      case 'refused':
        return this.emit('refused', { reason: msg.reason });
      case 'users':
        this.users = msg.users;
        return this.emit('users', msg.users);
      case 'presence':
        return this.emit('presence', { id: msg.id, state: msg.state });
      case 'probe':
        return this.emit('probe', { id: msg.id, seq: msg.seq, at: msg.at });
    }
  }

  /** The copy fell out of step with the server (should not happen): reconnect and take a fresh catch-up. */
  private resync() {
    this.forceSnapshot = true;
    this.ws?.close();
  }
}
