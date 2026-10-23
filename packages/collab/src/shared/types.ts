export interface HostInfo {
  code: string
  ip: string
  port: number
}

export const DEFAULT_PORT = 4000

/** WebSocket close code sent when the host ends a session. */
export const SESSION_ENDED = 4001
