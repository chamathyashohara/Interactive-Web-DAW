import { DEFAULT_MIX_REFERENCE, type MixReference, type Project } from "./model";
import type { OpBody } from "./ops";

/**
 * Mixer assistance: measures what the audio engine reports while the song plays, finds likely problems and proposes a gain change with
 * a plain explanation. Everything here is deterministic arithmetic on measured levels (no machine learning) and pure (no engine, no
 * Electron), so it is unit-tested directly. All levels are SAMPLE peaks in dBFS: the highest sample value seen, which can be a little
 * below the true (reconstructed) peak between samples.
 */

// ------------------------------------------------------------------------------------------------ level maths

/** The fader's own curve: gain = (value / 100)^2, so 100 is 0 dB and each halving of the value is -12 dB. */
export const faderToDb = (volume: number): number => (volume <= 0 ? -Infinity : 40 * Math.log10(volume / 100));
export const linearToDb = (linear: number): number => (linear <= 0 ? -Infinity : 20 * Math.log10(linear));

/** The largest single change a suggestion proposes; anything bigger is better made by listening and adjusting in steps. */
export const MAX_SUGGESTED_CHANGE_DB = 12;
/** A channel this far over its target is flagged; closer than this is treated as on target (meters wobble a little). */
export const TARGET_TOLERANCE_DB = 0.5;
/** A channel this far under its target is mentioned as quiet (it is only a note: quiet parts are often right). */
export const QUIET_BELOW_TARGET_DB = 12;
/** Channels within this many dB of the loudest one are treated as joint contributors to a master peak. */
export const CONTRIBUTOR_WINDOW_DB = 6;
/** Not enough playback to judge yet. */
export const MIN_ANALYSIS_SECONDS = 0.25;

/**
 * Moves a fader by about `wantedDb`. The fader has whole-number steps, so the result is the nearest step (at least one step in the
 * wanted direction); `actualDb` is what that step really does. Null when no usable step exists (already at an end of the fader).
 */
export function planFaderChange(fromVolume: number, wantedDb: number): { toVolume: number; actualDb: number } | null {
  if (!Number.isFinite(wantedDb) || wantedDb === 0 || fromVolume <= 0) return null;
  let to = Math.round(fromVolume * Math.pow(10, wantedDb / 40));
  if (wantedDb < 0 && to >= fromVolume) to = fromVolume - 1;
  if (wantedDb > 0 && to <= fromVolume) to = fromVolume + 1;
  to = Math.min(100, Math.max(1, to));
  if (to === fromVolume) return null;
  return { toVolume: to, actualDb: faderToDb(to) - faderToDb(fromVolume) };
}

export const referenceOf = (project: Pick<Project, "mixReference">): MixReference => ({ ...DEFAULT_MIX_REFERENCE, ...project.mixReference });
export const channelTargetDb = (ref: MixReference, trackId: string): number => ref.channels?.[trackId] ?? ref.channelPeakDb;

// ------------------------------------------------------------------------------------------------ measuring

/** The part of the engine's status message the analyzer reads (all new fields are optional so an older engine just reports nothing). */
export interface MixStatusInput {
  playing: boolean;
  callbacks: number;
  masterL: number;
  masterR: number;
  /** Master peak before the soft clip, linear (can be above 1). */
  prePeak?: number;
  /** Samples in this interval above the soft-clip knee / at or above full scale. */
  softClips?: number;
  overs?: number;
  /** Per engine slot: what the channel put on the master bus (after fader and pan), as a peak, a sum of squares and a frame count. */
  bus?: number[];
  sumSq?: number[];
  frames?: number[];
}
export interface MixAnalyzerContext {
  project: Project;
  sampleRate: number;
  bufferSize: number;
  trackOf: (slot: number) => string | undefined;
}

