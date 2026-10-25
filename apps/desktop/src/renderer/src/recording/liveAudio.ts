import { ArrivalStats, JitterBuffer } from "@daw/recording";
import workletUrl from "./recordingWorklets.js?url";
import { clickBuffer, findOnset, loadLatencySetting, robustLatencyFrames, saveLatencySetting, type LatencySetting } from "./latency";

/**
 * The window's half of remote recording: it opens the microphone, cuts it into 10 ms blocks, and
 *  - streams every block to the main process, which writes the master WAV and decides when a take starts and stops;
 *  - when "talkback" is on, encodes the blocks to Opus (WebCodecs) and hands the packets to the main process to send;
 *  - plays the other person's Opus packets (jitter buffer -> decoder -> playback worklet).
 * It makes no timing decisions: the master recording is exact because the main process counts samples, not because of anything done here.
 */

const RATE = 48000;
const BLOCK = 480;

export interface MicState {
  open: boolean;
  starting: boolean;
  deviceName: string;
  error: string;
  /** 0..1 level of the microphone, for the meter */
  level: number;
  /** 0..1 level of what is being played */
  outLevel: number;
  /** frames of the other person's voice handed to the speakers so far */
  played: number;
  /** vocal over a backing track: the backing track held in memory (id), and whether it is playing now */
  backingId: string;
  backingPlaying: boolean;
  backingVolume: number;
  /** speaker-to-microphone round trip used for takes, microseconds, and where the number comes from */
  latencyUs: number;
  latencySource: "auto" | "measured" | "manual";
  calibrating: boolean;
  calibNote: string;
  talkSupported: boolean;
}

export interface DeviceList {
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
}

type Listener = () => void;

export class LiveAudio {
  private state: MicState = { open: false, starting: false, deviceName: "", error: "", level: 0, outLevel: 0, played: 0, backingId: "", backingPlaying: false, backingVolume: 0.8, latencyUs: 0, latencySource: "auto", calibrating: false, calibNote: "", talkSupported: typeof AudioEncoder !== "undefined" && typeof AudioDecoder !== "undefined" };
  private listeners = new Set<Listener>();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private playback: AudioWorkletNode | null = null;
  private outGain: GainNode | null = null;
  private encoder: AudioEncoder | null = null;
  private decoder: AudioDecoder | null = null;
  private send = false;
  private hear = false;
  private muted = false;
  private levelUntilMs = 0;

  // playout
  private jb = new JitterBuffer(3);
  private arrival = new ArrivalStats();
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private posted = 0;
  private consumed = 0;
  private pendingDecodes = 0;
  private lastPcm: Float32Array | null = null;
  private concealRun = 0;
  private concealed = 0;
  private decodeErrors = 0;
  private offAudio: (() => void) | null = null;
  private offEnd: (() => void) | null = null;

  // backing track (vocal over the producer's song)
  private backing: AudioBuffer | null = null;
  private backingGain: GainNode | null = null;
  private backingSrc: AudioBufferSourceNode | null = null;
  private latency: LatencySetting = loadLatencySetting();
  private micTrack: MediaStreamTrack | null = null;
  private calib: { starts: number[]; floors: number[]; measures: (number | null)[]; done: (r: { ok: boolean; us: number; detail: string }) => void; endFrame: number } | null = null;
  /** TEST ONLY (end-to-end tests): the "microphone" is the backing track's own output, so a take must contain the backing track exactly. */
  testLoopMic = false;

  constructor() {
    if (typeof window !== "undefined" && window.daw?.live) {
      window.daw.live.onBackingFile((f) => void this.loadBacking(f));
      window.daw.live.onPlayBacking((p) => this.playBacking(p.startFrame, p.offsetSec));
      window.daw.live.onStopBacking(() => this.stopBackingPlayback());
    }
  }

