"""Stdlib-only check of prototype WAV output (32-bit float or 16-bit PCM, mono).

For each file: format, frames, duration, and per-10 ms block RMS. A block is
"damaged" when its RMS differs from the file's median block RMS by more than
10 %. That suits a constant test tone: a clean local file has 0 damaged blocks;
a monitor file shows concealed segments as damaged blocks. Dominant frequency
is estimated from zero crossings.
"""
import array, struct, sys, statistics, math, hashlib


def read_wav(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('not RIFF/WAVE')
    pos, fmt, samples = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b'fmt ':
            tag, ch, rate, _, _, bits = struct.unpack('<HHIIHH', body[:16])
            if tag == 0xFFFE:  # WAVE_FORMAT_EXTENSIBLE: subformat GUID starts at byte 24
                tag = struct.unpack('<H', body[24:26])[0]
            fmt = (tag, ch, rate, bits)
        elif cid == b'data':
            tag, ch, rate, bits = fmt
            if tag == 3 and bits == 32:
                samples = array.array('f'); samples.frombytes(body[:len(body) // 4 * 4])
            elif tag == 1 and bits == 16:
                samples = array.array('h'); samples.frombytes(body[:len(body) // 2 * 2])
                samples = array.array('f', (s / 32768.0 for s in samples))
            else:
                raise ValueError(f'unsupported format {fmt}')
        pos += 8 + size + (size & 1)
    return fmt, samples, data


def main():
    for path in sys.argv[1:]:
        fmt, s, raw = read_wav(path)
        rate = fmt[2]
        blk = rate // 100
        rms = [math.sqrt(sum(x * x for x in s[i:i + blk]) / blk) for i in range(0, len(s) - blk + 1, blk)]
        med = statistics.median(rms) if rms else 0.0
        bad = sum(1 for r in rms if med > 0 and abs(r - med) / med > 0.10)
        zc = sum(1 for i in range(1, len(s)) if (s[i - 1] < 0) != (s[i] < 0))
        freq = zc / 2 / (len(s) / rate) if len(s) else 0
        print(f'{path.split("/")[-1]:28s} fmt={fmt} frames={len(s)} dur={len(s)/rate:.2f}s '
              f'median_block_rms={med:.4f} damaged_10ms_blocks={bad}/{len(rms)} '
              f'approx_freq={freq:.0f}Hz sha256={hashlib.sha256(raw).hexdigest()[:16]}')


if __name__ == '__main__':
    main()
