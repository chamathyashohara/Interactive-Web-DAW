// "Different network": the session lives on a separate server (with an access token) instead of inside the host's app.
// Starts the real session server (the same file `npm run server` uses), then two app windows: one hosts on it, one joins.
// Usage: node apps/desktop/e2e/collab-online.mjs (build the desktop app first).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const PORT = 4311;
const TOKEN = "e2e-secret";
const hostDir = tmpDataDir("daw-online-host-");
const joinDir = tmpDataDir("daw-online-join-");
const bundleDir = fs.mkdtempSync(path.join(root, "packages/collab/dist-e2e-"));
const hostChild = launch(9352, hostDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(hostDir, "projects") });
const joinChild = launch(9353, joinDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(joinDir, "projects") });

const notesOf = async (c) => Object.keys((await c.evalJs(`window.daw.getInitial().then((x) => x.project)`)).tracks["track-1"].clips["clip-1"].notes).sort();
const addNote = (c, id) => c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: ${JSON.stringify(id)}, pitch: 60, startTick: 0, durationTicks: 240, velocity: 100 } })`);
const collabState = (c) => c.evalJs(`window.daw.collab.getState()`);
const ready = (c) => until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);

let host, join, server;
try {
  // the same entry file `npm run server` bundles
  const out = path.join(bundleDir, "server.mjs");
  await build({ entryPoints: [path.join(root, "packages/collab/src/server/cloud.ts")], bundle: true, platform: "node", format: "esm", outfile: out, external: ["ws"], logLevel: "error" });
  server = spawn(process.execPath, [out], { env: { ...process.env, PORT: String(PORT), AUTH_TOKEN: TOKEN }, stdio: "ignore" });
  const up = await until(async () => (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false)), 8000);
  check("O1. the session server starts", up);

  host = await connect(9352);
  join = await connect(9353);
  await ready(host);
  await ready(join);
  await addNote(host, "host-1");
  await host.evalJs(`window.daw.dispatch({ type: "setSongLength", bars: 24 })`);
  await sleep(200);

  const wrong = await host.evalJs(`window.daw.collab.host("Ana", { server: "127.0.0.1:${PORT}", token: "nope" })`);
  check("O2. a wrong access token is refused with a clear reason", wrong.ok === false && /token/i.test(wrong.reason), JSON.stringify(wrong));
  const dead = await host.evalJs(`window.daw.collab.host("Ana", { server: "127.0.0.1:1" })`);
  check("O3. an unreachable server gives a clear reason", dead.ok === false && /cannot reach/i.test(dead.reason), JSON.stringify(dead));
  check("O3b. a failed attempt leaves the app out of any session", (await collabState(host)).active === false);

  const hosted = await host.evalJs(`window.daw.collab.host("Ana", { server: "http://127.0.0.1:${PORT}", token: ${JSON.stringify(TOKEN)} })`);
  check("O4. hosting on the server with the right token returns a code", hosted.ok && /^\d{6}$/.test(hosted.code), JSON.stringify(hosted));
  await until(async () => (await collabState(host)).status === "connected", 8000);
  check("O5. the host's state says the session is on a server", (await collabState(host)).online === true && (await collabState(host)).hosting === true);

  const joined = await join.evalJs(`window.daw.collab.join("http://127.0.0.1:${PORT}", ${JSON.stringify(hosted.code)}, "Ben")`);
  check("O6. a guest joins with the server link and the code", joined.ok, JSON.stringify(joined));
  check("O7. the guest receives the host's project (note and song length)", await until(async () => (await notesOf(join)).includes("host-1"), 8000));
  const gp = await join.evalJs(`window.daw.getInitial().then((x) => x.project)`);
  check("O7b. the song length came across", gp.songBars === 24, String(gp.songBars));

  await addNote(join, "join-1");
  check("O8. a guest edit reaches the host through the server", await until(async () => (await notesOf(host)).includes("join-1"), 8000));
  check("O9. both see two people", await until(async () => (await collabState(host)).users?.length === 2 && (await collabState(join)).users?.length === 2, 6000));

  // The server here is on this same PC (a private address), so Live recording treats the room as same-network and offers the room link.
  // (An address on another network, such as a Cloudflare tunnel, gets the "needs the same network" message instead: see isLanHost's tests.)
  for (const [who, win] of [["host", host], ["guest", join]]) {
    await win.evalJs(`document.querySelector('[data-testid=rec-button]').click()`);
    check(`O9b. the ${who}'s Live recording tab judges the room by the server's address (private = same network)`, await until(async () => await win.evalJs(`!!document.querySelector('[data-testid=rec-share]') && !document.querySelector('[data-testid=rec-room-online]')`), 5000));
    await win.evalJs(`document.querySelector('[data-testid=rec-button]').click()`);
  }

  await host.evalJs(`window.daw.collab.leave()`);
  check("O10. ending the session removes it from the server", await until(async () => (await fetch(`http://127.0.0.1:${PORT}/sessions/${hosted.code}`).then((r) => r.status)) === 404, 6000));
  check("O11. the guest is told and leaves the session", await until(async () => (await collabState(join)).active === false, 8000));
} catch (e) {
  check("online run completed without exception", false, String(e));
} finally {
  try { host?.ws.close(); } catch {}
  try { join?.ws.close(); } catch {}
  try { server?.kill(); } catch {}
  killTree(hostChild);
  killTree(joinChild);
  await sleep(500);
  rmDir(hostDir);
  rmDir(joinDir);
  rmDir(bundleDir);
}
finish();
