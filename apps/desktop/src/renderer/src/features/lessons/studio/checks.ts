import { TICKS_PER_BAR, type Project, type Track } from "@daw/shared";
import type { CheckResult } from "../types";
import { KICK, SNARE, SONG, barTick } from "./exampleSong";
import type { Role, SoundInfo, SoundWant, StudioCheck, StudioCtx } from "./types";

/** Tracks the Kick lessons create: sounds dropped in the lesson workspace, and the example song. */
export const LESSON_TRACK_PREFIX = "lesson-k-";
export const isLessonTrack = (id: string) => id.startsWith(LESSON_TRACK_PREFIX) || id.startsWith("lesson-song-");

/** The project as the lessons see it: only their own tracks, so the learner's song never affects a check. */
export function lessonView(p: Project): Project {
  const trackOrder = p.trackOrder.filter(isLessonTrack);
  return { ...p, trackOrder, tracks: Object.fromEntries(trackOrder.map((id) => [id, p.tracks[id]!])) };
}

/**
 * Pure checks for the studio lessons: they read the learner's real project (and which sounds they listened to) and say
 * what is still missing, in plain words. Every item names the track or bar so the learner knows where to look.
 */

const DRUM_CATEGORIES = ["Kick", "Snare", "Clap", "Hat", "Cymbal", "Tom", "Percussion"];
const SNARE_PITCHES = [38, 39, 40];
const KICK_PITCHES = [35, KICK];

/** A sound the library does not know (another computer's pack): guess from its name. */
function guess(name: string): SoundInfo | undefined {
  const n = name.toLowerCase();
  if (/kick|808 kick|bd\b/.test(n)) return { category: "Kick", sub: "Kick" };
  if (/snare/.test(n)) return { category: "Snare", sub: "Snare" };
  if (/clap/.test(n)) return { category: "Clap", sub: "Clap" };
  if (/hat/.test(n)) return { category: "Hat", sub: /open/.test(n) ? "Open Hat" : "Closed Hat" };
  if (/riser/.test(n)) return { category: "FX", sub: "Riser" };
  if (/impact|noise hit|sub drop/.test(n)) return { category: "FX", sub: "Impact" };
  return undefined;
}

export const soundOfTrack = (t: Track, ctx: StudioCtx): SoundInfo | undefined =>
  t.instrument === "sample" && t.sample ? (ctx.soundOf(t.sample.id) ?? guess(t.sample.name)) : undefined;
const matches = (want: SoundWant, s: SoundInfo | undefined) => Boolean(s && s.category === want.category && (!want.sub || s.sub === want.sub));

export function roleOf(t: Track, ctx: StudioCtx): Role {
  if (t.id === SONG.drums || t.instrument === "drums") return "drums";
  if (t.id === SONG.bass) return "bass";
  if (t.id === SONG.chords) return "chords";
  const s = soundOfTrack(t, ctx);
  if (s) {
    if (DRUM_CATEGORIES.includes(s.category) || s.sub === "Drum Loop") return "drums";
    if (s.category === "Bass" || s.sub === "Bass Loop") return "bass";
    if (s.sub === "Chord Loop" || s.category === "Pad" || s.category === "Keys") return "chords";
    return "other";
  }
  if (/bass/i.test(t.name)) return "bass";
  if (/chord|pad|keys|piano/i.test(t.name)) return "chords";
  return "other";
}

/** Heard at all: not muted, and not silenced by another track's solo. */
const audible = (p: Project, t: Track) => !t.mute && (!Object.values(p.tracks).some((x) => x.solo) || t.solo);

interface Hit {
  track: Track;
  pitch: number;
  start: number;
  end: number;
  velocity: number;
}
/** Every unmuted note of a track, in song time. */
function hitsOf(t: Track): Hit[] {
  const out: Hit[] = [];
  for (const c of Object.values(t.clips))
    for (const n of Object.values(c.notes)) if (!n.muted) out.push({ track: t, pitch: n.pitch, start: c.startTick + n.startTick, end: c.startTick + n.startTick + n.durationTicks, velocity: n.velocity });
  return out;
}
const sounds = (t: Track, from: number, to: number) => hitsOf(t).some((h) => h.start < to && h.end > from);

/** Snare (or clap) hits from drum tracks and snare/clap samples. */
function snareHits(p: Project, ctx: StudioCtx): Hit[] {
  const out: Hit[] = [];
  for (const t of Object.values(p.tracks)) {
    if (!audible(p, t)) continue;
    if (t.instrument === "drums") out.push(...hitsOf(t).filter((h) => SNARE_PITCHES.includes(h.pitch)));
    else if (matches({ category: "Snare", label: "" }, soundOfTrack(t, ctx)) || matches({ category: "Clap", label: "" }, soundOfTrack(t, ctx))) out.push(...hitsOf(t));
  }
  return out;
}
const inBar = (hits: Hit[], bar: number) => hits.filter((h) => h.start >= barTick(bar) && h.start < barTick(bar + 1));
const meanVelocity = (hits: Hit[]) => (hits.length ? hits.reduce((s, h) => s + h.velocity, 0) / hits.length : 0);

