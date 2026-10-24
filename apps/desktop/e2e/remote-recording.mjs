// End-to-end check of remote recording inside the DAW: TWO real DAW windows (a Producer and a Singer) on this PC, each with Chromium's
// fake microphone, driven over the DevTools protocol. They create/join a session, record a coordinated take, exchange live talkback (real
// Opus over UDP) and the producer receives a verified copy of the singer's take.
//   node apps/desktop/e2e/remote-recording.mjs        (build first: npx electron-vite build)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const A = 9331;
const B = 9332;
const dirA = tmpDataDir("daw-rr-prod-");
const dirB = tmpDataDir("daw-rr-sing-");
const takesA = path.join(dirA, "takes");
const takesB = path.join(dirB, "takes");
const procs = [];

const env = (takes) => ({ DAW_FAKE_MIC: "1", DAW_RR_WATCH_DIR: takes });
const port = 52000 + Math.floor(Math.random() * 6000);

// RR_SHOT_DIR=<folder> saves screenshots of both windows at key moments.
const shotDir = process.env.RR_SHOT_DIR;
async function shot(c, name) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(r.result.data, "base64"));
}

function api(c) {
  const q = (sel) => `document.querySelector('[data-testid="${sel}"]')`;
  return {
    click: (sel) => c.evalJs(`(() => { const e = ${q(sel)}; if (!e) return false; e.click(); return true; })()`),
    exists: (sel) => c.evalJs(`!!${q(sel)}`),
    text: (sel) => c.evalJs(`${q(sel)}?.textContent ?? null`),
    disabled: (sel) => c.evalJs(`${q(sel)}?.disabled ?? null`),
    checked: (sel) => c.evalJs(`${q(sel)}?.checked ?? null`),
    type: (sel, v) => c.evalJs(`(() => { const i = ${q(sel)}; if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`),
    select: (sel, v) => c.evalJs(`(() => { const i = ${q(sel)}; if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    count: (sel) => c.evalJs(`document.querySelectorAll('[data-testid="${sel}"]').length`),
    state: () => c.evalJs(`window.daw.live.getState()`),
  };
}

try {
  procs.push(launch(A, dirA, env(takesA)), launch(B, dirB, env(takesB)));
  const [ca, cb] = [await connect(A), await connect(B)];
  const prod = api(ca);
  const sing = api(cb);
  await sleep(1500);

  // ---- microphones (Chromium's fake device) ----
  for (const [who, w, c] of [["producer", prod, ca], ["singer", sing, cb]]) {
    await w.click("rec-button");
    await until(() => w.exists("rec-popover"), 5000);
    await w.click("rec-mic-on");
    const on = await until(async () => (await w.exists("rec-mic-name")) || (await w.exists("rec-mic-error")), 15000);
    const open = await w.exists("rec-mic-name");
    check(`${who}: microphone opens inside the DAW window`, open, open ? await w.text("rec-mic-name") : await w.text("rec-mic-error"));
    void on; void c;
  }

  // ---- producer creates the session on the loopback address ----
  await prod.click("rec-open-producer");
  await until(() => prod.exists("rec-network"), 5000);
  await prod.click("rec-mode-both"); // this test is about the original mode: each PC records its own microphone
  await prod.select("rec-network", "127.0.0.1");
  await prod.type("rec-port-in", String(port));
  await prod.click("rec-create");
  const code = await until(async () => {
    const t = await prod.text("rec-code");
    return t && /^\d{6}$/.test(t) ? t : null;
  }, 8000);
  check("producer: a session is created and its pairing code shown", !!code, code ?? "");

  // ---- singer joins ----
  await sing.click("rec-open-performer");
  await until(() => sing.exists("rec-host-in"), 5000);
  await sing.type("rec-host-in", "127.0.0.1");
  await sing.type("rec-port-join", String(port));
  await sing.type("rec-code-in", code ?? "000000");
  await sing.click("rec-join");
  const joined = await until(async () => (await sing.exists("rec-peer")) && (await prod.exists("rec-peer")), 15000);
  check("both windows show 'connected'", !!joined, await prod.text("rec-peer"));

  // ---- a wrong code is refused with a plain reason (a third window is not needed: check the state after leaving) ----
  // ---- consent and readiness ----
  await prod.click("rec-consent");
  await sing.click("rec-consent");
  await sing.click("rec-delivery");
  const ready = await until(async () => /Ready/.test((await prod.text("rec-step-3-status")) ?? "") && /Ready/.test((await sing.text("rec-step-3-status")) ?? ""), 20000);
  check("both sides become Ready after consent (checklist green)", !!ready, `${await prod.text("rec-step-3-status")} / ${await sing.text("rec-step-3-status")}`);
  check("the producer's Record button is enabled", (await prod.disabled("rec-record")) === false);
  await shot(ca, "producer-ready");
  await shot(cb, "singer-ready");

  // ---- talkback: real Opus over UDP in both directions ----
  await prod.click("rec-talk");
  await sing.click("rec-talk");
  const talked = await until(async () => {
    const a = (await prod.state()).media?.audioReceived ?? 0;
    const b = (await sing.state()).media?.audioReceived ?? 0;
    return a > 20 && b > 20 ? { a, b } : null;
  }, 15000);
  check("talkback: Opus packets flow both ways (encoded and decoded by the windows)", !!talked, JSON.stringify(talked));
  await until(async () => ((await prod.state()).media?.remoteReport.received ?? 0) > 0, 8000);
  const ps = await prod.state();
  check("talkback: the receiver reports reach the sender", !!ps.media?.hasRemoteReport && ps.media.remoteReport.received > 0, JSON.stringify(ps.media?.remoteReport ?? {}).slice(0, 120));
  const played = await until(async () => {
    const n = await ca.evalJs(`Number(document.querySelector('[data-testid="rec-talk-stats"]')?.dataset.played ?? 0)`);
    return n > 4800 ? n : null;
  }, 8000);
  check("talkback: the other person's voice reaches the speakers (decoded Opus frames played)", !!played, `${played} frames`);
  check("talkback: no packet was rejected as invalid", (ps.media?.invalidTotal ?? 1) === 0 && ((await sing.state()).media?.invalidTotal ?? 1) === 0);

  // ---- a coordinated take ----
  await prod.click("rec-record");
  const recording = await until(async () => /Recording/.test((await prod.text("rec-step-3-status")) ?? "") && /Recording/.test((await sing.text("rec-step-3-status")) ?? ""), 15000);
  check("Record starts a take on both PCs", !!recording, `${await prod.text("rec-step-3-status")} / ${await sing.text("rec-step-3-status")}`);
  await sleep(3000);
  await shot(ca, "producer-recording");
  await prod.click("rec-stop");
  const done = await until(async () => {
    const a = await prod.state();
    const b = await sing.state();
    return a.snapshot?.take.peerFinalised && a.snapshot?.take.localFinalised && b.snapshot?.take.localFinalised ? { a, b } : null;
  }, 20000);
  check("Stop ends the take on both PCs and both report finalised", !!done);
  if (done) {
    const t = done.a.snapshot.take;
    check("the producer estimated the difference between the two starts", t.hasStartOffset && Math.abs(t.startOffsetMs) < 100, `${t.startOffsetMs?.toFixed(3)} ms ± ${t.startOffsetUncMs?.toFixed(3)} ms`);
    const mineA = done.a.takes.find((x) => x.kind === "mine");
    const mineB = done.b.takes.find((x) => x.kind === "mine");
    check("each PC wrote its own master WAV", !!mineA && !!mineB && fs.existsSync(mineA.file) && fs.existsSync(mineB.file), `${mineA?.file}`);
    if (mineA && mineB) {
      for (const [who, f] of [["producer", mineA.file], ["singer", mineB.file]]) {
        const buf = fs.readFileSync(f);
        const fmt = buf.readUInt16LE(20);
        const rate = buf.readUInt32LE(24);
        const secs = (buf.length - 58) / 4 / rate;
        let peak = 0;
        for (let i = 58; i + 4 <= buf.length; i += 4) peak = Math.max(peak, Math.abs(buf.readFloatLE(i)));
        check(`${who}'s file: float32 mono ${rate} Hz, about 3 s, with sound in it`, fmt === 3 && rate === 48000 && secs > 2.5 && secs < 4.5 && peak > 0.001, `${secs.toFixed(2)} s, peak ${peak.toFixed(3)}`);
      }
      const dA = done.a.snapshot.take.localFrames;
      const dB = done.a.snapshot.take.peerFrames;
      check("the two takes have almost the same length", Math.abs(dA - dB) < 48000 * 0.1, `${dA} vs ${dB} frames`);
    }
  }

  // ---- verified copy of the singer's take ----
  const copy = await until(async () => (await prod.state()).takes.find((x) => x.kind === "singer-copy"), 25000);
  check("the producer receives a VERIFIED copy of the singer's take automatically", !!copy, copy?.file);
  if (copy) {
    const b = await sing.state();
    const original = b.takes.find((x) => x.kind === "mine").file;
    const h = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    check("the copy is byte-identical to the singer's original", h(copy.file) === h(original));
    check("the singer's original is unchanged and the singer's PC shows VERIFIED", await until(async () => (await sing.state()).snapshot.transfers.some((x) => x.state === "verified" && x.sourceUnchanged), 8000).then(Boolean));
    check("the copy is in the producer's own folder, not the singer's", copy.file.startsWith(takesA) && original.startsWith(takesB));
  }

  await sleep(1500);
  await shot(ca, "producer-after-take");
  await shot(cb, "singer-after-take");

  // ---- the takes can be put into the project (needs the audio engine) ----
  const engine = await ca.evalJs(`window.daw.getInitial().then(s => s.engine.connected)`);
  if (engine) {
    await prod.click("rec-add-take");
    const added = await until(async () => /Added/.test((await prod.text("rec-message")) ?? ""), 20000);
    check("Add to project puts the take on a new track", !!added, await prod.text("rec-message"));
    await ca.evalJs(`window.__lv = 0; window.daw.onEngineStatus((s) => { for (const v of Object.values(s.levels)) window.__lv = Math.max(window.__lv, v); })`);
    await ca.evalJs(`window.daw.play()`);
    const heard = await until(async () => (await ca.evalJs(`window.__lv`)) > 0.02, 8000, 150);
    await ca.evalJs(`window.daw.stop()`);
    check("the DAW's engine plays the recorded take (float32 WAV from the in-app recorder)", !!heard, String(await ca.evalJs(`window.__lv`)));
  } else {
    console.log("SKIP  Add to project (the audio engine is not built here)");
  }

  // ---- leaving ----
  await sing.click("rec-leave");
  const left = await until(async () => (await sing.state()).role === null, 8000);
  check("the singer can leave; the session ends cleanly", !!left);
  await until(async () => !(await prod.exists("rec-peer")), 10000);
} catch (e) {
  check("no unexpected error", false, String(e?.stack ?? e));
} finally {
  for (const p of procs) killTree(p);
  await sleep(500);
  rmDir(dirA);
  rmDir(dirB);
  finish();
}
