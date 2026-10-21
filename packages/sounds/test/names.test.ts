import { describe, expect, it } from "vitest";
import { categorize, cleanName, detectBrandWord, parseBpm, parseKeyTag, trackNameFor } from "../src";

describe("detectBrandWord", () => {
  const kshmr = ["KSHMR Big Kick 01", "KSHMR Tight Snare 02", "KSHMR Open Hat", "KSHMR Clap 03", "KSHMR Crash", "KSHMR Ride", "KSHMR Tom 1", "KSHMR Perc 2", "Other Thing"];
  it("finds a brand that starts most names", () => expect(detectBrandWord(kshmr)).toBe("KSHMR"));
  it("is case-insensitive and keeps the original spelling", () => expect(detectBrandWord(kshmr.map((n) => n.replace("KSHMR", "kshmr")))).toBe("kshmr"));
  it("ignores ordinary drum words, numbers and small packs", () => {
    expect(detectBrandWord(Array.from({ length: 10 }, (_, i) => `Kick ${i}`))).toBeNull();
    expect(detectBrandWord(Array.from({ length: 10 }, (_, i) => `808 ${i}`))).toBeNull();
    expect(detectBrandWord(kshmr.slice(0, 5))).toBeNull();
  });
  it("needs at least 60% of the names", () => {
    const mixed = [...kshmr.slice(0, 4), "A One", "B Two", "C Three", "D Four", "E Five", "F Six"];
    expect(detectBrandWord(mixed)).toBeNull();
  });
});

describe("cleanName and trackNameFor", () => {
  it("removes the brand as a whole word", () => {
    expect(cleanName("KSHMR Big Kick 01 (A)", "KSHMR")).toBe("Big Kick 01 (A)");
    expect(cleanName("KSHMR_Snare_Tight", "KSHMR")).toBe("Snare Tight");
    expect(cleanName("Big Kick - KSHMR - 02", "kshmr")).toBe("Big Kick - 02");
  });
  it("never leaves an empty name", () => expect(cleanName("KSHMR", "KSHMR")).toBe("KSHMR"));
  it("does not cut brand text out of the middle of another word", () => expect(cleanName("Pre KSHMRs Kick", "KSHMR")).toBe("Pre KSHMRs Kick"));
  it("drops a trailing key tag for the track name", () => {
    expect(trackNameFor("Big Kick 01 (A)")).toBe("Big Kick 01");
    expect(trackNameFor("Pad (F#m)")).toBe("Pad");
    expect(trackNameFor("Loop (120 bpm)")).toBe("Loop");
    expect(trackNameFor("Kick (Heavy)")).toBe("Kick (Heavy)");
  });
});

describe("tags", () => {
  it("reads key tags", () => {
    expect(parseKeyTag("Bass (F#)")).toEqual({ pitchClass: 6, minor: null });
    expect(parseKeyTag("Pad (Am)")).toEqual({ pitchClass: 9, minor: true });
    expect(parseKeyTag("Pad (Bb)")).toEqual({ pitchClass: 10, minor: null });
    expect(parseKeyTag("Pad")).toBeNull();
  });
  it("reads tempo tags in a sane range only", () => {
    expect(parseBpm("Drums 128 bpm")).toBe(128);
    expect(parseBpm("Drums 128bpm")).toBe(128);
    expect(parseBpm("Drums 900 bpm")).toBeNull();
    expect(parseBpm("Drums")).toBeNull();
  });
});

describe("categorize", () => {
  const cat = (folders: string[], name: string) => categorize(folders, name).category;
  it("uses the folder and the name", () => {
    expect(cat(["Drums", "Kicks"], "Big 01")).toBe("Kick");
    expect(cat([], "Tight Snare 3")).toBe("Snare");
    expect(cat(["Hats"], "Open Hat 2")).toBe("Hat");
    expect(categorize(["Hats"], "Open Hat 2").sub).toBe("Open Hat");
    expect(cat([], "Crash Long")).toBe("Cymbal");
    expect(cat([], "Riser 8 bars")).toBe("FX");
    expect(cat(["Loops"], "Kick Loop 128")).toBe("Loop");
    expect(cat([], "Sub 808 C")).toBe("Bass");
    expect(cat([], "Mystery")).toBe("Other");
  });
});
