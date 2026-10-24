// Synth presets: changing a synth track's preset changes the sound (a pad swells in slowly; keys start at once).
// Usage: node apps/desktop/e2e/presets.mjs   (build the app first: npm run build -w apps/desktop)
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9350;
const dataDir = tmpDataDir("daw-presets-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);

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
  return { rate: 48000, mono };
};
const peak = ({ rate, mono }, from, to) => {
  let p = 0;
  for (let i = Math.floor(from * rate); i < Math.min(mono.length, Math.floor(to * rate)); i++) p = Math.max(p, Math.abs(mono[i]));
  return p;
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

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  // one held synth note: 1 bar at 120 BPM = 2 s
  await c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n1", pitch: 60, startTick: 0, durationTicks: 3840, velocity: 110 } })`);
  await sleep(300);

  // default = keys: starts almost at once
  const keys = await render();
  const keysEarly = peak(keys, 0, 0.03), keysMid = peak(keys, 0.4, 0.6);
  check("P1. the default 'keys' synth starts almost immediately (early level close to its mid level)", keysEarly > 0.3 * keysMid && keysMid > 0.02, `early ${keysEarly.toFixed(3)}, mid ${keysMid.toFixed(3)}`);

  // the picker shows on a synth track
  check("P2. a synth track has a preset picker, defaulting to keys", (await c.evalJs(`!!document.querySelector('[data-testid=synth-preset-track-1]')`)) && (await presetOf() ?? "keys") === "keys");

  // switch to pad: swells in slowly (early level much lower than mid)
  await setPreset("pad");
  await sleep(400);
  check("P3. choosing Pad records the preset on the track", (await presetOf()) === "pad");
  const pad = await render();
  const padEarly = peak(pad, 0, 0.03), padMid = peak(pad, 0.4, 0.6);
  check("P4. the Pad swells in: its first 30 ms are much quieter than halfway through the note", padEarly < 0.25 * padMid && padMid > 0.02, `early ${padEarly.toFixed(3)}, mid ${padMid.toFixed(3)}`);
  check("P5. Pad and Keys are audibly different (Pad starts far softer than Keys for the same note)", padEarly < 0.5 * keysEarly, `padEarly ${padEarly.toFixed(3)} vs keysEarly ${keysEarly.toFixed(3)}`);

  // bass is darker than lead (less high-frequency content): compare high-frequency energy
  const highs = ({ rate, mono }, from, to) => { let e = 0, n = 0; for (let i = Math.floor(from * rate) + 1; i < Math.min(mono.length, Math.floor(to * rate)); i++, n++) e += (mono[i] - mono[i - 1]) ** 2; return Math.sqrt(e / Math.max(1, n)); };
  await setPreset("bass");
  await sleep(300);
  const bass = await render();
  await setPreset("lead");
  await sleep(300);
  const lead = await render();
  check("P6. Bass is darker than Lead (less high-frequency content)", highs(bass, 0.4, 1.0) < highs(lead, 0.4, 1.0), `bass ${highs(bass, 0.4, 1.0).toFixed(4)} vs lead ${highs(lead, 0.4, 1.0).toFixed(4)}`);

  // undoable; the saved preset returns after a round-trip
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  check("P7. changing the preset is undoable", (await presetOf()) === "bass");
} catch (e) {
  check("presets run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
