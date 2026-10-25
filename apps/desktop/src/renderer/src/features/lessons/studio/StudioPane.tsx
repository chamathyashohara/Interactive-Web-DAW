import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_BPM, MIN_BPM, MIN_CLIP_TICKS, PPQ, TICKS_PER_BAR, deleteClipOps, dropSampleOps, duplicateClipOps, moveClipOps, newClipOps, resizeClipOps, songTicks, type Clip, type OpBody, type Project, type Track } from "@daw/shared";
import type { Category, IndexEntry } from "@daw/sounds";
import { GRID_OPTIONS } from "../../../pianoRoll/geometry";
import { CATEGORY_COLORS, sampleTag } from "../../../samples/sampleColors";
import { categoryCounts, filterSamples } from "../../../samples/filter";
import { libraryStore, previewIdStore, statusStore, useStore } from "../../../store";
import { PianoPane } from "../PianoPane";
import { browserStore, readJson, writeJson } from "../storage";
import { LESSON_TRACK_PREFIX, lessonView, songView } from "./checks";
import { trackElement } from "./songChecks";
import { studioCtx, studioState } from "./studioState";
import { toGuideNotes } from "../subLesson";
import { barTick } from "./exampleSong";
import { newTrackOps } from "./lessonTools";
import type { Ghost, Target, Tool } from "./types";
import { AutomationLane, ClipTools, LessonMixer } from "./WorkspaceTools";

/**
 * The Kick lessons' workspace (the right-hand pane, like the Piano lessons' piano roll): a sound browser and an
 * arrangement of the lesson's own tracks, editing the real project through the DAW's shared ops (so Undo, the engine and
 * the Studio all see the same thing). Sounds dropped here make "lesson-k-" tracks; the learner's own tracks are hidden.
 */

export interface StudioGuide {
  /** Dashed targets: where to drop or what to change. */
  targets?: Target[];
  /** Bars lit up while a Watch step talks about them. */
  litBars?: [number, number];
  /** Category chip and sound lit while a demonstration plays it. */
  litCategory?: string;
  litSoundId?: string;
  /** Show the notes editor for the selected clip. */
  editNotes?: boolean;
  /** No editing (Hook, Watch, Quick check). */
  readOnly?: boolean;
  /** Extra tools for this exercise (Make a Song lessons). */
  tools?: Tool[];
  /** Faint notes to copy in the notes editor (Special tasks). */
  ghosts?: Ghost[];
}

/** Tracks the learner can add (Make a Song): the name says which element it is. */
const NEW_TRACKS: { name: string; kind: "synth" | "drums"; color: string }[] = [
  { name: "Pads", kind: "synth", color: "#818cf8" },
  { name: "Strings", kind: "synth", color: "#c084fc" },
  { name: "Bass", kind: "synth", color: "#a78bfa" },
  { name: "Arp", kind: "synth", color: "#34d399" },
  { name: "Melody", kind: "synth", color: "#facc15" },
  { name: "Kick", kind: "drums", color: "#f97316" },
  { name: "Hats", kind: "drums", color: "#a3e635" },
  { name: "Clap", kind: "drums", color: "#fb7185" },
];

const CATEGORY_ORDER: Category[] = ["Kick", "Snare", "Clap", "Hat", "Cymbal", "Tom", "Percussion", "Bass", "Keys", "Pad", "Synth", "FX", "Loop", "Other"];
const DRAG_TYPE = "application/x-lesson-sound";
const LANE_H = 52;
const HEAD_W = 176;
/** Grabbing a clip this close to its right edge resizes it instead of moving it. */
const RESIZE_PX = 8;
const uuid = () => crypto.randomUUID();
/** The learner's Grid and Snap choice, kept for every lesson (default: one beat, so clips can land on any beat). */
const PANE_KEY = "lessons.studioPane.v1";
const paneStore = browserStore();
const btn = "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 bg-white/5 text-slate-200 hover:bg-white/10";

/** Plays a library sound in the engine and remembers it as heard (the listening tasks read that). */
export function previewSound(id: string) {
  window.daw.previewSample(id);
  previewIdStore.set(id);
}

