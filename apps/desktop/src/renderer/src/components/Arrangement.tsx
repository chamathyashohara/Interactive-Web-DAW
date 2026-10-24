import { Fragment, memo, useEffect, useRef, useState } from "react";
import {
  MAX_SONG_BARS,
  MIN_CLIP_TICKS,
  PPQ,
  TICKS_PER_BAR,
  deleteClipOps,
  dropSampleOps,
  duplicateClipOps,
  lastClipEnd,
  moveClipOps,
  newClipOps,
  overlapsAny,
  resizeClipOps,
  songTicks,
  sortedClips,
  splitClipOps,
  trimClipStartOps,
  findFreeStart,
  type AutoParam,
  type Clip,
  type ClipAudio,
  type OpBody,
  type Project,
  type Track,
} from "@daw/shared";
import type { IndexEntry } from "@daw/sounds";
import { libraryStore, statusStore, useStore } from "../store";
import { CATEGORY_COLORS } from "../samples/sampleColors";
import { SAMPLE_DRAG_TYPE, dragState } from "../samples/SamplesPanel";
import { LockIcon } from "../unlock/LockIcon";
import { useUnlock } from "../unlock/useUnlock";
import { AUTO_ROW_H, AutomationLane, formatAutoValue } from "./AutomationLane";
import { Knob } from "../controls/Knob";
import { SECTION_H, SectionOverlay, SectionRuler } from "./SectionRuler";
import { ClipAudioFields } from "./ClipAudioFields";
import { AddTrackRow, HEADER_W, TRACK_ROW_H, TrackHeader } from "./TrackHeader";

interface Props {
  project: Project;
  selectedTrackId: string;
  selectedClipId: string | null;
  snap: boolean;
  /** The toolbar grid size: clips and dropped sounds snap to it while Snap is on. */
  gridTicks: number;
  keysEnabled: boolean;
  /** Fixed height in px, or "fill" to take all the room the piano roll is not using. */
  height: number | "fill";
  onSelect: (trackId: string, clipId: string | null) => void;
  /** Double-clicking a clip asks for it to be opened in the piano roll. */
  onOpen?: (trackId: string, clipId: string) => void;
}

/** A fade being dragged on a clip: the value shown while dragging, applied on release. */
type FadeDrag = { trackId: string; clipId: string; which: "in" | "out"; startX: number; base: number; value: number; other: number; length: number };

/** Where a dragged sound would land: on an existing lane, or (trackId null) on a new track under the last one. */
type Ghost = { trackId: string | null; start: number; length: number; color: string; label: string };

type Drag = { kind: "move" | "resize" | "trim"; trackId: string; clipId: string; startX: number; orig: Clip; start: number; length: number; valid: boolean };

const RULER_H = 24;
const STRIP_H = 32;
const RESIZE_PX = 8;
const btn = "hw-btn px-2 py-0.5 text-[11px]";
const uuid = () => crypto.randomUUID();

const ArrPlayhead = memo(function ArrPlayhead({ pxPerTick }: { pxPerTick: number }) {
  const status = useStore(statusStore);
  return <div className="pointer-events-none absolute top-0 bottom-0 z-[25] w-px bg-amber-300" style={{ left: HEADER_W + (status?.tick ?? 0) * pxPerTick, boxShadow: "0 0 6px rgba(252,211,77,.7)" }} />;
});

/** Tiny picture of the notes inside a clip. */
function MiniNotes({ clip, color }: { clip: Clip; color: string }) {
  const notes = Object.values(clip.notes);
  if (!notes.length) return null;
  let lo = 127, hi = 0;
  for (const n of notes) (lo = Math.min(lo, n.pitch), (hi = Math.max(hi, n.pitch)));
  const span = Math.max(1, hi - lo + 1);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 top-4 overflow-hidden">
      {notes.slice(0, 300).map((n) => (
        <span
          key={n.id}
          className="absolute rounded-[1px]"
          style={{ left: `${(n.startTick / clip.lengthTicks) * 100}%`, width: `${Math.max(0.6, (n.durationTicks / clip.lengthTicks) * 100)}%`, top: `${(1 - (n.pitch - lo + 1) / (span + 1)) * 100}%`, height: 2, background: color, opacity: n.muted ? 0.25 : 0.9 }}
        />
      ))}
    </div>
  );
}

