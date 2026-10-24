// Shared helpers for the end-to-end scripts: launch the built app, drive it over the Chrome DevTools Protocol.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(here, "..");
export const electronExe = path.resolve(appDir, "../../node_modules/electron/dist/electron.exe");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, timeout = 8000, step = 100) {
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

export function makeReporter() {
  const results = [];
  return {
    check(name, ok, detail = "") {
      results.push({ name, ok });
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed`);
      process.exit(failed ? 1 : 0);
    },
  };
}

export const tmpDataDir = (prefix = "daw-e2e-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// Electron may still hold files in its profile folder for a moment after it is killed; leftovers in the temp folder are harmless.
export const rmDir = (d) => {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
};

/** The generated Starter packs are the same every run, so all test launches share one copy (made on first use, about 6 s). */
export const starterCache = path.join(os.tmpdir(), "daw-e2e-starter");

export function launch(port, dataDir, extraEnv = {}) {
  // ELECTRON_RUN_AS_NODE (set by some hosts) would make Electron run as plain Node and break the app.
  const env = { ...process.env, DAW_DATA_DIR: dataDir, DAW_PROGRESS_DIR: dataDir, DAW_LIBRARY_DIR: path.join(dataDir, "library"), DAW_STARTER_DIR: starterCache, DAW_USER_DATA: path.join(dataDir, "user"), DAW_E2E: "1", ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [k, v] of Object.entries(extraEnv)) if (v === null) delete env[k]; // allow a test to unset a default (e.g. DAW_DATA_DIR for workspace mode)
  // DAW_E2E_EXE: run the tests against a packaged build (release/win-unpacked/Collab DAW.exe) instead of Electron + the source folder.
  const args = process.env.DAW_E2E_EXE ? [`--remote-debugging-port=${port}`] : [appDir, `--remote-debugging-port=${port}`];
  return spawn(process.env.DAW_E2E_EXE || electronExe, args, {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
}
export function killTree(child) {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  } catch {}
}

export async function connect(port) {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
  // A taller virtual viewport so both the arrangement and the piano roll have room (the real window is resizable).
  await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra });
  const click = async (x, y, extra = {}) => { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y, extra); await mouse("mouseReleased", x, y, extra); };
  const drag = async (x0, y0, x1, y1, steps = 6, extra = {}) => {
    await mouse("mouseMoved", x0, y0, { buttons: 0 });
    await mouse("mousePressed", x0, y0, extra);
    for (let i = 1; i <= steps; i++) await mouse("mouseMoved", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, extra);
    await mouse("mouseReleased", x1, y1, extra);
  };
  const dblclick = async (x, y) => {
    await mouse("mouseMoved", x, y, { buttons: 0 });
    await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y);
    await mouse("mousePressed", x, y, { clickCount: 2 }); await mouse("mouseReleased", x, y, { clickCount: 2 });
  };
  const key = async (k, code, modifiers = 0) => {
    const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : undefined;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: code ?? k, modifiers, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: code ?? k, modifiers, windowsVirtualKeyCode: vk });
  };
  const ctrl = (k) => key(k, "Key" + k.toUpperCase(), 2);
  const insertText = (text) => send("Input.insertText", { text });
  const rectOf = (selector, index = 0) => evalJs(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
  const clickEl = async (selector, index = 0) => {
    const r = await rectOf(selector, index);
    if (!r) throw new Error("element not found: " + selector);
    await click(r.cx, r.cy);
  };
  const setRange = (selector, value) =>
    evalJs(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(String(value))}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  return { ws, send, evalJs, mouse, click, drag, dblclick, key, ctrl, insertText, rectOf, clickEl, setRange };
}