function SoundBrowser({ guide }: { guide: StudioGuide }) {
  const lib = useStore(libraryStore);
  const playing = useStore(previewIdStore);
  const [category, setCategory] = useState<Category | "All">("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const filter = { query, category, pack: "All" as const };
  const list = useMemo(() => filterSamples(lib.entries, filter).slice(0, 300), [lib.entries, query, category]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => categoryCounts(lib.entries, filter), [lib.entries, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const listRef = useRef<HTMLDivElement>(null);

  const play = (e: IndexEntry) => {
    setSelected(e.id);
    previewSound(e.id);
  };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    const i = list.findIndex((e) => e.id === selected);
    const next = list[Math.max(0, Math.min(list.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      play(next);
      listRef.current?.querySelector(`[data-sample-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-[#0f121a]" aria-label="Sounds" data-testid="lesson-sounds">
      <div className="flex items-center justify-between px-3 pt-2.5 text-[11px] font-semibold tracking-widest text-slate-400 uppercase">
        Sounds <span className="font-normal tracking-normal normal-case">{list.length}</span>
      </div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: kick, riser, 90 bpm…" className="mx-3 mt-2 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:ring-1 focus:ring-violet-400/60" aria-label="Search sounds" data-testid="ksearch" />
      <div className="flex flex-wrap gap-1 px-3 py-2">
        {(["All", ...CATEGORY_ORDER.filter((c) => counts.get(c))] as const).map((c) => {
          const lit = guide.litCategory === c;
          const on = category === c;
          return (
            <button
              key={c}
              onClick={() => setCategory(c)}
              aria-pressed={on}
              className={`rounded-md px-1.5 py-0.5 text-[11px] transition-shadow ${on ? "bg-violet-500/30 text-violet-100" : "bg-white/5 text-slate-300 hover:bg-white/10"} ${lit ? "ring-2 ring-amber-300 shadow-[0_0_12px_rgba(252,211,77,.5)]" : ""}`}
              data-testid={`kcat-${c}`}
            >
              {c}
            </button>
          );
        })}
      </div>
      {lib.status.state !== "ready" ? (
        <div className="px-3 py-4 text-xs text-slate-400" data-testid="ksounds-loading">
          {lib.status.state === "error" ? `The sound library could not load: ${lib.status.message}` : "Preparing the sounds… (only the first time)"}
        </div>
      ) : (
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-2 outline-none" tabIndex={0} onKeyDown={onKey} role="listbox" aria-label="Sound list">
          {list.map((e) => {
            const tag = sampleTag(e.meta);
            const lit = guide.litSoundId === e.id;
            return (
              <div
                key={e.id}
                role="option"
                aria-selected={selected === e.id}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(DRAG_TYPE, e.id);
                  ev.dataTransfer.setData("text/plain", e.name);
                  ev.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => play(e)}
                title={`${e.name} · ${e.sub}. Click to listen, drag onto the arrangement.`}
                className={`flex cursor-grab items-center gap-2 border-l-2 px-3 py-1.5 text-xs ${selected === e.id ? "bg-white/10" : "hover:bg-white/5"} ${lit ? "bg-amber-300/15" : ""}`}
                style={{ borderLeftColor: selected === e.id || lit ? CATEGORY_COLORS[e.category] : "transparent" }}
                data-testid="ksound"
                data-sample-id={e.id}
                data-playing={playing === e.id ? "true" : undefined}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLORS[e.category] }} />
                <span className="min-w-0 flex-1 truncate text-slate-200">{e.name}</span>
                <span className="shrink-0 text-[10px] text-slate-500">{tag ?? e.sub}</span>
                {playing === e.id && <span className="text-[10px] text-emerald-300">▶</span>}
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

/** Ticks from the left edge of a lane, snapped down to the grid (a drop lands on the line at or before the pointer). */
/** "4 beats", "1 bar", "2 bars 1 beat". */
function beatsText(ticks: number) {
  const beats = Math.round(ticks / PPQ);
  const bars = Math.floor(beats / 4);
  const rest = beats % 4;
  const parts = [bars ? `${bars} bar${bars === 1 ? "" : "s"}` : "", rest ? `${rest} beat${rest === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" ") || `${(ticks / PPQ).toFixed(2)} beats`;
}

const snapTo = (ticks: number, grid: number, snap: boolean) => Math.max(0, snap ? Math.floor(ticks / grid) * grid : Math.round(ticks));

/** `ready` is false while the lesson's own workspace is being swapped in (the previous lesson's tracks are hidden). */
/** `scope: "song"` works on the learner's own song (the last card) instead of the lesson's workspace tracks. */
export function StudioPane({ project, guide, ready = true, scope }: { project: Project; guide: StudioGuide; ready?: boolean; scope?: "song" }) {
  const all = scope === "song" ? songView(project) : lessonView(project);
  /** New tracks belong to the lesson workspace, or to the song itself on the last card. */
  const newTrackId = () => (scope === "song" ? `track-${uuid()}` : `${LESSON_TRACK_PREFIX}${uuid()}`);
  const view = ready ? all : { ...all, trackOrder: [], tracks: {} };
  const status = useStore(statusStore);
  const lib = useStore(libraryStore);
  const playing = status?.playing ?? false;
  const songLen = songTicks(project);
  const [grid, setGrid] = useState<number>(() => readJson(paneStore, PANE_KEY, { grid: PPQ, snap: true }).grid);
  const [snap, setSnap] = useState<boolean>(() => readJson(paneStore, PANE_KEY, { grid: PPQ, snap: true }).snap);
  useEffect(() => writeJson(paneStore, PANE_KEY, { grid, snap }), [grid, snap]);
  const [pxPerBar, setPxPerBar] = useState(project.songBars > 12 ? 56 : 110);
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null);
  type Drag = { kind: "move" | "resize"; trackId: string; clipId: string; x0: number; orig: number; start: number; length: number };
  const [drag, setDragState] = useState<Drag | null>(null);
  // The ref sees every pointer event at once (events can arrive before React re-renders); the state draws it.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [message, setMessage] = useState("");
  const tools = guide.tools ?? [];
  const has = (t: Tool) => tools.includes(t) && !guide.readOnly;
  const [lanes, setLanes] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const addTrack = (name: string) => {
    const t = NEW_TRACKS.find((x) => x.name === name);
    if (!t) return;
    const id = newTrackId();
    const clipId = uuid();
    void batch(newTrackOps(t.kind, t.name, t.color, id, clipId), "");
    setSelected({ trackId: id, clipId });
  };
  const rename = () => {
    if (renaming && renaming.name.trim()) void window.daw.dispatch({ type: "updateTrack", trackId: renaming.id, changes: { name: renaming.name.trim().slice(0, 40) } });
    setRenaming(null);
  };
  const exportSong = async () => {
    const r = await window.daw.exportWav();
    setMessage(r.ok ? "Exporting your song: it is saved where you chose." : r.canceled ? "" : `Export failed: ${r.reason ?? "unknown error"}`);
  };
  const [bpm, setBpm] = useState(String(project.tempo));
  useEffect(() => setBpm(String(project.tempo)), [project.tempo]);
  useEffect(() => setPxPerBar(project.songBars > 12 ? 56 : 110), [project.songBars > 12]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = guide.readOnly ?? false;
  const selTrack = selected ? view.tracks[selected.trackId] : undefined;
  const selClip = selTrack && selected ? selTrack.clips[selected.clipId] : undefined;
  useEffect(() => {
    if (selected && !selClip) setSelected(null);
  }, [selected, selClip]);

  const batch = async (ops: OpBody[] | null, refused: string) => {
    if (!ops) return setMessage(refused);
    if (!ops.length) return;
    const r = await window.daw.dispatchBatch(ops);
    setMessage(r.ok ? "" : (r.reason ?? "That did not work."));
  };
  const tickAt = (ev: { clientX: number }, el: HTMLElement) => ((ev.clientX - el.getBoundingClientRect().left) / pxPerBar) * TICKS_PER_BAR;

  const dropSound = (sampleId: string, tick: number, laneTrackId: string | null) => {
    const e = lib.entries.find((x) => x.id === sampleId);
    if (!e) return;
    const r = dropSampleOps(project, { id: e.id, name: e.name, category: e.category, durationSec: e.durationSec, meta: e.meta }, snapTo(tick, grid, snap), laneTrackId, { trackId: newTrackId(), clipId: uuid(), noteId: uuid() }, CATEGORY_COLORS[e.category]);
    if (!r.ok) return setMessage(r.reason);
    void batch(r.ops, "");
    setSelected({ trackId: r.trackId, clipId: r.clipId });
  };
  const onDrop = (ev: React.DragEvent<HTMLDivElement>, laneTrackId: string | null) => {
    const id = ev.dataTransfer.getData(DRAG_TYPE);
    if (!id || readOnly) return;
    ev.preventDefault();
    dropSound(id, tickAt(ev, ev.currentTarget), laneTrackId);
  };
  const allowDrop = (ev: React.DragEvent) => {
    if (!readOnly && ev.dataTransfer.types.includes(DRAG_TYPE)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    }
  };

  const cmdDelete = () => selected && selClip && void batch(deleteClipOps(selected.trackId, selected.clipId), "");
  const cmdDuplicate = () => selTrack && selClip && void batch(duplicateClipOps(selTrack.id, selTrack, selClip, uuid(), uuid, songLen), "No free space on this track for a copy.");
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (readOnly || (ev.target as HTMLElement).closest("input,select")) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === "d") (ev.preventDefault(), cmdDuplicate());
    else if (k === "delete" || k === "backspace") (ev.preventDefault(), cmdDelete());
  };

  const clipDown = (ev: React.PointerEvent, t: Track, c: Clip) => {
    ev.stopPropagation();
    setSelected({ trackId: t.id, clipId: c.id });
    if (readOnly || ev.button !== 0) return;
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      // not a real pointer (keyboard or synthetic): the drag still works while the pointer stays over the clip
    }
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const kind = rect.right - ev.clientX <= RESIZE_PX ? "resize" : "move";
    setDrag({ kind, trackId: t.id, clipId: c.id, x0: ev.clientX, orig: kind === "move" ? c.startTick : c.lengthTicks, start: c.startTick, length: c.lengthTicks });
  };
  const clipMove = (ev: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const raw = drag.orig + ((ev.clientX - drag.x0) / pxPerBar) * TICKS_PER_BAR;
    const snapped = snap ? Math.round(raw / grid) * grid : Math.round(raw);
    if (drag.kind === "move") {
      if (snapped !== drag.start) setDrag({ ...drag, start: Math.max(0, snapped) });
    } else {
      // At least one beat long, and never past the end of the song.
      const length = Math.max(MIN_CLIP_TICKS, Math.min(songLen - drag.start, snapped));
      if (length !== drag.length) setDrag({ ...drag, length });
    }
  };
  const clipUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    const t = view.tracks[drag.trackId];
    const c = t?.clips[drag.clipId];
    setDrag(null);
    if (!t || !c) return;
    if (drag.kind === "move" && drag.start !== c.startTick) void batch(moveClipOps(t.id, t, c, drag.start, songLen), "A clip cannot overlap another clip on the same track.");
    if (drag.kind === "resize" && drag.length !== c.lengthTicks) void batch(resizeClipOps(t.id, t, c, drag.length, songLen), "A clip cannot overlap the next clip on the same track.");
  };
  const laneDouble = (ev: React.MouseEvent<HTMLDivElement>, t: Track) => {
    if (readOnly || t.instrument === "sample") return;
    const start = Math.floor(tickAt(ev, ev.currentTarget) / TICKS_PER_BAR) * TICKS_PER_BAR;
    const id = uuid();
    void batch(newClipOps(t.id, t, id, start, songLen), "There is no free space there.");
    setSelected({ trackId: t.id, clipId: id });
  };

  const commitBpm = () => {
    const v = Math.round(Number(bpm));
    if (Number.isFinite(v) && v >= MIN_BPM && v <= MAX_BPM && v !== project.tempo) void window.daw.dispatch({ type: "setTempo", bpm: v });
    else setBpm(String(project.tempo));
  };

  const bars = project.songBars;
  const width = bars * pxPerBar;
  const tick = Math.min(status?.tick ?? 0, songLen);
  const x = (t: number) => (t / TICKS_PER_BAR) * pxPerBar;
  const overlays = (
    <>
      {guide.litBars && <div className="pointer-events-none absolute top-0 bottom-0 z-[5] bg-amber-300/10 ring-1 ring-amber-300/40" style={{ left: x(barTick(guide.litBars[0])), width: x(barTick(guide.litBars[1] + 1) - barTick(guide.litBars[0])) }} data-testid="klit" />}
      {guide.targets?.map((g, i) => {
        const start = barTick(g.bar, g.beat ?? 1);
        return (
          <div key={i} className="pointer-events-none absolute top-0 bottom-0 z-[6] rounded-md border-2 border-dashed border-emerald-300/70 bg-emerald-300/[0.06]" style={{ left: x(start), width: Math.max(8, x((g.beats ?? 4) * PPQ)) }} data-testid="ktarget">
            <span className="absolute top-1 left-1 rounded bg-emerald-300 px-1 text-[10px] font-semibold whitespace-nowrap text-slate-900">{g.label}</span>
          </div>
        );
      })}
      <div className="pointer-events-none absolute top-0 bottom-0 z-[7] w-px bg-amber-300" style={{ left: x(tick) }} />
    </>
  );
  const gridBg = { backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,.10) 0 1px, transparent 1px ${pxPerBar}px), repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px ${pxPerBar / 4}px)` };
  const editable = selTrack && selClip && selTrack.instrument !== "sample" ? { track: selTrack, clip: selClip } : null;
  /** The faint notes for the selected clip: a ghost for this track's element on the bar where the clip starts. */
  const ghostNotes = (() => {
    if (!editable || !guide.ghosts?.length) return undefined;
    const el = trackElement(editable.track, studioCtx());
    const g = guide.ghosts.find((x) => x.element === el && barTick(x.bar) === editable.clip.startTick);
    return g ? toGuideNotes(g.notes, true) : undefined;
  })();
  const [songBars, setSongBars] = useState(String(project.songBars));
  useEffect(() => setSongBars(String(project.songBars)), [project.songBars]);
  const commitSongBars = () => {
    const v = Math.round(Number(songBars));
    if (Number.isFinite(v) && v >= 1 && v <= 128 && v !== project.songBars) void batch([{ type: "setSongLength", bars: v }], "");
    else setSongBars(String(project.songBars));
  };
  /** The Mixing Special task's levels and pans, put on the tracks by element. */
  const useMix = () => {
    const mix = studioState.mix();
    if (!mix) return setMessage("No saved mix yet: finish the Mixing Special task and press Save my mix.");
    const ops: OpBody[] = [];
    for (const id of view.trackOrder) {
      const m = mix[trackElement(view.tracks[id]!, studioCtx())];
      if (m) ops.push({ type: "updateTrack", trackId: id, changes: { volume: m.volume, pan: m.pan } });
    }
    void batch(ops, "");
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3" data-testid="studio-pane">
      <div className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141c]">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-2.5">
          <button onClick={() => (playing ? window.daw.stop() : window.daw.play())} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/15" aria-label={playing ? "Stop" : "Play"} data-testid="kplay">
            {playing ? "■" : "▶"}
          </button>
          <span className="font-mono text-sm text-slate-200" data-testid="kposition">
            Bar {Math.floor(tick / TICKS_PER_BAR) + 1} · {Math.floor((tick % TICKS_PER_BAR) / PPQ) + 1}
          </span>
          <label className="flex items-center gap-2 text-sm text-slate-400">
            BPM
            <input value={bpm} onChange={(e) => setBpm(e.target.value)} onBlur={commitBpm} onKeyDown={(e) => e.key === "Enter" && commitBpm()} disabled={readOnly} className="w-16 rounded-lg bg-white/5 px-2 py-1 text-slate-100 ring-1 ring-white/10" aria-label="Tempo in BPM" data-testid="kbpm" />
          </label>
          <span className="mx-1 h-6 w-px bg-white/10" />
          <button className={`${btn} ${snap ? "!bg-emerald-400/15 !text-emerald-200" : ""}`} onClick={() => setSnap(!snap)} aria-pressed={snap} data-testid="ksnap">
            Snap {snap ? "on" : "off"}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-slate-400" title="Clips land on these lines: 1 bar = only the start of a bar, 1/4 = every beat, 1/8 and finer = in between">
            Grid
            <select value={grid} onChange={(e) => setGrid(Number(e.target.value))} className="rounded-lg bg-white/5 px-1.5 py-1 text-slate-100" aria-label="Grid size" data-testid="kgrid">
              {GRID_OPTIONS.map((g) => (
                <option key={g.label} value={g.ticks} className="bg-[#12151c]">
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            Zoom
            <input type="range" min={36} max={220} value={pxPerBar} onChange={(e) => setPxPerBar(Number(e.target.value))} className="w-20 accent-violet-400" aria-label="Zoom" />
          </label>
          {has("loop") && (
            <button className={`${btn} ${project.loop ? "!bg-emerald-400/15 !text-emerald-200" : ""}`} onClick={() => void window.daw.dispatch({ type: "setLoop", loop: project.loop ? null : { startTick: 0, endTick: 4 * TICKS_PER_BAR } })} aria-pressed={Boolean(project.loop)} title="Loop: play the first 4 bars over and over" data-testid="kloop">
              Loop {project.loop ? "on" : "off"}
            </button>
          )}
          {has("addTrack") && (
            <select value="" onChange={(e) => addTrack(e.target.value)} className="rounded-lg bg-white/5 px-1.5 py-1 text-xs text-slate-100" aria-label="Add a track" data-testid="kadd-track">
              <option value="">+ Add track…</option>
              {NEW_TRACKS.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.kind === "drums" ? "drums" : "synth"})
                </option>
              ))}
            </select>
          )}
          {has("songLength") && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              Song bars
              <input value={songBars} onChange={(e) => setSongBars(e.target.value)} onBlur={commitSongBars} onKeyDown={(e) => e.key === "Enter" && commitSongBars()} className="w-12 rounded-lg bg-white/5 px-1.5 py-1 text-slate-100 ring-1 ring-white/10" aria-label="Song length in bars" data-testid="ksong-bars" />
            </label>
          )}
          {has("useMix") && (
            <button className={btn} onClick={useMix} title="Put the levels and pans from your Mixing Special task on these tracks" data-testid="kuse-mix">
              Use my mix
            </button>
          )}
          {has("export") && (
            <button className={btn} onClick={() => void exportSong()} title="Render the whole song to a WAV file" data-testid="kexport">
              ⤓ Export WAV
            </button>
          )}
          <span className="ml-auto flex gap-1.5">
            <button className={btn} disabled={readOnly || !selClip} onClick={cmdDuplicate} title="Duplicate the selected clip into the next free space (Ctrl+D)" data-testid="kduplicate">
              Duplicate
            </button>
            <button className={btn} disabled={readOnly || !selClip} onClick={cmdDelete} title="Delete the selected clip (Delete)" data-testid="kdelete">
              Delete
            </button>
          </span>
        </div>

        <div className="flex min-h-0 flex-1">
          <SoundBrowser guide={guide} />
          <div className="min-w-0 flex-1 overflow-auto outline-none" tabIndex={0} onKeyDown={onKeyDown} aria-label="Lesson arrangement" data-testid="karrangement">
            <div style={{ width: HEAD_W + width }} className="relative">
              {/* ruler */}
              <div className="sticky top-0 z-20 flex h-7 border-b border-white/10 bg-[#161a23]">
                <div className="sticky left-0 z-30 shrink-0 border-r border-white/10 bg-[#161a23]" style={{ width: HEAD_W }} />
                <div className="relative cursor-pointer" style={{ width }} onPointerDown={(e) => window.daw.seek(snapTo(tickAt(e, e.currentTarget), grid, true))}>
                  {Array.from({ length: bars }, (_, b) => (
                    <span key={b} className="absolute top-1 text-[11px] text-slate-400" style={{ left: b * pxPerBar + 4 }}>
                      {b + 1}
                    </span>
                  ))}
                </div>
              </div>
              {/* lanes */}
              <div className="relative">
                {view.trackOrder.map((id) => {
                  const t = view.tracks[id]!;
                  const fit = t.sample?.bpm ? t.sample : null;
                  return (
                    <div key={id}>
                    <div className="flex border-b border-white/5" style={{ height: LANE_H }} data-testid={`klane-${id}`}>
                      <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-white/10 bg-[#141821] px-2" style={{ width: HEAD_W }}>
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: t.color }} />
                        {renaming?.id === id ? (
                          <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id, name: e.target.value })} onBlur={rename} onKeyDown={(e) => (e.key === "Enter" ? rename() : e.key === "Escape" && setRenaming(null))} className="min-w-0 flex-1 rounded bg-white/10 px-1 text-xs text-white" aria-label="Track name" data-testid={`krename-${id}`} />
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-xs text-slate-100" title={has("rename") ? `${t.name}: double-click to rename` : t.name} onDoubleClick={() => has("rename") && setRenaming({ id, name: t.name })} data-testid={`kname-${id}`}>
                            {t.name}
                          </span>
                        )}
                        {has("automation") && (
                          <button className={`rounded px-1 text-[11px] ${lanes[id] ? "bg-sky-400/25 text-sky-100" : "bg-white/5 text-slate-400"}`} onClick={() => setLanes({ ...lanes, [id]: !lanes[id] })} aria-pressed={!!lanes[id]} title="Automation lane (filter or volume)" data-testid={`kauto-toggle-${id}`}>
                            ∿
                          </button>
                        )}
                        {fit && (
                          <button className={`rounded px-1 text-[10px] ${fit.fit ? "bg-emerald-400/20 text-emerald-200" : "bg-white/5 text-slate-400"}`} disabled={readOnly} onClick={() => void window.daw.dispatch({ type: "updateSample", trackId: id, changes: { fit: !fit.fit } })} aria-pressed={!!fit.fit} title="Fit the loop to the song tempo" data-testid={`kfit-${id}`}>
                            {fit.fit && fit.bpm !== project.tempo ? `${fit.bpm}→${project.tempo}` : "Fit"}
                          </button>
                        )}
                        <button className={`rounded px-1 text-[10px] ${t.mute ? "bg-amber-400/25 text-amber-100" : "bg-white/5 text-slate-400"}`} disabled={readOnly} onClick={() => void window.daw.dispatch({ type: "updateTrack", trackId: id, changes: { mute: !t.mute } })} aria-pressed={t.mute} title="Mute" data-testid={`kmute-${id}`}>
                          M
                        </button>
                        <button className={`rounded px-1 text-[10px] ${t.solo ? "bg-cyan-400/25 text-cyan-100" : "bg-white/5 text-slate-400"}`} disabled={readOnly} onClick={() => void window.daw.dispatch({ type: "updateTrack", trackId: id, changes: { solo: !t.solo } })} aria-pressed={t.solo} title="Solo" data-testid={`ksolo-${id}`}>
                          S
                        </button>
                        <button className="rounded px-1 text-[11px] text-slate-500 hover:text-rose-300" disabled={readOnly} onClick={() => void batch([{ type: "deleteTrack", trackId: id }], "")} title="Remove this track" aria-label={`Remove ${t.name}`}>
                          ×
                        </button>
                      </div>
                      <div className="relative" style={{ width, ...gridBg }} onDragOver={allowDrop} onDrop={(e) => onDrop(e, id)} onDoubleClick={(e) => laneDouble(e, t)} onPointerDown={() => setSelected(null)}>
                        {Object.values(t.clips).map((c) => {
                          const start = drag?.clipId === c.id ? drag.start : c.startTick;
                          const length = drag?.clipId === c.id ? drag.length : c.lengthTicks;
                          const sel = selected?.clipId === c.id;
                          return (
                            <div
                              key={c.id}
                              onPointerDown={(e) => clipDown(e, t, c)}
                              onPointerMove={clipMove}
                              onPointerUp={clipUp}
                              className={`absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-md px-1.5 text-[11px] font-medium text-white/90 ${sel ? "ring-2 ring-white" : ""} ${t.mute ? "opacity-40" : ""}`}
                              style={{ left: x(start), width: Math.max(6, x(length) - 2), background: `${t.color}55`, borderLeft: `3px solid ${t.color}` }}
                              title={`${c.name ?? "Clip"}: bar ${Math.floor(start / TICKS_PER_BAR) + 1}${start % TICKS_PER_BAR ? `, beat ${Math.floor((start % TICKS_PER_BAR) / PPQ) + 1}` : ""}, ${beatsText(length)} long. Drag to move, drag the right edge to change its length.`}
                              data-testid="kclip"
                              data-clip-id={c.id}
                              data-start={start}
                              data-length={length}
                            >
                              {!readOnly && <span className="absolute top-0 right-0 bottom-0 cursor-ew-resize rounded-r-md" style={{ width: RESIZE_PX, background: `${t.color}aa` }} aria-hidden="true" data-testid="kresize" />}
                              {drag?.clipId === c.id && drag.kind === "resize" && <span className="absolute top-0.5 right-2 rounded bg-black/60 px-1 text-[10px]">{beatsText(length)}</span>}
                              <span className="truncate">{c.name ?? "Clip"}</span>
                              <span className="pointer-events-none absolute inset-x-1 bottom-1 flex h-3 items-end gap-px opacity-70">
                                {Object.values(c.notes)
                                  .slice(0, 400)
                                  .map((n) => (
                                    <span key={n.id} className="absolute bottom-0 w-px bg-white" style={{ left: x(n.startTick), height: `${Math.max(20, (n.velocity / 127) * 100)}%` }} />
                                  ))}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {lanes[id] && <AutomationLane track={t} project={project} width={width} pxPerBar={pxPerBar} grid={grid} snap={snap} readOnly={readOnly} />}
                    </div>
                  );
                })}
                <div className="flex" style={{ height: view.trackOrder.length ? 56 : 150 }}>
                  <div className="sticky left-0 z-10 shrink-0 border-r border-white/10 bg-[#141821]" style={{ width: HEAD_W }} />
                  <div className="relative flex items-center" style={{ width, ...gridBg }} onDragOver={allowDrop} onDrop={(e) => onDrop(e, null)} data-testid="kdrop-new">
                    <span className="pointer-events-none sticky left-3 px-3 text-xs text-slate-500">{readOnly ? "" : "Drop a sound here for a new track"}</span>
                  </div>
                </div>
                <div className="pointer-events-none absolute top-0 bottom-0" style={{ left: HEAD_W, width }}>
                  {overlays}
                </div>
              </div>
            </div>
          </div>
        </div>
        {message && (
          <div className="border-t border-white/10 px-4 py-1.5 text-xs text-rose-200" role="status" data-testid="kmessage">
            {message}
          </div>
        )}
        {!readOnly && <ClipTools project={project} tracks={view.trackOrder.map((id) => view.tracks[id]!)} track={selTrack} clip={selClip} tools={tools} run={(ops, refused) => void batch(ops, refused)} />}
        {has("mixer") && <LessonMixer project={project} tracks={view.trackOrder.map((id) => view.tracks[id]!)} />}
      </div>
      {guide.editNotes &&
        (editable ? (
          <div className="flex h-[400px] flex-col" data-testid="knotes">
            <PianoPane project={project} shown={editable} guide={ghostNotes ? { notes: ghostNotes } : {}} />
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/15 px-4 py-3 text-sm text-slate-400" data-testid="knotes-empty">
            Select a clip on a drum or synth track to edit its notes here.
          </div>
        ))}
    </section>
  );
}
