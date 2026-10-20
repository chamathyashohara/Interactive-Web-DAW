import { useEffect, useRef, useState } from "react";
import { MAX_BPM, MIN_BPM, sortedClips } from "@daw/shared";
import { Arrangement } from "./components/Arrangement";
import { Mixer } from "./components/Mixer";
import { TRACK_ROW_H } from "./components/TrackHeader";
import { DEFAULT_ROW_H, GRID_OPTIONS, MAX_ROW_H, MIN_ROW_H } from "./pianoRoll/geometry";
import { PianoRoll, type Tool } from "./pianoRoll/PianoRoll";
import { LearnView } from "./features/lessons/LearnView";
import { engineStateStore, exportStore, projectStore, statusStore, useStore } from "./store";

const TOOLS: { id: Tool; label: string; key: string; title: string }[] = [
  { id: "draw", label: "Draw", key: "D", title: "Draw notes (D): click, or click and drag to set length" },
  { id: "paint", label: "Paint", key: "P", title: "Paint a row of notes by dragging (P)" },
  { id: "select", label: "Select", key: "S", title: "Select, move, resize; drag on empty space to box-select (S)" },
  { id: "delete", label: "Delete", key: "E", title: "Delete notes by clicking or dragging over them (E). Right-click also deletes." },
  { id: "mute", label: "Mute", key: "M", title: "Click a note to mute or unmute it (M)" },
  { id: "slice", label: "Slice", key: "C", title: "Click a note to cut it in two at the snapped position (C)" },
];

const btn = "rounded-md px-2.5 py-1 text-xs font-medium transition-colors";
const idle = "bg-white/5 text-slate-300 hover:bg-white/10";
const active = "bg-cyan-400/20 text-cyan-200 ring-1 ring-cyan-400/40";

function TempoField({ tempo }: { tempo: number }) {
  const [draft, setDraft] = useState(String(tempo));
  useEffect(() => setDraft(String(tempo)), [tempo]);
  const commit = () => {
    const v = Math.round(Number(draft));
    if (Number.isFinite(v) && v >= MIN_BPM && v <= MAX_BPM && v !== tempo) void window.daw.dispatch({ type: "setTempo", bpm: v }, "tempo");
    else setDraft(String(tempo));
  };
  return (
    <label className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs">
      <span className="text-slate-400">BPM</span>
      <input
        type="number"
        min={MIN_BPM}
        max={MAX_BPM}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-14 bg-transparent text-right font-mono text-amber-300 outline-none"
        aria-label="Tempo"
      />
    </label>
  );
}

function ExportChip() {
  const ex = useStore(exportStore);
  if (!ex) return null;
  const name = (p: string) => p.split(/[\/]/).pop();
  return (
    <span className="flex items-center gap-2" data-testid="export-chip" data-state={ex.state}>
      {ex.state === "running" && (
        <>
          <span className="text-cyan-300">Exporting… {Math.round(ex.fraction * 100)}%</span>
          <span className="h-1.5 w-24 overflow-hidden rounded bg-white/10"><span className="block h-full bg-cyan-400" style={{ width: `${ex.fraction * 100}%` }} /></span>
        </>
      )}
      {ex.state === "done" && (
        <>
          <span className="text-emerald-300">Saved {name(ex.path)} ({ex.seconds.toFixed(1)} s)</span>
          <button className="rounded bg-white/5 px-2 py-0.5 text-slate-300 hover:bg-white/10" onClick={() => window.daw.showInFolder(ex.path)}>Show in folder</button>
          <button className="text-slate-500 hover:text-slate-300" onClick={() => exportStore.set(null)} aria-label="Dismiss">×</button>
        </>
      )}
      {ex.state === "error" && (
        <>
          <span className="text-rose-300">Export failed: {ex.message}</span>
          <button className="text-slate-500 hover:text-slate-300" onClick={() => exportStore.set(null)} aria-label="Dismiss">×</button>
        </>
      )}
    </span>
  );
}

