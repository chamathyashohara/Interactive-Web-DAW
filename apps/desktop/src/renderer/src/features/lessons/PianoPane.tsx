import { useEffect, useState } from "react";
import { MAX_BPM, MIN_BPM, PPQ, songTicks, type Project } from "@daw/shared";
import { DEFAULT_ROW_H, GRID_OPTIONS } from "../../pianoRoll/geometry";
import { PianoRoll, type Tool } from "../../pianoRoll/PianoRoll";
import { engineStateStore, statusStore, useStore } from "../../store";
import { BrushIcon, CursorIcon, EraserIcon, MuteIcon, PencilIcon, PlayIcon, ScissorsIcon, StopIcon } from "./Icons";
import type { ExerciseState } from "./useExercise";

const TOOLS: { id: Tool; label: string; key: string; Icon: (p: { size?: number }) => React.JSX.Element }[] = [
  { id: "select", label: "Select", key: "S", Icon: CursorIcon },
  { id: "draw", label: "Draw", key: "D", Icon: PencilIcon },
  { id: "paint", label: "Paint", key: "P", Icon: BrushIcon },
  { id: "delete", label: "Delete", key: "E", Icon: EraserIcon },
  { id: "mute", label: "Mute", key: "M", Icon: MuteIcon },
  { id: "slice", label: "Slice", key: "C", Icon: ScissorsIcon },
];

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function TempoInput({ tempo }: { tempo: number }) {
  const [draft, setDraft] = useState(String(tempo));
  useEffect(() => setDraft(String(tempo)), [tempo]);
  const commit = () => {
    const v = Math.round(Number(draft));
    if (Number.isFinite(v) && v >= MIN_BPM && v <= MAX_BPM && v !== tempo) void window.daw.dispatch({ type: "setTempo", bpm: v }, "tempo");
    else setDraft(String(tempo));
  };
  return (
    <label className="flex items-center gap-2 text-sm text-slate-400">
      Tempo
      <input
        type="number"
        min={MIN_BPM}
        max={MAX_BPM}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-16 rounded-lg bg-white/5 px-2 py-1.5 text-center text-slate-100 outline-none ring-1 ring-white/10 focus:ring-violet-400/60"
        aria-label="Tempo"
      />
      <span className="text-xs text-slate-500">BPM</span>
    </label>
  );
}

/** Right-hand pane of the Learn view: transport, editing tools and the DAW's real piano roll on the exercise clip. */
export function PianoPane({ xs, project, onStart }: { xs: ExerciseState; project: Project; onStart: () => void }) {
  const status = useStore(statusStore);
  const engine = useStore(engineStateStore);
  const [tool, setTool] = useState<Tool>("draw");
  const [snap, setSnap] = useState(true);
  const [gridTicks, setGridTicks] = useState<number>(GRID_OPTIONS[1].ticks);
  const [pxPerBeat, setPxPerBeat] = useState(62);
  const playing = status?.playing ?? false;
  const songLen = songTicks(project);
  const toSeconds = (ticks: number) => (ticks * 60) / project.tempo / PPQ;
  const tick = Math.min(status?.tick ?? 0, songLen);

  const play = () => {
    if (playing) return window.daw.stop();
    if (xs.found) window.daw.seek(xs.found.clip.startTick);
    window.daw.play();
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141c]" data-testid="learn-piano">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 px-4 py-3">
        <button
          onClick={play}
          disabled={!engine.connected}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:opacity-40"
          title={engine.connected ? (playing ? "Stop (Space)" : "Play from the exercise (Space)") : "The audio engine is offline: use Listen in Practice"}
          aria-label={playing ? "Stop" : "Play"}
          data-testid="learn-play"
        >
          {playing ? <StopIcon size={20} /> : <PlayIcon size={22} />}
        </button>
        <span className="font-mono text-sm text-slate-300">
          {clock(toSeconds(tick))} / {clock(toSeconds(songLen))}
        </span>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-slate-300" style={{ width: `${(tick / songLen) * 100}%` }} />
        </div>
        <TempoInput tempo={project.tempo} />

        <div className="ml-auto flex items-center gap-1.5" role="toolbar" aria-label="Piano roll tools">
          {TOOLS.map(({ id, label, key, Icon }) => (
            <button
              key={id}
              onClick={() => setTool(id)}
              aria-pressed={tool === id}
              title={`${label} (${key})`}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${tool === id ? "bg-violet-600 text-white shadow-md shadow-violet-600/30" : "bg-white/5 text-slate-300 hover:bg-white/10"}`}
              data-tool={id}
            >
              <Icon size={17} />
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-1.5 text-xs text-slate-400">
        <button className={`rounded-md px-2 py-0.5 ${snap ? "bg-emerald-400/15 text-emerald-200" : "bg-white/5"}`} onClick={() => setSnap(!snap)} aria-pressed={snap}>
          Snap {snap ? "on" : "off"}
        </button>
        <label className="flex items-center gap-1.5">
          Grid
          <select value={gridTicks} onChange={(e) => setGridTicks(Number(e.target.value))} className="rounded-md bg-white/5 px-1.5 py-0.5 text-slate-200 outline-none" aria-label="Grid size">
            {GRID_OPTIONS.map((g) => (
              <option key={g.label} value={g.ticks} className="bg-[#12151c]">
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Zoom
          <input type="range" min={40} max={300} value={pxPerBeat} onChange={(e) => setPxPerBeat(Number(e.target.value))} className="w-24 accent-violet-400" aria-label="Zoom" />
        </label>
        {!engine.connected && <span className="ml-auto rounded-md bg-amber-400/10 px-2 py-0.5 text-amber-200">Audio engine offline · use Listen in Practice</span>}
      </div>

      {xs.found ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <PianoRoll key={`${xs.found.trackId}/${xs.found.clipId}`} track={xs.found.track} clip={xs.found.clip} keysEnabled tool={tool} snap={snap} gridTicks={gridTicks} pxPerBeat={pxPerBeat} rowH={DEFAULT_ROW_H} onTool={setTool} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="grid grid-cols-4 gap-1 opacity-60">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <span key={i} className="h-3 w-10 rounded-sm" style={{ background: i % 3 === 0 ? "#8b5cf6" : "rgba(255,255,255,.08)" }} />
            ))}
          </div>
          <p className="max-w-xs text-sm text-slate-400">{xs.removed ? "The exercise was removed (maybe by Undo). Start it again to continue." : "Your exercise opens here, in the same piano roll you use in the studio."}</p>
          <button onClick={onStart} className="rounded-xl bg-emerald-300 px-5 py-2 text-sm font-semibold text-slate-900 hover:bg-emerald-200" data-testid="learn-start">
            {xs.removed ? "Restart practice" : "Start practice"}
          </button>
        </div>
      )}
    </section>
  );
}
