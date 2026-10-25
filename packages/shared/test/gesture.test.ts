import { describe, expect, it } from "vitest";
import {
  ADAPT_WINDOW,
  applyOp,
  createProject,
  stamp,
  AssistController,
  BendRecorder,
  GestureNoteMachine,
  HAND_LOST_MS,
  PINCH_DOWN,
  PINCH_UP,
  SOFT_CAPTURE_SEMITONES,
  assist,
  bendAt,
  glidePitch,
  heightToPitch,
  isInKey,
  nearestScalePitch,
  palmCentre,
  pinchRatio,
  placeNote,
  shiftBend,
  sliceBend,
  wrapPlayhead,
  quantizeTick,
  type AssistLevel,
  type GestureNoteEvent,
  type HandFrame,
  type Landmark,
  type ProjectKey,
} from "../src";

const C_MAJOR: ProjectKey = { tonic: 0, mode: "major" };

/** A hand whose palm is at height `y` (fractions of the picture), with the thumb and index tips together (pinched) or apart. */
function hand(y: number, pinched: boolean, t = 0): HandFrame {
  const l: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y }));
  l[0] = { x: 0.5, y: y + 0.1 }; // wrist
  for (const i of [5, 9, 13, 17]) l[i] = { x: 0.4 + i * 0.01, y: y - 0.025 }; // knuckles: the palm's centre stays at y
  l[4] = { x: 0.3, y: y - 0.1 }; // thumb tip
  l[8] = { x: pinched ? 0.31 : 0.4, y: y - 0.1 }; // index tip
  return { t, landmarks: l };
}
/** The height at which the hand reads as exactly this continuous pitch. */
const yFor = (pitch: number, low = 60, high = 84) => 0.88 - ((pitch - low) / (high - low)) * (0.88 - 0.12);

describe("hand height to pitch", () => {
  it("maps the top of the usable zone to the highest note and the bottom to the lowest, and clamps beyond", () => {
    expect(heightToPitch(0.12)).toBeCloseTo(84, 9);
    expect(heightToPitch(0.88)).toBeCloseTo(60, 9);
    expect(heightToPitch(0.5)).toBeCloseTo(72, 9);
    expect(heightToPitch(0)).toBe(84);
    expect(heightToPitch(1)).toBe(60);
    expect(heightToPitch(0.5, { low: 48, high: 72 })).toBeCloseTo(60, 9);
  });
  it("palm centre ignores the fingertips, so pinching does not change the pitch", () => {
    expect(palmCentre(hand(0.5, false).landmarks).y).toBeCloseTo(0.5, 9);
    expect(palmCentre(hand(0.5, true).landmarks).y).toBeCloseTo(0.5, 9);
  });
});

describe("the scale helps", () => {
  it("finds the nearest scale note (the lower one on a tie)", () => {
    expect(nearestScalePitch(61.2, C_MAJOR)).toBe(62);
    expect(nearestScalePitch(60.8, C_MAJOR)).toBe(60);
    expect(nearestScalePitch(61, C_MAJOR)).toBe(60); // C# is between C and D: tie, lower
    expect(nearestScalePitch(66, C_MAJOR)).toBe(65); // F# between F and G
    expect(nearestScalePitch(71.9, C_MAJOR)).toBe(72);
  });

  it("full help: whatever the hand does, only scale notes are played; the hand's own note is still recorded for measuring", () => {
    for (let p = 60; p <= 84; p += 0.1) {
      const r = assist(p, C_MAJOR, "full");
      expect(isInKey(r.pitch, C_MAJOR)).toBe(true);
      expect(r.playedInKey).toBe(true);
      expect(r.rawPitch).toBe(Math.round(p));
      expect(r.rawInKey).toBe(isInKey(Math.round(p), C_MAJOR));
    }
    const c = assist(61.0, C_MAJOR, "full");
    expect(c.rawInKey).toBe(false); // the hand was on C#: that is what the learner did
    expect(c.snapped).toBe(true);
    expect(c.playedInKey).toBe(true);
  });

  it("soft help: scale notes pull the hand in, but an outside note can still be reached", () => {
    expect(assist(60.3, C_MAJOR, "soft").pitch).toBe(60); // near C: pulled in
    expect(assist(61.7, C_MAJOR, "soft").pitch).toBe(62); // near D: pulled in
    const reach = assist(61.0, C_MAJOR, "soft"); // exactly between C and D: the outside note is reachable
    expect(reach.pitch).toBe(61);
    expect(reach.playedInKey).toBe(false);
    expect(reach.snapped).toBe(false);
    expect(Math.abs(61 - 60)).toBeGreaterThan(SOFT_CAPTURE_SEMITONES); // so the pull does not swallow it
    // a hand just a little off a scale note is still in the scale at soft help
    expect(assist(60.4, C_MAJOR, "soft").pitch).toBe(60);
  });

  it("guide and free change nothing; only the display differs", () => {
    for (const level of ["guide", "free"] as AssistLevel[]) {
      const r = assist(61.0, C_MAJOR, level);
      expect(r.pitch).toBe(61);
      expect(r.snapped).toBe(false);
      expect(r.playedInKey).toBe(false);
    }
  });

  it("without a key there is nothing to help with or to measure", () => {
    for (const level of ["full", "soft", "guide", "free"] as AssistLevel[]) {
      const r = assist(61.4, null, level);
      expect(r.pitch).toBe(61);
      expect(r.rawInKey).toBeNull();
      expect(r.playedInKey).toBeNull();
    }
  });

  it("a minor key works the same way (A natural minor has no C#)", () => {
    const A_MINOR: ProjectKey = { tonic: 9, mode: "minor" };
    expect(assist(61, A_MINOR, "full").pitch).toBe(60);
    expect(isInKey(assist(66.4, A_MINOR, "full").pitch, A_MINOR)).toBe(true);
  });
});

