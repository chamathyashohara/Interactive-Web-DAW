import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { HandFrame } from "@daw/shared";
import type { HandListener, HandSource } from "./handSource";

/** The tracking model and its WebAssembly files are served from this app's own files (see main/index.ts); nothing is fetched from the internet. */
const ASSETS = "dawasset://mediapipe";

const friendly = (e: unknown): string => {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "The camera was not allowed. Allow camera access for this app and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found.";
  if (name === "NotReadableError") return "The camera is busy (another program may be using it).";
  return e instanceof Error ? e.message : String(e);
};

/** Google's MediaPipe hand tracking, running on this computer: the picture is processed here and never saved or sent anywhere. */
export async function createMediaPipeSource(): Promise<HandSource> {
  const delegate = "CPU" as const;
  const listeners = new Set<HandListener>();
  let landmarker: HandLandmarker | null = null;
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let running = false;
  let frameHandle = 0;
  let lastVideoTime = -1;

  const tick = () => {
    if (!running || !video || !landmarker) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const t0 = performance.now();
      let frame: HandFrame | null = null;
      try {
        const result = landmarker.detectForVideo(video, t0);
        const hand = result.landmarks[0];
        if (hand) frame = { t: t0, landmarks: hand.map((p) => ({ x: p.x, y: p.y, z: p.z })) };
      } catch {
        frame = null; // one bad frame is not worth stopping for
      }
      const inferMs = performance.now() - t0;
      listeners.forEach((l) => l(frame, { inferMs }));
    }
    frameHandle = requestAnimationFrame(tick);
  };

  return {
    get delegate() {
      return delegate;
    },
    async start(target: HTMLVideoElement) {
      try {
        const fileset = await FilesetResolver.forVisionTasks(`${ASSETS}/wasm`);
        // The processor, not the graphics card: measured on the development laptop (integrated Intel graphics), the GPU path took about
        // four times as long per frame and stalled for seconds at a time. docs/gesture-play.md has the numbers.
        landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${ASSETS}/hand_landmarker.task`, delegate: "CPU" },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (e) {
        throw new Error(`The hand tracking could not be loaded (${friendly(e)}). Run "npm run gesture:assets" to fetch its files.`);
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30, facingMode: "user" }, audio: false });
        video = target;
        video.srcObject = stream;
        await video.play();
      } catch (e) {
        landmarker?.close();
        landmarker = null;
        throw new Error(friendly(e));
      }
      running = true;
      lastVideoTime = -1;
      window.daw.keepRunning(true);
      frameHandle = requestAnimationFrame(tick);
    },
    stop() {
      if (running) window.daw.keepRunning(false);
      running = false;
      cancelAnimationFrame(frameHandle);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (video) video.srcObject = null;
      video = null;
      landmarker?.close();
      landmarker = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