export interface ChannelMeasure {
  trackId: string;
  /** Highest bus sample since the measurement started (linear). */
  peak: number;
  /** RMS of the channel while it was sounding (linear); 0 when it never sounded. */
  rms: number;
  /** Seconds the channel was sounding (silent time is not counted, so a part that plays rarely is not averaged away). */
  seconds: number;
  /** The fader value the measurement was made at. */
  volume: number;
}
export interface MixSnapshot {
  /** live = measured while the song played; song = measured by rendering the whole song offline. */
  source: "live" | "song";
  /** Bumps whenever a new measurement pass starts (playback pressed, or measurements were reset). */
  pass: number;
  playing: boolean;
  /** How much playback has been measured. */
  seconds: number;
  /** True when a fader (or pan, mute, solo) moved after the measurement: what it shows no longer describes the mix. */
  stale: boolean;
  master: {
    /** Highest master sample BEFORE the soft clip (linear, can be above 1). */
    prePeak: number;
    /** Highest sample actually sent to the speakers (never above 1: the soft clip sees to that). */
    outPeak: number;
    /** Estimated true peak (between the samples) of the pre-clip master; only a whole-song analysis can measure it, else null. */
    truePeak: number | null;
    /** Time the soft clip was shaping the sound, and time the signal would have passed full scale without it. */
    softClipSeconds: number;
    overSeconds: number;
    volume: number;
  };
  channels: Record<string, ChannelMeasure>;
}

interface ChannelAcc { peak: number; sumSq: number; frames: number; sig: string }

/**
 * Everything in the project that changes what the channels or the master put out, as one string. Two equal signatures mean a
 * measurement made under the first still describes the second.
 */
export function mixSignature(project: Project): string {
  const anySolo = Object.values(project.tracks).some((t) => t.solo);
  const parts = project.trackOrder.map((id) => {
    const t = project.tracks[id];
    return t ? `${id}:${t.volume}|${t.pan}|${!t.mute && (!anySolo || t.solo) ? 1 : 0}` : id;
  });
  return `${project.masterVolume};${parts.join(",")}`;
}
const channelSignature = (project: Project, id: string): string => {
  const t = project.tracks[id];
  if (!t) return "";
  const anySolo = Object.values(project.tracks).some((x) => x.solo);
  return `${t.volume}|${t.pan}|${!t.mute && (!anySolo || t.solo) ? 1 : 0}`;
};

/** The offline whole-song result as the engine reports it (arrays per engine slot). */
export interface SongAnalysisInput {
  sampleRate: number;
  totalFrames: number;
  prePeak: number;
  truePeak: number;
  outPeak: number;
  softClips: number;
  overs: number;
  bus: number[];
  sumSq: number[];
  frames: number[];
}

/**
 * Accumulates the engine's per-interval numbers into a measurement of the current playback. A pass starts when playback starts. A
 * channel's numbers start again from zero when something that changes what it puts on the bus changes (its fader, pan, mute/solo
 * state), and the master's when the master fader moves: an old peak says nothing about the new gain, and it must not be shown as if it did.
 */
export class MixAnalyzer {
  private pass = 0;
  private wasPlaying = false;
  private lastCallbacks: number | null = null;
  private seconds = 0;
  private channels = new Map<string, ChannelAcc>();
  private master = { prePeak: 0, outPeak: 0, softClips: 0, overs: 0, sig: "" };
  private truePeak: number | null = null;
  private source: "live" | "song" = "live";
  private stale = false;
  private sampleRate = 48000;
  private playing = false;

  reset(): void {
    this.pass++;
    this.seconds = 0;
    this.channels.clear();
    this.truePeak = null;
    this.source = "live";
    this.stale = false;
    this.master = { prePeak: 0, outPeak: 0, softClips: 0, overs: 0, sig: this.master.sig };
  }

