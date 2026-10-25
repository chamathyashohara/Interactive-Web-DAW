import { TakeStatus } from "../errors";
import { type LocalReadiness, ReadyItem } from "../session";
import { type Clock, systemClock } from "./clock";
import { type PortTakeSpec, type RecorderPort, TestRecorderPort } from "./recorderPort";

export interface VocalProducerHost {
  /** the audio engine that plays the arrangement is running */
  engineReady(): boolean;
  /** the take has started on the shared clock: play the arrangement from the take's start position */
  onStart(spec: PortTakeSpec): void;
  /** the take has ended: stop the arrangement */
  onEnd(spec: PortTakeSpec, reason: string): void;
}

/**
 * The producer's side of a "vocal over backing track" take. The producer does not record anything: the singer's microphone is recorded on the
 * singer's PC. What the producer does at the planned start is play the arrangement from the chosen position (so the producer hears the
 * same music at the same moment), and stop it when the take stops. Timing comes from the same schedule as a normal take.
 */
export class VocalProducerPort extends TestRecorderPort implements RecorderPort {
  constructor(private host: VocalProducerHost, clock: Clock = systemClock) {
    super(clock);
  }

  override readiness(): LocalReadiness {
    const engine = this.host.engineReady();
    const idle = !this.active;
    const checks = [
      { item: ReadyItem.EngineHealthy, ok: engine, mandatory: true, detail: engine ? "audio engine running" : "the audio engine is not running" },
      { item: ReadyItem.NoActiveRecording, ok: idle, mandatory: true, detail: idle ? "idle" : "a take is running" },
    ];
    const reasons: string[] = [];
    if (!engine) reasons.push("the audio engine is not running");
    return { ok: engine && idle, reasons, checks };
  }

  override poll() {
    const events = super.poll();
    for (const e of events) {
      const spec = this.spec;
      if (!spec) continue;
      if (e.kind === "started") this.host.onStart(spec);
      else {
        e.status = e.stopReason.includes("fault") ? TakeStatus.IncompleteDevice : TakeStatus.Complete;
        this.host.onEnd(spec, e.stopReason);
      }
    }
    return events;
  }

  override description(): string {
    return "the arrangement plays here; the singer's microphone is recorded on the singer's PC";
  }
}
