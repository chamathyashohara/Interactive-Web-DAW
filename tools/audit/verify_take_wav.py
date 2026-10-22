#!/usr/bin/env python3
"""Independent structural check of master take WAV files (Stage 9).

Written separately from the C++ writer and inspector, so a writer bug is not hidden by the same
code reading it back. For each file:
  - RIFF/WAVE header, chunk walk, RIFF size == file size - 8;
  - fmt: IEEE float 32-bit (format 3, or EXTENSIBLE with the float sub-format), channels, rate,
    block align and byte rate consistent;
  - fact sample-frame count == data bytes / block align;
  - data chunk complete (not truncated), every sample read, count of non-finite values;
  - duration, peak and RMS per channel; frames compared with the take's JSON metadata if present.
Exit code 0 if every file passes, 1 otherwise. Usage: verify_take_wav.py <file.wav>...
This proves the file is well-formed and fully readable; it does not prove what it sounds like.
"""
import json
import math
import os
import struct
import sys


def check(path):
    problems = []
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        return ['not a RIFF/WAVE file'], {}
    riff = struct.unpack('<I', data[4:8])[0]
    if riff != size - 8:
        problems.append('RIFF size %d != file size - 8 (%d)' % (riff, size - 8))
    pos = 12
    fmt = None
    fact = None
    data_off = data_len = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        clen = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = pos + 8
        if body + clen > len(data):
            problems.append('chunk %r runs past the end of the file' % cid)
            break
        if cid == b'fmt ':
            tag, ch, rate, byte_rate, align, bits = struct.unpack('<HHIIHH', data[body:body + 16])
            sub = tag
            if tag == 0xFFFE and clen >= 40:
                sub = struct.unpack('<H', data[body + 24:body + 26])[0]
            fmt = dict(tag=tag, sub=sub, channels=ch, rate=rate, byte_rate=byte_rate, align=align, bits=bits)
        elif cid == b'fact':
            fact = struct.unpack('<I', data[body:body + 4])[0]
        elif cid == b'data':
            data_off, data_len = body, clen
        pos = body + clen + (clen & 1)
    if fmt is None or data_off is None:
        return problems + ['missing fmt or data chunk'], {}
    if fmt['sub'] != 3 or fmt['bits'] != 32:
        problems.append('not IEEE float 32-bit (format %d/%d, %d bits)' % (fmt['tag'], fmt['sub'], fmt['bits']))
    if fmt['align'] != fmt['channels'] * 4 or fmt['byte_rate'] != fmt['rate'] * fmt['align']:
        problems.append('block align / byte rate inconsistent')
    if data_len % fmt['align'] != 0:
        problems.append('data size %d is not a whole number of frames' % data_len)
    frames = data_len // fmt['align']
    if fact is not None and fact != frames:
        problems.append('fact frames %d != data frames %d' % (fact, frames))
    count = frames * fmt['channels']
    values = struct.unpack('<%df' % count, data[data_off:data_off + count * 4])
    nonfinite = sum(1 for v in values if not math.isfinite(v))
    if nonfinite:
        problems.append('%d non-finite samples' % nonfinite)
    ch = fmt['channels']
    stats = []
    for c in range(ch):
        col = values[c::ch]
        peak = max((abs(v) for v in col), default=0.0)
        rms = math.sqrt(sum(v * v for v in col) / len(col)) if col else 0.0
        stats.append((peak, rms))
    info = dict(frames=frames, rate=fmt['rate'], channels=ch, seconds=frames / fmt['rate'] if fmt['rate'] else 0, stats=stats)
    meta = os.path.splitext(path)[0] + '.json'
    if os.path.exists(meta):
        try:
            m = json.load(open(meta, encoding='utf-8'))
            mf = None
            for key in ('frames', 'frames_written', 'total_frames'):
                if isinstance(m.get(key), int):
                    mf = m[key]
                    break
            if mf is None and isinstance(m.get('take'), dict):
                mf = m['take'].get('frames')
            info['meta_frames'] = mf
            if mf is not None and mf != frames:
                problems.append('metadata frames %s != file frames %d' % (mf, frames))
        except (ValueError, OSError) as e:
            problems.append('metadata unreadable: %s' % e)
    return problems, info


def db(x):
    return 20 * math.log10(x) if x > 1e-10 else -200.0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    failed = 0
    for path in sys.argv[1:]:
        problems, info = check(path)
        name = os.path.basename(path)
        if info:
            levels = ', '.join('ch%d peak %.1f dBFS rms %.1f dBFS' % (i + 1, db(p), db(r)) for i, (p, r) in enumerate(info['stats']))
            print('%s: %s; %d frames = %.3f s at %d Hz, %d ch; %s%s' % (
                name, 'PASS' if not problems else 'FAIL', info['frames'], info['seconds'], info['rate'], info['channels'],
                levels, '' if info.get('meta_frames') is None else '; metadata frames %s' % info['meta_frames']))
        for p in problems:
            print('  problem: %s' % p)
        failed += 1 if problems else 0
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
