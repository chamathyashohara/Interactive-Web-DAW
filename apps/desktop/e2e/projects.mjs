// Project system: new / open-recent / switch, and Save / Save-as / Open to real .daw files, via the Project menu.
// Runs in workspace mode (no fixed DAW_DATA_DIR). File dialogs are bypassed with the DAW_E2E explicit-path hook.
// Usage: node apps/desktop/e2e/projects.mjs   (build the app first: npm run build -w apps/desktop)
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9345;
const dataDir = tmpDataDir("daw-projects-");
const fileDir = path.join(dataDir, "files");
fs.mkdirSync(fileDir, { recursive: true });
const child = launch(PORT, dataDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(dataDir, "projects") });
const c = await connect(PORT);

const proj = () => c.evalJs(`window.daw.getInitial().then((x) => x.project)`);
const list = () => c.evalJs(`window.daw.projects.list()`);
const menuName = () => c.evalJs(`document.querySelector('[data-testid=project-name]')?.textContent ?? ''`);
const notes = async () => Object.keys((await proj()).tracks["track-1"].clips["clip-1"].notes);
const addNote = (id) => c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: ${JSON.stringify(id)}, pitch: 60, startTick: 0, durationTicks: 240, velocity: 100 } })`);
const openMenu = async () => {
  if (!(await c.evalJs(`!!document.querySelector('[data-testid=project-popover]')`))) await c.clickEl("[data-testid=project-menu]");
  await sleep(250);
};
const rowFor = (id) => `[data-testid=project-row][data-project-id="${id}"]`;
const save = (p) => c.evalJs(`window.daw.projects.save(${JSON.stringify(p)})`);
const openFile = (p) => c.evalJs(`window.daw.projects.openFile(${JSON.stringify(p)})`);

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);

  const l0 = await list();
  check("P1. a first project exists and is shown in the menu", l0.projects.length === 1 && l0.projects[0].name === "My first project" && (await menuName()) === "My first project", JSON.stringify(l0));
  const firstId = l0.activeId;

  await addNote("in-first");
  await sleep(200);
  await openMenu();
  await c.clickEl("[data-testid=project-new]");
  await sleep(600);
  const l1 = await list();
  check("P2. New project creates and switches to a fresh, empty project", l1.projects.length === 2 && l1.activeId !== firstId && (await notes()).length === 0);

  await openMenu();
  await c.clickEl(`${rowFor(firstId)} button`);
  await sleep(600);
  check("P3. Opening a recent project reloads it with its own content", (await list()).activeId === firstId && (await notes()).join() === "in-first");

  // ---------- Save to a real file ----------
  const songPath = path.join(fileDir, "My Song.daw");
  const r = await save(songPath);
  await sleep(500);
  const onDisk = fs.existsSync(songPath) ? JSON.parse(fs.readFileSync(songPath, "utf8")) : null;
  check("P4. Save writes a .daw file with the project inside, and names the project after the file", r.ok && r.path === songPath && !!onDisk && onDisk.project && Object.keys(onDisk.project.tracks["track-1"].clips["clip-1"].notes).join() === "in-first" && (await menuName()) === "My Song", JSON.stringify({ ok: r.ok, menu: await menuName() }));

  // Ctrl+S / Save again writes to the linked file without asking (no explicit path given)
  await addNote("added-later");
  await sleep(200);
  const r2 = await c.evalJs(`window.daw.projects.save()`);
  await sleep(400);
  const reread = JSON.parse(fs.readFileSync(songPath, "utf8"));
  check("P5. Save again writes to the same file without a dialog (Ctrl+S)", r2.ok && r2.path === songPath && Object.keys(reread.project.tracks["track-1"].clips["clip-1"].notes).join() === "in-first,added-later", JSON.stringify({ ok: r2.ok, path: r2.path === songPath }));

  // ---------- Open the file as a new project ----------
  await openMenu();
  await c.clickEl("[data-testid=project-new]"); // move away first
  await sleep(500);
  const before = (await list()).projects.length;
  const ro = await openFile(songPath);
  await sleep(700);
  const l2 = await list();
  check("P6. Open… loads a .daw file as a project with its content", ro.ok && (await notes()).join() === "in-first,added-later" && l2.projects.length === before + 1 && (await menuName()) === "My Song", JSON.stringify({ ok: ro.ok, n: l2.projects.length, menu: await menuName() }));

  // a bad file is refused, not crashed
  const badPath = path.join(fileDir, "bad.daw");
  fs.writeFileSync(badPath, "not json at all");
  const rb = await openFile(badPath);
  check("P7. a file that is not a project is refused with a message, not a crash", rb.ok === false && !!rb.reason && (await c.evalJs(`!!document.querySelector('[data-testid=project-menu]')`)), JSON.stringify(rb));

  // ---------- Delete ----------
  await openMenu();
  const openedCopy = l2.activeId;
  const delBefore = (await list()).projects.length;
  await c.clickEl(`${rowFor(openedCopy)} [data-testid=project-delete]`);
  await sleep(200);
  await c.clickEl(`${rowFor(openedCopy)} [data-testid=project-delete-confirm]`);
  await sleep(500);
  check("P8. Delete removes a project (✕ then confirm)", (await list()).projects.length === delBefore - 1);

  // ---------- persistence across a relaunch ----------
  killTree(child);
  await sleep(1500);
  const child2 = launch(PORT + 1, dataDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(dataDir, "projects") });
  const c2 = await connect(PORT + 1);
  try {
    await until(async () => (await c2.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
    const relaunched = await c2.evalJs(`window.daw.projects.list()`);
    check("P9. projects (and the saved name 'My Song') survive a relaunch", relaunched.projects.some((p) => p.name === "My Song"), JSON.stringify(relaunched.projects.map((p) => p.name)));
  } finally {
    try { c2.ws.close(); } catch {}
    killTree(child2);
  }
} catch (e) {
  check("projects run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
