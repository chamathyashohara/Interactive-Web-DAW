// UI test: drives two real Electron windows over the DevTools protocol (host in one, join in the other).
// Run with `npm run test:ui` (needs a built app; close other copies of the app first, they hold port 4000).
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const electron = require('electron')
const WebSocket = require('ws')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function launch(port) {
  const p = spawn(electron, [process.cwd(), `--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
  return p
}

async function target(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await wait(250)
  }
  throw new Error('no page on ' + port)
}

async function cdp(url) {
  const ws = new WebSocket(url)
  await new Promise((r) => ws.on('open', r))
  let id = 0
  const pending = new Map()
  const errors = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d))
    if (m.id && pending.has(m.id)) pending.get(m.id)(m)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
  })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable')
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.result.value
  }
  return { ev, errors, close: () => ws.close() }
}

const results = []
const check = (label, ok) => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', label) }

const FP = `(() => {
  const ids = ['host','hostOnline','join','end','leave','info','workspace'];  // the Network panel's open/closed state is the user's choice, so it is not compared
  const disp = Object.fromEntries(ids.map(i => [i, getComputedStyle(document.getElementById(i)).display]));
  const vals = Object.fromEntries(['addr','token','code','tempo','master'].map(i => [i, document.getElementById(i).value]));
  const kids = Object.fromEntries(['tracks','grid','users','activity','cursors','infoText'].map(i => [i, document.getElementById(i).children.length]));
  const text = Object.fromEntries(['status','gridTitle','netQuality','netPing','netSync','netRate'].map(i => [i, document.getElementById(i).textContent.trim()]));
  return JSON.stringify({disp, vals, kids, text});
})()`
const pa = launch(9341)
const pb = launch(9342)
try {
  const A = await cdp(await target(9341))
  const B = await cdp(await target(9342))

  const startA = await A.ev(FP), startB = await B.ev(FP)

  await A.ev(`document.getElementById('host').click()`)
  await wait(1500)
  const code = await A.ev(`document.querySelector('#infoText b')?.textContent`)
  check(`host window shows a 6-digit code (${code})`, /^\d{6}$/.test(code ?? ''))
  await A.ev(`document.getElementById('copyCode').click()`)
  await wait(400)
  check('Copy code button confirms with "Copied!"', (await A.ev(`document.getElementById('copyCode').textContent`)) === 'Copied!')
  const clip = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard']).toString().trim() // the real system clipboard
  check(`the code is on the system clipboard (${clip})`, clip === code)
  check('host window shows the workspace with 2 tracks', (await A.ev(`document.querySelectorAll('.track').length`)) === 2)
  check('host sees 4 starting notes', (await A.ev(`document.querySelectorAll('.cell.on').length`)) === 4)

  await B.ev(`document.getElementById('code').value='${code}'; document.getElementById('join').click()`)
  await wait(2000)
  check('guest window receives the project (2 tracks, 4 notes)', (await B.ev(`document.querySelectorAll('.track').length`)) === 2 && (await B.ev(`document.querySelectorAll('.cell.on').length`)) === 4)
  check('both windows list two people', (await A.ev(`document.querySelectorAll('#users span').length`)) === 2 && (await B.ev(`document.querySelectorAll('#users span').length`)) === 2)

  // Guest clicks an empty cell; host should get a new note.
  await B.ev(`[...document.querySelectorAll('.cell')].find(c => !c.classList.contains('on')).click()`)
  await wait(700)
  check('a note added by the guest appears for the host', (await A.ev(`document.querySelectorAll('.cell.on').length`)) === 5)
  check('host activity list shows who did it', (await A.ev(`document.getElementById('activity').innerText`)).includes('added a note'))

  // Host changes tempo; guest sees it.
  await A.ev(`const t=document.getElementById('tempo'); t.value='150'; t.dispatchEvent(new Event('change'))`)
  await wait(700)
  check('tempo changed by the host shows for the guest', (await B.ev(`document.getElementById('tempo').value`)) === '150')

  // Pointers: guest sends a mouse move; host should draw a cursor.
  await B.ev(`document.dispatchEvent(new PointerEvent('pointermove', {clientX: 400, clientY: 300}))`)
  await wait(500)
  check('host sees the guest pointer', (await A.ev(`document.querySelectorAll('.cursor').length`)) === 1)

  // Network panel
  await A.ev(`document.getElementById('netBtn').click()`)
  await wait(4500)
  const conn = await A.ev(`document.getElementById('netConn').textContent`)
  const ping = await A.ev(`document.getElementById('netPing').textContent`)
  check(`network panel shows connected and a ping (${conn}, ${ping})`, conn === 'connected' && /ms/.test(ping))

  // End session
  await A.ev(`document.getElementById('end').click()`)
  await wait(1200)
  const status = await B.ev(`document.getElementById('notice').textContent`)
  check(`guest is told the session ended ("${status}")`, /host ended/i.test(status))
  check('guest is back to the start screen', (await B.ev(`getComputedStyle(document.getElementById('workspace')).display`)) === 'none')

  check('guest window is back to its launch state', (await B.ev(FP)) === startB)

  // Round 2: host again, a guest joins and leaves; the host window must still be hosting, the guest back to default.
  await A.ev(`document.getElementById('host').click()`); await wait(1500)
  const code2 = await A.ev(`document.querySelector('#infoText b')?.textContent`)
  check(`the same window can host a second session (${code2})`, /^\d{6}$/.test(code2 ?? ''))
  await B.ev(`document.getElementById('code').value='${code2}'; document.getElementById('join').click()`); await wait(2000)
  await B.ev(`document.getElementById('leave').click()`); await wait(1200)
  check('guest window is back to its launch state after leaving', (await B.ev(FP)) === startB)
  check('host is still hosting after the guest left', (await A.ev(`document.getElementById('users').children.length`)) === 1)
  await A.ev(`document.getElementById('end').click()`); await wait(1200)
  const endA = await A.ev(FP)
  check('host window is back to its launch state after ending', endA === startA)
  if (endA !== startA) console.log('  launch:', startA, ' now:', endA)

  check('no script errors in either window', A.errors.length === 0 && B.errors.length === 0)
  if (A.errors.length || B.errors.length) console.log([...A.errors, ...B.errors])
  A.close(); B.close()
} catch (e) {
  console.log('FAIL script error:', e.message)
  results.push(false)
} finally {
  pa.kill(); pb.kill()
}
process.exit(results.every(Boolean) ? 0 : 1)
