import type { ProjectInfo } from "../types/daw";

interface TransportBarProps {
  project: ProjectInfo;
}

export function TransportBar({ project }: TransportBarProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center gap-3">
      <div className="flex items-center gap-1.5 rounded-full bg-black/35 p-1 ring-1 ring-white/8">
        <button
          type="button"
          aria-label="Play"
          title="Play"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-400 text-slate-950"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
            <path d="M2 1.5v9l9-4.5L2 1.5z" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Stop"
          title="Stop"
          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-200 hover:bg-white/10"
        >
          <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
        </button>
        <button
          type="button"
          aria-label="Record"
          title="Record"
          className="flex h-8 w-8 items-center justify-center rounded-full text-rose-400 hover:bg-white/10"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-current" />
        </button>
      </div>

      <label className="hidden items-center gap-1.5 rounded-lg bg-black/30 px-2.5 py-1 md:flex">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">BPM</span>
        <span className="font-mono text-sm text-white">{project.bpm}</span>
      </label>

      <label className="hidden items-center gap-1.5 rounded-lg bg-black/30 px-2.5 py-1 md:flex">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Time</span>
        <span className="font-mono text-sm text-white">{project.timeSignature}</span>
      </label>

      <div className="hidden items-center gap-1.5 rounded-lg bg-black/30 px-2.5 py-1 sm:flex">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Now</span>
        <span className="font-mono text-sm text-cyan-300">{project.position}</span>
      </div>

      <label className="hidden min-w-28 items-center gap-2 lg:flex">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Master</span>
        <input
          type="range"
          min={0}
          max={100}
          defaultValue={project.masterVolume}
          aria-label="Master volume"
          className="w-20 accent-cyan-400"
        />
      </label>
    </div>
  );
}
