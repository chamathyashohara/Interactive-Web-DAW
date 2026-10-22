import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR, applyOp, createProject, dropSampleOps, type Op, type OpBody, type Project } from "@daw/shared";
import { lessonView, runStudioCheck } from "./checks";
import { SONG, SNARE, barTick, songSetupOps, stageSetupOps } from "./exampleSong";
import { KICK_MODULES } from "./kickCurriculum";
import { STUDIO_LESSONS, nextStudioLesson } from "./courses";
import { lessonTracksOf, spaceSwitchOps } from "./space";
import { createStudioState } from "./studioState";
import { applyCopiesOps } from "./park";
import type { SoundInfo, StudioCheck, StudioCtx } from "./types";
import { memoryStore } from "../storage";

let n = 0;
function applyAll(p: Project, bodies: OpBody[]): Project {
  let out = p;
  for (const b of bodies) {
    const r = applyOp(out, { opId: `op${++n}`, clientId: "test", ...b } as Op);
    if (!r.ok) throw new Error(r.reason);
    out = r.project;
  }
  return out;
}

/** A tiny library: ids are "cat/sub/name". */
const LIB: Record<string, SoundInfo & { name: string; durationSec: number; meta: { bpm?: number; bars?: number; loop?: boolean } }> = {
  "Kick/Kick/Punch Kick": { category: "Kick", sub: "Kick", name: "Punch Kick", durationSec: 0.4, meta: {} },
  "Snare/Snare/Tight Snare": { category: "Snare", sub: "Snare", name: "Tight Snare", durationSec: 0.3, meta: {} },
  "Hat/Closed Hat/Closed Hat 1": { category: "Hat", sub: "Closed Hat", name: "Closed Hat 1", durationSec: 0.1, meta: {} },
  "Hat/Open Hat/Open Hat 1": { category: "Hat", sub: "Open Hat", name: "Open Hat 1", durationSec: 0.5, meta: {} },
  "Loop/Drum Loop/Boom Drums": { category: "Loop", sub: "Drum Loop", name: "Boom Drums", durationSec: 5.33, meta: { bpm: 90, bars: 2, loop: true } },
  "Loop/Chord Loop/Warm Chords": { category: "Loop", sub: "Chord Loop", name: "Warm Chords", durationSec: 10.67, meta: { bpm: 90, bars: 4, loop: true } },
  "FX/Riser/Riser 4s": { category: "FX", sub: "Riser", name: "Riser 4s", durationSec: 4, meta: {} },
  "FX/Impact/Impact": { category: "FX", sub: "Impact", name: "Impact", durationSec: 2, meta: {} },
};
const ctx = (auditioned: string[] = []): StudioCtx => ({ soundOf: (id) => LIB[id], auditioned });

function drop(p: Project, id: string, bar: number, beat = 1): Project {
  const s = LIB[id]!;
  const r = dropSampleOps(p, { id, name: s.name, category: s.category, durationSec: s.durationSec, meta: s.meta }, barTick(bar, beat), null, { trackId: `t${++n}`, clipId: `c${++n}`, noteId: `n${++n}` }, "#ffffff");
  if (!r.ok) throw new Error(r.reason);
  return applyAll(p, r.ops);
}
const song = (setup: Parameters<typeof songSetupOps>[1], p = createProject("p")) => {
  const r = songSetupOps(p, setup);
  if (!r.ok) throw new Error(r.reason);
  return applyAll(p, r.ops);
};
const check = (p: Project, c: StudioCheck, x = ctx()) => runStudioCheck(p, c, x);
const lessonCheck = (id: string) => STUDIO_LESSONS[id]!.practice.check!;
const tryCheck = (id: string) => STUDIO_LESSONS[id]!.tryIt.check!;

