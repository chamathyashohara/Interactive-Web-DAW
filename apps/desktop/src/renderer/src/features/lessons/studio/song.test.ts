import { describe, expect, it } from "vitest";
import { TICKS_PER_BAR, applyOp, createProject, dropSampleOps, duplicateClipOps, type Op, type OpBody, type Project } from "@daw/shared";
import { MODULES, PIANO_STUDIO_IDS } from "../curriculum";
import { lessonView, runStudioCheck, songView } from "./checks";
import { stageSetupOps } from "./exampleSong";
import { arpOps, chopOps, copyClipToTrackOps, newTrackOps, separateDrumsOps, shiftOps } from "./lessonTools";
import { COURSES, PIANO_EXTRA_LESSONS, STUDIO_LESSONS, courseItems, nextStudioLesson } from "./courses";
import { applyPartOps } from "./park";
import { runAll } from "./SpecialTaskPage";
import { SPECIAL_TASKS, SPECIALS } from "./specials";
import { lessonTracksOf } from "./space";
import { hzToValue } from "./songChecks";
import { MOONWING, barTick, songTrackId } from "./songParts";
import type { SongSpec, SoundInfo, StudioCheck, StudioCtx } from "./types";

let n = 0;
const id = () => `x${++n}`;
function apply(p: Project, ops: OpBody[] | null): Project {
  if (!ops) throw new Error("no ops");
  let out = p;
  for (const b of ops) {
    const r = applyOp(out, { opId: `op${++n}`, clientId: "t", ...b } as Op);
    if (!r.ok) throw new Error(r.reason);
    out = r.project;
  }
  return out;
}
const FX: Record<string, SoundInfo & { name: string; durationSec: number }> = {
  "FX/Riser/Riser 2s": { category: "FX", sub: "Riser", name: "Riser 2s", durationSec: 2 },
  "FX/Downlifter/Downlifter 1s": { category: "FX", sub: "Downlifter", name: "Downlifter 1s", durationSec: 1 },
  "Loop/Drum Loop/Boom Drums": { category: "Loop", sub: "Drum Loop", name: "Boom Drums", durationSec: 5.33 },
};
const ctx = (peaks?: StudioCtx["peaks"]): StudioCtx => ({ soundOf: (sid) => FX[sid], auditioned: [], peaks });
/** The song-making lessons by their plan number (they now live in the Piano, Drum sequencer, Kick Drums and Mixing courses). */
const CODE: Record<string, string> = { "0.1": "M30.1", "1.3": "M31.3", "1.4": "M31.4", "2.2": "M32.2", "2.3": "M32.3", "3.2": "M33.2", "4.1": "M34.1", "4.2": "M34.2", "5.1": "M35.1", "5.2": "M35.2", "6.1": "M36.1", "6.2": "M36.2", "7.1": "M37.1", "7.2": "M37.2", "7.3": "M37.3", "8.2": "M38.2", "8.3": "M38.3", "8.4": "M38.4", "9.1": "M39.1", "10.1": "M40.1", "10.2": "M40.2", "10.4": "M40.4", "10.5": "M40.5" };
const lesson = (code: string) => STUDIO_LESSONS[CODE[code]!]!;
const setUp = (code: string, stage: "tryIt" | "practice" = "practice") => {
  const r = stageSetupOps(createProject("p"), lesson(code)[stage].setup!, id, { id: "Loop/Drum Loop/Boom Drums", name: "Boom Drums", category: "Loop", durationSec: 5.33, meta: { bpm: 90, bars: 2, loop: true } });
  if (!r.ok) throw new Error(r.reason);
  return apply(createProject("p"), r.ops);
};
const check = (p: Project, code: string, stage: "tryIt" | "practice" = "practice", c = ctx()) => runStudioCheck(lessonView(p), lesson(code)[stage].check as StudioCheck, c);
/** Drops a sound like the workspace does; a sound already on a track is dropped on that track's lane. */
const drop = (p: Project, sid: string, bar: number) => {
  const s = FX[sid]!;
  const lane = p.trackOrder.find((t) => p.tracks[t]!.sample?.id === sid) ?? null;
  const r = dropSampleOps(p, { id: sid, name: s.name, category: s.category, durationSec: s.durationSec, meta: {} }, barTick(bar), lane, { trackId: `lesson-k-${id()}`, clipId: id(), noteId: id() }, "#ffffff");
  return apply(p, r.ok ? r.ops : null);
};
const clipsOf = (p: Project, part: string) => Object.values(p.tracks[songTrackId(part as never)]!.clips).sort((a, b) => a.startTick - b.startTick);
const deleteClipsIn = (p: Project, part: string, from: number, to: number) =>
  apply(p, clipsOf(p, part).filter((c) => c.startTick >= barTick(from) && c.startTick < barTick(to + 1)).map((c) => ({ type: "deleteClip" as const, trackId: songTrackId(part as never), clipId: c.id })));
