// Gliding between notes with the hand, end to end on real audio: a hand rising while pinched is recorded as a note with a pitch curve,
// the piano roll draws it, and the exported audio really glides along the recorded curve. Also: no glide when it is off, scale help
// shaping the glide, plugin tracks (no glide), and the study data. The camera is replaced by a test feed (gesture.mjs explains why).
// Needs an engine built with pitch bend: DAW_ENGINE_PATH, or the default build (engine/build) once rebuilt.
// Usage: DAW_ENGINE_PATH=<daw_engine.exe> node apps/desktop/e2e/gesture-bend.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = process.env.DAW_ENGINE_PATH ?? path.resolve(here, "../../../engine/build-gesture/daw_engine_artefacts/Release/daw_engine.exe");
const RATE = 48000;
const dataDir = tmpDataDir("daw-gesture-bend-");
const child = launch(9400, dataDir, { DAW_ENGINE_PATH: fs.existsSync(enginePath) ? enginePath : null });
const c = await connect(9400);
const ev = c.evalJs;

const project = () => ev(`window.daw.getInitial().then((x) => x.project)`);
const notes = async () => Object.values((await project()).tracks["track-1"].clips["clip-1"].notes).sort((a, b) => a.startTick - b.startTick);
const attr = (sel, a) => ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)})`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const has = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const chooseLevel = (v) => ev(`(() => { const s = document.querySelector('[data-testid="gesture-level"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(v)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const clearNotes = () => ev(`(async () => { const p = await window.daw.getInitial().then((x) => x.project); const ids = Object.keys(p.tracks["track-1"].clips["clip-1"].notes); if (ids.length) await window.daw.dispatchBatch(ids.map((id) => ({ type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: id }))); })()`);

const readWav = (file) => {
  const b = fs.readFileSync(file);
  let p = 12, ch = 2, bits = 24, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString("latin1", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") (ch = b.readUInt16LE(p + 10), bits = b.readUInt16LE(p + 22));
    if (id === "data") data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  const bytes = bits / 8, n = Math.floor(data.length / (bytes * ch));
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = data.readIntLE(i * ch * bytes, bytes) / 2 ** (bits - 1);
  return mono;
};
/** Autocorrelation pitch near `fGuess` (searching a quarter either way), refined between samples. */
const pitchNear = (x, t, fGuess, win = 0.05) => {
  const s = Math.floor(t * RATE), n = Math.floor(win * RATE);
  const lo = Math.floor(RATE / (fGuess * 1.3)), hi = Math.ceil(RATE / (fGuess * 0.77));
  const r = (lag) => { let sum = 0; for (let i = 0; i < n; i++) sum += x[s + i] * x[s + i + lag]; return sum; };
  let best = lo, bv = -Infinity;
  for (let lag = lo; lag <= hi; lag++) { const v = r(lag); if (v > bv) { bv = v; best = lag; } }
  const y0 = r(best - 1), y1 = r(best), y2 = r(best + 1);
  const off = (y0 - y2) / (2 * (y0 - 2 * y1 + y2));
  return RATE / (best + (Number.isFinite(off) ? off : 0));
};
const bendAt = (curve, tick) => {
  if (tick <= curve[0].tick) return curve[0].semis;
  const last = curve[curve.length - 1];
  if (tick >= last.tick) return last.semis;
  let i = 1;
  while (curve[i].tick < tick) i++;
  const a = curve[i - 1], b = curve[i];
  return a.semis + ((b.semis - a.semis) * (tick - a.tick)) / (b.tick - a.tick);
};
let exN = 0;
const exportWav = async () => {
  await ev(`window.__ex = []; window.daw.onExportStatus((x) => window.__ex.push(x));`);
  const file = path.join(dataDir, `bend${++exN}.wav`);
  await ev(`window.daw.exportWav(${JSON.stringify(file)}, { tailSeconds: 0 })`);
  const done = await until(() => ev(`(window.__ex || []).find((x) => x.state === 'done' || x.state === 'error') || null`), 60000, 150);
  if (done?.state !== "done") throw new Error("export failed " + JSON.stringify(done));
  return readWav(file);
};

try {
  await until(async () => (await text('[data-testid=engine-chip]')).includes("Engine connected"), 20000);
  check("the engine under test is the build with pitch bend", fs.existsSync(enginePath), enginePath);
  await ev(`window.daw.setProgressMode('all')`);
  await ev(`window.daw.keepRunning(true)`); // timers keep their pace even if another window covers this one
  await ev(`window.daw.dispatch({ type: "setKey", key: { tonic: 0, mode: "major" } })`);
  await ev(`(() => {
    window.__yFor = (pitch) => 0.88 - ((pitch - 60) / 24) * 0.76;
    window.__hand = (pitch, pinched, t) => {
      const y = window.__yFor(pitch);
      const l = Array.from({ length: 21 }, () => ({ x: 0.5, y }));
      l[0] = { x: 0.5, y: y + 0.1 };
      for (const i of [5, 9, 13, 17]) l[i] = { x: 0.4 + i * 0.01, y: y - 0.025 };
      l[4] = { x: 0.3, y: y - 0.1 };
      l[8] = { x: pinched ? 0.31 : 0.4, y: y - 0.1 };
      return { t, landmarks: l };
    };
    window.__t = 1000;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    // a hand that settles at 'from', pinches, moves to 'to' over 'seconds' while pinched, holds there a moment, and lets go - at the camera's pace
    window.__glide = async (from, to, seconds, hold = 6) => {
      const f = window.__gestureTest.feed;
      const frame = (p, pinched) => f(window.__hand(p, pinched, (window.__t += 33)));
      for (let i = 0; i < 14; i++) { frame(from, false); await nap(33); }
      for (let i = 0; i < 4; i++) { frame(from, true); await nap(33); }
      const n = Math.max(1, Math.round((seconds * 1000) / 33));
      for (let i = 1; i <= n; i++) { frame(from + ((to - from) * i) / n, true); await nap(33); }
      for (let i = 0; i < hold; i++) { frame(to, true); await nap(33); }
      for (let i = 0; i < 5; i++) { frame(to, false); await nap(33); }
    };
  })()`);
  await ev(`window.__gestureUseTestSource = true`);
  await ev(`window.daw.telemetry.consent("P-BEND-01")`);

  await c.clickEl('[data-testid="pr-hand"]');
  await c.clickEl('[data-testid="gesture-start"]');
  await until(async () => (await attr('[data-testid="gesture-status"]', "data-phase")) === "running", 8000);
  check("the panel offers Glide, off to begin with", (await text('[data-testid="gesture-glide"]')) === "Glide: off" && (await attr('[data-testid="gesture-status"]', "data-glide")) === "off");

  // ---------- glide on, no help: a rising hand becomes a note with a rising curve ----------
  await chooseLevel("free");
  await c.clickEl('[data-testid="gesture-glide"]');
  check("Glide turns on", (await text('[data-testid="gesture-glide"]')) === "Glide: on" && (await attr('[data-testid="gesture-status"]', "data-glide")) === "on");
  await c.clickEl('[data-testid="gesture-record"]');
  await ev(`window.daw.play()`);
  await sleep(500);
  await ev(`window.__glide(60, 67, 1.0)`);
  await ev(`window.daw.stop()`);
  await sleep(400);
  let n = await notes();
  const glided = n[0];
  check("a hand rising from C4 to G4 while pinched records one note on C4 with a pitch curve", n.length === 1 && glided.pitch === 60 && Array.isArray(glided.bend) && glided.bend.length >= 2, JSON.stringify(glided));
  const curve = glided?.bend ?? [];
  check("the curve starts at the note's own pitch and ends about 7 semitones higher", curve.length > 0 && Math.abs(curve[0].semis) < 0.6 && Math.abs(curve[curve.length - 1].semis - 7) < 0.8, `${curve[0]?.semis} .. ${curve[curve.length - 1]?.semis}`);
  check("the curve is in time order, rises, and uses few points", curve.every((p, i) => i === 0 || (p.tick > curve[i - 1].tick && p.semis >= curve[i - 1].semis - 0.1)) && curve.length <= 48, `${curve.length} points over ${curve[curve.length - 1]?.tick} ticks`);
  check("the piano roll draws the glide on the note", await has(`[data-testid="bend-curve"][data-bend-note="${glided.id}"]`));

  // ---------- the exported audio follows the recorded curve ----------
  const wav = await exportWav();
  const startSec = glided.startTick / 1920; // 120 bpm, 960 ppq
  const t1 = 0.06;
  const lastTick = curve[curve.length - 1].tick;
  const t2 = Math.max(t1 + 0.3, (lastTick - 180) / 1920);
  const s1 = bendAt(curve, t1 * 1920), s2 = bendAt(curve, t2 * 1920);
  const f0 = 261.63;
  const fa = pitchNear(wav, startSec + t1, f0 * 2 ** (s1 / 12));
  const fb = pitchNear(wav, startSec + t2, f0 * 2 ** (s2 / 12));
  const measuredSemis = 12 * Math.log2(fb / fa), expectedSemis = s2 - s1;
  check("the exported note really glides: the pitch rise measured in the audio matches the recorded curve", Math.abs(measuredSemis - expectedSemis) < 0.45 && expectedSemis > 3, `measured ${measuredSemis.toFixed(2)} semitones (${fa.toFixed(1)} -> ${fb.toFixed(1)} Hz), the curve says ${expectedSemis.toFixed(2)}`);
  const fStart = pitchNear(wav, startSec + 0.02, f0, 0.04);
  check("and it starts on the note's own pitch (C4, 262 Hz)", Math.abs(12 * Math.log2(fStart / f0)) < 0.5, `${fStart.toFixed(1)} Hz`);

  // ---------- glide off: the same hand movement leaves a plain note ----------
  await clearNotes();
  await c.clickEl('[data-testid="gesture-glide"]');
  await ev(`window.daw.play()`);
  await sleep(500);
  await ev(`window.__glide(60, 67, 1.0)`);
  await ev(`window.daw.stop()`);
  await sleep(400);
  n = await notes();
  check("with Glide off the note has no curve, however the hand moved", n.length === 1 && n[0].bend === undefined && n[0].pitch === 60, JSON.stringify(n[0]));
  const wavPlain = await exportWav();
  const st = n[0].startTick / 1920;
  const pa = pitchNear(wavPlain, st + 0.1, f0), pb = pitchNear(wavPlain, st + 0.6, f0);
  check("a plain note keeps its pitch in the audio", Math.abs(12 * Math.log2(pb / pa)) < 0.3, `${pa.toFixed(1)} -> ${pb.toFixed(1)} Hz`);

  // ---------- scale help shapes the glide ----------
  await clearNotes();
  await c.clickEl('[data-testid="gesture-glide"]');
  await chooseLevel("full");
  await ev(`window.daw.play()`);
  await sleep(500);
  await ev(`window.__glide(60, 64, 0.8)`); // C up to E in C major: both are scale notes
  await ev(`window.daw.stop()`);
  await sleep(400);
  n = await notes();
  const full = n[0]?.bend ?? [];
  check("with full help the glide from C to E ends exactly on E (4 semitones), resting on the scale note", full.length >= 2 && Math.abs(full[full.length - 1].semis - 4) < 0.15 && Math.abs(full[0].semis) < 0.15, JSON.stringify(full));

  // ---------- the study data ----------
  const file = path.join(dataDir, "study.json");
  await ev(`window.daw.telemetry.export("json", ${JSON.stringify(file)})`);
  const g = JSON.parse(fs.readFileSync(file, "utf8")).events.filter((e) => e.t === "ui.gesture.note");
  check("each note event says whether it glided and how far", g.length === 3 && g[0].glide === true && g[0].bendMax > 5 && g[1].glide === false && g[1].bendMax === 0 && g[2].glide === true, JSON.stringify(g.map((e) => [e.glide, e.bendMax])));

  // ---------- a plugin track cannot glide ----------
  await c.clickEl('[data-testid="gesture-close"]');
  await ev(`(async () => { await window.daw.dispatchBatch([{ type: "addTrack", track: { id: "tp", name: "Plug", instrument: "plugin", color: "#a78bfa", volume: 80, pan: 0, mute: false, solo: false, clips: { cp: { id: "cp", name: "Clip 1", startTick: 0, lengthTicks: 15360, notes: {} } } } }]); })()`);
  await sleep(300);
  await c.clickEl('[data-track-id="tp"]');
  await sleep(300);
  await c.clickEl('[data-testid="pr-hand"]');
  check("on a plugin track the Glide button is disabled and says why", (await ev(`document.querySelector('[data-testid="gesture-glide"]')?.disabled === true`)) && /built-in synth/.test(await ev(`document.querySelector('[data-testid="gesture-glide"]')?.title ?? ''`)));
} catch (e) {
  check("the glide scenarios ran without an unexpected error", false, String(e?.stack ?? e));
} finally {
  killTree(child);
  rmDir(dataDir);
}
finish();
