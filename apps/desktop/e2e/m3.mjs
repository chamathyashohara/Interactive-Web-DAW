// M3 end-to-end acceptance checks: arrangement (clips), song length, playback following clip positions,
// persistence, migration of an M2 project, and offline WAV export (verified by parsing the written file).
// Usage: node apps/desktop/e2e/m3.mjs   (build the app first: npm run build -w apps/desktop)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const BAR = 3840;
const PX_PER_BAR = 90; // arrangement default zoom
const PORT = 9335;
const dataDir = tmpDataDir("daw-m3-");
const extraDirs = [];
let child = launch(PORT, dataDir);
let c = await connect(PORT);

const project = () => c.evalJs(`window.daw.getInitial().then(x => x.project)`);
const clipsOf = async (trackId) => Object.values((await project()).tracks[trackId].clips).sort((a, b) => a.startTick - b.startTick);
const sumDur = (clip) => Object.values(clip.notes).reduce((s, n) => s + n.durationTicks, 0);
const hint = () => c.evalJs(`document.querySelector('[data-testid=arr-hint]')?.textContent ?? ''`);
const batch = (ops) => c.evalJs(`window.daw.dispatchBatch(${JSON.stringify(ops)})`);
const dispatch = (op) => c.evalJs(`window.daw.dispatch(${JSON.stringify(op)})`);
const clipEl = (id) => c.rectOf(`[data-testid=clip][data-clip-id="${id}"]`);
const lane = (trackId) => c.rectOf(`[data-testid=lane][data-track-id="${trackId}"]`);
const noteCount = () => c.evalJs(`document.querySelectorAll('[data-note-id]').length`);
const uid = () => "x" + Math.random().toString(36).slice(2, 10);
const note = (id, pitch, start, dur) => ({ id, pitch, startTick: start, durationTicks: dur, velocity: 100 });
const mkTrack = (id, name, instrument, color, clips) => ({ id, name, instrument, color, volume: 80, pan: 0, mute: false, solo: false, clips });
const mkClip = (id, name, startBars, lenBars, notes = []) => ({ id, name, startTick: startBars * BAR, lengthTicks: lenBars * BAR, notes: Object.fromEntries(notes.map((n) => [n.id, n])) });
const playheadTick = () => c.evalJs(`(() => { const el = document.querySelector('[data-testid=arrangement] .bg-amber-300'); return el ? (parseFloat(el.style.left) - 272) / ${PX_PER_BAR} * ${BAR} : -1; })()`);
const level = async (sel) => Number(await c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.dataset.level ?? 'NaN'`));
const clickText = (text) => c.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(${JSON.stringify(text)}))?.click()`);

