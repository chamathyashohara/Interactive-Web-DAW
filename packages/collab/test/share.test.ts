import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CollabClient } from "../src/client/collabClient";
import { startSessionServer, type SessionServer } from "../src/server/sessionServer";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(15);
  return cond();
}
const WS = WebSocket as unknown as typeof globalThis.WebSocket;

type Note = { id: string; topic: string; data: unknown | null };
let server: SessionServer | null = null;
const clients: CollabClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await server?.close();
  server = null;
});

async function room() {
  server = await startSessionServer(0);
  const code = server.createSession();
  const join = async (name: string) => {
    const c = new CollabClient({ baseUrl: `ws://127.0.0.1:${server!.port}`, code, name, color: "#fff", WebSocketImpl: WS });
    const notes: Note[] = [];
    c.on("share", (n) => notes.push(n));
    clients.push(c);
    c.connect();
    await until(() => c.status === "connected");
    return { c, notes };
  };
  return { join };
}

describe("notes put in the room (used to carry a live recording into the same session)", () => {
  it("others see a note at once, and someone who joins later still gets it", async () => {
    const { join } = await room();
    const a = await join("A");
    const b = await join("B");
    a.c.share("recording", { host: "192.168.1.5", port: 52000, code: "123456" });
    expect(await until(() => b.notes.some((n) => n.topic === "recording" && n.data !== null))).toBe(true);
    expect(b.notes.at(-1)!.data).toEqual({ host: "192.168.1.5", port: 52000, code: "123456" });
    expect(b.notes.at(-1)!.id).toBe(a.c.clientId);
    expect(a.notes).toEqual([]); // the sender is not told about their own note

    const late = await join("C");
    expect(late.notes.map((n) => n.topic)).toEqual(["recording"]);
    expect(late.notes[0]!.data).toEqual({ host: "192.168.1.5", port: 52000, code: "123456" });
  });

  it("the owner can take it down, and nobody else can", async () => {
    const { join } = await room();
    const a = await join("A");
    const b = await join("B");
    a.c.share("recording", { code: "111111" });
    await until(() => b.notes.length === 1);
    b.c.share("recording", null); // not the owner: ignored
    await wait(150);
    expect(a.notes).toEqual([]);
    a.c.share("recording", null);
    expect(await until(() => b.notes.length === 2)).toBe(true);
    expect(b.notes[1]).toMatchObject({ topic: "recording", data: null });
    const late = await join("C");
    expect(late.notes).toEqual([]);
  });

  it("goes away by itself when its owner leaves", async () => {
    const { join } = await room();
    const a = await join("A");
    const b = await join("B");
    a.c.share("recording", { code: "222222" });
    await until(() => b.notes.length === 1);
    a.c.close();
    expect(await until(() => b.notes.some((n) => n.data === null))).toBe(true);
  });

  it("refuses odd topics and oversize notes", async () => {
    const { join } = await room();
    const a = await join("A");
    const b = await join("B");
    a.c.share("Bad Topic!", { x: 1 });
    a.c.share("big", { text: "x".repeat(2000) });
    await wait(200);
    expect(b.notes).toEqual([]);
  });

  it("a note taken down while someone was disconnected is reported gone when they come back", async () => {
    const { join } = await room();
    const a = await join("A");
    const b = await join("B");
    a.c.share("recording", { code: "333333" });
    await until(() => b.notes.length === 1);
    // B's connection drops; the note is taken down meanwhile; B reconnects on its own
    (b.c as unknown as { ws: { terminate(): void } }).ws.terminate();
    a.c.share("recording", null);
    expect(await until(() => b.notes.some((n) => n.data === null), 8000)).toBe(true);
  }, 15000);
});