describe("pinching", () => {
  it("measures thumb-to-index against the hand's own size, and has a gap between closing and opening", () => {
    expect(pinchRatio(hand(0.5, true).landmarks)).toBeLessThan(PINCH_DOWN);
    expect(pinchRatio(hand(0.5, false).landmarks)).toBeGreaterThan(PINCH_UP);
    expect(PINCH_UP).toBeGreaterThan(PINCH_DOWN);
    // the same pose twice as close to the camera (everything scaled) reads the same
    const near = hand(0.5, true).landmarks.map((p) => ({ x: 0.5 + (p.x - 0.5) * 2, y: 0.5 + (p.y - 0.5) * 2 }));
    expect(pinchRatio(near)).toBeCloseTo(pinchRatio(hand(0.5, true).landmarks), 6);
  });
});

describe("notes from a hand", () => {
  const run = (frames: (HandFrame | null)[], opts: { key?: ProjectKey | null; level?: AssistLevel } = {}) => {
    const level = opts.level ?? "full";
    const m = new GestureNoteMachine({ key: () => (opts.key === undefined ? C_MAJOR : opts.key), level: () => level });
    const events: GestureNoteEvent[] = [];
    let displays: ReturnType<GestureNoteMachine["update"]>["display"][] = [];
    let now = 0;
    for (const f of frames) {
      now = f ? f.t : now + 33;
      const r = m.update(f, now);
      events.push(...r.events);
      displays.push(r.display);
    }
    return { events, displays, m };
  };
  /** n frames of a hand at a pitch, 33 ms apart */
  const hold = (pitch: number, pinched: boolean, n: number, t0: number) => Array.from({ length: n }, (_, i) => hand(yFor(pitch), pinched, t0 + i * 33));

  it("a pinch plays the note under the hand and opening the hand stops it", () => {
    const { events } = run([...hold(67, false, 8, 0), ...hold(67, true, 6, 264), ...hold(67, false, 4, 462)]);
    const on = events.filter((e) => e.type === "on");
    const off = events.filter((e) => e.type === "off");
    expect(on).toHaveLength(1);
    expect(off).toHaveLength(1);
    expect(on[0]).toMatchObject({ type: "on", pitch: 67, rawPitch: 67, rawInKey: true, level: "full" });
    expect(off[0]).toMatchObject({ pitch: 67 });
  });

  it("the pinch itself does not move the note (it is taken from before the fingers closed)", () => {
    const { events } = run([...hold(67, false, 10, 0), ...hold(67, true, 4, 330)]);
    expect(events.find((e) => e.type === "on")).toMatchObject({ pitch: 67 });
  });

  it("full help turns a hand between scale notes into a scale note, and says what the hand really did", () => {
    const { events } = run([...hold(61, false, 10, 0), ...hold(61, true, 4, 330)]);
    expect(events.find((e) => e.type === "on")).toMatchObject({ pitch: 60, rawPitch: 61, rawInKey: false, playedInKey: true, snapped: true });
  });

  it("at guide level the same hand plays the outside note", () => {
    const { events } = run([...hold(61, false, 10, 0), ...hold(61, true, 4, 330)], { level: "guide" });
    expect(events.find((e) => e.type === "on")).toMatchObject({ pitch: 61, rawInKey: false, playedInKey: false, snapped: false });
  });

  it("losing the hand while a note is held stops it, but only after a short moment", () => {
    const frames = [...hold(67, false, 8, 0), ...hold(67, true, 6, 264)];
    const m = new GestureNoteMachine({ key: () => C_MAJOR, level: () => "full" });
    let events: GestureNoteEvent[] = [];
    for (const f of frames) events.push(...m.update(f, f.t).events);
    const last = frames[frames.length - 1]!.t;
    expect(m.update(null, last + 60).events).toEqual([]);
    expect(m.holding).toBe(true);
    events = m.update(null, last + HAND_LOST_MS + 50).events;
    expect(events).toEqual([expect.objectContaining({ type: "off", pitch: 67 })]);
    expect(m.holding).toBe(false);
  });

  it("jitter in the picture does not change the note while the hand stays on it", () => {
    const frames: HandFrame[] = [];
    for (let i = 0; i < 20; i++) frames.push(hand(yFor(67) + (i % 2 ? 0.004 : -0.004), false, i * 33));
    for (let i = 0; i < 4; i++) frames.push(hand(yFor(67) + (i % 2 ? 0.004 : -0.004), true, 660 + i * 33));
    expect(run(frames).events.find((e) => e.type === "on")).toMatchObject({ pitch: 67 });
  });

  it("release() stops a held note (the panel closed)", () => {
    const { m } = run([...hold(67, false, 8, 0), ...hold(67, true, 6, 264)]);
    expect(m.release(1000)).toEqual([expect.objectContaining({ type: "off", pitch: 67 })]);
    expect(m.release(1001)).toEqual([]);
  });

  it("shows where the hand is, what would be played, and whether it is pinched", () => {
    const { displays } = run([...hold(61, false, 6, 0)]);
    const d = displays[displays.length - 1]!;
    expect(d.hand).toBe(true);
    expect(d.pinched).toBe(false);
    expect(d.pitchFloat).toBeCloseTo(61, 1);
    expect(d.result).toMatchObject({ rawPitch: 61, pitch: 60 });
    expect(run([null]).displays[0]).toMatchObject({ hand: false, result: null });
  });
});

