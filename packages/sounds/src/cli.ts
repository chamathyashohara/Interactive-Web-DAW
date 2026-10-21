// Generates the Starter sound library into a folder so you can listen to it in any audio player.
// Usage: npm run generate -w packages/sounds -- <output folder>      (default: ./starter-library)
import path from "node:path";
import { writeStarterLibrary } from "./writeLibrary.ts";
import { CATEGORIES } from "./library.ts";

const out = path.resolve(process.argv[2] ?? "starter-library");
const t0 = Date.now();
const index = writeStarterLibrary(out);
const bytes = index.entries.reduce((s, e) => s + e.durationSec * e.sampleRate * e.channels * 2, 0);
console.log(`Wrote ${index.entries.length} sounds (${(bytes / 1e6).toFixed(1)} MB) to ${out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const c of CATEGORIES) {
  const n = index.entries.filter((e) => e.category === c).length;
  if (n) console.log(`  ${c.padEnd(11)} ${n}`);
}
