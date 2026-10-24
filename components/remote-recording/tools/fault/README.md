# Fault injection (tests T-05e, T-07b, T-12)

`send_bad_packets.py` is the tool named in
[PP1_ACCEPTANCE_MATRIX.md §2](../../docs/requirements/PP1_ACCEPTANCE_MATRIX.md): it sends
malformed UDP media datagrams and fake control frames so the receiver's refusals and
counters can be observed. Python 3.9+, standard library only, no install.

It builds packets from the layouts in `libs/media/include/rr/media/MediaPacket.h`
(ADR-008 header v1) and `libs/network/include/rr/network/ControlProtocol.h`
(ADR-016 frame), so the two stay in step. **If either layout changes, change this tool.**

## Cases

```powershell
python tools\fault\send_bad_packets.py --list
```

17 UDP cases cover every rejection reason in `PacketCheck`: `bad_length` (4 ways),
`bad_version`, `bad_type` (2), `bad_crc` (2), `bad_session`, `bad_payload` (5), plus
`valid-audio` for source filtering. 3 TCP cases cover the version-mismatch HELLO and a
frame with an out-of-range length field.

## Running T-12

With a session live and a take recording, from a PC that is **not** the paired peer
(or at least from a different source port):

```powershell
python tools\fault\send_bad_packets.py --host <PC-R ip> --port <live udp port> `
    --session <8 hex digits from the app> --case all
```

Then read the receiver's counters (app: **Live audio panel → Export live report**;
probe: `rr_session_probe --report`) and file them under
`docs/testing/evidence/PP1/<date>/T-12/`. The take must finish COMPLETE on both PCs
and no injected audio may be heard — that is the actual pass condition, not the counts.

## Running T-05(e)

With the producer listening and no performer joined:

```powershell
python tools\fault\send_bad_packets.py --host <PC-P ip> --control-port <control port> `
    --case hello-bad-version
```

The producer must refuse with a version-mismatch message and stay usable; a real
performer must still be able to join afterwards.

## T-07b

T-07b (ARM never acknowledged) is **not** implemented here. The matrix offers a simpler
route that needs no tool: block PC-R's control port after pairing, then press Record.
Use that. A fake performer that pairs correctly, answers heartbeats and then ignores
only the ARM would have to reimplement most of the control link, and a tool that drifts
from the real one is worse than no tool.

## Honesty note

This sends corruption and protocol errors. It is not an attacker and proves nothing
about security — the build is unencrypted and unauthenticated by design (ADR-012). What
it demonstrates is input validation and that bad input cannot disturb a local recording.
