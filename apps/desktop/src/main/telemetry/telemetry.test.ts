import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOp, createProject, type Op, type OpBody, type Project } from "@daw/shared";
import { TelemetryStore } from "./telemetryStore";

let dir: string;
let clock: number;
let mode: "beginner" | "all";
const make = () => new TelemetryStore(dir, () => mode, () => clock);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daw-telemetry-"));
  clock = 1_000_000;
  mode = "beginner";
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
const apply = (p: Project, b: OpBody): Project => {
  const r = applyOp(p, { ...b, opId: `t${++n}`, clientId: "c" } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};
const inC = (): Project => apply(createProject("p"), { type: "setKey", key: { tonic: 0, mode: "major" } });
const addNote = (id: string, pitch: number): OpBody => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id, pitch, startTick: 0, durationTicks: 240, velocity: 100 } });

describe("consent", () => {
  it("records nothing until the participant has agreed", () => {
    const s = make();
    s.record("ui.tool", { tool: "draw" });
    s.recordOps(inC(), [addNote("a", 60)]);
    expect(s.readEvents()).toEqual([]);
    expect(s.state()).toMatchObject({ consented: false, participantCode: null, events: 0 });
  });
  it("needs an anonymous code, not a name or an address", () => {
    const s = make();
    expect(s.consent("Maria Perera").ok).toBe(false);
    expect(s.consent("a@b.com").ok).toBe(false);
    expect(s.consent("").ok).toBe(false);
    expect(s.consent("P07").ok).toBe(true);
    expect(s.state()).toMatchObject({ consented: true, participantCode: "P07" });
  });
  it("starts recording at the moment of consent and remembers consent after a restart", () => {
    const s = make();
    s.consent("P07");
    s.record("ui.tool", { tool: "draw" });
    expect(s.readEvents().map((e) => e.t)).toEqual(["consent.given", "session.started", "ui.tool"]);
    const again = make();
    expect(again.state()).toMatchObject({ consented: true, participantCode: "P07" });
    expect(again.readEvents().at(-1)!.t).toBe("session.started");
  });
  it("withdrawing stops recording, and can erase everything recorded", () => {
    const s = make();
    s.consent("P07");
    s.record("ui.tool", { tool: "draw" });
    s.withdraw(false);
    s.record("ui.tool", { tool: "paint" });
    expect(s.readEvents().length).toBe(3); // kept, but nothing new
    expect(make().state().consented).toBe(false);
    const t = make();
    t.consent("P07");
    t.withdraw(true);
    expect(t.readEvents()).toEqual([]);
    expect(t.state().events).toBe(0);
  });
});

describe("what is recorded", () => {
  it("tags every event with the session and the study condition at that moment", () => {
    const s = make();
    s.consent("P07");
    mode = "all";
    clock += 5000;
    s.record("ui.tool", { tool: "select" });
    const e = s.readEvents().at(-1)!;
    expect(e).toMatchObject({ t: "ui.tool", tool: "select", mode: "all", at: clock, s: s.session });
  });
  it("keeps only short plain values and refuses reserved or odd field names", () => {
    const s = make();
    s.consent("P07");
    s.record("ui.tool", { tool: "x".repeat(200), at: 5, mode: "hacked", "bad key!": "x", ok: true, nothing: null } as never);
    s.record("not valid!", {});
    const e = s.readEvents().at(-1)!;
    expect((e.tool as string).length).toBe(60);
    expect(e.at).toBe(clock);
    expect(e.mode).toBe("beginner");
    expect(e["bad key!"]).toBeUndefined();
    expect(e.ok).toBe(true);
    expect(s.readEvents().some((x) => x.t === "not valid!")).toBe(false);
  });
});

