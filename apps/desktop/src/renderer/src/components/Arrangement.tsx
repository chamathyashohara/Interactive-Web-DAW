import { memo, useEffect, useRef, useState } from "react";
import {
  MAX_SONG_BARS,
  MIN_CLIP_TICKS,
  PPQ,
  TICKS_PER_BAR,
  deleteClipOps,
  duplicateClipOps,
  lastClipEnd,
  moveClipOps,
  newClipOps,
  overlapsAny,
  resizeClipOps,
  songTicks,
  sortedClips,
  splitClipOps,
  findFreeStart,
  type Clip,
  type OpBody,
  type Project,
  type Track,
} from "@daw/shared";
import { statusStore, useStore } from "../store";
import { AddTrackRow, HEADER_W, TRACK_ROW_H, TrackHeader } from "./TrackHeader";

interface Props {
  project: Project;
  selectedTrackId: string;
  selectedClipId: string | null;
  snap: boolean;
  keysEnabled: boolean;
  height: number;
  onSelect: (trackId: string, clipId: string | null) => void;
}

type Drag = { kind: "move" | "resize"; trackId: string; clipId: string; startX: number; orig: Clip; start: number; length: number; valid: boolean };

const RULER_H = 24;
const STRIP_H = 32;
const RESIZE_PX = 8;
const btn = "rounded px-2 py-0.5 text-[11px] font-medium bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-35 disabled:hover:bg-white/5";
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

export function Arrangement({ project, selectedTrackId, selectedClipId, snap, keysEnabled, height, onSelect }: Props) {
  const [pxPerBar, setPxPerBar] = useState(90);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hint, setHint] = useState("");
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  const pxPerTick = pxPerBar / TICKS_PER_BAR;
  const songLen = songTicks(project);
  const songW = songLen * pxPerTick;
  const unit = snap ? TICKS_PER_BAR : PPQ;
  const snapTo = (tick: number) => Math.round(tick / unit) * unit;

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
    const ops = splitClipOps(track.id, clip, tick, id, uuid);
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

  useEffect(() => {
    if (!keysEnabled) return;
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
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    const resize = rect.right - e.clientX <= RESIZE_PX;
    setDrag({ kind: resize ? "resize" : "move", trackId: t.id, clipId: c.id, startX: e.clientX, orig: c, start: c.startTick, length: c.lengthTicks, valid: true });
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
    else batch(resizeClipOps(t.id, t, c, d.length, songLen));
  };

  const laneBg = [
    `repeating-linear-gradient(to right, rgba(255,255,255,0.22) 0 1px, transparent 1px ${pxPerBar}px)`,
    pxPerBar >= 70 ? `repeating-linear-gradient(to right, rgba(255,255,255,0.06) 0 1px, transparent 1px ${pxPerBar / 4}px)` : "",
  ].filter(Boolean).join(",");

  return (
    <section className="flex shrink-0 flex-col border-b border-white/10 bg-[#0e1118]" style={{ height }} data-testid="arrangement">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 bg-[#12151c] px-3" style={{ height: STRIP_H }}>
        <span className="mr-1 text-[11px] tracking-wide text-slate-400 uppercase">Arrangement</span>
        <button className={btn} onClick={cmdAddClip} disabled={!track} data-testid="arr-add-clip" title="Add a clip on the selected track (or double-click an empty spot on its lane)">+ Clip</button>
        <button className={btn} onClick={cmdSplit} disabled={!clip} data-testid="arr-split" title="Split the selected clip at the playhead (S)">Split</button>
        <button className={btn} onClick={cmdDuplicate} disabled={!clip} data-testid="arr-duplicate" title="Duplicate the selected clip after itself (Ctrl+D)">Duplicate</button>
        <button className={btn} onClick={cmdDelete} disabled={!clip} data-testid="arr-delete" title="Delete the selected clip (Delete)">Delete clip</button>
        <span className="mx-1 h-4 w-px bg-white/10" />
        <span className="text-[11px] text-slate-400">Song</span>
        <button className={btn} disabled={project.songBars <= minBars} onClick={() => setBars(project.songBars - 1)} aria-label="Shorter song" data-testid="song-minus">−</button>
        <span className="w-16 text-center text-[11px] text-slate-200" data-testid="song-bars">{project.songBars} bars</span>
        <button className={btn} disabled={project.songBars >= MAX_SONG_BARS} onClick={() => setBars(project.songBars + 1)} aria-label="Longer song" data-testid="song-plus">+</button>
        <label className="ml-2 flex items-center gap-1.5 text-[11px] text-slate-400">
          Zoom
          <input type="range" min={24} max={260} value={pxPerBar} onChange={(e) => setPxPerBar(Number(e.target.value))} className="w-20 accent-cyan-400" aria-label="Arrangement zoom" />
        </label>
        <span className="ml-2 truncate text-[11px] text-amber-300/80" data-testid="arr-hint">{hint}</span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto" data-testid="arrangement-scroll">
        <div className="relative" style={{ width: HEADER_W + songW, minHeight: "100%" }}>
          <ArrPlayhead pxPerTick={pxPerTick} />

          {/* Ruler */}
          <div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
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
              <div key={id} className="flex" style={{ height: TRACK_ROW_H }}>
                <div className="sticky left-0 z-20 shrink-0">
                  <TrackHeader project={project} trackId={id} index={i} selected={id === selectedTrackId} onSelect={() => id !== selectedTrackId && onSelect(id, null)} />
                </div>
                <div
                  className="relative border-b border-white/10"
                  style={{ width: songW, height: TRACK_ROW_H, backgroundImage: laneBg }}
                  data-testid="lane"
                  data-track-id={id}
                  onPointerDown={(e) => e.target === e.currentTarget && onSelect(id, null)}
                  onDoubleClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const start = Math.floor((e.clientX - rect.left) / pxPerTick / TICKS_PER_BAR) * TICKS_PER_BAR;
                    const clipId = `clip-${uuid()}`;
                    if (batch(newClipOps(id, t, clipId, start, songLen))) (onSelect(id, clipId), setHint(""));
                    else setHint("There is no room for a clip there.");
                  }}
                >
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
                        {length * pxPerTick > 24 && <MiniNotes clip={c} color={t.color} />}
                        <span className="absolute top-0 right-0 h-full cursor-ew-resize" style={{ width: RESIZE_PX, background: `${t.color}55` }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="flex">
            <div className="sticky left-0 z-20 shrink-0">
              <AddTrackRow project={project} onAdded={(id) => onSelect(id, null)} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
