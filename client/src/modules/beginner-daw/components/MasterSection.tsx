interface MasterSectionProps {
  volume: number;
  dbDisplay: string;
}

export function MasterSection({ volume, dbDisplay }: MasterSectionProps) {
  const bars = [92, 84, 76, 70, 62, 55, 48, 40, 32, 24];

  return (
    <section className="rounded-xl border border-white/8 bg-[#12151c] p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
        Master
      </p>
      <p className="text-[10px] text-slate-500">How loud the whole song is</p>

      <div className="mt-2 flex items-end gap-3">
        <div className="flex h-16 items-end gap-0.5">
          {bars.map((height, index) => (
            <span
              key={index}
              className={`w-1.5 rounded-sm ${
                index > 7 ? "bg-rose-400" : index > 5 ? "bg-amber-300" : "bg-cyan-400"
              }`}
              style={{ height: `${height * 0.55}%` }}
            />
          ))}
        </div>
        <div>
          <p className="font-mono text-sm text-white">{dbDisplay}</p>
          <label className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
            Volume
            <input
              type="range"
              min={0}
              max={100}
              defaultValue={volume}
              aria-label="Master output volume"
              className="w-20 accent-cyan-400"
            />
          </label>
        </div>
      </div>
    </section>
  );
}
