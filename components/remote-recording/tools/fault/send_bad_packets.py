#!/usr/bin/env python3
"""Fault-injection tool for the PP1 acceptance tests (T-05e, T-07b, T-12).

Sends deliberately malformed UDP media datagrams and fake TCP control frames at a
running ProducerStudio / PerformerClient (or rr_session_probe). It never sends a
*valid* audio packet unless you ask for one with `--case valid-audio`, which exists
only to prove the receiver still accepts good traffic from a non-peer address.

Wire formats implemented here are copied from the code, not from prose:
  * UDP media header v1  -> libs/media/include/rr/media/MediaPacket.h (ADR-008, ADR-017)
  * TCP control frame    -> libs/network/include/rr/network/ControlProtocol.h (ADR-016)

Nothing here is a security tool. It produces corruption and protocol errors so the
receiver's counters and refusals can be observed (ERR-07, SEC-02, SEC-03).

Usage
-----
  List the cases:
      python send_bad_packets.py --list

  T-12, every malformed case against the performer's live port:
      python send_bad_packets.py --host 192.168.8.21 --port 45002 --session 1a2b3c4d --case all

  T-12, one case, printed instead of sent:
      python send_bad_packets.py --session 1a2b3c4d --case bad-crc --dry-run

  T-05(e), a HELLO offering protocol 9.0 to the producer's control port:
      python send_bad_packets.py --host 192.168.8.20 --control-port 45000 \
          --case hello-bad-version

Exit code is 0 when every selected case was sent, 1 otherwise.
"""

from __future__ import annotations

import argparse
import binascii
import socket
import struct
import sys
import time

# --- media header v1 (MediaPacket.h) -------------------------------------
HEADER_BYTES = 26
MAX_DATAGRAM_BYTES = 1472
HEADER_VERSION = 1

STREAM_PRODUCER_MIC = 1
STREAM_PERFORMER_MIC = 2

TYPE_AUDIO = 0
TYPE_PROBE_REQ = 1          # designed, not implemented -> must be rejected as bad_type
TYPE_END_OF_STREAM = 3
TYPE_RECEIVER_REPORT = 4

CODEC_OPUS = 0x01
FLAG_MUTED = 0x04

# --- control frame (ControlProtocol.h) -----------------------------------
MSG_HELLO = 0x0001
TAG_SENT_NS = 1
TAG_PROTO_MAJOR = 2
TAG_PROTO_MINOR = 3
TAG_ROLE = 4
TAG_APP_VERSION = 5
ROLE_PERFORMER = 2


def media_packet(
    seq: int = 1,
    media_index: int = 0,
    session: int = 0x1A2B3C4D,
    stream: int = STREAM_PRODUCER_MIC,
    ptype: int = TYPE_AUDIO,
    flags: int = CODEC_OPUS,
    payload: bytes = b"\x78" * 40,
    *,
    version: int = HEADER_VERSION,
    declared_len: int | None = None,
    break_crc: bool = False,
) -> bytes:
    """Builds a datagram. Every deviation is explicit, so a 'valid' call is valid.

    declared_len overrides the payload_len field without changing the payload, which
    is how the oversized-length-field case is produced.
    """
    stated = len(payload) if declared_len is None else declared_len
    head = bytearray(HEADER_BYTES)
    struct.pack_into(">I", head, 0, seq & 0xFFFFFFFF)
    struct.pack_into(">Q", head, 4, media_index & 0xFFFFFFFFFFFFFFFF)
    struct.pack_into(">I", head, 12, session & 0xFFFFFFFF)
    struct.pack_into(">H", head, 16, stream & 0xFFFF)
    struct.pack_into(">H", head, 18, stated & 0xFFFF)
    head[20] = ((version & 0x0F) << 4) | (ptype & 0x0F)
    head[21] = flags & 0xFF
    # CRC-32/IEEE over bytes 0..21 and the payload (ADR-008). zlib.crc32 is the same
    # polynomial, init and final xor as crc32_ieee() in MediaPacket.cpp.
    crc = binascii.crc32(bytes(head[:22]) + payload) & 0xFFFFFFFF
    if break_crc:
        crc ^= 0x00000001
    struct.pack_into(">I", head, 22, crc)
    return bytes(head) + payload


def control_frame(msg_type: int, msg_id: int, fields: list[tuple[int, bytes]]) -> bytes:
    """u32 length | u16 type | u16 reserved | u32 msg_id | u32 ref_id | TLVs."""
    body = bytearray()
    body += struct.pack(">HHII", msg_type, 0, msg_id, 0)
    for tag, value in sorted(fields):
        body += struct.pack(">HH", tag, len(value)) + value
    return struct.pack(">I", len(body)) + bytes(body)


