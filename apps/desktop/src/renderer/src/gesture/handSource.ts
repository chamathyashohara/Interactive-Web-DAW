import type { HandFrame } from "@daw/shared";

/** One frame's result: the hand (null = none seen) and how long the tracking itself took. */
export type HandListener = (frame: HandFrame | null, info: { inferMs: number }) => void;

/**
 * Where hand frames come from: the camera and the tracking model in normal use, a test feed in the automated tests. The rest of the
 * gesture code only knows this interface.
 */
export interface HandSource {
  /** What runs the tracking: the graphics card, the processor, or (in tests) a feed. Known once started. */
  readonly delegate: "GPU" | "CPU" | "test";
  /** Starts the camera and tracking, drawing the picture into `video`. Rejects with a message a person can read. */
  start(video: HTMLVideoElement): Promise<void>;
  /** Stops the camera (its light goes off) and the tracking. Safe to call twice. */
  stop(): void;
  subscribe(listener: HandListener): () => void;
}

/** Lets the automated tests play the part of the camera: they push the landmarks themselves. Nothing here touches a camera. */
export class TestHandSource implements HandSource {
  readonly delegate = "test" as const;
  private listeners = new Set<HandListener>();
  private running = false;

  async start(): Promise<void> {
    this.running = true;
    (window as unknown as { __gestureTest?: unknown }).__gestureTest = {
      feed: (frame: HandFrame | null) => this.running && this.listeners.forEach((l) => l(frame, { inferMs: 0 })),
    };
  }
  stop(): void {
    this.running = false;
    delete (window as unknown as { __gestureTest?: unknown }).__gestureTest;
  }
  subscribe(listener: HandListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Creates the real source, loading the tracking code only when it is first needed (it is a large download-free but heavy module). */
export async function createHandSource(): Promise<HandSource> {
  const useTest = (window as unknown as { __gestureUseTestSource?: boolean }).__gestureUseTestSource === true && (await window.daw.isDev());
  if (useTest) return new TestHandSource();
  const { createMediaPipeSource } = await import("./mediapipeSource");
  return createMediaPipeSource();
}
