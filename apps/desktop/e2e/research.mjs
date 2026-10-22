// Study recording: consent, what is recorded, locked-control attempts, export and the analysis script, withdrawal.
// Usage: node apps/desktop/e2e/research.mjs   (build the app first: npm run build -w apps/desktop)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const PORT = 9344;
const dataDir = tmpDataDir("daw-research-");
const child = launch(PORT, dataDir);
const c = await connect(PORT);

const state = () => c.evalJs(`window.daw.telemetry.getState()`);
const dispatch = (op) => c.evalJs(`window.daw.dispatch(${JSON.stringify(op)})`);
const eventsFile = path.join(dataDir, "research-events.ndjson");
const events = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const exists = (sel) => c.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const setValue = (sel, v) => c.evalJs(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const openFeatures = async () => {
  if (!(await exists("[data-testid=features-panel]"))) await c.clickEl("[data-testid=features-toggle]");
  await sleep(300);
};

try {
  await until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
  await c.evalJs(`window.daw.setProgressMode('all')`);

  // ---------- before consent ----------
  await dispatch({ type: "setKey", key: { tonic: 0, mode: "major" } });
  await c.clickEl("[data-tool=paint]");
  await sleep(300);
  check("R1. nothing is recorded before the participant agrees", events().length === 0 && (await state()).events === 0 && !(await state()).consented);
  await openFeatures();
  check("R2. the Features panel shows the consent text, and Start is off until they tick the box and type a code", (await exists("[data-testid=research-agree]")) && (await c.evalJs(`document.querySelector('[data-testid=research-start]').disabled`)) === true);
  await c.clickEl("[data-testid=research-agree]");
  await setValue("[data-testid=research-code]", "Maria P");
  await sleep(200);
  await c.clickEl("[data-testid=research-start]");
  await sleep(400);
  check("R3. a code that looks like a name is refused with a message", !(await state()).consented && /not a name/.test(await c.evalJs(`document.querySelector('[data-testid=research-message]')?.textContent ?? ''`)));
  await setValue("[data-testid=research-code]", "P07");
  await sleep(200);
  await c.clickEl("[data-testid=research-start]");
  await sleep(500);
  const st = await state();
  check("R4. with a proper code recording starts, and the status bar shows it", st.consented && st.participantCode === "P07" && (await exists("[data-testid=recording-chip]")), JSON.stringify(st));
  check("R5. the study panel now shows the code and an event count", /P07/.test(await c.evalJs(`document.querySelector('[data-testid=research-state]')?.textContent ?? ''`)));
  await c.clickEl("[data-testid=features-toggle]"); // close the panel so it does not cover the toolbar
  await sleep(300);

  // ---------- what gets recorded ----------
  await dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "ok1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 } });
  await sleep(200);
  await dispatch({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "bad1", pitch: 61, startTick: 480, durationTicks: 480, velocity: 100 } });
  await sleep(1200);
  await c.clickEl("[data-tool=select]");
  await c.clickEl("[data-testid=mixer-toggle]");
  await sleep(300);
  await c.clickEl("[data-testid=key-fix]"); // the red note is moved into the key by the Fix button
  await sleep(600);
  await c.evalJs(`window.daw.undo()`);
  await sleep(300);
  const ev = events();
  const names = ev.map((e) => e.t);
  check("R6. edits are recorded as kinds and counts (edit, note.added, history)", names.includes("edit") && names.filter((t) => t === "note.added").length === 2 && names.includes("history"));
  check("R7. each note is recorded only as in the key or not (C is in C major, C# is not)", JSON.stringify(ev.filter((e) => e.t === "note.added").map((e) => e.inKey)) === "[true,false]");
  const fix = ev.find((e) => e.t === "note.corrected");
  check("R8. pressing Fix on the red note records how long it waited and that the Fix button did it", !!fix && fix.via === "fix" && fix.ms >= 1000 && fix.ms < 60000, JSON.stringify(fix));
  check("R9. tools and panels are recorded as interface events", ev.some((e) => e.t === "ui.tool" && e.tool === "select") && ev.some((e) => e.t === "ui.panel" && e.panel === "mixer" && e.open === true));
  check("R10. every event has the session and the condition (beginner or all)", ev.every((e) => typeof e.s === "string" && (e.mode === "all" || e.mode === "beginner") && typeof e.at === "number"));
  const raw = fs.readFileSync(eventsFile, "utf8");
  check("R11. the log holds no song content: no pitch or position values, no track or clip names", !/"(pitch|startTick|durationTicks|velocity)":|track-1|clip-1|Synth|"60"|"61"/.test(raw));

  // ---------- locked controls ----------
  await c.evalJs(`window.daw.setProgressMode('beginner')`);
  await c.evalJs(`window.daw.resetProgress()`);
  await sleep(500);
  await c.clickEl("[data-testid=loop-toggle]"); // locked until M8.2
  await sleep(400);
  check("R12. pressing a locked control records which lesson it is waiting for", events().some((e) => e.t === "ui.locked" && e.lesson === "M8.2"), JSON.stringify(events().filter((e) => e.t === "ui.locked")));
  await c.evalJs(`window.daw.completeLesson('M8.2')`);
  await sleep(400);
  await dispatch({ type: "setLoop", loop: { startTick: 0, endTick: 3840 } });
  await sleep(300);

  // ---------- export ----------
  const jsonPath = path.join(dataDir, "study-P07.json");
  await openFeatures();
  const r = await c.evalJs(`window.daw.telemetry.export('json', ${JSON.stringify(jsonPath)})`);
  const bundle = r.ok ? JSON.parse(fs.readFileSync(jsonPath, "utf8")) : null;
  check("R13. JSON export has the participant, every event and the computed numbers", !!bundle && bundle.participant === "P07" && bundle.events.length >= 10 && !!bundle.metrics, r.reason ?? `${bundle?.events.length} events`);
  const m = bundle?.metrics;
  check("R14. the numbers are right: 2 notes, 1 outside the key, 1 corrected, 1 locked attempt, lesson M8.2 done", m?.notesAdded === 2 && m?.outOfKeyNotes === 1 && m?.corrected === 1 && m?.lockedAttempts === 1 && m?.lessonsCompleted.join() === "M8.2", JSON.stringify({ n: m?.notesAdded, bad: m?.outOfKeyNotes, fixed: m?.corrected, locked: m?.lockedAttempts, lessons: m?.lessonsCompleted }));
  check("R15. lesson events are merged into the timeline, and the study condition changed to beginner", bundle?.events.some((e) => e.t === "lesson.completed" && e.lessonId === "M8.2") && bundle?.events.some((e) => e.mode === "beginner") && !!m?.byMode.all);
  const loopUse = m?.adoption.find((a) => a.feature === "arrangement.loop");
  check("R16. adoption: the loop region was used a moment after lesson M8.2 unlocked it", !!loopUse && loopUse.latencyMs !== null && loopUse.latencyMs < 5000, JSON.stringify(loopUse));
  const csvBase = path.join(dataDir, "study-P07");
  const rc = await c.evalJs(`window.daw.telemetry.export('csv', ${JSON.stringify(csvBase + ".csv")})`);
  const eventsCsv = fs.existsSync(`${csvBase}-events.csv`) ? fs.readFileSync(`${csvBase}-events.csv`, "utf8") : "";
  const metricsCsv = fs.existsSync(`${csvBase}-metrics.csv`) ? fs.readFileSync(`${csvBase}-metrics.csv`, "utf8") : "";
  check("R17. CSV export writes an events file and a metrics file", rc.ok && eventsCsv.split("\n")[0].startsWith("at,iso,s,mode,t") && metricsCsv.includes("out_of_key_notes,1"));
  let analysis = "";
  try {
    analysis = execFileSync("node", [path.resolve("../../scripts/analyze-telemetry.mjs"), jsonPath], { encoding: "utf8" });
  } catch (e) {
    analysis = String(e);
  }
  check("R18. the analysis script turns the exports into a results table", analysis.split("\n")[0].startsWith("participant,") && analysis.includes("P07,") && analysis.includes("arrangement.loop"), analysis.split("\n").slice(0, 3).join(" | ").slice(0, 160));

  // ---------- restart keeps consent; withdrawal erases ----------
  const before = (await state()).events;
  check("R19. the event count grows as the participant works", before >= 10, String(before));
  await openFeatures();
  await c.clickEl("[data-testid=research-withdraw]");
  await sleep(200);
  await c.clickEl("[data-testid=research-delete]");
  await sleep(500);
  check("R20. Stop and delete erases everything recorded and the recording indicator disappears", !(await state()).consented && (await state()).events === 0 && events().length === 0 && !(await exists("[data-testid=recording-chip]")));
  await c.clickEl("[data-tool=draw]");
  await sleep(300);
  check("R21. after stopping, nothing more is recorded", events().length === 0);
} catch (e) {
  check("research run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  killTree(child);
  rmDir(dataDir);
}
finish();