describe("edit events", () => {
  it("counts edits by kind and says whether a note was in the key, never what it was", () => {
    const s = make();
    s.consent("P07");
    s.recordOps(inC(), [addNote("a", 60), addNote("b", 61)]);
    const ev = s.readEvents();
    expect(ev.filter((e) => e.t === "note.added").map((e) => e.inKey)).toEqual([true, false]);
    expect(ev.find((e) => e.t === "edit")).toMatchObject({ op: "addNote", n: 2, batch: true });
    const raw = fs.readFileSync(path.join(dir, "research-events.ndjson"), "utf8");
    expect(raw).not.toMatch(/pitch|startTick|"60"|"61"|track-1|clip-1/);
  });
  it("does not judge notes when no key is set or on drum tracks", () => {
    const s = make();
    s.consent("P07");
    s.recordOps(createProject("p"), [addNote("a", 61)]);
    expect(s.readEvents().find((e) => e.t === "note.added")!.inKey).toBeNull();
  });
  it("measures how long a red note stays before the learner fixes it, by hand, with the Fix button, or by deleting it", () => {
    const s = make();
    s.consent("P07");
    let p = inC();
    s.recordOps(p, [addNote("a", 61), addNote("b", 63), addNote("c", 66), addNote("d", 68)]); // C#, D#, F#, G# are all outside C major
    p = [addNote("a", 61), addNote("b", 63), addNote("c", 66), addNote("d", 68)].reduce(apply, p);
    clock += 4000;
    s.recordOps(p, [{ type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "a", changes: { pitch: 60 } }]);
    clock += 3000;
    s.expectFix();
    s.recordOps(p, [
      { type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "b", changes: { pitch: 62 } },
      { type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "c", changes: { pitch: 65 } },
    ]);
    clock += 1000;
    s.recordOps(p, [{ type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: "d" }]);
    const fixes = s.readEvents().filter((e) => e.t === "note.corrected");
    expect(fixes.map((e) => [e.via, e.ms])).toEqual([["manual", 4000], ["fix", 7000], ["fix", 7000], ["removed", 8000]]);
  });
  it("a note moved to another red pitch is still waiting to be fixed", () => {
    const s = make();
    s.consent("P07");
    let p = inC();
    s.recordOps(p, [addNote("a", 61)]);
    p = apply(p, addNote("a", 61));
    s.recordOps(p, [{ type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "a", changes: { pitch: 63 } }]);
    expect(s.readEvents().some((e) => e.t === "note.corrected")).toBe(false);
  });
  it("describes track edits by what changed, not by value or name", () => {
    const s = make();
    s.consent("P07");
    s.recordOps(createProject("p"), [{ type: "updateTrack", trackId: "track-1", changes: { mute: true } }]);
    expect(s.readEvents().find((e) => e.t === "edit")).toMatchObject({ op: "updateTrack", fields: "mute" });
  });
  it("writes a summary of the song as counts only", () => {
    const s = make();
    s.consent("P07");
    s.recordSummary([addNote("a", 60), addNote("b", 61)].reduce(apply, inC()));
    expect(s.readEvents().at(-1)).toMatchObject({ t: "project.summary", tracks: 1, notes: 2, outOfKey: 1, keyed: true, bars: 8 });
  });
});

describe("export", () => {
  it("is not available before consent", () => expect(make().buildExport(null)).toBeNull());
  it("merges the lesson log from after consent, in time order, and adds the numbers", () => {
    const lessons = path.join(dir, "progress-events.ndjson");
    fs.writeFileSync(lessons, [{ t: "lesson.completed", lessonId: "M0.4", at: clock - 10 }, { t: "lesson.completed", lessonId: "M8.2", at: clock + 9000 }, { t: "mode.changed", mode: "beginner", at: clock + 100 }].map((e) => JSON.stringify(e)).join("\n"));
    const s = make();
    clock += 1;
    s.consent("P07");
    clock += 5000;
    s.recordOps(inC(), [{ type: "setLoop", loop: { startTick: 0, endTick: 3840 } }]);
    clock += 4000;
    const b = s.buildExport(lessons)!;
    expect(b.participant).toBe("P07");
    expect(b.events.map((e) => e.t)).toContain("lesson.completed");
    expect(b.events.filter((e) => e.t === "lesson.completed").map((e) => e.lessonId)).toEqual(["M8.2"]); // M0.4 was before consent
    expect(b.events.every((e, i, a) => i === 0 || a[i - 1]!.at <= e.at)).toBe(true);
    expect(b.metrics.lessonsCompleted).toEqual(["M8.2"]);
    expect(b.metrics.edits).toBe(1);
  });
});