describe("fading the help", () => {
  const feed = (c: AssistController, pattern: (i: number) => boolean | null, n: number) => {
    const changes = [];
    for (let i = 0; i < n; i++) {
      const ch = c.record(pattern(i));
      if (ch) changes.push(ch);
    }
    return changes;
  };

  it("starts with full help and reduces it after a window of notes the learner played in key without the help", () => {
    const c = new AssistController("full");
    expect(feed(c, () => true, ADAPT_WINDOW - 1)).toEqual([]); // not enough notes yet
    const changes = feed(c, () => true, 1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: "full", to: "soft", rate: 1 });
    expect(c.level).toBe("soft");
  });

  it("waits for a whole new window before changing again, and ends at no help", () => {
    const c = new AssistController("full");
    const changes = feed(c, () => true, ADAPT_WINDOW * 5);
    expect(changes.map((x) => x.to)).toEqual(["soft", "guide", "free"]);
    expect(feed(c, () => true, ADAPT_WINDOW * 2)).toEqual([]); // nothing beyond free
  });

  it("judges the hand's own note, so full help cannot make a struggling learner look good", () => {
    // every note PLAYED is in the key at full help, but the learner's hand was on a scale note only 1 time in 4
    const c = new AssistController("full");
    const played = Array.from({ length: ADAPT_WINDOW * 3 }, () => assist(61.0, C_MAJOR, "full").playedInKey);
    expect(played.every(Boolean)).toBe(true);
    expect(feed(c, (i) => i % 4 === 0, ADAPT_WINDOW * 3)).toEqual([]);
    expect(c.level).toBe("full"); // it did not fade
    expect(c.rate).toBeCloseTo(0.25, 6);
  });

  it("gives some help back when the learner struggles at a lower level", () => {
    const c = new AssistController("guide");
    const changes = feed(c, (i) => i % 4 === 0, ADAPT_WINDOW); // 25% in key
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: "guide", to: "soft" });
    expect(feed(new AssistController("full"), () => false, ADAPT_WINDOW * 3)).toEqual([]); // already the most help
  });

  it("does not move on a middling run", () => {
    const c = new AssistController("soft");
    expect(feed(c, (i) => i % 4 !== 0, ADAPT_WINDOW * 3)).toEqual([]); // 75%
    expect(c.level).toBe("soft");
  });

  it("fixed mode never changes the level (for a study condition), and a manual choice restarts the count", () => {
    const fixed = new AssistController("full", false);
    expect(feed(fixed, () => true, ADAPT_WINDOW * 4)).toEqual([]);
    expect(fixed.level).toBe("full");
    const c = new AssistController("full");
    feed(c, () => true, ADAPT_WINDOW - 1);
    c.setLevel("guide", true);
    expect(c.rate).toBeNull();
    expect(feed(c, () => true, 1)).toEqual([]);
  });

  it("ignores notes played with no key (nothing to judge them by)", () => {
    const c = new AssistController("full");
    expect(feed(c, () => null, ADAPT_WINDOW * 3)).toEqual([]);
    expect(c.rate).toBeNull();
  });
});

