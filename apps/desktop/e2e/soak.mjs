// Engine soak test: plays a dense 8-track looping pattern (6 synths + 2 drum kits, moving mixer values) for N minutes
// with a steady stream of project reloads (simulating edits) and reports callback overruns.
// Usage: node apps/desktop/e2e/soak.mjs [minutes] [bufferSize]
import { spawn } from "node:child_process";
import os from "node:os";

const minutes = Number(process.argv[2] ?? 10);
const buffer = process.argv[3] ?? "";
const exe = new URL("../../../engine/build/daw_engine_artefacts/Release/daw_engine.exe", import.meta.url);
const p = spawn(decodeURIComponent(exe.pathname.slice(1)), buffer ? ["--buffer", buffer] : [], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", last = null, ready = null;
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.t === "ready") ready = m;
    else if (m.t === "status") last = m;
  }
});
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");

const TRACKS = 8;
const makeProject = (shift) => ({
  ppq: 960, tempo: 140, loopTicks: 15360, masterGain: 0.64,
  tracks: Array.from({ length: TRACKS }, (_, slot) => ({
    slot,
    instrument: slot >= 6 ? "drums" : "synth",
    gain: 0.4 + 0.2 * Math.abs(Math.sin((shift + slot) / 3)), // moving faders
    pan: Math.sin((shift + slot) / 5), // moving pans
    // 16th-note density, long synth notes => many simultaneous voices; drums = hits
    notes: Array.from({ length: 64 }, (_, i) => ({
      pitch: slot >= 6 ? [36, 38, 42, 46, 39, 41, 43, 45][(i + slot) % 8] : 36 + ((i * 7 + slot * 3 + shift) % 40),
      startTick: i * 240,
      durationTicks: slot >= 6 ? 120 : 960,
      velocity: 60 + (i % 60),
    })),
  })),
});
setTimeout(() => { send({ t: "loadProject", project: makeProject(0) }); send({ t: "play" }); }, 1500);
let n = 0;
const edit = setInterval(() => send({ t: "loadProject", project: makeProject(++n) }), 100); // 10 project updates/s
const report = setInterval(() => last && console.log(new Date().toISOString().slice(11, 19), `callbacks=${last.callbacks} overruns=${last.overruns} peakLoad=${(last.peakLoad * 100).toFixed(1)}% xruns=${last.xruns} masterL=${last.masterL}`), 30000);
setTimeout(() => {
  clearInterval(edit); clearInterval(report);
  console.log("RESULT", JSON.stringify({ minutes, tracks: TRACKS, device: ready?.device, deviceType: ready?.deviceType, sampleRate: ready?.sampleRate, bufferSize: ready?.bufferSize, cpu: os.cpus()[0].model, callbacks: last?.callbacks, overruns: last?.overruns, peakLoadPct: +(last?.peakLoad * 100).toFixed(1), xruns: last?.xruns }));
  p.stdin.end();
  setTimeout(() => process.exit(last && last.overruns === 0 ? 0 : 1), 500);
}, minutes * 60_000);
