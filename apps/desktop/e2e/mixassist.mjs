// Mixer assistant, end to end on real audio: levels are measured from the engine while the song plays, a suggested fix is applied with
// one click, and the result is checked in the audio itself (a second playback, and an offline WAV export), not in the fader position.
// Covers: below / above target, a clipping master, several contributing channels, silent channels, undo and restore, changing targets,
// stopping and restarting, saving and reopening, and two collaborators at once.
// Usage: node apps/desktop/e2e/mixassist.mjs   (build the app and the engine first)
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const readWavPeak = (file) => {
  const b = fs.readFileSync(file);
  let p = 12, ch = 2, bits = 24, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString("latin1", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") (ch = b.readUInt16LE(p + 10), bits = b.readUInt16LE(p + 22));
    if (id === "data") data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  const bytes = bits / 8, n = Math.floor(data.length / bytes);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data.readIntLE(i * bytes, bytes) / 2 ** (bits - 1)));
  void ch;
  return peak;
};

/** A window onto one running app instance with the helpers the scenarios need. */
function rig(c, dir) {
  const ev = c.evalJs;
  const r = {
    c, ev,
    project: () => ev(`window.daw.getInitial().then((x) => x.project)`),
    snap: () => ev(`window.daw.mix.get()`),
    openMixer: () => ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Mixer'))?.click()`),
    /** scrolls the element into view first, as a person would, then clicks it */
    click: async (sel) => {
      await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'nearest' })`);
      await sleep(80);
      await c.clickEl(sel);
    },
    has: (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`),
    text: (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`),
    attr: (sel, a) => ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)})`),
    /** plays from the start for a while, then stops; the measurement stays for reading */
    play: async (sec = 3) => {
      await ev(`window.daw.stop()`);
      await sleep(250);
      await ev(`window.daw.play()`);
      await sleep(sec * 1000);
      await ev(`window.daw.stop()`);
      await sleep(500);
    },
    setNum: async (testId, value) => {
      await ev(`document.querySelector('[data-testid="${testId}"]').focus()`);
      await c.setRange(`[data-testid="${testId}"]`, String(value));
      await ev(`document.querySelector('[data-testid="${testId}"]').blur()`); // the field commits on blur
      await sleep(200);
    },
    exportPeak: async (name) => {
      await ev(`window.__ex = []; window.daw.onExportStatus((x) => window.__ex.push(x));`);
      const file = path.join(dir, name);
      await ev(`window.daw.exportWav(${JSON.stringify(file)}, { tailSeconds: 0 })`);
      const done = await until(() => ev(`(window.__ex || []).find((x) => x.state === 'done' || x.state === 'error') || null`), 60000, 150);
      if (done?.state !== "done") throw new Error("export failed " + JSON.stringify(done));
      return readWavPeak(file);
    },
    ready: () => until(async () => (await ev(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 20000),
    /** a track playing a 4-note chord, loud */
    addChordTrack: async (id, name, base, volume) => {
      const notes = [0, 4, 7, 12].map((o, i) => `{ type: "addNote", trackId: ${JSON.stringify(id)}, clipId: ${JSON.stringify("clip-" + id)}, note: { id: ${JSON.stringify(id + "-n" + i)}, pitch: ${base + o}, startTick: 0, durationTicks: 7680, velocity: 127 } }`).join(",");
      await ev(`(async () => { const t = { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, instrument: "synth", color: "#22c55e", volume: ${volume}, pan: 0, mute: false, solo: false, clips: { ${JSON.stringify("clip-" + id)}: { id: ${JSON.stringify("clip-" + id)}, name: "Clip 1", startTick: 0, lengthTicks: 15360, notes: {} } } }; await window.daw.dispatch({ type: "addTrack", track: t }); await window.daw.dispatchBatch([${notes}]); })()`);
    },
  };
  return r;
}

