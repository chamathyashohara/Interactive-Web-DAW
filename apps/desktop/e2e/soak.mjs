// Engine soak test: plays a dense 8-track looping pattern for N minutes with a steady stream of project reloads
// (simulating edits) and reports callback overruns. The 8 tracks now cover the newer engine paths too: 5 synths with
// moving volume + filter automation, 2 drum kits, and 1 sample track whose notes retrigger constantly and whose
// tempo-stretch ratio changes on each reload (hammering the sample voice retire/free and the stretch cache). A loop
// region and the metronome are on, so their logic runs for the whole soak.
// Usage: node apps/desktop/e2e/soak.mjs [minutes] [bufferSize] [exportEverySeconds]
// With exportEverySeconds the engine also renders the whole song to a WAV on that interval while playing (tests live audio vs export).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Writes a 2-second stereo 48 kHz 16-bit WAV (a 220 Hz sine) for the sample track to play. */
function writeWav(file) {
  const rate = 48000, secs = 2, ch = 2, frames = rate * secs;
  const data = Buffer.alloc(frames * ch * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767);
    data.writeInt16LE(v, (i * ch) * 2);
    data.writeInt16LE(v, (i * ch + 1) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * ch * 2, 28);
  header.writeUInt16LE(ch * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}
const wavPath = writeWav(path.join(os.tmpdir(), "daw-soak-sample.wav"));

const minutes = Number(process.argv[2] ?? 10);
const buffer = process.argv[3] && process.argv[3] !== "0" ? process.argv[3] : "";
const exportEvery = Number(process.argv[4] ?? 0);
const exe = new URL("../../../engine/build/daw_engine_artefacts/Release/daw_engine.exe", import.meta.url);
const p = spawn(decodeURIComponent(exe.pathname.slice(1)), buffer ? ["--buffer", buffer] : [], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", last = null, ready = null;
const exportStarted = {}, exportSeconds = [], exportErrors = [];
let exportsDone = 0;
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.t === "ready") ready = m;
    else if (m.t === "status") last = m;
    else if (m.t === "exportDone") { exportsDone++; exportSeconds.push(Date.now() - exportStarted[m.id]); }
    else if (m.t === "exportError") exportErrors.push(m.message);
  }
});
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");

const TRACKS = 8;
const STRETCH = [0.8, 1.0, 1.25, 1.5]; // a small fixed set so the stretch cache is exercised but bounded
const makeProject = (shift) => ({
  ppq: 960, tempo: 140, loopTicks: 15360, masterGain: 0.64,
  loopStartTick: 3840, loopEndTick: 11520, // a loop region: the wrap logic runs the whole soak
  tracks: Array.from({ length: TRACKS }, (_, slot) => {
    const kind = slot === 5 ? "sample" : slot >= 6 ? "drums" : "synth";
    const track = {
      slot,
      instrument: kind,
      gain: 0.4 + 0.2 * Math.abs(Math.sin((shift + slot) / 3)), // moving faders
      pan: Math.sin((shift + slot) / 5), // moving pans
      notes: Array.from({ length: kind === "sample" ? 16 : 64 }, (_, i) => {
        const note = {
          pitch: kind === "drums" ? [36, 38, 42, 46, 39, 41, 43, 45][(i + slot) % 8] : kind === "sample" ? 60 : 36 + ((i * 7 + slot * 3 + shift) % 40),
          startTick: i * (kind === "sample" ? 960 : 240),
          durationTicks: kind === "drums" ? 120 : kind === "sample" ? 720 : 960,
          velocity: 60 + (i % 60),
        };
        if (kind === "sample") { note.gain = 0.9; note.fadeInSec = 0.01; note.fadeOutSec = 0.05; note.cut = true; } // clip audio on every sample note
        return note;
      }),
    };
    if (kind === "sample") { track.samplePath = wavPath; track.gate = true; track.stretchRatio = STRETCH[shift % STRETCH.length]; }
    if (kind === "synth") track.automation = { // moving volume + filter curves
      volume: [[0, 0.3], [7680, 1.0], [15360, 0.3]],
      filter: [[0, 0.2 + 0.1 * (slot % 3)], [7680, 1.0], [15360, 0.3]],
    };
    return track;
  }),
});
setTimeout(() => { send({ t: "loadProject", project: makeProject(0) }); send({ t: "play" }); send({ t: "setMetronome", on: true }); }, 1500);
let n = 0;
const edit = setInterval(() => send({ t: "loadProject", project: makeProject(++n) }), 100); // 10 project updates/s
let exportCount = 0;
const exporter = exportEvery > 0 ? setInterval(() => {
  const id = "soak-" + ++exportCount;
  exportStarted[id] = Date.now();
  send({ t: "exportWav", id, path: os.tmpdir() + "/daw-soak-export.wav", tailSeconds: 2 });
}, exportEvery * 1000) : null;
// Engine process memory (KB), so a voice/buffer leak shows up as steadily rising RSS over the run.
const rssSamples = [];
const readRssKb = () => {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${p.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    const m = /"([\d.,]+) K"/.exec(out);
    return m ? Number(m[1].replace(/[.,]/g, "")) : null;
  } catch {
    return null;
  }
};
const report = setInterval(() => {
  const rss = readRssKb();
  if (rss) rssSamples.push(rss);
  if (last) console.log(new Date().toISOString().slice(11, 19), `callbacks=${last.callbacks} overruns=${last.overruns} peakLoad=${(last.peakLoad * 100).toFixed(1)}% xruns=${last.xruns} rss=${rss ? (rss / 1024).toFixed(0) + "MB" : "?"} masterL=${last.masterL}`);
}, 30000);
setTimeout(() => {
  clearInterval(edit); clearInterval(report); if (exporter) clearInterval(exporter);
  const rssStartMb = rssSamples.length ? +(rssSamples[0] / 1024).toFixed(0) : null;
  const rssEndMb = rssSamples.length ? +(rssSamples[rssSamples.length - 1] / 1024).toFixed(0) : null;
  const rssMaxMb = rssSamples.length ? +(Math.max(...rssSamples) / 1024).toFixed(0) : null;
  console.log("RESULT", JSON.stringify({ minutes, tracks: TRACKS, device: ready?.device, deviceType: ready?.deviceType, sampleRate: ready?.sampleRate, bufferSize: ready?.bufferSize, cpu: os.cpus()[0].model, callbacks: last?.callbacks, overruns: last?.overruns, peakLoadPct: +(last?.peakLoad * 100).toFixed(1), xruns: last?.xruns, rssStartMb, rssEndMb, rssMaxMb, rssGrowthMb: rssStartMb !== null ? rssEndMb - rssStartMb : null, exports: exportsDone, exportErrors: exportErrors.length, exportMsAvg: exportSeconds.length ? Math.round(exportSeconds.reduce((a, b) => a + b, 0) / exportSeconds.length) : null }));
  p.stdin.end();
  setTimeout(() => process.exit(last && last.overruns === 0 ? 0 : 1), 500);
}, minutes * 60_000);