def hello_frame(major: int, minor: int) -> bytes:
    now_ns = time.monotonic_ns()
    return control_frame(
        MSG_HELLO,
        1,
        [
            (TAG_SENT_NS, struct.pack(">q", now_ns)),
            (TAG_PROTO_MAJOR, struct.pack(">H", major)),
            (TAG_PROTO_MINOR, struct.pack(">H", minor)),
            (TAG_ROLE, struct.pack(">B", ROLE_PERFORMER)),
            (TAG_APP_VERSION, b"fault-tool/0.1.0"),
        ],
    )


# --- the cases --------------------------------------------------------------
# name -> (transport, expected counter / behaviour, builder)
# "expected" is what the receiver should report. It is what you record as evidence.

def build_cases(session: int, stream: int) -> dict:
    valid_payload = b"\x78" * 40
    return {
        "truncated": (
            "udp",
            "bad_length (datagram shorter than the 26-byte header)",
            lambda: media_packet(session=session, stream=stream)[:17],
        ),
        "empty": (
            "udp",
            "bad_length (zero-byte datagram)",
            lambda: b"",
        ),
        "oversized-length-field": (
            "udp",
            "bad_length (payload_len says 1400, datagram carries 40)",
            lambda: media_packet(session=session, stream=stream, declared_len=1400),
        ),
        "short-length-field": (
            "udp",
            "bad_length (payload_len says 1, datagram carries 40)",
            lambda: media_packet(session=session, stream=stream, declared_len=1),
        ),
        "bad-version": (
            "udp",
            "bad_version (version nibble 0: a pre-ADR-008 prototype packet)",
            lambda: media_packet(session=session, stream=stream, version=0),
        ),
        "unknown-type": (
            "udp",
            "bad_type (type 1 = PROBE_REQ, designed but not implemented)",
            lambda: media_packet(session=session, stream=stream, ptype=TYPE_PROBE_REQ),
        ),
        "reserved-type": (
            "udp",
            "bad_type (type 7 is not defined at all)",
            lambda: media_packet(session=session, stream=stream, ptype=7),
        ),
        "bad-crc": (
            "udp",
            "bad_crc (one bit flipped in the CRC after it was computed)",
            lambda: media_packet(session=session, stream=stream, break_crc=True),
        ),
        "corrupt-payload": (
            "udp",
            "bad_crc (payload altered after the CRC was computed over the original)",
            lambda: bytearray(media_packet(session=session, stream=stream))[:-1] + b"\xff",
        ),
        "wrong-session": (
            "udp",
            "bad_session (session id 0xdeadbeef is not this session)",
            lambda: media_packet(session=0xDEADBEEF, stream=stream),
        ),
        "bad-codec": (
            "udp",
            "bad_payload (codec nibble 2: not Opus)",
            lambda: media_packet(session=session, stream=stream, flags=0x02),
        ),
        "reserved-flags": (
            "udp",
            "bad_payload (reserved flag bits 3-7 set)",
            lambda: media_packet(session=session, stream=stream, flags=CODEC_OPUS | 0x80),
        ),
        "empty-audio-payload": (
            "udp",
            "bad_payload (AUDIO with a zero-length payload)",
            lambda: media_packet(session=session, stream=stream, payload=b""),
        ),
        "eos-with-payload": (
            "udp",
            "bad_payload (END_OF_STREAM must carry no payload and no flags)",
            lambda: media_packet(
                session=session, stream=stream, ptype=TYPE_END_OF_STREAM, flags=0, payload=b"\x01\x02"
            ),
        ),
        "short-report": (
            "udp",
            "bad_payload (RECEIVER_REPORT must be exactly 64 bytes)",
            lambda: media_packet(
                session=session, stream=stream, ptype=TYPE_RECEIVER_REPORT, flags=0, payload=b"\x00" * 16
            ),
        ),
        "unknown-stream": (
            "udp",
            "bad_payload (stream_id 9 is neither 1 nor 2)",
            lambda: media_packet(session=session, stream=9),
        ),
        "valid-audio": (
            "udp",
            "src_rejected IF this tool is not the paired peer; otherwise the packet is accepted "
            "- run it from a third address or port to show source filtering (SEC-02)",
            lambda: media_packet(session=session, stream=stream, payload=valid_payload),
        ),
        "hello-bad-version": (
            "tcp",
            "the control link refuses the connection with a version-mismatch error (T-05e)",
            lambda: hello_frame(9, 0),
        ),
        "hello-zero-version": (
            "tcp",
            "the control link refuses protocol 0.0 (T-05e)",
            lambda: hello_frame(0, 0),
        ),
        "control-garbage": (
            "tcp",
            "the frame decoder rejects a frame whose length field is out of range and closes the "
            "connection, without crashing",
            lambda: struct.pack(">I", 0xFFFFFFF0) + b"\x00" * 16,
        ),
    }


