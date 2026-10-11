#!/usr/bin/env python3
"""Analyse one side of a two-way live run of rr_session_probe (Stage 8).

Inputs (written by the probe on ONE test clock, so sample n of both files is the same instant):
  --sink   <file.wav>   what this side's TEST PLAYBACK CLOCK played (--live-sink wav:<file>)
  --source <file.wav>   what this side's test source sent (--source-wav <file>), optional
  --own-hz <Hz>         this side's test tone (producer 440, performer 660)
  --remote-hz <Hz>      the other side's test tone

Reported:
  - level of the sink and the share of its energy at the remote tone and at this side's OWN tone.
    Own-tone energy in the sink means this side's audio came back: duplicate audio / accidental
    feedback (e.g. the other side's speakers into its microphone, simulated by --live-source echo);
  - with --source and a bursts source: the delay from each sent burst onset to the matching onset
    in the sink. With the other side in echo mode this is the SOFTWARE ROUND TRIP of the live path
    (encode + network + both jitter buffers + both test clocks), not acoustic latency: no devices,
    converters or air are involved.
Pure Python, no numpy. Reads 32-bit float WAV.
"""
import argparse
import math
import struct
import sys


def read_float_wav(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[0:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('not a RIFF/WAVE file: %s' % path)
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
    tag, channels, rate, bits = fmt
    if bits != 32 or tag not in (3, 0xFFFE):
        raise ValueError('expected 32-bit float samples')
    count = len(samples) // 4
    values = struct.unpack('<%df' % count, samples[:count * 4])
    return rate, list(values[0::channels])


def db(x):
    return 20.0 * math.log10(x) if x > 1e-10 else -200.0


def tone_share(x, hz, rate):
    w = 2.0 * math.pi * hz / rate
    coeff = 2.0 * math.cos(w)
    s1 = s2 = energy = 0.0
    for v in x:
        s0 = v + coeff * s1 - s2
        s2, s1 = s1, s0
        energy += v * v
    power = s1 * s1 + s2 * s2 - coeff * s1 * s2
    return 2.0 * power / (len(x) * energy) if energy > 0 else 0.0


def envelope(x, block):
    return [math.sqrt(sum(v * v for v in x[i:i + block]) / block) for i in range(0, len(x) - block + 1, block)]


def onsets(env, threshold, quiet_blocks):
    out = []
    quiet = quiet_blocks
    for i, e in enumerate(env):
        if e >= threshold:
            if quiet >= quiet_blocks:
                out.append(i)
            quiet = 0
        else:
            quiet += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sink', required=True)
    ap.add_argument('--source')
    ap.add_argument('--own-hz', type=float, required=True)
    ap.add_argument('--remote-hz', type=float, required=True)
    ap.add_argument('--skip-s', type=float, default=1.0, help='ignore the first seconds (start-up)')
    a = ap.parse_args()

    rate, sink = read_float_wav(a.sink)
    skip = int(a.skip_s * rate)
    body = sink[skip:]
    rms = math.sqrt(sum(v * v for v in body) / max(1, len(body)))
    print('sink: %s, %.2f s analysed (first %.1f s skipped)' % (a.sink, len(body) / rate, a.skip_s))
    print('sink RMS %.2f dBFS' % db(rms))
    if rms > 1e-6:
        print('energy share at remote tone %.0f Hz: %.3f' % (a.remote_hz, tone_share(body, a.remote_hz, rate)))
        print('energy share at OWN tone %.0f Hz: %.3f  (> 0.05 = own audio coming back: feedback/duplicate)' %
              (a.own_hz, tone_share(body, a.own_hz, rate)))
    if not a.source:
        return 0
    _, src = read_float_wav(a.source)
    n = min(len(src), len(sink))
    block = rate // 1000  # 1 ms
    env_src = envelope(src[:n], block)
    env_sink = envelope(sink[:n], block)
    peak_src = max(env_src) if env_src else 0.0
    peak_sink = max(env_sink[int(a.skip_s * 1000):]) if len(env_sink) > a.skip_s * 1000 else 0.0
    if peak_src <= 0 or peak_sink <= 0:
        print('burst delay: no bursts found')
        return 0
    s_on = [i for i in onsets(env_src, 0.3 * peak_src, 100) if i >= a.skip_s * 1000]
    k_on = onsets(env_sink, 0.3 * peak_sink, 100)
    delays = []
    for t in s_on:
        match = next((k for k in k_on if t <= k < t + 450), None)
        if match is not None:
            delays.append(match - t)
    print('bursts sent (after skip): %d, matched in sink within 450 ms: %d' % (len(s_on), len(delays)))
    if delays:
        d = sorted(delays)
        print('burst onset delay source -> sink: median %d ms, min %d ms, max %d ms (1 ms resolution)' %
              (d[len(d) // 2], d[0], d[-1]))
        print('returned burst level: %.2f dBFS peak envelope vs sent %.2f dBFS' % (db(peak_sink), db(peak_src)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
