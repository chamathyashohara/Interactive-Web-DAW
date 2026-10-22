// Producing tools: bar.beat readout, tap tempo, metronome, loop region, section markers, drum step sequencer, velocity ramp.
// Usage: node apps/desktop/e2e/producing.mjs   (build the app first: npm run build -w apps/desktop)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9343;
const dataDir = tmpDataDir("daw-prod-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);

const proj = () => c.evalJs(`window.daw.getInitial().then(x => x.project)`);
const canUndo = () => c.evalJs(`window.daw.getInitial().then(x => x.canUndo)`);
const exists = (sel) => c.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const readout = () => text("[data-testid=bar-beat]");
const dispatch = (op) => c.evalJs(`window.daw.dispatch(${JSON.stringify(op)})`);
const kitNotes = async () => Object.values((await proj()).tracks["td"].clips["cd"].notes);
const exportHash = async (file) => {
  await c.evalJs(`window.__exports.length = 0`);
  await c.evalJs(`window.daw.exportWav(${JSON.stringify(file)})`);
  const done = await until(async () => await c.evalJs(`window.__exports.find(x => x.state === 'done' || x.state === 'error') || null`), 30000, 100);
  if (done?.state !== "done") throw new Error("export failed " + JSON.stringify(done));
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
};

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`(() => { window.__rec = { maxL: 0 }; window.daw.onEngineStatus((st) => { window.__rec.maxL = Math.max(window.__rec.maxL, st.masterL, st.masterR); }); window.__exports = []; window.daw.onExportStatus((x) => window.__exports.push(x)); })()`);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n1", pitch: 60, startTick: 0, durationTicks: 960, velocity: 100 } });
  await dispatch({ type: "addTrack", track: { id: "td", name: "Kit", instrument: "drums", color: "#f472b6", volume: 70, pan: 0, mute: false, solo: false, clips: { cd: { id: "cd", name: "Beat", startTick: 0, lengthTicks: 15360, notes: {} } } } });
  await sleep(500);

  // ---------- bar.beat readout ----------
  check("B1. the position readout starts at bar 1, beat 1, sixteenth 1", (await readout()).includes("001.1.1"), await readout());
  await c.evalJs(`window.daw.seek(${3840 + 1920})`);
  await sleep(400);
  check("B2. after jumping to bar 2, beat 3 it reads 002.3.1", (await readout()).includes("002.3.1"), await readout());
  await c.evalJs(`window.daw.seek(0)`);

  // ---------- tap tempo ----------
  await dispatch({ type: "setTempo", bpm: 90 });
  await sleep(300);
  for (let i = 0; i < 5; i++) {
    await c.clickEl("[data-testid=tap-tempo]");
    await sleep(500);
  }
  const tapped = (await proj()).tempo;
  check("T1. tapping every half second sets the tempo to about 120 BPM", Math.abs(tapped - 120) <= 8, `tempo ${tapped}`);
  await sleep(2300);
  await c.clickEl("[data-testid=tap-tempo]");
  await sleep(300);
  check("T2. a single tap after a pause does not change the tempo", (await proj()).tempo === tapped);
  await dispatch({ type: "setTempo", bpm: 120 });

  // ---------- metronome ----------
  const masterPeak = async (ms) => {
    await c.evalJs(`window.__rec.maxL = 0`);
    await sleep(ms);
    return Number(await c.evalJs(`window.__rec.maxL`));
  };
  await dispatch({ type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: "n1" });
  await sleep(300);
  await c.evalJs(`window.daw.play()`);
  const quiet = await masterPeak(1200);
  await c.evalJs(`window.daw.stop()`);
  check("M1. an empty song is silent with the metronome off", quiet < 0.001, quiet.toFixed(4));
  await c.clickEl("[data-testid=metronome-toggle]");
  check("M2. the Click key lights up", (await c.evalJs(`document.querySelector('[data-testid=metronome-toggle]').getAttribute('aria-pressed')`)) === "true");
  await c.evalJs(`window.daw.play()`);
  const clicking = await masterPeak(1200);
  await c.evalJs(`window.daw.stop()`);
  check("M3. with the metronome on, the click is heard while playing", clicking > 0.05, clicking.toFixed(3));
  await sleep(300);
  const withClick = await masterPeak(600);
  check("M4. and it is silent again when stopped", withClick < 0.001, withClick.toFixed(4));
  await dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n1", pitch: 60, startTick: 0, durationTicks: 960, velocity: 100 } });
  await sleep(300);
  const exportClickOn = await exportHash(path.join(dataDir, "click-on.wav"));
  await c.clickEl("[data-testid=metronome-toggle]");
  await sleep(200);
  const exportClickOff = await exportHash(path.join(dataDir, "click-off.wav"));
  check("M5. the exported WAV never contains the click (identical with the metronome on or off)", exportClickOn === exportClickOff);

  // ---------- loop region ----------
  const loopOf = async () => (await proj()).loop ?? null;
  await c.clickEl("[data-testid=loop-toggle]");
  await sleep(400);
  let loop = await loopOf();
  check("L1. the Loop key turns on a region over the selected clip", !!loop && loop.startTick === 0 && loop.endTick === 15360, JSON.stringify(loop));
  check("L2. the region is drawn in the loop strip and tinted over the tracks", (await exists("[data-testid=loop-region]")) && (await exists("[data-testid=loop-tint]")));
  await c.clickEl("[data-testid=loop-toggle]");
  await sleep(300);
  check("L3. pressing it again loops the whole song again", (await loopOf()) === null);

  let row = await c.rectOf("[data-testid=loop-row]");
  const pxBar = row.w / 8;
  await c.drag(row.x + pxBar * 1 + 1, row.cy, row.x + pxBar * 3 + 1, row.cy, 8);
  await sleep(400);
  loop = await loopOf();
  check("L4. dragging in the loop strip draws a region from bar 2 to bar 4", !!loop && Math.abs(loop.startTick - 3840) <= 240 && Math.abs(loop.endTick - 11520) <= 240, JSON.stringify(loop));
  const before = loop;
  await c.drag(row.x + pxBar * 2, row.cy, row.x + pxBar * 3, row.cy, 8);
  await sleep(400);
  loop = await loopOf();
  check("L5. dragging the middle of the region moves it one bar later, keeping its length", !!loop && Math.abs(loop.startTick - before.startTick - 3840) <= 240 && loop.endTick - loop.startTick === before.endTick - before.startTick, JSON.stringify(loop));
  const reg = await c.rectOf("[data-testid=loop-region]");
  await c.drag(reg.x + reg.w - 2, reg.cy, reg.x + reg.w - 2 + pxBar, reg.cy, 8);
  await sleep(400);
  const longer = await loopOf();
  check("L6. dragging its right end makes it a bar longer", !!longer && Math.abs(longer.endTick - loop.endTick - 3840) <= 240 && longer.startTick === loop.startTick, JSON.stringify(longer));
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("L7. each of those is one undo step", JSON.stringify(await loopOf()) === JSON.stringify(loop));
  const reg2 = await c.rectOf("[data-testid=loop-region]");
  await c.dblclick(reg2.cx, reg2.cy);
  await sleep(300);
  check("L8. double-clicking the region clears it", (await loopOf()) === null);

  // playback stays inside the region (bars 2-3), and wraps
  await dispatch({ type: "setLoop", loop: { startTick: 3840, endTick: 11520 } });
  await sleep(400);
  await c.evalJs(`window.daw.seek(0)`);
  await sleep(200);
  await c.evalJs(`window.daw.play()`);
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 8500) {
    const m = /(\d+)\.(\d)\.(\d)/.exec(await readout());
    if (m) seen.push({ t: Date.now() - t0, tick: (Number(m[1]) - 1) * 3840 + (Number(m[2]) - 1) * 960 + (Number(m[3]) - 1) * 240 });
    await sleep(60);
  }
  await c.evalJs(`window.daw.stop()`);
  const entered = seen.findIndex((s) => s.tick >= 3840);
  const after = seen.slice(entered);
  check("L9. playing from the start, the playhead enters the region and never leaves it", entered >= 0 && after.every((s) => s.tick >= 3840 - 240 && s.tick < 11520 + 240), `min ${Math.min(...after.map((s) => s.tick))}, max ${Math.max(...after.map((s) => s.tick))}`);
  let wraps = 0;
  for (let i = 1; i < after.length; i++) if (after[i].tick < after[i - 1].tick - 2000) wraps++;
  check("L10. it wraps back to the start of the region (at least once in 8 s)", wraps >= 1, `${wraps} wraps`);
  const exportLoop = await exportHash(path.join(dataDir, "loop-on.wav"));
  await dispatch({ type: "setLoop", loop: null });
  await sleep(300);
  const exportWhole = await exportHash(path.join(dataDir, "loop-off.wav"));
  check("L11. the exported WAV always renders the whole song (identical with or without a loop region)", exportLoop === exportWhole);

  // ---------- section markers ----------
  const markersOf = async () => (await proj()).markers ?? [];
  row = await c.rectOf("[data-testid=marker-row]");
  await c.dblclick(row.x + pxBar * 2 + 2, row.cy);
  await sleep(400);
  check("S1. double-clicking the marker strip adds a section marker and opens its name for editing", (await markersOf()).length === 1 && (await exists("[data-testid=marker-input]")));
  await c.evalJs(`(() => { const i = document.querySelector('[data-testid=marker-input]'); i.focus(); i.select(); })()`);
  await c.insertText("Verse");
  await c.key("Enter", "Enter");
  await sleep(400);
  const m1 = (await markersOf())[0];
  check("S2. typing a name and pressing Enter renames it", m1?.name === "Verse" && Math.abs(m1.tick - 7680) <= 240, JSON.stringify(m1));
  const mr = await c.rectOf("[data-testid=marker]");
  await c.drag(mr.x + 1, mr.cy, mr.x + 1 + pxBar * 2, mr.cy, 8);
  await sleep(400);
  const moved = (await markersOf())[0];
  check("S3. dragging a marker moves it (two bars later)", Math.abs(moved.tick - m1.tick - 7680) <= 240 && moved.name === "Verse", JSON.stringify(moved));
  await c.dblclick(row.x + pxBar * 1 + 2, row.cy);
  await sleep(300);
  await c.key("Escape", "Escape");
  await sleep(300);
  const two = await markersOf();
  check("S4. markers are kept in time order", two.length === 2 && two[0].tick < two[1].tick, JSON.stringify(two.map((m) => m.tick)));
  const first = await c.rectOf("[data-testid=marker]", 0);
  await c.click(first.x + 3, first.cy);
  await sleep(400);
  check("S5. clicking a marker jumps the playhead to it", (await readout()).includes("002.1.1"), await readout());
  await c.mouse("mouseMoved", first.x + 3, first.cy, { buttons: 0 });
  await c.mouse("mousePressed", first.x + 3, first.cy, { button: "right", buttons: 2 });
  await c.mouse("mouseReleased", first.x + 3, first.cy, { button: "right", buttons: 0 });
  await sleep(400);
  check("S6. right-clicking a marker deletes it", (await markersOf()).length === 1);
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("S7. and that is undoable", (await markersOf()).length === 2);

  // ---------- drum step sequencer ----------
  await c.clickEl('[data-testid=track-row][data-track-id="td"] [data-testid=track-name]');
  await sleep(500);
  check("D1. a drum clip opens in the step sequencer, one bar of sixteen pads per drum", (await exists("[data-testid=step-sequencer]")) && (await c.evalJs(`document.querySelectorAll('[data-testid=step-row][data-pitch="36"] [data-pad]').length`)) === 16);
  const pad = (pitch, step) => c.rectOf(`[data-testid=step-row][data-pitch="${pitch}"] [data-pad][data-step="${step}"]`);
  let p = await pad(36, 0);
  await c.click(p.cx, p.cy);
  await sleep(350);
  let notes = await kitNotes();
  check("D2. clicking a pad places a hit: kick (36) on step 1, at the normal loudness", notes.length === 1 && notes[0].pitch === 36 && notes[0].startTick === 0 && notes[0].velocity === 100 && notes[0].durationTicks === 240, JSON.stringify(notes));
  check("D3. the pad lights up", (await c.evalJs(`document.querySelector('[data-testid=step-row][data-pitch="36"] [data-pad][data-step="0"]').dataset.on`)) === "true");
  await c.click(p.cx, p.cy);
  await sleep(350);
  check("D4. clicking it again removes the hit", (await kitNotes()).length === 0);
  p = await pad(38, 4);
  await c.mouse("mouseMoved", p.cx, p.cy, { buttons: 0 });
  await c.mouse("mousePressed", p.cx, p.cy, { modifiers: 8 });
  await c.mouse("mouseReleased", p.cx, p.cy, { modifiers: 8 });
  await sleep(350);
  notes = await kitNotes();
  check("D5. Shift+click places an accent (velocity 127) on the snare, step 5", notes.length === 1 && notes[0].pitch === 38 && notes[0].startTick === 960 && notes[0].velocity === 127 && (await c.evalJs(`document.querySelector('[data-testid=step-row][data-pitch="38"] [data-pad][data-step="4"]').dataset.accent`)) === "true", JSON.stringify(notes));
  const p0 = await pad(42, 0), p7 = await pad(42, 7);
  await c.drag(p0.cx, p0.cy, p7.cx, p7.cy, 14);
  await sleep(450);
  notes = (await kitNotes()).filter((n) => n.pitch === 42);
  check("D6. dragging across a row paints all its pads (eight closed hats)", notes.length === 8 && notes.every((n, i) => notes.some((m) => m.startTick === i * 240)), notes.map((n) => n.startTick / 240).sort((a, b) => a - b).join());
  await c.evalJs(`window.daw.undo()`);
  await sleep(350);
  check("D7. the whole paint stroke is one undo step", (await kitNotes()).filter((n) => n.pitch === 42).length === 0 && (await kitNotes()).length === 1);
  await c.clickEl("[data-testid=step-bar-2]");
  await sleep(300);
  p = await pad(36, 2);
  await c.click(p.cx, p.cy);
  await sleep(350);
  notes = (await kitNotes()).filter((n) => n.pitch === 36);
  check("D8. bar 2 has its own pads: step 3 of bar 2 is at tick 3840 + 480", notes.length === 1 && notes[0].startTick === 3840 + 480, JSON.stringify(notes.map((n) => n.startTick)));
  await c.clickEl("[data-testid=step-copy-all]");
  await sleep(450);
  notes = await kitNotes();
  const perBar = [0, 1, 2, 3].map((b) => notes.filter((n) => n.startTick >= b * 3840 && n.startTick < (b + 1) * 3840).length);
  check("D9. Copy to all bars makes every bar like the one shown", perBar.every((n) => n === perBar[1]) && perBar[1] === 1, perBar.join());
  await c.clickEl("[data-testid=step-clear]");
  await sleep(350);
  notes = await kitNotes();
  check("D10. Clear bar empties just that bar", notes.filter((n) => n.startTick >= 3840 && n.startTick < 7680).length === 0 && notes.length === 3, `${notes.length} notes left`);
  await c.clickEl("[data-testid=step-bar-1]");
  await sleep(200);
  // the same notes in the piano roll
  await c.clickEl("[data-testid=view-roll]");
  await sleep(400);
  check("D11. the Roll view shows the same hits (one note per hit)", !(await exists("[data-testid=step-sequencer]")) && (await c.evalJs(`document.querySelectorAll('[data-note-id]').length`)) === (await kitNotes()).length);
  await c.clickEl("[data-testid=view-steps]");
  await sleep(300);

  // ---------- velocity ramp ----------
  await c.clickEl('[data-testid=track-row][data-track-id="track-1"] [data-testid=track-name]');
  await sleep(500);
  await dispatch({ type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: "n1" });
  for (let i = 0; i < 4; i++) await dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: `r${i}`, pitch: 60 + i, startTick: i * 960 + 1920, durationTicks: 480, velocity: 60 } });
  await sleep(300);
  await c.clickEl("[data-testid=ramp-toggle]");
  await sleep(250);
  check("V1. the Ramp button opens a small panel saying which notes it changes", (await exists("[data-testid=ramp-popover]")) && (await text("[data-testid=ramp-popover]")).includes("all the notes in this clip"));
  await c.evalJs(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const f = document.querySelector('[data-testid=ramp-from]'), t = document.querySelector('[data-testid=ramp-to]'); set.call(f, '30'); f.dispatchEvent(new Event('input', { bubbles: true })); set.call(t, '120'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const undoBefore = await canUndo();
  await c.clickEl("[data-testid=ramp-apply]");
  await sleep(450);
  const ramped = Object.values((await proj()).tracks["track-1"].clips["clip-1"].notes).filter((n) => n.id.startsWith("r")).sort((a, b) => a.startTick - b.startTick);
  check("V2. Apply makes the four notes climb evenly from 30 to 120 (the first and last notes set the ends)", ramped.map((n) => n.velocity).join() === [30, 60, 90, 120].join() || (ramped[0].velocity === 30 && ramped[3].velocity === 120 && ramped[1].velocity < ramped[2].velocity), ramped.map((n) => n.velocity).join());
  await c.evalJs(`window.daw.undo()`);
  await sleep(350);
  const afterUndo = Object.values((await proj()).tracks["track-1"].clips["clip-1"].notes).filter((n) => n.id.startsWith("r"));
  check("V3. one undo puts every velocity back", afterUndo.every((n) => n.velocity === 60) && undoBefore !== undefined);

  // ---------- lessons gate the new tools in beginner mode ----------
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await c.evalJs(`window.daw.resetProgress()`);
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await sleep(500);
  const dis = (sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.disabled`);
  const title = (sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.title ?? ''`);
  check("G1. before lesson M8.2 the Loop key is locked and names the lesson", (await dis("[data-testid=loop-toggle]")) === true && /M8\.2/.test(await title("[data-testid=loop-toggle]")));
  check("G2. the metronome, tap tempo and position readout are always available", (await dis("[data-testid=metronome-toggle]")) === false && (await dis("[data-testid=tap-tempo]")) === false && (await exists("[data-testid=bar-beat]")));
  check("G3. before lesson M7.4 the velocity ramp is locked", (await dis("[data-testid=ramp-toggle]")) === true && /M7\.4/.test(await title("[data-testid=ramp-toggle]")));
  const lockedMarkers = Object.keys((await proj()).markers ?? []).length;
  row = await c.rectOf("[data-testid=marker-row]");
  await c.dblclick(row.x + pxBar * 5, row.cy);
  await sleep(300);
  check("G4. before lesson M13.1 double-clicking the marker strip does nothing", Object.keys((await proj()).markers ?? []).length === lockedMarkers);
  await c.evalJs(`window.daw.completeLesson('M8.2')`);
  await sleep(400);
  check("G5. completing M8.2 unlocks the Loop key", (await dis("[data-testid=loop-toggle]")) === false);
  await c.evalJs(`window.daw.setProgressMode('all')`);
} catch (e) {
  check("producing run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
