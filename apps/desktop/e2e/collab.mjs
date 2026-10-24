// Real-time collaboration in the DAW: one window hosts, another joins, and edits sync live (option A: no local undo).
// Launches two app instances on one machine. Usage: node apps/desktop/e2e/collab.mjs (build first).
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const hostDir = tmpDataDir("daw-collab-host-");
const joinDir = tmpDataDir("daw-collab-join-");
const hostChild = launch(9350, hostDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(hostDir, "projects") });
const joinChild = launch(9351, joinDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(joinDir, "projects") });

const notesOf = async (c) => Object.keys((await c.evalJs(`window.daw.getInitial().then((x) => x.project)`)).tracks["track-1"].clips["clip-1"].notes).sort();
const addNote = (c, id) => c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: ${JSON.stringify(id)}, pitch: 60, startTick: 0, durationTicks: 240, velocity: 100 } })`);
const collabState = (c) => c.evalJs(`window.daw.collab.getState()`);
const ready = async (c) => until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);

let host, join;
try {
  host = await connect(9350);
  join = await connect(9351);
  await ready(host);
  await ready(join);

  // host makes a note, then hosts a session seeded with its project
  await addNote(host, "host-1");
  await host.evalJs(`window.daw.dispatch({ type: "setSongLength", bars: 24 })`);
  await host.evalJs(`window.daw.dispatch({ type: "setKey", key: { tonic: 2, mode: "minor" } })`);
  await sleep(200);
  const hosted = await host.evalJs(`window.daw.collab.host("Ana")`);
  check("C1. hosting returns a 6-digit code and a host address", hosted.ok && /^\d{6}$/.test(hosted.code) && /:\d+$/.test(hosted.address), JSON.stringify(hosted));
  const port = hosted.address.split(":").pop();
  await until(async () => (await collabState(host)).active && (await collabState(host)).status === "connected", 8000);
  check("C2. the host is shown as in a live session (hosting)", (await collabState(host)).hosting === true);

  // joiner joins via localhost + the code
  const joined = await join.evalJs(`window.daw.collab.join("127.0.0.1:${port}", ${JSON.stringify(hosted.code)}, "Ben")`);
  check("C3. joining with the address and code succeeds", joined.ok, JSON.stringify(joined));
  check("C4. the joiner receives the host's project (sees the note made before joining)", await until(async () => (await notesOf(join)).includes("host-1"), 8000));

  // live sync both ways
  await addNote(host, "host-2");
  check("C5. an edit by the host appears for the joiner", await until(async () => (await notesOf(join)).includes("host-2"), 8000));
  await addNote(join, "join-1");
  check("C6. an edit by the joiner appears for the host", await until(async () => (await notesOf(host)).includes("join-1"), 8000));
  check("C7. both sides have the same notes", (await notesOf(host)).join() === (await notesOf(join)).join(), `${(await notesOf(host)).join()} vs ${(await notesOf(join)).join()}`);

  // presence: each sees two people
  check("C8. both see two people in the room", await until(async () => (await collabState(host)).users?.length === 2 && (await collabState(join)).users?.length === 2, 6000));

  // live pointers: the host's pointer shows up in the joiner's window with the host's name, and goes away when it leaves
  const pointerText = (c) => c.evalJs(`[...document.querySelectorAll('[data-testid^="collab-pointer-"]')].map((e) => e.textContent.trim() + "@" + e.style.transform).join("|")`);
  await host.evalJs(`window.daw.collab.sendPointer({ x: 0.25, y: 0.5 })`);
  check("C8b. the host's pointer appears in the joiner's window with the host's name", await until(async () => /Ana@translate\(25vw, 50vh\)/.test(await pointerText(join)), 6000), await pointerText(join));
  check("C8c. you never see your own pointer drawn", !(await pointerText(host)).includes("Ana"), await pointerText(host));
  await host.evalJs(`window.daw.collab.sendPointer(null)`);
  check("C8d. the pointer disappears when it leaves the window", await until(async () => (await pointerText(join)) === "", 6000), await pointerText(join));

  // network panel: opens from the popover, shows real measurements, exports a CSV
  await host.evalJs(`document.querySelector('[data-testid=collab-button]').click()`);
  await sleep(150);
  await host.evalJs(`document.querySelector('[data-testid=collab-network-button]')?.click()`);
  check("C8e. the Network panel opens", await until(async () => await host.evalJs(`!!document.querySelector('[data-testid=collab-network]')`), 6000));
  const pingText = () => host.evalJs(`document.querySelector('[data-testid=net-ping]')?.textContent ?? ''`);
  check("C8f. it shows two people and a measured ping", await until(async () => (await host.evalJs(`document.querySelector('[data-testid=net-users]')?.textContent`)) === "2" && /ms/.test(await pingText()), 12000), await pingText());
  const csvPath = path.join(hostDir, "net.csv");
  const exported = await host.evalJs(`window.daw.collab.exportNet(${JSON.stringify(csvPath)})`);
  const csv = exported.ok ? fs.readFileSync(csvPath, "utf8") : "";
  check("C8g. Export CSV writes the measurements", exported.ok && csv.startsWith("time,kind,ms") && csv.split("\n").length > 2, JSON.stringify(exported));
  await host.evalJs(`document.querySelector('[aria-label="Close the Network panel"]')?.click()`);

  // option A: local undo is off during a session
  const beforeUndo = await notesOf(join);
  const undoResult = await join.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("C9. local undo does nothing during a session (use the shared history instead)", undoResult === false && (await notesOf(join)).join() === beforeUndo.join());

  // host ends the session; the joiner is returned to solo editing with the result kept
  await host.evalJs(`window.daw.collab.leave()`);
  check("C10. after the host ends it, the joiner leaves the session", await until(async () => (await collabState(join)).active === false, 8000));
  check("C11. the joiner's own project is left untouched (no session notes in it)", (await notesOf(join)).length === 0, (await notesOf(join)).join());
  const list = await join.evalJs(`window.daw.projects.list()`);
  const saved = list.projects.find((p) => /\(session\)$/.test(p.name));
  check("C11b. the session was saved as a new project in the joiner's list", !!saved, JSON.stringify(list.projects.map((p) => p.name)));
  await join.evalJs(`window.daw.projects.open(${JSON.stringify(saved?.id)})`);
  await sleep(500);
  check("C11c. that saved project holds the collaborated notes", (await notesOf(join)).includes("host-2") && (await notesOf(join)).includes("join-1"), (await notesOf(join)).join());
  const joined2 = await join.evalJs(`window.daw.getInitial().then((x) => x.project)`);
  check("C11d. the host's song length and key came across (not reset to defaults)", joined2.songBars === 24 && joined2.key?.tonic === 2 && joined2.key?.mode === "minor", `${joined2.songBars} ${JSON.stringify(joined2.key)}`);
  check("C12. the host is also back to solo", (await collabState(host)).active === false);
} catch (e) {
  check("collab run completed without exception", false, String(e));
} finally {
  try { host?.ws.close(); } catch {}
  try { join?.ws.close(); } catch {}
  killTree(hostChild);
  killTree(joinChild);
  rmDir(hostDir);
  rmDir(joinDir);
}
finish();