describe("the playhead between updates", () => {
  it("wraps at the end of the song, or of the loop region, like the real playhead", () => {
    expect(wrapPlayhead(1000, undefined, 15360)).toBe(1000);
    expect(wrapPlayhead(15360, undefined, 15360)).toBe(0);
    expect(wrapPlayhead(15400, undefined, 15360)).toBe(40);
    expect(wrapPlayhead(8000, { startTick: 3840, endTick: 7680 }, 15360)).toBe(4160); // 320 past the loop end -> 320 into the loop
    expect(wrapPlayhead(5000, { startTick: 3840, endTick: 7680 }, 15360)).toBe(5000);
    expect(wrapPlayhead(100, { startTick: 3840, endTick: 7680 }, 15360)).toBe(100); // before the loop: the song is still on its way in
    expect(wrapPlayhead(99999, undefined, 0)).toBe(99999); // an empty song cannot wrap
  });
});

describe("recording the notes", () => {
  it("snaps to the grid and never makes a note shorter than one step", () => {
    expect(quantizeTick(119, 240)).toBe(0);
    expect(quantizeTick(121, 240)).toBe(240);
    expect(quantizeTick(500, 0)).toBe(500);
    // 120 bpm, 960 ppq: 1000 ms = 1920 ticks
    expect(placeNote(960, 1000, 120, 960, 240)).toEqual({ startTick: 960, durationTicks: 1920 });
    expect(placeNote(975, 30, 120, 960, 240)).toEqual({ startTick: 960, durationTicks: 240 });
    expect(placeNote(-50, 100, 120, 960, 240).startTick).toBe(0);
  });
});

describe("gliding between notes", () => {
  it("rests on scale notes and slides between them when there is help (C major: C to D)", () => {
    expect(glidePitch(60, C_MAJOR, "full")).toBe(60);
    expect(glidePitch(60.4, C_MAJOR, "full")).toBe(60); // still on the C
    expect(glidePitch(61, C_MAJOR, "full")).toBeCloseTo(61, 6); // halfway across: halfway
    expect(glidePitch(61.7, C_MAJOR, "full")).toBe(62); // arrived on the D
    expect(glidePitch(61, C_MAJOR, "soft")).toBeCloseTo(61, 6);
    expect(glidePitch(60.5, C_MAJOR, "soft")).toBeGreaterThan(60.1); // soft help hardly holds the note
    expect(glidePitch(60.5, C_MAJOR, "full")).toBe(60); // full help holds it
  });
  it("is the hand's own pitch with no help or no key", () => {
    for (const p of [60.0, 60.37, 61.5, 66.2]) {
      expect(glidePitch(p, C_MAJOR, "guide")).toBe(p);
      expect(glidePitch(p, C_MAJOR, "free")).toBe(p);
      expect(glidePitch(p, null, "full")).toBe(p);
    }
  });
  it("never jumps and never goes backwards as the hand rises", () => {
    for (const level of ["full", "soft"] as AssistLevel[]) {
      let last = glidePitch(60, C_MAJOR, level);
      for (let p = 60.01; p <= 84; p += 0.01) {
        const g = glidePitch(p, C_MAJOR, level);
        expect(g).toBeGreaterThanOrEqual(last - 1e-9);
        expect(g - last).toBeLessThan(0.06); // no jump larger than the hand's own step times the steepest slide
        last = g;
      }
    }
  });
  it("rests exactly on every scale note of a minor key when the hand is just beside it", () => {
    const A_MINOR: ProjectKey = { tonic: 9, mode: "minor" };
    for (let n = 57; n <= 81; n++) {
      if (!isInKey(n, A_MINOR)) continue;
      expect(glidePitch(n + 0.05, A_MINOR, "full")).toBe(n);
      expect(glidePitch(n - 0.05, A_MINOR, "full")).toBe(n);
    }
  });
});

