// M4 end-to-end checks: project key, scale highlighting, red out-of-key notes and Fix; feature unlock registry,
// beginner mode, the lesson API (completeLesson), and persistence of progress.
// Usage: node apps/desktop/e2e/m4.mjs   (build the app first: npm run build -w apps/desktop)
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9337;
const dataDir = tmpDataDir("daw-m4-");
let child = launch(PORT, dataDir);
let c = await connect(PORT);

const project = () => c.evalJs(`window.daw.getInitial().then(x => x.project)`);
const progress = () => c.evalJs(`window.daw.getProgress()`);
const q = (sel) => c.evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const text = (sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const attr = (sel, name) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)})`);
const disabled = (sel, i = 0) => c.evalJs(`document.querySelectorAll(${JSON.stringify(sel)})[${i}]?.disabled ?? null`);
const setSelect = (sel, value) => c.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const notesOf = async (trackId = "track-1", clipId = "clip-1") => Object.values((await project()).tracks[trackId].clips[clipId].notes).sort((a, b) => a.startTick - b.startTick);
const centerOn = (pitch) => c.evalJs(`(() => { const el = document.querySelector('[data-testid=piano-roll-scroll]'); el.scrollTop = (83 - ${pitch}) * 18 + 26 - el.clientHeight / 2; })()`);
const drawAt = async (beat, pitch) => {
  await centerOn(66);
  await sleep(120);
  const g = await c.rectOf("[data-testid=grid]");
  await c.click(g.x + beat * 120 + 4, g.y + (83 - pitch) * 18 + 9);
};
const note = (id, pitch, start, dur = 480) => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id, pitch, startTick: start, durationTicks: dur, velocity: 100 } });
const toolPressed = (id) => attr(`[data-tool=${id}]`, "aria-pressed");
const complete = (id) => c.evalJs(`window.daw.completeLesson(${JSON.stringify(id)})`);
const featureRow = (id) => attr(`[data-testid=feature-row][data-feature-id="${id}"]`, "data-unlocked");

try {
  await until(async () => (await text("[data-testid=engine-chip]")).includes("Engine connected"), 15000);

  // =====================================================================
  //  PROJECT KEY, SCALE HIGHLIGHT, RED OUT-OF-KEY NOTES
  // =====================================================================
  check("K1. a new project has no key and shows no key highlighting", (await project()).key === null && (await q("[data-in-key]")) === 0 && (await c.evalJs(`document.querySelector('[data-testid=key-select]').value`)) === "none");

  await setSelect("[data-testid=key-select]", "0-major");
  await until(async () => (await project()).key !== null);
  await sleep(200);
  const k = (await project()).key;
  check("K2. choosing C major in the toolbar saves it in the project", k && k.tonic === 0 && k.mode === "major");
  const rows = { root: await q('[data-testid=grid] [data-in-key="root"]'), inKey: await q('[data-testid=grid] [data-in-key="true"]'), out: await q('[data-testid=grid] [data-in-key="false"]') };
  check("K3. the piano roll lights the 7 scale notes per octave: 4 root rows, 24 other scale rows, 20 dimmed rows (C2-B5)", rows.root === 4 && rows.inKey === 24 && rows.out === 20, JSON.stringify(rows));
  const keyMarks = { root: await q('[data-key] [data-in-key="root"]'), inKey: await q('[data-key] [data-in-key="true"]') };
  check("K4. the on-screen keyboard marks the same keys (root brighter)", keyMarks.root === 4 && keyMarks.inKey === 24, JSON.stringify(keyMarks));

  await c.clickEl("[data-tool=draw]");
  await drawAt(1, 66); // F#4: not in C major
  await drawAt(3, 64); // E4: in key
  await until(async () => (await notesOf()).length === 2);
  await sleep(200);
  const notes = await notesOf();
  const flags = await c.evalJs(`[...document.querySelectorAll('[data-note-id]')].map(e => [e.dataset.noteId, e.dataset.outOfKey === 'true'])`);
  const fsharp = notes.find((n) => n.pitch === 66), e4 = notes.find((n) => n.pitch === 64);
  check("K5. a note outside the key (F#4) turns red; a note in the key (E4) does not", flags.find(([id]) => id === fsharp.id)[1] === true && flags.find(([id]) => id === e4.id)[1] === false);
  const warn = await text("[data-testid=key-warning]");
  check("K6. a plain-English message says what is wrong and what to try", warn.includes("1 note outside C major") && warn.includes("F♯ is not in C major. Try F or G."), warn.trim().slice(0, 90));

  await c.clickEl("[data-testid=key-fix]");
  await until(async () => (await notesOf()).every((n) => n.pitch !== 66));
  await sleep(200);
  const fixed = await notesOf();
  check("K7. Fix moves the red note to the nearest note in the key (F#4 -> F4) and clears the warning", fixed.some((n) => n.pitch === 65) && fixed.length === 2 && (await q("[data-testid=key-warning]")) === 0 && (await q("[data-out-of-key]")) === 0);
  await c.ctrl("z");
  await until(async () => (await notesOf()).some((n) => n.pitch === 66));
  await sleep(200);
  check("K8. one Ctrl+Z undoes the fix (the red note is back)", (await q("[data-out-of-key]")) === 1);

  await setSelect("[data-testid=key-select]", "7-major");
  await until(async () => (await project()).key?.tonic === 7);
  await sleep(200);
  check("K9. in G major the same F# is in key, so nothing is red", (await q("[data-out-of-key]")) === 0 && (await q("[data-testid=key-warning]")) === 0);
  await setSelect("[data-testid=key-select]", "9-minor");
  await until(async () => (await project()).key?.tonic === 9);
  await sleep(200);
  check("K10. in A minor (relative of C major) the F# is out again", (await q("[data-out-of-key]")) === 1 && (await text("[data-testid=key-warning]")).includes("A minor"));

  await c.clickEl("[data-testid=key-help-toggle]");
  await sleep(200);
  check("K11. the key-help toggle hides the highlight and the red notes", (await q("[data-out-of-key]")) === 0 && (await q("[data-in-key]")) === 0);
  await c.clickEl("[data-testid=key-help-toggle]");
  await sleep(200);
  check("K12. and brings them back", (await q("[data-out-of-key]")) === 1);

  // drum tracks have no key
  await c.evalJs(`window.daw.dispatch({ type: "addTrack", track: { id: "td", name: "Kit", instrument: "drums", color: "#f472b6", volume: 80, pan: 0, mute: false, solo: false, clips: { cd: { id: "cd", name: "Beat", startTick: 0, lengthTicks: 15360, notes: { dn: { id: "dn", pitch: 61, startTick: 0, durationTicks: 240, velocity: 100 } } } } } })`);
  await sleep(300);
  await c.evalJs(`(() => { const el = [...document.querySelectorAll('[data-testid=clip]')].find(e => e.dataset.clipId === 'cd'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); })()`);
  await sleep(300);
  check("K13. a drum track is never marked: no red notes, no highlighted rows (its rows are instruments)", (await q("[data-out-of-key]")) === 0 && (await q("[data-testid=grid] [data-in-key]")) === 0 && (await q("[data-testid=key-help-toggle]")) === 0);
  await c.clickEl('[data-testid=track-row][data-track-id="track-1"] [data-testid=track-name]');
  await sleep(300);

  await setSelect("[data-testid=key-select]", "0-major");
  await until(async () => (await project()).key?.tonic === 0 && (await project()).key?.mode === "major");
  await c.ctrl("z");
  await until(async () => (await project()).key?.tonic === 9);
  check("K14. changing the key is undoable", (await project()).key.tonic === 9 && (await project()).key.mode === "minor");
  await c.ctrl("y");
  await until(async () => (await project()).key?.tonic === 0);
  await setSelect("[data-testid=key-select]", "none");
  await until(async () => (await project()).key === null);
  await sleep(200);
  check("K15. 'No key' clears it and all highlighting", (await q("[data-in-key]")) === 0 && (await q("[data-out-of-key]")) === 0);
  await setSelect("[data-testid=key-select]", "2-major");
  await until(async () => (await project()).key?.tonic === 2);

  // =====================================================================
  //  FEATURE UNLOCK: BEGINNER MODE
  // =====================================================================
  const lockedNow = () => q("[data-locked]");
  check("U1. by default everything is available: no control is locked", (await lockedNow()) === 0 && (await progress()).mode === "all");

  await c.evalJs(`window.daw.setProgressMode("beginner")`);
  await sleep(400);
  const drawD = await disabled("[data-tool=draw]"), delD = await disabled("[data-tool=delete]");
  const locked = {};
  for (const t of ["select", "paint", "mute", "slice"]) locked[t] = await disabled(`[data-tool=${t}]`);
  check("U2. Beginner mode: Draw and Delete stay available; Select, Paint, Mute and Slice are locked", drawD === false && delD === false && Object.values(locked).every((v) => v === true), JSON.stringify(locked));
  const paintTitle = await attr("[data-tool=paint]", "title");
  check("U3. a locked control explains itself: the lesson that unlocks it, with its title", paintTitle === "Locked. Unlocked by lesson M6.4: Variations and off-beats.", paintTitle);
  check("U4. Snap/grid, Key, Export, Mixer, + Clip and Add track are locked too; Play, Stop and Undo are not", (await disabled("[data-testid=snap-toggle]")) && (await disabled("[data-testid=key-select]")) && (await disabled("[data-testid=export-wav]")) && (await disabled("[data-testid=mixer-toggle]")) && (await disabled("[data-testid=arr-add-clip]")) && (await disabled("[data-testid=add-track]")) && (await c.evalJs(`!document.querySelector('[data-testid=piano-toggle]').disabled`)));

  // shortcuts must obey the locks too
  await c.clickEl("[data-tool=draw]");
  for (const key of ["p", "s", "m", "c"]) await c.key(key, "Key" + key.toUpperCase());
  await sleep(150);
  check("U5. pressing a locked tool's shortcut key (P, S, M, C) does nothing: Draw stays selected", (await toolPressed("draw")) === "true" && (await toolPressed("paint")) === "false" && (await toolPressed("select")) === "false");

  await c.evalJs(`window.daw.dispatchBatch(${JSON.stringify([note("b1", 60, 0), note("b2", 64, 960)])})`);
  await until(async () => (await notesOf()).length >= 4);
  await sleep(200);
  const before = JSON.stringify(await notesOf());
  const nb = await c.rectOf('[data-note-id="b1"]');
  await c.drag(nb.x + 8, nb.y + 8, nb.x + 8 + 60, nb.y + 8 - 36, 6);
  await sleep(300);
  check("U6. until Select is unlocked, dragging a note with Draw does not move it", JSON.stringify(await notesOf()) === before);
  await c.ctrl("a");
  await sleep(150);
  check("U7. Ctrl+A (Select all) does nothing while locked", !(await text("[data-testid=selection-count]")).includes("selected"));
  await c.ctrl("d");
  await sleep(250);
  check("U8. Ctrl+D (Duplicate) does nothing while locked", JSON.stringify(await notesOf()) === before);

  // clip editing and tracks
  const lane = await c.rectOf('[data-testid=lane][data-track-id="track-1"]');
  const clipsBefore = (await q("[data-testid=clip]"));
  await c.dblclick(lane.x + 6 * 90 + 20, lane.y + 25);
  await sleep(300);
  const clipBox = await c.rectOf('[data-testid=clip][data-clip-id="clip-1"]');
  await c.drag(clipBox.cx, clipBox.cy, clipBox.cx + 90, clipBox.cy, 6);
  await sleep(300);
  check("U9. until the clips lesson, a clip can be selected but not created, moved or resized", (await q("[data-testid=clip]")) === clipsBefore && (await project()).tracks["track-1"].clips["clip-1"].startTick === 0);

  // ---------------- unlocking through the lesson API ----------------
  const first = await complete("M0.4");
  await sleep(500);
  check("U10. completeLesson('M0.4') unlocks Select and Snap at once, without a restart; others stay locked", first.ok && first.newlyCompleted === true && (await disabled("[data-tool=select]")) === false && (await disabled("[data-testid=snap-toggle]")) === false && (await disabled("[data-tool=paint]")) === true);
  check("U11. a toast tells the learner what they unlocked", (await text("[data-testid=unlock-toast]")).includes("Select, move and resize notes") && (await text("[data-testid=unlock-toast]")).includes("Snap and grid size"), (await text("[data-testid=unlock-toast]")).trim());
  const again = await complete("M0.4");
  check("U12. completing the same lesson twice is harmless", again.ok && again.newlyCompleted === false && (await progress()).completedLessons.filter((l) => l === "M0.4").length === 1);
  const bad = [await complete("lesson-1"), await complete(""), await complete("M0"), await complete("../../etc")];
  check("U13. things that are not lesson ids are rejected", bad.every((r) => r.ok === false) && (await progress()).completedLessons.length === 1);

  await c.clickEl("[data-testid=edit-strip]"); // give the piano roll keyboard focus (shortcuts only act on the focused panel)
  await c.key("s", "KeyS");
  await sleep(150);
  check("U14. the Select tool works now (shortcut S selects it)", (await toolPressed("select")) === "true");
  const nb2 = await c.rectOf('[data-note-id="b1"]');
  await c.drag(nb2.x + 8, nb2.y + 8, nb2.x + 8 + 60, nb2.y + 8, 6);
  await sleep(300);
  check("U15. and a note can be moved", (await notesOf()).find((n) => n.id === "b1").startTick !== 0);
  await c.ctrl("a");
  await sleep(150);
  check("U16. Select all (Ctrl+A) is unlocked with the Select tool", (await text("[data-testid=selection-count]")).includes("selected"));
  await c.ctrl("d");
  await sleep(250);
  check("U17. but Duplicate stays locked until lesson M0.5", (await notesOf()).length === 4 && (await disabled("[data-testid=edit-strip] button", 3)) === true);

  await complete("M0.5");
  await sleep(400);
  await c.ctrl("d");
  await until(async () => (await notesOf()).length > 4, 3000);
  check("U18. completing M0.5 unlocks Copy / Paste / Duplicate", (await notesOf()).length > 4);

  // tracks, drums, arrangement, mixer, export
  check("U19. adding tracks is locked until lesson M4.6, drums until M6.2", (await disabled("[data-testid=add-track]")) === true);
  await complete("M4.6");
  await sleep(300);
  await c.clickEl("[data-testid=add-track]");
  await sleep(200);
  check("U20. after M4.6 a synth track can be added, but the drum option is still locked", (await disabled("[data-testid=add-synth]")) === false && (await disabled("[data-testid=add-drums]")) === true);
  await complete("M6.2");
  await sleep(300);
  check("U21. after M6.2 the drum option is available", (await disabled("[data-testid=add-drums]")) === false);
  const rowsBefore = await q("[data-testid=track-row]");
  await c.clickEl("[data-testid=add-synth]");
  await until(async () => (await q("[data-testid=track-row]")) === rowsBefore + 1);
  check("U22. the track really gets added once unlocked", (await q("[data-testid=track-row]")) === rowsBefore + 1);

  check("U23. track Mute/Solo are locked until M9.4, the Mixer until M9.2, Export until M10.3", (await disabled('[data-testid=track-row] [aria-label^="Mute"]')) === true && (await disabled("[data-testid=mixer-toggle]")) === true && (await disabled("[data-testid=export-wav]")) === true);
  await complete("M9.2"); await complete("M9.4"); await complete("M10.3");
  await sleep(400);
  check("U24. after those lessons they are all available", (await disabled('[data-testid=track-row] [aria-label^="Mute"]')) === false && (await disabled("[data-testid=mixer-toggle]")) === false && (await disabled("[data-testid=export-wav]")) === false);

  await complete("M8.2");
  await sleep(400);
  const lane2 = await c.rectOf('[data-testid=lane][data-track-id="track-1"]');
  const cb = await q("[data-testid=clip]");
  await c.dblclick(lane2.x + 6 * 90 + 20, lane2.y + 25);
  await until(async () => (await q("[data-testid=clip]")) === cb + 1, 3000);
  check("U25. after M8.2 clips can be created", (await q("[data-testid=clip]")) === cb + 1);

  // key help locks with its lesson
  check("U26. the key selector is still locked (lesson M2.6 not done) and the earlier key shows no help", (await disabled("[data-testid=key-select]")) === true && (await q("[data-out-of-key]")) === 0 && (await q("[data-testid=grid] [data-in-key]")) === 0);
  await complete("M2.6");
  await sleep(400);
  check("U27. completing M2.6 turns the key help on (the project's key shows through)", (await disabled("[data-testid=key-select]")) === false && (await q("[data-testid=grid] [data-in-key]")) > 0);

  // ---------------- Features panel ----------------
  await c.evalJs(`window.daw.resetProgress()`);
  await sleep(300);
  await c.clickEl("[data-testid=features-toggle]");
  await sleep(300);
  const rowsInfo = await c.evalJs(`[...document.querySelectorAll('[data-testid=feature-row]')].map(r => [r.dataset.featureId, r.dataset.unlocked])`);
  const unlockedCount = rowsInfo.filter(([, u]) => u === "true").length;
  check("U28. the Features panel lists every feature; after a reset only the 4 starter features are unlocked", rowsInfo.length === 19 && unlockedCount === 4 && (await featureRow("tool.draw")) === "true" && (await featureRow("export.wav")) === "false", `${rowsInfo.length} rows, ${unlockedCount} unlocked`);
  await c.evalJs(`(() => { const el = document.querySelector('[data-testid=dev-lesson-select]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, 'M6.4'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await c.clickEl("[data-testid=dev-complete]");
  await sleep(400);
  check("U29. the developer tool completes a lesson: Paint and Quantize unlock", (await featureRow("tool.paint")) === "true" && (await featureRow("edit.quantize")) === "true" && (await disabled("[data-tool=paint]")) === false);
  await c.clickEl("[data-testid=mode-switch]");
  await sleep(400);
  check("U30. switching Beginner mode off unlocks everything", (await progress()).mode === "all" && (await lockedNow()) === 0 && (await featureRow("export.wav")) === "true");
  await c.clickEl("[data-testid=mode-switch]");
  await sleep(300);
  await c.key("Escape", "Escape");
  await c.clickEl("[data-tool=paint]");
  await sleep(150);
  check("U31. Paint is usable because its lesson is done", (await toolPressed("paint")) === "true");
  await c.evalJs(`window.daw.resetProgress()`);
  await sleep(400);
  check("U32. if its lesson is forgotten while Paint is active, the tool falls back to Draw", (await toolPressed("draw")) === "true" && (await disabled("[data-tool=paint]")) === true);

  // ---------------- persistence ----------------
  await complete("M0.4");
  await complete("M2.6");
  await sleep(300);
  const savedProgress = await progress();
  const savedProject = await project();
  c.ws.close();
  killTree(child);
  await sleep(1500);
  child = launch(PORT, dataDir);
  c = await connect(PORT);
  await until(async () => (await text("[data-testid=engine-chip]")).includes("Engine connected"), 15000);
  const after = await progress();
  check("U33. force-killed app: completed lessons and Beginner mode are remembered", JSON.stringify(after) === JSON.stringify(savedProgress) && after.mode === "beginner" && after.completedLessons.join() === "M0.4,M2.6", JSON.stringify(after));
  check("U34. the unlocked tools are unlocked again on screen, others are still locked", (await disabled("[data-tool=select]")) === false && (await disabled("[data-tool=paint]")) === true);
  const proj2 = await project();
  check("U35. the project (including its key) is restored; progress is not stored inside the project", proj2.key && proj2.key.tonic === savedProject.key.tonic && !JSON.stringify(proj2).includes("completedLessons"));
} catch (e) {
  check("m4 run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
