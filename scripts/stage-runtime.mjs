// Gathers what the packaged app needs that is not built by npm, and stops with a plain message if something is missing.
//   - checks the audio engine has been built (remote recording is part of the app itself and needs nothing built)
//   - copies the Visual C++ runtime DLLs next to the engine (apps/desktop/build-resources/vcruntime), so a PC without the
//     "Visual C++ Redistributable" still starts them. (These DLLs are redistributable app-locally.)
// Usage: node scripts/stage-runtime.mjs   (run by `npm run dist`)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const need = [
  ["the audio engine", "engine/build/daw_engine_artefacts/Release/daw_engine.exe", "npm run engine:configure && npm run engine:build"],
];
let missing = false;
for (const [what, rel, how] of need) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error(`Missing ${what}: ${rel}\n  Build it first: ${how}`);
    missing = true;
  }
}
if (missing) process.exit(1);

// Find the newest Visual C++ runtime folder in Visual Studio / Build Tools.
const vsRoots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean).map((p) => path.join(p, "Microsoft Visual Studio"));
const candidates = [];
for (const vs of vsRoots) {
  for (const year of fs.existsSync(vs) ? fs.readdirSync(vs) : []) {
    for (const edition of ["BuildTools", "Community", "Professional", "Enterprise"]) {
      const redist = path.join(vs, year, edition, "VC", "Redist", "MSVC");
      if (!fs.existsSync(redist)) continue;
      for (const ver of fs.readdirSync(redist)) {
        const crt = path.join(redist, ver, "x64", "Microsoft.VC143.CRT");
        if (fs.existsSync(crt)) candidates.push({ ver, crt });
      }
    }
  }
}
candidates.sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }));
if (!candidates.length) {
  console.error("Could not find the Visual C++ runtime (VC/Redist/MSVC/*/x64/Microsoft.VC143.CRT). Install Visual Studio 2022 Build Tools with the C++ workload.");
  process.exit(1);
}
const wanted = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "msvcp140_atomic_wait.dll", "concrt140.dll"];
const out = path.join(root, "apps/desktop/build-resources/vcruntime");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const { crt, ver } = candidates[0];
for (const f of wanted) {
  const from = path.join(crt, f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, f));
}
console.log(`Staged ${fs.readdirSync(out).length} Visual C++ runtime files (${ver}) in apps/desktop/build-resources/vcruntime`);
