import { SR } from "./dsp.ts";

/** Encodes float channels (-1..1) as a 16-bit PCM RIFF/WAVE file. Deterministic: no dither, plain rounding with clipping. */
export function encodeWav(channels: Float32Array[], sampleRate: number = SR): Uint8Array {
  const n = channels[0]!.length;
  const ch = channels.length;
  const bytes = n * ch * 2;
  const out = new Uint8Array(44 + bytes);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      v.setInt16(o, Math.round(s < 0 ? s * 32768 : s * 32767), true);
      o += 2;
    }
  }
  return out;
}

/** Reads back a file written by encodeWav (16-bit PCM) into float channels. Used by tests and the library index. */
export function decodeWav(data: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const str = (o: number) => String.fromCharCode(data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!);
  if (str(0) !== "RIFF" || str(8) !== "WAVE") throw new Error("not a WAV file");
  let pos = 12;
  let ch = 0, rate = 0, bits = 0;
  while (pos + 8 <= data.length) {
    const id = str(pos);
    const size = v.getUint32(pos + 4, true);
    if (id === "fmt ") {
      ch = v.getUint16(pos + 10, true);
      rate = v.getUint32(pos + 12, true);
      bits = v.getUint16(pos + 22, true);
    } else if (id === "data") {
      if (bits !== 16) throw new Error("only 16-bit PCM is supported");
      const frames = Math.floor(size / (ch * 2));
      const channels = Array.from({ length: ch }, () => new Float32Array(frames));
      let o = pos + 8;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < ch; c++) {
          channels[c]![i] = v.getInt16(o, true) / 32768;
          o += 2;
        }
      }
      return { sampleRate: rate, channels };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}