// =============================================================================================================== single instance
const dataDir = tmpDataDir("daw-mixassist-");
const child = launch(9392, dataDir);
let A;
try {
  const c = await connect(9392);
  A = rig(c, dataDir);
  await A.ready();
  await A.ev(`window.daw.setProgressMode('all')`);
  await A.ev(`window.daw.dispatch({ type: "setSongLength", bars: 4 })`);
  await A.ev(`(async () => { await window.daw.dispatchBatch([0, 4, 7, 12].map((o, i) => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "k" + i, pitch: 48 + o, startTick: 0, durationTicks: 7680, velocity: 127 } }))); })()`);
  await A.ev(`window.daw.dispatch({ type: "updateTrack", trackId: "track-1", changes: { name: "Kick" } })`);
  await A.openMixer();
  check("the mixer shows the Mix check panel", await until(() => A.has('[data-testid="mix-panel"]'), 5000));
  check("before any playback the panel asks for one and shows no made-up numbers", (await A.attr('[data-testid="mix-status"]', "data-state")) === "no-data" && !(await A.has('[data-testid="mix-master"]')) && (await A.text('[data-testid="master-peak"]')).includes("--"));

  // ---- 1. a channel with its peak below its target
  await A.play(3);
  const s1 = await A.snap();
  const kickPeakDb = db(s1.channels["track-1"].peak);
  check("measured from the real audio: the master peak is the channel peak times the master gain (0.64 at fader 80)", near(s1.master.prePeak / s1.channels["track-1"].peak, 0.64, 0.01), `ratio ${(s1.master.prePeak / s1.channels["track-1"].peak).toFixed(3)}`);
  check("RMS is below peak and above zero, as a chord's must be", s1.channels["track-1"].rms > 0.01 && s1.channels["track-1"].rms < s1.channels["track-1"].peak, `rms ${db(s1.channels["track-1"].rms).toFixed(1)} dB, peak ${kickPeakDb.toFixed(1)} dB`);
  check("1. a peak below the target (default -8 dBFS) raises no flag", kickPeakDb < -8 && !(await A.has('[data-testid="mix-badge-track-1"]')) && (await A.has('[data-testid="mix-clear"]')), `peak ${kickPeakDb.toFixed(2)} dBFS`);
  check("the panel shows the master sample peak, its headroom and the target", (await A.attr('[data-testid="mix-master"]', "data-state")) === "ok" && /dB/.test(await A.text('[data-testid="mix-master-headroom"]')) && near(Number(await A.attr('[data-testid="mix-master-peak"]', "data-db")), db(s1.master.prePeak), 0.1));
  check("the master strip shows the same peak", (await A.text('[data-testid="master-peak"]')).includes(db(s1.master.prePeak).toFixed(1)), await A.text('[data-testid="master-peak"]'));

  // ---- 7. changing a configured target, then 2. a channel above it
  await A.click('[data-testid="mix-targets-toggle"]');
  const targetDb = Math.round((kickPeakDb - 4) * 2) / 2; // 4 dB under what the kick really does
  await A.setNum("mix-target-channel", targetDb);
  check("7. changing the channel target is saved in the project", (await A.project()).mixReference?.channelPeakDb === targetDb, JSON.stringify((await A.project()).mixReference));
  check("2. the channel now exceeds its target: a marker appears on its strip", await until(() => A.has('[data-testid="mix-badge-track-1"]'), 4000));
  await A.click('[data-testid="mix-badge-track-1"]');
  check("the explanation opens with what was measured and the target", await until(async () => /dBFS/.test(await A.text('[data-testid="mix-detected"]')) && (await A.text('[data-testid="mix-detected"]')).includes(`${targetDb.toFixed(1)} dBFS`), 4000), await A.text('[data-testid="mix-detected"]'));
  const card = await A.text('[data-testid="mix-card"]');
  check("it says what changes, why it may help and what to listen for", /Kick fader/.test(card) && /Why it may help/.test(card) && /What to listen for/.test(card), card.slice(0, 200));
  const volumeBefore = (await A.project()).tracks["track-1"].volume;
  const wavBefore = await A.exportPeak("before.wav");
  const wantedDb = targetDb - kickPeakDb;
  await A.click('[data-testid="mix-apply-fader-track-1"]');
  const volumeAfter = await until(async () => { const v = (await A.project()).tracks["track-1"].volume; return v !== volumeBefore ? v : null; }, 4000);
  const appliedDb = 40 * Math.log10(volumeAfter / volumeBefore);
  check("one click lowers the channel fader by about the amount asked", !!volumeAfter && near(appliedDb, wantedDb, 0.4), `wanted ${wantedDb.toFixed(2)} dB, fader ${volumeBefore} -> ${volumeAfter} = ${appliedDb.toFixed(2)} dB`);
  const proj2 = await A.project();
  check("nothing else changed: pan, mute, solo, master, name", proj2.tracks["track-1"].pan === 0 && !proj2.tracks["track-1"].mute && !proj2.tracks["track-1"].solo && proj2.masterVolume === 80 && proj2.tracks["track-1"].name === "Kick");
  check("the applied fix is listed with a restore button", await A.has('[data-testid="mix-applied-item"]') && await A.has('[data-testid="mix-restore"]'));
  const wavAfter = await A.exportPeak("after.wav");
  check("the exported audio is quieter by the same amount (not just a moved fader)", near(db(wavAfter) - db(wavBefore), appliedDb, 0.15), `WAV peak ${db(wavBefore).toFixed(2)} -> ${db(wavAfter).toFixed(2)} dBFS`);
  await A.play(3);
  const s2 = await A.snap();
  const newPeak = db(s2.channels["track-1"].peak);
  check("playing again measures the new, lower peak, close to the target", near(newPeak, targetDb, 0.7) && near(newPeak - kickPeakDb, appliedDb, 0.25), `now ${newPeak.toFixed(2)} dBFS (target ${targetDb})`);
  check("and the marker is gone", !(await A.has('[data-testid="mix-badge-track-1"]')));

  // ---- 8. stop and restart: a new pass, the same numbers
  const pass1 = s2.pass;
  await A.play(3);
  const s3 = await A.snap();
  check("8. stopping and playing again starts a fresh measurement pass with the same result", s3.pass > pass1 && near(db(s3.channels["track-1"].peak), newPeak, 0.2), `pass ${pass1} -> ${s3.pass}, ${db(s3.channels["track-1"].peak).toFixed(2)} dBFS`);

  // ---- 6. undo and restore
  await A.click('[data-testid="mix-restore"]');
  check("6. Restore original puts the fader back exactly", (await until(async () => (await A.project()).tracks["track-1"].volume === volumeBefore, 4000)) === true && !(await A.has('[data-testid="mix-applied-item"]')));
  await A.play(3);
  check("the next measurement is the original level again", near(db((await A.snap()).channels["track-1"].peak), kickPeakDb, 0.2));
  await A.click('[data-testid="mix-badge-track-1"]');
  await A.click('[data-testid="mix-apply-fader-track-1"]');
  await until(async () => (await A.project()).tracks["track-1"].volume !== volumeBefore, 4000);
  await A.ev(`document.activeElement?.blur?.()`);
  await A.c.ctrl("z");
  check("6. Ctrl+Z takes back the whole fix in one step", (await until(async () => (await A.project()).tracks["track-1"].volume === volumeBefore, 4000)) === true);
  await A.click('[data-testid="mix-targets-toggle"]');

  // ---- preview: hear a fix before applying it; the project does not change
  await A.play(3);
  const pBase = await A.snap();
  const volReal = (await A.project()).tracks["track-1"].volume;
  const undoBefore = await A.ev(`window.daw.getInitial().then((x) => x.canUndo)`);
  await A.click('[data-testid="mix-badge-track-1"]');
  await A.click('[data-testid="mix-preview-fader-track-1"]');
  check("Preview: a banner says a preview is playing", await until(() => A.has('[data-testid="mix-preview-banner"]'), 4000));
  const pProj = await A.project();
  check("Preview: the project itself is unchanged (fader, undo history)", pProj.tracks["track-1"].volume === volReal && (await A.ev(`window.daw.getInitial().then((x) => x.canUndo)`)) === undoBefore);
  await A.play(3);
  const pHeard = await A.snap();
  check("Preview: the engine really plays the quieter version", near(db(pHeard.channels["track-1"].peak), targetDb, 0.7) && db(pBase.channels["track-1"].peak) - db(pHeard.channels["track-1"].peak) > 3, `${db(pBase.channels["track-1"].peak).toFixed(2)} -> ${db(pHeard.channels["track-1"].peak).toFixed(2)} dBFS (target ${targetDb})`);
  check("Preview: and the real fader still reads the original value", (await A.project()).tracks["track-1"].volume === volReal);
  check("Preview: the previewed version no longer shows the marker (the result can be judged before keeping it)", !(await A.has('[data-testid="mix-badge-track-1"]')));
  const wavReal = await A.exportPeak("preview-export.wav");
  check("Preview: an export is always the real project, and ends the preview", near(db(wavReal), db(wavBefore), 0.05) && !(await A.has('[data-testid="mix-preview-banner"]')), `WAV ${db(wavReal).toFixed(2)} dBFS, original ${db(wavBefore).toFixed(2)}`);

  await A.play(3);
  await A.click('[data-testid="mix-badge-track-1"]');
  await A.click('[data-testid="mix-preview-fader-track-1"]');
  await until(() => A.has('[data-testid="mix-preview-banner"]'), 4000);
  await A.click('[data-testid="mix-preview-stop"]');
  check("Stop preview: the banner goes and nothing was changed", await until(async () => !(await A.has('[data-testid="mix-preview-banner"]')), 4000) && (await A.project()).tracks["track-1"].volume === volReal && !(await A.has('[data-testid="mix-applied-item"]')));
  await A.play(3);
  check("Stop preview: the original sound is back", near(db((await A.snap()).channels["track-1"].peak), db(pBase.channels["track-1"].peak), 0.2));

  await A.click('[data-testid="mix-badge-track-1"]');
  await A.click('[data-testid="mix-preview-fader-track-1"]');
  await until(() => A.has('[data-testid="mix-preview-banner"]'), 4000);
  await A.play(3);
  await A.click('[data-testid="mix-preview-keep"]');
  check("Keep: the fader change becomes real, as one undoable step, and is listed with Restore", (await until(async () => (await A.project()).tracks["track-1"].volume < volReal, 4000)) !== null && !(await A.has('[data-testid="mix-preview-banner"]')) && (await A.has('[data-testid="mix-restore"]')));
  check("Keep: what was measured during the preview is still valid, so no new playback is needed", (await A.attr('[data-testid="mix-status"]', "data-state")) === "measured" && near(db((await A.snap()).channels["track-1"].peak), targetDb, 0.7), await A.text('[data-testid="mix-status"]'));
  await A.click('[data-testid="mix-restore"]');
  await until(async () => (await A.project()).tracks["track-1"].volume === volReal, 4000);

  await A.play(3);
  await A.click('[data-testid="mix-badge-track-1"]');
  await A.click('[data-testid="mix-preview-fader-track-1"]');
  await until(() => A.has('[data-testid="mix-preview-banner"]'), 4000);
  await A.ev(`window.daw.dispatch({ type: "setTempo", bpm: 121 })`);
  check("a real change to the project ends the preview, with a message", (await until(async () => !(await A.has('[data-testid="mix-preview-banner"]')), 4000)) === true && /project changed/.test(await A.text('[data-testid="mix-job-message"]')));
  await A.ev(`window.daw.dispatch({ type: "setTempo", bpm: 120 })`);

  // ---- 3 + 4. a master that clips with several contributing channels
  await A.ev(`window.daw.dispatch({ type: "setMixReference", reference: null })`);
  await A.addChordTrack("bass", "Bass", 36, 100);
  await A.addChordTrack("lead", "Lead", 60, 100);
  await A.addChordTrack("pad", "Pad", 48, 30);
  await A.ev(`window.daw.dispatchBatch([{ type: "updateTrack", trackId: "track-1", changes: { volume: 100 } }, { type: "setMasterVolume", volume: 100 }])`);
  await sleep(400);
  await A.play(3);
  const s4 = await A.snap();
  check("3. the master clips: its peak before the soft clip is above full scale", s4.master.prePeak > 1.0 && s4.master.overSeconds > 0, `pre-clip peak ${db(s4.master.prePeak).toFixed(2)} dBFS, ${(s4.master.overSeconds * 1000).toFixed(0)} ms over`);
  check("the speakers' own peak stays under 1.0: the soft clip hides what the master meter would show", s4.master.outPeak < 1.0, `output peak ${s4.master.outPeak.toFixed(4)}`);
  check("a contextual warning appears in the panel and on the master strip", (await A.attr('[data-testid="mix-master"]', "data-state")) === "clipping" && /clipping/i.test(await A.text('[data-testid="mix-clip-warning"]')) && (await A.attr('[data-testid="master-peak"]', "data-state")) === "clipping");
  check("the master did not change by itself", (await A.project()).masterVolume === 100);
  await A.click('[data-testid="mix-finding-master"]');
  const mcard = await A.text('[data-testid="mix-card"]');
  check("4. the master explanation names the contributing channels and warns that one channel may not be enough", /Several channels may be contributing/.test(mcard) && /Kick|Bass|Lead/.test(mcard) && !/Pad \(/.test(mcard) && /will not always solve/.test(mcard), mcard.slice(0, 260));
  check("the master option and the channels option are both offered, and the quiet Pad is not a contributor", (await A.has('[data-testid="mix-apply-fader-master"]')) && (await A.has('[data-testid="mix-apply-contributors"]')));
  const before4 = await A.project();
  await A.click('[data-testid="mix-apply-contributors"]');
  await until(async () => (await A.project()).tracks["bass"].volume < 100, 4000);
  const after4 = await A.project();
  check("4. only the contributing channels were lowered; the quiet Pad and the master were left alone", after4.tracks["bass"].volume < 100 && after4.tracks["lead"].volume < 100 && after4.tracks["track-1"].volume < 100 && after4.tracks["pad"].volume === 30 && after4.masterVolume === 100);
  await A.play(3);
  const s5 = await A.snap();
  check("playing again: the master no longer clips and its peak fell", s5.master.overSeconds === 0 && s5.master.prePeak < s4.master.prePeak * 0.7, `${db(s4.master.prePeak).toFixed(2)} -> ${db(s5.master.prePeak).toFixed(2)} dBFS`);
  check("the panel clears the clipping warning", (await A.attr('[data-testid="mix-master"]', "data-state")) !== "clipping");
  await A.click('[data-testid="mix-restore"]');
  await until(async () => (await A.project()).tracks["bass"].volume === 100, 4000);
  const restored4 = await A.project();
  check("restoring puts all three faders back", restored4.tracks["bass"].volume === before4.tracks["bass"].volume && restored4.tracks["lead"].volume === 100 && restored4.tracks["track-1"].volume === 100);

  // the exact option: lowering the master by X dB lowers the measured pre-clip peak by X dB
  await A.play(3);
  const s6 = await A.snap();
  await A.click('[data-testid="mix-finding-master"]');
  const m0 = (await A.project()).masterVolume;
  await A.click('[data-testid="mix-apply-fader-master"]');
  await until(async () => (await A.project()).masterVolume !== m0, 4000);
  const m1 = (await A.project()).masterVolume;
  await A.play(3);
  const s7 = await A.snap();
  check("the master option is exact: the measured peak drops by the dB the master fader moved", near(db(s7.master.prePeak) - db(s6.master.prePeak), 40 * Math.log10(m1 / m0), 0.1), `fader ${m0} -> ${m1} (${(40 * Math.log10(m1 / m0)).toFixed(2)} dB), peak ${db(s6.master.prePeak).toFixed(2)} -> ${db(s7.master.prePeak).toFixed(2)}`);
  await A.ev(`window.daw.dispatch({ type: "setMasterVolume", volume: 100 })`);

  // ---- whole-song analysis (offline): the same numbers without playing, plus an estimated true peak
  await A.play(3);
  const live = await A.snap();
  await A.click('[data-testid="mix-analyse"]');
  const songDone = await until(async () => (await A.snap()).source === "song", 60000, 200);
  check("Analyse song renders the whole song and reports it", !!songDone && /whole song/.test(await A.text('[data-testid="mix-status"]')), await A.text('[data-testid="mix-status"]'));
  const song = await A.snap();
  check("it covers the whole song (8 s plus a short tail)", song.seconds > 8.5 && song.seconds < 10, `${song.seconds.toFixed(2)} s`);
  check("its master peak agrees with live playback", near(db(song.master.prePeak), db(live.master.prePeak), 0.3), `offline ${db(song.master.prePeak).toFixed(2)} vs live ${db(live.master.prePeak).toFixed(2)} dBFS`);
  check("and so does every channel's peak", ["track-1", "bass", "lead", "pad"].every((id) => near(db(song.channels[id].peak), db(live.channels[id].peak), 0.3)), ["track-1", "bass", "lead", "pad"].map((id) => `${id} ${db(song.channels[id].peak).toFixed(1)}/${db(live.channels[id].peak).toFixed(1)}`).join("  "));
  check("the true peak is estimated and is never below the sample peak", song.master.truePeak !== null && song.master.truePeak >= song.master.prePeak - 1e-4 && db(song.master.truePeak) - db(song.master.prePeak) < 3.1, `sample ${db(song.master.prePeak).toFixed(2)}, true ${db(song.master.truePeak).toFixed(2)} dBFS`);
  check("the panel shows the true peak, labelled as an estimate", /true peak \(estimated\)/.test(await A.text('[data-testid="mix-master"]')) && near(Number(await A.attr('[data-testid="mix-master-truepeak"]', "data-db")), db(song.master.truePeak), 0.1));
  check("the offline analysis finds the clipping without playback", (await A.attr('[data-testid="mix-master"]', "data-state")) === "clipping" && song.master.overSeconds > 0);
  const exported = await A.exportPeak("song.wav");
  check("it agrees with the exported file: the speakers' peak equals the WAV's peak", near(song.master.outPeak, exported, 0.002), `analysis ${song.master.outPeak.toFixed(4)} vs WAV ${exported.toFixed(4)}`);
  await A.ev(`window.daw.dispatch({ type: "updateTrack", trackId: "bass", changes: { volume: 90 } })`);
  check("moving a fader marks the result out of date instead of leaving a wrong one on screen", await until(async () => (await A.attr('[data-testid="mix-status"]', "data-state")) === "stale", 4000) && !(await A.has('[data-testid="mix-master"]')), await A.text('[data-testid="mix-status"]'));
  await A.ev(`window.daw.dispatch({ type: "updateTrack", trackId: "bass", changes: { volume: 100 } })`);
  // the mix changes right after the analysis starts, while the song is still rendering
  await A.ev(`(async () => { await window.daw.mix.analyzeSong(); await window.daw.dispatch({ type: "updateTrack", trackId: "lead", changes: { volume: 77 } }); })()`);
  check("a result for a mix that changed while rendering is discarded, with a message", await until(async () => /changed while/.test(await A.text('[data-testid="mix-job-message"]')), 60000, 200) === true && (await A.snap()).source !== "song", await A.text('[data-testid="mix-job-message"]'));
  await A.ev(`window.daw.dispatch({ type: "updateTrack", trackId: "lead", changes: { volume: 100 } })`);

  // ---- 5. silent channels
  await A.ev(`window.daw.dispatch({ type: "updateTrack", trackId: "pad", changes: { mute: true } })`);
  await A.play(3);
  const s8 = await A.snap();
  check("5. a muted channel measures nothing: no peak, no time, no marker", s8.channels["pad"].peak === 0 && s8.channels["pad"].seconds === 0 && !(await A.has('[data-testid="mix-badge-pad"]')));
  await A.ev(`window.daw.dispatch({ type: "updateTrack", trackId: "pad", changes: { mute: false } })`);
  await A.ev(`window.daw.dispatchBatch([{ type: "updateTrack", trackId: "track-1", changes: { mute: true } }, { type: "updateTrack", trackId: "bass", changes: { mute: true } }, { type: "updateTrack", trackId: "lead", changes: { mute: true } }, { type: "updateTrack", trackId: "pad", changes: { mute: true } }])`);
  await A.play(3);
  check("with everything muted the panel says nothing audible was measured", (await A.attr('[data-testid="mix-status"]', "data-state")) === "silent", await A.text('[data-testid="mix-status"]'));
  await A.ev(`window.daw.dispatchBatch([{ type: "updateTrack", trackId: "track-1", changes: { mute: false } }, { type: "updateTrack", trackId: "bass", changes: { mute: false } }, { type: "updateTrack", trackId: "lead", changes: { mute: false } }, { type: "updateTrack", trackId: "pad", changes: { mute: false } }])`);

  // ---- 9. save and reopen with the targets
  await A.ev(`window.daw.dispatch({ type: "setMixReference", reference: { masterPeakDb: -9, channelPeakDb: -11.5, safetyDb: -3, channels: { bass: -7 } } })`);
  const file = path.join(dataDir, "mix.daw");
  const saved = await A.ev(`window.daw.projects.save(${JSON.stringify(file)})`);
  await A.ev(`window.daw.projects.new("Other")`);
  await sleep(500);
  check("9. a new project starts on the default targets", (await A.project()).mixReference === undefined);
  const opened = await A.ev(`window.daw.projects.openFile(${JSON.stringify(file)})`);
  await sleep(500);
  check("9. saving and reopening keeps the targets", saved.ok && opened.ok && JSON.stringify((await A.project()).mixReference) === JSON.stringify({ masterPeakDb: -9, channelPeakDb: -11.5, safetyDb: -3, channels: { bass: -7 } }), JSON.stringify((await A.project()).mixReference));
} catch (e) {
  check("single-instance scenarios ran without an unexpected error", false, String(e?.stack ?? e));
} finally {
  killTree(child);
  rmDir(dataDir);
}

// =============================================================================================================== 10. two collaborators
const hostDir = tmpDataDir("daw-mixassist-host-");
const joinDir = tmpDataDir("daw-mixassist-join-");
const hostChild = launch(9394, hostDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(hostDir, "projects") });
const joinChild = launch(9395, joinDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: path.join(joinDir, "projects") });
try {
  const H = rig(await connect(9394), hostDir);
  const J = rig(await connect(9395), joinDir);
  await H.ready();
  await J.ready();
  for (const R of [H, J]) await R.ev(`window.daw.setProgressMode('all')`);
  await H.ev(`window.daw.dispatch({ type: "setSongLength", bars: 4 })`);
  await H.ev(`window.daw.dispatch({ type: "updateTrack", trackId: "track-1", changes: { name: "Kick", volume: 100 } })`);
  await H.ev(`window.daw.dispatchBatch([0, 4, 7, 12].map((o, i) => ({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "k" + i, pitch: 48 + o, startTick: 0, durationTicks: 7680, velocity: 127 } })))`);
  await H.addChordTrack("bass", "Bass", 36, 100);
  await H.addChordTrack("lead", "Lead", 60, 100);
  await H.ev(`window.daw.dispatch({ type: "setMasterVolume", volume: 100 })`);
  await sleep(300);
  const hosted = await H.ev(`window.daw.collab.host("Ana")`);
  const port = hosted.address.split(":").pop();
  await until(async () => (await H.ev(`window.daw.collab.getState()`)).status === "connected", 8000);
  const joined = await J.ev(`window.daw.collab.join("127.0.0.1:${port}", ${JSON.stringify(hosted.code)}, "Ben")`);
  check("10. two people are in one session", hosted.ok && joined.ok && (await until(async () => (await J.project()).trackOrder.length === 3, 8000)) === true);
  await H.openMixer();
  await J.openMixer();

  // both play at the same time; each engine measures the same shared project
  await Promise.all([H.play(3), J.play(3)]);
  const [hs, js] = [await H.snap(), await J.snap()];
  check("10. both collaborators measure a clipping master, and agree on its level", hs.master.prePeak > 1 && js.master.prePeak > 1 && near(db(hs.master.prePeak), db(js.master.prePeak), 0.5), `host ${db(hs.master.prePeak).toFixed(2)} dBFS, guest ${db(js.master.prePeak).toFixed(2)} dBFS`);
  check("10. both see the clipping warning", (await H.attr('[data-testid="mix-master"]', "data-state")) === "clipping" && (await J.attr('[data-testid="mix-master"]', "data-state")) === "clipping");

  // at the same moment: the host changes the targets while the guest applies the "lower the loudest channels" fix
  await J.click('[data-testid="mix-finding-master"]');
  const beforeCollab = await J.project();
  await Promise.all([
    H.ev(`window.daw.dispatch({ type: "setMixReference", reference: { masterPeakDb: -9, channelPeakDb: -10, safetyDb: -2 } })`),
    J.click('[data-testid="mix-apply-contributors"]'),
  ]);
  const converged = await until(async () => {
    const [hp, jp] = [await H.project(), await J.project()];
    return jp.tracks["bass"].volume < 100 && JSON.stringify(hp.tracks) === JSON.stringify(jp.tracks) && JSON.stringify(hp.mixReference) === JSON.stringify(jp.mixReference) && hp.mixReference?.masterPeakDb === -9 ? true : null;
  }, 10000, 200);
  if (!converged) {
    const [hp0, jp0] = [await H.project(), await J.project()];
    console.log("DEBUG host", JSON.stringify({ vols: hp0.trackOrder.map((i) => hp0.tracks[i].volume), ref: hp0.mixReference }), "guest", JSON.stringify({ vols: jp0.trackOrder.map((i) => jp0.tracks[i].volume), ref: jp0.mixReference }), "state", JSON.stringify(await J.ev(`window.daw.collab.getState()`)));
  }
  check("10. simultaneous edits converge: the same faders and the same targets on both sides", !!converged);
  const hp = await H.project();
  check("10. the guest's fix and the host's target change both survived", hp.mixReference?.masterPeakDb === -9 && hp.tracks["bass"].volume < beforeCollab.tracks["bass"].volume);
  await Promise.all([H.play(3), J.play(3)]);
  const [hs2, js2] = [await H.snap(), await J.snap()];
  check("10. after the fix both engines play the lower mix: no clipping, and the same peak", hs2.master.overSeconds === 0 && js2.master.overSeconds === 0 && near(db(hs2.master.prePeak), db(js2.master.prePeak), 0.5) && hs2.master.prePeak < hs.master.prePeak, `${db(hs.master.prePeak).toFixed(2)} -> host ${db(hs2.master.prePeak).toFixed(2)} / guest ${db(js2.master.prePeak).toFixed(2)} dBFS`);
} catch (e) {
  check("collaboration scenario ran without an unexpected error", false, String(e?.stack ?? e));
} finally {
  killTree(hostChild);
  killTree(joinChild);
  rmDir(hostDir);
  rmDir(joinDir);
}
finish();
