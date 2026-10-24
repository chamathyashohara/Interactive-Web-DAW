// End-to-end M1 acceptance checks. Launches the built app (run `npm run build -w apps/desktop` first),
// drives it with real mouse/keyboard events over the Chrome DevTools Protocol and asserts results.
// Usage: node apps/desktop/e2e/run.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const electronExe = path.resolve(appDir, "../../node_modules/electron/dist/electron.exe");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "daw-e2e-"));
const PORT = 9333;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(step);
  }
  return null;
}

function launch() {
  const child = spawn(electronExe, [appDir, `--remote-debugging-port=${PORT}`], {
    env: (() => { const e = { ...process.env, DAW_DATA_DIR: dataDir, DAW_PROGRESS_DIR: dataDir, DAW_LIBRARY_DIR: path.join(dataDir, "library"), DAW_STARTER_DIR: path.join(os.tmpdir(), "daw-e2e-starter"), DAW_USER_DATA: path.join(dataDir, "user"), DAW_E2E: "1" }; delete e.ELECTRON_RUN_AS_NODE; return e; })(),
    stdio: ["ignore", "ignore", "inherit"],
  });
  return child;
}

async function connect() {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    return list.find((t) => t.type === "page" && t.url.includes("index.html"));
  }, 20000);
  if (!target) throw new Error("no renderer target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra });
  const click = async (x, y) => { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
  const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: code ?? k }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: code ?? k }); };
  return { ws, send, evalJs, mouse, click, key };
}