  /** Replaces the measurement with a whole-song one (rendered offline). A later playback, or any change to a fader, starts a live pass again. */
  loadWholeSong(result: SongAnalysisInput, ctx: Pick<MixAnalyzerContext, "project" | "trackOf">): void {
    this.reset();
    this.source = "song";
    this.sampleRate = result.sampleRate > 0 ? result.sampleRate : 48000;
    this.seconds = result.totalFrames / this.sampleRate;
    for (const id of ctx.project.trackOrder) this.channels.set(id, { peak: 0, sumSq: 0, frames: 0, sig: channelSignature(ctx.project, id) });
    result.bus.forEach((peak, slot) => {
      const id = ctx.trackOf(slot);
      const acc = id ? this.channels.get(id) : undefined;
      if (!acc) return;
      acc.peak = peak;
      acc.sumSq = result.sumSq[slot] ?? 0;
      acc.frames = result.frames[slot] ?? 0;
    });
    this.master = { prePeak: result.prePeak, outPeak: result.outPeak, softClips: result.softClips, overs: result.overs, sig: String(ctx.project.masterVolume) };
    this.truePeak = result.truePeak;
  }

  feed(status: MixStatusInput, ctx: MixAnalyzerContext): void {
    this.sampleRate = ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    this.playing = status.playing;
    if (status.playing && !this.wasPlaying) this.reset();
    this.wasPlaying = status.playing;
    const delta = this.lastCallbacks === null ? 0 : Math.max(0, status.callbacks - this.lastCallbacks);
    this.lastCallbacks = status.callbacks;

    // Restart the numbers of whatever just changed its gain. The master is the sum of the channels, so any change makes its peak out of date too.
    let changed = false;
    for (const id of ctx.project.trackOrder) {
      const t = ctx.project.tracks[id];
      if (!t) continue;
      const sig = channelSignature(ctx.project, id);
      const acc = this.channels.get(id);
      if (!acc) this.channels.set(id, { peak: 0, sumSq: 0, frames: 0, sig });
      else if (acc.sig !== sig) {
        this.channels.set(id, { peak: 0, sumSq: 0, frames: 0, sig });
        changed = true;
      }
    }
    const masterSig = String(ctx.project.masterVolume);
    if (this.master.sig !== masterSig) changed = true;
    if (changed) {
      const hadData = this.seconds > 0;
      this.master = { prePeak: 0, outPeak: 0, softClips: 0, overs: 0, sig: masterSig };
      this.truePeak = null; // measured at the old gains
      if (hadData) {
        this.source = "live";
        this.stale = true;
      }
    }

    if (!status.playing) return;
    this.seconds += (delta * Math.max(1, ctx.bufferSize)) / this.sampleRate;
    status.bus?.forEach((peak, slot) => {
      const id = ctx.trackOf(slot);
      const acc = id ? this.channels.get(id) : undefined;
      if (!acc) return;
      acc.peak = Math.max(acc.peak, peak);
      acc.sumSq += status.sumSq?.[slot] ?? 0;
      acc.frames += status.frames?.[slot] ?? 0;
    });
    this.master.prePeak = Math.max(this.master.prePeak, status.prePeak ?? 0);
    this.master.outPeak = Math.max(this.master.outPeak, status.masterL, status.masterR);
    this.master.softClips += status.softClips ?? 0;
    this.master.overs += status.overs ?? 0;
  }

  snapshot(project: Project): MixSnapshot {
    const channels: Record<string, ChannelMeasure> = {};
    for (const id of project.trackOrder) {
      const acc = this.channels.get(id);
      const t = project.tracks[id];
      if (!t) continue;
      channels[id] = {
        trackId: id,
        peak: acc?.peak ?? 0,
        rms: acc && acc.frames > 0 ? Math.sqrt(acc.sumSq / (2 * acc.frames)) : 0,
        seconds: acc ? acc.frames / this.sampleRate : 0,
        volume: t.volume,
      };
    }
    return {
      source: this.source,
      pass: this.pass,
      playing: this.playing,
      seconds: this.seconds,
      stale: this.stale,
      master: {
        prePeak: this.master.prePeak,
        outPeak: this.master.outPeak,
        truePeak: this.truePeak,
        softClipSeconds: this.master.softClips / this.sampleRate,
        overSeconds: this.master.overs / this.sampleRate,
        volume: project.masterVolume,
      },
      channels,
    };
  }
}