const duplicate = (p: Project, trackId: string, times: number) => {
  let out = p;
  for (let i = 0; i < times; i++) {
    const t = out.tracks[trackId]!;
    const last = Object.values(t.clips).sort((a, b) => b.startTick - a.startTick)[0]!;
    out = apply(out, duplicateClipOps(trackId, t, last, id(), id, out.songBars * TICKS_PER_BAR));
  }
  return out;
};

describe("the song-making lessons live in the four courses, easiest first", () => {
  it("are each placed once: Piano L5-L7, Drum sequencer S2, Kick Drums K1-K4, Mixing; no Make a Song course", () => {
    const ids = (c: keyof typeof COURSES) => COURSES[c].modules.map((m) => `${m.code}:${m.lessons.map((l) => l.id).join(",")}`);
    expect(Object.keys(COURSES)).toEqual(["kick", "sequencer", "mixing"]);
    expect(ids("kick")).toEqual(["K1:M30.1,M12.1,M12.2,M12.3,M12.4,M12.5,M12.6", "K2:M33.1,M33.2,M34.1,M34.2,M36.2", "K3:M13.1,M13.2,M37.1,M37.2,M13.3,M37.3,M13.4,M13.5,M13.6", "K4:M38.4,M39.1"]);
    expect(ids("sequencer")).toEqual(["S1:M14.1,M14.2,M14.3,M14.4,M14.5", "S2:M32.2,M32.3,M14.7", "S3:M14.6,M14.8,M14.9,M14.10"]);
    expect(ids("mixing")).toEqual(["X1:M40.1,M40.2,M40.3,M40.4,M40.5"]);
    expect(MODULES.map((m) => m.code)).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
    expect(MODULES.find((m) => m.code === "L7")!.items.map((i) => i.id)).toEqual(["M35.1", "M35.2", "M36.1"]);
    expect(PIANO_EXTRA_LESSONS.map((l) => l.id).sort()).toEqual([...PIANO_STUDIO_IDS].sort());
    const all = [...Object.values(COURSES).flatMap((c) => courseItems(c).map((i) => i.id)), ...PIANO_STUDIO_IDS];
    expect(new Set(all).size).toBe(all.length);
    for (const id of Object.values(CODE)) expect(all, id).toContain(id);
    expect(STUDIO_LESSONS["M41.1"]).toBeUndefined();
    for (const l of Object.values(STUDIO_LESSONS)) {
      expect(l.practice.hints, l.id).toHaveLength(3);
      expect(l.watch.steps.length, l.id).toBeGreaterThanOrEqual(3);
    }
    expect(nextStudioLesson("M30.1", "kick")?.id).toBe("M12.1");
    expect(nextStudioLesson("M13.6", "kick")?.id).toBe("M38.4");
    expect(nextStudioLesson("M14.5", "sequencer")?.id).toBe("M32.2");
  });

  it("every course ends with its Special task; Piano with two", () => {
    expect(COURSES.kick.specials).toEqual(["M50.4"]);
    expect(COURSES.sequencer.specials).toEqual(["M50.3"]);
    expect(COURSES.mixing.specials).toEqual(["M50.5"]);
    expect(SPECIALS.map((t) => t.id)).toEqual(["M50.1", "M50.2", "M50.3", "M50.4", "M50.5", "M51.1"]);
  });
});

