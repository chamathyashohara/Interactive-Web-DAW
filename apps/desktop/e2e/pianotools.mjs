// Piano-roll lesson tools: the chopper (Lesson 5.2), arpeggiator (6.1) and transpose (1.3, 5.1), driven for real.
// Usage: node apps/desktop/e2e/pianotools.mjs   (build the app first: npm run build -w apps/desktop)
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9349;
const dataDir = tmpDataDir("daw-pianotools-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);

const BAR = 3840, STEP16 = 240;
const notes = async () => Object.values((await c.evalJs(`window.daw.getInitial().then((x) => x.project)`)).tracks["track-1"].clips["clip-1"].notes);
const clear = () => c.evalJs(`(async () => { const p = await window.daw.getInitial().then(x => x.project); const ids = Object.keys(p.tracks["track-1"].clips["clip-1"].notes); if (ids.length) await window.daw.dispatchBatch(ids.map((id) => ({ type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: id }))); })()`);
const add = (id, pitch, startTick, durationTicks) => c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: ${JSON.stringify(id)}, pitch: ${pitch}, startTick: ${startTick}, durationTicks: ${durationTicks}, velocity: 100 } })`);

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await sleep(200);

  // ---------- chopper ----------
  await add("whole", 60, 0, BAR);
  await sleep(200);
  await c.clickEl("[data-testid=pr-chop]");
  await sleep(400);
  let n = await notes();
  check("CH1. Chop slices a 1-bar note into 16 pieces at the 1/16 grid, same pitch, covering the bar", n.length === 16 && n.every((x) => x.pitch === 60 && x.durationTicks === STEP16), `${n.length} notes`);
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("CH2. one undo restores the single held note", (await notes()).length === 1);

  // Alt+U does the same from the keyboard
  await c.key("u", "KeyU", 1); // Alt = modifier bit 1
  await sleep(400);
  check("CH3. Alt+U chops too (keyboard)", (await notes()).length === 16);
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);

  // ---------- transpose ----------
  await clear();
  await add("t", 60, 0, BAR);
  await sleep(200);
  await c.key("ArrowUp", "ArrowUp", 2); // Ctrl = bit 2 => octave up
  await sleep(300);
  check("T1. Ctrl+Up moves the note up an octave (60 -> 72)", (await notes())[0]?.pitch === 72, JSON.stringify((await notes()).map((x) => x.pitch)));
  await c.key("ArrowDown", "ArrowDown", 8); // Shift = bit 8 => semitone down
  await sleep(300);
  check("T2. Shift+Down moves it down one semitone (72 -> 71)", (await notes())[0]?.pitch === 71);
  await c.key("ArrowDown", "ArrowDown", 2);
  await sleep(300);
  check("T3. Ctrl+Down moves it down an octave (71 -> 59)", (await notes())[0]?.pitch === 59);

  // ---------- arpeggiator ----------
  await clear();
  await add("c1", 60, 0, BAR);
  await add("c2", 64, 0, BAR);
  await add("c3", 67, 0, BAR);
  await sleep(200);
  await c.clickEl("[data-testid=pr-arp]");
  await sleep(250);
  await c.clickEl("[data-testid=pr-arp-up]");
  await sleep(400);
  n = (await notes()).sort((a, b) => a.startTick - b.startTick);
  check("A1. Arp spreads the 3-note chord into a rising sequence at the grid (16 steps over the bar)", n.length === 16 && n[0].pitch === 60 && n[1].pitch === 64 && n[2].pitch === 67 && n[3].pitch === 60, `${n.length} notes, first ${n.slice(0, 4).map((x) => x.pitch)}`);
  check("A2. each arp note is one grid step long and they are back to back", n.every((x, i) => x.durationTicks === STEP16 && x.startTick === i * STEP16));
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("A3. one undo restores the chord", (await notes()).length === 3 && (await notes()).every((x) => x.startTick === 0));
} catch (e) {
  check("pianotools run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
