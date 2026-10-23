import { memo, useState } from "react";
import { isInKey, isTonic, type ProjectKey } from "@daw/shared";
import { DRUM_NAMES, PITCH_MAX, PITCH_MIN, isBlackKey, pitchLabel } from "./geometry";

const PITCHES = Array.from({ length: PITCH_MAX - PITCH_MIN + 1 }, (_, i) => PITCH_MAX - i);

const WHITE = "#eef1f6";
const WHITE_PRESSED = "#7dd3fc";
const EDGE = "#8d97a8"; // line between neighbouring white keys
const BLACK = "linear-gradient(180deg, #2b3040 0%, #14161d 100%)";
const BLACK_PRESSED = "linear-gradient(180deg, #0ea5e9 0%, #0284c7 100%)";
const BLACK_WIDTH = "60%"; // black keys cover the left 60% of the keyboard, like a real piano

interface Props {
  trackId: string;
  isDrums: boolean;
  rowH: number;
  /** When set, keys in the key get a coloured edge (brighter on the root) so beginners see where the safe notes are. */
  musicKey?: ProjectKey | null;
  /** Keys lit up by a lesson while a demonstration plays them. */
  activeKeys?: number[];
}

/**
 * The keyboard on the left of the piano roll. Melodic tracks get a real-piano look: white keys with thin dividers,
 * black keys as short bars over their left side, and the octave label ("C4") on each C. Drum tracks list the drum
 * names instead. Pressing a key previews that pitch on the track's instrument.
 */
export const PianoKeys = memo(function PianoKeys({ trackId, isDrums, rowH, musicKey = null, activeKeys }: Props) {
  const [pressed, setPressed] = useState<number | null>(null);

  const down = (e: React.PointerEvent<HTMLDivElement>, p: number) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPressed(p);
    window.daw.preview(trackId, p, 100, true);
  };
  const up = (p: number) => {
    setPressed(null);
    window.daw.preview(trackId, p, 100, false);
  };

  return (
    <>
      {PITCHES.map((p) => {
        const lit = activeKeys?.includes(p) ?? false;
        const isPressed = pressed === p || lit;
        const active = lit ? { "data-active": "true" } : {};
        const handlers = { onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => down(e, p), onPointerUp: () => up(p), onPointerCancel: () => up(p) };

        if (isDrums) {
          const name = DRUM_NAMES[p] ?? "";
          return (
            <div
              key={p}
              data-key={p}
              {...active}
              {...handlers}
              className={`flex items-center justify-end overflow-hidden border-b pr-1 text-[9px] whitespace-nowrap ${
                isBlackKey(p) ? "border-black/50 bg-[#1d212b] text-slate-500 hover:bg-[#2a3040]" : "border-slate-300/40 bg-[#e8ecf2] text-slate-700 hover:bg-white"
              }`}
              style={{ height: rowH, ...(isPressed ? { background: WHITE_PRESSED, color: "#0f172a" } : {}) }}
            >
              {name}
            </div>
          );
        }

        const pc = p % 12;
        const edge = musicKey && isInKey(p, musicKey) ? (
          <div className="pointer-events-none absolute" data-in-key={isTonic(p, musicKey) ? "root" : "true"} style={{ right: 0, top: 1, bottom: 1, width: 4, background: isTonic(p, musicKey) ? "#22d3ee" : "#0e7490", borderRadius: "2px 0 0 2px" }} />
        ) : null;
        if (isBlackKey(p)) {
          return (
            <div key={p} data-key={p} data-black-key="true" {...active} {...handlers} className="relative cursor-pointer" style={{ height: rowH, background: isPressed ? WHITE_PRESSED : WHITE }}>
              <div className="pointer-events-none absolute" style={{ left: 0, top: 1, bottom: 1, width: BLACK_WIDTH, background: isPressed ? BLACK_PRESSED : BLACK, borderRadius: "0 3px 3px 0", boxShadow: "inset 0 -1px 0 rgba(0,0,0,.55), 1px 0 2px rgba(0,0,0,.35)" }} />
              {/* the white keys on either side of this black key meet in the middle of its row */}
              <div className="pointer-events-none absolute right-0" style={{ left: BLACK_WIDTH, top: "50%", borderTop: `1px solid ${EDGE}` }} />
              {edge}
            </div>
          );
        }

        // White key. C and F have no black key below them, so a full line separates them from the key beneath (B, E).
        const fullEdge = pc === 0 || pc === 5;
        return (
          <div key={p} data-key={p} {...active} {...handlers} className="relative cursor-pointer hover:brightness-95" style={{ height: rowH, background: isPressed ? WHITE_PRESSED : WHITE, borderBottom: fullEdge ? `1px solid ${EDGE}` : "none" }}>
            {edge}
            {pc === 0 && <span className="pointer-events-none absolute text-[9px] font-medium text-slate-600" style={{ right: 8, bottom: 1, lineHeight: 1 }}>{pitchLabel(p)}</span>}
          </div>
        );
      })}
    </>
  );
});
