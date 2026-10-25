import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { voiceKey, normalizeLine } from "./voiceKey";
import { studioSpeech, voiceLines } from "./voiceLines";
import { STUDIO_LESSONS } from "./studio/courses";

const VOICE_DIR = join(__dirname, "voice");

describe("voice guidance recordings", () => {
  const lines = voiceLines();
  // `VOICE_LINES_OUT=<file> npx vitest run voiceLines` writes the lines to record (docs/lessons/VOICE.md).
  if (process.env.VOICE_LINES_OUT) writeFileSync(process.env.VOICE_LINES_OUT, JSON.stringify(lines.map((text) => ({ key: voiceKey(text), text })), null, 1));

  it("keys are stable and ignore spacing", () => {
    expect(voiceKey("Well done.")).toBe(voiceKey("  Well   done. "));
    expect(voiceKey("Well done.")).not.toBe(voiceKey("Well done!"));
    expect(voiceKey("Well done.")).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(lines.map(voiceKey)).size).toBe(lines.length);
  });

  it("covers every stage of a workspace lesson", () => {
    const lesson = Object.values(STUDIO_LESSONS)[0]!;
    for (const stage of ["hook", "try", "practice", "quick", "done"] as const) expect(lines).toContain(normalizeLine(studioSpeech(lesson, stage)));
  });

  it("every line has a natural-voice recording, and no recording is left over", () => {
    const have = new Set(existsSync(VOICE_DIR) ? readdirSync(VOICE_DIR).filter((f) => f.endsWith(".ogg")).map((f) => f.slice(0, -4)) : []);
    const missing = lines.filter((t) => !have.has(voiceKey(t)));
    const wanted = new Set(lines.map(voiceKey));
    const extra = [...have].filter((k) => !wanted.has(k));
    expect(missing.map((t) => t.slice(0, 80)), "lines without a recording: record them (docs/lessons/VOICE.md)").toEqual([]);
    expect(extra, "recordings no line uses any more: delete them").toEqual([]);
  });
});
