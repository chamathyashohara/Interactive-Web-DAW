// End-to-end check of "vocal over a backing track": two real DAW windows (a Producer and a Singer in another place).
//   1. the producer parks the playhead; the DAW renders the arrangement and the singer downloads and verifies it
//   2. Play: the singer hears the song when the producer presses Play; Stop stops it
//   3. Record: the song plays from the playhead on the singer's PC while the singer's microphone is recorded, both started on the same audio frame
//   4. the recording comes back verified, and appears on its own "Vocal take" track, at the playhead position, aligned with the song
//   5. more takes go on new tracks; earlier ones are untouched; changing the arrangement refreshes the backing track; the project is saved
// The singer's "microphone" is the backing track's own output (a test switch), so alignment can be checked sample by sample.
//   node apps/desktop/e2e/vocal-over-backing.mjs        (build first: npx electron-vite build)
import fs from "node:fs";
import path from "node:path";
import { connect, delayProxy, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
// RR_SHOT_DIR=<folder> saves screenshots of both windows at key moments.
const shotDir = process.env.RR_SHOT_DIR;
async function shot(c, name) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(r.result.data, "base64"));
}
const A = 9341;
const B = 9342;
const dirA = tmpDataDir("daw-vob-prod-");
const dirB = tmpDataDir("daw-vob-sing-");
const takesA = path.join(dirA, "takes");
const takesB = path.join(dirB, "takes");
const procs = [];
const port = 52000 + Math.floor(Math.random() * 6000);
// RR_DELAY_MS=60 puts the singer "far away": everything the singer sends or receives goes through a proxy that adds that delay (+/- a third as jitter).
const DELAY = Number(process.env.RR_DELAY_MS ?? 0);
const proxies = [];
const TICKS_PER_BAR = 3840;
const PPQ = 960;

