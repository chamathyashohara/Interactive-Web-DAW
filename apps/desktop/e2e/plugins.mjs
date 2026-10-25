// Plugin tracks in the UI: pick an installed VST3 from "+ Add track > Plugin", see it load, survive its host process being killed.
// Needs a real VST3 instrument; uses Diva if it is installed and skips (exit 0) otherwise.
// Usage: node apps/desktop/e2e/plugins.mjs   (build the app and the engine first)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const DIVA = "C:\\Program Files\\Common Files\\VST3\\Diva(x64).vst3";
if (!fs.existsSync(DIVA)) {
  console.log("SKIP  Diva is not installed here, so there is no plugin to load");
  process.exit(0);
}

const { check, finish } = makeReporter();
const PORT = 9360;
const dataDir = tmpDataDir("daw-plugins-");
// DAW_PLUGINHOST_TWEAK stands in for a person turning a knob in the plugin window: when the window opens, the host moves the Transpose parameter.
const child = launch(PORT, dataDir, { DAW_PLUGINHOST_TWEAK: "Transpose" });
const c = await connect(PORT);
const ev = c.evalJs;
const badge = () => ev(`document.querySelector('[data-testid^="plugin-badge-"]')?.getAttribute('data-plugin-state') ?? null`);
const readWav = (file) => {
  const b = fs.readFileSync(file);
  let p = 12, ch = 2, bits = 24, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString("latin1", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") (ch = b.readUInt16LE(p + 10), bits = b.readUInt16LE(p + 22));
    if (id === "data") data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  const bytes = bits / 8, n = Math.floor(data.length / (bytes * ch));
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = data.readIntLE(i * ch * bytes, bytes) / 2 ** (bits - 1);
  return mono;
};
const rmsOf = (x, f = (v) => v) => { let e = 0; for (let i = 0; i < x.length; i++) e += f(x[i], i) ** 2; return Math.sqrt(e / Math.max(1, x.length)); };
const diffRms = (a, b) => { const n = Math.min(a.length, b.length); return rmsOf(new Float32Array(n).map((_, i) => a[i] - b[i])); };
let exN = 0;
const render = async () => {
  await ev(`window.__ex = []; window.daw.onExportStatus((x) => window.__ex.push(x));`);
  const file = path.join(dataDir, `plugin${++exN}.wav`);
  await ev(`window.daw.exportWav(${JSON.stringify(file)}, { tailSeconds: 0 })`);
  const done = await until(() => ev(`(window.__ex || []).find((x) => x.state === 'done' || x.state === 'error') || null`), 90000, 200);
  if (done?.state !== "done") throw new Error("export failed " + JSON.stringify(done));
  return readWav(file);
};
const pluginTrack = () => ev(`window.daw.getInitial().then(i => { const t = Object.values(i.project.tracks).find(t => t.instrument === 'plugin'); return t ? { id: t.id, clip: Object.keys(t.clips)[0], plugin: t.plugin } : null; })`);
const waitState = (s, ms = 60000) => until(async () => (await badge()) === s, ms, 250);

try {
  await until(() => ev(`!!document.querySelector('[data-testid="add-track"]')`), 20000);
  check("the host reports it can load VST3", (await ev(`window.daw.plugins.list().then(i => i.hostAvailable && i.vst3)`)) === true);
  check("VST2 is reported unsupported in this build", (await ev(`window.daw.plugins.list().then(i => i.vst2)`)) === false);

  await c.clickEl('[data-testid="add-track"]');
  await c.clickEl('[data-testid="add-plugin"]');
  const listed = await until(() => ev(`[...document.querySelectorAll('[data-testid="plugin-entry"]')].some(b => /Diva/.test(b.textContent))`), 5000);
  check("the scanned plugins appear in the menu (Diva)", !!listed);
  check("the menu offers browse and scan-folder", (await ev(`!!document.querySelector('[data-testid="plugin-browse"]') && !!document.querySelector('[data-testid="plugin-scan-folder"]')`)) === true);

  const bad = await ev(`window.daw.plugins.browse('C:\\\\nowhere\\\\notes.txt')`);
  check("browsing to a file that is not a plugin is refused", bad.ok === false && /not a plugin/i.test(bad.reason ?? ""));
  const picked = await ev(`window.daw.plugins.browse(${JSON.stringify(DIVA)})`);
  check("browsing to a plugin file returns its entry", picked.ok === true && picked.entry?.format === "vst3");

  const before = await ev(`document.querySelectorAll('[data-testid="track-row"]').length`);
  const idx = await ev(`[...document.querySelectorAll('[data-testid="plugin-entry"]')].findIndex(b => /Diva/.test(b.textContent))`);
  await c.clickEl('[data-testid="plugin-entry"]', idx);
  check("choosing a plugin adds a track", !!(await until(async () => (await ev(`document.querySelectorAll('[data-testid="track-row"]').length`)) === before + 1, 5000)));
  check("the track is labelled PLG", (await ev(`[...document.querySelectorAll('[data-testid="track-row"]')].some(r => /PLG/.test(r.textContent))`)) === true);
  const project = await ev(`window.daw.getInitial().then(i => { const t = Object.values(i.project.tracks).find(t => t.instrument === 'plugin'); return t ? { name: t.name, plugin: t.plugin } : null; })`);
  check("the project stores the plugin path and name", project?.plugin?.id === DIVA && /Diva/.test(project.plugin.name), JSON.stringify(project?.plugin));

  check("the plugin loads (badge reaches ready)", !!(await waitState("ready")), `state ${await badge()}`);

  // ---- changing the plugin's sound in its own window, and keeping it ----
  const pt = await pluginTrack();
  check("a fresh plugin track has no saved settings yet", !pt.plugin.state);
  await ev(`window.daw.dispatch({ type: "setSongLength", bars: 2 })`);
  await ev(`window.daw.dispatch({ type: "addNote", trackId: ${JSON.stringify(pt.id)}, clipId: ${JSON.stringify(pt.clip)}, note: { id: "n1", pitch: 60, startTick: 0, durationTicks: 3840, velocity: 100 } })`);
  await sleep(500);
  const before1 = await render();
  const before2 = await render();
  check("the plugin track is audible in the export", rmsOf(before1) > 0.005, `rms ${rmsOf(before1).toFixed(4)}`);
  const noise = diffRms(before1, before2) / rmsOf(before1);

  const edit = await ev(`window.daw.plugins.openEditor(${JSON.stringify(pt.id)})`);
  check("the Edit button is offered on a loaded plugin track", (await ev(`!document.querySelector('[data-testid="plugin-edit-${pt.id}"]')?.disabled`)) === true);
  check("asking for the plugin window is accepted", edit.ok === true, JSON.stringify(edit));
  const titles = await until(() => {
    const out = execFileSync("tasklist", ["/V", "/FO", "CSV", "/FI", "IMAGENAME eq daw_pluginhost.exe"]).toString();
    return /Diva/i.test(out.split(/\r?\n/).slice(1).join(" ")) ? out : null; // the first line is the column headings
  }, 15000, 300);
  check("the plugin's own window opens (a window titled Diva belongs to the host process)", !!titles);
  const saved = await until(async () => (await pluginTrack())?.plugin?.state, 15000, 200);
  check("a change made in the window is saved into the project", !!saved && saved.length > 100, `state ${saved ? saved.length : 0} chars`);
  const afterTrack = await pluginTrack();
  check("the saved settings keep the plugin's path and name", afterTrack.plugin.id === DIVA && /Diva/.test(afterTrack.plugin.name));
  await sleep(300);
  const after = await render();
  const change = diffRms(before1, after) / rmsOf(before1);
  check("the export plays the changed sound, not the original", change > 3 * Math.max(noise, 0.02), `change ${change.toFixed(2)} vs run-to-run ${noise.toFixed(3)}`);

  // The sound the plugin reports is not a user edit: the first undo takes back the NOTE (the last thing the user did), not the sound.
  const stateBeforeUndo = (await pluginTrack()).plugin.state;
  await c.ctrl("z");
  await until(async () => (await ev(`window.daw.getInitial().then(i => Object.keys(Object.values(i.project.tracks).find(t => t.instrument === 'plugin').clips[${JSON.stringify(pt.clip)}].notes).length)`)) === 0, 5000);
  const afterUndo = await pluginTrack();
  check("undo takes back the note and leaves the plugin's saved sound alone", !!afterUndo.plugin.state && afterUndo.plugin.state === stateBeforeUndo, `${afterUndo.plugin.state?.length} chars vs ${stateBeforeUndo?.length}`);

  // The plugin runs in its own process: kill it and the DAW must stay up and bring it back.
  execFileSync("taskkill", ["/F", "/IM", "daw_pluginhost.exe"], { stdio: "ignore" });
  check("killing the plugin host leaves the window responsive", (await ev(`1 + 1`)) === 2);
  const restarted = await until(async () => (await badge()) !== "ready", 15000, 100);
  check("the badge shows the plugin dropped", !!restarted, `state ${await badge()}`);
  check("the host is restarted and the plugin is ready again", !!(await waitState("ready")), `state ${await badge()}`);

  for (let i = 0; i < 4; i++) {
    if ((await ev(`document.querySelectorAll('[data-testid="track-row"]').length`)) === before) break;
    await c.ctrl("z");
    await sleep(300);
  }
  check("undo removes the plugin track", (await ev(`document.querySelectorAll('[data-testid="track-row"]').length`)) === before);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  killTree(child);
  rmDir(dataDir);
}
finish();
