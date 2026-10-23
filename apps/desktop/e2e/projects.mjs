// Project system: new / open / save-as / rename / delete, driven through the Project menu with the real mouse.
// Runs in workspace mode (no fixed DAW_DATA_DIR), so switching between real project folders is exercised.
// Usage: node apps/desktop/e2e/projects.mjs   (build the app first: npm run build -w apps/desktop)
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9345;
const dataDir = tmpDataDir("daw-projects-");
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

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);

  // ---------- first run ----------
  const l0 = await list();
  check("P1. a first project exists and is shown in the menu", l0.projects.length === 1 && l0.projects[0].name === "My first project" && (await menuName()) === "My first project", JSON.stringify(l0));
  const firstId = l0.activeId;

  // ---------- new project switches to an empty one ----------
  await addNote("in-first");
  await sleep(200);
  await openMenu();
  await c.clickEl("[data-testid=project-new]");
  await sleep(600);
  const l1 = await list();
  check("P2. New project creates and switches to a fresh, empty project", l1.projects.length === 2 && l1.activeId !== firstId && (await notes()).length === 0, JSON.stringify({ n: l1.projects.length, active: l1.activeId !== firstId, notes: (await notes()).length }));

  // ---------- open the first one again: its note is still there ----------
  await openMenu();
  await c.clickEl(`${rowFor(firstId)} button`);
  await sleep(600);
  check("P3. Opening another project reloads it with its own content", (await list()).activeId === firstId && (await notes()).join() === "in-first");

  // ---------- save a copy ----------
  await openMenu();
  await c.clickEl("[data-testid=project-saveas]");
  await sleep(200);
  await c.evalJs(`(() => { const i = document.querySelector('[data-testid=project-name-input]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'My Remix'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await c.clickEl("[data-testid=project-name-ok]");
  await sleep(700);
  const l2 = await list();
  const copy = l2.projects.find((p) => p.name === "My Remix");
  check("P4. Save a copy makes a new project with the copied content and switches to it", !!copy && l2.activeId === copy.id && copy.id !== firstId && (await notes()).join() === "in-first", JSON.stringify({ copy: copy?.name, active: l2.activeId === copy?.id }));

  // editing the copy does not change the original
  await addNote("only-in-copy");
  await sleep(300);
  await openMenu();
  await c.clickEl(`${rowFor(firstId)} button`);
  await sleep(600);
  check("P5. editing the copy left the original untouched", (await notes()).join() === "in-first");

  // ---------- rename ----------
  await openMenu();
  await c.clickEl("[data-testid=project-rename]");
  await sleep(200);
  await c.evalJs(`(() => { const i = document.querySelector('[data-testid=project-name-input]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Verse Idea'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
  await c.clickEl("[data-testid=project-name-ok]");
  await sleep(500);
  check("P6. Rename changes the name in the menu and the list, keeping the content", (await menuName()) === "Verse Idea" && (await list()).projects.find((p) => p.id === firstId)?.name === "Verse Idea" && (await notes()).join() === "in-first");

  // the name survives a relaunch (persisted)
  await sleep(300);

  // ---------- delete ----------
  await openMenu();
  const before = (await list()).projects.length;
  await c.clickEl(`${rowFor(copy.id)} [data-testid=project-delete]`);
  await sleep(200);
  await c.clickEl(`${rowFor(copy.id)} [data-testid=project-delete-confirm]`);
  await sleep(500);
  const l3 = await list();
  check("P7. Delete removes a project (two clicks: ✕ then confirm)", l3.projects.length === before - 1 && !l3.projects.some((p) => p.id === copy.id), JSON.stringify(l3.projects.map((p) => p.name)));

  // ---------- persistence across a relaunch ----------
  killTree(child);
  await sleep(1500);
  const child2 = launch(PORT + 1, dataDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(dataDir, "projects") });
  const c2 = await connect(PORT + 1);
  try {
    await until(async () => (await c2.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
    const relaunched = await c2.evalJs(`window.daw.projects.list()`);
    const back = await c2.evalJs(`window.daw.getInitial().then((x) => Object.keys(x.project.tracks["track-1"].clips["clip-1"].notes))`);
    check("P8. after a relaunch the renamed project reopens with its content", relaunched.projects.some((p) => p.name === "Verse Idea") && relaunched.activeId === firstId && back.join() === "in-first", JSON.stringify({ names: relaunched.projects.map((p) => p.name), back }));
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