// ------------------------------------------------------------------------------------------------ findings

export type FindingSeverity = "problem" | "target" | "note";

export interface MixSuggestion {
  id: string;
  /** Short button text, e.g. "Lower Kick by 4.0 dB". */
  label: string;
  /** What changes, for the review panel. */
  summary: string;
  /** Applied as ONE undoable step. */
  ops: OpBody[];
  /** Puts the touched faders back exactly where they were. */
  restore: OpBody[];
  /** Whether the result can be stated exactly (a master fader) or only roughly. */
  predicted: string;
}
export interface MixFinding {
  id: string;
  severity: FindingSeverity;
  scope: "channel" | "master";
  trackId?: string;
  headline: string;
  /** What was measured. */
  detected: string;
  /** What the suggestion changes. */
  change: string;
  /** Why that may help. */
  why: string;
  /** What to check by ear afterwards. */
  listen: string;
  /** What this does NOT solve. */
  limits?: string;
  suggestions: MixSuggestion[];
}
export type ChannelState = "silent" | "ok" | "above-target" | "full-scale" | "quiet";
export interface ChannelReading {
  trackId: string;
  name: string;
  state: ChannelState;
  peakDb: number;
  rmsDb: number;
  targetDb: number;
  /** Channel peak minus master peak, in dB (how close this channel gets to the master peak; 0 = as loud). */
  belowMasterDb: number | null;
}
export interface MasterReading {
  prePeakDb: number;
  /** Estimated true peak in dBFS, or null when only live (sample-peak) measurement exists. */
  truePeakDb: number | null;
  outPeakDb: number;
  /** Space between the measured peak and 0 dBFS. Negative = over full scale. */
  headroomDb: number;
  targetDb: number;
  safetyDb: number;
  state: "ok" | "above-target" | "above-warning" | "clipping";
  softClipSeconds: number;
  overSeconds: number;
}
export interface MixReport {
  /** no-data = not enough playback measured yet; stale = a fader moved since, so play again; silent = playback measured but nothing was audible. */
  status: "no-data" | "stale" | "silent" | "measured";
  master: MasterReading | null;
  channels: ChannelReading[];
  findings: MixFinding[];
  reference: MixReference;
  /** One standing sentence that keeps the numbers in perspective. */
  perspective: string;
}

const fmt = (db: number, digits = 1): string => (Number.isFinite(db) ? (Math.abs(db) < 0.05 ? 0 : db).toFixed(digits) : "-inf");
const dbfs = (db: number): string => `${fmt(db)} dBFS`;
const dbAmount = (db: number): string => `${fmt(Math.abs(db))} dB`;

export const MIX_PERSPECTIVE =
  "These numbers are sample peaks and your own reference levels. Meeting a target does not make a mix balanced or ready for mastering: the right levels depend on the sound, the arrangement and what you hear.";

const channelSuggestion = (project: Project, trackId: string, wantedDb: number): { s: MixSuggestion; actualDb: number; clamped: boolean } | null => {
  const track = project.tracks[trackId];
  if (!track) return null;
  const clamped = Math.abs(wantedDb) > MAX_SUGGESTED_CHANGE_DB;
  const plan = planFaderChange(track.volume, Math.max(-MAX_SUGGESTED_CHANGE_DB, Math.min(MAX_SUGGESTED_CHANGE_DB, wantedDb)));
  if (!plan) return null;
  const verb = plan.actualDb < 0 ? "Lower" : "Raise";
  return {
    actualDb: plan.actualDb,
    clamped,
    s: {
      id: `fader-${trackId}`,
      label: `${verb} ${track.name} by ${dbAmount(plan.actualDb)}`,
      summary: `${track.name} fader: ${fmt(faderToDb(track.volume))} dB → ${fmt(faderToDb(plan.toVolume))} dB (${verb.toLowerCase()} by ${dbAmount(plan.actualDb)})`,
      ops: [{ type: "updateTrack", trackId, changes: { volume: plan.toVolume } }],
      restore: [{ type: "updateTrack", trackId, changes: { volume: track.volume } }],
      predicted: "about",
    },
  };
};