/** A kick on this tick: a drum-track kick note, a kick sample, or a drum loop starting there. */
function kickAt(p: Project, ctx: StudioCtx, tick: number): boolean {
  return Object.values(p.tracks).some((t) => {
    if (!audible(p, t)) return false;
    if (t.instrument === "drums") return hitsOf(t).some((h) => KICK_PITCHES.includes(h.pitch) && h.start === tick);
    const s = soundOfTrack(t, ctx);
    return (s?.category === "Kick" || s?.sub === "Drum Loop") && hitsOf(t).some((h) => h.start === tick);
  });
}

function riserClips(p: Project, ctx: StudioCtx) {
  return Object.values(p.tracks)
    .filter((t) => audible(p, t) && soundOfTrack(t, ctx)?.sub === "Riser")
    .flatMap((t) => Object.values(t.clips).map((c) => ({ start: c.startTick, end: c.startTick + c.lengthTicks })));
}

const bars = (a: number, b: number) => (a === b ? `bar ${a}` : `bars ${a}-${b}`);

interface Item {
  label: string;
  ok: boolean;
  /** What to do when it is not met. */
  fix: string;
}
function result(items: Item[], success: string): CheckResult {
  const missing = items.find((i) => !i.ok);
  const ok = items.filter((i) => i.ok).length;
  return { pass: !missing, score: items.length ? ok / items.length : 1, feedback: missing ? missing.fix : success, items: items.map(({ label, ok }) => ({ label, ok })) };
}

/** The tracks of a role that still sound in [from, to), for "Song: Drums still plays in bar 9" messages. */
function playingIn(p: Project, ctx: StudioCtx, role: Role, from: number, to: number) {
  return Object.values(p.tracks).filter((t) => roleOf(t, ctx) === role && audible(p, t) && sounds(t, from, to));
}

