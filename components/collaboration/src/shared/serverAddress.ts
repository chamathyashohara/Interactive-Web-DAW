import { DEFAULT_PORT } from './types'

export interface ServerAddress {
  http: string // e.g. https://collab.example.com
  ws: string // e.g. wss://collab.example.com  (no path; the app adds /ops/<code> and /ping)
}

/**
 * Turns what a user types into server URLs.
 *   "192.168.1.5"                  -> ws://192.168.1.5:4000       (LAN, default port)
 *   "192.168.1.5:5000"             -> ws://192.168.1.5:5000
 *   "collab.example.com"           -> wss://collab.example.com    (a domain with no port is assumed to be secure)
 *   "https://abc.trycloudflare.com"-> wss://abc.trycloudflare.com
 *   "http://host:4000"             -> ws://host:4000
 * Empty input means this computer.
 */
export function parseServerAddress(input: string): ServerAddress {
  let s = input.trim().replace(/\/+$/, '')
  if (!s) s = '127.0.0.1'
  let secure: boolean
  const scheme = s.match(/^(https?|wss?):\/\//i)
  if (scheme) {
    secure = /^(https|wss)$/i.test(scheme[1])
    s = s.slice(scheme[0].length)
  } else {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s) || /^localhost(:\d+)?$/i.test(s)
    secure = !isIp && !/:\d+$/.test(s)
  }
  if (!secure && !/:\d+$/.test(s)) s += `:${DEFAULT_PORT}`
  return { http: `${secure ? 'https' : 'http'}://${s}`, ws: `${secure ? 'wss' : 'ws'}://${s}` }
}
