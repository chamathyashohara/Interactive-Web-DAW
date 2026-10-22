import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PPQ, TICKS_PER_BAR, isInKey, isTonic, keyLabel, outOfKeyMessage, type Clip, type Note, type NoteFields, type OpBody, type ProjectKey, type Track } from "@daw/shared";
import { LockIcon } from "../unlock/LockIcon";
import { useUnlock } from "../unlock/useUnlock";
import { statusStore, useStore } from "../store";
import { PianoKeys } from "./PianoKeys";
import { WindowButtons } from "./WindowButtons";
import { StepSequencer } from "./StepSequencer";
import { VelocityRamp } from "./VelocityRamp";
import { clampGroupMove, copyNotes, deleteOps, duplicateOps, fixOutOfKeyOps, pasteOps, quantizeOps, sliceOps, toggleMuteOps, type NoteClip } from "./editing";
import {
  KEYS_W,
  MAX_PX_PER_BEAT,
  MIN_PX_PER_BEAT,
  PITCH_MAX,
  PITCH_MIN,
  clamp,
  isBlackKey,
  pitchLabel,
  pitchToY,
  pxToTick,
  snapTick,
  tickToPx,
  yToPitch,
} from "./geometry";

export type Tool = "draw" | "paint" | "select" | "delete" | "mute" | "slice";

interface Props {
  track: Track;
  clip: Clip;
  /** Keyboard shortcuts (tools, copy/paste, delete...) only react while this panel has focus. */
  keysEnabled: boolean;
  tool: Tool;
  snap: boolean;
  gridTicks: number;
  pxPerBeat: number;
  /** Horizontal zoom (ctrl + middle mouse sweep). */
  onZoom: (pxPerBeat: number) => void;
  rowH: number;
  onTool: (t: Tool) => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
  /** The project's key (null = none). Drives scale highlighting and the red out-of-key notes. */
  musicKey: ProjectKey | null;
  keyHelp: boolean;
  onToggleKeyHelp: () => void;
}

type Drag =
  | { kind: "draw"; startTick: number; pitch: number; duration: number }
  | { kind: "paint"; pitch: number; cells: Map<string, { tick: number; pitch: number }> }
  | { kind: "move"; ids: Set<string>; grabId: string; grabTick: number; grabY: number; dTick: number; dPitch: number }
  | { kind: "resize"; ids: Set<string>; grabId: string; dDur: number }
  | { kind: "velocity"; id: string; velocity: number }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: "erase"; ids: Set<string>; lx: number; ly: number };

const RULER_H = 26;
const EDIT_H = 30;
const VEL_H = 72;
const RESIZE_PX = 8;
const PITCHES = Array.from({ length: PITCH_MAX - PITCH_MIN + 1 }, (_, i) => PITCH_MAX - i);

/** Notes copied with Copy; shared across tracks so a pattern can be pasted into another track. */
let clipboard: Note[] = [];

const Playhead = memo(function Playhead({ pxPerBeat, clipStart, clipLength }: { pxPerBeat: number; clipStart: number; clipLength: number }) {
  const status = useStore(statusStore);
  const rel = (status?.tick ?? 0) - clipStart; // the playhead is absolute song time; the roll shows one clip
  if (rel < 0 || rel > clipLength) return null;
  const x = KEYS_W + tickToPx(rel, pxPerBeat);
  return <div className="pointer-events-none absolute top-0 bottom-0 z-[25] w-px bg-amber-300" style={{ left: x, boxShadow: "0 0 6px rgba(252,211,77,.7)" }} />;
});

const btn = "hw-btn px-2 py-0.5 text-[11px]";

