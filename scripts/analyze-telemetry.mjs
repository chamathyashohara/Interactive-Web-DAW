// Combines the study exports of several participants into one table (and a short summary) for the evaluation chapter.
// Usage: node scripts/analyze-telemetry.mjs study-P01.json study-P02.json ...   > results.csv
// Input: the "Export JSON" files from Features -> Study data. Output: one CSV row per participant, then summary rows.
import fs from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Give one or more exported study files (JSON).");
  process.exit(1);
}

const cols = [
  ["participant", (b) => b.participant],
  ["sessions", (b) => b.metrics.sessions],
  ["active_minutes", (b) => b.metrics.activeMinutes],
  ["edits_per_active_minute", (b) => b.metrics.editsPerActiveMinute],
  ["notes_added", (b) => b.metrics.notesAdded],
  ["keyed_notes", (b) => b.metrics.keyedNotes],
  ["out_of_key_rate", (b) => b.metrics.outOfKeyRate],
  ["out_of_key_rate_first_third", (b) => b.metrics.outOfKeyRateFirstThird],
  ["out_of_key_rate_last_third", (b) => b.metrics.outOfKeyRateLastThird],
  ["corrected_share", (b) => b.metrics.correctedShare],
  ["median_correction_seconds", (b) => (b.metrics.medianCorrectionMs === null ? null : b.metrics.medianCorrectionMs / 1000)],
  ["undos", (b) => b.metrics.undos],
  ["locked_attempts", (b) => b.metrics.lockedAttempts],
  ["lessons_completed", (b) => b.metrics.lessonsCompleted.length],
  ["beginner_out_of_key_rate", (b) => b.metrics.byMode?.beginner?.outOfKeyRate ?? null],
  ["all_out_of_key_rate", (b) => b.metrics.byMode?.all?.outOfKeyRate ?? null],
  ["beginner_median_correction_seconds", (b) => (b.metrics.byMode?.beginner?.medianCorrectionMs ?? null) === null ? null : b.metrics.byMode.beginner.medianCorrectionMs / 1000],
  ["all_median_correction_seconds", (b) => (b.metrics.byMode?.all?.medianCorrectionMs ?? null) === null ? null : b.metrics.byMode.all.medianCorrectionMs / 1000],
];

const bundles = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const fmt = (v) => (v === null || v === undefined ? "" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v));
const rows = bundles.map((b) => cols.map(([, get]) => get(b)));
const out = [cols.map(([name]) => name).join(","), ...rows.map((r) => r.map(fmt).join(","))];

const col = (name) => rows.map((r) => r[cols.findIndex(([n]) => n === name)]).filter((v) => typeof v === "number");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
out.push("");
out.push(["mean", ...cols.slice(1).map(([n]) => fmt(mean(col(n))))].join(","));
out.push(["median", ...cols.slice(1).map(([n]) => fmt(median(col(n))))].join(","));

// Do mistakes fall with practice? Paired by participant: last third minus first third of their keyed notes.
const paired = bundles.map((b) => [b.metrics.outOfKeyRateFirstThird, b.metrics.outOfKeyRateLastThird]).filter(([a, c]) => a !== null && c !== null);
out.push("");
out.push("practice_effect,participants_with_enough_notes,mean_change_in_out_of_key_rate,participants_who_improved");
out.push(["", paired.length, fmt(mean(paired.map(([a, c]) => c - a))), paired.filter(([a, c]) => c < a).length].join(","));

// Unlock-to-first-use delay for each gated feature, over all participants.
const delays = {};
for (const b of bundles) for (const a of b.metrics.adoption) (delays[a.feature] ??= []).push(a.latencyMs === null ? null : a.latencyMs / 1000);
out.push("");
out.push("feature,participants_unlocked,participants_used,median_seconds_to_first_use");
for (const [f, xs] of Object.entries(delays).sort()) {
  const used = xs.filter((x) => x !== null);
  out.push([f, xs.length, used.length, fmt(median(used))].join(","));
}
console.log(out.join("\n"));