describe("Kick Drums course content", () => {
  it("has the 12 lessons M12.1-M12.6 and M13.1-M13.6 in order, each complete", () => {
    expect(KICK_MODULES.flatMap((m) => m.lessons.map((l) => l.id))).toEqual(["M12.1", "M12.2", "M12.3", "M12.4", "M12.5", "M12.6", "M13.1", "M13.2", "M13.3", "M13.4", "M13.5", "M13.6"]);
    for (const l of Object.values(STUDIO_LESSONS)) {
      expect(l.practice.check || l.practice.labels, l.id).toBeTruthy();
      expect(l.tryIt.check || l.tryIt.labels, l.id).toBeTruthy();
      expect(l.practice.hints).toHaveLength(3);
      expect(l.watch.steps.length, l.id).toBeGreaterThanOrEqual(3);
      expect(l.quick.options[l.quick.correct], l.id).toBeDefined();
      expect(l.recap.length).toBeGreaterThanOrEqual(2);
      expect(l.hook.text.length).toBeGreaterThan(60);
    }
    expect(nextStudioLesson("M12.6")?.id).toBe("M13.1");
    expect(nextStudioLesson("M13.6")).toBeNull();
  });
});

describe("K1 Sounds and beats checks", () => {
  it("M12.1 needs a kick, a snare and a closed hat heard (an open hat does not count)", () => {
    const c = lessonCheck("M12.1");
    expect(check(createProject("p"), c).pass).toBe(false);
    const almost = check(createProject("p"), c, ctx(["Kick/Kick/Punch Kick", "Snare/Snare/Tight Snare", "Hat/Open Hat/Open Hat 1"]));
    expect(almost.pass).toBe(false);
    expect(almost.feedback).toMatch(/closed hat/);
    expect(check(createProject("p"), c, ctx(["Kick/Kick/Punch Kick", "Snare/Snare/Tight Snare", "Hat/Closed Hat/Closed Hat 1"])).pass).toBe(true);
  });

  it("M12.2 needs a kick track with a clip in bar 1", () => {
    const c = lessonCheck("M12.2");
    expect(check(createProject("p"), c).feedback).toMatch(/No kick yet/);
    expect(check(drop(createProject("p"), "Kick/Kick/Punch Kick", 3), c).feedback).toMatch(/not in bar 1/);
    expect(check(drop(createProject("p"), "Kick/Kick/Punch Kick", 1), c).pass).toBe(true);
  });

  it("M12.3 needs kick, snare and hat tracks all in bar 1", () => {
    const c = lessonCheck("M12.3");
    let p = drop(drop(createProject("p"), "Kick/Kick/Punch Kick", 1), "Snare/Snare/Tight Snare", 1);
    expect(check(p, c).pass).toBe(false);
    p = drop(p, "Hat/Closed Hat/Closed Hat 1", 1);
    expect(check(p, c).pass).toBe(true);
  });

  it("M12.4 needs the snare on beat 2, and explains a snare left on the bar line", () => {
    const c = lessonCheck("M12.4");
    const onOne = check(drop(createProject("p"), "Snare/Snare/Tight Snare", 1), c);
    expect(onOne.pass).toBe(false);
    expect(onOne.feedback).toMatch(/beat 1/);
    expect(check(drop(createProject("p"), "Snare/Snare/Tight Snare", 1, 3), c).pass).toBe(false);
    expect(check(drop(createProject("p"), "Snare/Snare/Tight Snare", 2, 2), c).pass).toBe(true);
  });

  it("M12.5 needs two loop tracks", () => {
    const c = lessonCheck("M12.5");
    const one = drop(createProject("p"), "Loop/Drum Loop/Boom Drums", 1);
    expect(check(one, c).pass).toBe(false);
    expect(check(drop(one, "Loop/Chord Loop/Warm Chords", 1), c).pass).toBe(true);
  });

  it("M12.6 needs 100 BPM and a loop with Fit on", () => {
    const c = lessonCheck("M12.6");
    let p = drop(createProject("p"), "Loop/Drum Loop/Boom Drums", 1);
    expect(check(p, c).feedback).toMatch(/Type 100/);
    p = applyAll(p, [{ type: "setTempo", bpm: 100 }]);
    expect(check(p, c).pass).toBe(true);
    const loop = Object.values(p.tracks).find((t) => t.instrument === "sample")!;
    expect(check(applyAll(p, [{ type: "updateSample", trackId: loop.id, changes: { fit: false } }]), c).feedback).toMatch(/Fit on/);
  });
});

