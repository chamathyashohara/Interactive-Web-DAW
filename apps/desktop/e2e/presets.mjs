// Synth presets: each preset is a different KIND of sound, measured on the rendered audio.
//   Piano  = struck: decays while the key is held, starts loud, brighter when played harder.
//   Violin = bowed: swells in, and its pitch wavers (vibrato) after a delay.
//   Bass   = heavy: far more low-frequency energy than the classic synth, for the same note.
// Usage: node apps/desktop/e2e/presets.mjs   (build the app first: npm run build -w apps/desktop)
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9350;
const dataDir = tmpDataDir("daw-presets-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);
const RATE = 48000;

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
const peak = (x, from, to) => { let p = 0; for (let i = Math.floor(from * RATE); i < Math.min(x.length, Math.floor(to * RATE)); i++) p = Math.max(p, Math.abs(x[i])); return p; };
const rms = (x, from, to) => { let e = 0, n = 0; for (let i = Math.floor(from * RATE); i < Math.min(x.length, Math.floor(to * RATE)); i++, n++) e += x[i] * x[i]; return Math.sqrt(e / Math.max(1, n)); };
/** RMS of the part of the signal below `hz` (a one-pole low-pass, applied twice for a steeper slope). */
const lowRms = (x, from, to, hz) => {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / RATE);
  let y1 = 0, y2 = 0, e = 0, n = 0;
  for (let i = 0; i < Math.min(x.length, Math.floor(to * RATE)); i++) {
    y1 += a * (x[i] - y1);
    y2 += a * (y1 - y2);
    if (i >= Math.floor(from * RATE)) { e += y2 * y2; n++; }
  }
  return Math.sqrt(e / Math.max(1, n));
};
/** Autocorrelation pitch (Hz) of a short window, refined to a fraction of a sample. */
const pitchAt = (x, t, win = 0.06, f0 = 262) => {
  const s = Math.floor(t * RATE), n = Math.floor(win * RATE);
  const lo = Math.floor(RATE / (f0 * 1.06)), hi = Math.ceil(RATE / (f0 * 0.94));
  const r = (lag) => { let sum = 0; for (let i = 0; i < n; i++) sum += x[s + i] * x[s + i + lag]; return sum; };
  let best = lo, bv = -Infinity;
  for (let lag = lo; lag <= hi; lag++) { const v = r(lag); if (v > bv) { bv = v; best = lag; } }
  const y0 = r(best - 1), y1 = r(best), y2 = r(best + 1);
  const off = (y0 - y2) / (2 * (y0 - 2 * y1 + y2));
  return RATE / (best + (Number.isFinite(off) ? off : 0));
};
let exN = 0;
const render = async () => {
  await c.evalJs(`window.__ex = []; window.daw.onExportStatus((x) => window.__ex.push(x));`);
  const file = path.join(dataDir, `p${++exN}.wav`);
  await c.evalJs(`window.daw.exportWav(${JSON.stringify(file)}, { tailSeconds: 0 })`);
  const done = await until(async () => await c.evalJs(`(window.__ex || []).find((x) => x.state === 'done' || x.state === 'error') || null`), 30000, 100);
  if (done?.state !== "done") throw new Error("export failed " + JSON.stringify(done));
  return readWav(file);
};
const setPreset = (preset) => c.evalJs(`window.daw.dispatch({ type: "setSynthPreset", trackId: "track-1", preset: ${JSON.stringify(preset)} })`);
const presetOf = async () => (await c.evalJs(`window.daw.getInitial().then((x) => x.project)`)).tracks["track-1"].synthPreset;
const setNote = async (pitch, velocity, ticks = 7680) => {
  await c.evalJs(`(async () => { const p = await window.daw.getInitial().then(x => x.project); const ids = Object.keys(p.tracks["track-1"].clips["clip-1"].notes); if (ids.length) await window.daw.dispatchBatch(ids.map((id) => ({ type: "deleteNote", trackId: "track-1", clipId: "clip-1", noteId: id }))); await window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n", pitch: ${pitch}, startTick: 0, durationTicks: ${ticks}, velocity: ${velocity} } }); })()`);
  await sleep(300);
};

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await c.evalJs(`window.daw.dispatch({ type: "setSongLength", bars: 4 })`);

  // a held middle C (262 Hz), 4 seconds at 120 BPM
  await setNote(60, 100);
  const classic = await render();
  check("P1. the picker defaults to Classic and the track keeps the original synth sound", (await c.evalJs(`!!document.querySelector('[data-testid=synth-preset-track-1]')`)) && ((await presetOf()) ?? "classic") === "classic");
  const classicHold = rms(classic, 2.5, 3.5) / rms(classic, 0.2, 0.7);
  check("P2. Classic sustains while held (late level about equal to early)", classicHold > 0.8 && classicHold < 1.25, `late/early ${classicHold.toFixed(2)}`);

  // ----- piano: struck, decays while held -----
  await setPreset("keys");
  await sleep(300);
  const piano = await render();
  const pianoHold = rms(piano, 2.5, 3.5) / rms(piano, 0.05, 0.3);
  check("P3. Piano is struck: it starts at full level at once, and has already decayed a lot after 2.5 s while the key is still held", peak(piano, 0, 0.02) > 0.5 * peak(piano, 0.02, 0.2) && pianoHold < 0.5, `late/early ${pianoHold.toFixed(2)}`);
  check("P4. Piano and Classic are clearly different sounds (different decay shape)", pianoHold < 0.6 * classicHold, `piano ${pianoHold.toFixed(2)} vs classic ${classicHold.toFixed(2)}`);
  // brightness follows how hard it is played
  await setNote(60, 30);
  const soft = await render();
  await setNote(60, 120);
  const hard = await render();
  const ratio = (x) => { const hi = rms(x, 0.05, 0.5) - lowRms(x, 0.05, 0.5, 1500); return Math.abs(hi) / rms(x, 0.05, 0.5); };
  const harshness = (x) => { let e = 0, n = 0; for (let i = Math.floor(0.05 * RATE) + 1; i < Math.floor(0.5 * RATE); i++, n++) e += (x[i] - x[i - 1]) ** 2; return Math.sqrt(e / n) / rms(x, 0.05, 0.5); };
  check("P5. Piano is brighter when played harder (more high-frequency content relative to its level)", harshness(hard) > harshness(soft) * 1.15, `hard ${harshness(hard).toFixed(3)} vs soft ${harshness(soft).toFixed(3)}`);
  void ratio;

  // ----- violin: swells in, wavers -----
  await setNote(60, 100);
  await setPreset("strings");
  await sleep(300);
  const violin = await render();
  check("P6. Violin is bowed: it swells in (first 20 ms far quieter than 0.5 s in) and then holds", peak(violin, 0, 0.02) < 0.35 * peak(violin, 0.4, 0.7) && rms(violin, 2.5, 3.5) > 0.7 * rms(violin, 0.5, 1.2), `early ${peak(violin, 0, 0.02).toFixed(3)} mid ${peak(violin, 0.4, 0.7).toFixed(3)}`);
  const pitches = [];
  for (let t = 1.0; t < 3.4; t += 0.04) pitches.push(pitchAt(violin, t));
  const cents = pitches.map((f) => 1200 * Math.log2(f / 261.63));
  const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
  const spread = Math.sqrt(cents.reduce((a, b) => a + (b - mean) ** 2, 0) / cents.length);
  const classicPitches = [];
  await setPreset("classic");
  await sleep(300);
  const flat = await render();
  for (let t = 1.0; t < 3.4; t += 0.04) classicPitches.push(1200 * Math.log2(pitchAt(flat, t) / 261.63));
  const cm = classicPitches.reduce((a, b) => a + b, 0) / classicPitches.length;
  const cspread = Math.sqrt(classicPitches.reduce((a, b) => a + (b - cm) ** 2, 0) / classicPitches.length);
  check("P7. Violin has vibrato: its pitch wavers by several cents, while Classic stays steady", spread > 4 && spread > 3 * cspread, `violin ±${spread.toFixed(1)} cents vs classic ±${cspread.toFixed(1)}`);

  // ----- bass: much more low end -----
  await setNote(40, 100); // E2, 82 Hz
  const classicLow = await render();
  await setPreset("bass");
  await sleep(300);
  const bass = await render();
  const lowC = lowRms(classicLow, 0.3, 3.0, 140), lowB = lowRms(bass, 0.3, 3.0, 140);
  check("P8. Bass has far more low-frequency energy than the classic synth for the same note", lowB > 2.0 * lowC, `bass ${lowB.toFixed(4)} vs classic ${lowC.toFixed(4)} (below 140 Hz)`);
  const shareB = lowB / rms(bass, 0.3, 3.0), shareC = lowC / rms(classicLow, 0.3, 3.0);
  check("P9. and a larger share of the bass sound is low end (heavy, not just louder)", shareB > shareC + 0.08, `share ${shareB.toFixed(2)} vs ${shareC.toFixed(2)}`);
  check("P10. the Bass stays at a safe level (no clipping)", peak(bass, 0, 4) < 0.95);

  // ----- the picker and undo -----
  await setPreset("keys");
  await sleep(300);
  check("P11. choosing a preset is recorded on the track and undoable", (await presetOf()) === "keys" && (await c.evalJs(`window.daw.undo().then(() => true)`)) && (await sleep(300), (await presetOf()) === "bass"));
} catch (e) {
  check("presets run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
