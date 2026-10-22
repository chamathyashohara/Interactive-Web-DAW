// Piano roll window behaviour and keyboard look: close, reopen, maximize, restore, piano-style keys.
// Usage: node apps/desktop/e2e/pianoroll-ui.mjs   (build the app first: npm run build -w apps/desktop)
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9336;
const dataDir = tmpDataDir("daw-pr-ui-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);

const h = async (sel) => (await c.rectOf(sel))?.h ?? 0;
const exists = (sel) => c.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const noteCount = () => c.evalJs(`document.querySelectorAll('[data-note-id]').length`);
const bg = (sel, i = 0) => c.evalJs(`getComputedStyle(document.querySelectorAll(${JSON.stringify(sel)})[${i}]).backgroundColor`);
const attr = (sel, name) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)})`);

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n1", pitch: 60, startTick: 0, durationTicks: 960, velocity: 100 } })`);
  await sleep(300);

  // ---------- keyboard look ----------
  const blackKeys = await c.evalJs(`document.querySelectorAll('[data-black-key]').length`);
  const totalKeys = await c.evalJs(`document.querySelectorAll('[data-key]').length`);
  const labels = await c.evalJs(`[...document.querySelectorAll('[data-key]')].map(e => e.textContent.trim()).filter(Boolean).join(',')`);
  check("K1. the keyboard has 20 black keys among 48 keys (C2-B5): 5 per octave like a real piano", blackKeys === 20 && totalKeys === 48, `black ${blackKeys}, total ${totalKeys}`);
  check("K2. every C is labelled with its octave (C2, C3, C4, C5) and nothing else is", labels === "C5,C4,C3,C2", labels);
  const blackRow = await c.rectOf("[data-black-key]");
  const whiteBar = await c.evalJs(`(() => { const bar = document.querySelector('[data-black-key]').firstElementChild.getBoundingClientRect(); const row = document.querySelector('[data-black-key]').getBoundingClientRect(); return bar.width / row.width; })()`);
  check("K3. a black key is a bar covering the left 60% of its row, over a white key", whiteBar > 0.55 && whiteBar < 0.65 && blackRow.h > 10, `width ${whiteBar.toFixed(2)} of the row`);

  const before = await bg("[data-key]:not([data-black-key])", 1);
  const r = await c.rectOf("[data-key]:not([data-black-key])", 1);
  await c.mouse("mouseMoved", r.cx, r.cy, { buttons: 0 });
  await c.mouse("mousePressed", r.cx, r.cy);
  await sleep(120);
  const pressed = await bg("[data-key]:not([data-black-key])", 1);
  await c.mouse("mouseReleased", r.cx, r.cy);
  await sleep(120);
  const released = await bg("[data-key]:not([data-black-key])", 1);
  check("K4. a pressed key lights up and returns to normal when released", pressed !== before && released === before, `${before} -> ${pressed} -> ${released}`);

  // ---------- maximize / restore ----------
  const arrH0 = await h("[data-testid=arrangement]");
  const scrollH0 = await h("[data-testid=piano-roll-scroll]");
  check("W1. by default both the arrangement and the piano roll are visible", arrH0 > 100 && scrollH0 > 100);
  await c.clickEl("[data-testid=pr-maximize]");
  await sleep(300);
  const arrH1 = await h("[data-testid=arrangement]");
  const scrollH1 = await h("[data-testid=piano-roll-scroll]");
  check("W2. Maximize hides the arrangement and gives the piano roll the full height", arrH1 === 0 && scrollH1 > scrollH0 + 150 && (await attr("[data-testid=piano-panel]", "data-maximized")) === "true", `roll ${Math.round(scrollH0)} -> ${Math.round(scrollH1)} px`);
  check("W3. the button changes to Restore", (await attr("[data-testid=pr-maximize]", "aria-label")) === "Restore piano roll");
  check("W4. notes are untouched in the full view", (await noteCount()) === 1);
  await c.clickEl("[data-testid=pr-maximize]");
  await sleep(300);
  check("W5. Restore brings the arrangement back at its old size", Math.abs((await h("[data-testid=arrangement]")) - arrH0) < 2 && (await attr("[data-testid=pr-maximize]", "aria-label")) === "Maximize piano roll");
  await c.clickEl("[data-testid=pr-maximize]");
  await sleep(200);
  await c.key("Escape", "Escape");
  await sleep(300);
  check("W6. Esc also restores from the full view", (await h("[data-testid=arrangement]")) > 100);

  // ---------- close / reopen ----------
  await c.clickEl("[data-testid=pr-close]");
  await sleep(300);
  const arrFill = await h("[data-testid=arrangement]");
  check("C1. Close removes the piano roll and lets the arrangement fill the window", !(await exists("[data-testid=piano-roll-scroll]")) && arrFill > arrH0 + 200 && (await attr("[data-testid=piano-toggle]", "aria-pressed")) === "false", `arrangement ${Math.round(arrH0)} -> ${Math.round(arrFill)} px`);
  await c.clickEl("[data-testid=piano-toggle]");
  await sleep(300);
  check("C2. the Piano roll button reopens it with the same notes", (await exists("[data-testid=piano-roll-scroll]")) && (await noteCount()) === 1);
  await c.clickEl("[data-testid=pr-close]");
  await sleep(200);
  await c.dblclick(...(await (async () => { const r2 = await c.rectOf("[data-testid=clip]"); return [r2.cx, r2.cy]; })()));
  await sleep(400);
  check("C3. double-clicking a clip reopens the piano roll on that clip", (await exists("[data-testid=piano-roll-scroll]")) && (await noteCount()) === 1);
  await c.clickEl("[data-testid=pr-maximize]");
  await sleep(200);
  await c.clickEl("[data-testid=pr-close]");
  await sleep(200);
  check("C4. closing from the full view also leaves the full view (arrangement is visible)", (await h("[data-testid=arrangement]")) > 100 && !(await exists("[data-testid=piano-roll-scroll]")));
  await c.clickEl("[data-testid=piano-toggle]");
  await sleep(300);
  check("C5. reopening after that shows the normal split, not the full view", (await attr("[data-testid=piano-panel]", "data-maximized")) === null && (await h("[data-testid=arrangement]")) > 100);

  // ---------- note width, sweep delete, zoom ----------
  const notesOf = async () => Object.values((await c.evalJs(`window.daw.getInitial().then(x => x.project)`)).tracks["track-1"].clips["clip-1"].notes);
  const add = (id, pitch, startTick, durationTicks) => c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: ${JSON.stringify(id)}, pitch: ${pitch}, startTick: ${startTick}, durationTicks: ${durationTicks}, velocity: 100 } })`);
  const noteRect = (id) => c.rectOf(`[data-note-id="${id}"]`);
  await add("w1", 64, 1920, 1440);
  await sleep(300);
  const w1 = await noteRect("w1");
  await c.click(w1.cx, w1.cy);
  await sleep(250);
  const g = await c.rectOf("[data-testid=grid]");
  await c.click(g.x + 600, w1.cy + 18 * 3); // empty cell, 3 rows lower
  await sleep(400);
  const made = (await notesOf()).filter((n) => !["n1", "w1"].includes(n.id));
  check("P1. clicking a note, then clicking empty space, draws a note of the same width as the one clicked", made.length === 1 && made[0].durationTicks === 1440, JSON.stringify(made.map((n) => n.durationTicks)));
  await c.evalJs(`window.daw.dispatch({ type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: ${JSON.stringify(made[0]?.id ?? "")} })`);

  // right button held and swept over three notes deletes all of them at once
  await add("s1", 62, 5760, 960);
  await add("s2", 63, 5760, 960);
  await add("s3", 64, 5760, 960);
  await sleep(300);
  const s1 = await noteRect("s1"), s3 = await noteRect("s3");
  const rb = { button: "right", buttons: 2 };
  await c.mouse("mouseMoved", s1.x + 10, s1.cy, { buttons: 0 });
  await c.mouse("mousePressed", s1.x + 10, s1.cy, rb);
  for (let i = 1; i <= 4; i++) await c.mouse("mouseMoved", s1.x + 10, s1.cy + ((s3.cy - s1.cy) * i) / 4, rb);
  await c.mouse("mouseReleased", s1.x + 10, s3.cy, { button: "right", buttons: 0 });
  await sleep(400);
  const left = (await notesOf()).map((n) => n.id).sort();
  check("P2. holding the right button and sweeping over notes deletes them all in one go (others stay)", left.join() === "n1,w1", left.join());
  await c.evalJs(`window.daw.undo()`);
  await sleep(400);
  check("P3. the whole sweep is one undo step", (await notesOf()).length === 5);
  const n1r = await noteRect("n1");
  await c.mouse("mouseMoved", n1r.cx, n1r.cy, { buttons: 0 });
  await c.mouse("mousePressed", n1r.cx, n1r.cy, rb);
  await c.mouse("mouseReleased", n1r.cx, n1r.cy, { button: "right", buttons: 0 });
  await sleep(400);
  check("P4. a plain right-click still deletes the one note under the cursor", !(await notesOf()).some((n) => n.id === "n1"));

  // Ctrl + middle mouse sweep = horizontal zoom, anchored under the cursor
  const zoom = () => c.evalJs(`Number(document.querySelector('[aria-label="Horizontal zoom"]').value)`);
  const z0 = await zoom();
  const sc = await c.rectOf("[data-testid=piano-roll-scroll]");
  const cx = sc.x + 500, cy = sc.y + 100;
  const tickAt = async () => { const gg = await c.rectOf("[data-testid=grid]"); return ((cx - gg.x) / (await zoom())) * 960; };
  const t0 = await tickAt();
  const mid = { button: "middle", buttons: 4, modifiers: 2 };
  await c.mouse("mouseMoved", cx, cy, { buttons: 0 });
  await c.mouse("mousePressed", cx, cy, mid);
  for (let i = 1; i <= 5; i++) await c.mouse("mouseMoved", cx + i * 20, cy, mid);
  await c.mouse("mouseReleased", cx + 100, cy, { button: "middle", buttons: 0, modifiers: 2 });
  await sleep(300);
  const z1 = await zoom();
  check("Z1. Ctrl + middle mouse swept right zooms in", z1 > z0 * 1.5, `${z0} -> ${z1}`);
  const t1 = await (async () => { const gg = await c.rectOf("[data-testid=grid]"); return ((cx - gg.x) / z1) * 960; })();
  check("Z2. the zoom stays centred on the moment under the cursor", Math.abs(t1 - t0) < 120, `tick ${Math.round(t0)} -> ${Math.round(t1)}`);
  await c.mouse("mousePressed", cx, cy, mid);
  for (let i = 1; i <= 5; i++) await c.mouse("mouseMoved", cx - i * 40, cy, mid);
  await c.mouse("mouseReleased", cx - 200, cy, { button: "middle", buttons: 0, modifiers: 2 });
  await sleep(300);
  const z2 = await zoom();
  check("Z3. swept left it zooms out (never past the slider's range)", z2 < z1 && z2 >= 40, `${z1} -> ${z2}`);
  const zBefore = await zoom();
  await c.mouse("mousePressed", cx, cy, { button: "middle", buttons: 4 });
  await c.mouse("mouseMoved", cx + 100, cy, { button: "middle", buttons: 4 });
  await c.mouse("mouseReleased", cx + 100, cy, { button: "middle", buttons: 0 });
  await sleep(200);
  check("Z4. middle mouse without Ctrl does not zoom", (await zoom()) === zBefore);

  // ---------- drum track keeps its drum names ----------
  await c.evalJs(`window.daw.dispatch({ type: "addTrack", track: { id: "td", name: "Kit", instrument: "drums", color: "#f472b6", volume: 80, pan: 0, mute: false, solo: false, clips: { cd: { id: "cd", name: "Beat", startTick: 0, lengthTicks: 15360, notes: {} } } } })`);
  await sleep(300);
  await c.clickEl('[data-testid=track-row][data-track-id="td"] [data-testid=track-name]');
  await sleep(300);
  await c.evalJs(`[...document.querySelectorAll('[data-testid=clip]')].find(e => e.dataset.clipId === 'cd').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
  check("D0. a drum clip opens in the step sequencer", await exists("[data-testid=step-sequencer]"));
  await c.clickEl("[data-testid=view-roll]");
  await sleep(300);
  const drumLabels = await c.evalJs(`[...document.querySelectorAll('[data-key]')].map(e => e.textContent.trim()).filter(Boolean).join(',')`);
  check("D1. a drum track lists drum names on its keys instead of a piano", drumLabels.includes("Kick") && drumLabels.includes("Snare") && (await c.evalJs(`document.querySelectorAll('[data-black-key]').length`)) === 0, drumLabels.slice(0, 50));
} catch (e) {
  check("pianoroll-ui run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