describe("K2 Build-up and drop checks", () => {
  it("the example song is three lesson tracks over 24 bars, set up again in one batch without touching other tracks", () => {
    const p = song("full");
    expect(p.songBars).toBe(24);
    expect(p.trackOrder).toEqual(["track-1", SONG.drums, SONG.bass, SONG.chords]);
    const again = song("buildup", p);
    expect(again.trackOrder).toHaveLength(4);
    expect(Object.keys(again.tracks[SONG.drums]!.clips)).toHaveLength(2);
    expect(again.tracks["track-1"]).toEqual(p.tracks["track-1"]);
  });

  it("M13.2 breakdown: deleting the drum and bass clips in bars 9-16 (or muting) passes; the chords must stay", () => {
    const c = lessonCheck("M13.2");
    const p = song("full");
    expect(check(p, c).feedback).toMatch(/Song: Drums still plays in bars 9-16/);
    const cut = applyAll(p, [
      { type: "deleteClip", trackId: SONG.drums, clipId: `${SONG.drums}-bar9` },
      { type: "deleteClip", trackId: SONG.bass, clipId: `${SONG.bass}-bar9` },
    ]);
    expect(check(cut, c).pass).toBe(true);
    const muted = applyAll(p, [
      { type: "updateTrack", trackId: SONG.drums, changes: { mute: true } },
      { type: "updateTrack", trackId: SONG.bass, changes: { mute: true } },
    ]);
    expect(check(muted, c).pass).toBe(true);
    expect(check(applyAll(cut, [{ type: "updateTrack", trackId: SONG.chords, changes: { mute: true } }]), c).feedback).toMatch(/Keep the chords/);
  });

  it("M13.3 build-up: a denser, louder snare roll in bars 15-16 with a riser under it", () => {
    const c = lessonCheck("M13.3");
    const start = song("buildup");
    expect(check(start, c).pass).toBe(false);
    // The ready-made roll from the "pause" song has 4 then 16 rising hits; add a riser on bar 15.
    const rolled = song("pause");
    expect(check(rolled, c).feedback).toMatch(/Riser/);
    expect(check(drop(rolled, "FX/Riser/Riser 4s", 15), c).pass).toBe(true);
    // A flat roll (same hits, same velocity) fails.
    const flat = applyAll(start, [
      { type: "addClip", trackId: SONG.drums, clip: { id: "r", startTick: barTick(15), lengthTicks: 2 * TICKS_PER_BAR, notes: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`h${i}`, { id: `h${i}`, pitch: SNARE, startTick: i * 960, durationTicks: 240, velocity: 100 }])) } },
    ]);
    expect(check(drop(flat, "FX/Riser/Riser 4s", 15), c).feedback).toMatch(/more snare hits/);
  });

  it("M13.4 pause: the last beat before bar 17 must be silent on every track, and the roll must stay", () => {
    const c = lessonCheck("M13.4");
    const p = song("pause");
    expect(check(p, c).feedback).toMatch(/Song: Drums still sounds on beat 4 of bar 16/);
    const noSnares = song("drop"); // same roll, stopping a beat early; the chord still rings through beat 4
    expect(check(noSnares, c).feedback).toMatch(/Song: Chords/);
    const chords = noSnares.tracks[SONG.chords]!.clips[`${SONG.chords}-bar9`]!;
    const lastBar = Object.values(chords.notes).filter((x) => x.startTick === 7 * TICKS_PER_BAR);
    const shortened = applyAll(noSnares, lastBar.map((x) => ({ type: "updateNote" as const, trackId: SONG.chords, clipId: chords.id, noteId: x.id, changes: { durationTicks: 3 * 960 } })));
    expect(check(shortened, c).pass).toBe(true);
  });

  it("M13.5 drop: impact, kick and bass all start on bar 17", () => {
    const c = lessonCheck("M13.5");
    let p = song("drop");
    expect(check(p, c).pass).toBe(false);
    p = drop(p, "FX/Impact/Impact", 17);
    const drums = p.tracks[SONG.drums]!.clips[`${SONG.drums}-bar1`]!;
    const bass = p.tracks[SONG.bass]!.clips[`${SONG.bass}-bar1`]!;
    p = applyAll(p, [{ type: "addClip", trackId: SONG.drums, clip: { ...drums, id: "d17", startTick: barTick(17) } }]);
    expect(check(p, c).feedback).toMatch(/bass/);
    p = applyAll(p, [{ type: "addClip", trackId: SONG.bass, clip: { ...bass, id: "b17", startTick: barTick(17) } }]);
    expect(check(p, c).pass).toBe(true);
  });

  it("M13.6 final: breakdown without drums, a roll that never thins out, a riser ending on bar 17, kick and bass in the drop", () => {
    const c = lessonCheck("M13.6");
    let p = song("final");
    expect(check(p, c).pass).toBe(false);
    p = applyAll(p, [{ type: "deleteClip", trackId: SONG.drums, clipId: `${SONG.drums}-bar1` }]);
    // Replace the bars 9-16 drums with the build-up roll (2 snares per bar, then 4, then 16).
    const roll = song("pause").tracks[SONG.drums]!.clips[`${SONG.drums}-bar9`]!;
    p = applyAll(p, [{ type: "deleteClip", trackId: SONG.drums, clipId: `${SONG.drums}-bar9` }, { type: "addClip", trackId: SONG.drums, clip: { ...roll, id: "roll" } }]);
    expect(check(p, c).feedback).toMatch(/Riser/);
    p = drop(p, "FX/Riser/Riser 4s", 15); // 4 s at 120 BPM = 2 bars: ends exactly on bar 17
    expect(check(p, c).pass).toBe(true);
  });
});

