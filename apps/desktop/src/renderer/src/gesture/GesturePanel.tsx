import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ASSIST_DESCRIPTION,
  ASSIST_LABEL,
  ASSIST_LEVELS,
  ADAPT_WINDOW,
  AssistController,
  BendRecorder,
  DEFAULT_PITCH_RANGE,
  GestureNoteMachine,
  PPQ,
  TICKS_PER_BAR,
  isInKey,
  keyLabel,
  noteName,
  octaveOf,
  placeNote,
  shiftBend,
  wrapPlayhead,
  type AssistLevel,
  type GestureDisplay,
  type GestureNoteEvent,
  type HandFrame,
  type PitchRange,
  type ProjectKey,
  type Track,
  type Clip,
} from "@daw/shared";
import { projectStore, statusStore, useStore } from "../store";
import { createHandSource, type HandSource } from "./handSource";

const VIDEO_W = 320;
const VIDEO_H = 240;
const RULER_W = 78;
const VELOCITY = 96;
// the 21 landmarks joined into a hand: thumb, fingers, palm
const BONES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

type Mode = "auto" | AssistLevel;
interface Held { recorder: BendRecorder; maxBend: number; pitch: number; startMs: number; startTick: number | null; rawPitch: number; rawInKey: boolean | null; playedInKey: boolean | null; snapped: boolean; level: AssistLevel }
interface Stats { notes: number; recorded: number; inferMs: number; inferHandMs: number; inferNoHandMs: number; frames: number; handFrames: number; display: GestureDisplay | null; message: string | null }

interface Props {
  track: Track;
  clip: Clip;
  /** The project's key (null = none): without one there is nothing for the help to follow. */
  musicKey: ProjectKey | null;
  gridTicks: number;
  onClose: () => void;
}

/**
 * Play notes with your hand in front of the webcam: a pinch plays the note at the height of your hand. The project's key helps you
 * stay in the scale, and the help is reduced by itself as you get better (or fixed at a level you choose). Notes can be recorded into
 * the clip while the song plays. The camera picture is processed on this computer only; it is never saved or sent.
 */
