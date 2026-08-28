import type { DawTrack } from "../types/daw";
import { TRACK_LANE_HEIGHT } from "../data/mockDaw";
import { TrackIcon } from "./TrackIcon";

interface TrackProps {
  track: DawTrack;
}

export function Track({ track }: TrackProps) {
  return (
    <div
      className="flex items-center gap-2 border-b border-white/6 px-2"
      style={{ height: TRACK_LANE_HEIGHT }}
    >
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-slate-950"
        style={{ backgroundColor: track.color }}
      >
        {track.number}
      </span>
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-black/30"
        style={{ color: track.color }}
      >
        <TrackIcon kind={track.kind} color={track.color} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-white">{track.name}</p>
        <input
          type="range"
          min={0}
          max={100}
          defaultValue={track.volume}
          aria-label={`${track.name} volume`}
          className="mt-1 w-full accent-cyan-400"
        />
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <button
          type="button"
          aria-label={`Mute ${track.name}`}
          title="Mute"
          className={`h-5 w-5 rounded text-[10px] font-bold ${
            track.muted
              ? "bg-amber-400/20 text-amber-300"
              : "bg-white/6 text-slate-400 hover:text-white"
          }`}
        >
          M
        </button>
        <button
          type="button"
          aria-label={`Solo ${track.name}`}
          title="Solo"
          className={`h-5 w-5 rounded text-[10px] font-bold ${
            track.solo
              ? "bg-cyan-400/20 text-cyan-300"
              : "bg-white/6 text-slate-400 hover:text-white"
          }`}
        >
          S
        </button>
      </div>
    </div>
  );
}
