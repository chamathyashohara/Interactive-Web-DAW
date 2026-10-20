/**
 * Voice guidance with the operating system's own speech voices (Web Speech API). Offline; nothing is sent anywhere.
 * If Windows has no voice installed, `speechAvailable()` is false and the UI hides or disables the voice controls.
 *
 * One voice at a time: every request bumps a generation counter and cancels what is playing. Chromium can keep or
 * queue an utterance that is spoken in the same moment as `cancel()`, so a new line only starts once the engine is
 * really quiet, and only if no newer request arrived meanwhile. Repeated Replay clicks therefore restart the line
 * instead of stacking voices on top of each other.
 */

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
  const synth = synthOf();
  return synth !== null && synth.getVoices().length > 0;
};

/** Stops any voice guidance now (and any line that was about to start). */
export function stopSpeaking() {
  generation++;
  synthOf()?.cancel();
  setSpeaking(false);
}

/** Reads `text` aloud from the beginning, replacing anything already being read. `onEnd` runs when it finishes or is stopped. */
export function speak(text: string, onEnd?: () => void) {
  const synth = synthOf();
  if (!synth) return onEnd?.();
  const mine = ++generation;
  synth.cancel();
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
