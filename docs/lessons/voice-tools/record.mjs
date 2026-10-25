// Records the prepared lines (from prep.mjs) with Piper in small batches, skipping lines already recorded and
// retrying a failed batch one line at a time. Usage: node record.mjs <piper.exe> <model.onnx> <input.jsonl>
import fs from "node:fs"; import { spawnSync } from "node:child_process";
const [piper, model, input] = process.argv.slice(2);
const all = fs.readFileSync(input, "utf8").trim().split("\n");
const todo = () => all.filter((l) => { const f = JSON.parse(l).output_file; return !fs.existsSync(f) || fs.statSync(f).size < 1000; });
const run = (lines) => spawnSync(piper, ["--model", model, "--sentence_silence", "0.3", "--json-input"], { input: lines.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 26, timeout: 15 * 60 * 1000 });
let left = todo();
console.log("to record:", left.length);
for (let i = 0; i < left.length; i += 20) {
  const batch = left.slice(i, i + 20);
  const r = run(batch);
  const failed = batch.filter((l) => { const f = JSON.parse(l).output_file; return !fs.existsSync(f) || fs.statSync(f).size < 1000; });
  for (const l of failed) {
    const r2 = run([l]);
    const f = JSON.parse(l).output_file;
    if (!fs.existsSync(f) || fs.statSync(f).size < 1000) console.log("FAILED", f, r2.status, (r2.stderr ?? "").slice(-300));
  }
  console.log(`${Math.min(i + 20, left.length)} / ${left.length}`, r.status);
}
console.log("DONE, still missing:", todo().length);
