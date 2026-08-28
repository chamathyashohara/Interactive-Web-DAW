interface TimelineProps {
  totalBars: number;
}

export function Timeline({ totalBars }: TimelineProps) {
  return (
    <div className="grid h-full border-b border-white/8 bg-[#0e1118]">
      <div
        className="grid h-full"
        style={{ gridTemplateColumns: `repeat(${totalBars}, minmax(3rem, 1fr))` }}
      >
        {Array.from({ length: totalBars }, (_, index) => {
          const bar = index + 1;
          return (
            <div
              key={bar}
              className="flex items-center border-r border-white/8 px-1.5 text-[10px] font-medium text-slate-400"
            >
              {bar}
            </div>
          );
        })}
      </div>
    </div>
  );
}