describe("Make a Song checks: starting setups fail, the plan's activity passes", () => {
  it("0.1 tempo 124 and loop", () => {
    let p = setUp("0.1");
    expect(check(p, "0.1").pass).toBe(false);
    p = apply(p, [{ type: "setTempo", bpm: 124 }, { type: "setLoop", loop: { startTick: 0, endTick: 4 * TICKS_PER_BAR } }]);
    expect(check(p, "0.1").pass).toBe(true);
  });

  it("1.3 repeat to 16 bars (octave up and back keeps it in range)", () => {
    let p = setUp("1.3");
    expect(check(p, "1.3").pass).toBe(false);
    p = duplicate(p, songTrackId("piano"), 1);
    expect(check(p, "1.3", "tryIt").pass).toBe(true);
    p = duplicate(p, songTrackId("piano"), 2);
    const c = clipsOf(p, "piano")[0]!;
    p = apply(p, shiftOps(songTrackId("piano"), c, 12));
    p = apply(p, shiftOps(songTrackId("piano"), clipsOf(p, "piano")[0]!, -12));
    expect(check(p, "1.3").pass).toBe(true);
    expect(check(apply(p, shiftOps(songTrackId("piano"), clipsOf(p, "piano")[0]!, 36)), "1.3").feedback).toMatch(/too high or too low/);
  });

  it("1.4 layer the progression on pads", () => {
    let p = setUp("1.4");
    expect(check(p, "1.4").feedback).toMatch(/Add a pad track/);
    p = apply(p, newTrackOps("synth", "Pads", "#818cf8", "lesson-k-pads", "pc0", 1));
    p = apply(p, [{ type: "deleteClip", trackId: "lesson-k-pads", clipId: "pc0" }]);
    for (const c of clipsOf(p, "piano")) p = apply(p, copyClipToTrackOps(p, c, "lesson-k-pads", id));
    expect(check(p, "1.4").pass).toBe(true);
  });

  it("2.2 hats off the beat, 2.3 clap on 2 and 4", () => {
    const add = (p: Project, pitch: number, list: number[]) => apply(p, list.map((x) => ({ type: "addNote" as const, trackId: "lesson-k-seq", clipId: "lesson-k-seq-clip", note: { id: id(), pitch, startTick: (x - 1) * 240, durationTicks: 240, velocity: 100 } })));
    expect(check(setUp("2.2"), "2.2").pass).toBe(false);
    expect(check(add(setUp("2.2"), 42, [3, 7, 11, 15]), "2.2").pass).toBe(true);
    expect(check(add(setUp("2.2"), 42, [3, 7, 11, 15, 16]), "2.2").feedback).toMatch(/remove the extra/);
    expect(check(setUp("2.3"), "2.3").feedback).toMatch(/Clap: nothing on pad 5, pad 13/);
    expect(check(add(setUp("2.3"), 39, [5, 13]), "2.3").pass).toBe(true);
  });

  it("3.2 intro: no kick in 1-8, kick in 9-16", () => {
    let p = setUp("3.2");
    expect(check(p, "3.2").feedback).toMatch(/already plays in bar 1/);
    const k = clipsOf(p, "kick")[0]!;
    p = apply(p, [{ type: "updateClip", trackId: songTrackId("kick"), clipId: k.id, changes: { startTick: barTick(9) } }]);
    expect(check(p, "3.2", "tryIt").pass).toBe(true);
    p = duplicate(p, songTrackId("kick"), 1);
    expect(check(p, "3.2").pass).toBe(true);
  });

  it("4.1 sweep ending on bar 9; 4.2 the pair", () => {
    expect(check(setUp("4.1"), "4.1").pass).toBe(false);
    expect(check(drop(setUp("4.1"), "FX/Riser/Riser 2s", 8), "4.1").feedback).toMatch(/does not end on bar 9/);
    const withSweep = drop(setUp("4.1"), "FX/Riser/Riser 2s", 7);
    expect(check(withSweep, "4.1").pass).toBe(true);
    expect(check(drop(setUp("4.2"), "FX/Downlifter/Downlifter 1s", 9), "4.2", "tryIt").pass).toBe(true);
    expect(check(drop(setUp("4.2"), "FX/Downlifter/Downlifter 1s", 9), "4.2").feedback).toMatch(/First the sweep/);
    expect(check(drop(drop(setUp("4.2"), "FX/Downlifter/Downlifter 1s", 9), "FX/Riser/Riser 2s", 7), "4.2").pass).toBe(true);
  });

  it("5.1 roots only, in the bass range; 5.2 chopped", () => {
    let p = setUp("5.1");
    expect(check(p, "5.1").pass).toBe(false);
    for (const c of clipsOf(p, "bass")) {
      const keep = new Set(Object.values(c.notes).filter((x) => x.startTick % TICKS_PER_BAR === 0).reduce<Record<number, string>>((m, x) => ((m[x.startTick] = m[x.startTick] && c.notes[m[x.startTick]!]!.pitch < x.pitch ? m[x.startTick]! : x.id), m), {}) && Object.values(Object.values(c.notes).reduce<Record<number, (typeof c.notes)[string]>>((m, x) => ((m[x.startTick] = !m[x.startTick] || x.pitch < m[x.startTick]!.pitch ? x : m[x.startTick]!), m), {})).map((x) => x.id));
      p = apply(p, Object.values(c.notes).filter((x) => !keep.has(x.id)).map((x) => ({ type: "deleteNote" as const, trackId: songTrackId("bass"), clipId: c.id, noteId: x.id })));
    }
    expect(check(p, "5.1").feedback).toMatch(/too high/);
    for (const c of clipsOf(p, "bass")) p = apply(p, shiftOps(songTrackId("bass"), c, -24));
    expect(check(p, "5.1").pass).toBe(true);

    let q = setUp("5.2");
    expect(check(q, "5.2").feedback).toMatch(/Use Chop/);
    q = apply(q, chopOps(songTrackId("bass"), clipsOf(q, "bass")[0]!, 480, id));
    expect(check(q, "5.2", "tryIt").pass).toBe(true);
    q = apply(q, chopOps(songTrackId("bass"), clipsOf(q, "bass")[1]!, 480, id));
    expect(check(q, "5.2").pass).toBe(true);
  });

  it("6.1 arp in bars 17-32; 6.2 the pair at bar 33", () => {
    let p = setUp("6.1");
    expect(check(p, "6.1").feedback).toMatch(/Add an Arp track/);
    p = apply(p, newTrackOps("synth", "Arp", "#34d399", "lesson-k-arp", "ac0", 1));
    p = apply(p, [{ type: "deleteClip", trackId: "lesson-k-arp", clipId: "ac0" }]);
    for (const c of clipsOf(p, "piano").filter((x) => x.startTick >= barTick(17))) p = apply(p, copyClipToTrackOps(p, c, "lesson-k-arp", id));
    expect(check(p, "6.1").feedback).toMatch(/still has chords/);
    for (const c of Object.values(p.tracks["lesson-k-arp"]!.clips)) p = apply(p, arpOps("lesson-k-arp", c, "updown", 240, id));
    expect(check(p, "6.1").pass).toBe(true);
    expect(check(drop(drop(setUp("6.2"), "FX/Riser/Riser 2s", 31), "FX/Downlifter/Downlifter 1s", 33), "6.2").pass).toBe(true);
  });

  it("7.1 strip back, 7.2 filter at 1 kHz, 7.3 open the filter into the drop", () => {
    let p = setUp("7.1");
    expect(check(p, "7.1", "tryIt").pass).toBe(false);
    p = deleteClipsIn(p, "kick", 33, 48);
    expect(check(p, "7.1", "tryIt").pass).toBe(true);
    for (const part of ["bass", "hats", "clap", "arp"]) p = deleteClipsIn(p, part, 33, 48);
    expect(check(p, "7.1").pass).toBe(true);

    const f = setUp("7.2");
    expect(check(f, "7.2").feedback).toMatch(/Open the ∿ lane/);
    const at = (hz: number) => apply(f, [{ type: "setAutomation", trackId: songTrackId("pads"), param: "filter", points: [{ tick: barTick(33), value: hzToValue(hz) }] }]);
    expect(check(at(5000), "7.2").feedback).toMatch(/5.0 kHz/);
    expect(check(at(1000), "7.2").pass).toBe(true);
    expect(check(at(2000), "7.2", "tryIt").pass).toBe(true);

    let b = setUp("7.3");
    const kick = clipsOf(b, "kick").find((c) => c.startTick === barTick(29))!;
    for (const bar of [49, 53, 57, 61]) b = apply(b, [{ type: "addClip", trackId: songTrackId("kick"), clip: { ...kick, id: id(), startTick: barTick(bar), notes: Object.fromEntries(Object.values(kick.notes).map((x) => { const nid = id(); return [nid, { ...x, id: nid }]; })) } }]);
    expect(check(b, "7.3", "tryIt").pass).toBe(true);
    b = apply(b, [{ type: "setAutomation", trackId: songTrackId("pads"), param: "filter", points: [{ tick: barTick(49), value: hzToValue(1000) }, { tick: barTick(65), value: 1 }] }]);
    expect(check(b, "7.3").feedback).toMatch(/Riser so it ends exactly on bar 65/);
    expect(check(drop(b, "FX/Riser/Riser 2s", 63), "7.3").pass).toBe(true);
  });

  it("8.2 a chord tone on the downbeat; 8.3 A-B-A-C; 8.4 the full drop", () => {
    let p = setUp("8.2");
    expect(check(p, "8.2").pass).toBe(false);
    const mel = clipsOf(p, "melody")[0]!;
    const last = Object.values(mel.notes).sort((a, b) => b.startTick - a.startTick)[0]!;
    p = apply(p, [{ type: "updateNote", trackId: songTrackId("melody"), clipId: mel.id, noteId: last.id, changes: { startTick: 3 * TICKS_PER_BAR, pitch: 67 } }]);
    expect(check(p, "8.2").pass).toBe(true);

    let m = setUp("8.3");
    expect(check(m, "8.3", "tryIt").pass).toBe(false);
    m = duplicate(m, songTrackId("melody"), 1);
    expect(check(m, "8.3", "tryIt").pass).toBe(true);
    m = duplicate(m, songTrackId("melody"), 2);
    expect(check(m, "8.3").feedback).toMatch(/is a copy/);
    const [, b2, , c4] = clipsOf(m, "melody");
    const edit = (clip: typeof b2, pitch: number) => {
      const first = Object.values(clip!.notes).sort((a, b) => a.startTick - b.startTick)[0]!;
      return [{ type: "updateNote" as const, trackId: songTrackId("melody"), clipId: clip!.id, noteId: first.id, changes: { pitch } }];
    };
    m = apply(apply(m, edit(b2, 79)), edit(c4, 72));
    expect(check(m, "8.3").pass).toBe(true);

    const d = setUp("8.4");
    expect(check(d, "8.4", "tryIt").feedback).toMatch(/missing in bars 65-72/);
    const full = apply(createProject("p"), (stageSetupOps(createProject("p"), { song: { bars: 96, parts: { piano: [[65, 96]], pads: [[65, 96]], kick: [[65, 96]], hats: [[65, 96]], clap: [[65, 96]], bass: [[65, 96]], arp: [[65, 96]], melody: [[65, 96]] } } }, id) as { ok: true; ops: OpBody[] }).ops);
    expect(check(full, "8.4").pass).toBe(true);
  });

  it("9.1 one element fewer every 4 bars while the filter closes", () => {
    let p = setUp("9.1");
    expect(check(p, "9.1").pass).toBe(false);
    p = deleteClipsIn(p, "melody", 101, 112);
    expect(check(p, "9.1", "tryIt").pass).toBe(true);
    p = deleteClipsIn(p, "arp", 105, 112);
    p = deleteClipsIn(p, "clap", 109, 112);
    expect(check(p, "9.1").feedback).toMatch(/filter curve that goes down/);
    p = apply(p, [{ type: "setAutomation", trackId: songTrackId("pads"), param: "filter", points: [{ tick: barTick(97), value: 1 }, { tick: barTick(112), value: 0.4 }] }]);
    expect(check(p, "9.1").pass).toBe(true);
  });

  it("10.1 one track per element, named; 10.4 pan", () => {
    let p = setUp("10.1");
    expect(check(p, "10.1", "tryIt").feedback).toMatch(/Drums plays kick, hats, clap/);
    p = apply(p, separateDrumsOps(p, "lesson-song-drums", () => `lesson-k-${id()}`, id));
    expect(check(p, "10.1", "tryIt").pass).toBe(true);
    expect(check(p, "10.1").feedback).toMatch(/Rename Synth 1 to piano/);
    for (const part of ["piano", "pads", "bass", "arp", "melody"]) p = apply(p, [{ type: "updateTrack", trackId: songTrackId(part as never), changes: { name: part[0]!.toUpperCase() + part.slice(1) } }]);
    expect(check(p, "10.1").pass).toBe(true);

    let q = setUp("10.4");
    expect(check(q, "10.4").pass).toBe(false);
    q = apply(q, [{ type: "updateTrack", trackId: songTrackId("hats"), changes: { pan: -25 } }, { type: "updateTrack", trackId: songTrackId("arp"), changes: { pan: 25 } }]);
    expect(check(q, "10.4").pass).toBe(true);
    expect(check(apply(q, [{ type: "updateTrack", trackId: songTrackId("bass"), changes: { pan: 40 } }]), "10.4").feedback).toMatch(/Keep the kick and the bass in the middle/);
  });

  it("10.2 gain staging and 10.5 headroom read the peaks measured while playing", () => {
    const p = setUp("10.2");
    const lin = (db: number) => Math.pow(10, db / 20);
    const peaks = (kick: number, others: number, master = -4) => ({ tracks: Object.fromEntries(p.trackOrder.map((tid) => [tid, lin(tid === songTrackId("kick") ? kick : others)])), master: lin(master), samples: 60 });
    expect(check(p, "10.2", "practice", ctx()).feedback).toMatch(/Press Play/);
    expect(check(p, "10.2", "practice", ctx(peaks(-2, -10))).feedback).toMatch(/Lower its level/);
    expect(check(p, "10.2", "practice", ctx(peaks(-9, -3))).feedback).toMatch(/lower it below the kick/);
    expect(check(p, "10.2", "practice", ctx(peaks(-9, -14))).pass).toBe(true);
    const h = setUp("10.5");
    expect(h.masterVolume).toBe(80);
    expect(check(h, "10.5", "practice", ctx(peaks(-9, -14, -1))).feedback).toMatch(/too loud/);
    expect(check(h, "10.5", "practice", ctx(peaks(-9, -14, -4.5))).pass).toBe(true);
    expect(check(apply(h, [{ type: "setMasterVolume", volume: 60 }]), "10.5", "practice", ctx(peaks(-9, -14, -4.5))).feedback).toMatch(/Put the master back/);
  });

});

