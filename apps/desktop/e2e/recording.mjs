// The remote-recording tab's recordings list: a finished WAV that appears in the recordings folder is offered, and Add to project puts it on a new track.
// (The session itself is covered by remote-recording.mjs; this needs the audio engine, which analyses and plays the take.)
// Usage: node apps/desktop/e2e/recording.mjs (build the desktop app first).
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const dir = tmpDataDir("daw-rec-");
const watch = path.join(dir, "takes");
fs.mkdirSync(watch, { recursive: true });
const child = launch(9360, dir, { DAW_RR_WATCH_DIR: watch });

/** A short 16-bit mono 48 kHz WAV (a decaying tone), like a recorded take. */
function wav16(file, secs, hz) {
  const rate = 48000;
  const n = Math.round(secs * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.6 * 32767), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

let c;
try {
  c = await connect(9360);
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await until(async () => (await c.evalJs(`window.daw.getLibrary()`)).status.state === "ready", 90000, 300);
  await c.evalJs(`window.daw.setProgressMode('all')`);
  const state = () => c.evalJs(`window.daw.recording.getState()`);
  const project = () => c.evalJs(`window.daw.getInitial().then((x) => x.project)`);

  const s0 = await state();
  check("R1. the tab watches the recordings folder", s0.watchDir === watch && s0.takes.length === 0, JSON.stringify(s0));

  // the panel in the window
  await c.evalJs(`document.querySelector('[data-testid=rec-button]').click()`);
  await sleep(200);
  check("R6. the Remote recording panel opens with both role buttons", await c.evalJs(`!!document.querySelector('[data-testid=rec-open-producer]') && !!document.querySelector('[data-testid=rec-open-performer]')`));
  check("R7. nothing is listed before a recording exists", await c.evalJs(`!!document.querySelector('[data-testid=rec-empty]')`));

  // a recording appears in the watched folder
  const take = path.join(watch, "session-1", "take-001.wav");
  wav16(take, 1.5, 330);
  await c.evalJs(`window.daw.recording.pollNow()`);
  await sleep(100);
  await c.evalJs(`window.daw.recording.pollNow()`);
  check("R8. a finished recording is noticed and listed", await until(async () => (await state()).takes.some((t) => t.name === "take-001.wav"), 5000), JSON.stringify((await state()).takes));
  check("R9. the list shows it with an Add to project button", await until(async () => await c.evalJs(`!!document.querySelector('[data-testid=rec-add-folder-take]')`), 4000));

  // add it to the project
  const before = Object.keys((await project()).tracks).length;
  await c.evalJs(`document.querySelector('[data-testid=rec-add-folder-take]').click()`);
  const added = await until(async () => Object.keys((await project()).tracks).length === before + 1, 15000, 200);
  check("R10. Add to project makes a new track", !!added);
  const p = await project();
  const track = Object.values(p.tracks).find((t) => t.instrument === "sample" && t.sample?.id.startsWith("imported/"));
  const clip = track ? Object.values(track.clips)[0] : null;
  check("R11. it is a sample track playing the recording, with a clip at the start of the song", !!track && clip?.startTick === 0 && clip.lengthTicks > 0, JSON.stringify(track?.sample));
  const lib = await c.evalJs(`window.daw.getLibrary()`);
  check("R12. the recording is in the sound library as its own pack, original untouched", lib.packs.some((x) => x.name.startsWith("Recording")) && fs.existsSync(take), lib.packs.map((x) => x.name).join(", "));
  check("R13. it is removed from the list once added", (await state()).takes.length === 0);

  // the engine plays it
  await c.evalJs(`window.__lv = 0; window.daw.onEngineStatus((s) => { for (const v of Object.values(s.levels)) window.__lv = Math.max(window.__lv, v); })`);
  await c.evalJs(`window.daw.play()`);
  const heard = await until(async () => (await c.evalJs(`window.__lv`)) > 0.02, 6000, 150);
  await c.evalJs(`window.daw.stop()`);
  check("R14. the engine plays the recording on its track", !!heard, String(await c.evalJs(`window.__lv`)));

  // a locked feature stays locked: in beginner mode the tab refuses and says which lesson unlocks it
  const take2 = path.join(watch, "session-1", "take-002.wav");
  wav16(take2, 1, 440);
  await c.evalJs(`window.daw.recording.pollNow()`);
  await sleep(100);
  await c.evalJs(`window.daw.recording.pollNow()`);
  await until(async () => (await state()).takes.length === 1, 5000);
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await sleep(300);
  const tracksNow = Object.keys((await project()).tracks).length;
  await c.evalJs(`document.querySelector('[data-testid=rec-add-folder-take]').click()`);
  await sleep(500);
  const msg = await c.evalJs(`document.querySelector('[data-testid=rec-message]')?.textContent ?? ''`);
  check("R15. in beginner mode, adding is refused with the lesson named", /M\d/.test(msg) && Object.keys((await project()).tracks).length === tracksNow, msg);
} catch (e) {
  check("recording run completed without exception", false, String(e));
} finally {
  try { c?.ws.close(); } catch {}
  killTree(child);
  await sleep(500);
  rmDir(dir);
}
finish();