describe("Try checks (the small guided step before Practice)", () => {
  it("M12.2 Try: any sound on the arrangement", () => {
    expect(check(createProject("p"), tryCheck("M12.2")).pass).toBe(false);
    expect(check(drop(createProject("p"), "Hat/Open Hat/Open Hat 1", 4), tryCheck("M12.2")).pass).toBe(true);
  });
  it("M12.6 Try: the tempo alone", () => {
    expect(check(createProject("p"), tryCheck("M12.6")).feedback).toMatch(/Type 100/);
    expect(check(applyAll(createProject("p"), [{ type: "setTempo", bpm: 100 }]), tryCheck("M12.6")).pass).toBe(true);
  });
  it("M13.2 Try: only the drums in bars 9-16", () => {
    const p = song("full");
    expect(check(p, tryCheck("M13.2")).pass).toBe(false);
    expect(check(applyAll(p, [{ type: "deleteClip", trackId: SONG.drums, clipId: `${SONG.drums}-bar9` }]), tryCheck("M13.2")).pass).toBe(true);
  });
  it("M13.3 Try: a riser over bars 15-16", () => {
    expect(check(song("buildup"), tryCheck("M13.3")).pass).toBe(false);
    expect(check(drop(song("buildup"), "FX/Riser/Riser 4s", 15), tryCheck("M13.3")).pass).toBe(true);
  });
  it("M13.4 Try: no drums on beat 4 of bar 16", () => {
    expect(check(song("pause"), tryCheck("M13.4")).pass).toBe(false);
    expect(check(song("drop"), tryCheck("M13.4")).pass).toBe(true); // the same roll, stopping a beat early
  });
  it("M13.5 Try: an impact exactly on bar 17", () => {
    expect(check(drop(song("drop"), "FX/Impact/Impact", 17, 2), tryCheck("M13.5")).pass).toBe(false);
    expect(check(drop(song("drop"), "FX/Impact/Impact", 17), tryCheck("M13.5")).pass).toBe(true);
  });
  it("M13.6 Try: no drums in bars 1-8", () => {
    expect(check(song("final"), tryCheck("M13.6")).pass).toBe(false);
    expect(check(applyAll(song("final"), [{ type: "deleteClip", trackId: SONG.drums, clipId: `${SONG.drums}-bar1` }]), tryCheck("M13.6")).pass).toBe(true);
  });
});

