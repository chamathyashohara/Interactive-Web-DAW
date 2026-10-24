import { randomBytes, randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Monotonic nanoseconds since this process started. A plain number is exact to 2^53 ns (about 104 days), far beyond a session. */
export const monotonicNs = (): number => Math.round(performance.now() * 1e6);
export const utcNowMs = (): number => Date.now();

export interface Clock {
  nowNs(): number;
}
export const systemClock: Clock = { nowNs: monotonicNs };

export const makePairingCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const makeRandomToken = (hexDigits: number): string => randomBytes(Math.ceil(hexDigits / 2)).toString("hex").slice(0, hexDigits);

/** 8 lower-case hex digits, never all zero (the session id shared by both PCs). */
export function makeSessionId(): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (id !== "00000000") return id;
  }
}

export const msToNs = (ms: number): number => ms * 1_000_000;

/** Strips the IPv4-mapped IPv6 prefix Node sometimes reports for an IPv4 peer. */
export const normalizeAddress = (a: string | undefined): string => (a ?? "").replace(/^::ffff:/i, "");