describe("a held note following the hand", () => {
  const frames = (pitches: number[], pinchFrom: number, t0 = 0) => pitches.map((p, i) => hand(yFor(p), i >= pinchFrom, t0 + i * 33));
  const play = (pitches: number[], pinchFrom: number, glide: boolean, level: AssistLevel = "free", key: ProjectKey | null = C_MAJOR) => {
    const m = new GestureNoteMachine({ key: () => key, level: () => level, glide: () => glide });
    const events: GestureNoteEvent[] = [];
    let last = null as ReturnType<GestureNoteMachine["update"]>["display"] | null;
    for (const f of frames(pitches, pinchFrom)) {
      const r = m.update(f, f.t);
      events.push(...r.events);
      last = r.display;
    }
    return { events, last: last! };
  };
  const bendsOf = (events: GestureNoteEvent[]) => events.filter((e): e is Extract<GestureNoteEvent, { type: "bend" }> => e.type === "bend");
  // the hand settles at 60, pinches, then rises smoothly to 64 and stays there
  const rise = [...Array(14).fill(60), ...Array(4).fill(60), ...Array.from({ length: 30 }, (_, i) => 60 + (4 * (i + 1)) / 30), ...Array(14).fill(64)];

  it("with glide on, the pitch bend follows the hand from where the note started", () => {
    const { events, last } = play(rise, 14, true);
    const bends = bendsOf(events);
    expect(events.find((e) => e.type === "on")).toMatchObject({ pitch: 60 });
    expect(bends.length).toBeGreaterThan(5);
    for (let i = 1; i < bends.length; i++) expect(bends[i]!.semis).toBeGreaterThanOrEqual(bends[i - 1]!.semis); // rising hand, rising bend
    expect(bends[bends.length - 1]!.semis).toBeGreaterThan(3.6);
    expect(bends[bends.length - 1]!.semis).toBeLessThan(4.2);
    expect(last.bend).toBeGreaterThan(3.6);
  });
  it("with glide off, the note stays on its pitch however the hand moves", () => {
    const { events, last } = play(rise, 14, false);
    expect(bendsOf(events)).toEqual([]);
    expect(last.bend).toBeNull();
  });
  it("a still hand sends nothing (the bend is only sent when it changes)", () => {
    const still = [...Array(14).fill(60), ...Array(40).fill(60)];
    expect(bendsOf(play(still, 14, true).events)).toEqual([]);
  });
  it("with full help the bend rests on scale notes: a rise from C to E in C major ends exactly on E", () => {
    const bends = bendsOf(play(rise, 14, true, "full").events);
    expect(bends[bends.length - 1]!.semis).toBeCloseTo(4, 1);
  });
  it("is limited to two octaves either way", () => {
    const m = new GestureNoteMachine({ key: () => null, level: () => "free", glide: () => true, range: { low: 36, high: 96 } });
    let last = 0;
    for (const f of frames([...Array(14).fill(36), ...Array(4).fill(36), ...Array(40).fill(96)], 14)) for (const e of m.update(f, f.t).events) if (e.type === "bend") last = e.semis;
    expect(last).toBeLessThanOrEqual(24);
    expect(last).toBeGreaterThan(20);
  });
});