  get micState(): MicState { return this.state; }
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): MicState => this.state;
  private set(p: Partial<MicState>): void {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  async devices(): Promise<DeviceList> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const pick = (kind: MediaDeviceKind) => all.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === "audioinput" ? "Microphone" : "Speakers"} ${i + 1}` }));
      return { inputs: pick("audioinput"), outputs: pick("audiooutput") };
    } catch {
      return { inputs: [], outputs: [] };
    }
  }

  /** Opens the microphone. Returns "" or a plain-English reason. */
  async startMic(deviceId?: string): Promise<string> {
    if (this.state.open || this.state.starting) await this.stopMic();
    this.set({ starting: true, error: "" });
    try {
      const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
      await ctx.audioWorklet.addModule(workletUrl);
      if (ctx.state !== "running") await ctx.resume();
      let stream: MediaStream | null = null;
      if (!this.testLoopMic) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
      }
      const track = stream?.getAudioTracks()[0] ?? null;
      this.micTrack = track;
      const backingGain = ctx.createGain(); // the backing track is a separate path from the microphone: it never enters the recording
      backingGain.gain.value = this.state.backingVolume;
      backingGain.connect(ctx.destination);
      this.backingGain = backingGain;
      const src = stream ? ctx.createMediaStreamSource(stream) : null;
      const capture = new AudioWorkletNode(ctx, "rr-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const silent = ctx.createGain();
      silent.gain.value = 0;
      src?.connect(capture);
      if (this.testLoopMic) backingGain.connect(capture); // TEST ONLY: the "microphone" hears the backing track with no delay at all
      capture.connect(silent).connect(ctx.destination); // an unconnected worklet is not pulled by the browser
      const playback = new AudioWorkletNode(ctx, "rr-playback", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      const outGain = ctx.createGain();
      outGain.gain.value = 0.25; // -12 dB, like the C++ recorder's default
      playback.connect(outGain).connect(ctx.destination);
      this.stream = stream;
      this.ctx = ctx;
      this.capture = capture;
      this.playback = playback;
      this.outGain = outGain;
      capture.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => this.onBlock(e.data.frame, e.data.samples);
      playback.port.onmessage = (e: MessageEvent<{ consumed: number; level: number; peak: number }>) => {
        this.consumed = e.data.consumed;
        this.outLevelValue = Math.max(e.data.peak, this.outLevelValue * 0.85);
      };
      if (track) {
        track.onended = () => {
          void this.stopMic("The microphone was disconnected.");
        };
      }
      this.rateOk = Math.round(ctx.sampleRate) === RATE;
      this.set({ open: true, starting: false, deviceName: this.testLoopMic ? "test loopback" : track?.label || "microphone", talkSupported: this.state.talkSupported && this.rateOk });
      this.applyLatency();
      window.daw.live.captureState({ open: true, deviceName: this.testLoopMic ? "test loopback" : track?.label || "microphone", sampleRate: Math.round(ctx.sampleRate), channels: 1 });
      this.posted = 0;
      this.consumed = 0;
      this.startPlayout();
      this.applyEncoder();
      return "";
    } catch (e) {
      const err = e as DOMException;
      const why = err?.name === "NotAllowedError" ? "The microphone is blocked. Allow microphone access for this app in Windows settings (Privacy > Microphone)." : err?.name === "NotFoundError" ? "No microphone was found." : `The microphone could not be opened: ${err?.message ?? String(e)}`;
      this.set({ starting: false, open: false, error: why });
      window.daw.live.captureState({ open: false, failed: why });
      await this.teardown();
      return why;
    }
  }

  private rateOk = true;
  private outLevelValue = 0;

  async stopMic(reason = ""): Promise<void> {
    const wasOpen = this.state.open;
    await this.teardown();
    this.set({ open: false, starting: false, error: reason, level: 0, outLevel: 0 });
    if (wasOpen) window.daw.live.captureState({ open: false, failed: reason });
  }

  private async teardown(): Promise<void> {
    this.stopPlayout();
    try { this.encoder?.close(); } catch { /* already closed */ }
    try { this.decoder?.close(); } catch { /* already closed */ }
    this.encoder = this.decoder = null;
    if (this.capture) this.capture.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    try { await this.ctx?.close(); } catch { /* already closed */ }
    this.stopBackingPlayback();
    this.ctx = this.capture = this.playback = this.outGain = this.backingGain = null;
    this.micTrack = null;
    this.stream = null;
  }

  // ---- backing track ----

  /** Decodes the downloaded backing track (independent of the microphone) and tells the main process it can be played. */
  private async loadBacking(f: { id: string; path: string }): Promise<void> {
    try {
      const bytes = await window.daw.live.readBacking(f.path);
      if (!bytes) throw new Error("the downloaded file cannot be read");
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const decoder = new OfflineAudioContext(2, 1, RATE); // decoding needs no sound card
      const buf = await decoder.decodeAudioData(copy);
      if (buf.numberOfChannels < 1 || buf.length < RATE / 10) throw new Error("the backing track is empty");
      this.backing = buf;
      this.set({ backingId: f.id });
      await window.daw.live.backingReady(f.id);
    } catch (e) {
      this.backing = null;
      this.set({ backingId: "" });
      await window.daw.live.backingFailed(f.id, (e as Error).message);
    }
  }

  /**
   * Starts the backing track on audio-context frame `startFrame` (the frame the take starts recording on), `offsetSec` into the song.
   * If that frame has already passed, the music starts at once but skips ahead by exactly the time lost, so it stays where it belongs.
   */
  private playBacking(startFrame: number, offsetSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.backing || !this.backingGain) return;
    this.stopBackingPlayback();
    const src = ctx.createBufferSource();
    src.buffer = this.backing;
    src.connect(this.backingGain);
    const at = startFrame / ctx.sampleRate;
    const now = ctx.currentTime;
    let offset = offsetSec;
    if (at > now + 0.001) {
      src.start(at, offset);
    } else {
      offset += now - at;
      if (offset >= this.backing.duration) return;
      src.start(0, offset);
    }
    src.onended = () => {
      if (this.backingSrc === src) {
        this.backingSrc = null;
        this.set({ backingPlaying: false });
      }
    };
    this.backingSrc = src;
    this.set({ backingPlaying: true });
  }

  private stopBackingPlayback(): void {
    const s = this.backingSrc;
    this.backingSrc = null;
    if (s) {
      s.onended = null;
      try { s.stop(); } catch { /* it had not started */ }
      try { s.disconnect(); } catch { /* already disconnected */ }
    }
    if (this.state.backingPlaying) this.set({ backingPlaying: false });
  }

  setBackingVolume(v: number): void {
    const vol = Math.min(1, Math.max(0, v));
    this.set({ backingVolume: vol });
    if (this.backingGain) this.backingGain.gain.value = vol;
  }

  // ---- latency ----

  /** What the browser reports for the sound card's output and input delay: an estimate that is often optimistic. */
  private estimateLatencyUs(): number {
    if (this.testLoopMic) return 0;
    const ctx = this.ctx;
    if (!ctx) return 0;
    const out = ctx.outputLatency || ctx.baseLatency || 0;
    const inn = Number((this.micTrack?.getSettings() as { latency?: number } | undefined)?.latency ?? 0);
    return Math.round((out + inn) * 1e6);
  }

  private applyLatency(): void {
    const us = this.testLoopMic ? 0 : this.latency.source === "auto" ? this.estimateLatencyUs() : this.latency.us;
    this.set({ latencyUs: us, latencySource: this.latency.source });
    window.daw.live.setLatency(us);
  }

  /** The user typed a value (milliseconds), or asked to go back to the automatic estimate. */
  setLatencyMs(ms: number | null): void {
    this.latency = ms === null ? { source: "auto", us: 0 } : { source: "manual", us: Math.round(Math.min(2000, Math.max(0, ms)) * 1000) };
    saveLatencySetting(this.latency);
    this.applyLatency();
  }

  /**
   * Measures the round trip: plays five clicks through the speakers and times when the microphone hears them. Needs the speakers to be audible to
   * the microphone (not headphones). Resolves with the result; the value is used for the next takes.
   */
  calibrate(): Promise<{ ok: boolean; us: number; detail: string }> {
    const ctx = this.ctx;
    if (!ctx || !this.state.open) return Promise.resolve({ ok: false, us: 0, detail: "Turn the microphone on first." });
    if (this.calib) return Promise.resolve({ ok: false, us: 0, detail: "A measurement is already running." });
    this.set({ calibrating: true, calibNote: "Listening… keep the room quiet and the microphone near the speakers." });
    const click = clickBuffer(ctx);
    const first = Math.ceil((ctx.currentTime + 0.6) * ctx.sampleRate);
    const starts = [0, 1, 2, 3, 4].map((k) => first + Math.round(k * 0.7 * ctx.sampleRate));
    for (const s of starts) {
      const src = ctx.createBufferSource();
      src.buffer = click;
      src.connect(ctx.destination);
      src.start(s / ctx.sampleRate);
    }
    return new Promise((resolve) => {
      this.calib = {
        starts, floors: starts.map(() => 0), measures: starts.map(() => null), endFrame: starts[starts.length - 1]! + Math.round(0.5 * ctx.sampleRate),
        done: (r) => {
          this.calib = null;
          this.set({ calibrating: false, calibNote: r.detail });
          if (r.ok) {
            this.latency = { source: "measured", us: r.us };
            saveLatencySetting(this.latency);
            this.applyLatency();
          }
          resolve(r);
        },
      };
    });
  }

  private calibBlock(frame: number, samples: Float32Array): void {
    const c = this.calib!;
    const rate = this.ctx?.sampleRate ?? RATE;
    c.starts.forEach((s, k) => {
      if (c.measures[k] !== null) return;
      // background level: the 150 ms before the click
      if (frame + samples.length > s - 0.15 * rate && frame < s) {
        let peak = 0;
        for (let i = 0; i < samples.length && frame + i < s; i++) peak = Math.max(peak, Math.abs(samples[i]!));
        c.floors[k] = Math.max(c.floors[k]!, peak);
      }
      if (frame + samples.length > s && frame < s + 0.35 * rate) {
        const from = Math.max(0, s - frame);
        const idx = findOnset(samples.subarray(from), c.floors[k]!);
        if (idx >= 0) c.measures[k] = frame + from + idx - s;
      }
    });
    if (frame > c.endFrame) {
      const got = c.measures.filter((m): m is number => m !== null);
      const frames = robustLatencyFrames(got, rate);
      if (frames === null) {
        c.done({ ok: false, us: 0, detail: got.length < 3 ? "The clicks were not heard. Use speakers (not headphones), turn them up a little and put the microphone close to them." : "The measurements did not agree. Try again in a quieter room." });
      } else {
        const us = Math.round((frames / rate) * 1e6);
        c.done({ ok: true, us, detail: `Measured ${(us / 1000).toFixed(1)} ms (from ${got.length} clicks).` });
      }
    }
  }

  // ---- talkback ----

  setTalkback(send: boolean, hear: boolean): void {
    this.send = send;
    this.hear = hear;
    void window.daw.live.setTalkback(send, hear);
    this.applyEncoder();
    if (!hear) {
      this.playback?.port.postMessage({ flush: true });
      this.posted = this.consumed;
    }
  }
  setMuted(m: boolean): void { this.muted = m; }
  setVolume(linear: number): void { if (this.outGain) this.outGain.gain.value = linear; }
  async setOutput(deviceId: string): Promise<void> {
    const c = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    try { await c?.setSinkId?.(deviceId); } catch { /* keep the current output */ }
  }

  private applyEncoder(): void {
    if (!this.state.open || !this.state.talkSupported) return;
    if (this.send && !this.encoder) {
      try {
        const enc = new AudioEncoder({
          output: (chunk) => {
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            const mediaIndex = Math.round((chunk.timestamp * RATE) / 1e6);
            window.daw.live.sendAudio(buf, mediaIndex, this.muted);
          },
          error: (e) => {
            this.set({ error: `Talkback encoder stopped: ${e.message}` });
            this.encoder = null;
          },
        });
        enc.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1, bitrate: 64000, bitrateMode: "constant", opus: { frameDuration: 10000, application: "lowdelay", complexity: 5, format: "opus", signal: "voice" } } as AudioEncoderConfig);
        this.encoder = enc;
      } catch (e) {
        this.set({ error: `Talkback is not available on this PC: ${(e as Error).message}` });
      }
    } else if (!this.send && this.encoder) {
      try { this.encoder.close(); } catch { /* already closed */ }
      this.encoder = null;
    }
  }

  // ---- microphone blocks ----

  private onBlock(frame: number, samples: Float32Array): void {
    window.daw.live.capture(frame, samples);
    if (this.calib) this.calibBlock(frame, samples);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]!);
      if (v > peak) peak = v;
    }
    const now = performance.now();
    if (now >= this.levelUntilMs) {
      // the meter updates at ~12 Hz, not 100 Hz
      this.levelUntilMs = now + 80;
      this.set({ level: peak, outLevel: this.outLevelValue, played: this.posted });
    }
    const enc = this.encoder;
    if (enc && enc.state === "configured") {
      try {
        const pcm = this.muted ? new Float32Array(BLOCK) : samples;
        const ad = new AudioData({ format: "f32", sampleRate: RATE, numberOfFrames: BLOCK, numberOfChannels: 1, timestamp: Math.round((frame / RATE) * 1e6), data: pcm as unknown as BufferSource });
        enc.encode(ad);
        ad.close();
      } catch { /* a bad block is skipped; the master recording is unaffected */ }
    }
  }

  // ---- playout (the other person's voice) ----

  private startPlayout(): void {
    this.jb = new JitterBuffer(3);
    this.arrival = new ArrivalStats();
    this.concealed = this.decodeErrors = this.concealRun = 0;
    this.lastPcm = null;
    this.pendingDecodes = 0;
    this.offAudio = window.daw.live.onAudio((p) => this.onPacket(p));
    this.offEnd = window.daw.live.onEnd(() => {
      this.jb.reset();
      this.arrival.reset();
    });
    this.pullTimer = setInterval(() => this.pump(), 5);
    this.statsTimer = setInterval(() => this.reportStats(), 250);
  }

  private stopPlayout(): void {
    this.offAudio?.();
    this.offEnd?.();
    this.offAudio = this.offEnd = null;
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.pullTimer = this.statsTimer = null;
  }

  private onPacket(p: { seq: number; mediaIndex: number; payload: Uint8Array; muted: boolean; arrivalMs: number }): void {
    const arrivalNs = p.arrivalMs * 1e6;
    if (!this.arrival.onPacket(p.seq, p.mediaIndex, arrivalNs)) return;
    this.jb.insert({ seq: p.seq, mediaIndex: p.mediaIndex, arrivalNs, data: p.payload });
  }

  private ensureDecoder(): AudioDecoder | null {
    if (this.decoder && this.decoder.state === "configured") return this.decoder;
    if (!this.state.talkSupported) return null;
    try {
      const d = new AudioDecoder({
        output: (ad) => {
          const pcm = new Float32Array(ad.numberOfFrames);
          ad.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
          ad.close();
          this.pendingDecodes = Math.max(0, this.pendingDecodes - 1);
          this.play(pcm);
        },
        error: () => {
          this.decodeErrors++;
          this.pendingDecodes = 0;
          this.decoder = null;
        },
      });
      d.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1 });
      this.decoder = d;
      return d;
    } catch {
      return null;
    }
  }

  private play(pcm: Float32Array): void {
    this.concealRun = 0;
    this.lastPcm = pcm.slice();
    this.posted += pcm.length;
    this.playback?.port.postMessage({ pcm }, [pcm.buffer]);
  }

  private conceal(): void {
    // WebCodecs has no packet-loss concealment, so a missing frame repeats the last one, fading out quickly (never a click).
    this.concealed++;
    this.concealRun++;
    const base = this.lastPcm;
    const out = new Float32Array(BLOCK);
    if (base && this.concealRun <= 3) {
      const gain = Math.pow(0.5, this.concealRun);
      for (let i = 0; i < BLOCK; i++) out[i] = (base[i] ?? 0) * gain;
    }
    this.posted += BLOCK;
    this.playback?.port.postMessage({ pcm: out }, [out.buffer]);
  }

  /** Keeps ~20 ms queued in the playback worklet by pulling frames from the jitter buffer as the audio device consumes them. */
  private pump(): void {
    if (!this.playback) return;
    if (!this.hear) {
      // still run the buffer so the sender's reports stay truthful, but play nothing
      let guard = 0;
      while (this.jb.playing && guard++ < 4) this.jb.pull();
      return;
    }
    const dec = this.ensureDecoder();
    let guard = 0;
    while (guard++ < 6 && this.posted - this.consumed + this.pendingDecodes * BLOCK < 2 * BLOCK) {
      const r = this.jb.pull();
      if (r.kind === "filling") break;
      if (r.kind === "packet") {
        if (!dec) break;
        this.pendingDecodes++;
        try {
          dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round((r.packet.mediaIndex / RATE) * 1e6), data: r.packet.data as unknown as BufferSource }));
        } catch {
          this.pendingDecodes = Math.max(0, this.pendingDecodes - 1);
          this.decodeErrors++;
        }
      } else {
        this.conceal();
      }
    }
  }

  private reportStats(): void {
    const j = this.jb.stats;
    window.daw.live.incomingStats({
      received: this.arrival.received,
      lostEstimate: this.arrival.lostEstimate,
      late: j.late,
      duplicates: this.arrival.duplicates,
      reordered: this.arrival.reordered,
      jitterUs: this.arrival.jitterUs,
      jbFill: this.jb.held,
      jbTarget: this.jb.targetFrames,
      underruns: j.underruns,
      concealed: this.concealed,
      decodeErrors: this.decodeErrors,
    });
  }
}

/** One per window: the microphone and the talkback are shared by every part of the interface. */
export const liveAudio = new LiveAudio();

// End-to-end tests drive the audio through this handle (development builds and test runs only).
if (typeof window !== "undefined" && window.daw?.isDev) {
  void window.daw.isDev().then((dev) => {
    if (dev) (window as unknown as { __liveAudio?: LiveAudio }).__liveAudio = liveAudio;
  });
}
