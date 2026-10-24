#!/usr/bin/env python3
"""Tabulate the Stage 9 "take_timing" log records of a producer and a performer.

Usage: analyse_take_timing.py <producer.jsonl> <performer.jsonl> [--same-pc]

Per take: outcome, frames on each PC, the producer's ESTIMATED recording-start offset
(performer first sample - producer first sample, converted with the clock-offset estimate theta)
and its uncertainty (+/- u, the clock-offset uncertainty only), each side's first sample relative
to its own scheduled time, and the command/acknowledgement intervals.

--same-pc: both processes ran on ONE PC, so both logs use the same monotonic clock
(QueryPerformanceCounter is system-wide). Then the first-sample times can be compared DIRECTLY,
giving a measured start difference with a known true clock offset of 0, and the error of the
theta estimate. This checks the scheduling mechanism; it is NOT a two-PC result, and neither
number includes device input latency (the time from the microphone to the capture callback).
"""
import json
import statistics
import sys


def records(path):
    out = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('event') == 'take_timing':
                out[int(r['fields']['take'])] = r['fields']
    return out


def num(fields, key):
    v = fields.get(key, 'n/a')
    try:
        return float(v)
    except ValueError:
        return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    same_pc = '--same-pc' in sys.argv
    if len(args) != 2:
        print(__doc__)
        return 2
    prod, perf = records(args[0]), records(args[1])
    print('take outcome(producer/performer) frames(prod/perf) est_offset_ms +/-u_ms '
          'first_sample_vs_schedule_ms(prod/perf) arm->ack_ms sched->ack_ms ack_margin_ms'
          + (' MEASURED_shared_clock_ms theta_error_ms' if same_pc else ''))
    measured, estimated, unc = [], [], []
    for take in sorted(prod):
        a = prod[take]
        b = perf.get(take, {})
        row = '%4d %s/%s %s/%s %s %s %s/%s %s %s %s' % (
            take, a.get('outcome'), b.get('outcome', 'missing'), a.get('local_frames'), b.get('local_frames', '-'),
            a.get('start_offset_estimate_ms'), a.get('start_offset_uncertainty_ms'),
            a.get('first_sample_minus_scheduled_ms'), b.get('first_sample_minus_scheduled_ms', '-'),
            a.get('arm_to_ack_ms'), a.get('schedule_to_ack_ms'), a.get('ack_margin_before_start_ms'))
        if same_pc and b:
            pa, pb = num(a, 'local_first_sample_ns'), num(b, 'local_first_sample_ns')
            th = num(a, 'theta_ns')
            if pa and pb:
                m = (pb - pa) / 1e6
                measured.append(m)
                est = num(a, 'start_offset_estimate_ms')
                if est is not None:
                    estimated.append(est)
                u = num(a, 'start_offset_uncertainty_ms')
                if u is not None:
                    unc.append(u)
                row += ' %.3f %.3f' % (m, (th or 0.0) / 1e6)
        print(row)
    if measured:
        print('measured start difference (shared clock): mean %.3f ms, min %.3f ms, max %.3f ms, n=%d' %
              (statistics.mean(measured), min(measured), max(measured), len(measured)))
    if estimated:
        print('estimated offset: mean %.3f ms, |max| %.3f ms; reported uncertainty u: max %.3f ms' %
              (statistics.mean(estimated), max(abs(e) for e in estimated), max(unc) if unc else float('nan')))
        if measured and len(measured) == len(estimated):
            errs = [e - m for e, m in zip(estimated, measured)]
            print('estimate - measured: max |%.3f| ms' % max(abs(x) for x in errs))
    return 0


if __name__ == '__main__':
    sys.exit(main())
