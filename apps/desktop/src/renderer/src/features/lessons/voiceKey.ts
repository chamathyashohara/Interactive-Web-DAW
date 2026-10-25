/** The same text always maps to the same recording, however it was spaced. */
export const normalizeLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A line's recording file name (voice/<key>.ogg): a 64-bit FNV-1a hash of the normalized text, in hex. */
export function voiceKey(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(normalizeLine(text))) {
    h ^= BigInt(ch);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
