import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { computeMetrics, type Metrics, type OpBody, type Project, type TelemetryEvent } from "@daw/shared";
import { opEvents, projectSummary, RedNoteTracker, type EventData } from "./opEvents";

export interface TelemetryState {
  consented: boolean;
  participantCode: string | null;
  events: number;
  session: string;
}
export interface ExportBundle {
  participant: string;
  exportedAt: number;
  events: TelemetryEvent[];
  metrics: Metrics;
}

const CODE = /^[A-Za-z0-9_-]{2,24}$/;
const MAX_FIELDS = 12;
const RESERVED = new Set(["t", "at", "s", "mode"]);

/**
 * The evaluation log. Nothing is recorded until the participant has agreed (and typed an anonymous code), and everything stays on this
 * computer until they export it. Events hold no names, paths or song content (see opEvents). No Electron imports, so it is testable in plain Node.
 */
export class TelemetryStore {
  readonly session: string;
  private consentInfo: { consented: boolean; participantCode: string | null; at: number } = { consented: false, participantCode: null, at: 0 };
  private count = 0;
  private readonly tracker = new RedNoteTracker();
  private fixNext = false;

  constructor(
    private readonly dir: string,
    private readonly mode: () => "beginner" | "all",
    private readonly now: () => number = () => Date.now(),
  ) {
    this.session = randomUUID().slice(0, 8);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const raw = JSON.parse(fs.readFileSync(this.consentFile, "utf8"));
      if (raw.consented === true && CODE.test(raw.participantCode)) this.consentInfo = { consented: true, participantCode: raw.participantCode, at: Number(raw.at) || 0 };
    } catch {
      /* no consent yet */
    }
    this.count = this.readEvents().length;
    if (this.consentInfo.consented) this.record("session.started", {});
  }

  private get consentFile() {
    return path.join(this.dir, "research-consent.json");
  }
  private get eventsFile() {
    return path.join(this.dir, "research-events.ndjson");
  }

  state(): TelemetryState {
    return { consented: this.consentInfo.consented, participantCode: this.consentInfo.participantCode, events: this.count, session: this.session };
  }

  /** Starts recording. The code is anonymous (letters, digits, - and _; 2-24 characters), given by the researcher, never a name. */
  consent(code: unknown): { ok: true; state: TelemetryState } | { ok: false; reason: string } {
    if (typeof code !== "string" || !CODE.test(code.trim())) return { ok: false, reason: "The participant code must be 2-24 letters, digits, - or _ (not a name)." };
    this.consentInfo = { consented: true, participantCode: code.trim(), at: this.now() };
    fs.writeFileSync(this.consentFile, JSON.stringify({ ...this.consentInfo, version: 1 }, null, 2));
    this.record("consent.given", {});
    this.record("session.started", {});
    return { ok: true, state: this.state() };
  }

  /** Stops recording. `deleteData` also erases everything recorded so far on this computer. */
  withdraw(deleteData: boolean): TelemetryState {
    this.consentInfo = { consented: false, participantCode: null, at: 0 };
    try {
      fs.rmSync(this.consentFile, { force: true });
      if (deleteData) fs.rmSync(this.eventsFile, { force: true });
    } catch {
      /* ignore */
    }
    if (deleteData) this.count = 0;
    this.tracker.clear();
    return this.state();
  }

  /** Appends one event if the participant has consented. Only short plain values are kept. */
  record(t: string, data: EventData = {}) {
    if (!this.consentInfo.consented || typeof t !== "string" || !/^[a-z][a-z0-9._]{0,40}$/i.test(t)) return;
    const clean: EventData = {};
    for (const [k, v] of Object.entries(data).slice(0, MAX_FIELDS)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,20}$/.test(k) || RESERVED.has(k)) continue;
      if (typeof v === "string") clean[k] = v.slice(0, 60);
      else if (typeof v === "number" && Number.isFinite(v)) clean[k] = Math.round(v * 1000) / 1000;
      else if (typeof v === "boolean" || v === null) clean[k] = v;
    }
    try {
      fs.appendFileSync(this.eventsFile, JSON.stringify({ t, at: this.now(), s: this.session, mode: this.mode(), ...clean }) + "\n");
      this.count++;
    } catch {
      /* recording must never break the app */
    }
  }

  /** Called after a successful edit with the project as it was before it. */
  recordOps(before: Project, bodies: OpBody[]) {
    if (!this.consentInfo.consented) return;
    const viaFix = this.fixNext;
    this.fixNext = false;
    for (const e of opEvents(before, bodies, this.tracker, this.now(), viaFix)) this.record(e.t, e.data);
  }

  /** The window says the next edit is the Fix button (it moves every red note into the key). */
  expectFix() {
    this.fixNext = true;
  }

  recordSummary(project: Project) {
    this.record("project.summary", projectSummary(project));
  }

  readEvents(): TelemetryEvent[] {
    try {
      return fs
        .readFileSync(this.eventsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as TelemetryEvent);
    } catch {
      return [];
    }
  }

  /**
   * Everything recorded plus the lesson log (lessons completed, mode changes) from the progress folder, merged in time order,
   * with the metrics computed from it. Lesson events from before consent are left out.
   */
  buildExport(progressEventsFile: string | null): ExportBundle | null {
    if (!this.consentInfo.consented) return null;
    const events = this.readEvents();
    if (progressEventsFile) {
      try {
        for (const line of fs.readFileSync(progressEventsFile, "utf8").split("\n").filter(Boolean)) {
          const e = JSON.parse(line) as { t?: string; at?: number; [k: string]: unknown };
          if (typeof e.t !== "string" || typeof e.at !== "number" || e.at < this.consentInfo.at) continue;
          const clean: TelemetryEvent = { t: e.t, at: e.at, src: "lessons" };
          for (const [k, v] of Object.entries(e)) if (k !== "t" && k !== "at" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) clean[k] = v;
          events.push(clean);
        }
      } catch {
        /* no lesson log yet */
      }
    }
    events.sort((a, b) => a.at - b.at);
    return { participant: this.consentInfo.participantCode!, exportedAt: this.now(), events, metrics: computeMetrics(events) };
  }
}