export function GesturePanel({ track, clip, musicKey, gridTicks, onClose }: Props) {
  const project = useStore(projectStore).project;
  const [phase, setPhase] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("auto");
  const [record, setRecord] = useState(false);
  const [glide, setGlide] = useState(false);
  const [low, setLow] = useState(DEFAULT_PITCH_RANGE.low);
  const [, force] = useState(0); // the status text is refreshed a few times a second, not on every camera frame

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<HandSource | null>(null);
  const controller = useRef(new AssistController("full", true));
  const statsRef = useRef<Stats>({ notes: 0, recorded: 0, inferMs: 0, inferHandMs: 0, inferNoHandMs: 0, frames: 0, handFrames: 0, display: null, message: null });
  const tickRef = useRef({ tick: 0, at: 0, playing: false });
  const heldRef = useRef<Held | null>(null);
  const machineRef = useRef<GestureNoteMachine | null>(null);

  // the latest of everything the camera callbacks need (they outlive any one render)
  const live = useRef({ glide, track, clip, musicKey, gridTicks, tempo: project?.tempo ?? 120, loop: project?.loop, songBars: project?.songBars ?? 4, record, range: { low, high: low + 24 } as PitchRange });
  live.current = { glide: glide && track.instrument === "synth", track, clip, musicKey, gridTicks, tempo: project?.tempo ?? 120, loop: project?.loop, songBars: project?.songBars ?? 4, record, range: { low, high: low + 24 } };

  const telemetry = (name: string, data: Record<string, string | number | boolean | null>) => window.daw.telemetry.event(`ui.gesture.${name}`, data);

  // ---- the song position, for placing recorded notes
  useEffect(() => {
    const update = () => {
      const s = statusStore.get();
      if (s) tickRef.current = { tick: s.tick, at: performance.now(), playing: s.playing };
    };
    update();
    return statusStore.subscribe(update);
  }, []);
  const tickNow = (nowMs: number): number | null => {
    const t = tickRef.current;
    if (!t.playing) return null;
    // the status arrives every 33 ms; in between the playhead is estimated, and the song loops, so the estimate wraps like the playhead does
    const estimate = t.tick + ((nowMs - t.at) * live.current.tempo * PPQ) / 60000;
    return wrapPlayhead(estimate, live.current.loop, live.current.songBars * TICKS_PER_BAR);
  };

  // ---- drawing
  const draw = useCallback((frame: HandFrame | null, display: GestureDisplay) => {
    const c = overlayRef.current?.getContext("2d");
    if (c) {
      c.clearRect(0, 0, VIDEO_W, VIDEO_H);
      if (frame) {
        const pts = frame.landmarks.map((p) => ({ x: (1 - p.x) * VIDEO_W, y: p.y * VIDEO_H })); // mirrored, like a mirror
        c.lineWidth = 2;
        c.strokeStyle = display.pinched ? "#fbbf24" : "#34d399";
        c.beginPath();
        for (const [a, b] of BONES) {
          c.moveTo(pts[a]!.x, pts[a]!.y);
          c.lineTo(pts[b]!.x, pts[b]!.y);
        }
        c.stroke();
        c.fillStyle = "#ef4444";
        for (const p of pts) {
          c.beginPath();
          c.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          c.fill();
        }
        if (display.pinched) {
          c.strokeStyle = "#fbbf24";
          c.beginPath();
          c.arc((pts[4]!.x + pts[8]!.x) / 2, (pts[4]!.y + pts[8]!.y) / 2, 10, 0, Math.PI * 2);
          c.stroke();
        }
      }
    }
    const r = rulerRef.current?.getContext("2d");
    if (r) {
      const { range, musicKey: key } = live.current;
      r.clearRect(0, 0, RULER_W, VIDEO_H);
      const yOf = (pitch: number) => VIDEO_H * (0.12 + 0.76 * (1 - (pitch - range.low) / (range.high - range.low)));
      r.font = "9px monospace";
      for (let p = range.low; p <= range.high; p++) {
        const inKey = key ? isInKey(p, key) : true;
        const y = yOf(p);
        r.strokeStyle = inKey ? "rgba(52,211,153,0.9)" : "rgba(148,163,184,0.25)";
        r.beginPath();
        r.moveTo(inKey ? 18 : 28, y);
        r.lineTo(RULER_W - 4, y);
        r.stroke();
        if (inKey && (!key || p % 12 === key.tonic || p === range.low)) {
          r.fillStyle = "#cbd5e1";
          r.fillText(noteName(p, key), 1, y + 3);
        }
      }
      if (display.hand && display.pitchFloat !== null) {
        const y = yOf(display.pitchFloat);
        r.fillStyle = "#e2e8f0"; // where the hand is
        r.beginPath();
        r.moveTo(14, y);
        r.lineTo(4, y - 4);
        r.lineTo(4, y + 4);
        r.fill();
        if (display.result) {
          const bad = display.result.playedInKey === false;
          r.fillStyle = bad ? "#ef4444" : "#34d399"; // what would be played
          r.beginPath();
          r.arc(RULER_W - 8, yOf(display.result.pitch), 5, 0, Math.PI * 2);
          r.fill();
        }
      }
    }
  }, []);

  // ---- notes
  const handleEvent = useCallback((e: GestureNoteEvent, nowMs: number) => {
    const { track: tr, clip: cl } = live.current;
    const stats = statsRef.current;
    if (e.type === "bend") {
      const held = heldRef.current;
      if (!held) return;
      window.daw.previewBend(tr.id, e.semis);
      held.recorder.add(nowMs - held.startMs, e.semis);
      held.maxBend = Math.max(held.maxBend, Math.abs(e.semis));
      return;
    }
    if (e.type === "on") {
      window.daw.preview(tr.id, e.pitch, VELOCITY, true);
      heldRef.current = { recorder: new BendRecorder(), maxBend: 0, pitch: e.pitch, startMs: nowMs, startTick: tickNow(nowMs), rawPitch: e.rawPitch, rawInKey: e.rawInKey, playedInKey: e.playedInKey, snapped: e.snapped, level: e.level };
      stats.notes++;
      const change = controller.current.record(e.rawInKey);
      if (change) {
        telemetry("level", { from: change.from, to: change.to, rate: Math.round(change.rate * 100) / 100, notes: change.notes, auto: true });
        const more = ASSIST_LEVELS.indexOf(change.to) < ASSIST_LEVELS.indexOf(change.from);
        stats.message = `${more ? "More" : "Less"} help: ${ASSIST_LABEL[change.to]}. Your hand was on a scale note ${Math.round(change.rate * 100)}% of the time.`;
      }
      return;
    }
    window.daw.preview(tr.id, e.pitch, VELOCITY, false);
    const held = heldRef.current;
    heldRef.current = null;
    if (!held) return;
    let recorded = false;
    if (live.current.record && held.startTick !== null) {
      const rel = held.startTick - cl.startTick;
      const placed = placeNote(rel, nowMs - held.startMs, live.current.tempo, PPQ, live.current.gridTicks);
      const duration = Math.min(placed.durationTicks, cl.lengthTicks - placed.startTick);
      if (rel >= 0 && placed.startTick < cl.lengthTicks && duration > 0) {
        // the bend was timed from the moment of the pinch; the note starts on the grid, so the curve moves with it
        const curve = live.current.glide ? held.recorder.finish(nowMs - held.startMs, live.current.tempo, PPQ) : undefined;
        const bend = curve ? shiftBend(curve, rel - placed.startTick) : undefined;
        void window.daw.dispatch({ type: "addNote", trackId: tr.id, clipId: cl.id, note: { id: `gesture-${crypto.randomUUID()}`, pitch: held.pitch, startTick: placed.startTick, durationTicks: duration, velocity: VELOCITY, ...(bend ? { bend } : {}) } }, "gesture");
        stats.recorded++;
        recorded = true;
      } else stats.message = "That note was outside this clip, so it was not recorded.";
    }
    telemetry("note", {
      level: held.level,
      raw: held.rawPitch,
      played: held.pitch,
      rawInKey: held.rawInKey,
      playedInKey: held.playedInKey,
      snapped: held.snapped,
      heldMs: Math.round(nowMs - held.startMs),
      recorded,
      glide: live.current.glide,
      bendMax: Math.round(held.maxBend * 100) / 100,
      inferMs: Math.round(stats.inferMs),
    });
  }, []);

  // ---- starting and stopping
  const stop = useCallback(() => {
    const now = performance.now();
    for (const e of machineRef.current?.release(now) ?? []) handleEvent(e, now);
    sourceRef.current?.stop();
    sourceRef.current = null;
    machineRef.current = null;
    setPhase((p) => (p === "idle" || p === "error" ? p : "idle"));
    const s = statsRef.current;
    telemetry("session", { action: "stop", assist: mode, level: controller.current.level, notes: s.notes, recorded: s.recorded });
  }, [handleEvent, mode]);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");
    try {
      const source = await createHandSource();
      const video = videoRef.current;
      if (!video) throw new Error("The camera view is not ready.");
      const machine = new GestureNoteMachine({ range: live.current.range, key: () => live.current.musicKey, level: () => controller.current.level, glide: () => live.current.glide });
      source.subscribe((frame, info) => {
        const now = performance.now();
        const s = statsRef.current;
        s.inferMs = s.inferMs === 0 ? info.inferMs : s.inferMs * 0.9 + info.inferMs * 0.1;
        // frames with a hand being followed are cheaper than frames where the hand has to be found first
        s.frames++;
        if (frame) s.handFrames++;
        if (frame) s.inferHandMs = s.inferHandMs === 0 ? info.inferMs : s.inferHandMs * 0.9 + info.inferMs * 0.1;
        else s.inferNoHandMs = s.inferNoHandMs === 0 ? info.inferMs : s.inferNoHandMs * 0.9 + info.inferMs * 0.1;
        const m = machineRef.current ?? machine;
        const { events, display } = m.update(frame, now);
        s.display = display;
        draw(frame, display);
        for (const e of events) handleEvent(e, now);
      });
      await source.start(video);
      sourceRef.current = source;
      machineRef.current = machine;
      statsRef.current = { notes: 0, recorded: 0, inferMs: 0, inferHandMs: 0, inferNoHandMs: 0, frames: 0, handFrames: 0, display: null, message: null };
      setPhase("running");
      telemetry("session", { action: "start", assist: mode, level: controller.current.level, notes: 0, recorded: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [draw, handleEvent, mode]);

  // a new pitch range needs a fresh note machine (and any held note stops first)
  useEffect(() => {
    if (!machineRef.current) return;
    const now = performance.now();
    for (const e of machineRef.current.release(now)) handleEvent(e, now);
    machineRef.current = new GestureNoteMachine({ range: live.current.range, key: () => live.current.musicKey, level: () => controller.current.level, glide: () => live.current.glide });
  }, [low, handleEvent]);

  // leaving the panel always turns the camera off and lets go of any note
  useEffect(() => () => {
    const now = performance.now();
    for (const e of machineRef.current?.release(now) ?? []) handleEvent(e, now);
    sourceRef.current?.stop();
    sourceRef.current = null;
  }, [handleEvent]);

  // the text under the picture, a few times a second
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => force((n) => n + 1), 150);
    return () => clearInterval(id);
  }, [phase]);

  const chooseMode = (m: Mode) => {
    setMode(m);
    if (m === "auto") controller.current.setLevel(controller.current.level, true);
    else controller.current.setLevel(m, false);
    statsRef.current.message = null;
    telemetry("mode", { assist: m, level: controller.current.level });
  };

  const level = controller.current.level;
  const rate = controller.current.rate;
  const recentNotes = Math.min(statsRef.current.notes, ADAPT_WINDOW);
  const display = statsRef.current.display;
  const key = musicKey;
  const status = useMemo(() => (phase === "running" ? (display?.hand ? (display.pinched ? "pinched: playing" : "hand seen: pinch to play") : "show your hand to the camera") : ""), [phase, display?.hand, display?.pinched]);

  return createPortal(
    <div className="hw-popover fixed right-4 bottom-4 z-[70] flex w-[432px] flex-col gap-2 p-2.5 text-[11px] text-slate-300" data-testid="gesture-panel" role="dialog" aria-label="Hand play">
      <div className="flex items-center gap-2">
        <span className="hw-legend !text-[11px] font-semibold !text-slate-200">HAND PLAY</span>
        <span className="min-w-0 flex-1 truncate text-slate-500">{track.name}</span>
        <button className="hw-btn h-6 w-6 text-[12px]" onClick={() => { stop(); onClose(); }} aria-label="Close hand play" data-testid="gesture-close">×</button>
      </div>

      <div className="flex gap-1.5">
        <div className="relative shrink-0 overflow-hidden rounded border border-black bg-black" style={{ width: VIDEO_W, height: VIDEO_H }}>
          <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} muted playsInline data-testid="gesture-video" />
          <canvas ref={overlayRef} width={VIDEO_W} height={VIDEO_H} className="absolute inset-0" />
          {phase !== "running" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-3 text-center text-slate-300">
              {phase === "starting" ? "Starting the camera…" : "The camera is off."}
              <span className="text-[10px] text-slate-500">The picture is processed on this computer only. It is not saved or sent anywhere.</span>
            </div>
          )}
        </div>
        <canvas ref={rulerRef} width={RULER_W} height={VIDEO_H} className="rounded border border-black bg-[#10141b]" aria-label="Pitch ruler" data-testid="gesture-ruler" />
      </div>

      {error && <div className="rounded border border-red-500/40 bg-red-950/30 px-2 py-1 text-red-200" data-testid="gesture-error">{error}</div>}

      <div className="flex items-center gap-1.5">
        {phase === "running" ? (
          <button className="hw-btn px-2 py-1" onClick={stop} data-testid="gesture-stop">Stop camera</button>
        ) : (
          <button className="hw-btn hw-teal px-2 py-1" disabled={phase === "starting"} onClick={() => void start()} data-testid="gesture-start">Start camera</button>
        )}
        <button className="hw-btn px-2 py-1" aria-pressed={record} onClick={() => setRecord(!record)} title="Put the notes you play into this clip while the song plays" data-testid="gesture-record">{record ? "Recording: on" : "Record: off"}</button>
        <button
          className="hw-btn px-2 py-1"
          aria-pressed={glide && track.instrument === "synth"}
          disabled={track.instrument !== "synth"}
          onClick={() => { setGlide(!glide); telemetry("glide", { on: !glide }); }}
          title={track.instrument === "synth" ? "While you hold a pinch, the pitch follows your hand smoothly (pitch bend). The glide is recorded with the note." : "Gliding works with the built-in synth only: a plugin's bend range is its own"}
          data-testid="gesture-glide"
        >
          {glide && track.instrument === "synth" ? "Glide: on" : "Glide: off"}
        </button>
        <span className="flex items-center gap-1" title="Move the range the hand covers by an octave">
          <button className="hw-btn h-6 w-6" onClick={() => setLow((v) => Math.max(24, v - 12))} aria-label="Lower by an octave" data-testid="gesture-oct-down">◀</button>
          <span className="w-[74px] text-center font-mono text-[10px] text-slate-400" data-testid="gesture-range">{noteName(low, key)}{octaveOf(low)}–{noteName(low + 24, key)}{octaveOf(low + 24)}</span>
          <button className="hw-btn h-6 w-6" onClick={() => setLow((v) => Math.min(84, v + 12))} aria-label="Raise by an octave" data-testid="gesture-oct-up">▶</button>
        </span>
      </div>

      <label className="flex items-center justify-between gap-2">
        <span className="text-slate-400">Help from the key</span>
        <select value={mode} onChange={(e) => chooseMode(e.target.value as Mode)} className="hw-lcd px-1 py-0.5 text-[11px] outline-none" data-testid="gesture-level" aria-label="Help from the key">
          <option value="auto" className="bg-[#12151c]">Automatic: fades as you improve</option>
          {ASSIST_LEVELS.map((l) => <option key={l} value={l} className="bg-[#12151c]">{ASSIST_LABEL[l]} (fixed)</option>)}
        </select>
      </label>

      <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5" data-testid="gesture-status" data-level={level} data-phase={phase} data-notes={statsRef.current.notes} data-recorded={statsRef.current.recorded} data-glide={live.current.glide ? "on" : "off"} data-hand={display?.hand ? "yes" : "no"} data-pinched={display?.pinched ? "yes" : "no"} data-infer-ms={Math.round(statsRef.current.inferMs)} data-infer-hand-ms={Math.round(statsRef.current.inferHandMs)} data-infer-nohand-ms={Math.round(statsRef.current.inferNoHandMs)} data-delegate={sourceRef.current?.delegate ?? ""} data-frames={statsRef.current.frames} data-hand-frames={statsRef.current.handFrames}>
        <div className="flex items-baseline justify-between">
          <span><b className="text-slate-100" data-testid="gesture-level-badge">{ASSIST_LABEL[level]}</b>{mode === "auto" ? " (automatic)" : " (fixed)"}</span>
          <span className="text-slate-500" data-testid="gesture-hand-state">{status}{display?.bend != null ? ` · bend ${display.bend >= 0 ? "+" : ""}${display.bend.toFixed(1)}` : ""}</span>
        </div>
        <div className="text-slate-400">{ASSIST_DESCRIPTION[level]}</div>
        {key ? (
          <div className="text-slate-500" data-testid="gesture-key">Key: {keyLabel(key)}. Green marks are notes of the scale.</div>
        ) : (
          <div className="text-amber-300" data-testid="gesture-key">No key is set, so there is nothing for the help to follow. Choose the song's key to get scale help.</div>
        )}
        {rate !== null && (
          <div className="text-slate-400" data-testid="gesture-accuracy">
            Without any help, your hand was on a scale note {Math.round(rate * recentNotes)} of the last {recentNotes} times.
          </div>
        )}
        {statsRef.current.message && <div className="text-sky-300" data-testid="gesture-message">{statsRef.current.message}</div>}
        {phase === "running" && <div className="text-[9px] text-slate-600" data-testid="gesture-latency">Tracking takes about {Math.round(statsRef.current.inferMs)} ms a frame{sourceRef.current && sourceRef.current.delegate !== "test" ? ` (on the ${sourceRef.current.delegate === "GPU" ? "graphics card" : "processor"})` : ""}.</div>}
      </div>
    </div>,
    document.body,
  );
}
