// Import MIDI: a real .mid file becomes a new project with its tracks, notes and tempo.
// Usage: node apps/desktop/e2e/importmidi.mjs   (build the app first: npm run build -w apps/desktop)
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9348;
const dataDir = tmpDataDir("daw-midi-");
const child = launch(PORT, dataDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(dataDir, "projects") });
const c = await connect(PORT);

// --- minimal Standard MIDI File builder ---
const vlq = (n) => { const b = [n & 0x7f]; n >>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>= 7; } return b; };
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const str = (s) => [...s].map((ch) => ch.charCodeAt(0));
const midiFile = (division, trackEvents) => {
  const out = [...str("MThd"), ...u32(6), ...u16(1), ...u16(trackEvents.length), ...u16(division)];
  for (const events of trackEvents) {
    const body = [];
    for (const e of events) body.push(...vlq(e.delta), ...e.bytes);
    body.push(...vlq(0), 0xff, 0x2f, 0x00);
    out.push(...str("MTrk"), ...u32(body.length), ...body);
  }
  return Buffer.from(out);
};
const tempoMeta = (bpm) => { const us = Math.round(60000000 / bpm); return { delta: 0, bytes: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] }; };
const nameMeta = (name) => ({ delta: 0, bytes: [0xff, 0x03, name.length, ...str(name)] });
const on = (delta, ch, pitch, vel) => ({ delta, bytes: [0x90 | ch, pitch, vel] });
const off = (delta, ch, pitch) => ({ delta, bytes: [0x80 | ch, pitch, 0] });

const proj = () => c.evalJs(`window.daw.getInitial().then((x) => x.project)`);
const importMidi = (p) => c.evalJs(`window.daw.projects.importMidi(${JSON.stringify(p)})`);

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);

  // a 2-track MIDI at 140 BPM, division 480: a melody and a drum hit
  const midiPath = path.join(dataDir, "my beat.mid");
  fs.writeFileSync(midiPath, midiFile(480, [
    [tempoMeta(140), nameMeta("Lead"), on(0, 0, 60, 100), off(480, 0, 60), on(0, 0, 67, 90), off(480, 0, 67)],
    [nameMeta("Drums"), on(0, 9, 36, 120), off(240, 9, 36), on(240, 9, 38, 110), off(240, 9, 38)],
  ]));

  const r = await importMidi(midiPath);
  await sleep(700);
  const p = await proj();
  const tracks = p.trackOrder.map((id) => p.tracks[id]);
  check("I1. importing a MIDI file makes a new project named after the file", r.ok && r.tracks === 2 && (await c.evalJs(`document.querySelector('[data-testid=project-name]')?.textContent`)) === "my beat", JSON.stringify({ ok: r.ok, tracks: r.tracks }));
  check("I2. the tempo comes from the file", p.tempo === 140, String(p.tempo));
  check("I3. a track per MIDI track, named, with the drum track as drums", tracks.length === 2 && tracks[0].name === "Lead" && tracks[0].instrument === "synth" && tracks[1].name === "Drums" && tracks[1].instrument === "drums", JSON.stringify(tracks.map((t) => [t.name, t.instrument])));
  const lead = Object.values(tracks[0].clips)[0];
  const leadNotes = Object.values(lead.notes).sort((a, b) => a.startTick - b.startTick);
  check("I4. notes keep their pitch, timing (scaled to PPQ 960) and velocity", leadNotes.length === 2 && leadNotes[0].pitch === 60 && leadNotes[0].durationTicks === 960 && leadNotes[1].startTick === 960 && leadNotes[1].pitch === 67 && leadNotes[1].velocity === 90, JSON.stringify(leadNotes.map((n) => [n.pitch, n.startTick, n.durationTicks, n.velocity])));
  const drumNotes = Object.values(Object.values(tracks[1].clips)[0].notes);
  check("I5. the drum track has its GM drum notes (kick 36, snare 38)", drumNotes.map((n) => n.pitch).sort((a, b) => a - b).join() === "36,38", JSON.stringify(drumNotes.map((n) => n.pitch)));

  // it plays: render and check there is audio
  await c.evalJs(`window.__exports = []; window.daw.onExportStatus((x) => window.__exports.push(x));`);
  const wavPath = path.join(dataDir, "out.wav");
  await c.evalJs(`window.daw.exportWav(${JSON.stringify(wavPath)}, { tailSeconds: 0 })`);
  const done = await until(async () => await c.evalJs(`(window.__exports || []).find((x) => x.state === 'done' || x.state === 'error') || null`), 30000, 100);
  const peak = done?.state === "done" ? done.peak : 0;
  check("I6. the imported project actually plays (the render has audio)", done?.state === "done" && peak > 0.01, JSON.stringify({ state: done?.state, peak }));

  // a non-MIDI file is refused
  const bad = path.join(dataDir, "bad.mid");
  fs.writeFileSync(bad, "this is not midi");
  const rb = await importMidi(bad);
  check("I7. a file that is not MIDI is refused with a message", rb.ok === false && !!rb.reason, JSON.stringify(rb));
} catch (e) {
  check("importmidi run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
