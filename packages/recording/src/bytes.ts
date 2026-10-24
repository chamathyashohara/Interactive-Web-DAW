/** Big-endian byte helpers shared by the control, media and transfer protocols. */

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const utf8 = new TextEncoder();
const utf8d = new TextDecoder("utf-8", { fatal: false });
export const toText = (b: Uint8Array): string => utf8d.decode(b);

export function beBytes(v: number | bigint, width: number): Uint8Array {
  let x = BigInt.asUintN(width * 8, BigInt(v));
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function readBe(b: Uint8Array, offset: number, width: number): bigint {
  let v = 0n;
  for (let i = 0; i < width; i++) v = (v << 8n) | BigInt(b[offset + i]!);
  return v;
}

export const readU16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
export const readU32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
export const readU64 = (b: Uint8Array, o: number): number => Number(readBe(b, o, 8));

export function writeU16(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}
export function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}
export function writeU64(b: Uint8Array, o: number, v: number | bigint): void {
  b.set(beBytes(v, 8), o);
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const isHex = (s: string): boolean => /^[0-9a-f]*$/.test(s);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32/IEEE; `crc` continues a previous value so header and payload can be hashed in two calls. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return ~c >>> 0;
}
