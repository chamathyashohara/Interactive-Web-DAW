import { memo, useRef } from "react";
import { formatBarBeat, tapTempo } from "@daw/shared";
import { statusStore, useStore } from "../store";

/** Where the playhead is, as bar.beat.sixteenth (like the position display on a drum machine). */
export const BarBeatReadout = memo(function BarBeatReadout({ ppq }: { ppq: number }) {
  const status = useStore(statusStore);
  return (
    <div className="hw-lcd flex items-center gap-1.5 px-2 py-1" title="Position: bar . beat . sixteenth" data-testid="bar-beat">
      <span className="hw-legend !text-[9px] !text-amber-200/60">POS</span>
      <span className="w-[4.2rem] text-right font-mono text-base leading-none text-[#ffbf5a]">{formatBarBeat(status?.tick ?? 0, ppq)}</span>
    </div>
  );
});

/** Tap this in time with a song to set the tempo. A pause of two seconds starts over. */
export function TapTempoButton({ className = "" }: { className?: string }) {
  const taps = useRef<number[]>([]);
  const tap = () => {
    taps.current = [...taps.current.slice(-15), performance.now()];
    const bpm = tapTempo(taps.current);
    if (bpm !== null) void window.daw.dispatch({ type: "setTempo", bpm: Math.round(bpm) }, "tempo"); // the tempo box works in whole BPM
  };
  return (
    <button className={`hw-btn px-2 py-1 text-xs ${className}`} onPointerDown={(e) => e.button === 0 && tap()} onClick={(e) => e.detail === 0 && tap()} title="Tap tempo: tap along with the beat (at least twice)" data-testid="tap-tempo">
      TAP
    </button>
  );
}