const masterSuggestion = (project: Project, wantedDb: number): { s: MixSuggestion; actualDb: number; clamped: boolean } | null => {
  const clamped = Math.abs(wantedDb) > MAX_SUGGESTED_CHANGE_DB;
  const plan = planFaderChange(project.masterVolume, Math.max(-MAX_SUGGESTED_CHANGE_DB, Math.min(0, wantedDb)));
  if (!plan) return null;
  return {
    actualDb: plan.actualDb,
    clamped,
    s: {
      id: "fader-master",
      label: `Lower the master by ${dbAmount(plan.actualDb)}`,
      summary: `Master fader: ${fmt(faderToDb(project.masterVolume))} dB → ${fmt(faderToDb(plan.toVolume))} dB (lower by ${dbAmount(plan.actualDb)})`,
      ops: [{ type: "setMasterVolume", volume: plan.toVolume }],
      restore: [{ type: "setMasterVolume", volume: project.masterVolume }],
      predicted: "exactly",
    },
  };
};

/**
 * Turns a measurement into readings and findings. Findings come in three kinds that are kept apart on purpose:
 *   problem = a measured technical problem (a channel at full scale, the master clipping or being shaped by the soft clip),
 *   target  = a level above the reference the user configured (their choice, not a rule),
 *   note    = something worth a listen that the numbers cannot decide.
 * The master is never changed just because it is high: its finding names the contributing channels and explains the options.
 */
