// Turns the lesson lines into Piper's JSON input: one recording per line, with symbols spelled out for the voice (the
// text on screen does not change). `--missing <voiceDir>` prepares only lines that have no recording yet.
// Usage: node prep.mjs <lines.json> <wavDir> <out.jsonl> [--missing <voiceDir>]
import fs from "node:fs";
import path from "node:path";

const ROMAN = { i: "one", ii: "two", iii: "three", iv: "four", v: "five", vi: "six", vii: "seven" };
const R = "(?:VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii)";
const romanSeq = new RegExp(String.raw`\b${R}(?:\s*[–-]\s*${R}\b)+`, "g");
const romanChord = new RegExp(String.raw`\b(the|The|a|A) (${R}) chord`, "g");

/** The line as the voice should say it: chord numerals, note names, symbols and units spelled out. */
export function spoken(t) {
  return t
    .replace(romanSeq, (m) => m.split(/\s*[–-]\s*/).map((r) => ROMAN[r.toLowerCase()]).join(", "))
    .replace(romanChord, (_, a, r) => `${a} ${ROMAN[r.toLowerCase()]} chord`)
    .replace(/^vi, in small letters/, "six, in small letters")
    .replace(/Ctrl\+([A-Z])/g, "Control $1")
    .replace(/\b([A-G])#(\d?)/g, (_, n, o) => `${n} sharp${o ? " " + o : ""}`)
    .replace(/\b([A-G])♭(\d?)/g, (_, n, o) => `${n} flat${o ? " " + o : ""}`)
    .replace(/♭/g, " flat").replace(/♯/g, " sharp").replace(/#/g, " sharp")
    .replace(/→|->/g, " then ").replace(/←/g, " back to ").replace(/[↑]/g, " up").replace(/[↓]/g, " down")
    .replace(/[★✓·∿▶■…]/g, " ")
    .replace(/(^|[\s(])-(\d)/g, "$1minus $2")
    .replace(/(\d)\s*[-–]\s*(\d)/g, "$1 to $2")
    .replace(/\s+[–—]\s+/g, ", ")
    .replace(/\b1\/16\b/g, "one sixteenth").replace(/\b1\/8\b/g, "one eighth").replace(/\b1\/4\b/g, "one quarter").replace(/\b1\/2\b/g, "one half")
    .replace(/\+(\d)/g, "plus $1")
    .replace(/(\d)\s*kHz\b/g, "$1 kilohertz").replace(/(\d)\s*Hz\b/g, "$1 hertz").replace(/(\d)\s*dB\b/g, "$1 decibels").replace(/\bdB\b/g, "decibels")
    .replace(/\bBPM\b/g, "B P M").replace(/\bWAV\b/g, "wave").replace(/\bDAW\b/g, "D A W").replace(/\bMIDI\b/g, "midi")
    .replace(/\bL(\d)\b/g, "L $1").replace(/\bK(\d)\b/g, "K $1").replace(/\bS(\d)\b/g, "S $1")
    .replace(/\s+/g, " ")
    .trim();
}

const [linesFile, wavDir, outFile, flag, voiceDir] = process.argv.slice(2);
if (linesFile && wavDir && outFile) {
  const lines = JSON.parse(fs.readFileSync(linesFile, "utf8"));
  const have = flag === "--missing" ? new Set(fs.readdirSync(voiceDir).map((f) => f.replace(/\.ogg$/, ""))) : new Set();
  fs.mkdirSync(wavDir, { recursive: true });
  const out = lines.filter((l) => !have.has(l.key)).map((l) => JSON.stringify({ text: spoken(l.text), output_file: path.resolve(wavDir, `${l.key}.wav`) }));
  fs.writeFileSync(outFile, out.length ? out.join("\n") + "\n" : "");
  console.log(out.length, "lines prepared");
}
