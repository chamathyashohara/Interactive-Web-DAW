import { TICKS_PER_BAR, type AutoPoint, type Project, type Track } from "@daw/shared";
import type { CheckResult } from "../types";
import { soundOfTrack } from "./checks";
import { toDb } from "./meters";
import { PHRASES, barTick, chordPcs, rootPc } from "./songParts";
import type { StudioCheck, StudioCtx } from "./types";

/**
 * Checks for the Make a Song lessons. They work in "elements" (piano, pads, kick, hats, clap, bass, arp, melody, fx), the
 * words the plan uses, found from the track (its lesson part, its drum notes, its sound or its name). Bars count from 1.
 */

export type Element = "piano" | "pads" | "kick" | "hats" | "clap" | "bass" | "arp" | "melody" | "fx" | "other";
const DRUM_ELEMENT: Record<number, Element> = { 35: "kick", 36: "kick", 42: "hats", 44: "hats", 46: "hats", 38: "clap", 39: "clap", 40: "clap" };
const WORDS: Record<Exclude<Element, "other">, string> = { piano: "piano", pads: "pads", kick: "kick", hats: "hats", clap: "clap", bass: "bass", arp: "arp", melody: "melody", fx: "fx" };

/** The element a non-drum track plays. */
export function trackElement(t: Track, ctx: StudioCtx): Element {
  const part = /^lesson-song-(\w+)$/.exec(t.id)?.[1];
  if (part && part !== "drums") return part as Element;
  const s = soundOfTrack(t, ctx);
  if (s) {
    if (s.category === "Kick") return "kick";
    if (s.category === "Hat") return "hats";
    if (s.category === "Clap" || s.category === "Snare") return "clap";
    if (s.category === "Bass" || s.sub === "Bass Loop") return "bass";
    if (s.category === "Pad" || s.sub === "Chord Loop") return "pads";
    if (s.category === "Keys") return "piano";
    if (s.category === "FX") return "fx";
  }
  const n = t.name.toLowerCase();
  if (/bass/.test(n)) return "bass";
  if (/arp/.test(n)) return "arp";
  if (/melod|lead/.test(n)) return "melody";
  if (/pad|string/.test(n)) return "pads";
  if (/piano|keys|chord/.test(n)) return "piano";
  return "other";
}