describe("the lesson workspace", () => {
  const ids = () => `x${++n}`;
  const loop = { id: "Loop/Drum Loop/Boom Drums", ...LIB["Loop/Drum Loop/Boom Drums"]! };
  const withLessonKick = () => {
    const p = createProject("p");
    const r = dropSampleOps(p, { id: "Kick/Kick/Punch Kick", name: "Punch Kick", category: "Kick", durationSec: 0.4, meta: {} }, 0, null, { trackId: "lesson-k-1", clipId: "c", noteId: "n" }, "#ffffff");
    return applyAll(p, r.ok ? r.ops : []);
  };
  const setup = (p: Project, s: Parameters<typeof stageSetupOps>[1]) => {
    const r = stageSetupOps(p, s, ids, loop);
    if (!r.ok) throw new Error(r.reason);
    return applyAll(p, r.ops);
  };

  it("'clear' removes the lesson's tracks (and the example song) but never the learner's own", () => {
    const p = setup(song("full", withLessonKick()), "clear");
    expect(p.trackOrder).toEqual(["track-1"]);
  });
  it("'loop' gives a fresh arrangement with one 90 BPM loop, Fit off, song at 120", () => {
    const p = setup(applyAll(withLessonKick(), [{ type: "setTempo", bpm: 100 }]), "loop");
    expect(p.tempo).toBe(120);
    const lessonTracks = p.trackOrder.filter((id) => id.startsWith("lesson-k-"));
    expect(lessonTracks).toHaveLength(1);
    expect(p.tracks[lessonTracks[0]!]!.sample).toMatchObject({ bpm: 90, fit: false });
    expect(stageSetupOps(p, "loop", ids).ok).toBe(false); // no library yet: a clear message instead
  });
  it("a song setup replaces the example song and clears dropped sounds", () => {
    const p = setup(withLessonKick(), "drop");
    expect(p.trackOrder).toEqual(["track-1", SONG.drums, SONG.bass, SONG.chords]);
  });
  it("checks read only the lesson's tracks: the learner's own drums never spoil a breakdown", () => {
    let p = applyAll(song("full"), [
      { type: "deleteClip", trackId: SONG.drums, clipId: `${SONG.drums}-bar9` },
      { type: "deleteClip", trackId: SONG.bass, clipId: `${SONG.bass}-bar9` },
    ]);
    p = applyAll(p, [{ type: "addTrack", track: { ...p.tracks[SONG.drums]!, id: "my-drums", name: "My drums", clips: { m: { id: "m", startTick: barTick(9), lengthTicks: 3840, notes: { a: { id: "a", pitch: 36, startTick: 0, durationTicks: 240, velocity: 100 } } } } } }]);
    expect(check(p, lessonCheck("M13.2")).pass).toBe(false);
    expect(check(lessonView(p), lessonCheck("M13.2")).pass).toBe(true);
  });
});

