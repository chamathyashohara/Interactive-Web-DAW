import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createProject, PPQ, projectHash, stamp, TICKS_PER_BAR, type Op, type OpBody, type Project } from "@daw/shared";
import { Room } from "../src/server/room";
import { Replica } from "../src/client/replica";
import { CollabClient, newId } from "../src/client/collabClient";
import { startSessionServer, type SessionServer } from "../src/server/sessionServer";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(15);
  return cond();
}
const op = (body: OpBody, clientId: string, id = newId()): Op => stamp(body, id, clientId);
const addNote = (id: string, pitch = 60): OpBody => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id, pitch, startTick: 0, durationTicks: PPQ, velocity: 100 } });
const base = (): Project => createProject("p1", "Test");
const notesOf = (p: Project | null) => (p ? Object.keys(p.tracks["track-1"]!.clips["clip-1"]!.notes).sort() : []);

describe("Room: server rules via the current applyOp", () => {
  it("accepts a valid op and orders it by seq", () => {
    const room = new Room(base());
    const r = room.submit("A", [op({ type: "setTempo", bpm: 140 }, "A")]);
    expect(r.ok && r.entries[0]!.seq === 1 && room.project.tempo === 140).toBe(true);
  });
  it("refuses an op stamped with another client's id", () => {
    const room = new Room(base());
    expect(room.submit("A", [op({ type: "setTempo", bpm: 140 }, "IMPOSTOR")]).ok).toBe(false);
  });
  it("enforces the shared rules (an out-of-range note is refused)", () => {
    const room = new Room(base());
    const r = room.submit("A", [op({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "x", pitch: 200, startTick: 0, durationTicks: PPQ, velocity: 100 } }, "A")]);
    expect(!r.ok && room.seq === 0).toBe(true);
  });
  it("orders the NEW op types too (loop, markers, automation) — the point of using @daw/shared", () => {
    const room = new Room(base());
    const r = room.submit("A", [
      op({ type: "setLoop", loop: { startTick: 0, endTick: TICKS_PER_BAR } }, "A"),
      op({ type: "setMarkers", markers: [{ id: "m1", tick: 0, name: "Intro" }] }, "A"),
      op({ type: "setAutomation", trackId: "track-1", param: "volume", points: [{ tick: 0, value: 0.5 }] }, "A"),
    ]);
    expect(r.ok).toBe(true);
    expect(room.project.loop).toEqual({ startTick: 0, endTick: TICKS_PER_BAR });
    expect(room.project.markers?.[0]!.name).toBe("Intro");
    expect(room.project.tracks["track-1"]!.automation?.volume?.length).toBe(1);
  });
});

describe("Replica: two users converge on the server's order", () => {
  it("both end on the same project whoever's op the server ordered first", () => {
    const seed = base();
    const a = new Replica(seed, 0);
    const b = new Replica(seed, 0);
    // both edit at once (A sets tempo, B adds a note); the server happens to order A then B
    const aOp = op({ type: "setTempo", bpm: 150 }, "A");
    const bOp = op(addNote("nb"), "B");
    a.localApply([aOp]);
    b.localApply([bOp]);
    for (const [i, o] of [aOp, bOp].entries()) {
      a.receive({ seq: i + 1, op: o, at: 0 });
      b.receive({ seq: i + 1, op: o, at: 0 });
    }
    expect(projectHash(a.view)).toBe(projectHash(b.view));
    expect(a.view.tempo).toBe(150);
    expect(notesOf(a.view)).toContain("nb");
    expect(a.pendingBatches.length).toBe(0); // both own edits confirmed
  });
});

describe("live over sockets: host and join a session", () => {
  let server: SessionServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const connect = (port: number, code: string, name: string) =>
    new CollabClient({ baseUrl: `ws://127.0.0.1:${port}`, code, name, color: "#22d3ee", WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });

  it("one client's edit reaches the other, and both converge", async () => {
    server = await startSessionServer(0);
    const code = server.createSession(base());

    const a = connect(server.port, code, "Ana");
    const b = connect(server.port, code, "Ben");
    let aProj: Project | null = null;
    let bProj: Project | null = null;
    a.on("change", (p) => (aProj = p));
    b.on("change", (p) => (bProj = p));
    a.connect();
    b.connect();
    expect(await until(() => a.status === "connected" && b.status === "connected")).toBe(true);

    a.dispatch(addNote("fromA"));
    expect(await until(() => notesOf(bProj).includes("fromA"))).toBe(true); // B sees A's note
    b.dispatch({ type: "setTempo", bpm: 128 });
    expect(await until(() => aProj?.tempo === 128)).toBe(true); // A sees B's tempo

    // a new op type travels the same path
    a.dispatch({ type: "setLoop", loop: { startTick: 0, endTick: TICKS_PER_BAR } });
    expect(await until(() => !!bProj?.loop)).toBe(true);

    expect(await until(() => !!aProj && !!bProj && projectHash(aProj) === projectHash(bProj))).toBe(true);
  });

  it("the two users see each other in the room", async () => {
    server = await startSessionServer(0);
    const code = server.createSession(base());
    const a = connect(server.port, code, "Ana");
    const b = connect(server.port, code, "Ben");
    let users = 0;
    a.on("users", (u) => (users = u.length));
    a.connect();
    b.connect();
    expect(await until(() => users === 2)).toBe(true);
  });
});
