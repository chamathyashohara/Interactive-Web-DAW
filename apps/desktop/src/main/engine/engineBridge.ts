import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { EngineCommand, EngineEvent, EngineReady, EngineStatus } from "@daw/engine-protocol";

export interface EngineBridgeEvents {
  ready: (info: EngineReady) => void;
  status: (status: EngineStatus) => void;
  down: () => void;
  error: (message: string) => void;
}

/**
 * Spawns and supervises the audio engine process. If it exits unexpectedly it is restarted;
 * the owner re-sends the project snapshot on every `ready` event, so the engine always
 * recovers its state from the main process (which owns the project).
 */
export class EngineBridge extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = "";
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly exePath: string,
    private readonly args: string[] = [],
  ) {
    super();
  }

  on<K extends keyof EngineBridgeEvents>(event: K, listener: EngineBridgeEvents[K]): this {
    return super.on(event, listener);
  }

  start(): void {
    this.stopping = false;
    let child: ChildProcess;
    try {
      child = spawn(this.exePath, this.args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    } catch (err) {
      this.emit("error", `cannot start engine: ${String(err)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.buffer = "";

    child.on("error", (err) => {
      this.emit("error", `engine process error: ${err.message}`);
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stdin!.on("error", () => {
      /* engine exited; handled by the exit event */
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      this.emit("down");
      this.scheduleRestart();
    });
  }

  send(cmd: EngineCommand): void {
    const stdin = this.child?.stdin;
    if (stdin && stdin.writable) stdin.write(JSON.stringify(cmd) + "\n");
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Debug/test hook: simulates an engine crash. */
  killForTest(): void {
    this.child?.kill();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    child.stdin?.end(); // engine exits when stdin closes
    setTimeout(() => child.kill(), 1000).unref();
  }

  private scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, 500);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: EngineEvent;
      try {
        msg = JSON.parse(line) as EngineEvent;
      } catch {
        continue;
      }
      if (msg.t === "ready") this.emit("ready", msg);
      else if (msg.t === "status") this.emit("status", msg);
      else if (msg.t === "error") this.emit("error", msg.message);
    }
  }
}