export function PianoRoll({ track, clip, keysEnabled, tool, snap, gridTicks, pxPerBeat, onZoom, rowH, onTool, maximized, onToggleMaximize, onClose, musicKey, keyHelp, onToggleKeyHelp }: Props) {
  const clipId = clip.id;
  const noteClip: NoteClip = { trackId: track.id, clipId, lengthTicks: clip.lengthTicks };
  const notes = useMemo(() => Object.values(clip.notes), [clip.notes]);
  const gridW = tickToPx(clip.lengthTicks, pxPerBeat);
  const gridH = PITCHES.length * rowH;
  const isDrums = track.instrument === "drums";
  const unlock = useUnlock();
  // Drum clips open in the step sequencer; the roll is one click away.
  const [drumView, setDrumView] = useState<"steps" | "roll">("steps");
  const showSteps = isDrums && unlock.can("seq.steps") && drumView === "steps";
  // Key help applies to melodic tracks only (drum rows are instruments, not pitches) and only once its lesson is done.
  const keyHelpAvailable = !isDrums && musicKey !== null && unlock.can("key.help");
  const hint = keyHelpAvailable && keyHelp ? musicKey : null;
  const badNotes = hint ? notes.filter((n) => !isInKey(n.pitch, hint)) : [];

  const gridRef = useRef<HTMLDivElement>(null);
  const velRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastDuration = useRef(PPQ / 2);
  const zoomDrag = useRef<{ x0: number; zoom0: number; anchorTick: number; viewX: number } | null>(null);
  const anchor = useRef<{ tick: number; viewX: number } | null>(null);
  const setDrag = useCallback((d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  }, []);

  // Drop selection entries whose notes no longer exist (undo, delete elsewhere).
  const liveSelected = useMemo(() => new Set([...selected].filter((id) => clip.notes[id])), [selected, clip.notes]);
  const selectedNotes = notes.filter((n) => liveSelected.has(n.id));

  const batch = (ops: OpBody[], group?: string) => {
    if (ops.length) void window.daw.dispatchBatch(ops, group);
  };
  const minDur = snap ? gridTicks : 30;

  // When a track opens, centre the view on its notes (or a sensible default: drum rows / middle C).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pitches = Object.values(clip.notes).map((n) => n.pitch);
    const center = pitches.length ? Math.round(pitches.reduce((a, b) => a + b, 0) / pitches.length) : isDrums ? 42 : 66;
    el.scrollTop = Math.max(0, pitchToY(center, rowH) + RULER_H - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, clip.id]);

  // After a zoom, keep the moment under the cursor where it was.
  useLayoutEffect(() => {
    const a = anchor.current, el = scrollRef.current;
    if (!a || !el) return;
    anchor.current = null;
    el.scrollLeft = Math.max(0, KEYS_W + tickToPx(a.tick, pxPerBeat) - a.viewX);
  }, [pxPerBeat]);

  // ---- horizontal zoom: hold Ctrl, press the middle mouse button and sweep left/right ----
  const onZoomDown = (e: React.PointerEvent) => {
    if (e.button !== 1 || !e.ctrlKey) return;
    e.preventDefault();
    const el = scrollRef.current!;
    const viewX = e.clientX - el.getBoundingClientRect().left;
    zoomDrag.current = { x0: e.clientX, zoom0: pxPerBeat, anchorTick: pxToTick(el.scrollLeft + viewX - KEYS_W, pxPerBeat), viewX };
    el.setPointerCapture(e.pointerId);
  };
  const onZoomMove = (e: React.PointerEvent) => {
    const z = zoomDrag.current;
    if (!z) return;
    const next = Math.round(clamp(z.zoom0 * Math.exp((e.clientX - z.x0) / 150), MIN_PX_PER_BEAT, MAX_PX_PER_BEAT));
    if (next === pxPerBeat) return;
    anchor.current = { tick: Math.max(0, z.anchorTick), viewX: z.viewX };
    onZoom(next);
  };
  const onZoomUp = () => {
    zoomDrag.current = null;
  };

  // ---- editing commands (buttons + shortcuts) ----
  const targets = () => (selectedNotes.length ? selectedNotes : notes);
  const cmdCopy = () => {
    if (!unlock.can("edit.clipboard")) return;
    if (selectedNotes.length) clipboard = copyNotes(selectedNotes);
  };
  const cmdPaste = () => {
    if (!unlock.can("edit.clipboard")) return;
    if (!clipboard.length) return;
    const rel = (statusStore.get()?.tick ?? 0) - clip.startTick;
    const at = rel >= 0 && rel < clip.lengthTicks ? snapTick(rel, gridTicks, snap, "floor") : 0; // playhead outside this clip: paste at its start
    const ids: string[] = [];
    batch(pasteOps(noteClip, clipboard, at, () => (ids.push(crypto.randomUUID()), ids[ids.length - 1]!)));
    setSelected(new Set(ids));
  };
  const cmdDuplicate = () => {
    if (!unlock.can("edit.clipboard")) return;
    const ids: string[] = [];
    batch(duplicateOps(noteClip, selectedNotes, gridTicks, () => (ids.push(crypto.randomUUID()), ids[ids.length - 1]!)));
    if (ids.length) setSelected(new Set(ids));
  };
  const cmdQuantize = () => {
    if (unlock.can("edit.quantize")) batch(quantizeOps(noteClip, targets(), gridTicks));
  };
  const cmdFixKey = () => {
    if (hint) {
      window.daw.telemetry.event("ui.fix", {});
      batch(fixOutOfKeyOps(noteClip, notes, hint));
    }
  };
  const cmdDelete = () => {
    batch(deleteOps(noteClip, [...liveSelected]));
    setSelected(new Set());
  };
  const cmdSelectAll = () => {
    if (unlock.can("tool.select")) setSelected(new Set(notes.map((n) => n.id)));
  };

  useEffect(() => {
    if (!keysEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === "a") (e.preventDefault(), cmdSelectAll());
        else if (k === "c") (e.preventDefault(), cmdCopy());
        else if (k === "v") (e.preventDefault(), cmdPaste());
        else if (k === "d") (e.preventDefault(), cmdDuplicate());
        return;
      }
      if (e.altKey) return;
      if (k === "d") onTool("draw");
      else if (k === "p") onTool("paint");
      else if (k === "s") onTool("select");
      else if (k === "e") onTool("delete");
      else if (k === "m") onTool("mute");
      else if (k === "c") onTool("slice");
      else if (k === "q") cmdQuantize();
      else if ((k === "delete" || k === "backspace") && liveSelected.size) cmdDelete();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const gridPoint = (e: React.PointerEvent) => {
    const rect = gridRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const noteRect = (n: Note) => ({
    x0: tickToPx(n.startTick, pxPerBeat),
    x1: tickToPx(n.startTick + n.durationTicks, pxPerBeat),
    y0: pitchToY(n.pitch, rowH),
    y1: pitchToY(n.pitch, rowH) + rowH,
  });
  const noteAt = (x: number, y: number) => notes.find((n) => {
    const r = noteRect(n);
    return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  });

  // ---- grid pointer handling ----
  const onGridPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    const { x, y } = gridPoint(e);
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-note-id]");
    const note = hit ? clip.notes[hit.dataset.noteId!] : undefined;
    const capture = () => gridRef.current!.setPointerCapture(e.pointerId);

    if (e.button === 2 || tool === "delete") {
      // hold the right button (or use the eraser) and sweep over notes to delete them all at once
      capture();
      setDrag({ kind: "erase", ids: new Set(note ? [note.id] : []), lx: x, ly: y });
      return;
    }
    if (note) lastDuration.current = note.durationTicks; // the next note drawn gets the width of the one just clicked
    if (tool === "mute") {
      if (note) batch(toggleMuteOps(noteClip, liveSelected.has(note.id) ? selectedNotes : [note]));
      return;
    }
    if (tool === "slice") {
      if (note) {
        const at = snapTick(pxToTick(x, pxPerBeat), gridTicks, snap, "round");
        const ids: string[] = [];
        const ops = sliceOps(noteClip, note, at, () => (ids.push(crypto.randomUUID()), ids[ids.length - 1]!));
        if (ops) {
          batch(ops);
          setSelected(new Set(ids));
        }
      }
      return;
    }

    if (note && !unlock.can("tool.select")) {
      // Until the select lesson is done, clicking a note only plays it.
      window.daw.preview(track.id, note.pitch, note.velocity, true);
      setTimeout(() => window.daw.preview(track.id, note.pitch, note.velocity, false), 250);
      return;
    }
    if (note) {
      // select / draw / paint on an existing note: select it and start moving or resizing the group
      let ids = liveSelected;
      if (e.shiftKey) {
        ids = new Set(liveSelected);
        if (ids.has(note.id)) ids.delete(note.id);
        else ids.add(note.id);
        setSelected(ids);
        if (!ids.has(note.id)) return;
      } else if (!liveSelected.has(note.id)) {
        ids = new Set([note.id]);
        setSelected(ids);
      }
      capture();
      window.daw.preview(track.id, note.pitch, note.velocity, true);
      const noteRight = tickToPx(note.startTick + note.durationTicks, pxPerBeat);
      if (x >= noteRight - RESIZE_PX) setDrag({ kind: "resize", ids, grabId: note.id, dDur: 0 });
      else setDrag({ kind: "move", ids, grabId: note.id, grabTick: pxToTick(x, pxPerBeat), grabY: y, dTick: 0, dPitch: 0 });
      return;
    }

    if (tool === "select") {
      capture();
      setDrag({ kind: "marquee", x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey });
      return;
    }

    const pitch = yToPitch(y, rowH);
    const startTick = clamp(snapTick(pxToTick(x, pxPerBeat), gridTicks, snap, "floor"), 0, clip.lengthTicks - 1);
    capture();
    window.daw.preview(track.id, pitch, 96, true);
    setSelected(new Set());
    if (tool === "paint") setDrag({ kind: "paint", pitch, cells: new Map([[`${startTick}:${pitch}`, { tick: startTick, pitch }]]) });
    else setDrag({ kind: "draw", startTick, pitch, duration: Math.max(minDur, lastDuration.current) });
  };

  const onGridPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const { x, y } = gridPoint(e);
    const tick = pxToTick(x, pxPerBeat);

    if (d.kind === "draw") {
      const end = snapTick(tick, gridTicks, snap, "round");
      const dur = Math.max(minDur, end - d.startTick);
      if (dur !== d.duration && end > d.startTick) setDrag({ ...d, duration: dur });
    } else if (d.kind === "paint") {
      const cell = clamp(snapTick(tick, gridTicks, snap, "floor"), 0, clip.lengthTicks - 1);
      const pitch = yToPitch(y, rowH);
      const key = `${cell}:${pitch}`;
      if (!d.cells.has(key)) {
        const cells = new Map(d.cells);
        cells.set(key, { tick: cell, pitch });
        setDrag({ ...d, cells });
      }
    } else if (d.kind === "resize") {
      const grabbed = clip.notes[d.grabId];
      if (!grabbed) return;
      const end = snapTick(tick, gridTicks, snap, "round");
      const dDur = end - (grabbed.startTick + grabbed.durationTicks);
      if (dDur !== d.dDur) setDrag({ ...d, dDur });
    } else if (d.kind === "move") {
      const group = notes.filter((n) => d.ids.has(n.id));
      const grabbed = clip.notes[d.grabId];
      if (!grabbed || !group.length) return;
      const wantStart = snapTick(grabbed.startTick + (tick - d.grabTick), gridTicks, snap, "round");
      const raw = clampGroupMove(group, wantStart - grabbed.startTick, -Math.round((y - d.grabY) / rowH), clip.lengthTicks, PITCH_MIN, PITCH_MAX);
      if (raw.dTick !== d.dTick || raw.dPitch !== d.dPitch) {
        if (raw.dPitch !== d.dPitch) {
          window.daw.preview(track.id, grabbed.pitch + d.dPitch, grabbed.velocity, false);
          window.daw.preview(track.id, grabbed.pitch + raw.dPitch, grabbed.velocity, true);
        }
        setDrag({ ...d, dTick: raw.dTick, dPitch: raw.dPitch });
      }
    } else if (d.kind === "marquee") {
      setDrag({ ...d, x1: x, y1: y });
    } else if (d.kind === "erase") {
      // check along the whole path since the last event, so a fast sweep cannot skip a note
      const steps = Math.max(1, Math.ceil(Math.hypot(x - d.lx, y - d.ly) / 4));
      let ids = d.ids;
      for (let i = 1; i <= steps; i++) {
        const n = noteAt(d.lx + ((x - d.lx) * i) / steps, d.ly + ((y - d.ly) * i) / steps);
        if (n && !ids.has(n.id)) ids = new Set([...ids, n.id]);
      }
      setDrag({ ...d, ids, lx: x, ly: y });
    }
  };

  const onGridPointerUp = () => {
    const d = dragRef.current;
    if (!d || d.kind === "velocity") return;
    setDrag(null);

    if (d.kind === "draw") {
      window.daw.preview(track.id, d.pitch, 96, false);
      const dur = clamp(d.duration, 1, clip.lengthTicks - d.startTick);
      lastDuration.current = dur;
      const id = crypto.randomUUID();
      batch([{ type: "addNote", trackId: track.id, clipId, note: { id, pitch: d.pitch, startTick: d.startTick, durationTicks: dur, velocity: 96 } }]);
      setSelected(new Set([id]));
    } else if (d.kind === "paint") {
      window.daw.preview(track.id, d.pitch, 96, false);
      const step = snap ? gridTicks : 240;
      const occupied = new Set(notes.map((n) => `${n.startTick}:${n.pitch}`));
      const ops: OpBody[] = [];
      for (const c of d.cells.values()) {
        if (occupied.has(`${c.tick}:${c.pitch}`)) continue;
        const dur = Math.min(step, clip.lengthTicks - c.tick);
        if (dur < 1) continue;
        ops.push({ type: "addNote", trackId: track.id, clipId, note: { id: crypto.randomUUID(), pitch: c.pitch, startTick: c.tick, durationTicks: dur, velocity: 96 } });
      }
      batch(ops);
    } else if (d.kind === "move") {
      const grabbed = clip.notes[d.grabId];
      if (grabbed) window.daw.preview(track.id, grabbed.pitch + d.dPitch, grabbed.velocity, false);
      const ops: OpBody[] = [];
      for (const n of notes) {
        if (!d.ids.has(n.id) || (d.dTick === 0 && d.dPitch === 0)) continue;
        const changes: Partial<NoteFields> = {};
        if (d.dTick) changes.startTick = n.startTick + d.dTick;
        if (d.dPitch) changes.pitch = n.pitch + d.dPitch;
        ops.push({ type: "updateNote", trackId: track.id, clipId, noteId: n.id, changes });
      }
      batch(ops);
    } else if (d.kind === "resize") {
      const grabbed = clip.notes[d.grabId];
      if (grabbed) window.daw.preview(track.id, grabbed.pitch, grabbed.velocity, false);
      const ops: OpBody[] = [];
      for (const n of notes) {
        if (!d.ids.has(n.id) || d.dDur === 0) continue;
        const dur = clamp(n.durationTicks + d.dDur, minDur, clip.lengthTicks - n.startTick);
        if (dur !== n.durationTicks) ops.push({ type: "updateNote", trackId: track.id, clipId, noteId: n.id, changes: { durationTicks: dur } });
        if (n.id === d.grabId) lastDuration.current = dur;
      }
      batch(ops);
    } else if (d.kind === "marquee") {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (x1 - x0 < 4 && y1 - y0 < 4) {
        if (!d.additive) setSelected(new Set());
        return;
      }
      const inside = notes.filter((n) => {
        const r = noteRect(n);
        return r.x1 >= x0 && r.x0 <= x1 && r.y1 >= y0 && r.y0 <= y1;
      });
      setSelected(new Set([...(d.additive ? liveSelected : []), ...inside.map((n) => n.id)]));
    } else if (d.kind === "erase") {
      if (d.ids.size) {
        batch(deleteOps(noteClip, [...d.ids]));
        setSelected(new Set());
      }
    }
  };

  const onContextMenu = (e: React.MouseEvent) => e.preventDefault(); // right button = sweep-delete, handled on pointer down/up

  // ---- velocity lane ----
  const velFromEvent = (e: React.PointerEvent) => {
    const rect = velRef.current!.getBoundingClientRect();
    return clamp(Math.round(((rect.bottom - e.clientY) / VEL_H) * 127), 1, 127);
  };
  const onVelDown = (e: React.PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-vel-id]");
    if (!el || e.button !== 0) return;
    const id = el.dataset.velId!;
    velRef.current!.setPointerCapture(e.pointerId);
    setSelected(new Set([id]));
    setDrag({ kind: "velocity", id, velocity: velFromEvent(e) });
  };
  const onVelMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d?.kind === "velocity") setDrag({ ...d, velocity: velFromEvent(e) });
  };
  const onVelUp = () => {
    const d = dragRef.current;
    if (d?.kind !== "velocity") return;
    setDrag(null);
    if (clip.notes[d.id] && clip.notes[d.id]!.velocity !== d.velocity) {
      batch([{ type: "updateNote", trackId: track.id, clipId, noteId: d.id, changes: { velocity: d.velocity } }]);
    }
  };

  // ---- derived view of each note while dragging ----
  const view = (n: Note): Note => {
    if (drag?.kind === "move" && drag.ids.has(n.id)) return { ...n, startTick: n.startTick + drag.dTick, pitch: n.pitch + drag.dPitch };
    if (drag?.kind === "resize" && drag.ids.has(n.id)) return { ...n, durationTicks: clamp(n.durationTicks + drag.dDur, minDur, clip.lengthTicks - n.startTick) };
    if (drag?.kind === "velocity" && drag.id === n.id) return { ...n, velocity: drag.velocity };
    return n;
  };

  const beatPx = tickToPx(PPQ, pxPerBeat);
  const barPx = tickToPx(TICKS_PER_BAR, pxPerBeat);
  const gridPx = tickToPx(gridTicks, pxPerBeat);
  const bars = Math.ceil(clip.lengthTicks / TICKS_PER_BAR);
  const cursor = { draw: "cell", paint: "cell", select: "default", delete: "not-allowed", mute: "pointer", slice: "col-resize" }[tool];
  const lines = (alpha: number, step: number) => `repeating-linear-gradient(to right, rgba(255,255,255,${alpha}) 0 1px, transparent 1px ${step}px)`;
  const stepTicks = snap ? gridTicks : 240;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Edit strip */}
      <div className="hw-panel flex items-center gap-1.5 border-b border-black px-3" style={{ height: EDIT_H }} data-testid="edit-strip">
        <span className="mr-1 flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: track.color }} />
          {track.name}
          <span className="text-slate-600">· {isDrums ? "Drums" : "Synth"} · {clip.name ?? "Clip"}</span>
        </span>
        {isDrums && (
          <span className="flex gap-1" role="group" aria-label="Drum view">
            <button className={`${btn} hw-teal`} aria-pressed={showSteps} disabled={!unlock.can("seq.steps")} onClick={() => (window.daw.telemetry.event("ui.view", { view: "steps" }), setDrumView("steps"))} title={unlock.reason("seq.steps") ?? "Step sequencer: place drum hits on pads"} data-testid="view-steps">Steps{!unlock.can("seq.steps") && <LockIcon className="ml-1" />}</button>
            <button className={`${btn} hw-teal`} aria-pressed={!showSteps} onClick={() => (window.daw.telemetry.event("ui.view", { view: "roll" }), setDrumView("roll"))} title="Piano roll: every note on a grid" data-testid="view-roll">Roll</button>
          </span>
        )}
        {!showSteps && (
          <>
        <button className={btn} disabled={!unlock.can("tool.select")} onClick={cmdSelectAll} title={unlock.reason("tool.select") ?? "Select all (Ctrl+A)"}>Select all{!unlock.can("tool.select") && <LockIcon className="ml-1" />}</button>
        <button className={btn} disabled={!liveSelected.size || !unlock.can("edit.clipboard")} onClick={cmdCopy} title={unlock.reason("edit.clipboard") ?? "Copy (Ctrl+C)"}>Copy{!unlock.can("edit.clipboard") && <LockIcon className="ml-1" />}</button>
        <button className={btn} disabled={!unlock.can("edit.clipboard")} onClick={cmdPaste} title={unlock.reason("edit.clipboard") ?? "Paste at the playhead (Ctrl+V)"}>Paste{!unlock.can("edit.clipboard") && <LockIcon className="ml-1" />}</button>
        <button className={btn} disabled={!liveSelected.size || !unlock.can("edit.clipboard")} onClick={cmdDuplicate} title={unlock.reason("edit.clipboard") ?? "Duplicate after the selection (Ctrl+D)"}>Duplicate{!unlock.can("edit.clipboard") && <LockIcon className="ml-1" />}</button>
        <button className={btn} disabled={!notes.length || !unlock.can("edit.quantize")} onClick={cmdQuantize} title={unlock.reason("edit.quantize") ?? "Quantize selected notes (or all) to the grid (Q)"}>Quantize{!unlock.can("edit.quantize") && <LockIcon className="ml-1" />}</button>
        <button className={btn} disabled={!liveSelected.size} onClick={cmdDelete} title="Delete selected (Delete)">Delete</button>
            <VelocityRamp clip={noteClip} notes={targets()} scope={selectedNotes.length ? "the selected notes" : "all the notes in this clip"} disabled={!unlock.can("velocity.ramp")} lockTitle={unlock.reason("velocity.ramp")} className={btn} />
          </>
        )}
        {keyHelpAvailable && (
          <button className={`${btn} hw-teal`} onClick={onToggleKeyHelp} aria-pressed={keyHelp} title="Show or hide the key help (highlighted scale notes and red out-of-key notes)" data-testid="key-help-toggle">
            Key: {keyLabel(musicKey!)}
          </button>
        )}
        {badNotes.length > 0 && hint && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-red-300" data-testid="key-warning" title={outOfKeyMessage(badNotes[0]!.pitch, hint)}>
            <span className="truncate">⚠ {badNotes.length} note{badNotes.length === 1 ? "" : "s"} outside {keyLabel(hint)}. {outOfKeyMessage(badNotes[0]!.pitch, hint)}</span>
            <button className={`${btn} hw-red`} onClick={cmdFixKey} data-testid="key-fix" title="Move each red note to the nearest note in the key">Fix</button>
          </span>
        )}
        <span className="ml-auto text-[11px] text-slate-500" data-testid="selection-count">{liveSelected.size ? `${liveSelected.size} selected` : `${notes.length} notes`}</span>
        <WindowButtons maximized={maximized} onToggleMaximize={onToggleMaximize} onClose={onClose} />
      </div>

      {showSteps ? (
        <StepSequencer track={track} clip={clip} rampLocked={!unlock.can("velocity.ramp")} rampLockTitle={unlock.reason("velocity.ramp")} />
      ) : (
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto bg-[#0b0e14]"
        data-testid="piano-roll-scroll"
        onPointerDown={onZoomDown}
        onPointerMove={onZoomMove}
        onPointerUp={onZoomUp}
        onPointerCancel={onZoomUp}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      >
        <div className="relative" style={{ width: KEYS_W + gridW, minHeight: "100%" }}>
          <Playhead pxPerBeat={pxPerBeat} clipStart={clip.startTick} clipLength={clip.lengthTicks} />

          {/* Ruler */}
          <div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-40 shrink-0 border-r border-b border-white/10 bg-[#161a23]" style={{ width: KEYS_W }} />
            <div
              className="relative border-b border-white/10 bg-[#161a23]"
              style={{ width: gridW }}
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                window.daw.seek(clip.startTick + clamp(snapTick(pxToTick(e.clientX - rect.left, pxPerBeat), PPQ, true, "round"), 0, clip.lengthTicks - 1));
              }}
            >
              {Array.from({ length: bars }, (_, b) => (
                <div key={b} className="absolute top-0 h-full border-l border-white/30 pl-1 text-[10px] leading-[22px] text-slate-300" style={{ left: b * barPx }}>
                  {Math.floor(clip.startTick / TICKS_PER_BAR) + b + 1}
                </div>
              ))}
              {Array.from({ length: bars * 4 }, (_, i) => (i % 4 === 0 ? null : <div key={i} className="absolute bottom-0 h-1.5 border-l border-white/20" style={{ left: i * beatPx }} />))}
              <div className="absolute right-0 bottom-0 left-0 h-[3px]" style={{ background: track.color, opacity: 0.6 }} title="Loop region" />
            </div>
          </div>

          {/* Keys + grid */}
          <div className="flex">
            <div className="sticky left-0 z-20 shrink-0 border-r border-black/60" style={{ width: KEYS_W, height: gridH }}>
              <PianoKeys trackId={track.id} isDrums={isDrums} rowH={rowH} musicKey={hint} />
            </div>

            <div
              ref={gridRef}
              className="relative"
              style={{ width: gridW, height: gridH, cursor, touchAction: "none" }}
              onPointerDown={onGridPointerDown}
              onPointerMove={onGridPointerMove}
              onPointerUp={onGridPointerUp}
              onPointerCancel={onGridPointerUp}
              onContextMenu={onContextMenu}
              data-testid="grid"
            >
              {PITCHES.map((p) => (
                <div
                  key={p}
                  className={`absolute right-0 left-0 border-b ${isBlackKey(p) ? "border-white/[0.03] bg-[#0d1017]" : "border-white/[0.05] bg-[#131824]"} ${p % 12 === 0 ? "!border-white/15" : ""}`}
                  data-in-key={hint ? (isTonic(p, hint) ? "root" : isInKey(p, hint) ? "true" : "false") : undefined}
                  style={{
                    top: pitchToY(p, rowH),
                    height: rowH,
                    // key help: the root row glows, other scale rows are lit, rows outside the key are dimmed
                    ...(hint ? { backgroundColor: isTonic(p, hint) ? "rgba(34,211,238,0.16)" : isInKey(p, hint) ? "#16202c" : "#07090d" } : {}),
                  }}
                />
              ))}
              <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: [lines(0.3, barPx), lines(0.13, beatPx), lines(0.05, gridPx)].join(",") }} />

              {drag?.kind === "draw" && (
                <div
                  className="pointer-events-none absolute rounded-[3px] border border-white/60"
                  style={{ left: tickToPx(drag.startTick, pxPerBeat), top: pitchToY(drag.pitch, rowH) + 1, width: tickToPx(drag.duration, pxPerBeat), height: rowH - 2, background: track.color, opacity: 0.45 }}
                />
              )}
              {drag?.kind === "paint" &&
                [...drag.cells.values()].map((c) => (
                  <div
                    key={`${c.tick}:${c.pitch}`}
                    className="pointer-events-none absolute rounded-[3px] border border-white/60"
                    style={{ left: tickToPx(c.tick, pxPerBeat), top: pitchToY(c.pitch, rowH) + 1, width: Math.max(4, tickToPx(stepTicks, pxPerBeat) - 1), height: rowH - 2, background: track.color, opacity: 0.45 }}
                  />
                ))}
              {drag?.kind === "marquee" && (
                <div
                  className="pointer-events-none absolute border border-cyan-300/80 bg-cyan-300/10"
                  style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }}
                  data-testid="marquee"
                />
              )}

              {notes.map((raw) => {
                const n = view(raw);
                const isSel = liveSelected.has(n.id);
                const erasing = drag?.kind === "erase" && drag.ids.has(n.id);
                const outOfKey = !!hint && !n.muted && !isInKey(n.pitch, hint);
                return (
                  <div
                    key={n.id}
                    data-note-id={n.id}
                    data-muted={n.muted ? "true" : undefined}
                    data-out-of-key={outOfKey ? "true" : undefined}
                    title={outOfKey && hint ? outOfKeyMessage(n.pitch, hint) : undefined}
                    data-selected={isSel ? "true" : undefined}
                    className={`absolute overflow-hidden rounded-[3px] ${isSel ? "ring-1 ring-white" : ""}`}
                    style={{
                      left: tickToPx(n.startTick, pxPerBeat),
                      top: pitchToY(n.pitch, rowH) + 1,
                      width: Math.max(4, tickToPx(n.durationTicks, pxPerBeat) - 1),
                      height: rowH - 2,
                      background: n.muted ? "repeating-linear-gradient(45deg,#475569 0 4px,#334155 4px 8px)" : outOfKey ? "repeating-linear-gradient(135deg,#ef4444 0 5px,#b91c1c 5px 10px)" : track.color,
                      boxShadow: outOfKey ? "0 0 0 1px #fecaca" : undefined,
                      filter: isSel ? "brightness(1.3)" : undefined,
                      opacity: erasing ? 0.25 : n.muted ? 0.7 : 0.55 + (n.velocity / 127) * 0.45,
                      cursor: tool === "delete" ? "not-allowed" : tool === "mute" ? "pointer" : tool === "slice" ? "col-resize" : "grab",
                    }}
                  >
                    {rowH >= 14 && <span className="pointer-events-none px-1 text-[9px] leading-none font-medium text-slate-950" style={{ lineHeight: `${rowH - 2}px` }}>{isDrums ? "" : pitchLabel(n.pitch)}</span>}
                    <span className="absolute top-0 right-0 h-full cursor-ew-resize bg-black/25" style={{ width: RESIZE_PX / 2 }} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Velocity lane */}
          <div className="sticky bottom-0 z-30 flex" style={{ height: VEL_H }}>
            <div className="sticky left-0 z-40 flex shrink-0 items-center justify-center border-t border-r border-white/10 bg-[#161a23] text-[9px] tracking-wide text-slate-500 uppercase" style={{ width: KEYS_W }}>
              Velocity
            </div>
            <div
              ref={velRef}
              className="relative border-t border-white/10 bg-[#0e1118]"
              style={{ width: gridW, touchAction: "none" }}
              onPointerDown={onVelDown}
              onPointerMove={onVelMove}
              onPointerUp={onVelUp}
              onPointerCancel={onVelUp}
            >
              <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: [lines(0.3, barPx), lines(0.1, beatPx)].join(",") }} />
              {notes.map((raw) => {
                const n = view(raw);
                return (
                  <div
                    key={n.id}
                    data-vel-id={n.id}
                    className="absolute bottom-0 cursor-ns-resize rounded-t-sm"
                    style={{ left: tickToPx(n.startTick, pxPerBeat), width: 6, height: Math.max(3, (n.velocity / 127) * (VEL_H - 4)), background: track.color, opacity: liveSelected.has(n.id) ? 1 : 0.6 }}
                    title={`velocity ${n.velocity}`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
