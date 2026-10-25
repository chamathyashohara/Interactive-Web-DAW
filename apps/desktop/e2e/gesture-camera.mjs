// The real thing, with a recorded camera: Chromium's fake camera plays a video file of a hand, and the real tracking model (MediaPipe,
// running in the app's window) has to find the hand and drive the panel. This checks the part gesture.mjs replaces with a test feed:
// the camera permission, the model and WebAssembly files served by the app, the tracking itself, and how long it takes per frame.
// Usage: node apps/desktop/e2e/gesture-camera.mjs <video.y4m|video.mjpeg>   (a clip of one hand in front of the camera, 15+ s)
// With no file it skips (exit 0): there is no hand video in the repository on purpose.
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const video = process.argv[2] ?? process.env.DAW_FAKE_VIDEO;
if (!video || !fs.existsSync(video)) {
  console.log("SKIP  give a video of a hand (.y4m or .mjpeg) as the first argument to test the real camera path");
  process.exit(0);
}

const { check, finish } = makeReporter();
const PORT = 9397;
const dataDir = tmpDataDir("daw-gesture-cam-");
const child = launch(PORT, dataDir, { DAW_FAKE_MIC: "1", DAW_FAKE_VIDEO: video });
const c = await connect(PORT);
const ev = c.evalJs;
const attr = (sel, a) => ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)})`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);

try {
  await until(async () => (await text('[data-testid=engine-chip]')).includes("Engine connected"), 15000);
  await ev(`window.daw.setProgressMode('all')`);
  await ev(`window.daw.dispatch({ type: "setKey", key: { tonic: 0, mode: "major" } })`);
  await c.clickEl('[data-testid="pr-hand"]');
  await c.clickEl('[data-testid="gesture-start"]');
  const up = await until(async () => (await attr('[data-testid="gesture-status"]', "data-phase")) === "running" || (await has()) , 60000, 250);
  async function has() {
    return (await ev(`!!document.querySelector('[data-testid="gesture-error"]')`)) ? "error" : null;
  }
  const phase = await attr('[data-testid="gesture-status"]', "data-phase");
  check("the real tracking model loads from the app's own files and the fake camera starts", phase === "running", `${phase}: ${await text('[data-testid="gesture-error"]')}`);
  if (phase === "running") {
    // sample the panel for a while: how often a hand is seen, how long a frame takes, whether a pinch is ever read
    let seen = 0, pinched = 0, samples = 0, maxInfer = 0;
    const inferSamples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      samples++;
      if ((await attr('[data-testid="gesture-status"]', "data-hand")) === "yes") seen++;
      if ((await attr('[data-testid="gesture-status"]', "data-pinched")) === "yes") pinched++;
      const ms = Number(await attr('[data-testid="gesture-status"]', "data-infer-ms"));
      if (ms > 0) { inferSamples.push(ms); maxInfer = Math.max(maxInfer, ms); }
      await sleep(100);
    }
    const mean = inferSamples.length ? inferSamples.reduce((a, b) => a + b, 0) / inferSamples.length : 0;
    const handMs = Number(await attr('[data-testid="gesture-status"]', "data-infer-hand-ms"));
    const noHandMs = Number(await attr('[data-testid="gesture-status"]', "data-infer-nohand-ms"));
    const frames = Number(await attr('[data-testid="gesture-status"]', "data-frames")), handFrames = Number(await attr('[data-testid="gesture-status"]', "data-hand-frames"));
    console.log(`INFO  the model processed ${frames} frames and found a hand in ${handFrames} of them`);
    if (seen / samples <= 0.4) {
      const shot = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.TEMP ?? ".", "gesture-camera-fail.png"), Buffer.from(shot.result.data, "base64"));
    }
    check("the model finds the hand in the video", seen / samples > 0.4, `hand seen in ${seen} of ${samples} samples (${Math.round((100 * seen) / samples)}%)`);
    console.log(`INFO  tracking took about ${mean.toFixed(1)} ms a frame overall (${handMs} ms when following a hand, ${noHandMs} ms when looking for one; largest average seen ${maxInfer} ms); a pinch was read in ${pinched} samples; notes played: ${await attr('[data-testid="gesture-status"]', "data-notes")}; running on the ${await attr('[data-testid="gesture-status"]', "data-delegate")}`);
    check("while following a hand, tracking keeps up with at least 20 frames a second (under 50 ms a frame)", handMs > 0 && handMs < 50, `${handMs} ms following a hand, ${noHandMs} ms looking for one`);
    const painted = await ev(`(() => { const cv = document.querySelector('[data-testid="gesture-panel"] canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true; return false; })()`);
    check("the hand skeleton is drawn over the picture", painted === true || (await attr('[data-testid="gesture-status"]', "data-hand")) !== "yes");
    await c.clickEl('[data-testid="gesture-stop"]');
    check("stopping releases the camera", (await attr('[data-testid="gesture-status"]', "data-phase")) === "idle" && (await ev(`document.querySelector('[data-testid="gesture-video"]').srcObject === null`)));
  }
} catch (e) {
  check("the camera scenario ran without an unexpected error", false, String(e?.stack ?? e));
} finally {
  killTree(child);
  rmDir(dataDir);
}
finish();