/** The sound's waveform inside a sample clip (only as long as the sound itself; the rest of a longer clip stays empty). */
function SampleWave({ entry, tempo, clipLength, color, sampleBpm, startSec = 0, gainDb = 0 }: { entry: IndexEntry; tempo: number; clipLength: number; color: string; sampleBpm?: number; startSec?: number; gainDb?: number }) {
  // Fitted loops are stretched to the project tempo, so their picture is as long as the stretched sound; unfitted ones keep their own length (and are cut at the clip end).
  const seconds = sampleBpm ? (entry.durationSec * sampleBpm) / tempo : entry.durationSec;
  const soundTicks = (seconds * tempo * PPQ) / 60;
  const frac = Math.max(0.02, soundTicks / clipLength); // may exceed 1: then the clip cuts the sound off
  const n = entry.peaks.length || 1;
  // a trimmed start hides the first part of the sound: the picture moves left by the trimmed time (in played seconds)
  const hiddenTicks = (startSec * (sampleBpm ? sampleBpm / tempo : 1) * tempo * PPQ) / 60;
  const gain = 10 ** (gainDb / 20);
  return (
    <svg className="pointer-events-none absolute bottom-0 top-4" style={{ left: `${(-hiddenTicks / clipLength) * 100}%`, width: `${frac * 100}%` }} viewBox={`0 0 ${n} 20`} preserveAspectRatio="none" aria-hidden>
      {entry.peaks.map((p, i) => {
        const h = Math.min(20, Math.max(0.6, (p / 255) * 20 * gain));
        return <rect key={i} x={i} y={10 - h / 2} width={0.8} height={h} fill={color} opacity={0.85} />;
      })}
    </svg>
  );
}