describe("Special tasks: Moonwing's Theme, part by part", () => {
  const setUpTask = (taskId: string) => {
    const r = stageSetupOps(createProject("p"), SPECIAL_TASKS[taskId]!.setup!, id);
    if (!r.ok) throw new Error(r.reason);
    return apply(createProject("p"), r.ops);
  };
  const step = (p: Project, taskId: string, i: number) => runAll(lessonView(p), SPECIAL_TASKS[taskId]!.steps[i]!.check);
  const note = (trackId: string, clipId: string, pitch: number, start: number, len: number) => ({ type: "addNote" as const, trackId, clipId, note: { id: id(), pitch, startTick: start, durationTicks: len, velocity: 100 } });

  it("the theme: E minor at 128 BPM, 32 bars are one minute, original phrases with a chromatic turn", () => {
    expect(MOONWING.tempo).toBe(128);
    expect((32 * 4 * 60) / MOONWING.tempo).toBe(60);
    expect(MOONWING.progression.map((c) => c.map((x) => x % 12))).toEqual([[4, 7, 11], [0, 4, 7], [9, 0, 4], [11, 3, 6]]);
    // Every phrase starts each bar on a note of that bar's chord, and A turns E - D# - E.
    for (const ph of Object.values(MOONWING.phrases)) for (const bar of [1, 2, 3, 4]) expect(MOONWING.progression[bar - 1]!.map((x) => x % 12)).toContain(ph.find(([b2, beat]) => b2 === bar && beat === 1)![3] % 12);
    expect(MOONWING.phrases.A.slice(0, 3).map((x) => x[3])).toEqual([76, 75, 76]);
    const setup = setUpTask("M50.1");
    expect(setup.tempo).toBe(128);
    expect(setup.tracks["lesson-song-melody"]!.synthPreset).toBe("pluck");
  });

  it("Piano 1: Em - C - Am - B, sixteen bars, strings, phrase A, then A-B-A-C; Apply names the parts, sets 128 BPM and replaces an earlier copy", () => {
    let p = setUpTask("M50.1");
    expect(step(p, "M50.1", 0).pass).toBe(false);
    expect(step(p, "M50.1", 0).feedback).toMatch(/Bar 1 should be Em \(E G B\)/);
    // Am - F - C - G (the course lessons' chords) is not this song.
    const wrong = apply(p, [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]].flatMap((c, b) => c.map((pitch) => note("lesson-song-piano", "lesson-song-piano-b1", pitch, b * TICKS_PER_BAR, TICKS_PER_BAR - 60))));
    expect(step(wrong, "M50.1", 0).pass).toBe(false);
    p = apply(p, MOONWING.progression.flatMap((c, b) => c.map((pitch) => note("lesson-song-piano", "lesson-song-piano-b1", pitch, b * TICKS_PER_BAR, TICKS_PER_BAR - 60))));
    expect(step(p, "M50.1", 0).pass).toBe(true);
    p = duplicate(p, "lesson-song-piano", 3);
    expect(step(p, "M50.1", 1).pass).toBe(true);
    p = apply(p, newTrackOps("synth", "Strings", "#c084fc", "lesson-k-pads", "pc0", 1, "strings"));
    p = apply(p, [{ type: "deleteClip", trackId: "lesson-k-pads", clipId: "pc0" }]);
    for (const c of clipsOf(p, "piano")) p = apply(p, copyClipToTrackOps(p, c, "lesson-k-pads", id));
    expect(step(p, "M50.1", 2).pass).toBe(true);
    expect(step(p, "M50.1", 3).feedback).toMatch(/Missing: E5 at bar 1, beat 1/);
    p = apply(p, MOONWING.phrases.A.map(([bar, beat, len, pitch]) => note("lesson-song-melody", "lesson-song-melody-b1", pitch, (bar - 1) * TICKS_PER_BAR + (beat - 1) * 960, len * 960)));
    expect(step(p, "M50.1", 3).pass).toBe(true);
    p = duplicate(p, "lesson-song-melody", 3);
    const mel = clipsOf(p, "melody");
    const edit = (clip: (typeof mel)[number], pitch: number) => apply(p, [{ type: "updateNote", trackId: "lesson-song-melody", clipId: clip.id, noteId: Object.values(clip.notes).sort((a, b) => a.startTick - b.startTick)[0]!.id, changes: { pitch } }]);
    p = edit(mel[1]!, 79);
    p = edit(clipsOf(p, "melody")[3]!, 72);
    expect(step(p, "M50.1", 4).pass).toBe(true);
    const { ops } = applyPartOps({ ...p, tempo: 120 }, id, MOONWING.tempo);
    expect(ops.some((o) => o.type === "setTempo" && o.bpm === 128)).toBe(true);
    let song = apply(p, ops);
    const names = () => song.trackOrder.filter((t) => !t.startsWith("lesson-")).map((t) => song.tracks[t]!.name);
    expect(names()).toEqual(["Synth", "Song · Piano", "Song · Melody", "Song · Strings"]);
    expect(song.tracks[song.trackOrder.find((t) => song.tracks[t]!.name === "Song · Strings")!]!.synthPreset).toBe("strings");
    song = apply(song, applyPartOps(song, id).ops);
    expect(names()).toEqual(["Synth", "Song · Piano", "Song · Melody", "Song · Strings"]);
  });

  it("Piano 2: the bass from the roots E, C, A, B in bars 9-16, and a music-box arp in 17-24; the reference is never applied", () => {
    let p = setUpTask("M50.2");
    expect(step(p, "M50.2", 0).pass).toBe(false);
    p = apply(p, newTrackOps("synth", "Bass", "#a78bfa", "lesson-k-bass", "bc0", 1));
    p = apply(p, [{ type: "deleteClip", trackId: "lesson-k-bass", clipId: "bc0" }]);
    const ref = Object.values(p.tracks["lesson-song-ref-piano"]!.clips);
    const at = (bars: number[]) => ref.filter((c) => bars.includes(c.startTick / TICKS_PER_BAR + 1));
    for (const c of at([9, 13])) p = apply(p, copyClipToTrackOps(p, c, "lesson-k-bass", id));
    expect(step(p, "M50.2", 0).pass).toBe(true);
    expect(step(p, "M50.2", 1).feedback).toMatch(/keep only the root \(E\)/);
    for (const c of Object.values(p.tracks["lesson-k-bass"]!.clips)) {
      const lowest = new Map<number, string>();
      for (const n2 of Object.values(c.notes)) if (!lowest.has(n2.startTick) || c.notes[lowest.get(n2.startTick)!]!.pitch > n2.pitch) lowest.set(n2.startTick, n2.id);
      const keep = new Set(lowest.values());
      p = apply(p, Object.values(c.notes).filter((x) => !keep.has(x.id)).map((x) => ({ type: "deleteNote" as const, trackId: "lesson-k-bass", clipId: c.id, noteId: x.id })));
      p = apply(p, shiftOps("lesson-k-bass", p.tracks["lesson-k-bass"]!.clips[c.id]!, -24));
    }
    expect(step(p, "M50.2", 1).pass).toBe(true);
    for (const c of Object.values(p.tracks["lesson-k-bass"]!.clips)) p = apply(p, chopOps("lesson-k-bass", c, 960, id));
    expect(step(p, "M50.2", 2).pass).toBe(true);
    p = apply(p, newTrackOps("synth", "Arp", "#34d399", "lesson-k-arp", "ac0", 1));
    p = apply(p, [{ type: "deleteClip", trackId: "lesson-k-arp", clipId: "ac0" }]);
    for (const c of at([17, 21])) p = apply(p, copyClipToTrackOps(p, c, "lesson-k-arp", id));
    expect(step(p, "M50.2", 3).pass).toBe(false);
    for (const c of Object.values(p.tracks["lesson-k-arp"]!.clips)) p = apply(p, arpOps("lesson-k-arp", c, "up", 240, id));
    expect(step(p, "M50.2", 3).pass).toBe(true);
    const song = apply(p, applyPartOps(p, id).ops);
    expect(song.trackOrder.filter((t) => !t.startsWith("lesson-")).map((t) => song.tracks[t]!.name)).toEqual(["Synth", "Song · Bass", "Song · Arp"]);
  });

  it("Drums: a half-time kick (1 and 3 only), hats, clap, then four bars with a lead-in", () => {
    let p = setUpTask("M50.3");
    const pads = (pitch: number, list: number[]) => list.map((x) => note("lesson-k-seq", "lesson-k-seq-clip", pitch, (x - 1) * 240, 240));
    expect(step(p, "M50.3", 0).pass).toBe(false);
    expect(step(apply(p, pads(36, [1, 5, 9, 13])), "M50.3", 0).pass).toBe(false);
    p = apply(p, pads(36, [1, 9]));
    expect(step(p, "M50.3", 0).pass).toBe(true);
    p = apply(p, pads(42, [3, 7, 11, 15]));
    p = apply(p, pads(39, [5, 13]));
    expect(step(p, "M50.3", 1).pass && step(p, "M50.3", 2).pass).toBe(true);
    p = apply(p, pads(36, [17, 25, 33, 41, 49, 57, 64]));
    expect(step(p, "M50.3", 3).pass).toBe(true);
  });

  it("Transitions: a sweep and a down filter at 9, a sweep and an impact into the climax at 17, a down filter at 25", () => {
    let p = setUpTask("M50.4");
    expect(p.songBars).toBe(32);
    expect(step(p, "M50.4", 0).pass).toBe(false);
    FX["FX/Impact/Impact"] = { category: "FX", sub: "Impact", name: "Impact", durationSec: 2 };
    p = drop(drop(p, "FX/Riser/Riser 2s", 7), "FX/Downlifter/Downlifter 1s", 9);
    p = drop(drop(p, "FX/Riser/Riser 2s", 15), "FX/Impact/Impact", 17);
    p = drop(p, "FX/Downlifter/Downlifter 1s", 25);
    for (let i = 0; i < 3; i++) expect(runAll(lessonView(p), SPECIAL_TASKS["M50.4"]!.steps[i]!.check).pass, `step ${i}`).toBe(true);
    const song = apply(p, applyPartOps(p, id).ops);
    expect(song.trackOrder.filter((t) => !t.startsWith("lesson-")).every((t) => t === "track-1" || song.tracks[t]!.name.startsWith("Song · "))).toBe(true);
    expect(lessonTracksOf(song).some((t) => t.id.startsWith("lesson-song-ref-"))).toBe(true);
  });

  /** A learner's song (track ids "track-..."), built from parts of the theme. */
  const ownSong = (song: { parts: SongSpec["song"]["parts"]; melodyPattern?: string }) => {
    const r = stageSetupOps(createProject("p"), { song: { bars: 32, theme: "moonwing", sharedDrums: true, ...song } }, id) as { ok: true; ops: OpBody[] };
    return apply(createProject("p"), r.ops.map((o) => (o.type === "addTrack" ? { ...o, track: { ...o.track, id: o.track.id.replace("lesson-song-", "track-") } } : o)));
  };
  /** Drops a sound into the learner's song (a new FX track gets an ordinary track id). */
  const own = (p: Project, sid: string, bar: number) => {
    const out = drop(p, sid, bar);
    const fx = out.trackOrder.find((t) => t.startsWith("lesson-k-"));
    if (!fx) return out;
    const nid = `track-${id()}`;
    return { ...out, trackOrder: out.trackOrder.map((t) => (t === fx ? nid : t)), tracks: Object.fromEntries(Object.entries(out.tracks).map(([k, v]) => (k === fx ? [nid, { ...v, id: nid, sample: v.sample }] : [k, v]))) };
  };
  const final = (p: Project, i: number) => runAll(songView(p), SPECIAL_TASKS["M51.1"]!.steps[i]!.check);

  it("Build the whole song reads the learner's own song: it needs every applied part, 128 BPM and 32 bars", () => {
    expect(final(createProject("p"), 0).feedback).toMatch(/Piano: Special task 1/);
    let song = ownSong({ parts: { piano: [[1, 16]], pads: [[1, 16]], melody: [[1, 16]], bass: [[9, 16]], arp: [[17, 24]], kick: [[1, 4]], hats: [[1, 4]], clap: [[1, 4]] } });
    expect(final(song, 0).feedback).toMatch(/Missing: fx/);
    song = own(song, "FX/Riser/Riser 2s", 7);
    expect(final(song, 0).pass).toBe(true);
    expect(final({ ...song, tempo: 124 }, 1).feedback).toMatch(/Type 128/);
    expect(final({ ...song, songBars: 40 }, 1).feedback).toMatch(/32 bars/);
    expect(final(song, 1).pass).toBe(true);
  });

  it("Build the whole song: the 60-second arrangement passes intro, climax, outro and transitions", () => {
    // Intro 1-8 (piano, strings, melody), theme 9-16 (+ drums, bass), climax 17-24 (+ arp), outro 25-32 (thinning out).
    let song = ownSong({ parts: { piano: [[1, 28]], pads: [[1, 32]], melody: [[1, 24]], kick: [[9, 24]], hats: [[9, 24]], clap: [[9, 24]], bass: [[9, 24]], arp: [[17, 32]] }, melodyPattern: "ABAC" });
    expect(final(song, 2).pass).toBe(true);
    expect(final(song, 3).pass).toBe(true);
    expect(final(song, 4).feedback).toMatch(/filter curve/);
    song = apply(song, [{ type: "setAutomation", trackId: "track-pads", param: "filter", points: [{ tick: barTick(25), value: 1 }, { tick: barTick(32), value: hzToValue(400) }] }]);
    expect(final(song, 4).pass).toBe(true);
    // Drums from bar 1: the intro is not quiet any more.
    expect(final(ownSong({ parts: { piano: [[1, 16]], pads: [[1, 16]], kick: [[1, 16]] } }), 2).pass).toBe(false);
    expect(final(song, 5).pass).toBe(false);
    FX["FX/Impact/Impact"] = { category: "FX", sub: "Impact", name: "Impact", durationSec: 2 };
    song = own(own(song, "FX/Riser/Riser 2s", 7), "FX/Downlifter/Downlifter 1s", 9);
    song = own(own(song, "FX/Riser/Riser 2s", 15), "FX/Impact/Impact", 17);
    song = own(song, "FX/Downlifter/Downlifter 1s", 25);
    expect(final(song, 5).pass).toBe(true);
  });
});