interface Hit {
  track: Track;
  element: Element;
  pitch: number;
  start: number;
  end: number;
  velocity: number;
}
/** Every unmuted note in song time, tagged with its element. */
function hits(p: Project, ctx: StudioCtx, audibleOnly = true): Hit[] {
  const anySolo = Object.values(p.tracks).some((t) => t.solo);
  const out: Hit[] = [];
  for (const id of p.trackOrder) {
    const t = p.tracks[id]!;
    if (audibleOnly && (t.mute || (anySolo && !t.solo))) continue;
    const el = t.instrument === "drums" ? null : trackElement(t, ctx);
    for (const c of Object.values(t.clips))
      for (const n of Object.values(c.notes)) {
        if (n.muted) continue;
        out.push({ track: t, element: el ?? DRUM_ELEMENT[n.pitch] ?? "other", pitch: n.pitch, start: c.startTick + n.startTick, end: c.startTick + n.startTick + n.durationTicks, velocity: n.velocity });
      }
  }
  return out;
}
const inBars = (h: Hit[], from: number, to: number) => h.filter((x) => x.start < barTick(to + 1) && x.end > barTick(from));
const startsIn = (h: Hit[], bar: number) => h.filter((x) => x.start >= barTick(bar) && x.start < barTick(bar + 1));
const elementsIn = (h: Hit[], from: number, to: number): Set<Element> => new Set(inBars(h, from, to).map((x) => x.element).filter((e) => e !== "other" && e !== "fx"));
const bars = (a: number, b: number) => (a === b ? `bar ${a}` : `bars ${a}-${b}`);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** The filter curve's value at a tick (held before the first point and after the last, straight lines between). */
export function curveAt(points: AutoPoint[], tick: number): number {
  const ps = [...points].sort((a, b) => a.tick - b.tick);
  if (!ps.length) return 1;
  if (tick <= ps[0]!.tick) return ps[0]!.value;
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1]!, b = ps[i]!;
    if (tick <= b.tick) return b.tick === a.tick ? b.value : a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
  }
  return ps[ps.length - 1]!.value;
}
/** The automation lane's 0-1 value as a cutoff frequency (20 Hz to 20 kHz, log scale), and back. */
export const valueToHz = (v: number) => 20 * Math.pow(1000, v);
export const hzToValue = (hz: number) => Math.log(hz / 20) / Math.log(1000);
const hzText = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`);

const filters = (p: Project) => p.trackOrder.map((id) => p.tracks[id]!).filter((t) => t.automation?.filter?.length);

function result(items: { label: string; ok: boolean; fix: string }[], success: string): CheckResult {
  const missing = items.find((i) => !i.ok);
  const ok = items.filter((i) => i.ok).length;
  return { pass: !missing, score: items.length ? ok / items.length : 1, feedback: missing ? missing.fix : success, items: items.map(({ label, ok }) => ({ label, ok })) };
}

/** FX clips: build-up sweeps (Riser, Sweep Up) and down filters (Downlifter, Sweep Down). */
function fxClips(p: Project, ctx: StudioCtx) {
  const out: { kind: "into" | "after"; start: number; end: number; name: string }[] = [];
  for (const t of Object.values(p.tracks)) {
    if (t.mute) continue;
    const s = soundOfTrack(t, ctx);
    const name = (t.sample?.name ?? t.name).toLowerCase();
    const kind = s?.sub === "Riser" || (/sweep/.test(name) && /up/.test(name)) || /riser/.test(name) ? "into" : s?.sub === "Downlifter" || (/sweep/.test(name) && /down/.test(name)) || /downlifter/.test(name) ? "after" : null;
    if (!kind) continue;
    for (const c of Object.values(t.clips)) out.push({ kind, start: c.startTick, end: c.startTick + c.lengthTicks, name: t.name });
  }
  return out;
}

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (pitch: number) => `${NOTE[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
const CHORD_NAMES = ["Am (A C E)", "F (F A C)", "C (C E G)", "G (G B D)"];
/** Which Special task makes each element of the song. */
const MADE_BY: Record<string, string> = {
  piano: "Piano: Special task 1 (chords, pads and melody)",
  pads: "Piano: Special task 1 (chords, pads and melody)",
  melody: "Piano: Special task 1 (chords, pads and melody)",
  bass: "Piano: Special task 2 (bass and arp)",
  arp: "Piano: Special task 2 (bass and arp)",
  kick: "Drum sequencer: Special task (the drum beat)",
  hats: "Drum sequencer: Special task (the drum beat)",
  clap: "Drum sequencer: Special task (the drum beat)",
  fx: "Kick Drums: Special task (the transitions)",
};

export function runSongCheck(p: Project, check: StudioCheck, ctx: StudioCtx): CheckResult | null {
  switch (check.kind) {
    case "progression": {
      const piano = hits(p, ctx).filter((x) => x.element === "piano");
      const bad = range(check.bars[0], check.bars[1]).find((bar) => {
        const at = startsIn(piano, bar).filter((x) => x.start === barTick(bar));
        const pcs = new Set(at.map((x) => x.pitch % 12));
        return at.length < 3 || chordPcs(bar).some((pc) => !pcs.has(pc)) || [...pcs].some((pc) => !chordPcs(bar).includes(pc));
      });
      return result(
        [{ label: `Am - F - C - G in ${bars(...check.bars)}`, ok: bad === undefined, fix: bad === undefined ? "" : `Bar ${bad} should be ${CHORD_NAMES[(bad - 1) % 4]}, three notes starting on the bar line. Follow the faint notes.` }],
        "The chords of the song: Am, F, C, G.",
      );
    }
    case "phrase": {
      const mel = hits(p, ctx).filter((x) => x.element === "melody");
      const from = barTick(check.from);
      const have = mel.filter((x) => x.start >= from && x.start < from + 4 * TICKS_PER_BAR).map((x) => ({ start: x.start - from, pitch: x.pitch, len: x.end - x.start }));
      const want = PHRASES[check.letter].map(([bar, beat, len, pitch]) => ({ start: (bar - 1) * TICKS_PER_BAR + Math.round((beat - 1) * 960), pitch, len: Math.round(len * 960) }));
      const missing = want.find((w) => !have.some((h) => h.start === w.start && h.pitch === w.pitch && Math.abs(h.len - w.len) <= 120));
      const extra = have.find((h) => !want.some((w) => w.start === h.start && w.pitch === h.pitch));
      const where = (t: number) => `bar ${check.from + Math.floor(t / TICKS_PER_BAR)}, beat ${Math.floor((t % TICKS_PER_BAR) / 960) + 1}${t % 960 ? "½" : ""}`;
      return result(
        [
          { label: `Phrase ${check.letter} in bars ${check.from}-${check.from + 3}`, ok: !missing, fix: missing ? `Missing: ${noteName(missing.pitch)} at ${where(missing.start)}, ${missing.len / 960} beat(s) long. Follow the faint notes.` : "" },
          { label: "No extra notes", ok: !extra, fix: extra ? `Extra note ${noteName(extra.pitch)} at ${where(extra.start)}: delete it.` : "" },
        ],
        `Phrase ${check.letter} is in place.`,
      );
    }
    case "hasNotes": {
      const el = hits(p, ctx).filter((x) => x.element === check.element);
      const gap = range(check.bars[0], check.bars[1]).find((bar) => !startsIn(el, bar).length);
      return result([{ label: `${check.element} plays in ${bars(...check.bars)}`, ok: gap === undefined, fix: `The ${check.element} track has nothing in bar ${gap}. Copy the clips onto it so every bar is covered.` }], `The ${check.element} track plays all through.`);
    }
    case "songBars":
      return result([{ label: `Song is ${check.bars} bars long`, ok: p.songBars >= check.bars, fix: `Set the song length to ${check.bars} bars (Song bars, at the top of the workspace).` }], `The song is ${p.songBars} bars long.`);
    case "parts": {
      const els = elementsIn(hits(p, ctx), 1, p.songBars);
      const need = ["piano", "pads", "melody", "bass", "arp", "kick", "hats", "clap"] as Element[];
      const missing = [...need.filter((e) => !els.has(e)), ...(fxClips(p, ctx).length ? [] : ["fx" as Element])];
      return result(
        [{ label: "Every part of the song is in your Studio", ok: !missing.length, fix: missing.length ? `Missing: ${missing.join(", ")}. Do ${[...new Set(missing.map((e) => MADE_BY[e]))].join("; ")}, then press Apply it in the studio.` : "" }],
        "All the parts you made are here: chords, pads, melody, bass, arp, drums and transitions.",
      );
    }
    case "tempoLoop":
      return result(
        [
          { label: `Tempo is ${check.bpm} BPM`, ok: p.tempo === check.bpm, fix: `Type ${check.bpm} in the BPM box (it is ${p.tempo} now) and press Enter.` },
          { label: "Loop is on", ok: Boolean(p.loop), fix: "Press Loop so the start of the song plays over and over." },
        ],
        `The song runs at ${check.bpm} BPM, looping while you work.`,
      );
    case "repeated": {
      const h = hits(p, ctx).filter((x) => x.element === "piano");
      const [a, b] = check.bars;
      const missing = range(a, b).filter((bar) => startsIn(h, bar).filter((x) => x.start === barTick(bar)).length < 3);
      const pitches = h.map((x) => x.pitch);
      const inRange = pitches.length > 0 && Math.min(...pitches) >= 48 && Math.max(...pitches) <= 84;
      return result(
        [
          { label: `Chords on every bar ${a}-${b}`, ok: missing.length === 0, fix: `${bars(missing[0] ?? a, missing[0] ?? a)} has no chord. Duplicate the clip (Ctrl+D) until the progression fills bars ${a}-${b}.` },
          { label: "In a comfortable range (C3-C6)", ok: inRange, fix: "The chords are too high or too low. Use Octave ↓ or Octave ↑ until they sit around middle C again." },
        ],
        `The progression plays ${(b - a + 1) / 4} times: ${b - a + 1} bars.`,
      );
    }
    case "layered": {
      const [a, b] = check.bars;
      const all = hits(p, ctx);
      const piano = all.filter((x) => x.element === "piano");
      const layer = all.filter((x) => x.element !== "piano" && ["pads", "other", "arp"].includes(x.element) && x.track.instrument !== "drums");
      const missing = range(a, b).filter((bar) => {
        const want = new Set(startsIn(piano, bar).map((x) => x.pitch % 12));
        const got = new Set(startsIn(layer, bar).map((x) => x.pitch % 12));
        return got.size < 3 || [...want].some((pc) => !got.has(pc));
      });
      return result(
        [{ label: `A second instrument plays the chords in bars ${a}-${b}`, ok: missing.length === 0, fix: layer.length ? `In ${bars(missing[0]!, missing[0]!)} the layer does not play the same chord as the piano. Copy the piano clip to the layer track again.` : "Add a pad track (+ Synth, or drop a Pad sound), then Copy to track: the piano clip onto it." }],
        "Piano and pads together: the same chords, a fuller sound.",
      );
    }
    case "intro": {
      const all = hits(p, ctx);
      const kick = all.filter((x) => x.element === "kick");
      const [q0, q1] = check.quiet;
      const [l0, l1] = check.loud;
      const early = inBars(kick, q0, q1);
      const gaps = range(l0, l1).filter((bar) => !startsIn(kick, bar).length);
      const harmony = range(q0, l1).filter((bar) => !startsIn(all.filter((x) => x.element === "piano" || x.element === "pads"), bar).length);
      return result(
        [
          { label: `No kick in ${bars(q0, q1)}`, ok: !early.length, fix: `The kick already plays in bar ${Math.floor((early[0]?.start ?? 0) / TICKS_PER_BAR) + 1}. Move the kick clip so it starts on bar ${l0}.` },
          { label: `Kick in every bar ${l0}-${l1}`, ok: !gaps.length, fix: `No kick in ${bars(gaps[0] ?? l0, gaps[0] ?? l0)}. Duplicate the kick clip so it fills bars ${l0}-${l1}.` },
          { label: `Piano and pads all through ${bars(q0, l1)}`, ok: !harmony.length, fix: `Keep the piano and pads playing in bar ${harmony[0]}.` },
        ],
        `Bars ${q0}-${q1} are piano and pads only; the kick lifts bars ${l0}-${l1}.`,
      );
    }
    case "transition": {
      const t = barTick(check.bar);
      const fx = fxClips(p, ctx);
      const into = fx.some((f) => f.kind === "into" && f.end === t);
      const after = fx.some((f) => f.kind === "after" && f.start === t);
      const ok = check.type === "into" ? into : check.type === "after" ? after : check.type === "pair" ? into && after : into || after;
      const near = fx.find((f) => Math.abs((f.kind === "into" ? f.end : f.start) - t) <= 4 * TICKS_PER_BAR);
      const fix =
        check.type === "pair"
          ? !into ? `First the sweep: drop a Riser (or Sweep Up) so it ends exactly on bar ${check.bar}.` : `Now the down filter: drop a Downlifter (or Sweep Down) so it starts on bar ${check.bar}.`
          : check.type === "after"
          ? near ? `The down filter starts at the wrong place. Drag it so it starts exactly on bar ${check.bar}.` : `Choose FX and drop a Downlifter (or Sweep Down) so it starts on bar ${check.bar}.`
          : near ? `The sweep does not end on bar ${check.bar}. Drag it (or change its length) so its end touches bar ${check.bar}.` : `Choose FX and drop a Riser (or Sweep Up) so it ends exactly on bar ${check.bar}.`;
      return result([{ label: check.type === "after" ? `A down filter from bar ${check.bar}` : check.type === "into" ? `A sweep ending on bar ${check.bar}` : check.type === "pair" ? `Sweep into bar ${check.bar} and a down filter after it` : `A transition at bar ${check.bar}`, ok, fix }], `The transition leads the ear into bar ${check.bar}.`);
    }
    case "bassRoots":
    case "bassChopped": {
      const [a, b] = check.bars;
      const bass = hits(p, ctx).filter((x) => x.element === "bass");
      const bad = range(a, b)
        .map((bar) => {
          const notes = startsIn(bass, bar);
          const wrong = notes.find((x) => x.pitch % 12 !== rootPc(bar));
          const high = notes.find((x) => x.pitch > 52);
          const count = check.kind === "bassRoots" ? notes.length !== 1 : notes.length < check.min;
          return { bar, notes, wrong, high, count };
        })
        .find((r) => r.wrong || r.high || r.count);
      const items = [
        {
          label: check.kind === "bassRoots" ? `One root note per bar, ${bars(a, b)}` : `At least ${check.min} root notes per bar, ${bars(a, b)}`,
          ok: !bad || (!bad.wrong && !bad.count),
          fix: !bad ? "" : bad.wrong ? `Bar ${bad.bar}: keep only the root (${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][rootPc(bad.bar)]}); the highlighted lowest note of each chord.` : check.kind === "bassRoots" ? `Bar ${bad.bar} has ${bad.notes.length} bass notes. Delete all but the root.` : `Bar ${bad.bar} has only ${bad.notes.length} bass note(s). Use Chop (1/8) on the bass clip.`,
        },
        { label: "In the bass range (below E3)", ok: !bad?.high, fix: `The bass in bar ${bad?.bar} is too high. Use Octave ↓ once or twice.` },
      ];
      return result(items, check.kind === "bassRoots" ? "A bass line from the roots: it always fits the chords." : "The roots now bounce in eighths with the kick.");
    }
    case "arp": {
      const [a, b] = check.bars;
      const arp = hits(p, ctx).filter((x) => x.element === "arp");
      const bad = range(a, b)
        .map((bar) => {
          const notes = startsIn(arp, bar);
          const stacked = notes.some((x) => notes.filter((y) => y.start === x.start).length > 1);
          const off = notes.find((x) => !chordPcs(bar).includes(x.pitch % 12));
          return { bar, count: notes.length, stacked, off };
        })
        .find((r) => r.count < 4 || r.stacked || r.off);
      return result(
        [{ label: `Arpeggio in ${bars(a, b)}`, ok: !bad, fix: !bad ? "" : bad.count === 0 ? (arp.length ? `Bar ${bad.bar} has no arpeggio yet. Duplicate the arp clip so it covers bars ${a}-${b}.` : "Add an Arp track (+ Add track → Arp), copy the piano clips onto it, then apply an arp preset.") : bad.stacked ? `Bar ${bad.bar} still has chords (notes together). Select that clip and press Apply arp.` : bad.off ? `Bar ${bad.bar} has a note outside its chord.` : `Bar ${bad.bar} needs at least four arp notes: use a faster arp step.` }],
        "The chord notes ripple one after another: movement for the section.",
      );
    }
    case "stripBack": {
      const [a, b] = check.bars;
      const all = hits(p, ctx);
      const els = elementsIn(all, a, b);
      const kick = inBars(all.filter((x) => x.element === "kick"), a, b);
      return result(
        [
          { label: `No kick in ${bars(a, b)}`, ok: !kick.length, fix: `The kick still plays in ${bars(a, b)}. Delete its clips there (or mute the Kick track).` },
          { label: `At most ${check.max} elements (${els.size} now)`, ok: els.size <= check.max && els.size > 0, fix: els.size === 0 ? `Keep ${check.max} elements playing.` : `Still playing: ${[...els].join(", ")}. Keep ${check.max} and delete the others' clips in ${bars(a, b)}.` },
        ],
        `Only ${[...els].join(" and ")} left: room to grow.`,
      );
    }
    case "filterAt": {
      const t = barTick(check.bar);
      const best = filters(p).map((tr) => ({ tr, hz: valueToHz(curveAt(tr.automation!.filter!, t)) })).sort((x, y) => Math.abs(Math.log(x.hz / check.hz)) - Math.abs(Math.log(y.hz / check.hz)))[0];
      const ok = Boolean(best && best.hz >= check.hz * 0.8 && best.hz <= check.hz * 1.25);
      return result(
        [{ label: `Filter at about ${hzText(check.hz)} on bar ${check.bar}`, ok, fix: best ? `The cutoff on bar ${check.bar} is ${hzText(best.hz)}. Drag the point until it reads about ${hzText(check.hz)}.` : `Open the ∿ lane on a track, choose Filter, and click a point on bar ${check.bar}; drag it down to ${hzText(check.hz)}.` }],
        "The sound gets darker: only the low end comes through the filter.",
      );
    }
    case "filterRise": {
      const t0 = barTick(check.from), t1 = barTick(check.to);
      const rising = filters(p).find((tr) => {
        const pts = tr.automation!.filter!;
        const start = valueToHz(curveAt(pts, t0)), end = curveAt(pts, t1);
        const steps = Array.from({ length: 17 }, (_, i) => curveAt(pts, t0 + ((t1 - t0) * i) / 16));
        return start <= 1500 && end >= 0.95 && steps.every((v, i) => i === 0 || v >= steps[i - 1]! - 0.001);
      });
      const items = [{ label: `Filter opens from about 1 kHz (bar ${check.from}) to fully open (bar ${check.to})`, ok: Boolean(rising), fix: filters(p).length ? `Make the curve rise: low (about 1 kHz) on bar ${check.from}, all the way up by bar ${check.to}, never dipping on the way.` : `Open the ∿ lane on a track, choose Filter, add a low point on bar ${check.from} and a high one on bar ${check.to}.` }];
      if (check.kickBack) {
        const kick = hits(p, ctx).filter((x) => x.element === "kick");
        const gaps = range(check.kickBack[0], check.kickBack[1]).filter((bar) => !startsIn(kick, bar).length);
        items.push({ label: `Kick back in ${bars(...check.kickBack)}`, ok: !gaps.length, fix: `No kick in bar ${gaps[0]}. Bring the kick clips back for bars ${check.kickBack[0]}-${check.kickBack[1]}.` });
      }
      if (check.transitionAt) {
        const into = fxClips(p, ctx).some((f) => f.kind === "into" && f.end === barTick(check.transitionAt!));
        items.push({ label: `A sweep ending on bar ${check.transitionAt}`, ok: into, fix: `Drop a Riser so it ends exactly on bar ${check.transitionAt}.` });
      }
      return result(items, "The filter opens and the tension builds into the drop.");
    }
    case "downbeatTone": {
      const mel = hits(p, ctx).filter((x) => x.element === "melody");
      const on = mel.find((x) => x.start === barTick(check.bar));
      const ok = Boolean(on && chordPcs(check.bar).includes(on.pitch % 12));
      return result(
        [{ label: `A chord tone on beat 1 of bar ${check.bar}`, ok, fix: on ? `The note on beat 1 of bar ${check.bar} is not in the chord. Move it to G, B or D.` : `There is no note on beat 1 of bar ${check.bar}. Drag the last note left onto the bar line and onto G, B or D.` }],
        "The phrase now lands on a chord tone on the downbeat: it settles.",
      );
    }
    case "melodyPattern": {
      const mel = hits(p, ctx, false).filter((x) => x.element === "melody");
      const blocks = check.pattern.split("").map((_, i) => {
        const from = barTick(check.from + i * 4);
        return mel
          .filter((x) => x.start >= from && x.start < from + 4 * TICKS_PER_BAR)
          .map((x) => `${x.start - from}:${x.pitch}:${x.end - x.start}`)
          .sort()
          .join(",");
      });
      const letters = check.pattern.split("");
      const items: { label: string; ok: boolean; fix: string }[] = [];
      letters.forEach((l, i) => {
        const at = `bars ${check.from + i * 4}-${check.from + i * 4 + 3}`;
        if (!blocks[i]) return items.push({ label: `${l} in ${at}`, ok: false, fix: `Nothing in ${at} yet. Duplicate phrase A (Ctrl+D) into ${at}.` });
        const first = letters.indexOf(l);
        if (first < i) items.push({ label: `${l} in ${at} repeats ${l}`, ok: blocks[i] === blocks[first], fix: `${at} should be the same as ${l} (bars ${check.from + first * 4}-${check.from + first * 4 + 3}). Duplicate that clip again.` });
        else items.push({ label: `${l} in ${at} is new`, ok: letters.slice(0, i).every((m, j) => m === l || blocks[j] !== blocks[i]), fix: `${at} is a copy. Change a few notes so it becomes ${l}: a new answer or a new ending.` });
      });
      return result(items, `Phrases in ${check.pattern.split("").join("-")}: repetition, variation and an ending.`);
    }
    case "dropFull": {
      const [a, b] = check.bars;
      const all = hits(p, ctx);
      for (let from = a; from <= b; from += 8) {
        const els = elementsIn(all, from, Math.min(b, from + 7));
        const missing = check.elements.filter((e) => !els.has(e as Element));
        if (missing.length) return result([{ label: `Every element in ${bars(a, b)}`, ok: false, fix: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing in ${bars(from, Math.min(b, from + 7))}. Duplicate their clips into the drop.` }], "");
      }
      return result([{ label: `Every element in ${bars(a, b)}`, ok: true, fix: "" }], "All the elements together, plus the melody: the peak of the song.");
    }
    case "outro": {
      const [a, b] = check.bars;
      const all = hits(p, ctx);
      const counts = range(0, Math.floor((b - a + 1) / 4) - 1).map((i) => elementsIn(all, a + i * 4, a + i * 4 + 3).size);
      const falling = counts.every((n, i) => i === 0 || n < counts[i - 1]!) && counts[0]! > 0;
      const items = [
        { label: `Song is ${b} bars long`, ok: p.songBars >= b, fix: `Make the song ${b} bars long (Song + in the Studio, or duplicate clips to bar ${b}).` },
        { label: "One element fewer every 4 bars", ok: falling, fix: `Elements playing per 4 bars: ${counts.join(", ")}. Each block needs one fewer than the one before.` },
      ];
      if (check.needFilter) {
        const closing = filters(p).some((tr) => curveAt(tr.automation!.filter!, barTick(b)) <= curveAt(tr.automation!.filter!, barTick(a)) - 0.3);
        items.push({ label: "A low-pass filter closes", ok: closing, fix: `Add a filter curve that goes down from bar ${a} to bar ${b}.` });
      }
      return result(items, "The song thins out and darkens: a smooth ending.");
    }
    case "ownChannels": {
      const all = hits(p, ctx, false);
      const byTrack = new Map<string, Set<Element>>();
      for (const x of all) byTrack.set(x.track.id, (byTrack.get(x.track.id) ?? new Set()).add(x.element));
      const shared = [...byTrack].find(([, els]) => els.size > 1);
      const unnamed = check.namesToo ? [...byTrack].find(([id, els]) => els.size === 1 && !p.tracks[id]!.name.toLowerCase().includes(WORDS[[...els][0] as Exclude<Element, "other">] ?? "~")) : undefined;
      return result(
        [
          { label: "One element per track", ok: !shared, fix: shared ? `${p.tracks[shared[0]]!.name} plays ${[...shared[1]].join(", ")}. Press "One track per drum" on it.` : "" },
          ...(check.namesToo ? [{ label: "Each track named after its element", ok: !unnamed, fix: unnamed ? `Rename ${p.tracks[unnamed[0]]!.name} to ${WORDS[[...unnamed[1]][0] as Exclude<Element, "other">]} (double-click its name).` : "" }] : []),
        ],
        "Every element has its own channel: each can be mixed on its own.",
      );
    }
    case "gainStage": {
      const pk = ctx.peaks;
      if (!pk || pk.samples < 30) return result([{ label: "Measured while playing", ok: false, fix: "Press Play and let the drop play for a few seconds, then check." }], "");
      const kickIds = Object.values(p.tracks).filter((t) => hits(p, ctx).some((x) => x.track.id === t.id && x.element === "kick")).map((t) => t.id);
      const kickDb = Math.max(...kickIds.map((id) => toDb(pk.tracks[id] ?? 0)));
      const others = Object.values(p.tracks).filter((t) => !kickIds.includes(t.id) && (pk.tracks[t.id] ?? 0) > 0);
      const loud = others.find((t) => toDb(pk.tracks[t.id]!) > check.others[1]);
      const quiet = others.find((t) => toDb(pk.tracks[t.id]!) < check.others[0]);
      return result(
        [
          { label: `Kick peaks between ${check.kick[0]} and ${check.kick[1]} dB (${kickDb.toFixed(1)} dB)`, ok: kickDb >= check.kick[0] && kickDb <= check.kick[1], fix: kickDb > check.kick[1] ? `The kick peaks at ${kickDb.toFixed(1)} dB. Lower its level until it peaks around -9 dB.` : `The kick peaks at ${kickDb.toFixed(1)} dB. Raise its level until it peaks around -9 dB.` },
          { label: `Every other element between ${check.others[0]} and ${check.others[1]} dB`, ok: !loud && !quiet, fix: loud ? `${loud.name} peaks at ${toDb(pk.tracks[loud.id]!).toFixed(1)} dB: lower it below the kick.` : quiet ? `${quiet.name} is almost silent (${toDb(pk.tracks[quiet.id]!).toFixed(1)} dB): bring it up a little.` : "" },
        ],
        "Every meter sits in the green zone, with room left on the master.",
      );
    }
    case "pan": {
      const pan = (el: Element) => Object.values(p.tracks).find((t) => hits(p, ctx, false).some((x) => x.track.id === t.id && x.element === el))?.pan;
      const hats = pan("hats"), arp = pan("arp"), kick = pan("kick"), bass = pan("bass");
      return result(
        [
          { label: "Hats and arp panned apart", ok: hats !== undefined && arp !== undefined && Math.sign(hats) !== Math.sign(arp) && Math.abs(hats - arp) >= 30, fix: "Pan the hats a little to one side and the arp a little to the other (for example -25 and +25)." },
          { label: "Kick and bass in the centre", ok: Math.abs(kick ?? 0) <= 5 && Math.abs(bass ?? 0) <= 5, fix: "Keep the kick and the bass in the middle (pan 0): low sounds stay mono." },
        ],
        "Hats and arp have their own space; the low end stays in the centre.",
      );
    }
    case "headroom": {
      const pk = ctx.peaks;
      if (!pk || pk.samples < 30) return result([{ label: "Measured while playing", ok: false, fix: "Play the drop (the loudest part) for a few seconds, then check." }], "");
      const db = toDb(pk.master);
      return result(
        [
          { label: `Master peaks between ${check.range[0]} and ${check.range[1]} dB (${db.toFixed(1)} dB)`, ok: db >= check.range[0] && db <= check.range[1], fix: db > check.range[1] ? `The master peaks at ${db.toFixed(1)} dB: too loud. Lower the elements' levels, not the master.` : `The master peaks at ${db.toFixed(1)} dB: a little quiet. Raise the elements a touch.` },
          ...(check.masterVolume === undefined ? [] : [{ label: "Master fader untouched", ok: p.masterVolume === check.masterVolume, fix: "Put the master back where it was: fix the mix with the element levels instead." }]),
        ],
        "Safe headroom: the mix is ready for export.",
      );
    }
    case "capstone": {
      const all = hits(p, ctx);
      const els = elementsIn(all, 1, p.songBars);
      const need: Element[] = ["piano", "kick", "hats", "clap", "bass", "arp", "melody"];
      const missing = need.filter((e) => !els.has(e) && !(e === "piano" && els.has("pads")));
      const byTrack = new Map<string, Set<Element>>();
      for (const x of all) byTrack.set(x.track.id, (byTrack.get(x.track.id) ?? new Set()).add(x.element));
      return result(
        [
          { label: "Chords, beat, bass, arp and melody in the song", ok: missing.length === 0, fix: `Not in your song yet: ${missing.join(", ")}. Finish the lessons for them and press Apply it in the studio.` },
          { label: "At least 96 bars", ok: p.songBars >= 96, fix: `Your song is ${p.songBars} bars. The plan's song is 112 bars (intro, arp section, build-up, drop, outro).` },
          { label: "Transitions at section changes", ok: fxClips(p, ctx).length >= 2, fix: "Add sweeps and down filters at the section changes (bars 9, 17, 33, 65)." },
          { label: "Filter automation (build-up and outro)", ok: filters(p).length > 0, fix: "Add the low-pass filter curves from Units 7 and 9." },
          { label: "Every element on its own track", ok: ![...byTrack.values()].some((s) => s.size > 1), fix: "Give every element its own track (Lesson 10.1)." },
        ],
        "Your song is complete: from the first chord to the outro.",
      );
    }
    default:
      return null;
  }
}
