import { mockDaw } from "../data/mockDaw";
import { Arrangement } from "./Arrangement";
import { Browser } from "./Browser";
import { EffectsRack } from "./EffectsRack";
import { MasterSection } from "./MasterSection";
import { PianoRoll } from "./PianoRoll";
import { ProjectPanel } from "./ProjectPanel";
import { TopBar } from "./TopBar";
import { TrackList } from "./TrackList";

const NAV_ITEMS = [
  { id: "studio", label: "Studio", active: true },
  { id: "sounds", label: "Sounds", active: false },
  { id: "learn", label: "Learn", active: false },
];

export function DAWWorkspace() {
  const { project, tracks, clips, notes, browserItems, effects, totalBars, playheadBar } =
    mockDaw;

  return (
    <div className="daw-workspace flex h-full min-h-0 min-w-[1100px] flex-col gap-2 bg-[#07080c] p-2 text-slate-200">
      <TopBar project={project} />

      <div className="grid min-h-0 flex-1 grid-cols-[3rem_15.5rem_minmax(0,1fr)_17rem] grid-rows-[minmax(0,1fr)_18.5rem] gap-2">
        <nav className="row-span-2 flex flex-col items-center gap-2 rounded-xl border border-white/8 bg-[#12151c] py-3">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={item.label}
              className={`flex h-9 w-9 items-center justify-center rounded-lg text-[10px] font-semibold ${
                item.active
                  ? "bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-400/30"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
            >
              {item.label.slice(0, 2)}
            </button>
          ))}
        </nav>

        <TrackList tracks={tracks} />
        <Arrangement
          tracks={tracks}
          clips={clips}
          totalBars={totalBars}
          playheadBar={playheadBar}
        />
        <ProjectPanel project={project} />
        <Browser items={browserItems} />
        <PianoRoll notes={notes} playheadBar={playheadBar} />

        <div className="flex min-h-0 flex-col gap-2">
          <MasterSection volume={project.masterVolume} dbDisplay={project.masterDb} />
          <EffectsRack effects={effects} />
        </div>
      </div>
    </div>
  );
}