describe("lesson tools", () => {
  const clip = { id: "c", startTick: 0, lengthTicks: TICKS_PER_BAR, notes: { a: { id: "a", pitch: 60, startTick: 0, durationTicks: TICKS_PER_BAR, velocity: 100 }, b: { id: "b", pitch: 64, startTick: 0, durationTicks: TICKS_PER_BAR, velocity: 100 }, c: { id: "c", pitch: 67, startTick: 0, durationTicks: TICKS_PER_BAR, velocity: 100 } } };
  it("chop cuts long notes into steps; arp spreads chords; octave shifts every note", () => {
    const chopped = chopOps("t", clip, 480, id).filter((o) => o.type === "addNote");
    expect(chopped).toHaveLength(24);
    const arp = arpOps("t", clip, "up", 240, id).filter((o) => o.type === "addNote").map((o) => (o as { note: { pitch: number } }).note.pitch);
    expect(arp.slice(0, 6)).toEqual([60, 64, 67, 60, 64, 67]);
    expect(arpOps("t", clip, "updown", 240, id).filter((o) => o.type === "addNote").map((o) => (o as { note: { pitch: number } }).note.pitch).slice(0, 5)).toEqual([60, 64, 67, 64, 60]);
    expect(shiftOps("t", clip, 12)!.map((o) => (o as { changes: { pitch: number } }).changes.pitch)).toEqual([72, 76, 79]);
    expect(shiftOps("t", { ...clip, notes: { a: { ...clip.notes.a, pitch: 120 } } }, 12)).toBeNull();
  });
});