describe("each lesson has its own workspace", () => {
  const kickTrack = (id: string, bar: number) => {
    const p = createProject("p");
    const r = dropSampleOps(p, { id: "Kick/Kick/Punch Kick", name: "Punch Kick", category: "Kick", durationSec: 0.4, meta: {} }, barTick(bar), null, { trackId: id, clipId: `${id}-c`, noteId: `${id}-n` }, "#ffffff");
    return r.ok ? (r.ops.find((o) => o.type === "addTrack") as { track: Project["tracks"][string] }).track : null!;
  };

  it("switching saves the open lesson's tracks and brings back the other lesson's, never touching the learner's tracks", () => {
    const state = createStudioState(memoryStore());
    // M12.2 is open with a kick on bar 1
    let p = applyAll(createProject("p"), [{ type: "addTrack", track: kickTrack("lesson-k-a", 1) }]);
    state.switchSpace("M12.2", []);
    // open M12.3: M12.2's kick leaves the project
    p = applyAll(p, spaceSwitchOps(p, state.savedSpace("M12.3")?.tracks));
    state.switchSpace("M12.3", lessonTracksOf(applyAll(createProject("p"), [{ type: "addTrack", track: kickTrack("lesson-k-a", 1) }])));
    expect(p.trackOrder).toEqual(["track-1"]);
    // M12.3 gets its own kick on bar 2
    p = applyAll(p, [{ type: "addTrack", track: kickTrack("lesson-k-b", 2) }]);
    // back to M12.2: its kick returns, M12.3's is saved
    const before = p;
    p = applyAll(p, spaceSwitchOps(p, state.savedSpace("M12.2")?.tracks));
    state.switchSpace("M12.2", lessonTracksOf(before));
    expect(p.trackOrder).toEqual(["track-1", "lesson-k-a"]);
    expect(Object.values(p.tracks["lesson-k-a"]!.clips)[0]!.startTick).toBe(0);
    expect(state.savedSpace("M12.3")!.tracks.map((t) => t.id)).toEqual(["lesson-k-b"]);
    expect(state.savedSpace("M12.2")).toBeUndefined();
    expect(state.active()).toBe("M12.2");
  });

  it("a song-length workspace lengthens the song when it comes back", () => {
    const long = song("full");
    const saved = lessonTracksOf(long);
    const short = createProject("p");
    const p = applyAll(short, spaceSwitchOps(short, saved));
    expect(p.songBars).toBe(24);
    expect(p.trackOrder).toEqual(["track-1", SONG.drums, SONG.bass, SONG.chords]);
  });

  it("each lesson keeps its own stage setup and listening", () => {
    const state = createStudioState(memoryStore());
    state.switchSpace("M12.1", []);
    state.setOwner("M12.1:practice");
    state.hear("Kick/Kick/Punch Kick");
    state.switchSpace("M12.2", []);
    expect(state.owner()).toBeNull();
    expect(state.heard()).toEqual([]);
    state.switchSpace("M12.1", []);
    expect(state.owner()).toBe("M12.1:practice");
    expect(state.heard()).toEqual(["Kick/Kick/Punch Kick"]);
  });
});

