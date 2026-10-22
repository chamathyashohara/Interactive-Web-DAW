import { ENGINE_MAX_SLOTS, type EngineProjectSnapshot, type EngineTrack } from "@daw/engine-protocol";
import { PPQ, songTicks, type Project } from "@daw/shared";

/** Fader curve: 0..100 -> linear gain. Squared so the lower half of the fader is usable. */
export const volumeToGain = (volume: number) => (volume / 100) ** 2;

/**
 * Gives every track a stable engine slot (0..15) so voices, smoothing state and meters survive edits.
 * Slots of deleted tracks are reused.
 */
export class SlotAllocator {
  private readonly slots = new Map<string, number>();

  sync(project: Project): void {
    for (const id of [...this.slots.keys()]) if (!project.tracks[id]) this.slots.delete(id);
    const used = new Set(this.slots.values());
    for (const id of project.trackOrder) {
      if (this.slots.has(id)) continue;
      let s = 0;
      while (used.has(s) && s < ENGINE_MAX_SLOTS - 1) s++;
      this.slots.set(id, s);
      used.add(s);
    }
  }
  slotFor(trackId: string): number | undefined {
    return this.slots.get(trackId);
  }
  trackFor(slot: number): string | undefined {
    for (const [id, s] of this.slots) if (s === slot) return id;
    return undefined;
  }
}

/** How much a sample must be sped up (>1) or slowed down (<1) to follow the project tempo; null when it plays as recorded. */
export function stretchRatioFor(projectTempo: number, sample: { bpm?: number; fit?: boolean }): number | null {
  if (!sample.fit || !sample.bpm) return null;
  const ratio = projectTempo / sample.bpm;
  if (Math.abs(ratio - 1) < 0.0005) return null;
  return Math.max(0.25, Math.min(4, ratio));
}

/** Mute/solo resolution: any soloed track silences all non-soloed ones; mute always silences. */
export function isAudible(project: Project, trackId: string): boolean {
  const track = project.tracks[trackId];
  if (!track || track.mute) return false;
  const anySolo = Object.values(project.tracks).some((t) => t.solo);
  return !anySolo || track.solo;
}

/** Flattens tracks -> clips -> notes into the absolute-tick note lists the audio engine plays. */
export function toEngineSnapshot(project: Project, slots: SlotAllocator, sampleFile: (sampleId: string) => string | null = () => null): EngineProjectSnapshot {
  slots.sync(project);
  const loopTicks = songTicks(project); // playback loops over the song, not over the longest clip
  const tracks: EngineTrack[] = [];
  for (const trackId of project.trackOrder) {
    const track = project.tracks[trackId];
    if (!track) continue;
    const notes: EngineTrack["notes"] = [];
    const secPerTick = 60 / (project.tempo * PPQ);
    const stretch = track.instrument === "sample" && track.sample ? stretchRatioFor(project.tempo, track.sample) ?? 1 : 1;
    for (const clip of Object.values(track.clips)) {
      const a = track.instrument === "sample" ? clip.audio : undefined;
      for (const n of Object.values(clip.notes)) {
        if (n.muted) continue; // muted notes stay in the project but are not played
        const note: EngineTrack["notes"][number] = { pitch: n.pitch, startTick: clip.startTick + n.startTick, durationTicks: n.durationTicks, velocity: n.velocity };
        if (a) {
          if (a.gainDb) note.gain = 10 ** (a.gainDb / 20);
          if (a.startSec) note.offsetSec = a.startSec / stretch; // the sound was stretched by `stretch`, so its parts moved by the same factor
          if (a.fadeInTicks) note.fadeInSec = a.fadeInTicks * secPerTick;
          if (a.fadeOutTicks) note.fadeOutSec = a.fadeOutTicks * secPerTick;
          if (a.cut || a.fadeOutTicks) note.cut = true;
        }
        notes.push(note);
      }
    }
    const et: EngineTrack = {
      slot: slots.slotFor(trackId)!,
      instrument: track.instrument,
      gain: isAudible(project, trackId) ? volumeToGain(track.volume) : 0,
      pan: track.pan / 100,
      notes,
    };
    if (track.instrument === "sample" && track.sample) {
      const file = sampleFile(track.sample.id);
      if (file) et.samplePath = file;
      et.gate = track.sample.gate;
      const ratio = stretchRatioFor(project.tempo, track.sample);
      if (ratio !== null) et.stretchRatio = ratio;
    }
    const auto: NonNullable<EngineTrack["automation"]> = {};
    if (track.automation?.volume?.length) auto.volume = track.automation.volume.map((p) => [p.tick, p.value]);
    if (track.automation?.filter?.length) auto.filter = track.automation.filter.map((p) => [p.tick, p.value]);
    if (auto.volume || auto.filter) et.automation = auto;
    tracks.push(et);
  }
  return { ppq: project.ppq, tempo: project.tempo, loopTicks, masterGain: volumeToGain(project.masterVolume), tracks };
}
