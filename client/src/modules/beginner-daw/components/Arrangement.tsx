import type { ArrangementClip, DawTrack } from "../types/daw";
import { SECTION_HEADER_HEIGHT, TIMELINE_HEIGHT, TRACK_LANE_HEIGHT } from "../data/mockDaw";
import { Timeline } from "./Timeline";

interface ArrangementProps {
  tracks: DawTrack[];
  clips: ArrangementClip[];
  totalBars: number;
  playheadBar: number;
}

export function Arrangement({
  tracks,
  clips,
  totalBars,
  playheadBar,
}: ArrangementProps) {
  const playheadPercent = ((playheadBar - 1) / totalBars) * 100;
  const clipByTrack = (trackId: string) =>
    clips.filter((clip) => clip.trackId === trackId);

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-[#0e1118]">
      <div
        className="flex items-center justify-between border-b border-white/8 px-3"
        style={{ height: SECTION_HEADER_HEIGHT }}
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            Arrangement
          </p>
          <p className="text-[10px] text-slate-500">Lay out your song from left to right</p>
        </div>
        <span className="text-[10px] text-slate-500">{totalBars} bars</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="relative min-w-[48rem]">
          <div style={{ height: TIMELINE_HEIGHT }}>
            <Timeline totalBars={totalBars} />
          </div>

          {tracks.map((track) => (
            <div
              key={track.id}
              className="relative grid border-b border-white/6"
              style={{
                height: TRACK_LANE_HEIGHT,
                gridTemplateColumns: `repeat(${totalBars}, minmax(3rem, 1fr))`,
              }}
            >
              {Array.from({ length: totalBars }, (_, index) => (
                <div
                  key={`${track.id}-cell-${index}`}
                  className={`border-r ${
                    index % 4 === 0 ? "border-white/12" : "border-white/6"
                  } ${index % 2 === 0 ? "bg-white/[0.015]" : ""}`}
                />
              ))}

              {clipByTrack(track.id).map((clip) => (
                <div
                  key={clip.id}
                  className="absolute top-2 bottom-2 overflow-hidden rounded-md px-2 py-1 shadow-[0_0_12px_rgba(0,0,0,0.25)]"
                  style={{
                    left: `calc((${clip.startBar - 1} / ${totalBars}) * 100%)`,
                    width: `calc((${clip.lengthBars} / ${totalBars}) * 100%)`,
                    backgroundColor: `${track.color}33`,
                    border: `1px solid ${track.color}99`,
                  }}
                >
                  <p className="truncate text-[11px] font-medium text-white">{clip.name}</p>
                  <div
                    className="mt-1 h-3 opacity-70"
                    style={{
                      background: `repeating-linear-gradient(90deg, ${track.color} 0 3px, transparent 3px 7px)`,
                    }}
                  />
                </div>
              ))}
            </div>
          ))}

          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-cyan-300 shadow-[0_0_8px_#22d3ee]"
            style={{ left: `${playheadPercent}%` }}
            aria-hidden="true"
          >
            <span className="absolute -left-1.5 top-0 h-0 w-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-cyan-300" />
          </div>
        </div>
      </div>
    </section>
  );
}