describe("Drum sequencer course", () => {
  const SEQ = ["M14.1", "M14.2", "M14.3", "M14.4", "M14.5", "M14.6", "M14.7", "M14.8", "M14.9", "M14.10"];
  const pad = (n: number) => (n - 1) * 240;
  /** The lesson's drum track after its Practice (or Try) setup. */
  const setUp = (id: string, stage: "tryIt" | "practice" = "practice") => {
    const r = stageSetupOps(createProject("p"), STUDIO_LESSONS[id]![stage].setup!, () => `i${++n}`);
    if (!r.ok) throw new Error(r.reason);
    return applyAll(createProject("p"), r.ops);
  };
  const notes = (p: Project) => p.tracks["lesson-k-seq"]!.clips["lesson-k-seq-clip"]!.notes;
  const add = (p: Project, pitch: number, pads: number[], velocity = 100) =>
    applyAll(p, pads.map((x) => ({ type: "addNote" as const, trackId: "lesson-k-seq", clipId: "lesson-k-seq-clip", note: { id: `a${++n}`, pitch, startTick: pad(x), durationTicks: 240, velocity } })));
  const remove = (p: Project, pitch: number, pads: number[]) =>
    applyAll(p, Object.values(notes(p)).filter((x) => x.pitch === pitch && pads.includes(x.startTick / 240 + 1)).map((x) => ({ type: "deleteNote" as const, trackId: "lesson-k-seq", clipId: "lesson-k-seq-clip", noteId: x.id })));
  const run = (p: Project, id: string, stage: "tryIt" | "practice" = "practice") => runStudioCheck(lessonView(p), STUDIO_LESSONS[id]![stage].check!, ctx());

  it("has ten lessons M14.1-M14.10 on the step sequencer, each with its own drum track setup", () => {
    for (const id of SEQ) {
      const l = STUDIO_LESSONS[id]!;
      expect(l.space, id).toBe("sequencer");
      expect(l.practice.hints).toHaveLength(3);
      expect(setUp(id).tracks["lesson-k-seq"]!.instrument, id).toBe("drums");
    }
    expect(nextStudioLesson("M14.10")).toBeNull();
    expect(nextStudioLesson("M14.5")?.id).toBe("M14.6");
  });

  it("M14.1: a kick (36) on pad 1; the hint names the top row", () => {
    expect(run(setUp("M14.1"), "M14.1").feedback).toMatch(/kick row is the top row/);
    expect(run(add(setUp("M14.1"), 36, [1]), "M14.1").pass).toBe(true);
    expect(STUDIO_LESSONS["M14.1"]!.practice.confirm).toEqual(["I pressed Play and heard the kick"]);
  });

  it("M14.2: kicks on exactly 1, 5, 9, 13, naming missing beats and extra pads", () => {
    expect(run(add(setUp("M14.2"), 36, [1, 5, 13]), "M14.2").feedback).toMatch(/No kick on beat 3 \(pad 9\)/);
    expect(run(add(setUp("M14.2"), 36, [1, 3, 5, 9, 13]), "M14.2").feedback).toMatch(/Extra kick on pad 3/);
    expect(run(add(setUp("M14.2"), 36, [1, 5, 9, 13]), "M14.2").pass).toBe(true);
  });

  it("M14.3: the K2 pattern is already there (Click and TAP are ticked by the learner)", () => {
    expect(run(setUp("M14.3"), "M14.3").pass).toBe(true);
    expect(STUDIO_LESSONS["M14.3"]!.practice.confirm).toHaveLength(2);
    expect(run(remove(setUp("M14.3"), 36, [9]), "M14.3").pass).toBe(false);
  });

  it("M14.4: kicks only on 1 and 9", () => {
    expect(run(add(setUp("M14.4"), 36, [1, 9, 13]), "M14.4").pass).toBe(false);
    expect(run(add(setUp("M14.4"), 36, [1, 9]), "M14.4").pass).toBe(true);
  });

  it("M14.5: at least three kicks, one off the beat", () => {
    expect(run(add(setUp("M14.5"), 36, [5]), "M14.5").feedback).toMatch(/Every kick is on a beat/);
    expect(run(add(setUp("M14.5"), 36, [7]), "M14.5").pass).toBe(true);
  });

  it("M14.6: pad 1 accented (127), another kick softer", () => {
    const p = setUp("M14.6");
    expect(run(p, "M14.6").feedback).toMatch(/Hold Shift and click the pad/);
    const accented = applyAll(p, Object.values(notes(p)).filter((x) => x.startTick === 0).map((x) => ({ type: "updateNote" as const, trackId: "lesson-k-seq", clipId: "lesson-k-seq-clip", noteId: x.id, changes: { velocity: 127 } })));
    expect(run(accented, "M14.6").pass).toBe(true);
    const allLoud = applyAll(p, Object.values(notes(p)).map((x) => ({ type: "updateNote" as const, trackId: "lesson-k-seq", clipId: "lesson-k-seq-clip", noteId: x.id, changes: { velocity: 127 } })));
    expect(run(allLoud, "M14.6").feedback).toMatch(/Leave the other kicks normal/);
  });

  it("M14.7: snares on 5 and 13 with no kick under them", () => {
    let p = add(setUp("M14.7"), 38, [5, 13]);
    expect(run(p, "M14.7").feedback).toMatch(/The snare owns pads 5 and 13. Move the kick off pad 5 and pad 13/);
    p = remove(p, 36, [5, 13]);
    expect(run(p, "M14.7").pass).toBe(true);
  });

  it("M14.8: all four bars have kicks and bar 4 differs from bar 1", () => {
    let p = setUp("M14.8");
    expect(run(p, "M14.8").feedback).toMatch(/Bar 2 has no kick. Use Copy to all bars first/);
    p = add(p, 36, [17, 25, 33, 41, 49, 57]); // bars 2-4 copied
    expect(run(p, "M14.8", "tryIt").pass).toBe(true);
    expect(run(p, "M14.8").feedback).toMatch(/Bar 4 is the same as bar 1/);
    expect(run(add(p, 36, [64]), "M14.8").pass).toBe(true); // pad 16 of bar 4
  });

  it("M14.9: a loop region of at least two bars", () => {
    const p = setUp("M14.9");
    expect(run(p, "M14.9").feedback).toMatch(/Drag in the thin LOOP strip above the numbers/);
    expect(run(applyAll(p, [{ type: "setLoop", loop: { startTick: 0, endTick: 3840 } }]), "M14.9").pass).toBe(false);
    expect(run(applyAll(p, [{ type: "setLoop", loop: { startTick: 0, endTick: 3840 } }]), "M14.9", "tryIt").pass).toBe(true);
    expect(run(applyAll(p, [{ type: "setLoop", loop: { startTick: 0, endTick: 7680 } }]), "M14.9").pass).toBe(true);
  });

  it("M14.10: kick velocities rise by at least 40 from the first to the last", () => {
    const p = setUp("M14.10");
    expect(run(p, "M14.10").feedback).toMatch(/Click the Kick name first/);
    const kicks = Object.values(notes(p)).filter((x) => x.pitch === 36).sort((a, b) => a.startTick - b.startTick);
    const ramped = applyAll(p, kicks.map((x, i) => ({ type: "updateNote" as const, trackId: "lesson-k-seq", clipId: "lesson-k-seq-clip", noteId: x.id, changes: { velocity: Math.round(30 + (90 * i) / (kicks.length - 1)) } })));
    expect(run(ramped, "M14.10").pass).toBe(true);
  });

  it("a sequencer setup never touches the Piano lessons' practice track or the learner's tracks", () => {
    const p = applyAll(createProject("p"), [{ type: "addTrack", track: { ...createProject("q").tracks["track-1"]!, id: "lesson-practice", name: "Lesson: Practice" } }]);
    const r = stageSetupOps(p, STUDIO_LESSONS["M14.1"]!.practice.setup!, () => "x");
    const after = applyAll(p, r.ok ? r.ops : []);
    expect(after.trackOrder).toEqual(["track-1", "lesson-practice", "lesson-k-seq"]);
  });
});