export function runStudioCheck(p: Project, check: StudioCheck, ctx: StudioCtx): CheckResult {
  const tracks = Object.values(p.tracks);
  switch (check.kind) {
    case "auditioned": {
      const heard = ctx.auditioned.map((id) => ctx.soundOf(id));
      return result(
        check.sounds.map((w) => ({ label: `Listened to a ${w.label}`, ok: heard.some((s) => matches(w, s)), fix: `Listen to a ${w.label}: click the ${w.sub ?? w.category} chip in the sounds list, then click a sound.` })),
        "You found and heard all three. Each drum sound has its own job in a beat.",
      );
    }
    case "sampleClips": {
      const [from, to] = [barTick(check.bars[0]), barTick(check.bars[1] + 1)];
      return result(
        check.sounds.map((w) => ({
          label: `A ${w.label} track with a clip in ${bars(...check.bars)}`,
          ok: tracks.some((t) => matches(w, soundOfTrack(t, ctx)) && Object.values(t.clips).some((c) => c.startTick >= from && c.startTick < to)),
          fix: tracks.some((t) => matches(w, soundOfTrack(t, ctx)))
            ? `Your ${w.label} is not in ${bars(...check.bars)} yet. Drag its clip to the start of ${bars(...check.bars)}.`
            : `No ${w.label} yet. Choose ${w.sub ?? w.category} in the sounds list and drag a sound onto ${bars(...check.bars)}.`,
        })),
        check.sounds.length === 1 ? `A new track named after the sound, with its clip in ${bars(...check.bars)}.` : "Kick, snare and hat, each on its own track, all in bar 1.",
      );
    }
    case "onBeat": {
      const offset = (check.beat - 1) * (TICKS_PER_BAR / 4);
      const clips = tracks.filter((t) => matches(check.sound, soundOfTrack(t, ctx))).flatMap((t) => Object.values(t.clips));
      const onBeat = clips.some((c) => c.startTick % TICKS_PER_BAR === offset);
      const onOne = clips.some((c) => c.startTick % TICKS_PER_BAR === 0);
      return result(
        [
          { label: `A ${check.sound.label} clip`, ok: clips.length > 0, fix: `Drag a ${check.sound.label} from the sounds list onto bar 1 first.` },
          {
            label: `It starts on beat ${check.beat}`,
            ok: onBeat,
            fix: onOne ? `Your ${check.sound.label} starts on beat 1 (the bar line). Set the grid to 1/4 and drag it one beat to the right.` : `Set the grid to 1/4 so clips land on beats, then drag the ${check.sound.label} to beat ${check.beat}.`,
          },
        ],
        `The ${check.sound.label} lands exactly on beat ${check.beat}: the 1/4 grid makes every beat a landing spot.`,
      );
    }
    case "anySample": {
      const any = tracks.some((t) => t.instrument === "sample" && Object.keys(t.clips).length > 0);
      return result([{ label: "A sound on the arrangement", ok: any, fix: "Drag any sound from the list onto the arrangement." }], "A new track appeared, named after the sound, with its clip where you dropped it.");
    }
    case "tempo":
      return result([{ label: `Song tempo is ${check.bpm} BPM`, ok: p.tempo === check.bpm, fix: `Type ${check.bpm} in the BPM box (it is ${p.tempo} now) and press Enter.` }], `The song now runs at ${check.bpm} BPM.`);
    case "silent": {
      const [from, to] = [barTick(...check.from), barTick(...check.to)];
      const where = check.from[1] === 1 && check.to[1] === 1 ? bars(check.from[0], check.to[0] - 1) : `beat ${check.from[1]} of bar ${check.from[0]}`;
      return result(
        check.roles.map((role) => {
          const loud = playingIn(p, ctx, role, from, to);
          return { label: `No ${role} in ${where}`, ok: !loud.length, fix: `${loud[0]?.name} still plays in ${where}. Delete that part (or mute the track).` };
        }),
        `Silent in ${where}, just as planned.`,
      );
    }
    case "riser": {
      const [a, b] = check.bars;
      return result(
        [{ label: `A riser in ${bars(a, b)}`, ok: riserClips(p, ctx).some((r) => r.start < barTick(b + 1) && r.end > barTick(a)), fix: `Choose FX in the sounds list and drag a Riser onto bar ${a}.` }],
        "The riser sweeps up toward the drop.",
      );
    }
    case "impact": {
      const t = barTick(check.bar);
      const ok = tracks.some((x) => audible(p, x) && soundOfTrack(x, ctx)?.sub === "Impact" && Object.values(x.clips).some((c) => c.startTick === t));
      return result([{ label: `An impact on bar ${check.bar}`, ok, fix: `Choose FX and drag an Impact exactly onto the start of bar ${check.bar} (grid 1 bar helps).` }], `The impact marks the first beat of bar ${check.bar}.`);
    }
    case "loops": {
      const loops = tracks.filter((t) => soundOfTrack(t, ctx)?.category === "Loop");
      return result(
        [{ label: `At least ${check.min} loop tracks (${loops.length} now)`, ok: loops.length >= check.min, fix: loops.length ? "One loop is in. Add another: a drum loop and a chord or bass loop work well together." : "Choose Loop in the sounds list, and drag a drum loop and a chord loop onto the arrangement." }],
        "Two loops under your beat: a full groove in a few drags.",
      );
    }
    case "fitTempo": {
      const loops = tracks.filter((t) => soundOfTrack(t, ctx)?.category === "Loop");
      return result(
        [
          { label: `Song tempo is ${check.bpm} BPM`, ok: p.tempo === check.bpm, fix: `Type ${check.bpm} in the BPM box (it is ${p.tempo} now).` },
          { label: "A loop has Fit on", ok: loops.some((t) => t.sample?.fit === true && Boolean(t.sample.bpm)), fix: loops.length ? "Turn Fit on (on the loop track) so it follows the song tempo." : "Add a loop from the sounds list first, then turn its Fit button on." },
        ],
        `The loop now plays at ${check.bpm} BPM without changing its pitch.`,
      );
    }
    case "breakdown": {
      const [from, to] = [barTick(check.bars[0]), barTick(check.bars[1] + 1)];
      const drums = playingIn(p, ctx, "drums", from, to);
      const bass = playingIn(p, ctx, "bass", from, to);
      const chords = playingIn(p, ctx, "chords", from, to);
      return result(
        [
          { label: `No drums in ${bars(...check.bars)}`, ok: !drums.length, fix: `${drums[0]?.name} still plays in ${bars(...check.bars)}. Delete or split its clip there, or mute the track.` },
          { label: `No bass in ${bars(...check.bars)}`, ok: !bass.length, fix: `${bass[0]?.name} still plays in ${bars(...check.bars)}. Delete its clip there, or mute the track.` },
          { label: `The chords still play in ${bars(...check.bars)}`, ok: chords.length > 0, fix: `Keep the chords: they carry the breakdown. Unmute Song: Chords or put its clip back in ${bars(...check.bars)}.` },
        ],
        "Only the chords are left: the energy drops, and the return of the beat will feel big.",
      );
    }
    case "buildup": {
      const [a, b] = check.bars;
      const hits = snareHits(p, ctx);
      const first = inBar(hits, a);
      const last = inBar(hits, b);
      const risers = riserClips(p, ctx);
      return result(
        [
          { label: `A snare roll in ${bars(a, b)}`, ok: first.length + last.length >= 6, fix: `Draw snare hits on the Snare row in ${bars(a, b)} of Song: Drums: 4 in bar ${a}, then 8 or 16 in bar ${b}.` },
          { label: "More hits in each bar", ok: first.length >= 2 && last.length > first.length, fix: `Bar ${b} needs more snare hits than bar ${a} (now ${first.length} then ${last.length}). Use a finer grid (1/16 or 1/32).` },
          { label: "Getting louder", ok: last.length > 0 && meanVelocity(last) > meanVelocity(first), fix: `Make bar ${b}'s snares louder than bar ${a}'s: raise them in the velocity lane.` },
          { label: "A riser under the roll", ok: risers.some((r) => r.start < barTick(b + 1) && r.end > barTick(a)), fix: `Choose FX in the sounds list and drag a Riser onto bar ${a}, so it plays under the roll.` },
        ],
        "Faster, louder snares and a rising sweep: the tension builds toward the drop.",
      );
    }
    case "pause": {
      const [from, to] = [barTick(check.dropBar - 1, 4), barTick(check.dropBar)];
      const loud = tracks.filter((t) => audible(p, t) && sounds(t, from, to));
      const roll = snareHits(p, ctx).filter((h) => h.start >= barTick(check.dropBar - 2) && h.start < from);
      return result(
        [
          { label: `Silence on beat 4 of bar ${check.dropBar - 1}`, ok: !loud.length, fix: `${loud[0]?.name} still sounds on beat 4 of bar ${check.dropBar - 1}. Delete those notes or shorten them so they stop before beat 4.` },
          { label: "The build-up is still there", ok: roll.length >= 4, fix: `Keep the snare roll before the gap: only the last beat should be empty.` },
        ],
        "One beat of silence: the drop now hits much harder.",
      );
    }
    case "drop": {
      const t = barTick(check.bar);
      const impact = tracks.some((x) => audible(p, x) && soundOfTrack(x, ctx)?.sub === "Impact" && Object.values(x.clips).some((c) => c.startTick === t));
      const bass = tracks.some((x) => audible(p, x) && roleOf(x, ctx) === "bass" && Object.values(x.clips).some((c) => c.startTick === t && Object.keys(c.notes).length > 0));
      return result(
        [
          { label: `An impact on bar ${check.bar}`, ok: impact, fix: `Choose FX in the sounds list and drag an Impact exactly onto bar ${check.bar}.` },
          { label: `The kick is back on bar ${check.bar}`, ok: kickAt(p, ctx, t), fix: `Bring the kick back on bar ${check.bar}: duplicate the Song: Drums beat clip (Ctrl+D) so a copy starts on bar ${check.bar}, or drag a kick there.` },
          { label: `The bass is back on bar ${check.bar}`, ok: bass, fix: `Bring the bass back: duplicate the Song: Bass clip (Ctrl+D) and drag the copy to bar ${check.bar}.` },
        ],
        "Impact, kick and bass all land together: that is the drop.",
      );
    }
    case "fullSection": {
      const [b0, b1] = check.breakdown;
      const [u0, u1] = check.buildup;
      const drums = playingIn(p, ctx, "drums", barTick(b0), barTick(b1 + 1));
      const hits = snareHits(p, ctx);
      const perBar = Array.from({ length: u1 - u0 + 1 }, (_, i) => inBar(hits, u0 + i).length);
      const denser = perBar.every((n, i) => i === 0 || n >= perBar[i - 1]!) && perBar[perBar.length - 1]! > perBar[0]!;
      const drop = barTick(check.dropBar);
      const bass = playingIn(p, ctx, "bass", drop, drop + TICKS_PER_BAR);
      return result(
        [
          { label: `No drums in the breakdown (${bars(b0, b1)})`, ok: !drums.length, fix: `${drums[0]?.name} plays in the breakdown (${bars(b0, b1)}). Delete or mute the drums there.` },
          { label: `The snare roll gets denser (${bars(u0, u1)})`, ok: denser, fix: `Snare hits per bar in ${bars(u0, u1)}: ${perBar.join(", ")}. Each bar needs at least as many as the one before, and the last more than the first.` },
          { label: `A riser ends on bar ${check.dropBar}`, ok: riserClips(p, ctx).some((r) => r.end === drop), fix: `Place a Riser so its clip ends exactly where bar ${check.dropBar} starts.` },
          { label: `The drop (bar ${check.dropBar}) has kick and bass`, ok: kickAt(p, ctx, drop) && bass.length > 0, fix: `Bar ${check.dropBar} needs the kick on beat 1 and the bass playing.` },
        ],
        "Breakdown, build-up and drop: a complete section, the way real tracks do it.",
      );
    }
  }
}
