/**
 * Voice guidance with the operating system's own speech voices (Web Speech API). Offline; nothing is sent anywhere.
 * If Windows has no voice installed, `speechAvailable()` is false and the UI hides the feature's controls.
 */

export const speechAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window && window.speechSynthesis.getVoices().length > 0;

export function stopSpeaking() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** Reads `text` aloud, interrupting anything already being read. `onEnd` runs when it finishes or is stopped. */
export function speak(text: string, onEnd?: () => void) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return onEnd?.();
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const english = synth.getVoices().find((v) => v.lang.startsWith("en"));
  if (english) u.voice = english;
  u.rate = 0.95;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  synth.speak(u);
}

/** Voices load asynchronously in Chromium; calls `cb` once they are known. Returns an unsubscribe function. */
export function onVoicesReady(cb: () => void): () => void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return () => {};
  const synth = window.speechSynthesis;
  if (synth.getVoices().length) cb();
  synth.addEventListener("voiceschanged", cb);
  return () => synth.removeEventListener("voiceschanged", cb);
}
