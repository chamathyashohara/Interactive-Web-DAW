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
  const kids = Object.fromEntries(['tracks','grid','users','historyBar','cursors','infoText'].map(i => [i, document.getElementById(i).children.length]));
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
  // The history bar: one segment, in the guest's colour; hovering shows what was done and by whom.
  check('host history bar has one segment for the guest note', (await A.ev(`document.querySelectorAll('#historyBar .seg:not(.start)').length`)) === 1)
  await A.ev(`document.querySelector('#historyBar .seg:not(.start)').dispatchEvent(new MouseEvent('mouseenter'))`)
  const tip = await A.ev(`document.getElementById('tip').innerText`)
  check(`hovering the segment shows who and what ("${tip.replace(/\n/g, ' | ')}")`, /Guest/.test(tip) && /added a note/.test(tip) && /at beat/.test(tip) && /\d\d:\d\d/.test(tip))
  const chips = await A.ev(`[...document.querySelectorAll('#users span')].map(s => [s.textContent, getComputedStyle(s).backgroundColor])`)
  const segColour = await A.ev(`getComputedStyle(document.querySelector('#historyBar .seg:not(.start)')).backgroundColor`)
  const guestChip = chips.find(([t]) => t.startsWith('Guest'))
  check('the segment has the guest colour, and the two people have different colours', !!guestChip && guestChip[1] === segColour && new Set(chips.map((c) => c[1])).size === 2)

  // Host changes tempo; guest sees it.
  await A.ev(`const t=document.getElementById('tempo'); t.value='150'; t.dispatchEvent(new Event('change'))`)
  await wait(700)
  check('tempo changed by the host shows for the guest', (await B.ev(`document.getElementById('tempo').value`)) === '150')
  const segColours = await B.ev(`[...document.querySelectorAll('#historyBar .seg:not(.start)')].map(s => getComputedStyle(s).backgroundColor)`)
  check('guest history bar has two segments in two different colours', segColours.length === 2 && segColours[0] !== segColours[1])

  // Restore: click the guest's note (the first action). The project goes back to just after it, for everyone.
  const hostChipColour = chips.find(([t]) => t.startsWith('Host'))[1]
  const tempoOf = (X) => X.ev(`document.getElementById('tempo').value`)
  const notesOf = (X) => X.ev(`document.querySelectorAll('.cell.on').length`)
  await A.ev(`document.querySelectorAll('#historyBar .seg:not(.start)')[0].click()`)
  await wait(300)
  check('clicking a segment opens a popup that names the step', (await A.ev(`getComputedStyle(document.getElementById('confirm')).display`)) === 'flex' && /step #1/.test(await A.ev(`document.getElementById('confirmTitle').textContent`)))
  check('the popup covers the whole window and says what it undoes', (await A.ev(`(() => { const r = document.getElementById('confirm').getBoundingClientRect(); const d = document.documentElement; return r.width >= d.clientWidth - 1 && r.height >= d.clientHeight - 1 })()`)) && /undoes \d+ later change/.test(await A.ev(`document.getElementById('confirmText').textContent`)))
  check('the safe choice (Cancel) has the focus', (await A.ev(`document.activeElement.id`)) === 'confirmNo')
  await A.ev(`document.getElementById('confirmNo').click()`)
  check('Cancel closes the popup and changes nothing', (await A.ev(`getComputedStyle(document.getElementById('confirm')).display`)) === 'none' && (await tempoOf(A)) === '150')
  await A.ev(`document.querySelectorAll('#historyBar .seg:not(.start)')[0].click()`)
  await A.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  check('Escape closes the popup', (await A.ev(`getComputedStyle(document.getElementById('confirm')).display`)) === 'none')
  await A.ev(`document.querySelectorAll('#historyBar .seg:not(.start)')[0].click()`)
  await A.ev(`document.getElementById('confirm').click()`)
  check('clicking the dimmed background closes it', (await A.ev(`getComputedStyle(document.getElementById('confirm')).display`)) === 'none')
  await A.ev(`document.querySelectorAll('#historyBar .seg:not(.start)')[0].click()`)
  check('nothing changes before confirming', (await tempoOf(A)) === '150')
  await A.ev(`document.getElementById('confirmYes').click()`)
  await wait(900)
  check('after restoring to step 1 the tempo is back to 120 in both windows', (await tempoOf(A)) === '120' && (await tempoOf(B)) === '120')
  check('the guest note from step 1 is kept (5 notes) in both windows', (await notesOf(A)) === 5 && (await notesOf(B)) === 5)
  check('everyone sees a striped restore segment in the restorer colour', (await B.ev(`document.querySelectorAll('#historyBar .seg.restore').length`)) === 1 && (await B.ev(`getComputedStyle(document.querySelector('#historyBar .seg.restore')).backgroundColor`)) === hostChipColour)
  check('the other person is told about the restore', /put the project back/.test(await B.ev(`document.getElementById('notice').textContent`)))
  await B.ev(`document.querySelector('#historyBar .seg.restore').dispatchEvent(new MouseEvent('mouseenter'))`)
  check('hovering the restore segment says what it did', /restored the project to step #1/.test(await B.ev(`document.getElementById('tip').innerText`)))

  // Go forward again by clicking the tempo action: this undoes the restore.
  await A.ev(`document.querySelectorAll('#historyBar .seg:not(.start):not(.restore)')[1].click()`)
  await A.ev(`document.getElementById('confirmYes').click()`)
  await wait(900)
  check('clicking the later action brings the tempo (150) back everywhere', (await tempoOf(A)) === '150' && (await tempoOf(B)) === '150')

  // And the original project, by clicking the grey start marker.
  await B.ev(`document.querySelector('#historyBar .seg.start').click()`)
  check('the start marker offers to restore the original', /original/.test(await B.ev(`document.getElementById('confirmTitle').textContent`)))
  await B.ev(`document.getElementById('confirmYes').click()`)
  await wait(900)
  check('restoring the original gives the 4 starting notes and tempo 120 in both windows', (await notesOf(A)) === 4 && (await notesOf(B)) === 4 && (await tempoOf(A)) === '120')
  check('the current state is marked on the bar', (await A.ev(`document.querySelectorAll('#historyBar .seg.current').length`)) === 1)

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