export function analyzeMix(project: Project, snap: MixSnapshot | null): MixReport {
  const reference = referenceOf(project);
  const empty: MixReport = { status: "no-data", master: null, channels: [], findings: [], reference, perspective: MIX_PERSPECTIVE };
  if (!snap || snap.seconds < MIN_ANALYSIS_SECONDS) return empty;
  if (snap.stale) return { ...empty, status: "stale" };

  const prePeakDb = linearToDb(snap.master.prePeak);
  const anySound = snap.master.prePeak > 1e-4 || Object.values(snap.channels).some((c) => c.seconds > 0 && c.peak > 1e-4);
  const findings: MixFinding[] = [];
  const channels: ChannelReading[] = [];

  const masterState: MasterReading["state"] =
    snap.master.overSeconds > 0 || snap.master.prePeak >= 1 ? "clipping"
    : prePeakDb > reference.safetyDb ? "above-warning"
    : prePeakDb > reference.masterPeakDb + TARGET_TOLERANCE_DB ? "above-target"
    : "ok";
  const master: MasterReading = {
    prePeakDb,
    truePeakDb: snap.master.truePeak === null ? null : linearToDb(snap.master.truePeak),
    outPeakDb: linearToDb(snap.master.outPeak),
    headroomDb: -prePeakDb,
    targetDb: reference.masterPeakDb,
    safetyDb: reference.safetyDb,
    state: anySound ? masterState : "ok",
    softClipSeconds: snap.master.softClipSeconds,
    overSeconds: snap.master.overSeconds,
  };

  // ---- channels
  const sounding: { id: string; name: string; peakDb: number }[] = [];
  for (const id of project.trackOrder) {
    const t = project.tracks[id];
    const m = snap.channels[id];
    if (!t) continue;
    const targetDb = channelTargetDb(reference, id);
    if (!m || m.seconds <= 0 || m.peak <= 1e-4) {
      channels.push({ trackId: id, name: t.name, state: "silent", peakDb: -Infinity, rmsDb: -Infinity, targetDb, belowMasterDb: null });
      continue;
    }
    const peakDb = linearToDb(m.peak);
    sounding.push({ id, name: t.name, peakDb });
    const state: ChannelState = m.peak >= 1 ? "full-scale" : peakDb > targetDb + TARGET_TOLERANCE_DB ? "above-target" : peakDb < targetDb - QUIET_BELOW_TARGET_DB ? "quiet" : "ok";
    channels.push({ trackId: id, name: t.name, state, peakDb, rmsDb: linearToDb(m.rms), targetDb, belowMasterDb: Number.isFinite(prePeakDb) ? peakDb - prePeakDb : null });

    if (state === "full-scale" || state === "above-target") {
      const over = peakDb - targetDb;
      const sug = channelSuggestion(project, id, targetDb - peakDb);
      const full = state === "full-scale";
      findings.push({
        id: `channel-${id}`,
        severity: full ? "problem" : "target",
        scope: "channel",
        trackId: id,
        headline: full ? `${t.name} reaches full scale` : `${t.name} is above its target`,
        detected: full
          ? `${t.name} reaches ${dbfs(peakDb)} before the master: its signal touches the digital maximum on its own. That is a measured technical problem, whatever the target.`
          : `${t.name} peaks at ${dbfs(peakDb)}, which is ${dbAmount(over)} above your target of ${dbfs(targetDb)}. The target is your own reference, not a rule.`,
        change: sug
          ? `${sug.s.summary}. Nothing else on the channel (pan, effects, automation, mute/solo) is touched.`
          : `No fader step is left in that direction (the ${t.name} fader is at its limit), so there is nothing to apply here.`,
        why: sug
          ? `Lowering the channel gain lowers its peak by the same amount, so it should land near ${dbfs(peakDb + sug.actualDb)}. That also leaves more room on the master for the other channels.`
          : `Another way to lower its peak is on the source itself, for example a quieter sound or lower note velocities.`,
        listen: `Play ${t.name} together with the rest of the mix. Check that it still sits well next to the other parts. If it now feels buried, a different target, or EQ and arrangement changes, may serve better than more level.`,
        limits: sug?.clamped ? `You are ${dbAmount(over)} over, but one suggestion changes at most ${MAX_SUGGESTED_CHANGE_DB} dB. Apply it, play again, and recheck. A level that far off may also mean the sound itself is very hot.` : undefined,
        suggestions: sug ? [sug.s] : [],
      });
    } else if (state === "quiet" && masterState === "ok") {
      const sug = channelSuggestion(project, id, targetDb - peakDb);
      findings.push({
        id: `channel-${id}`,
        severity: "note",
        scope: "channel",
        trackId: id,
        headline: `${t.name} is quiet`,
        detected: `${t.name} peaks at ${dbfs(peakDb)}, ${dbAmount(targetDb - peakDb)} below your target of ${dbfs(targetDb)}.`,
        change: sug ? `${sug.s.summary}. The fader has room to go up by this much (it stops at 0 dB).` : `The ${t.name} fader is already at its top, so only the source can be made louder.`,
        why: `A quiet channel is not always a problem: a background pad or a soft layer is often meant to be quiet. If you want it more present, its fader is the first place to look.`,
        listen: `Listen to ${t.name} against the parts it should support. Only raise it if it is hard to hear when it matters.`,
        suggestions: sug ? [sug.s] : [],
      });
    }
  }

  // ---- master
  const loudest = sounding.reduce((a, c) => Math.max(a, c.peakDb), -Infinity);
  const contributors = sounding.filter((c) => c.peakDb >= loudest - CONTRIBUTOR_WINDOW_DB).sort((a, b) => b.peakDb - a.peakDb).slice(0, 4);
  const names = contributors.map((c) => `${c.name} (${dbfs(c.peakDb)})`).join(", ");
  if (anySound && masterState !== "ok") {
    const toTarget = reference.masterPeakDb - prePeakDb;
    const quick = masterSuggestion(project, toTarget);
    const suggestions: MixSuggestion[] = [];
    if (contributors.length >= 2 && contributors.length <= 4) {
      const ops: OpBody[] = [], restore: OpBody[] = [];
      const actuals: number[] = [];
      for (const c of contributors) {
        const sug = channelSuggestion(project, c.id, toTarget);
        if (!sug) continue;
        ops.push(...sug.s.ops);
        restore.push(...sug.s.restore);
        actuals.push(sug.actualDb);
      }
      const actual = actuals.reduce((a, b) => a + b, 0) / Math.max(1, actuals.length);
      if (ops.length === contributors.length) {
        suggestions.push({
          id: "contributors",
          label: `Lower ${contributors.length} loudest channels by ${dbAmount(actual)}`,
          summary: `Lowers only ${contributors.map((c) => c.name).join(", ")} by about ${dbAmount(actual)} each; every other fader stays where it is`,
          ops,
          restore,
          predicted: "roughly",
        });
      }
    }
    if (quick) suggestions.push(quick.s);

    const clipping = masterState === "clipping";
    const shaped = snap.master.softClipSeconds > 0;
    findings.push({
      id: "master",
      severity: masterState === "above-target" ? "target" : "problem",
      scope: "master",
      headline: clipping ? "The master output is clipping" : masterState === "above-warning" ? "The master is close to clipping" : "The master peak is above your target",
      detected: clipping
        ? `Your master output is clipping during playback: before the soft clip its peak reached ${dbfs(prePeakDb)} (${fmt(snap.master.overSeconds * 1000, 0)} ms at or over full scale). Several channels may be contributing to the excessive peak level; the loudest are ${names || "not clear yet"}. Review them before applying a correction.`
        : masterState === "above-warning"
          ? `The master peak reached ${dbfs(prePeakDb)}, above your warning level of ${dbfs(reference.safetyDb)}${shaped ? `, and the soft clip was shaping the sound for ${fmt(snap.master.softClipSeconds * 1000, 0)} ms` : ""}. The loudest channels are ${names || "not clear yet"}.`
          : `The master peak reached ${dbfs(prePeakDb)}, ${dbAmount(prePeakDb - reference.masterPeakDb)} above your master target of ${dbfs(reference.masterPeakDb)}. That target is a mixing reference you chose, not a mastering requirement: a mix can sound right above it.`,
      change: suggestions.length
        ? `${suggestions.map((s, i) => `Option ${i + 1}: ${s.summary}.`).join(" ")} Nothing is changed until you choose one.`
        : "No fader step is left in that direction. Lower the loudest channels by ear instead.",
      why: `Channels add together on the master, so a peak there can come from several parts at once. Lowering the master brings every peak down by the same amount (${quick ? `to about ${dbfs(prePeakDb + quick.actualDb)}` : "the exact result depends on the step"}), but it does not tell you which channel is too hot. Lowering the loudest channels instead tackles the cause, but how much the master drops depends on whether their peaks happen at the same moment.`,
      listen: `Play the loudest part of the song again and read the master. Listen for harshness on drums and bass, which is where a clipped peak is usually heard first, and check the balance between parts still feels right.`,
      limits: `Reducing one channel will not always solve a master peak made by several. If the channel findings above are also listed, deal with those first, then play again and recheck the master. A master reading at your target says nothing about whether the mix is balanced or ready for mastering.`,
      suggestions,
    });
  }

  const order = { problem: 0, target: 1, note: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.scope === "master" ? -1 : 1));
  return { status: anySound ? "measured" : "silent", master: anySound ? master : null, channels, findings, reference, perspective: MIX_PERSPECTIVE };
}

/** True when every op still matches the state it expected, so a "restore" will put back exactly what Apply changed. */
export function restoreIsClean(project: Project, applied: OpBody[]): boolean {
  return applied.every((op) => {
    if (op.type === "updateTrack") return project.tracks[op.trackId]?.volume === op.changes.volume;
    if (op.type === "setMasterVolume") return project.masterVolume === op.volume;
    return false;
  });
}
