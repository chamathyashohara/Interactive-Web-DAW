// Encodes the Piper WAV recordings to Ogg Opus (24 kbps) with the app's own Chromium (WebCodecs), checks each one
// decodes to the same length, and writes them to the lessons' voice folder. Needs a build (npm run build -w apps/desktop).
// Usage: node encode.mjs <wavDir> [voiceDir]
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const { connect, sleep, killTree, launch, tmpDataDir } = await import(new URL("../../../apps/desktop/e2e/lib.mjs", import.meta.url).href);
const wavDir = process.argv[2];
if (!wavDir) throw new Error("Usage: node encode.mjs <wavDir> [voiceDir]");
const outDir = process.argv[3] ?? fileURLToPath(new URL("../../../apps/desktop/src/renderer/src/features/lessons/voice", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
const app = launch(9482, tmpDataDir("voice-enc-"));
const c = await connect(9482);
await c.evalJs(`(() => {
  const CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; CRC[i] = r >>> 0; }
  const crc = (b) => { let r = 0; for (const x of b) r = ((r << 8) ^ CRC[((r >>> 24) & 0xff) ^ x]) >>> 0; return r; };
  const page = (flags, granule, seq, packets) => {
    const lace = []; for (const p of packets) { let n = p.length; while (n >= 255) { lace.push(255); n -= 255; } lace.push(n); }
    const body = packets.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(27 + lace.length + body); const dv = new DataView(out.buffer);
    out.set([79, 103, 103, 83]); out[5] = flags; dv.setBigUint64(6, BigInt(granule), true); dv.setUint32(14, 0x434f4c4c, true); dv.setUint32(18, seq, true);
    out[26] = lace.length; out.set(lace, 27); let o = 27 + lace.length; for (const p of packets) { out.set(p, o); o += p.length; }
    dv.setUint32(22, crc(out), true); return out;
  };
  const ascii = (s) => new TextEncoder().encode(s);
  window.__encode = async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)); const dv = new DataView(bytes.buffer);
    let o = 12, sr = 22050, data = null;
    while (o + 8 <= bytes.length) { const id = String.fromCharCode(...bytes.slice(o, o + 4)); const len = dv.getUint32(o + 4, true);
      if (id === "fmt ") sr = dv.getUint32(o + 12, true); if (id === "data") data = [o + 8, Math.min(len, bytes.length - o - 8)]; o += 8 + len + (len & 1); }
    const n = data[1] >> 1; const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = dv.getInt16(data[0] + i * 2, true) / 32768;
    const ctx = new OfflineAudioContext(1, Math.ceil((n * 48000) / sr), 48000);
    const buf = ctx.createBuffer(1, n, sr); buf.copyToChannel(f, 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    const pcm = (await ctx.startRendering()).getChannelData(0);
    const packets = []; let head = null;
    const enc = new AudioEncoder({ output: (chunk, meta) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); packets.push({ d, samples: Math.round((chunk.duration * 48000) / 1e6) }); if (meta?.decoderConfig?.description) head = new Uint8Array(meta.decoderConfig.description); }, error: (e) => { throw e; } });
    enc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 });
    enc.encode(new AudioData({ format: "f32", sampleRate: 48000, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: 0, data: pcm }));
    await enc.flush(); enc.close();
    let preskip = 312;
    if (!head || String.fromCharCode(...head.slice(0, 8)) !== "OpusHead") { head = new Uint8Array(19); head.set(ascii("OpusHead")); head[8] = 1; head[9] = 1; new DataView(head.buffer).setUint16(10, preskip, true); new DataView(head.buffer).setUint32(12, 48000, true); }
    else preskip = new DataView(head.buffer).getUint16(10, true);
    const vendor = ascii("CollabDAW lessons"); const tags = new Uint8Array(8 + 4 + vendor.length + 4); tags.set(ascii("OpusTags")); new DataView(tags.buffer).setUint32(8, vendor.length, true); tags.set(vendor, 12);
    const pages = [page(2, 0, 0, [head]), page(0, 0, 1, [tags])];
    let seq = 2, gran = preskip, i = 0;
    while (i < packets.length) { const group = packets.slice(i, i + 50); i += group.length; gran += group.reduce((a, p) => a + p.samples, 0);
      const last = i >= packets.length; pages.push(page(last ? 4 : 0, last ? preskip + pcm.length : gran, seq++, group.map((p) => p.d))); }
    const ogg = new Uint8Array(pages.reduce((a, p) => a + p.length, 0)); let w = 0; for (const p of pages) { ogg.set(p, w); w += p.length; }
    const check = await new AudioContext().decodeAudioData(ogg.buffer.slice(0));
    let s = ""; for (let k = 0; k < ogg.length; k += 0x8000) s += String.fromCharCode(...ogg.subarray(k, k + 0x8000));
    return { b64: btoa(s), seconds: n / sr, decoded: check.duration };
  };
  return true;
})()`);
const files = fs.readdirSync(wavDir).filter((f) => f.endsWith(".wav"));
let bad = 0, inBytes = 0, outBytes = 0, secs = 0;
for (const [i, f] of files.entries()) {
  const wav = fs.readFileSync(path.join(wavDir, f)); inBytes += wav.length;
  const r = await c.evalJs(`window.__encode(${JSON.stringify(wav.toString("base64"))})`);
  const ogg = Buffer.from(r.b64, "base64"); outBytes += ogg.length; secs += r.seconds;
  if (Math.abs(r.decoded - r.seconds) > 0.1) { bad++; console.log("LENGTH MISMATCH", f, r.seconds, r.decoded); }
  fs.writeFileSync(path.join(outDir, f.replace(/\.wav$/, ".ogg")), ogg);
  if (i % 100 === 0) console.log(i, "/", files.length);
}
console.log(`ENCODED ${files.length} files, ${(secs / 60).toFixed(1)} min, wav ${(inBytes / 1e6).toFixed(1)} MB -> ogg ${(outBytes / 1e6).toFixed(1)} MB, mismatches ${bad}`);
c.send("Browser.close"); await sleep(1000); killTree(app); process.exit(bad ? 1 : 0);
