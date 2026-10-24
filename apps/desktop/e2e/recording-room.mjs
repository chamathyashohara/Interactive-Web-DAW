// Carrying the collaboration room into remote recording: when the Producer creates a recording session while in a same-network
// collaboration room, its address, port and pairing code are shared with the room automatically; a Singer (who may join later) sees
// "<Producer> is recording" and joins with one click, with nothing to type.
// Usage: node apps/desktop/e2e/recording-room.mjs (build the desktop app first). Needs a network address on this PC (Wi-Fi or cable).
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const hostDir = tmpDataDir("daw-recroom-host-");
const joinDir = tmpDataDir("daw-recroom-join-");
const hostChild = launch(9361, hostDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: `${hostDir}\\projects` });
const joinChild = launch(9362, joinDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: `${joinDir}\\projects` });

const collabState = (c) => c.evalJs(`window.daw.collab.getState()`);
const ready = (c) => until(async () => c.evalJs(`!!document.querySelector('[data-testid=rec-button]')`), 20000);
const q = (c, sel) => c.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (c, sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const click = (c, testid) => c.evalJs(`(() => { const e = document.querySelector('[data-testid=${testid}]'); if (!e) return false; e.click(); return true; })()`);
const setInput = (c, testid, value) =>
  c.evalJs(`(() => { const el = document.querySelector('[data-testid=${testid}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const setSelect = (c, testid, value) =>
  c.evalJs(`(() => { const el = document.querySelector('[data-testid=${testid}]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const openPanel = async (c) => {
  if (!(await q(c, "[data-testid=rec-popover]"))) {
    await click(c, "rec-button");
    await sleep(250);
  }
};

let host, join;
try {
  host = await connect(9361);
  join = await connect(9362);
  await ready(host);
  await ready(join);

  const hosted = await host.evalJs(`window.daw.collab.host("Ana")`);
  await until(async () => (await collabState(host)).status === "connected", 8000);
  const st = await collabState(host);
  check("RR1. a hosted session is a same-network (LAN) session and knows this PC's address", st.lan === true && /^\d+\.\d+\.\d+\.\d+$/.test(st.lanIp ?? ""), JSON.stringify({ lan: st.lan, ip: st.lanIp }));

  // the Singer is already in the room, but nothing is being recorded yet
  const port = hosted.address.split(":").pop();
  const joined = await join.evalJs(`window.daw.collab.join("127.0.0.1:${port}", ${JSON.stringify(hosted.code)}, "Ben")`);
  check("RR2. the Singer joins the collaboration room", joined.ok, JSON.stringify(joined));
  await until(async () => (await collabState(join)).status === "connected", 8000);
  await openPanel(join);
  await click(join, "rec-open-performer");
  await sleep(300);
  check("RR3. before a recording session exists, the Singer's panel offers no room link", !(await q(join, "[data-testid=rec-room-link]")));

  // the Producer creates the session on the room's network address: no typing, no extra button
  await openPanel(host);
  await click(host, "rec-open-producer");
  const offered = await until(async () => host.evalJs(`[...document.querySelectorAll('[data-testid=rec-network] option')].map((o) => o.value)`).then((l) => l.includes(st.lanIp)), 6000);
  check("RR4. this PC's room address is offered as the network to use", !!offered);
  if (offered) {
    await setSelect(host, "rec-network", st.lanIp);
    await setInput(host, "rec-port-in", "52" + String(100 + Math.floor(Math.random() * 800)));
    await click(host, "rec-create");
    const code = await until(async () => {
      const t = await text(host, "[data-testid=rec-code]");
      return /^\d{6}$/.test(t) ? t : null;
    }, 8000);
    check("RR5. the Producer's session is created and the panel says it is shared with the room", !!code && (await text(host, "[data-testid=rec-session]")).includes("shared with everyone"), code || "");

    check("RR6. the Singer sees who is recording, with a one-click join", await until(async () => await q(join, "[data-testid=rec-room-join]"), 8000));
    check("RR7. the card names the Producer", (await text(join, "[data-testid=rec-room-link]")).includes("Ana"));
    await click(join, "rec-room-join");
    const connected = await until(async () => (await q(host, "[data-testid=rec-peer]")) && (await q(join, "[data-testid=rec-peer]")), 15000);
    check("RR8. clicking it joins the recording session (nothing was typed)", !!connected, await text(host, "[data-testid=rec-peer]"));

    // a new pairing code shows on the Producer's panel
    const before = await text(host, "[data-testid=rec-code]");
    await click(host, "rec-new-code");
    check("RR9. a new pairing code replaces the old one on the Producer's panel", await until(async () => (await text(host, "[data-testid=rec-code]")) !== before, 5000));

    // ending the recording session takes the link down
    await click(host, "rec-leave");
    await until(async () => !(await q(host, "[data-testid=rec-session]")), 8000);
    check("RR10. when the Producer leaves, the room link disappears", await until(async () => !(await q(join, "[data-testid=rec-room-link]")), 8000));
  }
} catch (e) {
  check("recording-room run completed without exception", false, String(e));
} finally {
  try { host?.ws.close(); } catch {}
  try { join?.ws.close(); } catch {}
  killTree(hostChild);
  killTree(joinChild);
  await sleep(500);
  rmDir(hostDir);
  rmDir(joinDir);
}
finish();
