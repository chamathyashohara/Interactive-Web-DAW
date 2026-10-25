// Audio worklets for remote recording. They run on the audio thread, so they only move samples; every decision is made elsewhere.

/**
 * Collects the microphone into 480-frame (10 ms at 48 kHz) blocks and posts them with the index of the block's first frame on the AUDIO CONTEXT's own
 * frame counter (`currentFrame`). The backing track is scheduled on that same counter, so "the take starts on frame S" and "the music starts on frame S"
 * are the same instant by construction, whatever the device or the browser's scheduling does.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(480);
    this.fill = 0;
    this.blockStart = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    const n = 128;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.blockStart = currentFrame + i;
      this.block[this.fill++] = input ? input[i] : 0;
      if (this.fill === 480) {
        const out = this.block;
        this.port.postMessage({ frame: this.blockStart, samples: out }, [out.buffer]);
        this.block = new Float32Array(480);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor("rr-capture", CaptureProcessor);

/** Plays decoded PCM from a ring buffer and reports how much it has consumed, so the page can keep it topped up. */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000;
    this.buf = new Float32Array(this.cap);
    this.r = 0;
    this.w = 0;
    this.count = 0;
    this.consumed = 0;
    this.sinceReport = 0;
    this.underruns = 0;
    this.peak = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.pcm) {
        const p = d.pcm;
        for (let i = 0; i < p.length; i++) {
          if (this.count >= this.cap) break;
          this.buf[this.w] = p[i];
          this.w = (this.w + 1) % this.cap;
          this.count++;
        }
      } else if (d.flush) {
        this.r = this.w = this.count = 0;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      if (this.count > 0) {
        s = this.buf[this.r];
        this.r = (this.r + 1) % this.cap;
        this.count--;
        this.consumed++;
        const a = s < 0 ? -s : s;
        if (a > this.peak) this.peak = a;
      }
      for (let c = 0; c < out.length; c++) out[c][i] = s;
    }
    this.sinceReport += n;
    if (this.sinceReport >= 480) {
      this.sinceReport = 0;
      this.port.postMessage({ consumed: this.consumed, level: this.count, peak: this.peak });
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor("rr-playback", PlaybackProcessor);
