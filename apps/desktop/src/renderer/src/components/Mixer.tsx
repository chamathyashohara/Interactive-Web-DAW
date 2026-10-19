import type { Project, TrackFields } from "@daw/shared";
import { Meter, volumeToDb } from "./Meter";

const update = (trackId: string, changes: Partial<TrackFields>, group?: string) => void window.daw.dispatch({ type: "updateTrack", trackId, changes }, group);
const mini = "h-6 w-6 rounded text-[11px] font-bold transition-colors";
const fader = { writingMode: "vertical-lr", direction: "rtl", width: 22, height: 112 } as const;

function panLabel(pan: number) {
  if (pan === 0) return "C";
  return pan < 0 ? `L${-pan}` : `R${pan}`;
}

export function Mixer({ project, selectedId, onSelect }: { project: Project; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <section className="flex h-[212px] shrink-0 border-t border-white/10 bg-[#10131a]" data-testid="mixer">
      <div className="flex min-w-0 flex-1 gap-px overflow-x-auto">
        {project.trackOrder.map((id) => {
          const t = project.tracks[id]!;
          return (
            <div
              key={id}
              data-testid="mixer-strip"
              data-track-id={id}
              onPointerDown={() => onSelect(id)}
              className={`flex w-[88px] shrink-0 flex-col items-center gap-1 border-r border-white/5 px-1.5 pt-1.5 pb-2 ${id === selectedId ? "bg-white/[0.05]" : ""}`}
              style={{ borderTop: `3px solid ${t.color}` }}
            >
              <div className="w-full truncate text-center text-[10px] font-medium text-slate-300" title={t.name}>{t.name}</div>
              <div className="flex w-full items-center gap-1">
                <input type="range" min={-100} max={100} value={t.pan} onChange={(e) => update(id, { pan: Number(e.target.value) }, `pan-${id}`)} onDoubleClick={() => update(id, { pan: 0 })} className="h-1 min-w-0 flex-1" style={{ accentColor: t.color }} aria-label={`Pan of ${t.name}`} title="Pan (double-click to centre)" />
                <span className="w-6 text-right text-[9px] text-slate-500" data-testid="pan-label">{panLabel(t.pan)}</span>
              </div>
              <div className="flex flex-1 items-stretch gap-1.5">
                <input type="range" min={0} max={100} value={t.volume} onChange={(e) => update(id, { volume: Number(e.target.value) }, `vol-${id}`)} style={{ ...fader, accentColor: t.color }} aria-label={`Fader of ${t.name}`} />
                <Meter className="h-[112px]" color={t.color} testId={`meter-${id}`} read={(s) => s?.levels[id] ?? 0} />
              </div>
              <div className="text-[9px] text-slate-500">{volumeToDb(t.volume)} dB</div>
              <div className="flex gap-1">
                <button className={`${mini} ${t.mute ? "bg-amber-400 text-slate-900" : "bg-white/5 text-slate-400 hover:bg-white/10"}`} onClick={() => update(id, { mute: !t.mute })} aria-label={`Mixer mute ${t.name}`} aria-pressed={t.mute}>M</button>
                <button className={`${mini} ${t.solo ? "bg-cyan-400 text-slate-900" : "bg-white/5 text-slate-400 hover:bg-white/10"}`} onClick={() => update(id, { solo: !t.solo })} aria-label={`Mixer solo ${t.name}`} aria-pressed={t.solo}>S</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Master */}
      <div className="flex w-[96px] shrink-0 flex-col items-center gap-1 border-l border-white/15 bg-[#151922] px-2 pt-1.5 pb-2" style={{ borderTop: "3px solid #fcd34d" }} data-testid="master-strip">
        <div className="text-[10px] font-semibold text-amber-300">MASTER</div>
        <div className="h-4" />
        <div className="flex flex-1 items-stretch gap-1.5">
          <input type="range" min={0} max={100} value={project.masterVolume} onChange={(e) => void window.daw.dispatch({ type: "setMasterVolume", volume: Number(e.target.value) }, "master")} style={{ ...fader, accentColor: "#fcd34d" }} aria-label="Master volume" data-testid="master-fader" />
          <Meter className="h-[112px]" color="#fcd34d" testId="meter-master-l" read={(s) => s?.masterL ?? 0} />
          <Meter className="h-[112px]" color="#fcd34d" testId="meter-master-r" read={(s) => s?.masterR ?? 0} />
        </div>
        <div className="text-[9px] text-slate-500">{volumeToDb(project.masterVolume)} dB</div>
      </div>
    </section>
  );
}
