import type { DawTrack } from "../types/daw";
import { SECTION_HEADER_HEIGHT, TIMELINE_HEIGHT } from "../data/mockDaw";
import { Track } from "./Track";

interface TrackListProps {
  tracks: DawTrack[];
}

export function TrackList({ tracks }: TrackListProps) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-[#12151c]">
      <div
        className="flex items-center justify-between border-b border-white/8 px-3"
        style={{ height: SECTION_HEADER_HEIGHT }}
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            Tracks
          </p>
          <p className="text-[10px] text-slate-500">Song parts</p>
        </div>
      </div>
      <div
        className="border-b border-white/8 bg-[#0e1118]"
        style={{ height: TIMELINE_HEIGHT }}
        aria-hidden="true"
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {tracks.map((track) => (
          <Track key={track.id} track={track} />
        ))}
      </div>
      <div className="border-t border-white/8 p-2">
        <button
          type="button"
          className="w-full rounded-lg border border-dashed border-cyan-400/30 bg-cyan-400/5 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/10"
        >
          + Add Track
        </button>
      </div>
    </section>
  );
}
