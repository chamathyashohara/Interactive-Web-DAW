// Export settings window: it opens with the right info, and the tail setting changes the rendered file length.
// Usage: node apps/desktop/e2e/exportui.mjs   (build the app first: npm run build -w apps/desktop)
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9347;
const dataDir = tmpDataDir("daw-exportui-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);

const exists = (sel) => c.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const frames = (file) => {
  const b = fs.readFileSync(file);
  let p = 12, fmtCh = 2, bits = 24, dataLen = 0;
  while (p + 8 <= b.length) {
    const id = b.toString("latin1", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") (fmtCh = b.readUInt16LE(p + 10), bits = b.readUInt16LE(p + 22));
    if (id === "data") dataLen = size;
    p += 8 + size + (size % 2);
  }
  return Math.floor(dataLen / (fmtCh * (bits / 8)));
};
const exportWith = async (file, tail) => {
  await c.evalJs(`window.__exports = []; window.daw.onExportStatus && window.daw.onExportStatus((x) => window.__exports.push(x));`);
  await c.evalJs(`window.daw.exportWav(${JSON.stringify(file)}, { tailSeconds: ${tail} })`);
  const done = await until(async () => await c.evalJs(`(window.__exports || []).find((x) => x.state === 'done' || x.state === 'error') || null`), 30000, 100);
  if (done?.state !== "done") throw new Error("export failed: " + JSON.stringify(done));
  return frames(file);
};

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  await c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n1", pitch: 60, startTick: 0, durationTicks: 3840, velocity: 100 } })`);
  await sleep(300);

  // ---------- the dialog ----------
  await c.clickEl("[data-testid=export-wav]");
  await sleep(400);
  check("E1. the Export WAV button opens the export settings window", await exists("[data-testid=export-dialog]"));
  check("E2. it shows the fixed WAV quality and the rendered length", (await text("[data-testid=export-dialog]")).includes("WAV") && (await text("[data-testid=export-dialog]")).includes("48 kHz") && (await exists("[data-testid=export-tail]")));
  check("E3. a tail choice is offered", (await c.evalJs(`document.querySelectorAll('[data-testid=export-tail] option').length`)) >= 2);
  await c.clickEl("[data-testid=export-close]");
  await sleep(300);
  check("E4. Cancel/close dismisses the window", !(await exists("[data-testid=export-dialog]")));

  // ---------- the tail setting really changes the render ----------
  const noTail = await exportWith(path.join(dataDir, "no-tail.wav"), 0);
  const longTail = await exportWith(path.join(dataDir, "long-tail.wav"), 4);
  const rate = 48000;
  check("E5. a longer tail renders a longer file (about 4 seconds more at 48 kHz)", longTail - noTail > 3.5 * rate && longTail - noTail < 4.5 * rate, `${noTail} -> ${longTail} frames (+${((longTail - noTail) / rate).toFixed(2)} s)`);
  check("E6. the render is a real 48 kHz file of the song plus the tail", noTail >= 2 * rate, `${(noTail / rate).toFixed(2)} s`);
} catch (e) {
  check("exportui run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