const gridInfo = (c) => c.evalJs(`(() => { const r = document.querySelector('[data-testid=grid]').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
const noteCount = (c) => c.evalJs(`document.querySelectorAll('[data-note-id]').length`);
const chip = (c) => c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`);
const diag = (c) => c.evalJs(`document.querySelector('[data-testid=diag]')?.textContent ?? ''`);
const diagNum = async (c, label) => { const m = (await diag(c)).match(new RegExp(label + " (\\d+)")); return m ? Number(m[1]) : NaN; };
const clickButton = (c, text) => c.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)})); b?.click(); return !!b; })()`);
const playheadLeft = (c) => c.evalJs(`(() => { const el = document.querySelector('.bg-amber-300'); return el ? parseFloat(el.style.left) : -1; })()`);

let child = launch();
let c = await connect();
try {
  // 1. engine connects
  const connected = await until(async () => (await chip(c)).includes("Engine connected"), 15000);
  check("1. UI shows 'Engine connected' shortly after launch", !!connected);
  await c.evalJs(`window.daw.dispatch({ type: "setSongLength", bars: 4 })`); // M1 checks assume a 4-bar loop

  // 2. draw tool adds a note on the grid; keyboard key preview does not throw
  const g = await gridInfo(c);
  const X = (beat) => g.left + (beat * 120) + 4; // default zoom 120 px/beat
  const Y = (row) => g.top + row * 18 + 9; // row 0 = pitch 83
  await c.click(X(0), Y(20));
  const n1 = await until(async () => (await noteCount(c)) === 1);
  check("2a. clicking the grid with the Draw tool adds a note", !!n1);

  // 2b. delete with Delete tool: key E then click the note
  await c.key("e", "KeyE");
  await c.click(X(0) + 10, Y(20));
  const gone = await until(async () => (await noteCount(c)) === 0);
  check("2b. Delete tool removes a note", !!gone);
  await c.key("d", "KeyD");

  // 14. snap: draw at an off-grid x, note start must be on a 1/16 boundary (30 px = 1/16 at 120 px/beat)
  await c.click(X(1) + 11, Y(18));
  await until(async () => (await noteCount(c)) === 1);
  const left = await c.evalJs(`parseFloat(document.querySelector('[data-note-id]').style.left)`);
  check("14. snap on: note lands on grid (1/16 = 30 px)", Math.abs(left % 30) < 0.01 || Math.abs((left % 30) - 30) < 0.01, `left=${left}px`);

  // 15/13. select tool: move and resize a note by dragging, velocity lane drag
  await c.key("s", "KeyS");
  const noteBox = () => c.evalJs(`(() => { const r = document.querySelector('[data-note-id]').getBoundingClientRect(); const s = document.querySelector('[data-note-id]').style; return { x: r.left, y: r.top, w: r.width, h: r.height, left: parseFloat(s.left), top: parseFloat(s.top) }; })()`);
  const nb = await noteBox();
  await c.mouse("mouseMoved", nb.x + 8, nb.y + 8, { buttons: 0 });
  await c.mouse("mousePressed", nb.x + 8, nb.y + 8);
  await c.mouse("mouseMoved", nb.x + 8 + 60, nb.y + 8 - 36);
  await c.mouse("mouseReleased", nb.x + 8 + 60, nb.y + 8 - 36);
  await sleep(300);
  const nb2 = await noteBox();
  check("13a. Select tool: drag moves a note in time (+60 px = 1/8) and up 2 semitones", Math.abs(nb2.left - nb.left - 60) < 1 && Math.abs(nb.top - nb2.top - 36) < 1, `left ${nb.left}->${nb2.left}, top ${nb.top}->${nb2.top}`);
  await c.mouse("mouseMoved", nb2.x + nb2.w - 2, nb2.y - 36 + 9, { buttons: 0 });
  const nb2b = await noteBox();
  await c.mouse("mousePressed", nb2b.x + nb2b.w - 2, nb2b.y + 9);
  await c.mouse("mouseMoved", nb2b.x + nb2b.w - 2 + 60, nb2b.y + 9);
  await c.mouse("mouseReleased", nb2b.x + nb2b.w - 2 + 60, nb2b.y + 9);
  await sleep(300);
  const nb3 = await noteBox();
  check("13b. dragging the right edge resizes a note by 60 px", Math.abs(nb3.w - nb2b.w - 60) < 1, `width ${nb2b.w}->${nb3.w}`);
  const vel = await c.evalJs(`(() => { const r = document.querySelector('[data-vel-id]').getBoundingClientRect(); return { x: r.left + 3, top: r.top, bottom: r.bottom, h: r.height }; })()`);
  await c.mouse("mouseMoved", vel.x, vel.top + 2, { buttons: 0 });
  await c.mouse("mousePressed", vel.x, vel.top + 2);
  await c.mouse("mouseMoved", vel.x, vel.bottom - 10);
  await c.mouse("mouseReleased", vel.x, vel.bottom - 10);
  await sleep(300);
  const velAfter = await c.evalJs(`document.querySelector('[data-vel-id]').title`);
  check("13c. velocity lane drag changes the note velocity", velAfter !== "velocity 96", velAfter);
  await c.key("d", "KeyD");
  await send_ctrl(c, "z"); await send_ctrl(c, "z"); await send_ctrl(c, "z");
  await until(async () => (await c.evalJs(`document.querySelector('[data-note-id]')?.style.left`)) === `${nb.left}px`);
  check("16b. three undos restore the original note position", (await noteBox()).left === nb.left);

  // 3. play: playhead moves; callbacks increase
  await clickButton(c, "Play");
  const cb0 = await diagNum(c, "callbacks");
  const ph0 = await playheadLeft(c);
  await sleep(1500);
  const cb1 = await diagNum(c, "callbacks");
  const ph1 = await playheadLeft(c);
  check("3. playback runs: audio callbacks advance and playhead moves", cb1 > cb0 && ph1 !== ph0, `callbacks ${cb0}->${cb1}, playhead ${ph0.toFixed(0)}->${ph1.toFixed(0)}px`);

  // 4. tempo change during playback
  await c.evalJs(`(() => { const i = document.querySelector('input[aria-label=Tempo]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '180'); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); })()`);
  await c.key("Enter", "Enter");
  const t180 = await until(async () => (await c.evalJs(`document.querySelector('input[aria-label=Tempo]').value`)) === "180");
  const stillPlaying = !!(await until(async () => (await diagNum(c, "callbacks")) > cb1 + 10, 3000));
  check("4. tempo change applies while playing (no stop)", !!t180 && stillPlaying, `input=${await c.evalJs(`document.querySelector('input[aria-label=Tempo]').value`)}, callbacks ${cb1}->${await diagNum(c, "callbacks")}`);

  // 5. add a note during playback (UI stays responsive, state updates)
  await c.click(X(5), Y(22));
  const n2 = await until(async () => (await noteCount(c)) === 2);
  check("5. note added during playback", !!n2);

  // 7. isolation: freeze the renderer for 500 ms; engine overruns must stay 0
  const before = await diagNum(c, "overruns");
  await c.evalJs(`(() => { const t = performance.now(); while (performance.now() - t < 500) {} return 1; })()`);
  await sleep(600);
  const cbAfter = await diagNum(c, "callbacks");
  const after = await diagNum(c, "overruns");
  check("7. renderer blocked 500 ms: engine overruns remain 0 and callbacks continue", before === 0 && after === 0 && cbAfter > cb1, `overruns ${before}->${after}`);

  // 16. undo / redo
  await c.key("z", "KeyZ"); // no modifier => should do nothing
  const countNoMod = await noteCount(c);
  await send_ctrl(c, "z");
  const undone = await until(async () => (await noteCount(c)) === 1);
  await send_ctrl(c, "y");
  const redone = await until(async () => (await noteCount(c)) === 2);
  check("16. Ctrl+Z / Ctrl+Y undo and redo a note add", countNoMod === 2 && !!undone && !!redone);

  // 10. kill the engine; it restarts and the project is re-sent
  await c.evalJs(`window.daw.killEngine()`);
  const down = await until(async () => (await chip(c)).includes("disconnected"), 4000);
  const back = await until(async () => (await chip(c)).includes("Engine connected"), 6000);
  check("10. engine killed -> UI shows disconnected, then reconnects within ~3-6 s", !!down && !!back);
  await clickButton(c, "Play");
  const cb2 = await diagNum(c, "callbacks");
  await sleep(800);
  const cb3 = await diagNum(c, "callbacks");
  check("10b. playback works again after engine restart", cb3 > cb2);
  await clickButton(c, "Stop");

  // 9. recovery after a hard kill of the whole app
  const notesBefore = await noteCount(c);
  c.ws.close();
  execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  await sleep(1500);
  child = launch();
  c = await connect();
  await until(async () => (await noteCount(c)) > 0, 15000);
  const notesAfter = await noteCount(c);
  const tempoAfter = await c.evalJs(`document.querySelector('input[aria-label=Tempo]')?.value`);
  check("9. force-killed app: notes and tempo are restored on relaunch", notesBefore === 2 && notesAfter === 2 && tempoAfter === "180", `notes ${notesBefore}->${notesAfter}, tempo ${tempoAfter}`);
} catch (e) {
  check("e2e run completed without exception", false, String(e));
} finally {
  try { c.ws.close(); } catch {}
  try { execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
}

async function send_ctrl(client, k) {
  const code = "Key" + k.toUpperCase();
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers: 2, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers: 2, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
