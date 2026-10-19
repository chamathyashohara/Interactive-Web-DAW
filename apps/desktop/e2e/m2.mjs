// M2 end-to-end acceptance checks: multi-track, instruments, mixer, meters, editing tools, undo and recovery.
// Mute/solo/volume/pan are verified through the audio engine's own meters (what is actually rendered).
// Usage: node apps/desktop/e2e/m2.mjs   (build the app first: npm run build -w apps/desktop)
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9334;
const dataDir = tmpDataDir("daw-m2-");
let child = launch(PORT, dataDir);
let c = await connect(PORT);

const noteCount = () => c.evalJs(`document.querySelectorAll('[data-note-id]').length`);
const trackIds = () => c.evalJs(`[...document.querySelectorAll('[data-testid=track-row]')].map(e => e.dataset.trackId)`);
const level = async (sel) => Number(await c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.dataset.level ?? 'NaN'`));
const meter = (id) => level(`[data-testid=meter-${id}]`);
/** Peak of a meter over a window (meters report peak since last status, so take the max of several reads). */
async function peak(sel, ms = 500) {
  let mx = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    mx = Math.max(mx, await level(sel));
    await sleep(40);
  }
  return mx;
}
const project = () => c.evalJs(`window.daw.getInitial().then(x => x.project)`);
const grid = () => c.rectOf("[data-testid=grid]");
const X = (g, beat) => g.x + beat * 120 + 4;
const Y = (g, pitch) => g.y + (83 - pitch) * 18 + 9;
const tool = async (id) => c.clickEl(`[data-tool=${id}]`);
const selCount = () => c.evalJs(`document.querySelector('[data-testid=selection-count]').textContent`);
const noteBox = (i = 0) => c.evalJs(`(() => { const el = document.querySelectorAll('[data-note-id]')[${i}]; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, left: parseFloat(el.style.left), top: parseFloat(el.style.top), muted: el.dataset.muted === 'true' }; })()`);

const centerOn = (pitch) => c.evalJs(`(() => { const el = document.querySelector('[data-testid=piano-roll-scroll]'); el.scrollTop = (83 - ${pitch}) * 18 + 26 - el.clientHeight / 2; })()`);
const mk = (id, name, ins, color, clip) => ({ id, name, instrument: ins, color, volume: 80, pan: 0, mute: false, solo: false, clips: { [clip]: { id: clip, startTick: 0, lengthTicks: 15360, notes: {} } } });
const longNote = (trackId, clipId, pitch) => ({ type: "addNote", trackId, clipId, note: { id: crypto.randomUUID(), pitch, startTick: 0, durationTicks: 15000, velocity: 110 } });
// Drums are one-shots, so give them a kick on every beat to keep the meter busy.
const kicks = (trackId, clipId) => Array.from({ length: 32 }, (_, i) => ({ type: "addNote", trackId, clipId, note: { id: crypto.randomUUID(), pitch: 36, startTick: i * 480, durationTicks: 120, velocity: 110 } }));

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Mixer').click()`); // the mixer is collapsed by default
  await c.evalJs(`window.daw.dispatch({ type: "setSongLength", bars: 4 })`); // these tests fill a 4-bar loop with sustained notes

  // ---------- tracks: add via the UI ----------
  check("M2-1a. project starts with one track", (await trackIds()).length === 1);
  await c.clickEl("[data-testid=add-track]");
  await c.clickEl("[data-testid=add-synth]");
  await until(async () => (await trackIds()).length === 2);
  await c.clickEl("[data-testid=add-track]");
  await c.clickEl("[data-testid=add-drums]");
  await until(async () => (await trackIds()).length === 3);
  await c.clickEl("[data-testid=add-track]");
  await c.clickEl("[data-testid=add-synth]");
  await until(async () => (await trackIds()).length === 4);
  const p1 = await project();
  check("M2-1b. adding tracks from the UI creates 4 tracks with the chosen instruments", p1.trackOrder.length === 4 && p1.trackOrder.map((id) => p1.tracks[id].instrument).join() === "synth,synth,drums,synth");
  const ids = p1.trackOrder;

  // ---------- rename ----------
  const nameRect = await c.rectOf(`[data-track-id="${ids[1]}"] [data-testid=track-name]`);
  await c.dblclick(nameRect.cx, nameRect.cy);
  await sleep(150);
  await c.insertText("Lead");
  await c.key("Enter", "Enter");
  const renamed = await until(async () => (await project()).tracks[ids[1]].name === "Lead");
  check("M2-2. double-click renames a track", !!renamed);

  // ---------- instruments produce sound per track (long notes; engine meters) ----------
  const clips = ids.map((id) => Object.keys(p1.tracks[id].clips)[0]);
  await c.evalJs(`window.daw.dispatchBatch(${JSON.stringify(ids.flatMap((id, i) => (p1.tracks[id].instrument === "drums" ? kicks(id, clips[i]) : [longNote(id, clips[i], 48 + i * 5)])))})`);
  await c.evalJs(`window.daw.play()`);
  await sleep(700);
  const lv = {};
  for (const id of ids) lv[id] = await peak(`[data-testid=meter-${id}]`, 300);
  check("M2-3. every track (2 synths + drums + synth) is audible on its own meter while playing", ids.every((id) => lv[id] > 0.005), JSON.stringify(Object.values(lv).map((v) => +v.toFixed(3))));
  const master = await peak("[data-testid=meter-master-l]", 300);
  check("M2-4. master meter reports signal", master > 0.01, master.toFixed(3));

  // ---------- mute ----------
  await c.clickEl(`[data-track-id="${ids[0]}"] [aria-label^="Mute"]`);
  await sleep(500);
  const afterMute = [await peak(`[data-testid=meter-${ids[0]}]`, 300), await peak(`[data-testid=meter-${ids[1]}]`, 300)];
  check("M2-5a. muting a track silences it while the others keep playing", afterMute[0] < 0.0005 && afterMute[1] > 0.005, afterMute.map((v) => v.toFixed(4)).join(" / "));
  await c.clickEl(`[data-track-id="${ids[0]}"] [aria-label^="Mute"]`);
  await sleep(500);
  check("M2-5b. unmuting brings it back", (await peak(`[data-testid=meter-${ids[0]}]`, 400)) > 0.005);

  // ---------- solo ----------
  await c.clickEl(`[data-track-id="${ids[1]}"] [aria-label^="Solo"]`);
  await sleep(500);
  const solo = [];
  for (const id of ids) solo.push(await peak(`[data-testid=meter-${id}]`, 250));
  check("M2-6a. solo silences every other track", solo[1] > 0.005 && solo[0] < 0.0005 && solo[2] < 0.0005 && solo[3] < 0.0005, solo.map((v) => v.toFixed(4)).join(" / "));
  await c.clickEl(`[data-track-id="${ids[2]}"] [aria-label^="Solo"]`);
  await sleep(500);
  const solo2 = [];
  for (const id of ids) solo2.push(await peak(`[data-testid=meter-${id}]`, 250));
  check("M2-6b. two solos play together", solo2[1] > 0.005 && solo2[2] > 0.001 && solo2[0] < 0.0005 && solo2[3] < 0.0005, solo2.map((v) => v.toFixed(4)).join(" / "));
  await c.clickEl(`[data-track-id="${ids[1]}"] [aria-label^="Solo"]`);
  await c.clickEl(`[data-track-id="${ids[2]}"] [aria-label^="Solo"]`);
  await sleep(500);
  check("M2-6c. clearing solo restores everything", (await peak(`[data-testid=meter-${ids[0]}]`, 400)) > 0.005);

  // ---------- volume ----------
  await c.setRange(`[aria-label="Fader of Lead"]`, 80);
  await sleep(400);
  const loud = await peak(`[data-testid=meter-${ids[1]}]`, 400);
  await c.setRange(`[aria-label="Fader of Lead"]`, 30);
  await sleep(500);
  const quiet = await peak(`[data-testid=meter-${ids[1]}]`, 400);
  const expectedRatio = (30 / 80) ** 2;
  check("M2-7. moving a fader changes the rendered level in proportion (fader curve is squared)", Math.abs(quiet / loud - expectedRatio) < 0.05, `ratio ${(quiet / loud).toFixed(3)} expected ${expectedRatio.toFixed(3)}`);
  await c.setRange(`[aria-label="Fader of Lead"]`, 80);

  // ---------- pan (solo one track, read master L/R) ----------
  await c.clickEl(`[data-track-id="${ids[1]}"] [aria-label^="Solo"]`);
  await c.setRange(`[aria-label="Pan of Lead"]`, -100);
  await sleep(500);
  const hardLeft = [await peak("[data-testid=meter-master-l]", 300), await peak("[data-testid=meter-master-r]", 300)];
  await c.setRange(`[aria-label="Pan of Lead"]`, 100);
  await sleep(500);
  const hardRight = [await peak("[data-testid=meter-master-l]", 300), await peak("[data-testid=meter-master-r]", 300)];
  check("M2-8. pan hard left / hard right moves the sound to that side only", hardLeft[0] > 0.01 && hardLeft[1] < 0.0005 && hardRight[1] > 0.01 && hardRight[0] < 0.0005, `L-pan ${hardLeft.map((v) => v.toFixed(4))}  R-pan ${hardRight.map((v) => v.toFixed(4))}`);
  await c.setRange(`[aria-label="Pan of Lead"]`, 0);
  await c.clickEl(`[data-track-id="${ids[1]}"] [aria-label^="Solo"]`);

  // ---------- master ----------
  await c.setRange("[data-testid=master-fader]", 0);
  await sleep(500);
  const masterZero = await peak("[data-testid=meter-master-l]", 300);
  const trackStill = await peak(`[data-testid=meter-${ids[0]}]`, 300);
  check("M2-9. master fader at 0 silences the output while track meters stay live", masterZero < 0.0005 && trackStill > 0.005, `master ${masterZero.toFixed(4)} track ${trackStill.toFixed(3)}`);
  await c.setRange("[data-testid=master-fader]", 80);

  // ---------- stop: meters fall to zero ----------
  await c.evalJs(`window.daw.stop()`);
  await sleep(800);
  check("M2-10. after Stop every meter returns to zero", (await peak("[data-testid=meter-master-l]", 300)) < 0.0005 && (await peak(`[data-testid=meter-${ids[0]}]`, 300)) < 0.0005);

  // ---------- undo / redo of track and mixer edits ----------
  await c.evalJs(`window.daw.dispatch({type:"updateTrack",trackId:${JSON.stringify(ids[3])},changes:{volume:33}},"vol-x")`);
  await sleep(150);
  await c.ctrl("z");
  await until(async () => (await project()).tracks[ids[3]].volume === 80);
  check("M2-11a. Ctrl+Z undoes a mixer change", (await project()).tracks[ids[3]].volume === 80);
  await c.ctrl("y");
  await until(async () => (await project()).tracks[ids[3]].volume === 33);
  check("M2-11b. Ctrl+Y redoes it", (await project()).tracks[ids[3]].volume === 33);

  await c.evalJs(`window.daw.dispatch({type:"updateTrack",trackId:${JSON.stringify(ids[3])},changes:{volume:80}})`);
  await c.clickEl(`[data-track-id="${ids[2]}"] [aria-label^="Delete"]`);
  await until(async () => (await trackIds()).length === 3);
  check("M2-12a. delete button removes a track", (await trackIds()).length === 3 && !(await trackIds()).includes(ids[2]));
  await c.ctrl("z");
  await until(async () => (await trackIds()).length === 4);
  const restored = await project();
  check("M2-12b. undo restores the deleted track in its original position with its notes", restored.trackOrder.join() === ids.join() && Object.keys(restored.tracks[ids[2]].clips[clips[2]].notes).length === 32);

  // ---------- piano roll tools (use track 0, clear its notes first) ----------
  await c.clickEl(`[data-track-id="${ids[0]}"] [data-testid=track-name]`);
  await sleep(200);
  await c.evalJs(`window.daw.getInitial().then(x => window.daw.dispatchBatch(Object.keys(x.project.tracks[${JSON.stringify(ids[0])}].clips[${JSON.stringify(clips[0])}].notes).map(noteId => ({type:"deleteNote",trackId:${JSON.stringify(ids[0])},clipId:${JSON.stringify(clips[0])},noteId}))))`);
  await sleep(300);
  check("M2-13. selecting a track shows its notes in the roll (cleared track is empty)", (await noteCount()) === 0);

  await centerOn(66);
  await sleep(150);
  let g = await grid();
  // paint: drag across 5 cells -> one undo step
  await tool("paint");
  await c.drag(X(g, 0), Y(g, 66), X(g, 0) + 4 * 30 + 6, Y(g, 66), 8);
  await until(async () => (await noteCount()) >= 4, 3000);
  if ((await noteCount()) < 4) console.log("DEBUG paint", JSON.stringify({ g, pressed: await c.evalJs(`document.querySelector('[data-tool=paint]').getAttribute('aria-pressed')`), sel: await c.evalJs(`document.querySelector('[data-track-id][data-selected]')?.dataset.trackId`), want: ids[0], at: await c.evalJs(`document.elementFromPoint(${X(g, 0)}, ${Y(g, 60)})?.outerHTML.slice(0, 120)`), scroll: await c.evalJs(`innerHeight`) }));
  const painted = await noteCount();
  await c.ctrl("z");
  await until(async () => (await noteCount()) === 0);
  check("M2-14. Paint tool adds a run of notes in one stroke; one Ctrl+Z removes the whole stroke", painted >= 4 && (await noteCount()) === 0, `painted ${painted}`);
  await c.ctrl("y");
  await until(async () => (await noteCount()) === painted);

  // select all + group move
  await c.ctrl("a");
  check("M2-15a. Ctrl+A selects every note", (await selCount()).startsWith(`${painted} selected`), await selCount());
  await tool("select");
  const b0 = await noteBox(0);
  await c.drag(b0.x + 6, b0.y + 8, b0.x + 6 + 60, b0.y + 8 - 36, 6);
  await sleep(300);
  const b1 = await noteBox(0);
  const allMoved = await c.evalJs(`[...document.querySelectorAll('[data-note-id]')].map(el => parseFloat(el.style.left)).join()`);
  check("M2-15b. dragging one selected note moves the whole selection (time and pitch)", Math.abs(b1.left - b0.left - 60) < 1 && Math.abs(b0.top - b1.top - 36) < 1 && allMoved.split(",").length === painted, `left ${b0.left}->${b1.left}`);

  // rubber-band select
  g = await grid();
  await c.click(X(g, 7), Y(g, 72)); // click empty space deselects
  await sleep(100);
  check("M2-16a. clicking empty space with Select clears the selection", (await selCount()) === `${painted} notes`, await selCount());
  const first = await noteBox(0);
  await c.drag(first.x - 6, first.y - 10, first.x + 2 * 30 + 12, first.y + 24, 6);
  await sleep(200);
  const bandSel = await selCount();
  check("M2-16b. dragging a box on empty space selects the notes inside it", /^[1-9]\d* selected$/.test(bandSel) && !bandSel.startsWith(`${painted} selected`), bandSel);

  // copy / paste at playhead, duplicate
  await c.ctrl("a");
  await c.ctrl("c");
  const ruler = await c.rectOf("[data-testid=piano-roll-scroll]");
  await c.click(g.x + 4 * 120 + 4, ruler.y + 14); // click the ruler at beat 4 to move the playhead
  await sleep(400);
  await c.ctrl("v");
  await until(async () => (await noteCount()) === painted * 2);
  check("M2-17a. Ctrl+C then Ctrl+V pastes a copy at the playhead", (await noteCount()) === painted * 2, `${await noteCount()} notes`);
  await c.ctrl("z");
  await until(async () => (await noteCount()) === painted);
  await c.ctrl("a");
  await c.ctrl("d");
  await until(async () => (await noteCount()) === painted * 2);
  check("M2-17b. Ctrl+D duplicates the selection", (await noteCount()) === painted * 2);
  await c.ctrl("z");
  await until(async () => (await noteCount()) === painted);

  // quantize: draw off-grid with snap off, then snap on + Q
  await c.evalJs(`document.querySelector('[aria-pressed]').closest('header') && [...document.querySelectorAll('button')].find(b => b.textContent.includes('Snap')).click()`);
  await tool("draw");
  g = await grid();
  await c.click(X(g, 6) + 11, Y(g, 64));
  await until(async () => (await noteCount()) === painted + 1);
  const offGrid = await c.evalJs(`[...document.querySelectorAll('[data-note-id]')].map(el => parseFloat(el.style.left)).filter(l => Math.abs(l % 30) > 0.5 && Math.abs(l % 30) < 29.5).length`);
  await c.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Snap')).click()`);
  await c.ctrl("a");
  await c.key("q", "KeyQ");
  await sleep(300);
  const stillOff = await c.evalJs(`[...document.querySelectorAll('[data-note-id]')].map(el => parseFloat(el.style.left)).filter(l => Math.abs(l % 30) > 0.5 && Math.abs(l % 30) < 29.5).length`);
  check("M2-18. Quantize (Q) snaps off-grid notes onto the grid", offGrid >= 1 && stillOff === 0, `off-grid before ${offGrid}, after ${stillOff}`);

  // mute tool
  await c.evalJs(`document.querySelector('[data-testid=piano-roll-scroll]').scrollTop = document.querySelector('[data-testid=piano-roll-scroll]').scrollTop`);
  await tool("mute");
  const mb = await noteBox(0);
  await c.click(mb.x + 6, mb.y + 8);
  await sleep(250);
  check("M2-19a. Mute tool marks a note muted (hatched)", (await noteBox(0)).muted === true);
  await c.click(mb.x + 6, mb.y + 8);
  await sleep(250);
  check("M2-19b. clicking again unmutes it", (await noteBox(0)).muted === false);

  // slice
  await tool("slice");
  const before = await noteCount();
  await c.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Snap')).click()`); // snap off for a free cut
  const sb = await noteBox(0);
  await c.click(sb.x + sb.w / 2, sb.y + 8);
  await sleep(300);
  check("M2-20. Slice tool cuts a note into two", (await noteCount()) === before + 1, `${before}->${await noteCount()}`);
  await c.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Snap')).click()`);

  // delete tool drag erases several notes in one stroke
  await tool("delete");
  const n0 = await noteCount();
  g = await grid();
  const eb = await noteBox(0);
  await c.drag(eb.x - 4, eb.y + 8, eb.x + 6 * 30, eb.y + 8, 10);
  await sleep(300);
  const n1 = await noteCount();
  await c.ctrl("z");
  await until(async () => (await noteCount()) === n0);
  check("M2-21. Delete tool erases every note under a drag; one undo brings them back", n1 < n0 - 1 && (await noteCount()) === n0, `${n0}->${n1}->${await noteCount()}`);

  // vertical zoom
  const h0 = (await noteBox(0)).h;
  await c.setRange(`[aria-label="Vertical zoom"]`, 30);
  await sleep(200);
  const h1 = (await noteBox(0)).h;
  check("M2-22. vertical zoom changes row height without touching the notes", h1 > h0 + 8 && (await noteCount()) === n0, `note height ${h0}->${h1}`);
  await c.setRange(`[aria-label="Vertical zoom"]`, 18);

  // drum track labels
  await c.clickEl(`[data-track-id="${ids[2]}"] [data-testid=track-name]`);
  await sleep(300);
  const keyLabels = await c.evalJs(`[...document.querySelectorAll('[data-key]')].map(e => e.textContent).filter(Boolean).join()`);
  check("M2-23. drum tracks label piano-roll rows with drum names", keyLabels.includes("Kick") && keyLabels.includes("Snare"), keyLabels.slice(0, 60));

  // ---------- persistence: kill the whole app, relaunch ----------
  await c.clickEl(`[data-track-id="${ids[1]}"] [aria-label^="Mute"]`);
  await c.setRange(`[aria-label="Pan of Lead"]`, -55);
  await sleep(500);
  const snapshotBefore = await project();
  c.ws.close();
  killTree(child);
  await sleep(1500);
  child = launch(PORT, dataDir);
  c = await connect(PORT);
  await until(async () => (await trackIds())?.length === 4, 15000);
  const after = await project();
  const same = JSON.stringify(after.trackOrder) === JSON.stringify(snapshotBefore.trackOrder) &&
    after.trackOrder.every((id) => {
      const a = after.tracks[id], b = snapshotBefore.tracks[id];
      return a.name === b.name && a.volume === b.volume && a.pan === b.pan && a.mute === b.mute && a.solo === b.solo && a.color === b.color && a.instrument === b.instrument &&
        JSON.stringify(a.clips) === JSON.stringify(b.clips);
    });
  check("M2-24. force-killed app: all tracks, names, mixer settings, notes and muted notes are restored", same && after.tracks[ids[1]].name === "Lead" && after.tracks[ids[1]].mute === true && after.tracks[ids[1]].pan === -55);
  await c.evalJs(`window.daw.play()`);
  await sleep(800);
  check("M2-25. after relaunch the restored project plays", (await peak(`[data-testid=meter-list-${ids[0]}]`, 600)) > 0.001 || (await peak(`[data-testid=meter-list-${ids[2]}]`, 600)) > 0.001);
} catch (e) {
  check("m2 run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
