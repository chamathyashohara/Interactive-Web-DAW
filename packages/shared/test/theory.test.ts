import { describe, expect, it } from "vitest";
import {
  ALL_KEYS,
  applyOp,
  createProject,
  invertOp,
  isInKey,
  isTonic,
  isValidKey,
  keyLabel,
  migrateProject,
  nearestInKey,
  neighboursInKey,
  noteName,
  outOfKeyMessage,
  pitchClass,
  projectHash,
  scalePitchClasses,
  type Op,
  type Project,
  type ProjectKey,
} from "../src";

const C_MAJOR: ProjectKey = { tonic: 0, mode: "major" };
const A_MINOR: ProjectKey = { tonic: 9, mode: "minor" };
const G_MAJOR: ProjectKey = { tonic: 7, mode: "major" };
const E_MINOR: ProjectKey = { tonic: 4, mode: "minor" };
const F_MAJOR: ProjectKey = { tonic: 5, mode: "major" };

describe("scales (facts from docs/lessons/CURRICULUM.md section 4)", () => {
  it("major scales", () => {
    expect(scalePitchClasses(C_MAJOR)).toEqual([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B
    expect(scalePitchClasses(G_MAJOR)).toEqual([7, 9, 11, 0, 2, 4, 6]); // G A B C D E F#
    expect(scalePitchClasses(F_MAJOR)).toEqual([5, 7, 9, 10, 0, 2, 4]); // F G A Bb C D E
    expect(scalePitchClasses({ tonic: 2, mode: "major" }).sort((a, b) => a - b)).toEqual([1, 2, 4, 6, 7, 9, 11]); // D E F# G A B C#
  });
  it("natural minor scales; A minor shares its notes with C major (relative minor)", () => {
    expect(scalePitchClasses(A_MINOR)).toEqual([9, 11, 0, 2, 4, 5, 7]);
    expect([...scalePitchClasses(A_MINOR)].sort((a, b) => a - b)).toEqual([...scalePitchClasses(C_MAJOR)].sort((a, b) => a - b));
    expect(scalePitchClasses(E_MINOR)).toEqual([4, 6, 7, 9, 11, 0, 2]); // E F# G A B C D
  });
  it("every key has exactly 7 distinct notes", () => {
    expect(ALL_KEYS).toHaveLength(24);
    for (const k of ALL_KEYS) expect(new Set(scalePitchClasses(k)).size).toBe(7);
  });
});

describe("in key / out of key", () => {
  it("any octave counts: C major contains C4, C5, E2 but not C#4 or F#3", () => {
    for (const p of [60, 72, 40]) expect(isInKey(p, C_MAJOR)).toBe(true);
    for (const p of [61, 54]) expect(isInKey(p, C_MAJOR)).toBe(false);
  });
  it("F# is out of C major but in G major; with no key everything is allowed", () => {
    expect(isInKey(66, C_MAJOR)).toBe(false);
    expect(isInKey(66, G_MAJOR)).toBe(true);
    expect(isInKey(66, null)).toBe(true);
  });
  it("finds the tonic in any octave", () => {
    expect(isTonic(48, C_MAJOR)).toBe(true);
    expect(isTonic(57, A_MINOR)).toBe(true);
    expect(isTonic(60, A_MINOR)).toBe(false);
    expect(isTonic(60, null)).toBe(false);
  });
  it("nearestInKey leaves in-key notes alone and moves others one semitone, lower on a tie", () => {
    expect(nearestInKey(60, C_MAJOR)).toBe(60);
    expect(nearestInKey(61, C_MAJOR)).toBe(60); // C# -> C (tie: lower wins)
    expect(nearestInKey(63, C_MAJOR)).toBe(62); // D# -> D
    expect(nearestInKey(66, C_MAJOR)).toBe(65); // F# -> F
    expect(nearestInKey(0, { tonic: 4, mode: "major" })).toBe(1); // C is not in E major; B would be -1, so it goes up to C# (stays inside 0-127)
  });
  it("neighbours and the hint message", () => {
    expect(neighboursInKey(66, C_MAJOR)).toEqual({ below: 65, above: 67 });
    expect(outOfKeyMessage(66, C_MAJOR)).toBe("F♯ is not in C major. Try F or G.");
    expect(outOfKeyMessage(71, F_MAJOR)).toBe("B is not in F major. Try B♭ or C."); // flats are used for flat keys
  });
});

describe("names", () => {
  it("spells notes to suit the key", () => {
    expect(noteName(66, G_MAJOR)).toBe("F♯");
    expect(noteName(70, F_MAJOR)).toBe("B♭");
    expect(noteName(63, { tonic: 3, mode: "major" })).toBe("E♭");
    expect(noteName(61)).toBe("C♯");
  });
  it("labels keys", () => {
    expect(keyLabel(C_MAJOR)).toBe("C major");
    expect(keyLabel(A_MINOR)).toBe("A minor");
    expect(keyLabel({ tonic: 10, mode: "major" })).toBe("B♭ major");
    expect(keyLabel({ tonic: 6, mode: "minor" })).toBe("F♯ minor");
  });
  it("pitch class and validation", () => {
    expect(pitchClass(60)).toBe(0);
    expect(pitchClass(-1)).toBe(11);
    expect(isValidKey(C_MAJOR)).toBe(true);
    expect(isValidKey({ tonic: 12, mode: "major" })).toBe(false);
    expect(isValidKey({ tonic: 0, mode: "dorian" })).toBe(false);
    expect(isValidKey(null)).toBe(false);
  });
});

const run = (p: Project, op: object): Project => {
  const r = applyOp(p, { opId: Math.random().toString(36), clientId: "c", ...op } as Op);
  if (!r.ok) throw new Error(r.reason);
  return r.project;
};

describe("setKey op", () => {
  it("sets, changes and clears the key", () => {
    let p = createProject("p");
    expect(p.key).toBeNull();
    p = run(p, { type: "setKey", key: G_MAJOR });
    expect(p.key).toEqual(G_MAJOR);
    p = run(p, { type: "setKey", key: A_MINOR });
    expect(p.key).toEqual(A_MINOR);
    p = run(p, { type: "setKey", key: null });
    expect(p.key).toBeNull();
  });
  it("rejects invalid keys", () => {
    const p = createProject("p");
    for (const key of [{ tonic: 12, mode: "major" }, { tonic: 0, mode: "blues" }, { tonic: 1.5, mode: "major" }]) {
      expect(applyOp(p, { opId: "x", clientId: "c", type: "setKey", key } as unknown as Op).ok).toBe(false);
    }
  });
  it("is undoable and idempotent", () => {
    const p0 = createProject("p");
    const op = { opId: "k1", clientId: "c", type: "setKey", key: C_MAJOR } as Op;
    const r1 = applyOp(p0, op);
    if (!r1.ok) throw new Error(r1.reason);
    const again = applyOp(r1.project, op);
    expect(again.ok && again.applied).toBe(false);
    const inv = invertOp(p0, op, "k2")!;
    const back = applyOp(r1.project, inv);
    if (!back.ok) throw new Error(back.reason);
    expect(projectHash(back.project)).toBe(projectHash(p0));
  });
  it("older projects without a key open with no key", () => {
    const old = createProject("p") as unknown as Record<string, unknown>;
    delete old.key;
    expect(migrateProject(old as unknown as Project).key).toBeNull();
  });
});
