import { describe, expect, it } from "vitest";
import type { Category, IndexEntry } from "@daw/sounds";
import { categoryCounts, filterSamples } from "./filter";
import { formatDuration, sampleTag } from "./sampleColors";

const e = (name: string, category: Category, pack = "Starter Drums", extra: Partial<IndexEntry> = {}): IndexEntry => ({
  id: name, name, category, sub: category, pack, tags: [], meta: {}, file: `${name}.wav`, durationSec: 1, sampleRate: 48000, channels: 1, peaks: [], origin: "starter", ...extra,
});
const all = [
  e("Punch Kick", "Kick"),
  e("Deep 808 Kick", "Kick", "Starter Drums", { tags: ["808", "trap"] }),
  e("Tight Snare", "Snare"),
  e("Boom Bap 90 Drums", "Loop", "Starter Loops", { meta: { bpm: 90, loop: true } }),
  e("Big Kick 01", "Kick", "Pack"),
];

describe("filterSamples", () => {
  it("returns everything for an empty filter", () => expect(filterSamples(all, { query: "", category: "All", pack: "All" })).toHaveLength(5));
  it("matches every word, in any order, ignoring case", () => {
    expect(filterSamples(all, { query: "kick deep", category: "All", pack: "All" }).map((x) => x.name)).toEqual(["Deep 808 Kick"]);
    expect(filterSamples(all, { query: "KICK", category: "All", pack: "All" })).toHaveLength(3);
  });
  it("searches tags, pack and tempo too", () => {
    expect(filterSamples(all, { query: "trap", category: "All", pack: "All" })).toHaveLength(1);
    expect(filterSamples(all, { query: "loops", category: "All", pack: "All" })).toHaveLength(1);
    expect(filterSamples(all, { query: "90bpm", category: "All", pack: "All" })).toHaveLength(1);
  });
  it("combines category and pack", () => {
    expect(filterSamples(all, { query: "", category: "Kick", pack: "Pack" }).map((x) => x.name)).toEqual(["Big Kick 01"]);
    expect(filterSamples(all, { query: "snare", category: "Kick", pack: "All" })).toHaveLength(0);
  });
  it("counts categories within the other filters", () => {
    expect(categoryCounts(all, { query: "", pack: "All" }).get("Kick")).toBe(3);
    expect(categoryCounts(all, { query: "", pack: "Pack" }).get("Kick")).toBe(1);
    expect(categoryCounts(all, { query: "snare", pack: "All" }).get("Kick")).toBeUndefined();
  });
});

describe("tags and durations", () => {
  it("shows tempo before key", () => {
    expect(sampleTag({ bpm: 120, key: { tonic: 9, mode: "minor" } })).toBe("120 BPM");
    expect(sampleTag({ key: { tonic: 9, mode: "minor" } })).toBe("Am");
    expect(sampleTag({ rootPc: 6 })).toBe("F#");
    expect(sampleTag({})).toBe("");
  });
  it("formats durations", () => {
    expect(formatDuration(0.5)).toBe("0.50s");
    expect(formatDuration(12.34)).toBe("12.3s");
    expect(formatDuration(75)).toBe("1:15");
  });
});
