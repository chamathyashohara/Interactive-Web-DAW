import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { startSessionServer, type SessionServer } from '../server/sessionServer'
import { DEFAULT_PORT, type HostInfo } from '../shared/types'

// Several copies of the app run side by side when testing. Each needs its own data folder,
// otherwise the second one cannot open the cache the first one has locked.
app.setPath('userData', path.join(app.getPath('temp'), `comp3-collab-${process.pid}`))

let server: SessionServer | null = null

function lanIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

/** `seed` is the host's project; the server checks it with the shared rules before using it. */
ipcMain.handle('host-session', async (_e, seed: unknown): Promise<HostInfo> => {
  server ??= await startSessionServer(DEFAULT_PORT)
  const code = server.createSession(seed)
  const ip = lanIp()
  return { code, ip, port: server.port }
})

/** Copies short text to the system clipboard. Done here because the page cannot always write to it (e.g. when the window is not focused). */
ipcMain.handle('copy-text', (_e, text: unknown) => {
  if (typeof text !== 'string' || text.length === 0 || text.length > 200) return false
  clipboard.writeText(text)
  return true
})

ipcMain.handle('end-session', (_e, code: string) => server?.endSession(code) ?? false)

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 640,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  server?.close()
  app.quit()
})
