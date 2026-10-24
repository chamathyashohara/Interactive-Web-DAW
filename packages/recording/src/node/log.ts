/** A tiny structured logger (one JSON object per line, like the C++ recorder's JSONL logs). Pairing codes and tokens are never passed in. */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean>;

export interface Logger {
  log(level: LogLevel, component: string, event: string, message: string, fields?: LogFields): void;
}

export const nullLogger: Logger = { log() {} };

/** Keeps the records in memory (tests, and the diagnostics view). */
export class MemoryLogger implements Logger {
  records: { level: LogLevel; component: string; event: string; message: string; fields: LogFields }[] = [];
  log(level: LogLevel, component: string, event: string, message: string, fields: LogFields = {}): void {
    this.records.push({ level, component, event, message, fields });
    if (this.records.length > 2000) this.records.shift();
  }
  find(event: string) {
    return this.records.filter((r) => r.event === event);
  }
}

/** Appends JSON lines to a file; failures to write never reach the caller. */
export class JsonlFileLogger implements Logger {
  constructor(private file: string) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      /* logging must never stop recording */
    }
  }
  log(level: LogLevel, component: string, event: string, message: string, fields: LogFields = {}): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), level, component, event, message, ...fields }) + "\n");
    } catch {
      /* see above */
    }
  }
}

export function teeLogger(...loggers: Logger[]): Logger {
  return { log: (...a) => loggers.forEach((l) => l.log(...a)) };
}