function StatusBar() {
  const engine = useStore(engineStateStore);
  const status = useStore(statusStore);
  const info = engine.info;
  return (
    <footer className="flex items-center gap-4 border-t border-white/10 bg-[#0b0e14] px-3 py-1.5 text-[11px] text-slate-400">
      <span className={`flex items-center gap-1.5 ${engine.connected ? "text-emerald-300" : "text-rose-300"}`} title={engine.lastError ?? undefined} data-testid="engine-chip">
        <span className={`h-2 w-2 rounded-full ${engine.connected ? "bg-emerald-400" : "bg-rose-400"}`} />
        {engine.connected ? "Engine connected" : "Engine disconnected"}
      </span>
      {info && (
        <span>
          {info.deviceType}: {info.device} · {info.sampleRate} Hz · buffer {info.bufferSize}
        </span>
      )}
      {status && (
        <span data-testid="diag">
          callbacks {status.callbacks} · overruns <b className={status.overruns ? "text-rose-300" : "text-emerald-300"}>{status.overruns}</b> · peak load {(status.peakLoad * 100).toFixed(1)}% · xruns {status.xruns}
        </span>
      )}
      <ExportChip />
      <span className="ml-auto flex items-center gap-2">
        <span className="text-slate-500">Autosaved locally</span>
        <button
          className={`${btn} ${idle}`}
          title="Diagnostics: block the UI thread for 500 ms (audio must not glitch)"
          onClick={() => {
            const t = performance.now();
            while (performance.now() - t < 500) {
              /* busy wait */
            }
          }}
        >
          Freeze UI 500 ms
        </button>
        <button className={`${btn} ${idle}`} title="Diagnostics: kill the engine process (it should restart)" onClick={() => window.daw.killEngine()}>
          Kill engine
        </button>
      </span>
    </footer>
  );
}

