import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "engine", "build", "daw_engine_artefacts", "Release", "daw_engine.exe");
const r = spawnSync(exe, [process.argv[2] ?? "--selftest"], { stdio: "inherit" });
process.exit(r.status ?? 1);
