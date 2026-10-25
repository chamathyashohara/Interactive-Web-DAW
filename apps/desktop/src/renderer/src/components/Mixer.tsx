import type { Project, TrackFields } from "@daw/shared";
import { useUnlock } from "../unlock/useUnlock";
import { Fader } from "../controls/Fader";
import { Knob } from "../controls/Knob";
import { Meter, volumeToDb } from "./Meter";
import { MixAssist, MixBadge, dbText, useMixReport } from "./MixAssist";

const update = (trackId: string, changes: Partial<TrackFields>, group?: string) => void window.daw.dispatch({ type: "updateTrack", trackId, changes }, group);
const mini = "hw-btn h-6 w-6 text-[11px] font-bold";

function panLabel(pan: number) {
  if (pan === 0) return "C";
  return pan < 0 ? `L${-pan}` : `R${pan}`;
}

export function Mixer({ project, selectedId, onSelect }: { project: Project; selectedId: string; onSelect: (id: string) => void }) {
  const unlock = useUnlock();
  const muteSoloLocked = !unlock.can("mixer.muteSolo");
  const report = useMixReport(project);
  const master = report.master;
  return (
    <section className="hw-panel-deep hw-screws relative flex h-[226px] shrink-0 border-t border-black" data-testid="mixer">
      <div className="flex min-w-0 flex-1 gap-px overflow-x-auto">
        {project.trackOrder.map((id) => {
          const t = project.tracks[id]!;
          return (
            <div
              key={id}
              data-testid="mixer-strip"
              data-track-id={id}
              onPointerDown={() => onSelect(id)}
              data-selected={id === selectedId ? "true" : undefined}
              className="hw-strip flex w-[88px] shrink-0 flex-col items-center gap-1 border-r border-black px-1.5 pt-1.5 pb-2"
              style={{ borderTop: `3px solid ${t.color}` }}
            >
              <div className="flex w-full items-center justify-center gap-1">
                <div className="hw-legend min-w-0 truncate text-center !text-[10px] font-semibold !text-slate-300" title={t.name}>{t.name}</div>
                <MixBadge finding={report.findings.find((f) => f.trackId === id)} />
              </div>
              <div className="flex w-full items-center justify-center gap-1.5">
                <Knob value={t.pan} min={-100} max={100} defaultValue={0} bipolar size={28} color={t.color} onChange={(v) => update(id, { pan: v }, `pan-${id}`)} label={`Pan of ${t.name}`} title="Pan: drag up or down, double-click to centre" />
                <span className="hw-legend w-6 text-left !text-[10px]" data-testid="pan-label">{panLabel(t.pan)}</span>
              </div>
              <div className="flex flex-1 items-stretch gap-1.5">
                <Fader value={t.volume} min={0} max={100} scale color={t.color} onChange={(v) => update(id, { volume: v }, `vol-${id}`)} label={`Fader of ${t.name}`} />
                <Meter className="h-[112px]" color={t.color} testId={`meter-${id}`} read={(s) => s?.levels[id] ?? 0} />
              </div>
              <div className="hw-lcd px-1.5 py-px text-[10px]">{volumeToDb(t.volume)} dB</div>
              <div className="flex gap-1.5">
                <button className={`${mini}`} onClick={() => update(id, { mute: !t.mute })} aria-label={`Mixer mute ${t.name}`} aria-pressed={t.mute} disabled={muteSoloLocked} title={unlock.reason("mixer.muteSolo") ?? "Mute"}>M</button>
                <button className={`${mini} hw-teal`} onClick={() => update(id, { solo: !t.solo })} aria-label={`Mixer solo ${t.name}`} aria-pressed={t.solo} disabled={muteSoloLocked} title={unlock.reason("mixer.muteSolo") ?? "Solo"}>S</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Master */}
      <div className="hw-strip flex w-[96px] shrink-0 flex-col items-center gap-1 border-l border-black px-2 pt-1.5 pb-2" style={{ borderTop: "3px solid #fcd34d" }} data-testid="master-strip">
        <div className="hw-legend !text-[10px] font-semibold !text-amber-300">MASTER</div>
        <div
          className={`hw-lcd w-full px-1 py-px text-center text-[10px] ${master?.state === "clipping" || master?.state === "above-warning" ? "!text-red-400" : ""}`}
          title="Master sample peak from the last playback, before the soft clip"
          data-testid="master-peak"
          data-state={master?.state ?? "none"}
        >
          {master ? `pk ${dbText(master.prePeakDb)}` : "pk --"}
        </div>
        <div className="flex flex-1 items-stretch gap-1.5">
          <Fader value={project.masterVolume} min={0} max={100} scale color="#fcd34d" onChange={(v) => void window.daw.dispatch({ type: "setMasterVolume", volume: v }, "master")} label="Master volume" testId="master-fader" />
          <Meter className="h-[112px]" color="#fcd34d" testId="meter-master-l" read={(s) => s?.masterL ?? 0} />
          <Meter className="h-[112px]" color="#fcd34d" testId="meter-master-r" read={(s) => s?.masterR ?? 0} />
        </div>
        <div className="hw-lcd px-1.5 py-px text-[10px]">{volumeToDb(project.masterVolume)} dB</div>
      </div>
      <MixAssist project={project} report={report} selectedId={selectedId} />
    </section>
  );
}