describe("lesson work stays out of the Studio unless applied", () => {
  it("leaving the lessons saves the open lesson's tracks with it; opening it again brings them back", () => {
    const state = createStudioState(memoryStore());
    let p = song("full");
    state.switchSpace("M13.2", []);
    state.setOwner("M13.2:practice");
    // leave: the lesson tracks go out of the song and are saved under M13.2
    const saved = lessonTracksOf(p);
    p = applyAll(p, spaceSwitchOps(p, undefined));
    state.park(saved);
    expect(p.trackOrder).toEqual(["track-1"]);
    expect(state.active()).toBeNull();
    expect(state.savedSpace("M13.2")!.tracks.map((t) => t.id)).toEqual([SONG.drums, SONG.bass, SONG.chords]);
    // come back to M13.2: its song returns, with its stage setup
    p = applyAll(p, spaceSwitchOps(p, state.savedSpace("M13.2")!.tracks));
    state.switchSpace("M13.2", []);
    expect(p.trackOrder).toEqual(["track-1", SONG.drums, SONG.bass, SONG.chords]);
    expect(state.owner()).toBe("M13.2:practice");
  });

  it("Apply makes copies with new ids (ordinary tracks, not lesson tracks) and names them plainly", () => {
    let k = 0;
    const p = song("full");
    const { ops, open } = applyCopiesOps(p, () => `u${++k}`);
    const after = applyAll(applyAll(p, spaceSwitchOps(p, undefined)), ops);
    expect(after.trackOrder.filter((id) => id.startsWith("lesson-"))).toEqual([]);
    expect(after.trackOrder.map((id) => after.tracks[id]!.name)).toEqual(["Synth", "Drums", "Bass", "Chords"]);
    expect(open && after.tracks[open.trackId]!.clips[open.clipId]).toBeTruthy();
    const notesBefore = Object.values(p.tracks[SONG.chords]!.clips).reduce((n, c) => n + Object.keys(c.notes).length, 0);
    const copy = after.tracks[after.trackOrder[3]!]!;
    expect(Object.values(copy.clips).reduce((n, c) => n + Object.keys(c.notes).length, 0)).toBe(notesBefore);
  });
});
