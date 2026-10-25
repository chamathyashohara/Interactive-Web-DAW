import { voiceKey } from "./voiceKey";

/**
 * Voice guidance. Every lesson line is recorded ahead of time with a natural voice (./voice/<voiceKey>.ogg, see
 * docs/lessons/VOICE.md) and played from the app; a line without a recording falls back to the operating system's
 * own speech voice (Web Speech API). Offline either way; nothing is sent anywhere.
 *
 * One voice at a time: every request bumps a generation counter and cancels what is playing. Chromium can keep or
 * queue an utterance that is spoken in the same moment as `cancel()`, so a new line only starts once the engine is
 * really quiet, and only if no newer request arrived meanwhile. Repeated Replay clicks therefore restart the line
 * instead of stacking voices on top of each other.
 */

/** The recorded lines, by file name (Vite turns each into a URL in the build). */
const CLIPS = import.meta.glob("./voice/*.ogg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const clipFor = (text: string): string | undefined => CLIPS[`./voice/${voiceKey(text)}.ogg`];
let audio: HTMLAudioElement | null = null;
const stopAudio = () => {
  if (!audio) return;
  audio.onended = audio.onerror = null;
  audio.pause();
  audio = null;
};

let generation = 0;
const speakingListeners = new Set<(speaking: boolean) => void>();
let speakingNow = false;
const setSpeaking = (v: boolean) => {
  if (v === speakingNow) return;
  speakingNow = v;
  for (const l of speakingListeners) l(v);
};

const synthOf = () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

export const speechAvailable = () => {
  if (Object.keys(CLIPS).length && typeof Audio !== "undefined") return true;
  const synth = synthOf();
  return synth !== null && synth.getVoices().length > 0;
};

/** Stops any voice guidance now (and any line that was about to start). */
export function stopSpeaking() {
  generation++;
  stopAudio();
  synthOf()?.cancel();
  setSpeaking(false);
}

/** Reads `text` aloud from the beginning, replacing anything already being read. `onEnd` runs when it finishes or is stopped. */
export function speak(text: string, onEnd?: () => void) {
  const synth = synthOf();
  const mine = ++generation;
  stopAudio();
  synth?.cancel();
  const clip = clipFor(text);
  if (clip) return playClip(clip, mine, text, onEnd);
  if (!synth) return onEnd?.();
  sayWith(synth, text, mine, onEnd);
}

/** The system voice reads `text` (for a line with no recording, or one that cannot play). */
function sayWith(synth: SpeechSynthesis, text: string, mine: number, onEnd?: () => void) {
  let tries = 0;
  const start = () => {
    if (mine !== generation) return onEnd?.(); // a newer request (or a stop) took over
    if ((synth.speaking || synth.pending) && tries++ < 20) {
      synth.cancel();
      setTimeout(start, 40);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const english = synth.getVoices().find((v) => v.lang.startsWith("en"));
    if (english) u.voice = english;
    u.rate = 0.95;
    const done = () => {
      if (mine === generation) setSpeaking(false);
      onEnd?.();
    };
    u.onend = done;
    u.onerror = done;
    setSpeaking(true);
    synth.speak(u);
  };
  setTimeout(start, 60);
}

/** Plays a line's recording; if it cannot play, the system voice reads the line instead. */
function playClip(url: string, mine: number, text: string, onEnd?: () => void) {
  const a = new Audio(url);
  audio = a;
  const done = () => {
    if (audio === a) audio = null;
    if (mine === generation) setSpeaking(false);
    onEnd?.();
  };
  a.onended = done;
  a.onerror = () => {
    if (audio === a) audio = null;
    if (mine !== generation) return onEnd?.();
    const synth = synthOf();
    if (!synth?.getVoices().length) return done();
    sayWith(synth, text, mine, onEnd);
  };
  setSpeaking(true);
  void a.play().catch(() => a.onerror?.(new Event("error")));
}

/** Subscribe to "is voice guidance playing now?" (for Replay / Stop buttons). Returns an unsubscribe function. */
export function onSpeakingChange(cb: (speaking: boolean) => void): () => void {
  speakingListeners.add(cb);
  return () => void speakingListeners.delete(cb);
}

/** Voices load asynchronously in Chromium; calls `cb` once they are known. Returns an unsubscribe function. */
export function onVoicesReady(cb: () => void): () => void {
  const synth = synthOf();
  if (!synth) return () => {};
  if (synth.getVoices().length) cb();
  synth.addEventListener("voiceschanged", cb);
  return () => synth.removeEventListener("voiceschanged", cb);
}
