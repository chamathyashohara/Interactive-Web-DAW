// Gesture playing, end to end: play notes with a hand, with help from the project's key that fades as the learner improves.
// The camera and the tracking model are replaced by a test feed of hand landmarks, so this checks everything after them: the panel, the
// scale help, the fading, recording into the clip, and what happens when the key or the hand goes away. The real camera and model are
// checked by gesture-camera.mjs.
// Usage: node apps/desktop/e2e/gesture.mjs   (build the app first: npm run build -w apps/desktop)
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9396;
const dataDir = tmpDataDir("daw-gesture-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);
const ev = c.evalJs;

const project = () => ev(`window.daw.getInitial().then((x) => x.project)`);
const notes = async () => Object.values((await project()).tracks["track-1"].clips["clip-1"].notes).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
const attr = (sel, a) => ev(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)})`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const has = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const chooseLevel = (v) => ev(`(() => { const s = document.querySelector('[data-testid="gesture-level"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(v)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

try {
  await until(async () => (await text('[data-testid=engine-chip]')).includes("Engine connected"), 15000);
  await ev(`window.daw.setProgressMode('all')`);
  // the test feed: a hand whose palm is at the height of a pitch (range C4-C6), pinched or open
  await ev(`(() => {
    window.__yFor = (pitch) => 0.88 - ((pitch - 60) / 24) * 0.76;
    window.__hand = (pitch, pinched, t) => {
      const y = window.__yFor(pitch);
      const l = Array.from({ length: 21 }, () => ({ x: 0.5, y }));
      l[0] = { x: 0.5, y: y + 0.1 };
      for (const i of [5, 9, 13, 17]) l[i] = { x: 0.4 + i * 0.01, y: y - 0.025 };
      l[4] = { x: 0.3, y: y - 0.1 };
      l[8] = { x: pinched ? 0.31 : 0.4, y: y - 0.1 };
      return { t, landmarks: l };
    };
    window.__t = 1000;
    // one note: the hand settles on the pitch, pinches, and opens again
    window.__note = (pitch) => {
      const f = window.__gestureTest.feed;
      for (let i = 0; i < 14; i++) f(window.__hand(pitch, false, (window.__t += 33)));
      for (let i = 0; i < 4; i++) f(window.__hand(pitch, true, (window.__t += 33)));
      for (let i = 0; i < 4; i++) f(window.__hand(pitch, false, (window.__t += 33)));
    };
  })()`);
  await ev(`window.__gestureUseTestSource = true`);
  // the study recording: nothing is written before consent, and with it every gesture event must reach the export
  await ev(`window.daw.telemetry.consent("P-TEST-01")`);

  check("the Hand button is on the piano roll of a melodic track", await has('[data-testid="pr-hand"]'));
  await ev(`window.daw.dispatch({ type: "setKey", key: { tonic: 2, mode: "minor" } })`); // D minor: D E F G A Bb C
  await sleep(200);
  await c.clickEl('[data-testid="pr-hand"]');
  check("it opens the hand play panel, with the camera off and a privacy note", (await has('[data-testid="gesture-panel"]')) && /not saved or sent/.test(await text('[data-testid="gesture-panel"]')) && (await attr('[data-testid="gesture-status"]', "data-phase")) === "idle");
  check("the panel says which key it follows", /D minor/.test(await text('[data-testid="gesture-key"]')), await text('[data-testid="gesture-key"]'));
  await c.clickEl('[data-testid="gesture-start"]');
  check("starting brings the tracking up", !!(await until(async () => (await attr('[data-testid="gesture-status"]', "data-phase")) === "running", 8000)));

  // ---------- full help: a hand between two scale notes plays a scale note ----------
  await chooseLevel("full");
  await sleep(100);
  check("choosing a fixed level shows it", (await attr('[data-testid="gesture-status"]', "data-level")) === "full" && /fixed/.test(await text('[data-testid="gesture-status"]')));
  await c.clickEl('[data-testid="gesture-record"]');
  await ev(`window.daw.play()`);
  await sleep(500);
  await ev(`window.__note(61)`); // C#4 is not in D minor; C (60) and D (62) are: tie goes to the lower
  await ev(`window.__note(63)`); // D#4: between D and E
  await sleep(300);
  let n = await notes();
  check("full help: a hand on notes outside the key records scale notes", n.length === 2 && n[0].pitch === 60 && n[1].pitch === 62, JSON.stringify(n.map((x) => x.pitch)));
  check("the notes are placed on the grid, inside the clip", n.every((x) => x.startTick % 240 === 0 && x.durationTicks % 240 === 0 && x.durationTicks >= 240 && x.startTick + x.durationTicks <= 15360));
  check("the panel counts what was played and recorded", (await attr('[data-testid="gesture-status"]', "data-notes")) === "2" && (await attr('[data-testid="gesture-status"]', "data-recorded")) === "2");
  check("it reports the hand's own accuracy, not the helped result", /0 of the last 2/.test(await text('[data-testid="gesture-accuracy"]')), await text('[data-testid="gesture-accuracy"]'));

  // ---------- guide only: nothing is changed ----------
  await chooseLevel("guide");
  await sleep(100);
  await ev(`window.__note(66)`); // F#4: not in D minor
  await sleep(300);
  n = await notes();
  check("guide only: the outside note is played as it was, not corrected", n.some((x) => x.pitch === 66), JSON.stringify(n.map((x) => x.pitch)));

  // ---------- soft help: pulled toward the scale, but an outside note is still reachable ----------
  await chooseLevel("soft");
  await sleep(100);
  await ev(`window.__note(61.7)`);
  await ev(`window.__note(63)`); // exactly between D and E
  await sleep(300);
  n = await notes();
  const soft = n.slice(-2).map((x) => x.pitch);
  check("soft help: near a scale note it is pulled in (61.7 -> D), midway between two it can stay outside (D#)", soft[0] === 62 && soft[1] === 63, JSON.stringify(soft));

  // ---------- automatic: help fades when the hand is on scale notes, and returns when it is not ----------
  await chooseLevel("full");
  await chooseLevel("auto");
  await sleep(100);
  check("automatic starts from the level it was on (full help)", (await attr('[data-testid="gesture-status"]', "data-level")) === "full");
  for (const p of [62, 64, 65, 67, 69, 70, 72, 74, 76, 77, 79, 81]) await ev(`window.__note(${p})`); // 12 notes of D minor with no help needed
  await sleep(200);
  check("automatic: after 12 notes on the scale the help is reduced by itself", (await attr('[data-testid="gesture-status"]', "data-level")) === "soft" && /Less help/.test(await text('[data-testid="gesture-message"]')), `${await attr('[data-testid="gesture-status"]', "data-level")} / ${await text('[data-testid="gesture-message"]')}`);
  for (const p of [61, 63, 66, 68, 71, 73, 75, 78, 80, 61, 63, 66]) await ev(`window.__note(${p})`); // 12 notes outside the scale
  await sleep(200);
  check("automatic: after 12 notes outside the scale some help comes back", (await attr('[data-testid="gesture-status"]', "data-level")) === "full" && /More help/.test(await text('[data-testid="gesture-message"]')), `${await attr('[data-testid="gesture-status"]', "data-level")} / ${await text('[data-testid="gesture-message"]')}`);

  // ---------- losing the hand while a note is held ends the note ----------
  const before = (await notes()).length;
  await ev(`(() => { const f = window.__gestureTest.feed; for (let i = 0; i < 14; i++) f(window.__hand(67, false, (window.__t += 33))); for (let i = 0; i < 4; i++) f(window.__hand(67, true, (window.__t += 33))); })()`);
  await sleep(100);
  check("a held note is not recorded until it ends", (await notes()).length === before);
  await ev(`(async () => { for (let i = 0; i < 12; i++) { window.__gestureTest.feed(null); await new Promise((r) => setTimeout(r, 30)); } })()`);
  check("losing the hand ends the held note, which is then recorded", (await until(async () => (await notes()).length === before + 1, 3000)) !== null);

  // ---------- no key: nothing to follow ----------
  await ev(`window.daw.dispatch({ type: "setKey", key: null })`);
  await sleep(300);
  check("with no key the panel says so", /No key is set/.test(await text('[data-testid="gesture-key"]')));
  const afterKey = (await notes()).length;
  await ev(`window.__note(61)`);
  await sleep(300);
  check("with no key the hand's note is played exactly", (await notes()).length === afterKey + 1 && (await notes()).some((x) => x.pitch === 61));

  // ---------- recording off: playing does not change the song ----------
  await c.clickEl('[data-testid="gesture-record"]');
  const quiet = (await notes()).length;
  await ev(`window.__note(65)`);
  await sleep(300);
  check("with Record off the notes are played but not added", (await notes()).length === quiet);

  // ---------- range ----------
  const rangeBefore = await text('[data-testid="gesture-range"]');
  await c.clickEl('[data-testid="gesture-oct-up"]');
  const rangeAfter = await text('[data-testid="gesture-range"]');
  check("the range shows its octaves and moves up one (C4-C6 to C5-C7)", rangeBefore === "C4–C6" && rangeAfter === "C5–C7", `${rangeBefore} -> ${rangeAfter}`);

  // ---------- the study data ----------
  const file = path.join(dataDir, "study.json");
  await ev(`window.daw.telemetry.export("json", ${JSON.stringify(file)})`);
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  const g = bundle.events.filter((e) => String(e.t).startsWith("ui.gesture."));
  const noteEvents = g.filter((e) => e.t === "ui.gesture.note");
  check("the study export has a gesture event for every note played (2 + 1 + 2 + 24 + 1 + 1 + 1 = 32)", noteEvents.length === 32 && g.some((e) => e.t === "ui.gesture.session" && e.action === "start"), `${noteEvents.length} note events`);
  check("each note event says what the hand did and what was played", noteEvents.every((e) => typeof e.raw === "number" && typeof e.played === "number" && typeof e.level === "string" && typeof e.heldMs === "number" && typeof e.recorded === "boolean") && noteEvents.some((e) => e.rawInKey === false && e.playedInKey === true && e.snapped === true));
  const changes = g.filter((e) => e.t === "ui.gesture.level");
  check("the automatic level changes are recorded with the accuracy that caused them", changes.length === 2 && changes[0].from === "full" && changes[0].to === "soft" && changes[0].rate === 1 && changes[1].to === "full" && changes[1].rate === 0, JSON.stringify(changes.map((e) => `${e.from}->${e.to} ${e.rate}`)));
  const modes = g.filter((e) => e.t === "ui.gesture.mode").map((e) => e.assist).join();
  check("the levels chosen are recorded in order", modes === "full,guide,soft,full,auto", modes);

  // ---------- closing ----------
  await ev(`window.daw.stop()`);
  await c.clickEl('[data-testid="gesture-close"]');
  check("closing the panel turns the camera off (the test feed is gone)", !(await has('[data-testid="gesture-panel"]')) && (await ev(`window.__gestureTest === undefined`)));
} catch (e) {
  check("the gesture scenarios ran without an unexpected error", false, String(e?.stack ?? e));
} finally {
  killTree(child);
  rmDir(dataDir);
}
finish();
