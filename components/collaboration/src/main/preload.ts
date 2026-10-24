import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('collab', {
  hostSession: (seed: unknown) => ipcRenderer.invoke('host-session', seed),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('copy-text', text),
  endSession: (code: string) => ipcRenderer.invoke('end-session', code),
})
