/** Live media packet header v1 (PROTOCOL_OVERVIEW §12, §13): 26 bytes, big-endian, CRC-32/IEEE over bytes 0-21 and the payload. */
import { crc32, readU16, readU32, readU64, writeU16, writeU32, writeU64 } from "./bytes";

export const HEADER_BYTES = 26;
export const MAX_DATAGRAM_BYTES = 1472;
export const MAX_PAYLOAD_BYTES = MAX_DATAGRAM_BYTES - HEADER_BYTES;
export const HEADER_VERSION = 1;
export const STREAM_PRODUCER_MIC = 1;
export const STREAM_PERFORMER_MIC = 2;
export const FLAG_MUTED = 0x04;
export const CODEC_OPUS = 1;

export const PacketType = { Audio: 0, EndOfStream: 3, ReceiverReport: 4 } as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export interface MediaHeader {
  seq: number;
  mediaIndex: number;
  sessionId: number;
  streamId: number;
  payloadLen: number;
  type: PacketType;
  flags: number;
}

export type PacketCheck = "ok" | "bad_length" | "bad_version" | "bad_type" | "bad_crc" | "bad_session" | "bad_payload";

export interface InvalidCounts {
  src_rejected: number;
  oversized: number;
  bad_length: number;
  bad_version: number;
  bad_type: number;
  bad_crc: number;
  bad_session: number;
  bad_payload: number;
  wrong_stream: number;
}
export const newInvalidCounts = (): InvalidCounts => ({ src_rejected: 0, oversized: 0, bad_length: 0, bad_version: 0, bad_type: 0, bad_crc: 0, bad_session: 0, bad_payload: 0, wrong_stream: 0 });
export const invalidTotal = (c: InvalidCounts): number => Object.values(c).reduce((a, b) => a + b, 0);

export interface ReceiverReport {
  received: number;
  lostEstimate: number;
  late: number;
  duplicates: number;
  reordered: number;
  jitterUs: number;
  jbFill: number;
  jbTarget: number;
  underruns: number;
  concealed: number;
  decodeErrors: number;
  invalidPackets: number;
  flags: number;
}
export const REPORT_BYTES = 64;
export const REPORT_FLAG_PLAYING = 1;
export const REPORT_FLAG_CLOSING = 2;
export const emptyReport = (): ReceiverReport => ({ received: 0, lostEstimate: 0, late: 0, duplicates: 0, reordered: 0, jitterUs: 0, jbFill: 0, jbTarget: 0, underruns: 0, concealed: 0, decodeErrors: 0, invalidPackets: 0, flags: 0 });

/** Builds one datagram, or null if the payload is too big. */
export function writePacket(h: Omit<MediaHeader, "payloadLen">, payload: Uint8Array): Uint8Array | null {
  if (payload.length > MAX_PAYLOAD_BYTES) return null;
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  writeU32(out, 0, h.seq >>> 0);
  writeU64(out, 4, h.mediaIndex);
  writeU32(out, 12, h.sessionId >>> 0);
  writeU16(out, 16, h.streamId);
  writeU16(out, 18, payload.length);
  out[20] = (HEADER_VERSION << 4) | (h.type & 0x0f);
  out[21] = h.flags & 0xff;
  out.set(payload, HEADER_BYTES);
  let crc = crc32(out.subarray(0, 22));
  crc = crc32(payload, crc);
  writeU32(out, 22, crc);
  return out;
}

export type ParsedPacket = { check: "ok"; header: MediaHeader; payload: Uint8Array } | { check: Exclude<PacketCheck, "ok"> };

/** Validation order of PROTOCOL_OVERVIEW §2.1 / §12.2 (steps 2-8). */
export function parsePacket(data: Uint8Array, expectedSession: number): ParsedPacket {
  if (data.length < HEADER_BYTES || data.length > MAX_DATAGRAM_BYTES) return { check: "bad_length" };
  if (data[20]! >> 4 !== HEADER_VERSION) return { check: "bad_version" };
  const type = data[20]! & 0x0f;
  if (type !== PacketType.Audio && type !== PacketType.EndOfStream && type !== PacketType.ReceiverReport) return { check: "bad_type" };
  const payloadLen = readU16(data, 18);
  if (payloadLen !== data.length - HEADER_BYTES) return { check: "bad_length" };
  const payload = data.subarray(HEADER_BYTES);
  let crc = crc32(data.subarray(0, 22));
  crc = crc32(payload, crc);
  if (crc !== readU32(data, 22)) return { check: "bad_crc" };
  if (readU32(data, 12) !== expectedSession >>> 0) return { check: "bad_session" };
  const header: MediaHeader = {
    seq: readU32(data, 0),
    mediaIndex: readU64(data, 4),
    sessionId: readU32(data, 12),
    streamId: readU16(data, 16),
    payloadLen,
    type: type as PacketType,
    flags: data[21]!,
  };
  if (header.streamId !== STREAM_PRODUCER_MIC && header.streamId !== STREAM_PERFORMER_MIC) return { check: "bad_payload" };
  switch (header.type) {
    case PacketType.Audio:
      // Bit 2 (muted) is allowed; bits 3-7 are reserved.
      if ((header.flags & 0x03) !== CODEC_OPUS || (header.flags & 0xf8) !== 0 || payloadLen === 0 || payloadLen > 1276) return { check: "bad_payload" };
      break;
    case PacketType.EndOfStream:
      if (header.flags !== 0 || payloadLen !== 0) return { check: "bad_payload" };
      break;
    case PacketType.ReceiverReport:
      if (header.flags !== 0 || payloadLen !== REPORT_BYTES) return { check: "bad_payload" };
      break;
  }
  return { check: "ok", header, payload };
}

export function writeReport(r: ReceiverReport): Uint8Array {
  const o = new Uint8Array(REPORT_BYTES);
  writeU64(o, 0, r.received);
  writeU64(o, 8, r.lostEstimate);
  writeU32(o, 16, r.late);
  writeU32(o, 20, r.duplicates);
  writeU32(o, 24, r.reordered);
  writeU32(o, 28, r.jitterUs);
  writeU32(o, 32, r.jbFill);
  writeU32(o, 36, r.jbTarget);
  writeU32(o, 40, r.underruns);
  writeU32(o, 44, r.concealed);
  writeU32(o, 48, r.decodeErrors);
  writeU32(o, 52, r.invalidPackets);
  writeU32(o, 56, r.flags);
  return o;
}

export function readReport(b: Uint8Array): ReceiverReport {
  return {
    received: readU64(b, 0),
    lostEstimate: readU64(b, 8),
    late: readU32(b, 16),
    duplicates: readU32(b, 20),
    reordered: readU32(b, 24),
    jitterUs: readU32(b, 28),
    jbFill: readU32(b, 32),
    jbTarget: readU32(b, 36),
    underruns: readU32(b, 40),
    concealed: readU32(b, 44),
    decodeErrors: readU32(b, 48),
    invalidPackets: readU32(b, 52),
    flags: readU32(b, 56),
  };
}

/** "1a2b3c4d" -> 0x1A2B3C4D; null if it is not 8 lower-case hex digits or is zero. */
export function sessionIdToU32(text: string): number | null {
  if (!/^[0-9a-f]{8}$/.test(text)) return null;
  const v = parseInt(text, 16) >>> 0;
  return v === 0 ? null : v;
}
