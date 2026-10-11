#!/usr/bin/env python3
"""Analyse a live-sink WAV written by rr_session_probe --live-sink wav:<file> (Stage 7).

The file is what the performer's TEST PLAYBACK CLOCK would have played: the decoded live stream
after the jitter buffer, concealment and gain. It is NOT a recording and says nothing about
acoustic latency. Reported:
  - frames, duration, active span (first/last sample with |x| > 1e-4);
  - RMS and peak of the active span (dBFS);
  - tone frequency from positive-going zero crossings (meaningful for the probe's test tone only);
  - dropout blocks: 10 ms blocks inside the active span with RMS below -60 dBFS (silence while
    the tone should be playing, e.g. refills after a stall);
  - dip blocks: 10 ms blocks more than 6 dB below the median block RMS (e.g. concealment fading).
Usage: analyse_live_sink.py <file.wav>
Pure Python (no numpy). Reads 32-bit float mono/stereo WAV (format 3 or extensible float).
"""
import math
import struct
import sys


def read_float_wav(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[0:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('not a RIFF/WAVE file')
    pos = 12
    fmt = None
    samples = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b'fmt ':
            tag, channels, rate = struct.unpack('<HHI', body[0:8])
            bits = struct.unpack('<H', body[14:16])[0]
            fmt = (tag, channels, rate, bits)
        elif cid == b'data':
            samples = body
        pos += 8 + size + (size & 1)
    if fmt is None or samples is None:
        raise ValueError('missing fmt or data chunk')
    tag, channels, rate, bits = fmt
    if bits != 32 or tag not in (3, 0xFFFE):
        raise ValueError('expected 32-bit float samples, got tag %d bits %d' % (tag, bits))
    count = len(samples) // 4
    values = struct.unpack('<%df' % count, samples[:count * 4])
    mono = values[0::channels]  # first channel
    return rate, channels, mono


def db(x):
    return 20.0 * math.log10(x) if x > 0 else -200.0


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    rate, channels, x = read_float_wav(sys.argv[1])
    n = len(x)
    print('file: %s' % sys.argv[1])
    print('format: float32, %d Hz, %d ch; %d frames = %.3f s' % (rate, channels, n, n / rate))
    first = next((i for i, v in enumerate(x) if abs(v) > 1e-4), None)
    if first is None:
        print('active span: none (silent file)')
        return 0
    last = n - 1 - next(i for i, v in enumerate(reversed(x)) if abs(v) > 1e-4)
    span = x[first:last + 1]
    rms = math.sqrt(sum(v * v for v in span) / len(span))
    peak = max(abs(v) for v in span)
    crossings = sum(1 for a, b in zip(span, span[1:]) if a <= 0.0 < b)
    print('active span: %.3f s .. %.3f s (%.3f s)' % (first / rate, last / rate, len(span) / rate))
    print('active RMS %.2f dBFS, peak %.2f dBFS' % (db(rms), db(peak)))
    print('tone frequency (zero crossings): %.2f Hz' % (crossings / (len(span) / rate)))
    block = rate // 100
    blocks = []
    for b in range(0, len(span) - block + 1, block):
        seg = span[b:b + block]
        blocks.append(math.sqrt(sum(v * v for v in seg) / block))
    median = sorted(blocks)[len(blocks) // 2]
    dropouts = [i for i, r in enumerate(blocks) if db(r) < -60.0]
    dips = [i for i, r in enumerate(blocks) if r < median / 2.0]
    print('10 ms blocks in span: %d, median block RMS %.2f dBFS' % (len(blocks), db(median)))
    print('dropout blocks (< -60 dBFS): %d%s' % (
        len(dropouts), (' at ' + ', '.join('%.2f s' % ((first + i * block) / rate) for i in dropouts[:10])) if dropouts else ''))
    print('dip blocks (> 6 dB below median): %d%s' % (
        len(dips), (' at ' + ', '.join('%.2f s' % ((first + i * block) / rate) for i in dips[:10])) if dips else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
