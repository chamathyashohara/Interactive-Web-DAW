// Carrying the collaboration room into Live recording: the Producer shares the recording session's address, port and
// pairing code with the room; a Singer (who may join later) sees it and can copy it into Performer Client.
// Usage: node apps/desktop/e2e/recording-room.mjs (build the desktop app first).
import { connect, killTree, launch, makeReporter, rmDir, sleep, tmpDataDir, until } from "./lib.mjs";

const { check, finish } = makeReporter();
const hostDir = tmpDataDir("daw-recroom-host-");
const joinDir = tmpDataDir("daw-recroom-join-");
const hostChild = launch(9361, hostDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: `${hostDir}\\projects` });
const joinChild = launch(9362, joinDir, { DAW_DATA_DIR: null, DAW_PROJECTS_DIR: `${joinDir}\\projects` });

const collabState = (c) => c.evalJs(`window.daw.collab.getState()`);
const ready = (c) => until(async () => (await c.evalJs(`document.querySelector('[data-testid=engine-chip]')?.textContent ?? ''`)).includes("Engine connected"), 15000);
const q = (c, sel) => c.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (c, sel) => c.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const setInput = (c, testid, value) =>
  c.evalJs(`(() => { const el = document.querySelector('[data-testid=${testid}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const openPanel = async (c) => {
  if (!(await q(c, "[data-testid=rec-popover]"))) {
    await c.evalJs(`document.querySelector('[data-testid=rec-button]').click()`);
    await sleep(200);
  }
};

let host, join;
try {
  host = await connect(9361);
  join = await connect(9362);
  await ready(host);
  await ready(join);

  // not in a session: no room section
  await openPanel(host);
  check("RR1. outside a session the tab shows no room section", !(await q(host, "[data-testid=rec-room]")) && !(await q(host, "[data-testid=rec-room-online]")));

  const hosted = await host.evalJs(`window.daw.collab.host("Ana")`);
  await until(async () => (await collabState(host)).status === "connected", 8000);
  const st = await collabState(host);
  check("RR2. a hosted session is a same-network (LAN) session and knows this PC's address", st.lan === true && /^\d+\.\d+\.\d+\.\d+$/.test(st.lanIp ?? ""), JSON.stringify({ lan: st.lan, ip: st.lanIp }));

  // the Producer shares before the Singer arrives
  await openPanel(host);
  check("RR3. in a LAN session the tab offers to share the recording session with the room", await until(async () => await q(host, "[data-testid=rec-share]"), 4000));
  await setInput(host, "rec-share-code", "12ab34cd56"); // letters are stripped: only digits
  await setInput(host, "rec-share-port", "52000");
  await sleep(100);
  check("RR4. the pairing code box accepts digits only", (await host.evalJs(`document.querySelector('[data-testid=rec-share-code]').value`)) === "123456");
  await host.evalJs(`document.querySelector('[data-testid=rec-share]').click()`);
  await sleep(300);
  check("RR5. after sharing, the Producer sees that they are sharing and can stop", await q(host, "[data-testid=rec-unshare]"));

  const port = hosted.address.split(":").pop();
  const joined = await join.evalJs(`window.daw.collab.join("127.0.0.1:${port}", ${JSON.stringify(hosted.code)}, "Ben")`);
  check("RR6. the Singer joins the room", joined.ok, JSON.stringify(joined));
  await until(async () => (await collabState(join)).status === "connected", 8000);
  await openPanel(join);
  check("RR7. a Singer who joins later sees the Producer's recording details", await until(async () => await q(join, "[data-testid=rec-room-link]"), 6000));
  const got = { host: await text(join, "[data-testid=rec-room-host]"), port: await text(join, "[data-testid=rec-room-port]"), code: await text(join, "[data-testid=rec-room-code]") };
  check("RR8. address, port and pairing code are the ones the Producer entered", got.host === st.lanIp && got.port === "52000" && got.code === "123456", JSON.stringify(got));
  check("RR9. the Singer's card names the Producer", (await text(join, "[data-testid=rec-room-link]")).includes("Ana"));

  // a new pairing code (single use): the Producer updates it
  await setInput(host, "rec-share-code", "654321");
  await sleep(100);
  await host.evalJs(`document.querySelector('[data-testid=rec-share]').click()`);
  check("RR10. an updated code reaches the Singer", await until(async () => (await text(join, "[data-testid=rec-room-code]")) === "654321", 6000));

  // stopping removes it
  await host.evalJs(`document.querySelector('[data-testid=rec-unshare]').click()`);
  check("RR11. stopping the share removes it from the Singer's tab", await until(async () => !(await q(join, "[data-testid=rec-room-link]")) && (await q(join, "[data-testid=rec-room-waiting]")), 6000));

  // leaving the room clears everything
  await host.evalJs(`window.daw.collab.leave()`);
  check("RR12. when the session ends the room section goes away", await until(async () => !(await q(join, "[data-testid=rec-room]")), 8000));
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
