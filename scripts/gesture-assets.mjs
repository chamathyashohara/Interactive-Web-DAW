// Puts the files the hand tracking (gesture playing) needs into apps/desktop/resources/mediapipe:
//   wasm/   the WebAssembly runtime, copied from the installed @mediapipe/tasks-vision package
//   hand_landmarker.task   Google's hand landmark model, downloaded once from Google's public model storage
// Run it once after `npm install`:   npm run gesture:assets
// The files are not committed (see .gitignore); the installer build runs this first. After this, nothing is fetched at run time.
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps/desktop/resources/mediapipe");
const wasmFrom = path.join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
// The SHA-256 of the model as downloaded when this was set up. A different file is refused, so the app never ships a changed model unnoticed.
// (This is the hash of the file as first downloaded and checked here; it is not an official digest from Google.)
const MODEL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";

if (!fs.existsSync(wasmFrom)) {
  console.error("@mediapipe/tasks-vision is not installed. Run `npm install` first.");
  process.exit(1);
}
fs.mkdirSync(path.join(outDir, "wasm"), { recursive: true });
for (const f of fs.readdirSync(wasmFrom)) {
  if (!/\.(wasm|js)$/.test(f)) continue;
  fs.copyFileSync(path.join(wasmFrom, f), path.join(outDir, "wasm", f));
  console.log("copied", f);
}

const model = path.join(outDir, "hand_landmarker.task");
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const download = (url, to) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(download(res.headers.location, to));
        if (res.statusCode !== 200) return reject(new Error(`download failed: HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(to);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      })
      .on("error", reject);
  });

if (!fs.existsSync(model)) {
  console.log("downloading the hand landmark model (about 8 MB) from Google's public model storage...");
  const tmp = model + ".part";
  await download(MODEL_URL, tmp);
  fs.renameSync(tmp, model);
}
const hash = sha(model);
console.log(`hand_landmarker.task  ${fs.statSync(model).size} bytes  sha256 ${hash}`);
if (MODEL_SHA256 && hash !== MODEL_SHA256) {
  fs.rmSync(model);
  console.error("The model's checksum does not match the pinned one, so it was removed. Do not use it.");
  process.exit(1);
}
if (!MODEL_SHA256) console.log("(no checksum is pinned yet: put the sha256 above into MODEL_SHA256 in scripts/gesture-assets.mjs)");