describe("the bend curve of a note", () => {
  it("bendAt reads straight lines between points and holds the ends", () => {
    const c = [{ tick: 0, semis: 0 }, { tick: 960, semis: 4 }];
    expect(bendAt(c, -5)).toBe(0);
    expect(bendAt(c, 480)).toBe(2);
    expect(bendAt(c, 5000)).toBe(4);
    expect(bendAt([], 100)).toBe(0);
  });
  it("records a smooth rise as a few points", () => {
    const r = new BendRecorder();
    for (let ms = 33; ms <= 500; ms += 33) r.add(ms, (2 * ms) / 500); // up two semitones over half a second
    const curve = r.finish(500, 120, 960)!; // 120 bpm: 500 ms = 960 ticks
    expect(curve.length).toBeLessThanOrEqual(3);
    expect(curve[0]).toEqual({ tick: 0, semis: 0 });
    expect(curve[curve.length - 1]!.tick).toBe(960);
    expect(curve[curve.length - 1]!.semis).toBeCloseTo(2, 1);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!.tick).toBeGreaterThan(curve[i - 1]!.tick);
  });
  it("records nothing for a pitch that did not really move", () => {
    const r = new BendRecorder();
    for (let ms = 33; ms <= 500; ms += 33) r.add(ms, 0.02 * Math.sin(ms));
    expect(r.finish(500, 120, 960)).toBeUndefined();
  });
  it("never keeps more points than a note may hold, however wobbly the hand was", () => {
    const r = new BendRecorder();
    for (let ms = 10; ms <= 5000; ms += 10) r.add(ms, 3 * Math.sin(ms / 53) + 2 * Math.sin(ms / 17));
    const curve = r.finish(5000, 120, 960)!;
    expect(curve.length).toBeLessThanOrEqual(48);
    expect(Math.max(...curve.map((p) => Math.abs(p.semis)))).toBeLessThanOrEqual(24);
  });
  it("moves with the note when its start is placed on the grid, keeping the value it had at the new start", () => {
    const c = [{ tick: 0, semis: 0 }, { tick: 480, semis: 2 }];
    expect(shiftBend(c, 240)).toEqual([{ tick: 240, semis: 0 }, { tick: 720, semis: 2 }]);
    expect(shiftBend(c, -240)).toEqual([{ tick: 0, semis: 1 }, { tick: 240, semis: 2 }]);
  });
  it("a piece of a chopped note gets its own part of the curve", () => {
    const c = [{ tick: 0, semis: 0 }, { tick: 960, semis: 4 }];
    expect(sliceBend(c, 480, 960)).toEqual([{ tick: 0, semis: 2 }, { tick: 480, semis: 4 }]);
    expect(sliceBend(c, 0, 480)).toEqual([{ tick: 0, semis: 0 }, { tick: 480, semis: 2 }]);
    expect(sliceBend([{ tick: 0, semis: 0 }], 0, 480)).toBeUndefined(); // nothing to keep
    expect(sliceBend(undefined, 0, 480)).toBeUndefined();
  });
});

describe("a note's pitch bend in the project", () => {
  const add = (note: Record<string, unknown>) => applyOp(createProject("p"), stamp({ type: "addNote", trackId: "track-1", clipId: "clip-1", note: { id: "n", pitch: 60, startTick: 0, durationTicks: 960, velocity: 90, ...note } } as never, "op", "t"));
  it("is stored with the note and tidied to a hundredth of a semitone", () => {
    const r = add({ bend: [{ tick: 0, semis: 0 }, { tick: 480, semis: 1.23456 }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.tracks["track-1"]!.clips["clip-1"]!.notes["n"]!.bend).toEqual([{ tick: 0, semis: 0 }, { tick: 480, semis: 1.23 }]);
  });
  it("a note without one is unchanged", () => {
    const r = add({});
    expect(r.ok && r.project.tracks["track-1"]!.clips["clip-1"]!.notes["n"]!.bend).toBe(undefined);
  });
  it("is refused when it is malformed", () => {
    expect(add({ bend: [] }).ok).toBe(false);
    expect(add({ bend: [{ tick: 100, semis: 0 }, { tick: 50, semis: 1 }] }).ok).toBe(false); // out of order
    expect(add({ bend: [{ tick: 0, semis: 0 }, { tick: 0, semis: 1 }] }).ok).toBe(false); // same time twice
    expect(add({ bend: [{ tick: -1, semis: 0 }] }).ok).toBe(false);
    expect(add({ bend: [{ tick: 0, semis: 25 }] }).ok).toBe(false); // more than two octaves
    expect(add({ bend: [{ tick: 0, semis: Number.NaN }] }).ok).toBe(false);
    expect(add({ bend: Array.from({ length: 49 }, (_, i) => ({ tick: i, semis: 0 })) }).ok).toBe(false);
    expect(add({ bend: Array.from({ length: 48 }, (_, i) => ({ tick: i, semis: 0 })) }).ok).toBe(true);
  });
  it("survives moving and transposing the note (the bend is relative to the note)", () => {
    const base = add({ bend: [{ tick: 0, semis: 0 }, { tick: 480, semis: 2 }] });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const moved = applyOp(base.project, stamp({ type: "updateNote", trackId: "track-1", clipId: "clip-1", noteId: "n", changes: { pitch: 67, startTick: 240 } } as never, "op2", "t"));
    expect(moved.ok && moved.project.tracks["track-1"]!.clips["clip-1"]!.notes["n"]!.bend).toEqual([{ tick: 0, semis: 0 }, { tick: 480, semis: 2 }]);
  });
});