export function App() {
  const { project, canUndo, canRedo } = useStore(projectStore);
  const status = useStore(statusStore);
  const [tool, setTool] = useState<Tool>("draw");
  const [snap, setSnap] = useState(true);
  const [gridTicks, setGridTicks] = useState<number>(GRID_OPTIONS[2].ticks);
  const [pxPerBeat, setPxPerBeat] = useState(120);
  const [rowH, setRowH] = useState(DEFAULT_ROW_H);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [focus, setFocus] = useState<"arrangement" | "pianoroll">("pianoroll");
  const playing = useRef(false);
  playing.current = status?.playing ?? false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void window.daw.redo();
        else void window.daw.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void window.daw.redo();
      } else if (e.code === "Space" && !typing) {
        e.preventDefault();
        if (playing.current) window.daw.stop();
        else window.daw.play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!project) return null;
  // The selected track may have just been deleted (or not exist yet): fall back to the first track.
  const track = project.tracks[selectedTrackId] ?? project.tracks[project.trackOrder[0]!]!;
  // The clip shown in the piano roll: the selected one, else the track's first clip (there may be none).
  const clip = (selectedClipId ? track.clips[selectedClipId] : undefined) ?? sortedClips(track)[0];
  const selectTrackClip = (trackId: string, clipId: string | null) => {
    setSelectedTrackId(trackId);
    setSelectedClipId(clipId);
  };
  const arrHeight = Math.max(150, Math.min(300, 32 + 24 + (project.trackOrder.length + 1) * TRACK_ROW_H));
  const exportWav = async () => {
    const r = await window.daw.exportWav();
    if (!r.ok && !r.canceled) exportStore.set({ state: "error", id: "-", message: r.reason ?? "unknown error" });
  };
  // The lessons take over the whole window; the studio stays mounted-state-wise (selection, zoom) in App.
  if (lessonsOpen) return <LearnView project={project} onOpenClip={selectTrackClip} onExit={() => setLessonsOpen(false)} />;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#12151c] px-3 py-2">
        <div className="mr-2 text-sm font-semibold text-amber-300">
          Collab<span className="text-slate-200">DAW</span>
        </div>

        <div className="flex gap-1">
          <button className={`${btn} ${status?.playing ? active : "bg-amber-400/90 text-slate-900 hover:bg-amber-300"}`} onClick={() => window.daw.play()} title="Play (Space)">
            ▶ Play
          </button>
          <button className={`${btn} ${idle}`} onClick={() => window.daw.stop()} title="Stop and return to start (Space)">
            ■ Stop
          </button>
        </div>
        <TempoField tempo={project.tempo} />

        <div className="mx-1 h-5 w-px bg-white/10" />
        <div className="flex gap-1" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`${btn} ${tool === t.id ? active : idle}`} onClick={() => setTool(t.id)} title={t.title} aria-pressed={tool === t.id} data-tool={t.id}>
              {t.label} <span className="ml-0.5 text-[9px] text-slate-500">{t.key}</span>
            </button>
          ))}
        </div>

        <div className="mx-1 h-5 w-px bg-white/10" />
        <button className={`${btn} ${snap ? active : idle}`} onClick={() => setSnap(!snap)} title="Snap to grid" aria-pressed={snap}>
          ⌖ Snap
        </button>
        <select value={gridTicks} onChange={(e) => setGridTicks(Number(e.target.value))} className="rounded-md bg-white/5 px-2 py-1 text-xs text-slate-200 outline-none" aria-label="Grid size">
          {GRID_OPTIONS.map((g) => (
            <option key={g.label} value={g.ticks} className="bg-[#12151c]">
              {g.label}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          Zoom H
          <input type="range" min={40} max={400} value={pxPerBeat} onChange={(e) => setPxPerBeat(Number(e.target.value))} className="w-20 accent-cyan-400" aria-label="Horizontal zoom" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          V
          <input type="range" min={MIN_ROW_H} max={MAX_ROW_H} value={rowH} onChange={(e) => setRowH(Number(e.target.value))} className="w-16 accent-cyan-400" aria-label="Vertical zoom" />
        </label>

        <div className="ml-auto flex gap-1">
          <button className={`${btn} ${idle}`} onClick={() => void exportWav()} title="Render the whole song to a WAV file" data-testid="export-wav">
            ⤓ Export WAV
          </button>
          <button className={`${btn} ${idle}`} onClick={() => setLessonsOpen(true)} title="Open the lessons" data-testid="lessons-toggle">
            Lessons
          </button>
          <button className={`${btn} ${mixerOpen ? active : idle}`} onClick={() => setMixerOpen(!mixerOpen)} aria-pressed={mixerOpen} title="Show or hide the mixer">
            Mixer
          </button>
          <button className={`${btn} ${idle} disabled:opacity-40`} disabled={!canUndo} onClick={() => void window.daw.undo()} title="Undo (Ctrl+Z)">
            ↶ Undo
          </button>
          <button className={`${btn} ${idle} disabled:opacity-40`} disabled={!canRedo} onClick={() => void window.daw.redo()} title="Redo (Ctrl+Y)">
            ↷ Redo
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div onPointerDownCapture={() => setFocus("arrangement")}>
          <Arrangement project={project} selectedTrackId={track.id} selectedClipId={clip?.id ?? null} snap={snap} keysEnabled={focus === "arrangement"} height={arrHeight} onSelect={selectTrackClip} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col" onPointerDownCapture={() => setFocus("pianoroll")}>
          {clip ? (
            <PianoRoll key={`${track.id}/${clip.id}`} track={track} clip={clip} keysEnabled={focus === "pianoroll"} tool={tool} snap={snap} gridTicks={gridTicks} pxPerBeat={pxPerBeat} rowH={rowH} onTool={setTool} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500" data-testid="no-clip">
              This track has no clips. Double-click its lane in the arrangement, or press “+ Clip”, to add one.
            </div>
          )}
        </div>
      </div>
      {mixerOpen &&<Mixer project={project} selectedId={track.id} onSelect={setSelectedTrackId} />}
      <StatusBar />
    </div>
  );
}
