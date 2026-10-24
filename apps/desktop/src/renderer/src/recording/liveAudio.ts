import { ArrivalStats, JitterBuffer } from "@daw/recording";
import workletUrl from "./recordingWorklets.js?url";

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
  talkSupported: boolean;
}

export interface DeviceList {
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
}

type Listener = () => void;

export class LiveAudio {
  private state: MicState = { open: false, starting: false, deviceName: "", error: "", level: 0, outLevel: 0, played: 0, talkSupported: typeof AudioEncoder !== "undefined" && typeof AudioDecoder !== "undefined" };
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
      await ctx.audioWorklet.addModule(workletUrl);
      if (ctx.state !== "running") await ctx.resume();
      const track = stream.getAudioTracks()[0]!;
      const src = ctx.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(ctx, "rr-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const silent = ctx.createGain();
      silent.gain.value = 0;
      src.connect(capture);
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
      track.onended = () => {
        void this.stopMic("The microphone was disconnected.");
      };
      this.rateOk = Math.round(ctx.sampleRate) === RATE;
      this.set({ open: true, starting: false, deviceName: track.label || "microphone", talkSupported: this.state.talkSupported && this.rateOk });
      window.daw.live.captureState({ open: true, deviceName: track.label || "microphone", sampleRate: Math.round(ctx.sampleRate), channels: 1 });
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
    this.ctx = this.capture = this.playback = this.outGain = null;
    this.stream = null;
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
