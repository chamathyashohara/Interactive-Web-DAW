import { PPQ } from "@daw/shared";

export interface MidiNote {
  pitch: number;
  /** Start in our ticks (PPQ = 960), already scaled from the file's division. */
  startTick: number;
  durationTicks: number;
  velocity: number;
  /** 0-15; channel 9 is the drum channel. */
  channel: number;
}
export interface MidiTrack {
  name?: string;
  notes: MidiNote[];
}
export interface ParsedMidi {
  format: number;
  tempoBpm: number | null;
  tracks: MidiTrack[];
}

class Reader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get done() {
    return this.pos >= this.b.length;
  }
  u8() {
    return this.b[this.pos++]!;
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return this.u8() * 0x1000000 + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }
  str(n: number) {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  bytes(n: number) {
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** MIDI variable-length quantity. */
  vlq() {
    let v = 0;
    for (;;) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if ((c & 0x80) === 0) return v;
    }
  }
}

/**
 * Parses a Standard MIDI File (format 0 or 1) into note lists at our PPQ. Only note on/off, the track name and the first
 * tempo are used; every other event is skipped. Pure, no I/O. Throws a readable error if the bytes are not a MIDI file.
 */
export function parseMidi(data: Uint8Array): ParsedMidi {
  const r = new Reader(data);
  if (r.str(4) !== "MThd") throw new Error("not a MIDI file (no MThd header)");
  const headerLen = r.u32();
  const format = r.u16();
  r.u16(); // track count (we read until the bytes run out instead)
  const division = r.u16();
  r.pos = 8 + headerLen; // skip any extra header bytes
  if (division <= 0) throw new Error("SMPTE-timed MIDI files are not supported");
  const scale = PPQ / division;

  let tempoBpm: number | null = null;
  const tracks: MidiTrack[] = [];

  while (!r.done) {
    if (r.pos + 8 > data.length) break;
    const id = r.str(4);
    const len = r.u32();
    if (id !== "MTrk") {
      r.pos += len; // unknown chunk
      continue;
    }
    const end = r.pos + len;
    const notes: MidiNote[] = [];
    const open = new Map<number, { startMidi: number; velocity: number }>(); // key: channel*128 + pitch
    let name: string | undefined;
    let tick = 0;
    let status = 0;

    while (r.pos < end) {
      tick += r.vlq();
      let b = r.u8();
      if (b & 0x80) status = b;
      else r.pos--; // running status: the byte was data, reuse the last status
      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (type === 0x90 || type === 0x80) {
        const pitch = r.u8();
        const vel = r.u8();
        const key = channel * 128 + pitch;
        if (type === 0x90 && vel > 0) {
          open.set(key, { startMidi: tick, velocity: vel });
        } else {
          const on = open.get(key);
          if (on) {
            open.delete(key);
            const startTick = Math.round(on.startMidi * scale);
            const dur = Math.max(1, Math.round((tick - on.startMidi) * scale));
            notes.push({ pitch, startTick, durationTicks: dur, velocity: Math.max(1, Math.min(127, on.velocity)), channel });
          }
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        r.pos += 2; // two data bytes, ignored
      } else if (type === 0xc0 || type === 0xd0) {
        r.pos += 1; // one data byte, ignored
      } else if (status === 0xff) {
        const metaType = r.u8();
        const metaLen = r.vlq();
        const payload = r.bytes(metaLen);
        if (metaType === 0x03 && !name) name = new TextDecoder().decode(payload).trim() || undefined;
        if (metaType === 0x51 && metaLen === 3 && tempoBpm === null) {
          const us = (payload[0]! << 16) | (payload[1]! << 8) | payload[2]!;
          if (us > 0) tempoBpm = Math.round(60_000_000 / us);
        }
      } else if (status === 0xf0 || status === 0xf7) {
        r.pos += r.vlq(); // sysex
      } else {
        break; // unrecognised: stop this track rather than misread the rest
      }
    }
    r.pos = end;
    // close any notes left hanging at the track end
    for (const [key, on] of open) {
      const pitch = key % 128;
      notes.push({ pitch, startTick: Math.round(on.startMidi * scale), durationTicks: Math.max(1, Math.round((tick - on.startMidi) * scale)), velocity: on.velocity, channel: Math.floor(key / 128) });
    }
    if (notes.length) tracks.push({ name, notes: notes.sort((a, b) => a.startTick - b.startTick) });
  }

  return { format, tempoBpm, tracks };
}
