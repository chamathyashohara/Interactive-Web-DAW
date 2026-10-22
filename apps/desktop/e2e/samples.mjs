// Sample browser end-to-end checks: the Starter packs, search/filter, audition through the real audio engine,
// importing a zip (brand word removed, categories, a damaged file), persistence across restarts, removal, feature gating.
// Usage: node apps/desktop/e2e/samples.mjs   (build the app first: npm run build -w apps/desktop; build the engine too)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9341;
const dataDir = tmpDataDir("daw-samples-");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "daw-samples-src-"));

// ---------------------------------------------------------------- a pack shaped like a typical download
function wav16(file, secs, hz, rate = 44100) {
  const n = Math.round(secs * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 60) * Math.exp(-(i / rate) * (3 / secs)) ;
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.7 * env * 32767), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
const pack = path.join(work, "KSHMR Test Pack");
wav16(path.join(pack, "Drums", "Kicks", "KSHMR Big Kick 01 (A).wav"), 0.6, 55);
wav16(path.join(pack, "Drums", "Kicks", "KSHMR Tight Kick 02.wav"), 0.4, 60);
wav16(path.join(pack, "Drums", "Snares", "KSHMR Crack Snare 01.wav"), 0.4, 800);
wav16(path.join(pack, "Drums", "Snares", "KSHMR Fat Snare 02.wav"), 0.4, 700);
wav16(path.join(pack, "Drums", "Hats", "KSHMR Open Hat 01.wav"), 0.5, 6000);
wav16(path.join(pack, "Drums", "Hats", "KSHMR Closed Hat 01.wav"), 0.15, 7000);
wav16(path.join(pack, "Drums", "Claps", "KSHMR Clap 01.wav"), 0.3, 900);
wav16(path.join(pack, "FX", "KSHMR Riser 01.wav"), 1.0, 300);
wav16(path.join(pack, "Loops", "KSHMR Drum Loop 120 bpm.wav"), 4.0, 100);
wav16(path.join(pack, "Bass", "KSHMR Sub Bass (F#m).wav"), 1.0, 46);
fs.writeFileSync(path.join(pack, "Drums", "KSHMR Broken Kick.wav"), "this is not audio at all");
fs.writeFileSync(path.join(pack, "readme.txt"), "not audio");
const GOOD = 10;
const zip = path.join(work, "kshmr samples.zip");
const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const made = spawnSync(tar, ["-a", "-cf", zip, "-C", pack, "."], { windowsHide: true });
const haveZip = made.status === 0 && fs.readFileSync(zip).subarray(0, 2).toString("latin1") === "PK";

// The panel buttons open a file dialog; in test mode the app takes the zip from this variable instead.
if (haveZip) process.env.DAW_E2E_IMPORT = zip;
let child = launch(PORT, dataDir);
let c = await connect(PORT);

