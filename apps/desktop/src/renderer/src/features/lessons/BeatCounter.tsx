import { beatsLabel, type TimeTarget } from "./subLesson";

const BAR = 3840;
const BEAT = 960;

/**
 * A plain picture of bars and beats for beginners: each bar is four numbered boxes (one per beat), and every place the
 * exercise needs a note is drawn on top, as long as the note should last. It mirrors the green columns on the roll.
 */
export function BeatCounter({ targets, bars }: { targets: TimeTarget[]; bars: number }) {
  if (!targets.length) return null;
  const lastBar = Math.min(bars, Math.max(...targets.map((t) => Math.floor(t.startTick / BAR))) + 1);
  return (
    <div className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/5" data-testid="beat-counter">
      <div className="text-sm font-semibold text-slate-100">Where your notes go</div>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        A <b className="text-slate-200">bar</b> is 4 <b className="text-slate-200">beats</b>. Count each bar 1, 2, 3, 4. Each box is one beat; the green
        blocks show where a note goes and how long it lasts. The same places are green on the piano roll.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {Array.from({ length: lastBar }, (_, bar) => {
          const inBar = targets.filter((t) => Math.floor(t.startTick / BAR) === bar);
          return (
            <div key={bar} className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-slate-500">Bar {bar + 1}</span>
              <div className="relative grid flex-1 grid-cols-4 gap-px overflow-hidden rounded-md bg-white/10" style={{ height: 34 }}>
                {[1, 2, 3, 4].map((beat) => (
                  <div key={beat} className="flex items-start justify-start bg-[#151924] px-1 text-[10px] text-slate-500">
                    {beat}
                  </div>
                ))}
                {inBar.map((t) => {
                  const start = t.startTick - bar * BAR;
                  const width = Math.min(t.durationTicks, BAR - start);
                  return (
                    <div
                      key={t.startTick}
                      className={`absolute bottom-1 flex h-[18px] items-center justify-center overflow-hidden rounded text-[10px] font-semibold ${t.hasLength ? "bg-emerald-300 text-slate-900" : "border border-emerald-300 bg-emerald-300/25 text-emerald-100"}`}
                      style={{ left: `calc(${(start / BAR) * 100}% + 1px)`, width: `calc(${(width / BAR) * 100}% - 2px)` }}
                      title={`Starts on beat ${start / BEAT + 1} of bar ${bar + 1}${t.hasLength ? `, lasts ${beatsLabel(t.durationTicks)}` : ""}`}
                    >
                      {t.hasLength ? beatsLabel(t.durationTicks) : t.label}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