/** Minimal RIFF/WAVE parser (PCM): returns format and the raw data chunk. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === "data") { data = buf.subarray(pos + 8, pos + 8 + size); break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data chunk");
  const frames = data.length / (fmt.channels * (fmt.bits / 8));
  const sample = (frame, ch) => { const o = (frame * fmt.channels + ch) * 3; let v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16); if (v & 0x800000) v -= 0x1000000; return v / 8388608; };
  return { ...fmt, frames, sample };
}
const peakIn = (wav, from, to) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(wav.sample(i, 0)), Math.abs(wav.sample(i, 1))); return m; };

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);

  // The arrangement now snaps to the toolbar grid; these checks are about whole bars, so use the "1 bar" grid.
  await c.evalJs(`(() => { const el = document.querySelector('[aria-label="Grid size"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, '3840'); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  // ---------- defaults ----------
  const p0 = await project();
  const c0 = Object.values(p0.tracks["track-1"].clips);
  check("M3-1. a new project is 8 bars with one 4-bar clip per track, shown in the arrangement", p0.songBars === 8 && c0.length === 1 && c0[0].lengthTicks === 4 * BAR && (await c.evalJs(`document.querySelector('[data-testid=song-bars]').textContent`)) === "8 bars" && (await c.evalJs(`document.querySelectorAll('[data-testid=clip]').length`)) === 1);

  // ---------- create a clip by double-clicking an empty spot of a lane ----------
  const l1 = await lane("track-1");
  await c.dblclick(l1.x + 5 * PX_PER_BAR + 30, l1.y + 30);
  const created = await until(async () => (await clipsOf("track-1")).length === 2);
  const cl = await clipsOf("track-1");
  check("M3-2. double-clicking empty lane space adds a clip at that bar, shortened to fit the song", !!created && cl[1].startTick === 5 * BAR && cl[1].lengthTicks === 3 * BAR, JSON.stringify(cl[1] && [cl[1].startTick / BAR, cl[1].lengthTicks / BAR]));
  const lateId = cl[1].id;

  // ---------- overlap refusal ----------
  const r1 = await clipEl(lateId);
  await c.drag(r1.cx, r1.cy, r1.cx - 2.5 * PX_PER_BAR, r1.cy, 8);
  await sleep(300);
  const afterBad = await clipsOf("track-1");
  check("M3-3. dragging a clip onto another clip is refused: position unchanged, reason shown", afterBad[1].startTick === 5 * BAR && (await hint()).toLowerCase().includes("overlap"), await hint());

  // ---------- move (real drag), undo, redo ----------
  const r2 = await clipEl(lateId);
  await c.drag(r2.cx, r2.cy, r2.cx - PX_PER_BAR, r2.cy, 8);
  const moved = await until(async () => (await clipsOf("track-1"))[1].startTick === 4 * BAR);
  check("M3-4a. dragging a clip one bar left moves it exactly one bar (snapped)", !!moved);
  await c.ctrl("z");
  await until(async () => (await clipsOf("track-1"))[1].startTick === 5 * BAR);
  check("M3-4b. Ctrl+Z puts the clip back", (await clipsOf("track-1"))[1].startTick === 5 * BAR);
  await c.ctrl("y");
  await until(async () => (await clipsOf("track-1"))[1].startTick === 4 * BAR);
  check("M3-4c. Ctrl+Y moves it again", (await clipsOf("track-1"))[1].startTick === 4 * BAR);

  // ---------- resize trims notes; undo restores them ----------
  await batch([
    { type: "addNote", trackId: "track-1", clipId: "clip-1", note: note("na", 60, 0, 1000) },
    { type: "addNote", trackId: "track-1", clipId: "clip-1", note: note("nb", 62, 3500, 1000) },
    { type: "addNote", trackId: "track-1", clipId: "clip-1", note: note("nc", 64, 3 * BAR + 480, 1000) },
  ]);
  await sleep(200);
  const r3 = await clipEl("clip-1");
  await c.drag(r3.x + r3.w - 3, r3.cy, r3.x + r3.w - 3 - PX_PER_BAR, r3.cy, 8);
  const shrunk = await until(async () => (await clipsOf("track-1"))[0].lengthTicks === 3 * BAR);
  const afterShrink = (await clipsOf("track-1"))[0];
  check("M3-5a. dragging the right edge shortens the clip and removes notes that no longer fit", !!shrunk && !afterShrink.notes["nc"] && !!afterShrink.notes["na"] && !!afterShrink.notes["nb"]);
  await c.ctrl("z");
  await until(async () => (await clipsOf("track-1"))[0].lengthTicks === 4 * BAR);
  const restored = (await clipsOf("track-1"))[0];
  check("M3-5b. one Ctrl+Z restores both the length and the removed note", restored.lengthTicks === 4 * BAR && !!restored.notes["nc"] && restored.notes["nc"].startTick === 3 * BAR + 480);

  // ---------- split at the playhead (ruler click seeks) ----------
  const ruler = await c.rectOf("[data-testid=arr-ruler]");
  await c.click(ruler.x + PX_PER_BAR + 1, ruler.y + 10); // bar 2 -> tick 3840
  await until(async () => Math.abs((await playheadTick()) - BAR) < 40);
  check("M3-6a. clicking the arrangement ruler moves the playhead to that bar", Math.abs((await playheadTick()) - BAR) < 40, `${(await playheadTick()).toFixed(0)}`);
  const sumBefore = sumDur(restored);
  await c.clickEl('[data-testid=clip][data-clip-id="clip-1"]');
  await c.clickEl("[data-testid=arr-split]");
  const split = await until(async () => (await clipsOf("track-1")).length === 3);
  const s = await clipsOf("track-1");
  check("M3-6b. Split cuts the selected clip at the playhead into two clips that cover the original", !!split && s[0].lengthTicks === BAR && s[1].startTick === BAR && s[1].lengthTicks === 3 * BAR, JSON.stringify(s.map((x) => [x.startTick / BAR, x.lengthTicks / BAR])));
  check("M3-6c. a note crossing the cut continues in the new clip: no note time is lost", sumDur(s[0]) + sumDur(s[1]) === sumBefore, `${sumDur(s[0]) + sumDur(s[1])} vs ${sumBefore}`);
  await c.ctrl("z");
  await until(async () => (await clipsOf("track-1")).length === 2);
  check("M3-6d. one Ctrl+Z undoes the whole split (clip, notes and new clip)", (await clipsOf("track-1")).length === 2 && sumDur((await clipsOf("track-1"))[0]) === sumBefore);

  // ---------- a second track for duplicate / delete / isolation ----------
  await dispatch({ type: "addTrack", track: mkTrack("t2", "Pad", "synth", "#f472b6", {
    A: mkClip("A", "Verse", 0, 1, [note("a1", 60, 0, 480), note("a2", 64, 960, 480)]),
    B: mkClip("B", "Chorus", 2, 2, [note("b1", 67, 0, 480), note("b2", 69, 960, 480), note("b3", 72, 1920, 480)]),
  }) });
  await until(async () => (await c.evalJs(`document.querySelectorAll('[data-testid=lane]').length`)) === 2);
  await c.clickEl('[data-testid=clip][data-clip-id="A"]');
  await sleep(150);
  const nA = await noteCount();
  await c.clickEl('[data-testid=clip][data-clip-id="B"]');
  await sleep(150);
  const nB = await noteCount();
  check("M3-7a. selecting a clip shows only that clip's notes in the piano roll", nA === 2 && nB === 3, `A=${nA} B=${nB}`);
  await c.clickEl("[data-tool=draw]");
  const g = await c.rectOf("[data-testid=grid]");
  await c.evalJs(`(() => { const el = document.querySelector('[data-testid=piano-roll-scroll]'); el.scrollTop = (83 - 66) * 18 + 26 - el.clientHeight / 2; })()`);
  await sleep(150);
  const g2 = await c.rectOf("[data-testid=grid]");
  await c.click(g2.x + 5 * 120 + 4, g2.y + (83 - 66) * 18 + 9);
  await until(async () => Object.keys((await project()).tracks["t2"].clips["B"].notes).length === 4);
  const pr = await project();
  check("M3-7b. drawing in the piano roll changes only the selected clip", Object.keys(pr.tracks["t2"].clips["B"].notes).length === 4 && Object.keys(pr.tracks["t2"].clips["A"].notes).length === 2);

  await c.clickEl('[data-testid=clip][data-clip-id="A"]'); // select + focus the arrangement
  await c.ctrl("d");
  const dup = await until(async () => (await clipsOf("t2")).length === 3);
  const t2c = await clipsOf("t2");
  check("M3-8a. Ctrl+D duplicates the clip right after itself with its notes", !!dup && t2c[1].startTick === BAR && Object.keys(t2c[1].notes).length === 2 && !Object.keys(t2c[1].notes).includes("a1"), JSON.stringify(t2c.map((x) => x.startTick / BAR)));
  await c.key("Delete", "Delete");
  const del = await until(async () => (await clipsOf("t2")).length === 2);
  check("M3-8b. Delete removes the selected clip", !!del);
  await c.ctrl("z");
  await until(async () => (await clipsOf("t2")).length === 3);
  check("M3-8c. Ctrl+Z brings the deleted clip back with its notes", (await clipsOf("t2")).length === 3 && Object.keys((await clipsOf("t2"))[1].notes).length === 2);
  await c.ctrl("z"); // undo the duplicate
  await until(async () => (await clipsOf("t2")).length === 2);

  // ---------- track without clips ----------
  await dispatch({ type: "addTrack", track: mkTrack("t3", "Lead", "synth", "#a3e635", {}) });
  await until(async () => (await c.evalJs(`document.querySelectorAll('[data-testid=lane]').length`)) === 3);
  await c.clickEl('[data-testid=track-row][data-track-id="t3"] [data-testid=track-name]');
  await sleep(200);
  check("M3-9. a track with no clips shows a hint instead of a piano roll", await c.evalJs(`!!document.querySelector('[data-testid=no-clip]')`));

  // ---------- song length ----------
  const p1 = await project();
  const minBars = Math.ceil(Math.max(...Object.values(p1.tracks).flatMap((t) => Object.values(t.clips).map((x) => x.startTick + x.lengthTicks))) / BAR);
  await c.clickEl("[data-testid=song-plus]");
  await until(async () => (await project()).songBars === 9);
  await c.clickEl("[data-testid=song-minus]");
  await until(async () => (await project()).songBars === 8);
  check("M3-10a. + and − change the song length by one bar", (await project()).songBars === 8);
  await dispatch({ type: "setSongLength", bars: minBars });
  await until(async () => (await project()).songBars === minBars);
  const minusDisabled = await c.evalJs(`document.querySelector('[data-testid=song-minus]').disabled`);
  const refused = await c.evalJs(`window.daw.dispatch({ type: "setSongLength", bars: ${minBars - 1} })`);
  check("M3-10b. the song cannot be made shorter than its last clip (button disabled, request refused)", minusDisabled === true && refused.ok === false, `min ${minBars} bars`);
  await c.ctrl("z");
  await until(async () => (await project()).songBars === 8);
  check("M3-10c. Ctrl+Z restores the song length", (await project()).songBars === 8);

  // ---------- playback follows clip positions; loop = song length ----------
  // Only t3 is audible: mute the others. t3 gets one 2-bar clip at bar 5 holding a sustained note. 240 BPM => 1 bar = 1 s.
  await batch([
    { type: "updateTrack", trackId: "track-1", changes: { mute: true } },
    { type: "updateTrack", trackId: "t2", changes: { mute: true } },
    { type: "setTempo", bpm: 240 },
    { type: "addClip", trackId: "t3", clip: mkClip("late3", "Late", 4, 2, [note("L1", 69, 0, 2 * BAR)]) },
  ]);
  await sleep(300);
  c.evalJs(`window.daw.seek(${BAR})`); // start at bar 2
  await sleep(200);
  await c.evalJs(`window.daw.play()`);
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 8500) {
    samples.push({ tick: await playheadTick(), lvl: await level(`[data-testid=meter-list-t3]`) });
    await sleep(35);
  }
  await c.evalJs(`window.daw.stop()`);
  const inClip = samples.filter((x) => x.tick > 4 * BAR + 0.4 * BAR && x.tick < 6 * BAR - 0.3 * BAR);
  const inGap = samples.filter((x) => (x.tick > 1.3 * BAR && x.tick < 4 * BAR - 0.2 * BAR) || (x.tick > 6 * BAR + 0.4 * BAR && x.tick < 8 * BAR - 0.1 * BAR));
  const loud = inClip.length ? Math.max(...inClip.map((x) => x.lvl)) : 0;
  const quietest = inGap.length ? Math.max(...inGap.map((x) => x.lvl)) : 1;
  check("M3-11a. the clip plays only where it sits on the timeline: audible inside bars 5-6, silent in the gaps around it", inClip.length > 5 && inGap.length > 10 && loud > 0.005 && quietest < 0.0005, `inside ${loud.toFixed(3)} (${inClip.length} reads), gaps ${quietest.toFixed(4)} (${inGap.length} reads)`);
  const maxTick = Math.max(...samples.map((x) => x.tick));
  let wrapped = false;
  for (let i = 1; i < samples.length; i++) if (samples[i].tick < samples[i - 1].tick - 3 * BAR) wrapped = true;
  check("M3-11b. playback loops at the song end (8 bars) and never runs past it", maxTick < 8 * BAR + 40 && wrapped, `max tick ${(maxTick / BAR).toFixed(2)} bars, wrapped ${wrapped}`);

  // ---------- persistence ----------
  const snapshot = await project();
  c.ws.close();
  killTree(child);
  await sleep(1500);
  child = launch(PORT, dataDir);
  c = await connect(PORT);
  await until(async () => (await c.evalJs(`document.querySelectorAll('[data-testid=lane]').length`)) === 3, 15000);
  const after = await project();
  const strip = (p) => JSON.stringify({ t: p.tempo, b: p.songBars, o: p.trackOrder, tr: p.tracks });
  check("M3-12. force-killed app: every clip (position, length, name, notes), the song length and tempo are restored", strip(after) === strip(snapshot));

  // ---------- export ----------
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  check("M3-13a. the Export WAV button is present", await c.evalJs(`!!document.querySelector('[data-testid=export-wav]') && !document.querySelector('[data-testid=export-wav]').disabled`));
  const wavPath = path.join(os.tmpdir(), `daw-m3-${Date.now()}.wav`);
  await c.evalJs(`window.daw.play()`); // export must not disturb live playback
  await sleep(500);
  const cbBefore = Number((await c.evalJs(`document.querySelector('[data-testid=diag]').textContent`)).match(/callbacks (\d+)/)[1]);
  const started = await c.evalJs(`window.daw.exportWav(${JSON.stringify(wavPath)})`);
  const done = await until(async () => (await c.evalJs(`document.querySelector('[data-testid=export-chip]')?.dataset.state`)) === "done", 60000, 150);
  const diag = await c.evalJs(`document.querySelector('[data-testid=diag]').textContent`);
  const cbAfter = Number(diag.match(/callbacks (\d+)/)[1]);
  const overruns = Number(diag.match(/overruns (\d+)/)[1]);
  await c.evalJs(`window.daw.stop()`);
  check("M3-13b. export finishes and reports Saved", started.ok === true && !!done && fs.existsSync(wavPath));
  check("M3-13c. exporting while playing causes no audio overruns", cbAfter > cbBefore && overruns === 0, `callbacks ${cbBefore}->${cbAfter}, overruns ${overruns}`);

  const wav = readWav(wavPath);
  const expectedFrames = 8 * 4 * 0.25 * 48000 + 2 * 48000; // 8 bars at 240 BPM = 8 s, plus the 2 s tail
  check("M3-14a. the WAV is 48 kHz, stereo, 24-bit PCM", wav.format === 1 && wav.rate === 48000 && wav.channels === 2 && wav.bits === 24, JSON.stringify({ f: wav.format, r: wav.rate, ch: wav.channels, b: wav.bits }));
  check("M3-14b. the WAV length is exactly the song length plus the 2 s tail", wav.frames === expectedFrames, `${wav.frames} frames, expected ${expectedFrames}`);
  const gapBefore = peakIn(wav, 0, 4 * 48000);
  const inside = peakIn(wav, Math.round(4.1 * 48000), Math.round(5.9 * 48000));
  const gapAfter = peakIn(wav, Math.round(6.3 * 48000), wav.frames);
  check("M3-14c. the audio sits where the clip sits: exact silence before bar 5 and after the release, sound inside", gapBefore === 0 && gapAfter === 0 && inside > 0.01, `before ${gapBefore}, inside ${inside.toFixed(3)}, after ${gapAfter}`);
  fs.rmSync(wavPath, { force: true });

  // ---------- a long, heavy export beside live playback ----------
  // 128 bars at 240 BPM = 128 s of audio from 8 dense synth tracks (16k notes): the export takes a few seconds,
  // long enough to show whether live playback suffers while it runs.
  await c.evalJs(`window.daw.dispatch({ type: "setSongLength", bars: 128 })`);
  for (let k = 0; k < 8; k++) {
    const clips = {};
    for (let q = 0; q < 32; q++) {
      const notes = Array.from({ length: 64 }, (_, i) => note(`h${k}_${q}_${i}`, 40 + ((i * 5 + k * 3) % 36), i * 240, Math.min(960, 4 * BAR - i * 240)));
      clips[`hc${k}_${q}`] = mkClip(`hc${k}_${q}`, `H${q}`, q * 4, 4, notes);
    }
    const added = await dispatch({ type: "addTrack", track: mkTrack(`heavy${k}`, `Heavy ${k}`, "synth", "#22d3ee", clips) });
    if (!added.ok) throw new Error("heavy track rejected: " + added.reason);
  }
  await sleep(800);
  const longPath = path.join(os.tmpdir(), `daw-m3-long-${Date.now()}.wav`);
  await c.evalJs(`window.daw.play()`);
  await sleep(1200);
  const readDiag = async () => { const d = await c.evalJs(`document.querySelector('[data-testid=diag]').textContent`); return { cb: Number(d.match(/callbacks (\d+)/)[1]), over: Number(d.match(/overruns (\d+)/)[1]), t: Date.now() }; };
  const b0 = await readDiag();
  await sleep(1500);
  const b1 = await readDiag();
  const baseRate = (b1.cb - b0.cb) / ((b1.t - b0.t) / 1000);
  const d0 = await readDiag();
  await c.evalJs(`window.daw.exportWav(${JSON.stringify(longPath)})`);
  let sawRunning = false;
  while (Date.now() - d0.t < 120000) {
    const st = await c.evalJs(`document.querySelector('[data-testid=export-chip]')?.dataset.state`);
    if (st === "running") sawRunning = true;
    if (st === "done" || st === "error") break;
    await sleep(40);
  }
  const d1 = await readDiag();
  const elapsed = (d1.t - d0.t) / 1000;
  await c.evalJs(`window.daw.stop()`);
  const longWav = fs.existsSync(longPath) ? readWav(longPath) : null;
  const rate = (d1.cb - d0.cb) / elapsed;
  check("M3-16a. a 128-bar, 16k-note export is written correctly (exact length) and runs faster than real time", !!longWav && longWav.frames === 128 * 48000 + 96000 && elapsed < 128, `${elapsed.toFixed(1)} s for ${longWav ? (longWav.frames / 48000).toFixed(0) : "?"} s of audio`);
  check("M3-16b. progress was reported while exporting", sawRunning);
  check("M3-16c. live playback kept its rhythm during the export: callback rate within 5% of the rate before it, no new overruns", elapsed > 0.8 && d1.over === d0.over && rate > 0.95 * baseRate, `${rate.toFixed(1)} vs ${baseRate.toFixed(1)} callbacks/s over ${elapsed.toFixed(1)} s, overruns ${d0.over}->${d1.over}`);
  fs.rmSync(longPath, { force: true });

  // ---------- migrating an M2 project ----------
  c.ws.close();
  killTree(child);
  await sleep(1200);
  const m2Dir = tmpDataDir("daw-m3-m2-");
  extraDirs.push(m2Dir);
  const m2Project = {
    id: "default", name: "Old", tempo: 240, ppq: 960, masterVolume: 80, trackOrder: ["track-1"], recentOps: [],
    tracks: { "track-1": { id: "track-1", name: "Synth", instrument: "synth", color: "#22d3ee", volume: 80, pan: 0, mute: false, solo: false,
      clips: { "clip-1": { id: "clip-1", startTick: 0, lengthTicks: 4 * BAR, notes: { n1: note("n1", 60, 0, 2 * BAR), n2: note("n2", 64, 2 * BAR, BAR) } } } } },
  };
  fs.writeFileSync(path.join(m2Dir, "snapshot.json"), JSON.stringify({ seq: 0, project: m2Project }));
  child = launch(PORT, m2Dir);
  c = await connect(PORT);
  await until(async () => (await c.evalJs(`document.querySelectorAll('[data-testid=clip]').length`)) === 1, 15000);
  const mig = await project();
  check("M3-15a. an M2 project opens: its 4-bar loop becomes a 4-bar song, notes and tempo intact", mig.songBars === 4 && mig.tempo === 240 && Object.keys(mig.tracks["track-1"].clips["clip-1"].notes).length === 2);
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`window.daw.play()`);
  let migLevel = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 1500) { migLevel = Math.max(migLevel, await level(`[data-testid=meter-list-track-1]`)); await sleep(40); }
  check("M3-15b. and it plays", migLevel > 0.005, migLevel.toFixed(3));
} catch (e) {
  check("m3 run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
  extraDirs.forEach(rmDir);
}
finish();
