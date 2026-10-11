#!/usr/bin/env bash
# Two copies of a duplexrec prototype on 127.0.0.1, null audio, test tones.
# A presses r at ~3 s and again at ~9 s, quits at ~14 s; B quits at ~15 s.
# usage: loopback.sh <exe> <outdir> "<extra args A>" "<extra args B>"
exe="$1"; out="$2"; xa="$3"; xb="$4"
mkdir -p "$out/A" "$out/B"
( sleep 3; echo r; sleep 6; echo r; sleep 5; echo q ) | \
  "$exe" --peer 127.0.0.1 --port 51000 --peer-port 51002 --name A --null-audio --tone 440 --out-dir "$out/A" $xa \
  > "$out/A.stdout" 2> "$out/A.stderr" &
pa=$!
( sleep 15; echo q ) | \
  "$exe" --peer 127.0.0.1 --port 51002 --peer-port 51000 --name B --null-audio --tone 660 --out-dir "$out/B" $xb \
  > "$out/B.stdout" 2> "$out/B.stderr" &
pb=$!
wait $pa; echo "A exit=$?"
wait $pb; echo "B exit=$?"
