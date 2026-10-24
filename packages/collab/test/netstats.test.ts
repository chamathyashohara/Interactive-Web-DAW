import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { CollabClient } from "../src/client/collabClient";
import { NetStats } from "../src/client/netStats";
import { startSessionServer } from "../src/server/sessionServer";
import { summarize } from "../src/shared/stats";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WS = WebSocket as unknown as typeof globalThis.WebSocket;

describe("NetStats: measuring a real connection", () => {
  it("measures ping, sync delay and traffic between two clients, and exports a CSV", async () => {
    const server = await startSessionServer(0);
    const code = server.createSession();
    const base = `ws://127.0.0.1:${server.port}`;
    const make = (name: string) => {
      const c = new CollabClient({ baseUrl: base, code, name, color: "#4cc9f0", WebSocketImpl: WS });
      c.connect();
      return { c, net: new NetStats(base, c, WS) };
    };
    const a = make("A");
    const b = make("B");
    await wait(6500);

    const ping = summarize(a.net.pings);
    expect(a.net.pings.length).toBeGreaterThanOrEqual(2);
    expect(ping!.avg).toBeLessThan(200);
    expect(a.net.pingsLost).toBe(0);
    expect(a.net.otherUsers).toBe(1);
    expect(b.net.syncs.length).toBeGreaterThanOrEqual(1);
    expect(a.net.rx).toBeGreaterThan(0);
    expect(a.net.tx).toBeGreaterThan(0);
    const csv = a.net.toCsv();
    expect(csv.startsWith("time,kind,ms\n")).toBe(true);
    expect(csv.split("\n").length).toBeGreaterThan(3);
    const snap = a.net.snapshot();
    expect(snap.users).toBe(2);
    expect(snap.status).toBe("connected");
    expect(snap.recentPings.length).toBeGreaterThan(0);

    a.net.stop();
    b.net.stop();
    a.c.close();
    b.c.close();
    await server.close();
  }, 20000);
});