export function Arrangement({ project, selectedTrackId, selectedClipId, snap, gridTicks, keysEnabled, height, onSelect, onOpen }: Props) {
  const [pxPerBar, setPxPerBar] = useState(90);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hint, setHint] = useState("");
  const unlock = useUnlock();
  const library = useStore(libraryStore);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const clipsLocked = !unlock.can("arrangement.clips"); // clip editing is a lesson-gated feature
  const audioLocked = !unlock.can("clips.audio"); // trimming, fades and gain are lesson-gated too
  const audioLockTitle = unlock.reason("clips.audio");
  const [autoOpen, setAutoOpen] = useState<Record<string, AutoParam>>({}); // which tracks show an automation lane, and which curve
  const [autoReadout, setAutoReadout] = useState("");
  const [fadeDrag, setFadeDragState] = useState<FadeDrag | null>(null);
  const fadeRef = useRef<FadeDrag | null>(null);
  const setFadeDrag = (d: FadeDrag | null) => {
    fadeRef.current = d;
    setFadeDragState(d);
  };
  const lockTitle = unlock.reason("arrangement.clips");
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  const pxPerTick = pxPerBar / TICKS_PER_BAR;
  const songLen = songTicks(project);
  const songW = songLen * pxPerTick;
  const unit = snap ? gridTicks : PPQ;
  const snapTo = (tick: number) => Math.round(tick / unit) * unit;

  /** Seconds of the sound itself per arrangement tick (a tempo-fitted loop is stretched, so its own time runs faster or slower). */
  const nativeSecPerTick = (t: Track) => (60 / (project.tempo * PPQ)) * (t.sample?.fit && t.sample.bpm ? project.tempo / t.sample.bpm : 1);
  const track: Track | undefined = project.tracks[selectedTrackId];
  const clip: Clip | undefined = track && selectedClipId ? track.clips[selectedClipId] : undefined;
  const batch = (ops: OpBody[] | null, group?: string) => {
    if (!ops) return false;
    if (ops.length) void window.daw.dispatchBatch(ops, group);
    return true;
  };

  // ---- strip commands ----
  const cmdAddClip = () => {
    if (!track) return;
    const start = findFreeStart(track, TICKS_PER_BAR, songLen, 0);
    if (start === null) return setHint("This track has no free bar. Lengthen the song or delete a clip.");
    const id = `clip-${uuid()}`;
    if (batch(newClipOps(track.id, track, id, start, songLen))) (onSelect(track.id, id), setHint(""));
  };
  const cmdSplit = () => {
    if (!track || !clip) return setHint("Select a clip first.");
    const tick = Math.round((statusStore.get()?.tick ?? 0) / PPQ) * PPQ;
    const id = `clip-${uuid()}`;
    const ops = splitClipOps(track.id, clip, tick, id, uuid, track.instrument === "sample" ? nativeSecPerTick(track) : undefined);
    if (!ops) return setHint("Click the ruler to put the playhead inside the clip (at least one beat from each end), then Split.");
    batch(ops);
    onSelect(track.id, id);
    setHint("");
  };
  const cmdDuplicate = () => {
    if (!track || !clip) return setHint("Select a clip first.");
    const id = `clip-${uuid()}`;
    const ops = duplicateClipOps(track.id, track, clip, id, uuid, songLen);
    if (!ops) return setHint("No free space on this track for a copy. Lengthen the song first.");
    batch(ops);
    onSelect(track.id, id);
    setHint("");
  };
  const cmdDelete = () => {
    if (!track || !clip) return;
    batch(deleteClipOps(track.id, clip.id));
    onSelect(track.id, null);
    setHint("");
  };
  const minBars = Math.max(1, Math.ceil(lastClipEnd(project) / TICKS_PER_BAR));
  const setBars = (bars: number) => void window.daw.dispatch({ type: "setSongLength", bars });

  // ---- dropping a sound from the browser ----
  const sampleById = (id: string | null): IndexEntry | undefined => (id ? library.entries.find((e) => e.id === id) : undefined);
  const hasSampleDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(SAMPLE_DRAG_TYPE);
  /** The lane under the pointer (null when it is over empty space) and the bar-aligned tick it points at. */
  const dropTarget = (e: React.DragEvent) => {
    const lane = (e.target as HTMLElement).closest("[data-testid=lane]");
    const ruler = scrollRef.current?.querySelector("[data-testid=arr-ruler]");
    const left = ruler ? ruler.getBoundingClientRect().left : 0;
    const tick = Math.max(0, Math.min(songLen - 1, (e.clientX - left) / pxPerTick));
    return { laneId: lane?.getAttribute("data-track-id") ?? null, tick: snap ? Math.floor(tick / gridTicks) * gridTicks : Math.floor(tick) };
  };
  const planDrop = (entry: IndexEntry, laneId: string | null, tick: number) => {
    const ids = { trackId: `track-${uuid()}`, clipId: `clip-${uuid()}`, noteId: `note-${uuid()}` };
    return { ids, plan: dropSampleOps(project, { id: entry.id, name: entry.name, category: entry.category, durationSec: entry.durationSec, meta: entry.meta }, tick, laneId, ids, CATEGORY_COLORS[entry.category]) };
  };
  const onSampleDragOver = (e: React.DragEvent) => {
    if (!hasSampleDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const entry = sampleById(dragState.sampleId);
    if (!entry) return;
    const { laneId, tick } = dropTarget(e);
    const { plan } = planDrop(entry, laneId, tick);
    if (!plan.ok) return setGhost(null);
    const clipOp = plan.ops.find((o) => o.type === "addClip" || o.type === "addTrack");
    const clip = clipOp?.type === "addClip" ? clipOp.clip : clipOp?.type === "addTrack" ? Object.values(clipOp.track.clips)[0] : undefined;
    if (!clip) return;
    setGhost({ trackId: plan.newTrack ? null : plan.trackId, start: clip.startTick, length: clip.lengthTicks, color: CATEGORY_COLORS[entry.category], label: entry.name });
  };
  const onSampleDrop = (e: React.DragEvent) => {
    if (!hasSampleDrag(e)) return;
    e.preventDefault();
    setGhost(null);
    let id: string | null = null;
    try {
      id = (JSON.parse(e.dataTransfer.getData(SAMPLE_DRAG_TYPE)) as { id?: string }).id ?? null;
    } catch {
      id = dragState.sampleId;
    }
    const entry = sampleById(id);
    if (!entry) return setHint("That sound is not in your library any more.");
    const { laneId, tick } = dropTarget(e);
    const { ids, plan } = planDrop(entry, laneId, tick);
    if (!plan.ok) return setHint(plan.reason);
    if (plan.newTrack && project.trackOrder.length >= 1 && !unlock.can("tracks.multiple")) return setHint(unlock.reason("tracks.multiple") ?? "Adding tracks is locked.");
    if (!plan.newTrack && clipsLocked) return setHint(lockTitle ?? "Adding clips is locked.");
    void window.daw.dispatchBatch(plan.ops, `drop-${ids.clipId}`);
    onSelect(plan.trackId, plan.clipId);
    setHint("");
  };

  // a newly opened automation lane scrolls into view (the arrangement area is short while the piano roll is open)
  const openLanes = Object.keys(autoOpen).sort().join(",");
  useEffect(() => {
    const last = Object.keys(autoOpen).pop();
    if (!last) return;
    scrollRef.current?.querySelector(`[data-testid=auto-row][data-track-id="${last}"]`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLanes]);

  useEffect(() => {
    const clear = () => setGhost(null); // a drag that ends anywhere (dropped elsewhere, cancelled with Esc) removes the preview
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  useEffect(() => {
    if (!keysEnabled || clipsLocked) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "d") (e.preventDefault(), cmdDuplicate());
      else if (e.ctrlKey || e.metaKey || e.altKey) return;
      else if (k === "delete" || k === "backspace") cmdDelete();
      else if (k === "s") cmdSplit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- clip dragging ----
  const clipPointerDown = (e: React.PointerEvent<HTMLDivElement>, t: Track, c: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(t.id, c.id);
    if (clipsLocked) return; // until the clips lesson is done a clip can be selected and opened, not moved or resized
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const resize = rect.right - e.clientX <= RESIZE_PX;
    const trim = !resize && t.instrument === "sample" && !audioLocked && e.clientX - rect.left <= RESIZE_PX;
    setDrag({ kind: resize ? "resize" : trim ? "trim" : "move", trackId: t.id, clipId: c.id, startX: e.clientX, orig: c, start: c.startTick, length: c.lengthTicks, valid: true });
  };
  const clipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const t = project.tracks[d.trackId];
    if (!t) return;
    const dTick = (e.clientX - d.startX) / pxPerTick;
    if (d.kind === "move") {
      const start = Math.max(0, Math.min(songLen - d.orig.lengthTicks, snapTo(d.orig.startTick + dTick)));
      setDrag({ ...d, start, valid: !overlapsAny(t, start, d.orig.lengthTicks, d.clipId) });
    } else if (d.kind === "trim") {
      const start = Math.max(0, snapTo(d.orig.startTick + dTick));
      const ops = trimClipStartOps(t.id, t, d.orig, start, songLen, nativeSecPerTick(t));
      setDrag({ ...d, start, length: d.orig.lengthTicks - (start - d.orig.startTick), valid: ops !== null });
    } else {
      const end = snapTo(d.orig.startTick + d.orig.lengthTicks + dTick);
      const length = Math.max(MIN_CLIP_TICKS, Math.min(songLen - d.orig.startTick, end - d.orig.startTick));
      setDrag({ ...d, length, valid: !overlapsAny(t, d.orig.startTick, length, d.clipId) });
    }
  };
  const clipPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    setDrag(null);
    const t = project.tracks[d.trackId];
    const c = t?.clips[d.clipId];
    if (!t || !c) return;
    if (!d.valid) return setHint("A clip cannot overlap another clip on the same track.");
    setHint("");
    if (d.kind === "move") batch(moveClipOps(t.id, t, c, d.start, songLen));
    else if (d.kind === "trim") batch(trimClipStartOps(t.id, t, c, d.start, songLen, nativeSecPerTick(t)), `trim-${c.id}`);
    else batch(resizeClipOps(t.id, t, c, d.length, songLen));
  };

  // ---- fades: drag the little handle in the top corner of a selected sound clip ----
  const fadePointerDown = (e: React.PointerEvent<HTMLSpanElement>, t: Track, c: Clip, which: "in" | "out") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const base = which === "in" ? c.audio?.fadeInTicks ?? 0 : c.audio?.fadeOutTicks ?? 0;
    setFadeDrag({ trackId: t.id, clipId: c.id, which, startX: e.clientX, base, value: base, other: which === "in" ? c.audio?.fadeOutTicks ?? 0 : c.audio?.fadeInTicks ?? 0, length: c.lengthTicks });
  };
  const fadePointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const f = fadeRef.current;
    if (!f) return;
    const dx = (e.clientX - f.startX) / pxPerTick;
    const raw = f.which === "in" ? f.base + dx : f.base - dx;
    const snapped = snap ? Math.round(raw / gridTicks) * gridTicks : Math.round(raw);
    setFadeDrag({ ...f, value: Math.max(0, Math.min(f.length - f.other, snapped)) });
  };
  const fadePointerUp = () => {
    const f = fadeRef.current;
    if (!f) return;
    setFadeDrag(null);
    const t = project.tracks[f.trackId];
    const c = t?.clips[f.clipId];
    if (!t || !c || f.value === f.base) return;
    const next: ClipAudio = { ...c.audio, [f.which === "in" ? "fadeInTicks" : "fadeOutTicks"]: f.value };
    if (next.fadeOutTicks) next.cut = true;
    void window.daw.dispatch({ type: "updateClip", trackId: t.id, clipId: c.id, changes: { audio: next } }, `audio-${c.id}`);
  };

  const laneBg = [
    `repeating-linear-gradient(to right, rgba(255,255,255,0.22) 0 1px, transparent 1px ${pxPerBar}px)`,
    pxPerBar * (gridTicks / TICKS_PER_BAR) >= 5 && gridTicks < TICKS_PER_BAR ? `repeating-linear-gradient(to right, rgba(255,255,255,0.06) 0 1px, transparent 1px ${pxPerBar * (gridTicks / TICKS_PER_BAR)}px)` : "",
  ].filter(Boolean).join(",");

  return (
    <section className={`flex flex-col border-b border-white/10 bg-[#0e1118] ${height === "fill" ? "min-h-0 flex-1" : "shrink-0"}`} style={height === "fill" ? undefined : { height }} data-testid="arrangement">
      <div className="hw-panel flex shrink-0 items-center gap-1.5 border-b border-black px-3" style={{ height: STRIP_H }}>
        <span className="mr-1 text-[11px] tracking-wide text-slate-400 uppercase">Arrangement</span>
        <button className={btn} onClick={cmdAddClip} disabled={!track || clipsLocked} data-testid="arr-add-clip" title={lockTitle ?? "Add a clip on the selected track (or double-click an empty spot on its lane)"}>+ Clip{clipsLocked && <LockIcon className="ml-1" />}</button>
        <button className={btn} onClick={cmdSplit} disabled={!clip || clipsLocked} data-testid="arr-split" title={lockTitle ?? "Split the selected clip at the playhead (S)"}>Split</button>
        <button className={btn} onClick={cmdDuplicate} disabled={!clip || clipsLocked} data-testid="arr-duplicate" title={lockTitle ?? "Duplicate the selected clip after itself (Ctrl+D)"}>Duplicate</button>
        <button className={btn} onClick={cmdDelete} disabled={!clip || clipsLocked} data-testid="arr-delete" title={lockTitle ?? "Delete the selected clip (Delete)"}>Delete clip</button>
        {track?.instrument === "sample" && clip && <ClipAudioFields trackId={track.id} clip={clip} disabled={audioLocked} lockTitle={audioLockTitle} />}
        <span className="mx-1 h-4 w-px bg-white/10" />
        <span className="text-[11px] text-slate-400">Song</span>
        <button className={btn} disabled={project.songBars <= minBars || clipsLocked} title={lockTitle ?? undefined} onClick={() => setBars(project.songBars - 1)} aria-label="Shorter song" data-testid="song-minus">−</button>
        <span className="w-16 text-center text-[11px] text-slate-200" data-testid="song-bars">{project.songBars} bars</span>
        <button className={btn} disabled={project.songBars >= MAX_SONG_BARS || clipsLocked} title={lockTitle ?? undefined} onClick={() => setBars(project.songBars + 1)} aria-label="Longer song" data-testid="song-plus">+</button>
        <label className="ml-2 flex items-center gap-1.5 text-[11px] text-slate-400">
          Zoom
          <Knob value={pxPerBar} min={24} max={260} size={26} color="#2dd4bf" onChange={setPxPerBar} label="Arrangement zoom" title="Zoom: drag up or down" />
        </label>
        <span className="ml-2 truncate text-[11px] text-amber-300/80" data-testid="arr-hint">{hint}</span>
      </div>

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto"
        data-testid="arrangement-scroll"
        onDragOver={onSampleDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setGhost(null);
        }}
        onDrop={onSampleDrop}
      >
        <div className="relative" style={{ width: HEADER_W + songW, minHeight: "100%" }}>
          <ArrPlayhead pxPerTick={pxPerTick} />
          <SectionOverlay project={project} pxPerTick={pxPerTick} songLen={songLen} top={SECTION_H + RULER_H} />

          {/* Song sections and loop region */}
          <div className="sticky top-0 z-30">
            <SectionRuler
              project={project}
              pxPerTick={pxPerTick}
              songLen={songLen}
              songW={songW}
              unit={unit}
              loopLocked={!unlock.can("arrangement.loop")}
              loopLockTitle={unlock.reason("arrangement.loop")}
              markersLocked={!unlock.can("arrangement.markers")}
              markersLockTitle={unlock.reason("arrangement.markers")}
            />
          </div>

          {/* Ruler */}
          <div className="sticky z-30 flex" style={{ height: RULER_H, top: SECTION_H }}>
            <div className="sticky left-0 z-40 shrink-0 border-r border-b border-white/10 bg-[#161a23]" style={{ width: HEADER_W }} />
            <div
              className="relative border-b border-white/10 bg-[#161a23]"
              style={{ width: songW }}
              data-testid="arr-ruler"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const tick = Math.round((e.clientX - rect.left) / pxPerTick / PPQ) * PPQ;
                window.daw.seek(Math.max(0, Math.min(songLen - 1, tick)));
              }}
            >
              {Array.from({ length: project.songBars }, (_, b) => (
                <div key={b} className="absolute top-0 h-full border-l border-white/30 pl-1 text-[10px] leading-[22px] text-slate-300" style={{ left: b * pxPerBar }}>
                  {b + 1}
                </div>
              ))}
            </div>
          </div>

          {project.trackOrder.map((id, i) => {
            const t = project.tracks[id]!;
            return (
              <Fragment key={id}>
              <div className="flex" style={{ height: TRACK_ROW_H }}>
                <div className="sticky left-0 z-20 shrink-0">
                  <TrackHeader
                    project={project}
                    trackId={id}
                    index={i}
                    selected={id === selectedTrackId}
                    onSelect={() => id !== selectedTrackId && onSelect(id, null)}
                    autoOpen={!!autoOpen[id]}
                    onToggleAuto={() => setAutoOpen((prev) => (prev[id] ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)) : { ...prev, [id]: "volume" }))}
                  />
                </div>
                <div
                  className="relative border-b border-white/10"
                  style={{ width: songW, height: TRACK_ROW_H, backgroundImage: laneBg }}
                  data-testid="lane"
                  data-track-id={id}
                  onPointerDown={(e) => e.target === e.currentTarget && onSelect(id, null)}
                  onDoubleClick={(e) => {
                    if (e.target !== e.currentTarget || clipsLocked) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const start = Math.floor((e.clientX - rect.left) / pxPerTick / (snap ? gridTicks : TICKS_PER_BAR)) * (snap ? gridTicks : TICKS_PER_BAR);
                    const clipId = `clip-${uuid()}`;
                    if (batch(newClipOps(id, t, clipId, start, songLen))) (onSelect(id, clipId), setHint(""));
                    else setHint("There is no room for a clip there.");
                  }}
                >
                  {ghost && ghost.trackId === id && (
                    <div className="pointer-events-none absolute z-10 rounded-md border border-dashed" data-testid="drop-ghost" style={{ left: ghost.start * pxPerTick, width: Math.max(6, ghost.length * pxPerTick - 1), top: 5, height: TRACK_ROW_H - 11, background: `${ghost.color}40`, borderColor: ghost.color }} />
                  )}
                  {sortedClips(t).map((c) => {
                    const d = drag && drag.clipId === c.id ? drag : null;
                    const start = d ? d.start : c.startTick;
                    const length = d ? d.length : c.lengthTicks;
                    const selected = id === selectedTrackId && c.id === selectedClipId;
                    return (
                      <div
                        key={c.id}
                        data-testid="clip"
                        data-clip-id={c.id}
                        data-track-id={id}
                        data-start={start}
                        data-length={length}
                        data-selected={selected ? "true" : undefined}
                        data-invalid={d && !d.valid ? "true" : undefined}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          onOpen?.(t.id, c.id);
                        }}
                        onPointerDown={(e) => clipPointerDown(e, t, c)}
                        onPointerMove={clipPointerMove}
                        onPointerUp={clipPointerUp}
                        onPointerCancel={clipPointerUp}
                        className="absolute overflow-hidden rounded-md"
                        style={{
                          left: start * pxPerTick,
                          width: Math.max(6, length * pxPerTick - 1),
                          top: 5,
                          height: TRACK_ROW_H - 11,
                          background: `${t.color}33`,
                          border: `1px solid ${d && !d.valid ? "#f87171" : selected ? "#ffffff" : t.color}`,
                          boxShadow: selected ? `0 0 0 1px ${t.color}` : undefined,
                          cursor: "grab",
                          touchAction: "none",
                          opacity: d && !d.valid ? 0.6 : 1,
                        }}
                      >
                        <div className="pointer-events-none truncate px-1.5 text-[10px] leading-4 font-medium" style={{ color: t.color }}>{c.name ?? "Clip"}</div>
                        {t.instrument === "sample" ? (
                          (() => {
                            const entry = sampleById(t.sample?.id ?? null);
                            return entry ? <SampleWave entry={entry} tempo={project.tempo} clipLength={length} color={t.color} sampleBpm={t.sample?.fit ? t.sample.bpm : undefined} startSec={c.audio?.startSec} gainDb={c.audio?.gainDb} /> : <div className="pointer-events-none px-1.5 text-[9px] text-amber-300/80" data-testid="missing-sound">sound not in library</div>;
                          })()
                        ) : (
                          length * pxPerTick > 24 && <MiniNotes clip={c} color={t.color} />
                        )}
                        {t.instrument === "sample" && (() => {
                          const fd = fadeDrag && fadeDrag.clipId === c.id ? fadeDrag : null;
                          const fi = fd?.which === "in" ? fd.value : c.audio?.fadeInTicks ?? 0;
                          const fo = fd?.which === "out" ? fd.value : c.audio?.fadeOutTicks ?? 0;
                          const pct = (v: number) => (v / Math.max(1, length)) * 100;
                          return (
                            <>
                              {(fi > 0 || fo > 0) && (
                                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" data-testid="fade-shape" data-fade-in={fi} data-fade-out={fo}>
                                  {fi > 0 && <polygon points={`0,0 ${pct(fi)},0 0,100`} fill="rgba(0,0,0,0.45)" />}
                                  {fo > 0 && <polygon points={`100,0 ${100 - pct(fo)},0 100,100`} fill="rgba(0,0,0,0.45)" />}
                                </svg>
                              )}
                              {selected && !audioLocked && !clipsLocked && (
                                <>
                                  <span
                                    className="absolute z-10 h-3 w-3 cursor-ew-resize rounded-sm border border-white/70 bg-white/30"
                                    style={{ left: Math.max(0, fi * pxPerTick - 6), top: 1, touchAction: "none" }}
                                    title="Drag to fade the sound in"
                                    data-testid="fade-in-handle"
                                    onPointerDown={(e) => fadePointerDown(e, t, c, "in")}
                                    onPointerMove={fadePointerMove}
                                    onPointerUp={fadePointerUp}
                                    onPointerCancel={fadePointerUp}
                                  />
                                  <span
                                    className="absolute z-10 h-3 w-3 cursor-ew-resize rounded-sm border border-white/70 bg-white/30"
                                    style={{ right: Math.max(0, fo * pxPerTick - 6), top: 1, touchAction: "none" }}
                                    title="Drag to fade the sound out"
                                    data-testid="fade-out-handle"
                                    onPointerDown={(e) => fadePointerDown(e, t, c, "out")}
                                    onPointerMove={fadePointerMove}
                                    onPointerUp={fadePointerUp}
                                    onPointerCancel={fadePointerUp}
                                  />
                                </>
                              )}
                              {!audioLocked && <span className="absolute top-0 left-0 h-full cursor-ew-resize" style={{ width: RESIZE_PX, background: `${t.color}33` }} data-testid="trim-start-edge" />}
                            </>
                          );
                        })()}
                        <span className="absolute top-0 right-0 h-full cursor-ew-resize" style={{ width: RESIZE_PX, background: `${t.color}55` }} />
                      </div>
                    );
                  })}
                </div>
              </div>
              {autoOpen[id] && (
                <div className="flex" style={{ height: AUTO_ROW_H }} data-testid="auto-row" data-track-id={id}>
                  <div className="sticky left-0 z-20 shrink-0 border-r border-b border-black hw-strip px-2 py-1.5" style={{ width: HEADER_W, height: AUTO_ROW_H }}>
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      <span style={{ color: t.color }}>∿</span>
                      <select
                        value={autoOpen[id]}
                        onChange={(e) => setAutoOpen((prev) => ({ ...prev, [id]: e.target.value as AutoParam }))}
                        className="hw-lcd px-1.5 py-0.5 text-[11px] outline-none"
                        aria-label="Automation parameter"
                        data-testid="auto-param"
                      >
                        <option value="volume" className="bg-[#12151c]">Volume</option>
                        <option value="filter" className="bg-[#12151c]">Filter (low-pass)</option>
                      </select>
                      <button
                        className="hw-btn px-1.5 py-0.5 text-[10px]"
                        disabled={!t.automation?.[autoOpen[id]!]?.length}
                        onClick={() => void window.daw.dispatch({ type: "setAutomation", trackId: id, param: autoOpen[id]!, points: null })}
                        data-testid="auto-clear"
                      >
                        Clear
                      </button>
                      <span className="ml-auto font-mono text-amber-300" data-testid="auto-readout">{autoReadout}</span>
                    </div>
                    <div className="mt-1 text-[10px] leading-3 text-slate-500">
                      {autoOpen[id] === "volume" ? "Top = the track's fader level, bottom = silence." : "Top = open, bottom = muffled (20 Hz). A low cutoff removes the highs."}
                    </div>
                  </div>
                  <div className="border-b border-white/10" style={{ width: songW }}>
                    <AutomationLane
                      trackId={id}
                      param={autoOpen[id]!}
                      points={t.automation?.[autoOpen[id]!] ?? []}
                      width={songW}
                      pxPerTick={pxPerTick}
                      songLen={songLen}
                      snap={snap}
                      gridTicks={gridTicks}
                      color={t.color}
                      disabled={!unlock.can("automation.lanes")}
                      onReadout={setAutoReadout}
                    />
                  </div>
                </div>
              )}
              </Fragment>
            );
          })}
          <div className="flex" style={{ minHeight: ghost && ghost.trackId === null ? TRACK_ROW_H : undefined }}>
            <div className="sticky left-0 z-20 shrink-0">
              <AddTrackRow project={project} onAdded={(id) => onSelect(id, null)} />
            </div>
            {ghost && ghost.trackId === null && (
              <div className="relative" style={{ width: songW, height: TRACK_ROW_H }} data-testid="drop-new-track">
                <div className="pointer-events-none absolute rounded-md border border-dashed px-1.5 text-[10px] leading-4" style={{ left: ghost.start * pxPerTick, width: Math.max(6, ghost.length * pxPerTick - 1), top: 5, height: TRACK_ROW_H - 11, background: `${ghost.color}40`, borderColor: ghost.color, color: ghost.color }}>
                  New track: {ghost.label}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
