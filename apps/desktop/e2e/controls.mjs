// The hardware-style controls (faders, knobs, LED meters) driven with the real mouse.
// Usage: node apps/desktop/e2e/controls.mjs   (build the app first: npm run build -w apps/desktop)
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9342;
const dataDir = tmpDataDir("daw-controls-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);
const track = async () => (await c.evalJs(`window.daw.getInitial().then(x => x.project)`)).tracks["track-1"];

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  if (!(await c.evalJs(`!!document.querySelector('[data-testid=mixer]')`))) await c.clickEl("[data-testid=mixer-toggle]");
  await sleep(400);
  const strip = '[data-testid=mixer-strip][data-track-id="track-1"]';
  const faderSel = `${strip} .hw-fader`;
  const f = await c.rectOf(faderSel);

  // fader: press the top of the slot, then drag to the bottom
  await c.click(f.cx, f.y + 12);
  await sleep(250);
  check("F1. pressing near the top of the fader puts the volume near the maximum", (await track()).volume >= 90, String((await track()).volume));
  await c.drag(f.cx, f.y + 12, f.cx, f.y + f.h - 8, 8);
  await sleep(300);
  const low = (await track()).volume;
  check("F2. dragging the cap down turns the volume down", low <= 12, String(low));
  await c.drag(f.cx, f.y + f.h - 16, f.cx, f.y + f.h / 2, 6);
  await sleep(300);
  const mid = (await track()).volume;
  check("F3. dragging it back up raises it again", mid > low + 25 && mid < 80, `${low} -> ${mid}`);
  const capTop = await c.evalJs(`document.querySelector(${JSON.stringify(faderSel + " .hw-fader-cap")}).getBoundingClientRect().top`);
  const capShould = f.y + (1 - mid / 100) * (f.h - 32);
  check("F4. the cap is drawn where the value says (full travel mapped onto the slot)", Math.abs(capTop - capShould) < 2, `cap ${capTop.toFixed(1)} vs ${capShould.toFixed(1)}`);
  await c.dblclick(f.cx, capTop + 16);
  await sleep(300);

  // knob (pan): drag up = right, double-click = centre
  const k = await c.rectOf(`${strip} .hw-knob`);
  await c.drag(k.cx, k.cy, k.cx, k.cy - 70, 7);
  await sleep(300);
  const pan1 = (await track()).pan;
  check("K1. dragging the pan knob up turns it to the right", pan1 > 30, String(pan1));
  await c.dblclick(k.cx, k.cy);
  await sleep(300);
  check("K2. double-clicking the knob centres it", (await track()).pan === 0);
  check("K3. the printed label follows (C)", (await c.evalJs(`document.querySelector(${JSON.stringify(strip + " [data-testid=pan-label]")}).textContent`)) === "C");

  // keyboard still works through the real input inside the control
  await c.evalJs(`document.querySelector('[aria-label="Pan of Synth"]').focus()`);
  await c.key("ArrowRight", "ArrowRight");
  await sleep(300);
  check("K4. the control stays keyboard accessible (arrow key nudges the pan)", (await track()).pan === 1, String((await track()).pan));

  // LED meter lights while playing
  await c.evalJs(`window.daw.dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "m1", pitch: 60, startTick: 0, durationTicks: 3000, velocity: 110 } })`);
  await c.evalJs(`window.daw.dispatch({ type: "updateTrack", trackId: "track-1", changes: { volume: 90 } })`);
  await c.evalJs(`window.daw.play()`);
  await sleep(700);
  const lit = await c.evalJs(`(() => { const m = document.querySelector('[data-testid=meter-track-1] .hw-led-lit'); return m ? m.style.clipPath : null; })()`);
  await c.evalJs(`window.daw.stop()`);
  check("M1. the LED meter lights up while the track plays", !!lit && !/inset\(100%/.test(lit), String(lit));
} catch (e) {
  check("controls run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
