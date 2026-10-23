// Entry point for running the session server on its own (cloud / VPS), without Electron.
//   PORT        port to listen on (default 4000)
//   AUTH_TOKEN  required to create sessions; set this on any public server
import { startSessionServer } from './sessionServer'

const port = Number(process.env.PORT ?? 4000)
const authToken = process.env.AUTH_TOKEN || undefined

if (!authToken) console.warn('WARNING: AUTH_TOKEN is not set, so anyone can create sessions on this server.')

const server = await startSessionServer(port, { authToken })
console.log(`Collaboration server listening on port ${server.port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close().then(() => process.exit(0)))
}