function api(c) {
  const q = (sel) => `document.querySelector('[data-testid="${sel}"]')`;
  return {
    click: (sel) => c.evalJs(`(() => { const e = ${q(sel)}; if (!e) return false; e.click(); return true; })()`),
    exists: (sel) => c.evalJs(`!!${q(sel)}`),
    text: (sel) => c.evalJs(`${q(sel)}?.textContent ?? null`),
    disabled: (sel) => c.evalJs(`${q(sel)}?.disabled ?? null`),
    type: (sel, v) => c.evalJs(`(() => { const i = ${q(sel)}; if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`),
    select: (sel, v) => c.evalJs(`(() => { const i = ${q(sel)}; if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    state: () => c.evalJs(`window.daw.live.getState()`),
    project: () => c.evalJs(`window.daw.getInitial().then((x) => x.project)`),
  };
}

/** Reads a PCM (16/24-bit) or float32 WAV into per-channel Float32Arrays. */
function readWav(file) {
  const b = fs.readFileSync(file);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString("latin1", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { tag: b.readUInt16LE(pos + 8), ch: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    if (id === "data") { data = b.subarray(pos + 8, pos + 8 + Math.min(size, b.length - pos - 8)); break; }
    pos += 8 + size + (size & 1);
  }
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.ch));
  const ch = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bytes;
      ch[c][i] = fmt.tag === 3 ? data.readFloatLE(o) : fmt.bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt16LE(o) / 32768;
    }
  return { rate: fmt.rate, ch };
}

/** The lag (in samples) at which `take` best matches `ref` (ref index = take index + lag), and how well. */
function bestLag(take, ref, from, len, range = 1500) {
  let best = { lag: 0, corr: -1 };
  let tt = 0;
  for (let i = 0; i < len; i++) tt += take[from + i] * take[from + i];
  for (let lag = -range; lag <= range; lag++) {
    let tr = 0, rr = 0;
    for (let i = 0; i < len; i++) {
      const r = ref[from + lag + i] ?? 0;
      tr += take[from + i] * r;
      rr += r * r;
    }
    const corr = tr / Math.sqrt(tt * rr + 1e-12);
    if (corr > best.corr) best = { lag, corr };
  }
  return best;
}

try {
  procs.push(launch(A, dirA, { DAW_RR_WATCH_DIR: takesA }), launch(B, dirB, { DAW_RR_WATCH_DIR: takesB }));
  const [ca, cb] = [await connect(A), await connect(B)];
  const prod = api(ca);
  const sing = api(cb);
  await until(async () => (await ca.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 20000);
  await until(async () => (await ca.evalJs(`window.daw.getLibrary()`)).status.state === "ready", 90000, 300);
  await until(async () => (await cb.evalJs(`window.daw.getLibrary()`)).status.state === "ready", 90000, 300);
  await sleep(500);
  await ca.evalJs(`window.daw.setProgressMode('all')`);

  // ---- the producer's song: a synth line with sharp, varied notes over 4 bars ----
  const ops = [];
  const pitches = [72, 76, 79, 84, 74, 77, 81, 86];
  for (let k = 0; k < 16; k++) ops.push({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: `n${k}`, pitch: pitches[k % pitches.length], startTick: k * PPQ, durationTicks: 360, velocity: 70 + (k % 5) * 12 } });
  await ca.evalJs(`window.daw.dispatchBatch(${JSON.stringify(ops)}, 'song')`);
  check("the producer has a song to sing over (16 notes)", Object.keys((await prod.project()).tracks["track-1"].clips["clip-1"].notes).length >= 16);

  // ---- the singer's microphone is the backing track's own output (test switch) ----
  await cb.evalJs(`window.__liveAudio.testLoopMic = true`);
  await sing.click("rec-button");
  await sing.click("rec-mic-on");
  check("singer: audio device opens", await until(async () => await sing.exists("rec-mic-name"), 15000).then(Boolean), await sing.text("rec-mic-name"));

  // ---- producer: vocal mode (the default), create the session ----
  await prod.click("rec-button");
  await prod.click("rec-open-producer");
  await until(() => prod.exists("rec-network"), 5000);
  check("the producer's panel offers 'the singer sings over my song' as the default", (await ca.evalJs(`document.querySelector('[data-testid="rec-mode-vocal"]').checked`)) === true);
  await prod.select("rec-network", "127.0.0.1");
  await prod.type("rec-port-in", String(port));
  await prod.click("rec-create");
  const code = await until(async () => {
    const t = await prod.text("rec-code");
    return t && /^\d{6}$/.test(t) ? t : null;
  }, 8000);
  check("producer: session created", !!code, code ?? "");
  check("producer: no microphone is needed in this mode", (await prod.text("rec-step-1-status")) === "Not needed", await prod.text("rec-step-1-status"));

  await sing.click("rec-open-performer");
  await until(() => sing.exists("rec-host-in"), 5000);
  if (DELAY > 0) for (const off of [0, 2, 3]) proxies.push(await delayProxy("127.0.0.2", port + off, "127.0.0.1", DELAY, Math.round(DELAY / 3)));
  await sing.type("rec-host-in", DELAY > 0 ? "127.0.0.2" : "127.0.0.1");
  await sing.type("rec-port-join", String(port));
  await sing.type("rec-code-in", code ?? "000000");
  await sing.click("rec-join");
  check(`both windows show 'connected'${DELAY ? ` (the singer is ${DELAY} ms away, +/- ${Math.round(DELAY / 3)} ms jitter, each way)` : ""}`, !!(await until(async () => (await sing.exists("rec-peer")) && (await prod.exists("rec-peer")), 15000)));

  // ---- the backing track is rendered, delivered and verified ----
  const delivered = await until(async () => {
    const a = await prod.state();
    const b = await sing.state();
    return a.backing.phase === "ready" && b.backing.phase === "ready" && a.snapshot.backing.offeredId && a.snapshot.backing.offeredId === b.snapshot.backing.haveId ? { a, b } : null;
  }, 90000, 250);
  check("the arrangement is rendered and the singer has the verified backing track", !!delivered, delivered ? `${delivered.a.backing.seconds.toFixed(1)} s, ${(delivered.a.backing.bytes / 1048576).toFixed(1)} MB` : `${(await prod.state()).backing.detail} / ${(await sing.state()).backing.detail}`);
  const backingId1 = delivered?.a.snapshot.backing.offeredId ?? "";

  await prod.click("rec-consent");
  await sing.click("rec-consent");
  await sing.click("rec-delivery");
  const ready = await until(async () => /Ready/.test((await prod.text("rec-step-3-status")) ?? "") && /Ready/.test((await sing.text("rec-step-3-status")) ?? ""), 20000);
  check("both sides are Ready (checklist includes 'Backing track received')", !!ready, `${await prod.text("rec-step-3-status")} / ${await sing.text("rec-step-3-status")}`);
  check("the singer's checklist shows the backing track as received", (await sing.state()).snapshot.localChecks.some((c) => c.item === 8 && c.ok));

  await shot(ca, "vocal-producer-ready");
  await shot(cb, "vocal-singer-ready");
  // ---- 1. the playhead position is the recording start position ----
  const P0 = 2 * TICKS_PER_BAR + 2 * PPQ; // bar 3, beat 3 = 5.0 s at 120 bpm
  await ca.evalJs(`window.__es0 = null; window.daw.onEngineStatus((s) => { window.__es0 = { tick: s.tick, playing: s.playing }; })`);
  await ca.evalJs(`window.daw.seek(${P0})`);
  const posText = await until(async () => { const t = await prod.text("rec-start-pos"); return t && /bar 3, beat 3/.test(t) ? t : null; }, 5000);
  check("the panel shows where Record will start (the playhead)", !!posText, posText ?? await prod.text("rec-start-pos"));
  if (!posText) console.log("DEBUG seek:", JSON.stringify(await ca.evalJs(`window.__es0`)), "state.startTick", (await prod.state()).startTick, "backing", JSON.stringify((await prod.state()).backing));

  // ---- 2. Play: the singer hears the song ----
  const heardBefore = (await cb.evalJs(`window.__liveAudio.micState.backingPlaying`)) === true;
  await ca.evalJs(`window.daw.play()`);
  const singerHears = await until(async () => (await cb.evalJs(`window.__liveAudio.micState.backingPlaying`)) === true, 6000, 50);
  check("Play: the singer's PC starts playing the song", !heardBefore && !!singerHears);
  check("Play: the singer is told it is the producer's play (producer sees 'singer hears it')", !!(await until(async () => (await prod.state()).snapshot.backing.playing === true, 4000, 100)));
  await sleep(1200);
  await ca.evalJs(`window.daw.stop()`);
  check("Stop: the singer's playback stops", !!(await until(async () => (await cb.evalJs(`window.__liveAudio.micState.backingPlaying`)) === false, 4000, 50)));

  // ---- 3 + 4. Record ----
  await ca.evalJs(`window.daw.seek(${P0})`);
  await sleep(600);
  await prod.click("rec-record");
  const rec = await until(async () => /Recording/.test((await sing.text("rec-step-3-status")) ?? "") && /Recording/.test((await prod.text("rec-step-3-status")) ?? ""), 15000);
  check("Record: both PCs are recording/playing from the playhead", !!rec);
  const singerPlaying = await until(async () => (await cb.evalJs(`window.__liveAudio.micState.backingPlaying`)) === true, 3000, 50);
  check("Record: the song plays on the singer's PC while the microphone records", !!singerPlaying);
  await sleep(4000);
  await shot(ca, "vocal-producer-recording");
  await prod.click("rec-stop");
  const done = await until(async () => {
    const a = await prod.state();
    return a.snapshot.take.peerFinalised && a.snapshot.session === 1 ? a : null;
  }, 20000);
  check("Stop: the take ends and the song stops on both PCs", !!done && (await cb.evalJs(`window.__liveAudio.micState.backingPlaying`)) === false);

  const placed = await until(async () => Object.values((await prod.project()).tracks).find((t) => t.name === "Vocal take 1"), 30000, 250);
  check("the vocal appears on its own track, 'Vocal take 1'", !!placed, await prod.text("rec-vocal-note"));
  await shot(ca, "vocal-producer-after-take");
  if (shotDir) {
    await ca.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await ca.evalJs(`document.querySelector('[data-testid=pr-close]')?.click()`);
    await sleep(800);
    await shot(ca, "vocal-producer-arrangement");
    await prod.click("rec-button");
    await sleep(300);
  }
  let take1ClipStart = -1;
  let take1Sample = "";
  if (placed) {
    const clip = Object.values(placed.clips)[0];
    take1ClipStart = clip.startTick;
    take1Sample = placed.sample.id;
    check("the clip starts exactly at the playhead position", clip.startTick === P0, `${clip.startTick} vs ${P0}`);
    check("the track plays the recording (a sample track with a clip as long as the take)", placed.instrument === "sample" && clip.lengthTicks > 3 * 2 * PPQ, `${clip.lengthTicks} ticks`);
  }

  // ---- alignment: the take must be the backing track, sample for sample ----
  const stA = await prod.state();
  const stB = await sing.state();
  const outFiles = fs.readdirSync(path.join(dirA, "user", "backing")).filter((f) => f.startsWith("out-"));
  const rendered = readWav(path.join(dirA, "user", "backing", outFiles[0]));
  const takeFile = stB.takes.find((t) => t.kind === "mine")?.file;
  check("the singer's recording is a float WAV on the singer's PC", !!takeFile && fs.existsSync(takeFile), takeFile);
  if (takeFile) {
    const take = readWav(takeFile);
    const late = stB.snapshot.take.localLateFrames;
    const offsetFrames = Math.round((stA.snapshot.take.offsetUs / 1e6) * rendered.rate);
    // take[i] = 0.8 (the singer's song volume) * backing[offset + late + i]  -> lag 0 when the start frames agree
    const ref = rendered.ch[0];
    const shifted = new Float32Array(take.ch[0].length);
    for (let i = 0; i < shifted.length; i++) shifted[i] = ref[offsetFrames + late + i] ?? 0;
    const start = Math.round(0.3 * rendered.rate);
    const win = Math.round(2.5 * rendered.rate);
    const m = bestLag(take.ch[0], shifted, start, win);
    check("ALIGNMENT: the recorded take matches the backing track from the playhead position, to the sample", m.lag === 0 && m.corr > 0.999, `lag ${m.lag} samples, correlation ${m.corr.toFixed(5)}, started ${late} frames late`);
    let maxErr = 0;
    for (let i = start; i < start + win; i++) maxErr = Math.max(maxErr, Math.abs(take.ch[0][i] - 0.8 * shifted[i]));
    check("ALIGNMENT: the samples agree (the recording is the backing track, only the singer's volume applied)", maxErr < 0.01, `largest difference ${maxErr.toExponential(2)}`);
    check("the take is a continuous recording of the right length", Math.abs(take.ch[0].length / take.rate - stA.snapshot.take.peerFrames / 48000) < 0.01 && take.ch[0].length / take.rate > 3.8, `${(take.ch[0].length / take.rate).toFixed(2)} s`);
  }

  // ---- 5. more takes never overwrite earlier ones ----
  const before = await prod.project();
  const tracksBefore = Object.keys(before.tracks).length;
  await ca.evalJs(`window.__es = null; window.daw.onEngineStatus((s) => { window.__es = { tick: s.tick, playing: s.playing }; })`);
  await ca.evalJs(`window.daw.seek(0)`);
  await sleep(600);
  console.log("DEBUG engine before take 2:", JSON.stringify(await ca.evalJs(`window.__es`)), "startTick shown:", await prod.text("rec-start-pos"));
  await prod.click("rec-record");
  await until(async () => /Recording/.test((await prod.text("rec-step-3-status")) ?? ""), 15000);
  await sleep(2500);
  await prod.click("rec-stop");
  const placed2 = await until(async () => Object.values((await prod.project()).tracks).find((t) => t.name === "Vocal take 2"), 30000, 250);
  if (!placed2) {
    const d = await prod.state();
    const sd = await sing.state();
    console.log("DEBUG singer transfers", JSON.stringify(sd.snapshot.transfers.map((t) => [t.takeId, t.state, t.detail, t.connections])), "| singer history", sd.history.slice(-14).join(" || "));
    console.log("DEBUG msg:", await prod.text("rec-message"), "| session", d.snapshot.session, "| take", JSON.stringify({ id: d.snapshot.take.takeId, fin: d.snapshot.take.peerFinalised, st: d.snapshot.take.peerStarted }), "| transfers", JSON.stringify(d.snapshot.transfers.map((t) => [t.takeId, t.state, t.detail])), "| history", d.history.slice(-12).join(" || "));
  }
  const after = await prod.project();
  check("a second take goes on a new track and the first is untouched", !!placed2 && Object.keys(after.tracks).length === tracksBefore + 1 && Object.values(after.tracks).find((t) => t.name === "Vocal take 1").sample.id === take1Sample && Object.values(Object.values(after.tracks).find((t) => t.name === "Vocal take 1").clips)[0].startTick === take1ClipStart);
  if (placed2) check("take 2 starts where its own playhead was (bar 1)", Object.values(placed2.clips)[0].startTick === 0, `${Object.values(placed2.clips)[0].startTick}`);
  check("recording vocals did not make the producer re-render the backing track", (await prod.state()).snapshot.backing.offeredId === backingId1);

  // ---- replay: the producer hears everything, the singer still hears only the song ----
  await ca.evalJs(`window.__lv = 0; window.daw.onEngineStatus((s) => { for (const v of Object.values(s.levels)) window.__lv = Math.max(window.__lv, v); })`);
  await ca.evalJs(`window.daw.seek(${P0})`);
  await ca.evalJs(`window.daw.play()`);
  await sleep(2200);
  check("replay: the singer hears the song during the producer's Play", (await cb.evalJs(`window.__liveAudio.micState.backingPlaying`)) === true);
  await ca.evalJs(`window.daw.stop()`);

  // ---- changing the arrangement refreshes the backing track ----
  await ca.evalJs(`window.daw.dispatchBatch(${JSON.stringify([{ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "late", pitch: 60, startTick: 7 * PPQ + 480, durationTicks: 240, velocity: 100 } }])}, 'edit')`);
  check("the extra note was accepted", Object.keys((await prod.project()).tracks["track-1"].clips["clip-1"].notes).length >= 17);
  const stale = await until(async () => (await prod.state()).backing.stale === true, 5000, 100);
  check("changing the arrangement marks the backing track as out of date", !!stale);
  await prod.click("rec-record");
  const refused = await until(async () => /updated|moment|not ready/i.test((await prod.text("rec-message")) ?? ""), 3000, 100);
  check("Record is refused while the backing track is out of date, with a plain reason", !!refused, await prod.text("rec-message"));
  const refreshed = await until(async () => {
    const a = await prod.state();
    const b = await sing.state();
    return a.backing.phase === "ready" && !a.backing.stale && a.snapshot.backing.offeredId !== backingId1 && b.snapshot.backing.haveId === a.snapshot.backing.offeredId ? a : null;
  }, 90000, 250);
  check("the new backing track is rendered and delivered, and the singer is ready again", !!refreshed);

  // ---- the project is saved with the vocal tracks ----
  await ca.evalJs(`window.daw.getInitial()`);
  await sleep(1500);
  killTree(procs[0]); // close the producer's DAW
  await sleep(1500);
  const again = launch(9344, dirA, { DAW_RR_WATCH_DIR: takesA });
  procs.push(again);
  const c2 = await connect(9344);
  await until(async () => (await c2.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 20000);
  const reopened = await c2.evalJs(`window.daw.getInitial().then((x) => x.project)`);
  const names = Object.values(reopened.tracks).map((t) => t.name);
  check("saving: after closing and reopening the DAW the vocal take tracks are still in the project", names.includes("Vocal take 1") && names.includes("Vocal take 2"), names.join(", "));
  const t1 = Object.values(reopened.tracks).find((t) => t.name === "Vocal take 1");
  check("saving: the take is still on the same position with the same recording", !!t1 && Object.values(t1.clips)[0].startTick === P0 && t1.sample.id === take1Sample);
} catch (e) {
  check("no unexpected error", false, String(e?.stack ?? e));
} finally {
  for (const p of procs) killTree(p);
  proxies.forEach((p) => p.close());
  await sleep(500);
  rmDir(dirA);
  rmDir(dirB);
  finish();
}