def main() -> int:
    p = argparse.ArgumentParser(
        description="Send malformed media datagrams and control frames for tests T-05e, T-07b and T-12.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--host", default="127.0.0.1", help="target IP (the PC under test)")
    p.add_argument("--port", type=int, default=45002, help="target UDP live-audio port")
    p.add_argument("--control-port", type=int, default=45000, help="target TCP control port")
    p.add_argument(
        "--session",
        default="1a2b3c4d",
        help="the session id under test, 8 hex digits, as shown in the app (used so the packet is "
        "rejected for the reason under test and not simply as a wrong session)",
    )
    p.add_argument(
        "--stream",
        type=int,
        default=STREAM_PRODUCER_MIC,
        choices=[STREAM_PRODUCER_MIC, STREAM_PERFORMER_MIC],
        help="1 = producer mic, 2 = performer mic",
    )
    p.add_argument("--case", default="all", help="case name, a comma-separated list, or 'all'")
    p.add_argument("--list", action="store_true", help="list the cases and what each should produce")
    p.add_argument("--repeat", type=int, default=1, help="send each selected case this many times")
    p.add_argument("--gap-ms", type=int, default=50, help="pause between sends")
    p.add_argument(
        "--source-port",
        type=int,
        default=0,
        help="bind the UDP socket to this local port. Use a port that is NOT the paired peer's to "
        "exercise source-address filtering (SEC-02).",
    )
    p.add_argument("--dry-run", action="store_true", help="print the bytes instead of sending them")
    args = p.parse_args()

    try:
        session = int(args.session, 16)
    except ValueError:
        print(f"error: --session must be 8 hex digits, got {args.session!r}", file=sys.stderr)
        return 1
    if session == 0:
        print("error: session id 0 is never valid", file=sys.stderr)
        return 1

    cases = build_cases(session, args.stream)

    if args.list:
        width = max(len(n) for n in cases)
        for name, (transport, expected, _) in cases.items():
            print(f"{name:<{width}}  [{transport}]  {expected}")
        return 0

    if args.case == "all":
        selected = [n for n, (t, _, _) in cases.items() if t == "udp"]
    else:
        selected = [n.strip() for n in args.case.split(",") if n.strip()]
        unknown = [n for n in selected if n not in cases]
        if unknown:
            print(f"error: unknown case(s): {', '.join(unknown)}. Use --list.", file=sys.stderr)
            return 1

    print(f"# target {args.host} udp/{args.port} tcp/{args.control_port}, session {args.session}, "
          f"stream {args.stream}")
    if args.dry_run:
        print("# DRY RUN - nothing is sent")

    udp = None
    failures = 0
    for name in selected:
        transport, expected, build = cases[name]
        try:
            data = bytes(build())
        except Exception as exc:  # a builder bug must not look like a receiver result
            print(f"{name}: BUILD FAILED: {exc}", file=sys.stderr)
            failures += 1
            continue

        print(f"\n{name} [{transport}] {len(data)} bytes")
        print(f"  expect: {expected}")

        if args.dry_run:
            print(f"  bytes : {data[:48].hex(' ')}{' ...' if len(data) > 48 else ''}")
            continue

        for attempt in range(args.repeat):
            try:
                if transport == "udp":
                    if udp is None:
                        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        if args.source_port:
                            udp.bind(("", args.source_port))
                    udp.sendto(data, (args.host, args.port))
                else:
                    with socket.create_connection((args.host, args.control_port), timeout=5) as tcp:
                        tcp.sendall(data)
                        tcp.settimeout(2.0)
                        try:
                            reply = tcp.recv(4096)
                        except socket.timeout:
                            reply = b""
                        if reply:
                            print(f"  reply : {len(reply)} bytes: {reply[:48].hex(' ')}")
                        else:
                            print("  reply : none (connection closed or silent)")
            except OSError as exc:
                print(f"  SEND FAILED: {exc}", file=sys.stderr)
                failures += 1
                break
            if attempt + 1 < args.repeat:
                time.sleep(args.gap_ms / 1000.0)
        else:
            print(f"  sent  : {args.repeat}x")

    if udp is not None:
        udp.close()

    print(
        "\n# Now read the receiver's counters (app: Live audio panel / Export live report;"
        "\n# probe: rr_session_probe --report) and file them as evidence for the test."
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
