// Runs the app's network measuring code for real: two clients, one session, a few seconds of pings.
import { startSessionServer } from '../src/server/sessionServer'
import { CollabClient } from '../src/client/collabClient'
import { NetStats } from '../src/renderer/netstats'
import { summarize } from '../src/shared/stats'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const check = (label: string, ok: boolean) => {
  console.log(ok ? 'PASS' : 'FAIL', label)
  if (!ok) process.exitCode = 1
}

const server = await startSessionServer(4102)
const code = server.createSession()
const base = 'ws://127.0.0.1:4102'

function client(name: string) {
  const c = new CollabClient({ baseUrl: base, code, name, color: '#4cc9f0' })
  c.connect()
  return { c, net: new NetStats(base, c) }
}
const a = client('A')
const b = client('B')
await wait(7000)

const ping = summarize(a.net.pings)
check(`ping measured (${a.net.pings.length} samples, avg ${ping?.avg.toFixed(1)} ms)`, a.net.pings.length >= 2 && ping!.avg < 200)
check('no pings lost on a local connection', a.net.pingsLost === 0)
check('A counts the other user', a.net.otherUsers === 1)
const sync = summarize(b.net.syncs)
check(`sync delay measured on B (${b.net.syncs.length} samples, avg ${sync?.avg.toFixed(1)} ms)`, b.net.syncs.length >= 1 && sync!.avg < 200)
check('traffic counted both ways', a.net.rx > 0 && a.net.tx > 0)
check('csv export has header and rows', a.net.toCsv().startsWith('time,kind,ms\n') && a.net.toCsv().split('\n').length > 3)

a.net.stop()
b.net.stop()
a.c.close()
b.c.close()
await server.close()
process.exit(process.exitCode ?? 0)
