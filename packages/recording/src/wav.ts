/**
 * Master recordings are IEEE-float 32-bit WAV files (ADR-007), laid out exactly as the C++ recorder writes them so either side can
 * open the other's files: RIFF/WAVE, an 18-byte "fmt " (format tag 3, cbSize 0), a "fact" chunk with the frame count, then "data".
 * The header is 58 bytes for the mono/stereo float files made here. `inspectWav` is the structural check the transfer uses before
 * it says VERIFIED, and it walks chunks so it also accepts the extensible (40-byte fmt) files the C++ recorder makes for >2 channels.
 */

export const WAV_FORMAT_PCM = 1;
export const WAV_FORMAT_FLOAT = 3;
export const WAV_FORMAT_EXTENSIBLE = 0xfffe;
export const WAV_HEADER_BYTES = 58;
const FACT_FRAMES_OFFSET = 12 + 8 + 18 + 8;
const DATA_SIZE_OFFSET = FACT_FRAMES_OFFSET + 4 + 4;

export interface WavFormat {
  sampleRate: number;
  channels: number;
}
export const blockAlign = (f: WavFormat): number => f.channels * 4;
/** Whole frames that fit before the 32-bit RIFF size overflows. */
export const maxWavFrames = (f: WavFormat): number => Math.floor((0xffffffff - (WAV_HEADER_BYTES - 8)) / blockAlign(f));

function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function putU32le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function putU16le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}
function putTag(b: Uint8Array, o: number, tag: string): void {
  for (let i = 0; i < 4; i++) b[o + i] = tag.charCodeAt(i);
}

/** The 58-byte header for `frames` frames of float32 audio (frames = 0 when a take has just been opened). */
export function buildWavHeader(f: WavFormat, frames: number): Uint8Array {
  const dataBytes = Math.min(frames * blockAlign(f), 0xffffffff);
  const h = new Uint8Array(WAV_HEADER_BYTES);
  putTag(h, 0, "RIFF");
  putU32le(h, 4, Math.min(WAV_HEADER_BYTES - 8 + dataBytes, 0xffffffff));
  putTag(h, 8, "WAVE");
  putTag(h, 12, "fmt ");
  putU32le(h, 16, 18);
  putU16le(h, 20, WAV_FORMAT_FLOAT);
  putU16le(h, 22, f.channels);
  putU32le(h, 24, f.sampleRate);
  putU32le(h, 28, f.sampleRate * blockAlign(f));
  putU16le(h, 32, blockAlign(f));
  putU16le(h, 34, 32);
  putU16le(h, 36, 0); // cbSize
  putTag(h, 38, "fact");
  putU32le(h, 42, 4);
  putU32le(h, FACT_FRAMES_OFFSET, Math.min(frames, 0xffffffff));
  putTag(h, FACT_FRAMES_OFFSET + 4, "data");
  putU32le(h, DATA_SIZE_OFFSET, dataBytes);
  return h;
}

export interface WavInfo {
  ok: boolean;
  /** Everything that is wrong, in plain words (empty when ok). */
  problems: string[];
  sampleRate: number;
  channels: number;
  bits: number;
  formatTag: number;
  isFloat32: boolean;
  frames: number;
  dataOffset: number;
}

/**
 * Checks a finished WAV from its first bytes (`head`, at least the headers) and its size on disk:
 * float32, sane format, and a data chunk whose declared size matches the file exactly.
 */
export function inspectWav(head: Uint8Array, totalBytes: number): WavInfo {
  const info: WavInfo = { ok: false, problems: [], sampleRate: 0, channels: 0, bits: 0, formatTag: 0, isFloat32: false, frames: 0, dataOffset: 0 };
  const tagIs = (o: number, s: string) => o + 4 <= head.length && s.split("").every((c, i) => head[o + i] === c.charCodeAt(0));
  if (head.length < 12 || !tagIs(0, "RIFF") || !tagIs(8, "WAVE")) {
    info.problems.push("not a RIFF/WAVE file");
    return info;
  }
  let pos = 12;
  let hasFmt = false;
  let dataBytes = -1;
  while (pos + 8 <= head.length) {
    const size = u32le(head, pos + 4);
    if (tagIs(pos, "fmt ")) {
      if (size < 16 || pos + 8 + 16 > head.length) {
        info.problems.push("fmt chunk too short");
        return info;
      }
      hasFmt = true;
      info.formatTag = u16le(head, pos + 8);
      info.channels = u16le(head, pos + 10);
      info.sampleRate = u32le(head, pos + 12);
      info.bits = u16le(head, pos + 22);
      const extFloat = info.formatTag === WAV_FORMAT_EXTENSIBLE && size >= 40 && pos + 8 + 26 <= head.length && u16le(head, pos + 8 + 24) === WAV_FORMAT_FLOAT;
      info.isFloat32 = info.bits === 32 && (info.formatTag === WAV_FORMAT_FLOAT || extFloat);
    } else if (tagIs(pos, "data")) {
      dataBytes = size;
      info.dataOffset = pos + 8;
      break;
    }
    pos += 8 + size + (size & 1);
  }
  if (!hasFmt) info.problems.push("no fmt chunk");
  if (dataBytes < 0) info.problems.push("no data chunk");
  if (info.problems.length) return info;
  if (!info.isFloat32) info.problems.push("not a 32-bit float WAV");
  if (info.channels < 1 || info.sampleRate < 8000) info.problems.push("implausible format");
  if (u32le(head, 4) + 8 !== totalBytes) info.problems.push("RIFF size does not match the file size");
  if (info.dataOffset + dataBytes !== totalBytes) info.problems.push(`header says ${dataBytes} data bytes but the file holds ${totalBytes - info.dataOffset}`);
  const align = info.channels * 4;
  if (align > 0 && dataBytes % align !== 0) info.problems.push("data is not a whole number of frames");
  info.frames = align > 0 ? Math.floor(dataBytes / align) : 0;
  info.ok = info.problems.length === 0;
  return info;
}