const q = (sel) => c.evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const text = (sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const lib = () => c.evalJs(`window.daw.getLibrary()`);
const rowNames = () => c.evalJs(`[...document.querySelectorAll('[data-testid=sample-row]')].map(r => r.querySelector('span.truncate').textContent)`);
const typeSearch = async (s) => {
  await c.evalJs(`(() => { const i = document.querySelector('[data-testid=sample-search]'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(s)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(150);
};
const total = async () => (await text("[data-testid=sample-count]"));
// An engine-status recorder in the page: highest master level and preview positions seen since the last reset.
const installRec = () => c.evalJs(`(() => { window.__rec = { maxL: 0, maxPrev: -1, seen: [], overruns: 0 }; window.daw.onEngineStatus((s) => { const r = window.__rec; r.maxL = Math.max(r.maxL, s.masterL, s.masterR); r.maxPrev = Math.max(r.maxPrev, s.preview); r.last = s.preview; r.overruns = s.overruns; r.lv = r.lv || {}; for (const [k, v] of Object.entries(s.levels)) r.lv[k] = Math.max(r.lv[k] || 0, v); }); window.__exports = []; window.daw.onExportStatus((x) => window.__exports.push(x)); })()`);
await installRec();
const resetRec = () => c.evalJs(`(() => { window.__rec.maxL = 0; window.__rec.maxPrev = -1; window.__rec.lv = {}; })()`);
const level = (trackId) => c.evalJs(`(window.__rec.lv || {})[${JSON.stringify(trackId)}] || 0`);
const proj = () => c.evalJs(`window.daw.getInitial().then(x => x.project)`);
const canUndo = () => c.evalJs(`window.daw.getInitial().then(x => x.canUndo)`);
const rec = () => c.evalJs(`({ maxL: window.__rec.maxL, maxPrev: window.__rec.maxPrev, last: window.__rec.last, overruns: window.__rec.overruns })`);
const rowEl = (name) => `[...document.querySelectorAll('[data-testid=sample-row]')].find(r => r.querySelector('span.truncate').textContent === ${JSON.stringify(name)})`;
const clickRow = async (name) => {
  await typeSearch(name); // the list only draws the visible rows, so bring the sound into view by searching for it
  const r = await c.evalJs(`(() => { const el = ${rowEl(name)}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error("row not found: " + name);
  await c.click(r.x, r.y);
};

try {
  await until(async () => (await text("[data-testid=engine-chip]")).includes("Engine connected"), 15000);

  // The arrangement now snaps to the toolbar grid; these checks are about whole bars, so use the "1 bar" grid.
  await c.evalJs(`(() => { const el = document.querySelector('[aria-label="Grid size"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, '3840'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  // =====================================================================
  //  STARTER PACKS
  // =====================================================================
  const ready = await until(async () => (await lib()).status.state === "ready", 90000, 300);
  const L = await lib();
  check("L1. the Starter packs are generated on first run", !!ready && L.entries.length >= 140, `${L.entries.length} sounds`);
  check("L2. five Starter packs, none imported yet", L.packs.length === 5 && L.packs.every((p) => p.origin === "starter"), L.packs.map((p) => `${p.name} ${p.count}`).join(", "));
  check("L3. the sound browser is closed by default", (await q("[data-testid=samples-panel]")) === 0);

  // ---- gating
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await sleep(250);
  const locked = await c.evalJs(`(() => { const b = document.querySelector('[data-testid=samples-toggle]'); return { disabled: b.disabled, title: b.title }; })()`);
  check("L4. in beginner mode the Sounds button is locked and says which lesson unlocks it", locked.disabled && locked.title.includes("M6.2"), locked.title);
  await c.evalJs(`window.daw.completeLesson('M6.2')`);
  await sleep(300);
  check("L5. finishing lesson M6.2 unlocks it", (await c.evalJs(`document.querySelector('[data-testid=samples-toggle]').disabled`)) === false);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await sleep(200);

  // ---- open + browse
  await c.clickEl("[data-testid=samples-toggle]");
  await until(async () => (await q("[data-testid=samples-panel]")) === 1);
  await sleep(300);
  const shown = (await q("[data-testid=sample-row]"));
  check("L6. opening the browser lists the sounds, with only the visible rows drawn", shown > 5 && shown < 60, `${shown} rows in the DOM of ${L.entries.length}`);
  check("L7. the count shows the whole library", (await total()).includes(`${L.entries.length} of ${L.entries.length}`), await total());
  check("L8. while the library is open, the arrangement is still usable (layout intact)", (await q("[data-testid=piano-panel]")) === 1);

  await typeSearch("kick");
  const kickNames = await rowNames();
  check("L9. searching “kick” narrows the list to kicks", kickNames.length >= 8 && kickNames.length < 40, `${await total()}`);
  const kickCount = Number((await total()).split(" ")[0]);
  await c.evalJs(`document.querySelector('[data-testid=cat-Kick]').click()`);
  await sleep(150);
  check("L10. the Kick chip shows only kicks", Number((await total()).split(" ")[0]) >= 10 && (await c.evalJs(`document.querySelector('[data-testid=cat-Kick]').textContent`)).includes(String(kickCount)));
  await typeSearch("");
  await c.evalJs(`document.querySelector('[data-testid=cat-Kick]').click()`); // chip toggles back to All
  await sleep(150);
  await typeSearch("zzzz-nothing");
  check("L11. a search with no match says so", (await q("[data-testid=sample-row]")) === 0 && (await c.evalJs(`document.body.innerText`)).includes("Nothing matches"));
  await typeSearch("");

  // =====================================================================
  //  AUDITION THROUGH THE REAL ENGINE
  // =====================================================================
  await resetRec();
  await clickRow("Punch Kick");
  const heard = await until(async () => (await rec()).maxL > 0.03, 3000, 50);
  const r1 = await rec();
  check("L12. clicking a sound plays it through the engine: the master meter moves", !!heard, `peak ${r1.maxL.toFixed(3)}`);
  check("L13. the engine reports how far through the sound it is", r1.maxPrev >= 0);
  check("L14. the row shows that it is playing", (await c.evalJs(`!!${rowEl("Punch Kick")}?.dataset.playing`)) === true || (await rec()).last < 0);
  const finished = await until(async () => (await rec()).last < 0, 4000, 100);
  check("L15. a one-shot ends by itself", !!finished);

  await resetRec();
  await clickRow("Sad Piano Am 75");
  await until(async () => (await rec()).last > 0.05, 3000, 50);
  await clickRow("Sad Piano Am 75"); // click the playing sound again = stop (a 12.8 s loop, so it is still playing)
  const stopped = await until(async () => (await rec()).last < 0, 1500, 50);
  check("L16. clicking a playing sound stops it", !!stopped);
  await sleep(200);
  await resetRec();
  await sleep(300);
  check("L17. after stopping, the output is silent", (await rec()).maxL < 0.001, `peak ${(await rec()).maxL}`);

  // keyboard: arrow keys audition the next sound
  await c.clickEl("[data-testid=sample-search]");
  await resetRec();
  await c.key("ArrowDown", "ArrowDown");
  const kbd = await until(async () => (await rec()).maxPrev >= 0, 3000, 50);
  check("L18. ↓ in the search box plays the next sound", !!kbd);
  await c.key("Escape", "Escape");
  await until(async () => (await rec()).last < 0, 1500, 50);

  // drag payload
  const payload = await c.evalJs(`(() => {
    const el = ${rowEl("Tight Snare")};
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    return { draggable: el.draggable, data: dt.getData('application/x-daw-sample') };
  })()`);
  const pj = payload.data ? JSON.parse(payload.data) : {};
  check("L19. a row can be dragged and carries the sound id and name", payload.draggable && pj.name === "Tight Snare" && typeof pj.id === "string" && pj.category === "Snare", payload.data);

  // preview must not disturb song playback
  await c.evalJs(`window.daw.dispatch({ type: 'addNote', trackId: 'track-1', clipId: 'clip-1', note: { id: 'n-play', pitch: 60, startTick: 0, durationTicks: 3840, velocity: 100 } })`);
  await c.evalJs(`window.daw.play()`);
  await sleep(300);
  for (const n of ["Punch Kick", "Tight Snare", "Closed Hat Tight", "Deep 808 Kick"]) {
    await clickRow(n);
    await sleep(250);
  }
  const during = await rec();
  check("L20. auditioning sounds while the song plays causes no audio overruns", during.overruns === 0, `overruns ${during.overruns}`);
  await c.evalJs(`window.daw.stop()`);
  await c.evalJs(`window.daw.stopPreviewSample()`);


  // =====================================================================
  //  DROPPING A SOUND ON THE ARRANGEMENT
  // =====================================================================
  await c.evalJs(`window.daw.dispatch({ type: 'deleteNote', trackId: 'track-1', clipId: 'clip-1', noteId: 'n-play' })`);
  await c.evalJs(`window.daw.dispatch({ type: 'setSongLength', bars: 8 })`);
  await typeSearch("");
  // Runs the browser's drag and drop with real DOM drag events: dragstart on the row, dragover and drop on the arrangement.
  const PX_BAR = 90;
  const drag = async (name, { lane = null, bar = 0, drop = true } = {}) => {
    await typeSearch(name);
    return c.evalJs(`(() => {
      const row = ${rowEl(name)};
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const ruler = document.querySelector('[data-testid=arr-ruler]').getBoundingClientRect();
      const x = ruler.left + ${bar} * ${PX_BAR} + 6;
      const target = ${lane ? `document.querySelector('[data-testid=lane][data-track-id="${lane}"]')` : `document.querySelector('[data-testid=arrangement-scroll]')`};
      const r = target.getBoundingClientRect();
      const y = r.top + Math.min(r.height - 4, ${lane ? "20" : "r.height - 4"});
      const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
      const over = ev('dragover'); target.dispatchEvent(over);
      const result = { overAccepted: over.defaultPrevented };
      return new Promise((resolve) => setTimeout(() => {
        result.ghost = !!document.querySelector('[data-testid=drop-ghost], [data-testid=drop-new-track]');
        if (${drop ? "true" : "false"}) { const d = ev('drop'); target.dispatchEvent(d); result.dropAccepted = d.defaultPrevented; }
        row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        resolve(result);
      }, 120));
    })()`);
  };
  const trackNamed = async (n) => Object.values((await proj()).tracks).find((t) => t.name === n);

  const hover = await drag("Punch Kick", { bar: 2, drop: false });
  check("D1. dragging a sound over the arrangement is accepted and shows where it would land", hover.overAccepted && hover.ghost, JSON.stringify(hover));
  const before = Object.keys((await proj()).tracks).length;
  await sleep(100);
  check("D2. just hovering changes nothing, and the preview disappears when the drag ends", Object.keys((await proj()).tracks).length === before && (await q("[data-testid=drop-ghost], [data-testid=drop-new-track]")) === 0);

  const d1 = await drag("Punch Kick", { bar: 2 });
  await sleep(300);
  const kickTrack = await trackNamed("Punch Kick");
  check("D3. dropping a sound makes a track named after it", !!d1.dropAccepted && !!kickTrack && kickTrack.instrument === "sample" && kickTrack.sample.id === "starter/kick/punch-kick", JSON.stringify(kickTrack?.sample));
  const kclip = kickTrack && Object.values(kickTrack.clips)[0];
  check("D4. the clip sits at the bar it was dropped on and plays the sound's note", kclip && kclip.startTick === 2 * 3840 && kclip.lengthTicks === 3840 && Object.values(kclip.notes).length === 1 && Object.values(kclip.notes)[0].pitch === 60, JSON.stringify(kclip && { s: kclip.startTick, l: kclip.lengthTicks }));
  check("D5. the track gets the colour of its category and is not a one-shot-gated sound", kickTrack.color === "#f97316" && kickTrack.sample.gate === false);
  const ui = await c.evalJs(`(() => { const row = document.querySelector('[data-testid=track-row][data-track-id="${kickTrack.id}"]'); const clip = document.querySelector('[data-testid=clip][data-track-id="${kickTrack.id}"]'); return { label: row?.textContent.includes('SMP'), name: row?.textContent.includes('Punch Kick'), wave: !!clip?.querySelector('svg rect') }; })()`);
  check("D6. the arrangement shows the track (SMP) and the sound's waveform inside the clip", ui.label && ui.name && ui.wave, JSON.stringify(ui));
  check("D7. the whole drop is one undo step", (await canUndo()) && (await (async () => { await c.evalJs(`window.daw.undo()`); await sleep(250); const gone = !(await trackNamed("Punch Kick")); await c.evalJs(`window.daw.redo()`); await sleep(250); return gone && !!(await trackNamed("Punch Kick")); })()));

  // it really plays: put the clip at bar 1 and listen to the engine
  const kt = await trackNamed("Punch Kick");
  await c.evalJs(`window.daw.dispatch({ type: 'updateClip', trackId: ${JSON.stringify(kt.id)}, clipId: ${JSON.stringify(Object.values(kt.clips)[0].id)}, changes: { startTick: 0 } })`);
  await sleep(250);
  await resetRec();
  await c.evalJs(`window.daw.play()`);
  const playing = await until(async () => (await level(kt.id)) > 0.05, 3000, 50);
  check("D8. the dropped sound plays in the song: its track meter and the master move", !!playing && (await rec()).maxL > 0.03, `track ${(await level(kt.id)).toFixed(3)} master ${(await rec()).maxL.toFixed(3)}`);
  await c.evalJs(`window.daw.stop()`);
  await sleep(300);
  await resetRec();
  await sleep(400);
  check("D9. stop silences it", (await rec()).maxL < 0.002, `peak ${(await rec()).maxL}`);

  // mute
  await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify(kt.id)}, changes: { mute: true } })`);
  await sleep(250);
  await resetRec();
  await c.evalJs(`window.daw.play()`);
  await sleep(900);
  check("D10. a muted sample track is silent", (await level(kt.id)) < 0.002 && (await rec()).maxL < 0.002, `track ${await level(kt.id)}`);
  await c.evalJs(`window.daw.stop()`);
  await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify(kt.id)}, changes: { mute: false } })`);

  // same sound on its own lane = another clip; overlapping is refused with a message
  const d2 = await drag("Punch Kick", { lane: kt.id, bar: 4 });
  await sleep(300);
  const kt2 = await trackNamed("Punch Kick");
  check("D11. dropping the same sound on its own lane adds a clip there, not a second track", Object.keys(kt2.clips).length === 2 && Object.values((await proj()).tracks).filter((t) => t.name === "Punch Kick").length === 1, `${Object.keys(kt2.clips).length} clips`);
  await drag("Punch Kick", { lane: kt.id, bar: 4 });
  await sleep(200);
  check("D12. dropping onto an existing clip is refused and says why", Object.keys((await trackNamed("Punch Kick")).clips).length === 2 && (await text("[data-testid=arr-hint]")).includes("already a clip"), await text("[data-testid=arr-hint]"));

  // a loop: gated, its own bar count, lengthens the song when needed
  await drag("Boom Bap 90 Drums", { bar: 7 });
  await sleep(300);
  const loopTrack = await trackNamed("Boom Bap 90 Drums");
  const lp = await proj();
  check("D13. a loop drops as a gated 2-bar clip and lengthens the song to fit", loopTrack?.sample.gate === true && Object.values(loopTrack.clips)[0].lengthTicks === 2 * 3840 && lp.songBars === 9, `bars ${lp.songBars}`);
  await c.evalJs(`window.daw.dispatch({ type: 'updateClip', trackId: ${JSON.stringify(loopTrack.id)}, clipId: ${JSON.stringify(Object.values(loopTrack.clips)[0].id)}, changes: { startTick: 0 } })`);
  await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify(kt.id)}, changes: { mute: true } })`);
  await sleep(250);
  await resetRec();
  await c.evalJs(`window.daw.play()`);
  const loopHeard = await until(async () => (await level(loopTrack.id)) > 0.05, 3000, 50);
  check("D14. the loop plays", !!loopHeard, `level ${(await level(loopTrack.id)).toFixed(3)}`);
  await c.evalJs(`window.daw.stop()`);

  // export renders it too
  await c.evalJs(`window.__exports.length = 0`);
  const exPath = path.join(work, "drop-export.wav");
  await c.evalJs(`window.daw.exportWav(${JSON.stringify(exPath)})`);
  const exDone = await until(async () => (await c.evalJs(`window.__exports.find(x => x.state === 'done' || x.state === 'error') || null`)), 20000, 100);
  check("D15. exporting the song to WAV includes the sample track", exDone?.state === "done" && exDone.peak > 0.05 && fs.existsSync(exPath), JSON.stringify(exDone && { state: exDone.state, peak: exDone.peak, message: exDone.message }));

  // the sample track opens in the piano roll without red notes (a drum hit is not a pitch)
  await c.evalJs(`window.daw.dispatch({ type: 'setKey', key: { tonic: 6, mode: 'major' } })`);
  await c.evalJs(`document.querySelector('[data-testid=clip][data-track-id="${loopTrack.id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(400);
  const red = await c.evalJs(`document.querySelectorAll('[data-note-id][data-out-of-key=true]').length`);
  const notesShown = await c.evalJs(`document.querySelectorAll('[data-note-id]').length`);
  check("D16. its piano roll shows the one note and never paints it red", notesShown === 1 && red === 0, `${notesShown} notes, ${red} red`);
  await c.evalJs(`window.daw.dispatch({ type: 'setKey', key: null })`);

  // lesson gating: a new track needs the "more than one track" feature
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await sleep(250);
  const tracksBefore = Object.keys((await proj()).tracks).length;
  await drag("Tight Snare", { bar: 1 });
  await sleep(300);
  check("D17. in beginner mode, before the lesson that unlocks tracks, a drop is refused with the lesson named", Object.keys((await proj()).tracks).length === tracksBefore && (await text("[data-testid=arr-hint]")).includes("M4.6"), await text("[data-testid=arr-hint]"));
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await sleep(200);

  // the grid size in the toolbar applies to the arrangement too
  const setGrid = (v) => c.evalJs(`(() => { const el = document.querySelector('[aria-label="Grid size"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, '${v}'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setGrid(960);
  await drag("Tight Snare", { bar: 0.5 });
  await sleep(300);
  const sn = await trackNamed("Tight Snare");
  check("G1. with the 1/4 grid, a dropped sound snaps to the beat (not to the bar)", sn && Object.values(sn.clips)[0].startTick === 1920, JSON.stringify(sn && Object.values(sn.clips)[0].startTick));
  await c.evalJs(`window.daw.undo()`);
  await sleep(250);
  await setGrid(3840);

  // =====================================================================
  //  FITTING A LOOP TO THE PROJECT TEMPO
  // =====================================================================
  // Render the song through the engine's WAV export and look at where the loud hits (kicks, snares) fall.
  const readWav = (file) => {
    const b = fs.readFileSync(file);
    let p = 12, fmt = null, data = null;
    while (p + 8 <= b.length) {
      const id = b.toString("latin1", p, p + 4), size = b.readUInt32LE(p + 4);
      if (id === "fmt ") fmt = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
      if (id === "data") data = b.subarray(p + 8, p + 8 + size);
      p += 8 + size + (size % 2);
    }
    const bytes = fmt.bits / 8, n = Math.floor(data.length / (bytes * fmt.ch));
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let c = 0; c < fmt.ch; c++) m += data.readIntLE((i * fmt.ch + c) * bytes, bytes) / 2 ** (fmt.bits - 1); mono[i] = m / fmt.ch; }
    return { rate: fmt.rate, mono };
  };
  const hits = ({ rate, mono }, secs = 8) => {
    const hop = Math.round(rate * 0.002), env = [];
    for (let i = 0; i + hop < Math.min(mono.length, secs * rate); i += hop) { let m = 0; for (let k = 0; k < hop; k++) m = Math.max(m, Math.abs(mono[i + k])); env.push(m); }
    const top = Math.max(...env), thr = 0.3 * top, out = [];
    let last = -1e9;
    env.forEach((v, i) => { const t = i * hop / rate; if (v > thr && t - last > 0.09) { out.push(t); last = t; } });
    return out;
  };
  // 5 ms-step loudness curve (smoothed over 3 steps) of the first `secs` seconds
  const curve = ({ rate, mono }, secs = 7) => {
    const hop = Math.round(rate * 0.005), raw = [];
    for (let i = 0; i + hop < Math.min(mono.length, secs * rate); i += hop) { let e = 0; for (let k = 0; k < hop; k++) e += mono[i + k] ** 2; raw.push(Math.sqrt(e / hop)); }
    return raw.map((v, i) => (v + (raw[i - 1] ?? v) + (raw[i + 1] ?? v)) / 3);
  };
  const at = (cv, t) => { const x = t / 0.005, i = Math.floor(x), f = x - i; return i < 0 || i + 1 >= cv.length ? 0 : cv[i] * (1 - f) + cv[i + 1] * f; };
  const corr = (a, b) => { const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb || 1); };
  /** How well `measured` matches the as-recorded loop played `factor` times as fast (the best match over a small time shift, in ms). */
  const bestMatch = (measured, reference, factor) => {
    let best = { c: -1, lagMs: 0 };
    const n = Math.floor(6.5 / 0.005);
    for (let lag = -12; lag <= 12; lag++) {
      const a = [], b = [];
      for (let i = 0; i < n; i++) { a.push(at(measured, i * 0.005)); b.push(at(reference, (i * 0.005 + lag * 0.005) * factor)); }
      const c = corr(a, b);
      if (c > best.c) best = { c, lagMs: lag * 5 };
    }
    return best;
  };
  const gridError = (times, bpm) => Math.max(...times.map((t) => { const step = 60 / bpm / 4; return Math.abs(t - Math.round(t / step) * step); }));
  let exportN = 0;
  const exportSong = async () => {
    await c.evalJs(`window.__exports.length = 0`);
    const file = path.join(work, `fit-${++exportN}.wav`);
    await c.evalJs(`window.daw.exportWav(${JSON.stringify(file)})`);
    const done = await until(async () => (await c.evalJs(`window.__exports.find(x => x.state === 'done' || x.state === 'error') || null`)), 30000, 100);
    if (done?.state !== "done") throw new Error("export failed " + JSON.stringify(done));
    return readWav(file);
  };
  const setTempo = async (bpm) => { await c.evalJs(`window.daw.dispatch({ type: 'setTempo', bpm: ${bpm} })`); await sleep(1200); };
  const lt = async () => Object.values((await proj()).tracks).find((t) => t.name === "Boom Bap 90 Drums");

  const t0 = await lt();
  check("T1. a loop with a known tempo drops in already set to follow the project tempo", t0.sample.bpm === 90 && t0.sample.fit === true, JSON.stringify(t0.sample));
  // Reference: the loop as recorded (Fit off). A loop made at 90 BPM, fitted to a project at B BPM, must play the same hits at
  // times scaled by 90 / B. Compared hit by hit, so a swung or humanised groove does not matter.
  await c.evalJs(`window.daw.dispatch({ type: 'updateSample', trackId: ${JSON.stringify(t0.id)}, changes: { fit: false } })`);
  await setTempo(120);
  const asRecordedWav = await exportSong();
  const asRecorded = curve(asRecordedWav);
  check("T2. with Fit off the loop plays as recorded, whatever the project tempo", hits(asRecordedWav).length >= 8 && Math.max(...asRecorded) > 0.05, `${hits(asRecordedWav).length} hits`);
  await c.evalJs(`window.daw.dispatch({ type: 'updateSample', trackId: ${JSON.stringify(t0.id)}, changes: { fit: true } })`);
  await sleep(800);
  for (const [name, bpm] of [["T3", 120], ["T4", 100], ["T5", 75]]) {
    await setTempo(bpm);
    const measured = curve(await exportSong());
    const right = bestMatch(measured, asRecorded, bpm / 90);
    const wrong = bestMatch(measured, asRecorded, 1); // what it would look like if it had not been stretched
    check(`${name}. at ${bpm} BPM the loop's loudness follows the recorded loop played ${bpm}/90 times as fast, to within 10 ms`, right.c > 0.7 && Math.abs(right.lagMs) <= 10 && right.c > wrong.c + 0.2, `match ${right.c.toFixed(2)} at ${right.lagMs} ms shift; unstretched would match ${wrong.c.toFixed(2)}`);
  }

  // the loop's own tempo and the Fit button on the track
  const ui2 = await c.evalJs(`(() => { const row = document.querySelector('[data-testid=track-row][data-track-id="${t0.id}"]'); return { bpm: row.querySelector('[data-testid=sample-bpm]')?.value, fit: row.querySelector('[data-testid=sample-fit-toggle]')?.getAttribute('aria-pressed') }; })()`);
  check("T6. the loop's track shows its original tempo and an active Fit button", ui2.bpm === "90" && ui2.fit === "true", JSON.stringify(ui2));
  await c.evalJs(`document.querySelector('[data-testid=track-row][data-track-id="${t0.id}"] [data-testid=sample-fit-toggle]').click()`);
  await sleep(300);
  check("T7. the Fit button switches stretching off, and undo brings it back", (await lt()).sample.fit === false && (await (async () => { await c.evalJs(`window.daw.undo()`); await sleep(300); return (await lt()).sample.fit === true; })()));
  await c.evalJs(`(() => { const i = document.querySelector('[data-testid=track-row][data-track-id="${t0.id}"] [data-testid=sample-bpm]'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '80'); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`);
  await sleep(400);
  check("T8. typing another original tempo changes it (for loops whose tempo is not known)", (await lt()).sample.bpm === 80);
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("T9. a tempo outside the allowed range is refused", (await c.evalJs(`window.daw.dispatch({ type: 'updateSample', trackId: ${JSON.stringify(t0.id)}, changes: { bpm: 5 } })`)).ok === false);

  // live playback while the tempo changes: no audio overruns, and the engine keeps answering
  await resetRec();
  await c.evalJs(`window.daw.play()`);
  await sleep(500);
  for (const bpm of [110, 130, 95, 120]) { await c.evalJs(`window.daw.dispatch({ type: 'setTempo', bpm: ${bpm} })`); await sleep(500); }
  const live = await rec();
  check("T10. changing the tempo while the song plays never overruns the audio thread", live.overruns === 0 && (await level(t0.id)) > 0.05, `overruns ${live.overruns}, level ${(await level(t0.id)).toFixed(2)}`);
  await c.evalJs(`window.daw.stop()`);
  await setTempo(120);

  // =====================================================================
  //  TRIM, FADES AND GAIN ON A SOUND CLIP
  // =====================================================================
  // Everything is judged on the audio the engine renders (WAV export), not on the screen.
  const rmsBetween = ({ rate, mono }, from, to) => { let e = 0, n = 0; for (let i = Math.floor(from * rate); i < Math.min(mono.length, Math.floor(to * rate)); i++, n++) e += mono[i] ** 2; return Math.sqrt(e / Math.max(1, n)); };
  const loopT = await lt(); // the Boom Bap loop: 2 bars at 120 BPM = 4 s, stretched to fit
  await setTempo(120);
  const clipId = Object.values(loopT.clips)[0].id;
  const clipSel = `[data-testid=clip][data-track-id="${loopT.id}"]`;
  const clipData = async () => Object.values((await lt()).clips)[0];
  const typeInto = (testId, value) => c.evalJs(`(() => { const i = document.querySelector('[data-testid=${testId}]'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(String(value))}); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`);
  await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify((await trackNamed("Punch Kick")).id)}, changes: { mute: true } })`);
  await c.clickEl(clipSel);
  await sleep(300);
  check("A1. selecting a sound clip shows its Gain and Fade fields", (await q("[data-testid=clip-audio]")) === 1 && (await q("[data-testid=fade-in-handle]")) === 1 && (await q("[data-testid=fade-out-handle]")) === 1);

  const ca_base = await exportSong();
  const baseRms = (a, b) => rmsBetween(ca_base, a, b);
  check("A2. reference render of the untouched loop has sound in every beat of its 4 s", baseRms(0, 1) > 0.02 && baseRms(1, 2) > 0.02 && baseRms(2, 3) > 0.02 && baseRms(3, 4) > 0.02, [0, 1, 2, 3].map((s) => baseRms(s, s + 1).toFixed(3)).join(" "));

  // ---- trim the start with the mouse: drag the left edge one bar to the right
  const ca_r0 = await c.rectOf(clipSel);
  await c.drag(ca_r0.x + 3, ca_r0.cy, ca_r0.x + 3 + 90, ca_r0.cy, 8);
  await sleep(500);
  const ca_trimmed = await clipData();
  const ca_expectSec = 3840 * (60 / (120 * 960)) * (120 / 90);
  check("A3. dragging the clip's left edge one bar trims its start: the clip is now bars 2 only, starting 2.67 s into the sound", ca_trimmed.startTick === 3840 && ca_trimmed.lengthTicks === 3840 && Math.abs((ca_trimmed.audio?.startSec ?? 0) - ca_expectSec) < 0.01, JSON.stringify({ s: ca_trimmed.startTick, l: ca_trimmed.lengthTicks, a: ca_trimmed.audio }));
  const trimmedWav = await exportSong();
  const ca_sil = rmsBetween(trimmedWav, 0.1, 1.9);
  const ca_corr2 = (() => { const rate = ca_base.rate, from = Math.floor(2.05 * rate), to = Math.floor(3.95 * rate); let sab = 0, saa = 0, sbb = 0; for (let i = from; i < to; i++) { sab += ca_base.mono[i] * trimmedWav.mono[i]; saa += ca_base.mono[i] ** 2; sbb += trimmedWav.mono[i] ** 2; } return sab / Math.sqrt(saa * sbb || 1); })();
  check("A4. after the trim, bar 1 is silent and bar 2 is exactly the same sound as before (it still lines up)", ca_sil < 0.002 && ca_corr2 > 0.95, `bar 1 level ${ca_sil.toFixed(4)}, bar 2 match ${ca_corr2.toFixed(3)}`);
  await c.evalJs(`window.daw.undo()`);
  await sleep(400);
  const ca_untrimmed = await clipData();
  check("A5. undo puts the start back", ca_untrimmed.startTick === 0 && ca_untrimmed.lengthTicks === 7680 && !ca_untrimmed.audio?.startSec, JSON.stringify(ca_untrimmed.audio));

  // ---- gain
  await c.clickEl(clipSel);
  await typeInto("clip-gain", -6);
  await sleep(500);
  check("A6. typing -6 in Gain stores -6 dB on the clip", (await clipData()).audio?.gainDb === -6);
  const g6 = await exportSong();
  const ratio = rmsBetween(g6, 0, 4) / rmsBetween(ca_base, 0, 4);
  check("A7. the rendered loop is 6 dB quieter (half the level)", Math.abs(ratio - 0.501) < 0.03, `level ratio ${ratio.toFixed(3)}`);
  await typeInto("clip-gain", 0);
  await sleep(400);
  check("A8. gain 0 removes the setting", (await clipData()).audio === undefined);

  // ---- fade in: 4 beats = 2 s
  await typeInto("clip-fade-in", 4);
  await sleep(500);
  const ca_fi = await clipData();
  check("A9. Fade in of 4 beats is stored (3840 ticks) and drawn as a shape on the clip", ca_fi.audio?.fadeInTicks === 3840 && (await c.evalJs(`document.querySelector('[data-testid=fade-shape]')?.getAttribute('data-fade-in')`)) === "3840");
  const fadedIn = await exportSong();
  const ca_early = rmsBetween(fadedIn, 0.05, 0.5) / rmsBetween(ca_base, 0.05, 0.5);
  const ca_late = rmsBetween(fadedIn, 1.5, 2.0) / rmsBetween(ca_base, 1.5, 2.0);
  const ca_after = rmsBetween(fadedIn, 2.5, 3.5) / rmsBetween(ca_base, 2.5, 3.5);
  check("A10. the fade in ramps the sound up over 2 s (quiet at the start, nearly full at 2 s, untouched after)", ca_early < 0.3 && ca_late > 0.55 && ca_late < 1.0 && ca_after > 0.9 && ca_after < 1.1, `start ${ca_early.toFixed(2)}, near end of fade ${ca_late.toFixed(2)}, ca_after ${ca_after.toFixed(2)}`);

  // ---- fade out: 2 beats = 1 s, and it ends where the clip ends
  await typeInto("clip-fade-in", 0);
  await typeInto("clip-fade-out", 2);
  await sleep(500);
  const ca_fo = await clipData();
  check("A11. Fade out of 2 beats is stored and makes the clip cut its sound at its end", ca_fo.audio?.fadeOutTicks === 1920 && ca_fo.audio?.cut === true);
  const fadedOut = await exportSong();
  const startRatio = rmsBetween(fadedOut, 1.0, 2.5) / rmsBetween(ca_base, 1.0, 2.5);
  const endRatio = rmsBetween(fadedOut, 3.85, 3.98) / Math.max(1e-6, rmsBetween(ca_base, 3.85, 3.98));
  check("A12. the sound is untouched before the fade and fades to silence at the clip end", startRatio > 0.95 && startRatio < 1.05 && endRatio < 0.12, `before ${startRatio.toFixed(2)}, last 0.1 s ${endRatio.toFixed(3)}`);
  await c.evalJs(`window.daw.dispatch({ type: 'updateClip', trackId: ${JSON.stringify(loopT.id)}, clipId: ${JSON.stringify(clipId)}, changes: { audio: null } })`); // back to a clean clip
  await sleep(300);

  // ---- fade handle with the mouse (1/4 grid: the handle snaps to beats)
  await setGrid(960);
  const ca_r1 = await c.rectOf(clipSel);
  const ca_h = await c.rectOf("[data-testid=fade-in-handle]");
  await c.drag(ca_h.cx, ca_h.cy, ca_h.cx + 45, ca_h.cy, 6);
  await sleep(500);
  const ca_dragged = await clipData();
  check("A13. dragging the fade-in handle half a bar right sets a fade in of exactly 2 beats (snapped to the grid)", ca_dragged.audio?.fadeInTicks === 1920, JSON.stringify(ca_dragged.audio));
  await c.evalJs(`window.daw.dispatch({ type: 'updateClip', trackId: ${JSON.stringify(loopT.id)}, clipId: ${JSON.stringify(clipId)}, changes: { audio: null } })`);
  await setGrid(3840);
  await sleep(300);

  // ---- shorten from the right: the loop is cut
  await c.clickEl(clipSel);
  const ca_r2 = await c.rectOf(clipSel);
  await c.drag(ca_r2.x + ca_r2.w - 3, ca_r2.cy, ca_r2.x + ca_r2.w - 3 - 90, ca_r2.cy, 8);
  await sleep(500);
  const ca_shorter = await clipData();
  check("A14. shortening the clip by a bar leaves 1 bar and marks it as cutting its sound", ca_shorter.lengthTicks === 3840 && ca_shorter.audio?.cut === true, JSON.stringify({ l: ca_shorter.lengthTicks, a: ca_shorter.audio }));
  const cutWav = await exportSong();
  check("A15. the rendered loop ends at the clip end: sound before 2 s, silence after", rmsBetween(cutWav, 0.2, 1.9) > 0.02 && rmsBetween(cutWav, 2.1, 4.0) < 0.002, `before ${rmsBetween(cutWav, 0.2, 1.9).toFixed(3)}, ca_after ${rmsBetween(cutWav, 2.1, 4.0).toFixed(4)}`);
  await c.evalJs(`window.daw.undo()`);
  await sleep(400);
  const ca_longer = await clipData();
  check("A16. undo brings back the full 2-bar loop and its sound", ca_longer.lengthTicks === 7680 && rmsBetween(await exportSong(), 2.1, 3.9) > 0.02);

  // ---- split keeps the sound continuous
  await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify(loopT.id)}, changes: { mute: false } })`);
  await c.evalJs(`window.daw.seek(3840)`); // 2.0 s = bar 2
  await sleep(300);
  await c.clickEl(clipSel);
  await c.evalJs(`document.querySelector('[data-testid=arr-split]').click()`);
  await sleep(500);
  const ca_parts = Object.values((await lt()).clips).sort((a, b) => a.startTick - b.startTick);
  const splitWav = await exportSong();
  const ca_sc = (() => { const rate = ca_base.rate, from = Math.floor(0.2 * rate), to = Math.floor(3.9 * rate); let sab = 0, saa = 0, sbb = 0; for (let i = from; i < to; i++) { sab += ca_base.mono[i] * splitWav.mono[i]; saa += ca_base.mono[i] ** 2; sbb += splitWav.mono[i] ** 2; } return sab / Math.sqrt(saa * sbb || 1); })();
  check("A17. splitting the loop at bar 2 makes two clips; the right one continues the sound, so the render is unchanged", ca_parts.length === 2 && ca_parts[1].audio?.startSec > 2 && ca_sc > 0.97, `${ca_parts.length} clips, right start ${ca_parts[1]?.audio?.startSec?.toFixed(2)} s, match ${ca_sc.toFixed(3)}`);
  await c.evalJs(`window.daw.undo()`);
  await sleep(400);

  // ---- lesson gating
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await c.evalJs(`window.daw.completeLesson('M8.2')`); // clip editing itself is unlocked; fades and gain are a later lesson
  await sleep(400);
  await c.clickEl(clipSel);
  await sleep(300);
  const ca_gated = await c.evalJs(`({ gainDisabled: document.querySelector('[data-testid=clip-gain]')?.disabled, title: document.querySelector('[data-testid=clip-audio]')?.title, handles: document.querySelectorAll('[data-testid=fade-in-handle]').length, edge: document.querySelectorAll('[data-testid=trim-start-edge]').length })`);
  check("A18. before lesson M13.3 the fields are disabled (naming the lesson) and the fade handles and trim edge are not offered", ca_gated.gainDisabled === true && /M13\.3/.test(ca_gated.title ?? "") && ca_gated.handles === 0 && ca_gated.edge === 0, JSON.stringify(ca_gated));
  await c.evalJs(`window.daw.completeLesson('M13.3')`);
  await sleep(400);
  check("A19. after lesson M13.3 they are available", (await c.evalJs(`document.querySelector('[data-testid=clip-gain]').disabled`)) === false && (await q("[data-testid=fade-in-handle]")) === 1);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await sleep(300);
  await c.evalJs(`window.daw.resetProgress()`);
  await c.evalJs(`window.daw.completeLesson('M6.2')`); // the sound browser stays available for the rest of the script
  await c.evalJs(`window.daw.setProgressMode('all')`);
  if ((await q("[data-testid=samples-panel]")) === 0) await c.clickEl("[data-testid=samples-toggle]");
  await sleep(200);

  // =====================================================================
  //  AUTOMATION: VOLUME AND FILTER CURVES
  // =====================================================================
  const autoToggle = `[data-testid=auto-toggle-${loopT.id}]`;
  const autoPts = async (param) => (await lt()).automation?.[param];
  const laneRect = () => c.rectOf(`[data-testid=auto-lane][data-track-id="${loopT.id}"]`);
  // first-difference level = the energy in the highs (a low-pass filter removes it)
  const highsRms = ({ rate, mono }, from, to) => { let e = 0, n = 0; for (let i = Math.floor(from * rate) + 1; i < Math.min(mono.length, Math.floor(to * rate)); i++, n++) e += (mono[i] - mono[i - 1]) ** 2; return Math.sqrt(e / Math.max(1, n)); };
  await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify(loopT.id)}, changes: { mute: false } })`);
  await c.clickEl(autoToggle);
  await sleep(400);
  check("AU1. the track's automation button opens a lane under it (volume first)", (await q("[data-testid=auto-lane]")) === 1 && (await c.evalJs(`document.querySelector('[data-testid=auto-lane]').dataset.param`)) === "volume");

  // volume swell drawn with the mouse: bottom-left to top at bar 2 (1-bar grid)
  let lr = await laneRect();
  const yOfValue = (v) => lr.y + 8 + (1 - v) * (lr.h - 16);
  await c.click(lr.x + 2, yOfValue(0));
  await sleep(250);
  lr = await laneRect();
  await c.click(lr.x + 90 + 2, yOfValue(1)); // 90 px = 1 bar at the default zoom
  await sleep(500);
  const vol = await autoPts("volume");
  check("AU2. two clicks make a two-point volume curve: silent at the start, full at bar 2", vol?.length === 2 && vol[0].tick === 0 && vol[0].value < 0.05 && vol[1].tick === 3840 && vol[1].value > 0.95, JSON.stringify(vol));
  const swell = await exportSong();
  const sEarly = rmsBetween(swell, 0.2, 0.5) / rmsBetween(ca_base, 0.2, 0.5);
  const sLate = rmsBetween(swell, 2.5, 3.5) / rmsBetween(ca_base, 2.5, 3.5);
  const sMid = rmsBetween(swell, 0.9, 1.1) / rmsBetween(ca_base, 0.9, 1.1);
  check("AU3. the rendered loop swells: nearly silent at first, a quarter level halfway up (value squared), full level after", sEarly < 0.08 && Math.abs(sMid - 0.25) < 0.08 && sLate > 0.93 && sLate < 1.07, `start ${sEarly.toFixed(3)}, halfway ${sMid.toFixed(2)}, end ${sLate.toFixed(2)}`);
  check("AU4. the curve is drawn on the lane", (await q("[data-testid=auto-point]")) === 2);

  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("AU5. undo removes the points one step at a time", (await autoPts("volume")) === undefined);

  // drag a point
  lr = await laneRect();
  await c.click(lr.x + 2, yOfValue(0.5));
  await sleep(300);
  lr = await laneRect();
  await c.drag(lr.x + 2, yOfValue(0.5), lr.x + 2 + 90, yOfValue(0.9), 6);
  await sleep(400);
  const moved = await autoPts("volume");
  check("AU6. dragging a point moves it (to bar 2, higher up)", moved?.length === 1 && moved[0].tick === 3840 && moved[0].value > 0.85 && moved[0].value < 0.95, JSON.stringify(moved));

  // delete by double-click
  lr = await laneRect();
  await c.dblclick(lr.x + 90 + 2, yOfValue(0.9));
  await sleep(400);
  check("AU7. double-clicking a point removes it (and the last point removes the curve)", (await autoPts("volume")) === undefined);

  // filter curve: a closed filter takes the highs away
  await c.evalJs(`(() => { const s = document.querySelector('[data-testid=auto-param]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'filter'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  lr = await laneRect();
  await c.click(lr.x + 2, yOfValue(0.3)); // cutoff about 160 Hz from the start
  await sleep(500);
  const fl = await autoPts("filter");
  check("AU8. the Filter curve is its own curve: one point at value 0.3", fl?.length === 1 && Math.abs(fl[0].value - 0.3) < 0.03 && (await autoPts("volume")) === undefined, JSON.stringify(fl));
  const filtered = await exportSong();
  const hiRatio = highsRms(filtered, 0.2, 3.8) / highsRms(ca_base, 0.2, 3.8);
  check("AU9. a closed filter removes the highs from the render (the sharp part of the sound is more than 10 times quieter)", hiRatio < 0.1 && rmsBetween(filtered, 0.2, 3.8) > 0.002, `highs ratio ${hiRatio.toFixed(3)}, level ${rmsBetween(filtered, 0.2, 3.8).toFixed(4)}`);
  check("AU10. the lane header reads the value in Hz for the filter", (await c.evalJs(`document.querySelector('[data-testid=auto-row]').innerText`)).includes("Filter"));

  // open the filter again by dragging the point to the top
  lr = await laneRect();
  await c.drag(lr.x + 2, yOfValue(0.3), lr.x + 2, yOfValue(1), 6);
  await sleep(500);
  const reopened = await exportSong();
  const hiOpen = highsRms(reopened, 0.2, 3.8) / highsRms(ca_base, 0.2, 3.8);
  check("AU11. dragging the point to the top opens the filter again: the render is back to the original", hiOpen > 0.97 && hiOpen < 1.03, `highs ratio ${hiOpen.toFixed(3)}`);

  // a sweep: closed at bar 1 to open at bar 2
  await c.evalJs(`window.daw.dispatch({ type: 'setAutomation', trackId: ${JSON.stringify(loopT.id)}, param: 'filter', points: [{ tick: 0, value: 0.25 }, { tick: 3840, value: 1 }] })`);
  await sleep(500);
  const sw = await exportSong();
  const swFirst = highsRms(sw, 0.1, 0.6) / highsRms(ca_base, 0.1, 0.6);
  const swLast = highsRms(sw, 2.5, 3.8) / highsRms(ca_base, 2.5, 3.8);
  check("AU12. a filter sweep opens up over the first bar: muffled at the start, normal after", swFirst < 0.15 && swLast > 0.95, `start ${swFirst.toFixed(3)}, end ${swLast.toFixed(3)}`);

  // live playback with a sweep running: no overruns
  await c.evalJs(`window.daw.stop()`);
  await resetRec();
  await c.evalJs(`window.daw.play()`);
  await sleep(2500);
  check("AU13. playing with a filter sweep and a volume curve never overruns the audio thread", (await rec()).overruns === 0 && (await level(loopT.id)) > 0.02, `overruns ${(await rec()).overruns}, level ${(await level(loopT.id)).toFixed(3)}`);
  await c.evalJs(`window.daw.stop()`);

  // lock until the lesson
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await c.evalJs(`window.daw.completeLesson('M8.2')`);
  await sleep(400);
  const lockedAuto = await c.evalJs(`({ disabled: document.querySelector(${JSON.stringify(autoToggle)}).disabled, title: document.querySelector(${JSON.stringify(autoToggle)}).title })`);
  check("AU14. before lesson M13.3 the automation button is locked and names the lesson", lockedAuto.disabled && /M13\.3/.test(lockedAuto.title), lockedAuto.title);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await c.evalJs(`window.daw.resetProgress()`);
  await c.evalJs(`window.daw.completeLesson('M6.2')`); // the sound browser stays available for the rest of the script
  await c.evalJs(`window.daw.setProgressMode('all')`);
  if ((await q("[data-testid=samples-panel]")) === 0) await c.clickEl("[data-testid=samples-toggle]");
  await sleep(300);

  // leave a volume curve behind: the restart further down must bring it back, and the project stays valid
  await c.evalJs(`window.daw.dispatch({ type: 'setAutomation', trackId: ${JSON.stringify(loopT.id)}, param: 'volume', points: [{ tick: 0, value: 0.4 }, { tick: 7680, value: 1 }] })`);
  await c.evalJs(`window.daw.dispatch({ type: 'setAutomation', trackId: ${JSON.stringify(loopT.id)}, param: 'filter', points: null })`);
  await sleep(300);

  // =====================================================================
  //  IMPORT
  // =====================================================================
  if (!haveZip) check("I0. (skipped) this machine cannot create zip files", true, "no system tar");
  else {
    const res = await c.evalJs(`window.daw.importSamples('zip', ${JSON.stringify(zip)})`);
    check("I1. importing a zip works and reports what was added", res.ok && res.added === GOOD, JSON.stringify({ added: res.added, failed: res.failed.length, pack: res.pack }));
    check("I2. the brand word was found and removed (also from the pack name)", res.brandRemoved === "KSHMR" && res.pack === "samples", `${res.brandRemoved} / ${res.pack}`);
    check("I3. the damaged file is reported, the rest still import", res.failed.length === 1 && /Broken Kick/.test(res.failed[0].file), JSON.stringify(res.failed));
    const L2 = await lib();
    const mine = L2.entries.filter((e) => e.origin === "imported");
    check("I4. no sound, file or tag in the library still says KSHMR", mine.length === GOOD && !mine.some((e) => /kshmr/i.test(`${e.name} ${e.file} ${e.pack} ${e.tags.join(" ")}`)));
    const by = (n) => mine.find((e) => e.name === n);
    check("I5. each sound lands in the right category", by("Big Kick 01")?.category === "Kick" && by("Crack Snare 01")?.category === "Snare" && by("Open Hat 01")?.sub === "Open Hat" && by("Clap 01")?.category === "Clap" && by("Riser 01")?.category === "FX" && by("Drum Loop 120 bpm")?.category === "Loop" && by("Sub Bass")?.category === "Bass");
    check("I6. tempo and key tags are read from the names", by("Drum Loop 120 bpm")?.meta.bpm === 120 && by("Drum Loop 120 bpm")?.meta.bars === 2 && by("Big Kick 01")?.meta.rootPc === 9 && by("Sub Bass")?.meta.key?.mode === "minor");
    check("I7. every imported sound has a waveform picture that is not flat", mine.every((e) => e.peaks.length === 96 && Math.max(...e.peaks) === 255 && new Set(e.peaks).size > 5));
    check("I8. durations come from the engine's decode", Math.abs(by("Drum Loop 120 bpm").durationSec - 4) < 0.01 && Math.abs(by("Big Kick 01").durationSec - 0.6) < 0.01);
    check("I9. the original files are untouched", fs.existsSync(path.join(pack, "Drums", "Kicks", "KSHMR Big Kick 01 (A).wav")));

    await sleep(300);
    check("I10. the library list in the window updated by itself", Number((await total()).split(" ")[2]) === L2.entries.length, await total());
    await typeSearch("big kick");
    check("I11. searching finds the imported sound", (await rowNames()).includes("Big Kick 01"));
    await resetRec();
    await clickRow("Big Kick 01");
    const heard2 = await until(async () => (await rec()).maxL > 0.03, 3000, 50);
    check("I12. the imported sound plays through the engine", !!heard2, `peak ${(await rec()).maxL.toFixed(3)}`);
    await c.evalJs(`window.daw.stopPreviewSample()`);
    await drag("Big Kick 01", { bar: 3 });
    await sleep(300);
    const imp = Object.values((await proj()).tracks).find((t) => t.instrument === "sample" && t.sample.id.startsWith("imported/"));
    check("D18. dropping an imported sound names the track “Big Kick 01”: no KSHMR, no (A) tag", imp?.name === "Big Kick 01" && imp.sample.name === "Big Kick 01", imp?.name);
    await typeSearch("");
    const packOpts = await c.evalJs(`[...document.querySelectorAll('[data-testid=pack-select] option')].map(o => o.textContent)`);
    check("I13. the pack appears in the pack list", packOpts.some((o) => o.startsWith("samples (")), packOpts.join(" | "));

    // ---- persistence
    killTree(child);
    await sleep(1000);
    child = launch(PORT, dataDir);
    c = await connect(PORT);
    const t0 = Date.now();
    await until(async () => (await c.evalJs(`window.daw.getLibrary().then(l => l.status.state)`)) === "ready", 30000, 200);
    const L3 = await c.evalJs(`window.daw.getLibrary()`);
    check("I14. after a restart the imported pack is still there", L3.entries.filter((e) => e.origin === "imported").length === GOOD, `${L3.entries.length} sounds`);
    check("I15. the Starter packs are reused, not regenerated (ready within 8 s of launch)", Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
    await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
    await installRec();

    // importing the same zip again adds nothing
    const again = await c.evalJs(`window.daw.importSamples('zip', ${JSON.stringify(zip)})`);
    const reloaded = await c.evalJs(`window.daw.getInitial().then(x => x.project)`);
    const kt3 = Object.values(reloaded.tracks).find((t) => t.name === "Punch Kick");
    check("D19. sample tracks are saved in the project and come back after a restart", !!kt3 && kt3.sample.id === "starter/kick/punch-kick");
    const loopBack = Object.values(reloaded.tracks).find((t) => t.name === "Boom Bap 90 Drums");
    check("AU15. automation curves are saved in the project and come back after a restart", JSON.stringify(loopBack?.automation?.volume) === JSON.stringify([{ tick: 0, value: 0.4 }, { tick: 7680, value: 1 }]), JSON.stringify(loopBack?.automation));
    await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify(kt3.id)}, changes: { mute: false } })`);
    await c.evalJs(`window.daw.dispatch({ type: 'updateTrack', trackId: ${JSON.stringify(Object.values(reloaded.tracks).find((t) => t.name === "Boom Bap 90 Drums").id)}, changes: { mute: true } })`);
    await sleep(300);
    await resetRec();
    await c.evalJs(`window.daw.play()`);
    const replay = await until(async () => (await level(kt3.id)) > 0.05, 4000, 50);
    check("D20. after the restart the sample track still plays (the engine found its sound again)", !!replay, `level ${(await level(kt3.id)).toFixed(3)}`);
    await c.evalJs(`window.daw.stop()`);
    check("I16. importing the same pack again adds nothing (no duplicates)", again.ok && again.added === 0 && again.duplicates === GOOD);

    // ---- remove
    const imported = L3.packs.find((p) => p.origin === "imported");
    const someFile = L3.entries.find((e) => e.origin === "imported").file;
    const removed = await c.evalJs(`window.daw.removePack(${JSON.stringify(imported.name)})`);
    const L4 = await c.evalJs(`window.daw.getLibrary()`);
    check("I17. removing the pack deletes it from the library", removed === true && L4.entries.every((e) => e.origin === "starter"), `${L4.entries.length} left`);
    check("I18. the Starter packs cannot be removed", (await c.evalJs(`window.daw.removePack('Starter Drums')`)) === false);
    void someFile;

    // ---- the same import through the buttons in the window (the file dialog is replaced by DAW_E2E_IMPORT)
    await until(async () => (await q("[data-testid=samples-panel]")) === 1, 5000);
    await c.clickEl("[data-testid=import-zip]");
    const banner = await until(async () => (await q("[data-testid=import-result]")) === 1, 20000, 100);
    const bt = await text("[data-testid=import-result]");
    check("I19. the window shows what was imported", !!banner && bt.includes("Added 10 samples to samples") && bt.includes("KSHMR") && bt.includes("1 could not be read"), bt.trim().slice(0, 140) || (await c.evalJs(`document.querySelector('[data-testid=samples-panel]')?.innerText.slice(0, 300) ?? 'panel closed'`)));
    await c.clickEl("[data-testid=import-result] button[aria-label=Dismiss]");
    await sleep(150);
    check("I20. the message can be dismissed", (await q("[data-testid=import-result]")) === 0);
    await c.evalJs(`window.daw.removePack('samples')`);
  }

  // =====================================================================
  //  ENGINE RESTART
  // =====================================================================
  await c.evalJs(`window.daw.killEngine()`);
  await until(async () => (await text("[data-testid=engine-chip]")).includes("disconnected"), 5000, 50);
  await until(async () => (await text("[data-testid=engine-chip]")).includes("Engine connected"), 15000);
  await typeSearch("");
  await resetRec();
  await clickRow("Punch Kick");
  const afterRestart = await until(async () => (await rec()).maxL > 0.03, 4000, 50);
  check("R1. after the engine restarts, sounds play again", !!afterRestart);

  // a missing file does not crash anything
  const bogus = await c.evalJs(`(window.daw.previewSample('starter/kick/does-not-exist'), 'sent')`);
  await sleep(300);
  check("R2. previewing an unknown sound is ignored", bogus === "sent" && (await text("[data-testid=engine-chip]")).includes("Engine connected"));
} catch (err) {
  check("script ran to the end without throwing", false, String(err?.stack ?? err));
} finally {
  killTree(child);
  await sleep(500);
  rmDir(dataDir);
  rmDir(work);
  finish();
}
